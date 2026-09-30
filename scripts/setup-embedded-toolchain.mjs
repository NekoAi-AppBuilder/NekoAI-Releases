import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { execSync } from "node:child_process";

const TOOLS_DIR = path.resolve("tools");

async function downloadFile(url, destPath, expectedSha256) {
  console.log(`[Download] ${url} -> ${destPath}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const handleResponse = (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`[Redirect] -> ${response.headers.location}`);
        const redirectUrl = response.headers.location.startsWith("http")
          ? response.headers.location
          : new URL(response.headers.location, url).toString();
        const client = redirectUrl.startsWith("https") ? https : http;
        client.get(redirectUrl, handleResponse).on("error", reject);
        return;
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP status ${response.statusCode} for ${url}`));
      }

      const fileStream = fs.createWriteStream(destPath);
      const hash = crypto.createHash("sha256");

      response.on("data", (chunk) => {
        hash.update(chunk);
        fileStream.write(chunk);
      });

      response.on("end", () => {
        fileStream.end(() => {
          const actualSha256 = hash.digest("hex").toLowerCase();
          if (expectedSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
            fs.unlinkSync(destPath);
            return reject(
              new Error(`SHA-256 mismatch for ${url}. Expected: ${expectedSha256}, got: ${actualSha256}`)
            );
          }
          console.log(`[Verified SHA-256] ${actualSha256}`);
          resolve(actualSha256);
        });
      });

      response.on("error", (err) => {
        fileStream.close();
        fs.unlinkSync(destPath);
        reject(err);
      });
    };

    const client = url.startsWith("https") ? https : http;
    client.get(url, handleResponse).on("error", reject);
  });
}

function extractZipSafely(zipFilePath, targetDir) {
  console.log(`[Extract Zip] ${zipFilePath} -> ${targetDir}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const zipBuffer = fs.readFileSync(zipFilePath);
  const resolvedTargetDir = path.resolve(targetDir);

  let offset = 0;
  const entries = [];

  while (offset < zipBuffer.length - 4) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const flags = zipBuffer.readUInt16LE(offset + 6);
      const compression = zipBuffer.readUInt16LE(offset + 8);
      let compressedSize = zipBuffer.readUInt32LE(offset + 18);
      const nameLen = zipBuffer.readUInt16LE(offset + 26);
      const extraLen = zipBuffer.readUInt16LE(offset + 28);

      const nameBuf = zipBuffer.subarray(offset + 30, offset + 30 + nameLen);
      const fileName = nameBuf.toString("utf8");
      const dataOffset = offset + 30 + nameLen + extraLen;

      if ((flags & 0x08) !== 0) {
        let nextPos = dataOffset;
        while (nextPos < zipBuffer.length - 4) {
          const sig = zipBuffer.readUInt32LE(nextPos);
          if (sig === 0x04034b50 || sig === 0x02014b50 || sig === 0x06054b50) {
            break;
          }
          nextPos++;
        }
        compressedSize = nextPos - dataOffset;
      }

      const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
      let uncompressedData;

      if (compression === 0) {
        uncompressedData = Buffer.from(compressedData);
      } else if (compression === 8) {
        uncompressedData = zlib.inflateRawSync(compressedData);
      } else {
        throw new Error(`Unsupported compression method ${compression} in zip`);
      }

      const isDir = fileName.endsWith("/") || fileName.endsWith("\\");
      entries.push({ fileName, data: uncompressedData, isDir });

      offset = dataOffset + compressedSize;
      if ((flags & 0x08) !== 0) {
        offset += 12;
      }
    } else {
      offset++;
    }
  }

  for (const entry of entries) {
    const normalizedName = entry.fileName.replace(/\\/g, "/");
    if (
      normalizedName.startsWith("/") ||
      normalizedName.includes("../") ||
      path.isAbsolute(normalizedName)
    ) {
      throw new Error(`Zip Slip detected in entry: ${entry.fileName}`);
    }

    const destPath = path.resolve(resolvedTargetDir, normalizedName);
    if (!destPath.startsWith(resolvedTargetDir + path.sep) && destPath !== resolvedTargetDir) {
      throw new Error(`Zip Slip detected: target outside directory: ${destPath}`);
    }

    if (entry.isDir) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.data);
    }
  }
}

function extractTarGz(tarGzPath, targetDir, stripPrefix = "package/") {
  console.log(`[Extract TarGz] ${tarGzPath} -> ${targetDir}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const compressed = fs.readFileSync(tarGzPath);
  const tarBuffer = zlib.gunzipSync(compressed);

  let offset = 0;
  while (offset < tarBuffer.length - 512) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header[0] === 0) break; // End of archive

    let fileName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const typeFlag = String.fromCharCode(header[156]);
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512;

    if (fileName) {
      if (stripPrefix && fileName.startsWith(stripPrefix)) {
        fileName = fileName.slice(stripPrefix.length);
      }
      if (fileName) {
        const destPath = path.resolve(targetDir, fileName);
        if (typeFlag === "5" || fileName.endsWith("/")) {
          fs.mkdirSync(destPath, { recursive: true });
        } else if (typeFlag === "0" || typeFlag === "\0") {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          const fileData = tarBuffer.subarray(offset, offset + size);
          fs.writeFileSync(destPath, fileData);
        }
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }
}

async function main() {
  const tmpDir = path.resolve("scratch", "toolchain-downloads");
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Python 3.12.8
  const pythonZip = path.join(tmpDir, "python-3.12.8-embed-amd64.zip");
  const pythonDest = path.join(TOOLS_DIR, "python");
  await downloadFile(
    "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip",
    pythonZip,
    "8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb"
  );
  extractZipSafely(pythonZip, pythonDest);

  // 2. Bun 1.4.2
  const bunZip = path.join(tmpDir, "bun-windows-x64.zip");
  const bunDest = path.join(TOOLS_DIR, "bun");
  await downloadFile(
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64.zip",
    bunZip,
    "ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405"
  );
  extractZipSafely(bunZip, bunDest);
  // Se extraiu em bun/bun-windows-x64, copia bun.exe para bun/bun.exe se necessário
  const nestedBunExe = path.join(bunDest, "bun-windows-x64", "bun.exe");
  const rootBunExe = path.join(bunDest, "bun.exe");
  if (fs.existsSync(nestedBunExe) && !fs.existsSync(rootBunExe)) {
    fs.copyFileSync(nestedBunExe, rootBunExe);
  }

  // 3. Deno 2.9.7
  const denoZip = path.join(tmpDir, "deno-x86_64-pc-windows-msvc.zip");
  const denoDest = path.join(TOOLS_DIR, "deno");
  await downloadFile(
    "https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip",
    denoZip,
    "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238"
  );
  extractZipSafely(denoZip, denoDest);

  // 4. PHP 8.3.35
  const phpZip = path.join(tmpDir, "php-8.3.35-nts-Win32-vs16-x64.zip");
  const phpDest = path.join(TOOLS_DIR, "php");
  await downloadFile(
    "https://windows.php.net/downloads/releases/php-8.3.35-nts-Win32-vs16-x64.zip",
    phpZip,
    "25a8e2ac9ff30f1d768d1447c09a600617fa6e6082729f6e95f008b59c91fe45"
  );
  extractZipSafely(phpZip, phpDest);

  // 5. pnpm 9.15.4 (Node toolchain)
  const pnpmTgz = path.join(tmpDir, "pnpm-9.15.4.tgz");
  const pnpmDest = path.join(TOOLS_DIR, "node", "node_modules", "pnpm");
  await downloadFile("https://registry.npmjs.org/pnpm/-/pnpm-9.15.4.tgz", pnpmTgz, null);
  extractTarGz(pnpmTgz, pnpmDest, "package/");

  // 6. yarn 1.22.22 (Node toolchain)
  const yarnTgz = path.join(tmpDir, "yarn-1.22.22.tgz");
  const yarnDest = path.join(TOOLS_DIR, "node", "node_modules", "yarn");
  await downloadFile("https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz", yarnTgz, null);
  extractTarGz(yarnTgz, yarnDest, "package/");

  // 7. Criar wrappers cmd em tools/node/
  const nodeDir = path.join(TOOLS_DIR, "node");

  // pnpm.cmd
  const pnpmCmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node.exe" "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*
`;
  fs.writeFileSync(path.join(nodeDir, "pnpm.cmd"), pnpmCmdContent, "utf8");

  // pnpx.cmd
  const pnpxCmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node.exe" "%dp0%\\node_modules\\pnpm\\bin\\pnpx.cjs" %*
`;
  fs.writeFileSync(path.join(nodeDir, "pnpx.cmd"), pnpxCmdContent, "utf8");

  // yarn.cmd
  const yarnCmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node.exe" "%dp0%\\node_modules\\yarn\\bin\\yarn.js" %*
`;
  fs.writeFileSync(path.join(nodeDir, "yarn.cmd"), yarnCmdContent, "utf8");

  // yarnpkg.cmd
  const yarnpkgCmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node.exe" "%dp0%\\node_modules\\yarn\\bin\\yarn.js" %*
`;
  fs.writeFileSync(path.join(nodeDir, "yarnpkg.cmd"), yarnpkgCmdContent, "utf8");

  // POSIX / bash wrappers
  const pnpmShContent = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec "$basedir/node" "$basedir/node_modules/pnpm/bin/pnpm.cjs" "$@"
`;
  fs.writeFileSync(path.join(nodeDir, "pnpm"), pnpmShContent, "utf8");

  const pnpxShContent = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec "$basedir/node" "$basedir/node_modules/pnpm/bin/pnpx.cjs" "$@"
`;
  fs.writeFileSync(path.join(nodeDir, "pnpx"), pnpxShContent, "utf8");

  const yarnShContent = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec "$basedir/node" "$basedir/node_modules/yarn/bin/yarn.js" "$@"
`;
  fs.writeFileSync(path.join(nodeDir, "yarn"), yarnShContent, "utf8");

  const yarnpkgShContent = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec "$basedir/node" "$basedir/node_modules/yarn/bin/yarn.js" "$@"
`;
  fs.writeFileSync(path.join(nodeDir, "yarnpkg"), yarnpkgShContent, "utf8");

  console.log("[Success] Embedded Toolchain successfully installed in tools/ !");
}

main().catch((err) => {
  console.error("[Setup Error]", err);
  process.exit(1);
});

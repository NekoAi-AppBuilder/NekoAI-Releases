import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import https from "node:https";

import { RuntimeProvisioner } from "../src/main/runtime/runtime-provisioner.ts";
import { RuntimeStore } from "../src/main/runtime/runtime-store.ts";
import { RuntimeDownloader } from "../src/main/runtime/runtime-downloader.ts";

async function createTempDir(prefix: string = "neko-provisioner-test-"): Promise<string> {
  const tmpBase = os.tmpdir();
  return await fs.mkdtemp(path.join(tmpBase, prefix));
}

// Helper para criar um buffer ZIP sem compressão (Store) contendo os arquivos/diretórios especificados
function createZipBuffer(entries: Array<{ name: string; content?: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const isDir = entry.name.endsWith("/") || entry.name.endsWith("\\");
    const nameBuf = Buffer.from(entry.name, "utf8");
    const dataBuf = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || "", "utf8");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // Signature PK\x03\x04
    header.writeUInt16LE(10, 4); // Version needed
    header.writeUInt16LE(0, 6); // General purpose flag
    header.writeUInt16LE(0, 8); // Compression method: 0 (Store)
    header.writeUInt16LE(0, 10); // Mod time
    header.writeUInt16LE(0, 12); // Mod date
    header.writeUInt32LE(0, 14); // CRC-32 (0 para testes)
    header.writeUInt32LE(dataBuf.length, 18); // Compressed size
    header.writeUInt32LE(dataBuf.length, 22); // Uncompressed size
    header.writeUInt16LE(nameBuf.length, 26); // File name length
    header.writeUInt16LE(0, 28); // Extra field length

    chunks.push(header, nameBuf, dataBuf);
  }

  // End of Central Directory record (opcional, para integridade mínima)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// Helper para subir servidor HTTPS mock local
function setupMockHttpsServer(content: Buffer): Promise<{ server: https.Server; url: string; sha256: string }> {
  return new Promise((resolve, reject) => {
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDccqo5bVMV0Xu6",
      "tKEnakx3kxv6VhUVn3i5vUJbc1o6ycIWjOydl4V/qR1nyJoljibPEMgdJ9g4lc4j",
      "pW2WxvkO8c9hgtgb0gojYlXGPn3w1Tyq0+i4pDbps0Pf04IjgfYghD5T5undk9NP",
      "7//fliHJUVHsin+AKEw26JUtETs1g917JwknTmQA4S7ftNttVBT+rPr7V7vagsNz",
      "gkGl/76A/yFcP1jO5ruP7KmPJMRDzW4MAzEZgV0FWMEp+E19fOfVTEH3pPiclDnR",
      "PbP1VEDczQi9UZwByxTMdRyVvJ8kmk5gmomr/gxCy6uLTv5RgC+f3v7Z1PqcRDke",
      "MRkwNzAvAgMBAAECggEABWrR8RBVMtuPgVKQBUJw951HWjsEUKA3HMVgXJP0my47",
      "FUfIRsUi9DSpMtQ0qYiZPoxohoLkpttTkf+uNj7UfwAFOx22htR+CEmR1wnRGXp7",
      "/6yuct8iNFMB732onIvEix8E0xYBGD9aOYQp0wpC8UoMy9XJdVJIMS88/zsFq/Zy",
      "bI5wVpFL+psUq+6WJrlYgnWAWUBBY4nSkU/6RvZbzVBlq4fGqOIFg064zRmuFj1f",
      "HWiAFVjoLj54DNwf5+khss34dHvmtUgHFHNtmhaoNoPnHoypwVMms+99BVIrnju+",
      "VKOmpYrVT5UHbJHnWQPokJ7LFYSKIobnC4EccFe2FQKBgQDzTTnCNmw6VuEK1evk",
      "r/LM/bDzW3wlJsb2uZpbiBOZvTrS5ftLpw1y1iRVOylvgOuD/mm/5I841+XEXTrj",
      "F27tszKByVY4bSnQfYTxKWRn+xdGYE+iNOB7vwfgjO3LqXkMR005x52u0oXDKkMX",
      "SqhjRD9DGOXAC97qP0J++KuWIwKBgQDn9BafZkBqsWHvQzT2NqogN1iSwES3ZobF",
      "UDE+RJtZ/OFRkrpI+kdg1bi7/wW2iFBA4OoI4DkwymUw4qXtX5xik/df8JNjuQjp",
      "2NjIRyqxWn+xSHUXcqTPuEZgYufzclRuoBmvZPnIHK/uUwGVVfZ21aVYCcvqhMkz",
      "dzAaBpAQhQKBgA3wr82D5sGU9sHzLdfliOjb5EadSEispxu92K1D57OYVwV8beCQ",
      "ysF4qY5EnIQqA9SFQDPheZ9NJ3oPyW73icCO0ucCzTDgeFPczUAwGfOnPFco74cg",
      "tngAowfnqzxPEoN0lmUoHc3FfCqJglyUR3+gimtiws81HumXBE1YHCS3AoGBAL1s",
      "CE2EI3b+BQxvxgCMA8Lrb9noSjW79LOOGajQPk3uxdLoEFkoisH5xzM/wFqgV2mk",
      "Q3ucIRhHMPwLG5YOTpfyXkJrJPJ7WVwfSmnENIlBbqZIldbgONeplU+BdgrJg0oU",
      "VOV3gMR7KPFnuBNMcEn7j1umJHEQn374BsA6O8xBAoGBAKAYdLc3OP8zqao6DEvN",
      "NVXak6AHlS1DZ+kMsn3F9Tsoo8yhCnxtPPZfIySSJcWFKumUuC6JuZWjf/feZtGo",
      "t9ullpXrW27ExgNVDXx3rszRl6JhABEd4vICqdVHMLu0MedTYRkj72xUYjHAYXb/",
      "9yWzTiwVNlAKNPMN6IzIiu7L",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const certPem = [
      "-----BEGIN CERTIFICATE-----",
      "MIIDCTCCAfGgAwIBAgIUSEgthAe2MaZgBL4wLwbX4I1HaZowDQYJKoZIhvcNAQEL",
      "BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkyNjE3MTI1N1oXDTM2MDky",
      "MzE3MTI1N1owFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF",
      "AAOCAQ8AMIIBCgKCAQEA3HKqOW1TFdF7urShJ2pMd5Mb+lYVFZ94ub1CW3NaOsnC",
      "FozsnZeFf6kdZ8iaJY4mzxDIHSfYOJXOI6Vtlsb5DvHPYYLYG9IKI2JVxj598NU8",
      "qtPouKQ26bND39OCI4H2IIQ+U+bp3ZPTT+//35YhyVFR7Ip/gChMNuiVLRE7NYPd",
      "eycJJ05kAOEu37TbbVQU/qz6+1e72oLDc4JBpf++gP8hXD9Yzua7j+ypjyTEQ81u",
      "DAMxGYFdBVjBKfhNfXzn1UxB96T4nJQ50T2z9VRA3M0IvVGcAcsUzHUclbyfJJpO",
      "YJqJq/4MQsuri07+UYAvn97+2dT6nEQ5HjEZMDcwLwIDAQABo1MwUTAdBgNVHQ4E",
      "FgQUyd/DwhbofjOI+lF6OvztEVsUb60wHwYDVR0jBBgwFoAUyd/DwhbofjOI+lF6",
      "OvztEVsUb60wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAorzy",
      "yJ1PdgGSKY51yS3S7ATB98Tj3vK899TdMHzcjanyoLVNJAloUqYKyOkFmHAIXeyO",
      "EKYtsi4NZtw9iFPID4hfNuC9eDtg1jK6AIieCL0u94gBnpieRx4hwqrccbi2hw8j",
      "jYKxvmuPSFg497LikFOjTCSUki/YTGDWwVV4IW8UwrTv3mbAgzIv9WX2S77FOpLR",
      "CiFd5T04KaJDXPhGuT3Gj3jV2ywn3DyNNGNBbsoZCW+itwJm/fup4utKvQ24Bw5l",
      "T8eHgdjQYETzheS1+m6+1eF2CENmupRC2IVhNCuZ+UyXyJBoL7XxmztyVy8ecnUb",
      "P/S9P0OKcqv7NGjXsw==",
      "-----END CERTIFICATE-----",
    ].join("\n");

    const server = https.createServer({ key: privateKey, cert: certPem }, (req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(content.length),
      });
      res.end(content);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, url: `https://127.0.0.1:${addr.port}/mock-runtime.zip`, sha256 });
      } else {
        reject(new Error("Falha ao obter porta do servidor HTTPS mock."));
      }
    });

    server.on("error", reject);
  });
}

// ============================================================================
// SUÍTE DE TESTES: RUNTIME PROVISIONER (STAGING, EXTRAÇÃO, ZIP SLIP, VALIDAÇÃO E STORE)
// ============================================================================

test("1. RuntimeProvisioner: provisionamento bem-sucedido (staging -> dest -> store)", async () => {
  const baseDir = await createTempDir();
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const zipContent = createZipBuffer([
      { name: "bin/" },
      { name: "bin/python.exe", content: "MOCK_PYTHON_BINARY_CONTENT" },
      { name: "README.md", content: "Python mock runtime doc" },
    ]);

    const mock = await setupMockHttpsServer(zipContent);
    mockServer = mock.server;

    const store = new RuntimeStore({ baseDir });
    const downloader = new RuntimeDownloader();
    const provisioner = new RuntimeProvisioner({ store, downloader, baseDir });

    const result = await provisioner.provision({
      id: "python-3.11",
      name: "Python Runtime",
      version: "3.11.8",
      downloadUrl: mock.url,
      expectedSha256: mock.sha256,
      binDirs: ["bin"],
      executables: [{ name: "python", relativePath: "bin/python.exe", isPrimary: true }],
      environmentVariables: { PYTHONUNBUFFERED: "1" },
    });

    assert.equal(result.success, true, `Provisionamento deve suceder. Erro: ${result.error}`);
    assert.ok(result.descriptor);
    assert.equal(result.descriptor.id, "python-3.11");
    assert.equal(result.descriptor.category, "provisioned");
    assert.equal(result.descriptor.status, "ready");

    // Verificar se a pasta final existe
    const finalDir = path.join(baseDir, "python-3.11");
    assert.equal(fsSync.existsSync(finalDir), true, "Diretório final de instalação deve existir");
    assert.equal(fsSync.existsSync(path.join(finalDir, "bin", "python.exe")), true);

    // Verificar se o staging foi limpo
    const stagingDir = provisioner.getStagingBaseDir();
    if (fsSync.existsSync(stagingDir)) {
      const remainingStagingItems = await fs.readdir(stagingDir);
      assert.equal(remainingStagingItems.length, 0, "Staging deve estar limpo após o provisionamento");
    }

    // Verificar se o runtime foi registrado no store
    const stored = await store.getRuntime("python-3.11");
    assert.ok(stored);
    assert.equal(stored.name, "Python Runtime");
    assert.equal(stored.binDirs[0], path.join(finalDir, "bin"));
  } finally {
    if (mockServer) mockServer.close();
    if (origTls !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. RuntimeProvisioner: bloqueia tentativa de Zip Slip (ZIP_SLIP_DETECTED) e realiza rollback", async () => {
  const baseDir = await createTempDir();
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    // Criar ZIP contendo entrada com travessia de diretório ../evil.txt
    const malformedZip = createZipBuffer([
      { name: "bin/" },
      { name: "bin/python.exe", content: "OK" },
      { name: "../evil.txt", content: "MALICIOUS_CONTENT" },
    ]);

    const mock = await setupMockHttpsServer(malformedZip);
    mockServer = mock.server;

    const store = new RuntimeStore({ baseDir });
    const downloader = new RuntimeDownloader();
    const provisioner = new RuntimeProvisioner({ store, downloader, baseDir });

    const result = await provisioner.provision({
      id: "malicious-runtime",
      name: "Malicious Runtime",
      version: "1.0.0",
      downloadUrl: mock.url,
      expectedSha256: mock.sha256,
      binDirs: ["bin"],
      executables: [{ name: "python", relativePath: "bin/python.exe" }],
    });

    assert.equal(result.success, false, "Provisionamento deve falhar para ZIP malicioso");
    assert.ok(result.error?.includes("ZIP_SLIP_DETECTED"), `Erro (${result.error}) deve indicar ZIP_SLIP_DETECTED`);

    // Garantir que nenhum diretório 'evil.txt' ou 'malicious-runtime' foi criado fora do staging
    const finalDir = path.join(baseDir, "malicious-runtime");
    assert.equal(fsSync.existsSync(finalDir), false, "Diretório final de destino NÃO pode ser criado");

    const parentEvil = path.join(baseDir, "..", "evil.txt");
    assert.equal(fsSync.existsSync(parentEvil), false, "Arquivo fora do diretório permito NÃO pode ser criado");

    // Garantir rollback no store
    assert.equal(await store.getRuntime("malicious-runtime"), null, "Store NÃO deve conter o registro");
  } finally {
    if (mockServer) mockServer.close();
    if (origTls !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. RuntimeProvisioner: falha na validação estrutural (INVALID_RUNTIME_STRUCTURE)", async () => {
  const baseDir = await createTempDir();
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    // ZIP sem a pasta bin nem o executável declarado
    const zipContent = createZipBuffer([
      { name: "docs/" },
      { name: "docs/README.txt", content: "Missing bin folder" },
    ]);

    const mock = await setupMockHttpsServer(zipContent);
    mockServer = mock.server;

    const store = new RuntimeStore({ baseDir });
    const downloader = new RuntimeDownloader();
    const provisioner = new RuntimeProvisioner({ store, downloader, baseDir });

    const result = await provisioner.provision({
      id: "incomplete-runtime",
      name: "Incomplete Runtime",
      version: "1.0.0",
      downloadUrl: mock.url,
      expectedSha256: mock.sha256,
      binDirs: ["bin"],
      executables: [{ name: "bun", relativePath: "bin/bun.exe" }],
    });

    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes("INVALID_RUNTIME_STRUCTURE"),
      `Erro (${result.error}) deve indicar INVALID_RUNTIME_STRUCTURE`
    );

    // Garantir ausência do diretório final e do store
    assert.equal(fsSync.existsSync(path.join(baseDir, "incomplete-runtime")), false);
    assert.equal(await store.getRuntime("incomplete-runtime"), null);
  } finally {
    if (mockServer) mockServer.close();
    if (origTls !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. RuntimeProvisioner: falha no download/checksum cancela provisionamento e limpa staging", async () => {
  const baseDir = await createTempDir();
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const zipContent = createZipBuffer([{ name: "bin/python.exe", content: "MOCK" }]);
    const mock = await setupMockHttpsServer(zipContent);
    mockServer = mock.server;

    const store = new RuntimeStore({ baseDir });
    const downloader = new RuntimeDownloader();
    const provisioner = new RuntimeProvisioner({ store, downloader, baseDir });

    const wrongSha = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    const result = await provisioner.provision({
      id: "failed-download-runtime",
      name: "Failed Download Runtime",
      version: "1.0.0",
      downloadUrl: mock.url,
      expectedSha256: wrongSha,
      binDirs: [],
      executables: [],
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes("CHECKSUM_MISMATCH"));

    assert.equal(fsSync.existsSync(path.join(baseDir, "failed-download-runtime")), false);
    assert.equal(await store.getRuntime("failed-download-runtime"), null);
  } finally {
    if (mockServer) mockServer.close();
    if (origTls !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. RuntimeProvisioner: proteção de runtime existente contra sobrescrita parcial em falha de re-provisionamento", async () => {
  const baseDir = await createTempDir();
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer1: https.Server | null = null;
  let mockServer2: https.Server | null = null;

  try {
    // 1. Criar e provisionar runtime original válido (python-3.11 v3.11.8)
    const validZip1 = createZipBuffer([
      { name: "bin/" },
      { name: "bin/python.exe", content: "ORIGINAL_PYTHON_3.11.8_BINARY" },
    ]);
    const mock1 = await setupMockHttpsServer(validZip1);
    mockServer1 = mock1.server;

    const store = new RuntimeStore({ baseDir });
    const downloader = new RuntimeDownloader();
    const provisioner = new RuntimeProvisioner({ store, downloader, baseDir });

    const res1 = await provisioner.provision({
      id: "python-3.11",
      name: "Python Runtime",
      version: "3.11.8",
      downloadUrl: mock1.url,
      expectedSha256: mock1.sha256,
      binDirs: ["bin"],
      executables: [{ name: "python", relativePath: "bin/python.exe" }],
    });

    assert.equal(res1.success, true);
    const initialInstalledExe = path.join(baseDir, "python-3.11", "bin", "python.exe");
    assert.equal(await fs.readFile(initialInstalledExe, "utf8"), "ORIGINAL_PYTHON_3.11.8_BINARY");

    // 2. Tentar re-provisionar com um novo ZIP malformado (sem a pasta bin declarada)
    const malformedZip2 = createZipBuffer([
      { name: "docs/" },
      { name: "docs/CHANGELOG.txt", content: "Invalid new build" },
    ]);
    const mock2 = await setupMockHttpsServer(malformedZip2);
    mockServer2 = mock2.server;

    const res2 = await provisioner.provision({
      id: "python-3.11",
      name: "Python Runtime Updated",
      version: "3.11.9",
      downloadUrl: mock2.url,
      expectedSha256: mock2.sha256,
      binDirs: ["bin"],
      executables: [{ name: "python", relativePath: "bin/python.exe" }],
    });

    // 3. Confirmar que o novo provisionamento falhou
    assert.equal(res2.success, false);
    assert.ok(res2.error?.includes("INVALID_RUNTIME_STRUCTURE"));

    // 4. Confirmar que o runtime existente permanece 100% intacto (versão v3.11.8 mantida)
    assert.equal(fsSync.existsSync(initialInstalledExe), true);
    assert.equal(await fs.readFile(initialInstalledExe, "utf8"), "ORIGINAL_PYTHON_3.11.8_BINARY");

    // 5. Confirmar que o registro no store permanece consistente com a versão original
    const stored = await store.getRuntime("python-3.11");
    assert.ok(stored);
    assert.equal(stored?.version, "3.11.8", "O store deve preservar a versão original 3.11.8");

    // 6. Confirmar que nenhum diretório de staging residual permanece
    const stagingBase = provisioner.getStagingBaseDir();
    if (fsSync.existsSync(stagingBase)) {
      const items = await fs.readdir(stagingBase);
      assert.equal(items.length, 0, "Staging deve estar limpo após a falha");
    }
  } finally {
    if (mockServer1) mockServer1.close();
    if (mockServer2) mockServer2.close();
    if (origTls !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

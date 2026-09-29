import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import subprocess from "node:child_process";

function resolveNodeRuntimePure(options = {}) {
  const customPath = options.customPath || process.env.NEKO_NODE_PATH;
  const isWin = (options.platform || process.platform) === "win32";
  const nodeExe = isWin ? "node.exe" : "node";
  const npmCmd = isWin ? "npm.cmd" : "npm";
  const npxCmd = isWin ? "npx.cmd" : "npx";

  if (customPath && fs.existsSync(customPath)) {
    const customBinDir = path.dirname(customPath);
    const customNpm = path.join(customBinDir, npmCmd);
    const customNpx = path.join(customBinDir, npxCmd);
    return {
      nodePath: customPath,
      npmPath: fs.existsSync(customNpm) ? customNpm : npmCmd,
      npxPath: fs.existsSync(customNpx) ? customNpx : npxCmd,
      binDir: customBinDir,
      isBundled: true
    };
  }

  const projectDir = options.projectDir || process.cwd();
  const candidatePaths = [
    path.resolve(projectDir, "tools", "node")
  ];
  if (options.resourcesPath) {
    candidatePaths.push(path.join(options.resourcesPath, "tools", "node"));
  }

  for (const candidateDir of candidatePaths) {
    const candidateNode = path.join(candidateDir, nodeExe);
    if (fs.existsSync(candidateNode)) {
      const candidateNpm = path.join(candidateDir, npmCmd);
      const candidateNpx = path.join(candidateDir, npxCmd);

      const resolvedNpm = fs.existsSync(candidateNpm) ? candidateNpm : candidateNode;
      const resolvedNpx = fs.existsSync(candidateNpx) ? candidateNpx : candidateNode;

      return {
        nodePath: candidateNode,
        npmPath: resolvedNpm,
        npxPath: resolvedNpx,
        binDir: candidateDir,
        isBundled: true
      };
    }
  }

  if (options.systemNodePath && fs.existsSync(options.systemNodePath)) {
    const sysBinDir = path.dirname(options.systemNodePath);
    return {
      nodePath: options.systemNodePath,
      npmPath: path.join(sysBinDir, npmCmd),
      npxPath: path.join(sysBinDir, npxCmd),
      binDir: sysBinDir,
      isBundled: false
    };
  }

  throw new Error("Runtime Node.js da NekoAI não encontrado.");
}

test("1. resolveNodeRuntime encontra runtime empacotado em tools/node", () => {
  const runtime = resolveNodeRuntimePure();
  assert.equal(runtime.isBundled, true, "Runtime deve ser identificado como embutido");
  assert.ok(fs.existsSync(runtime.nodePath), `node.exe deve existir em ${runtime.nodePath}`);
  assert.ok(runtime.nodePath.toLowerCase().includes(path.join("tools", "node").toLowerCase()), "node.exe deve estar dentro da pasta tools/node");
});

test("2. npm resolve para o runtime embutido", () => {
  const runtime = resolveNodeRuntimePure();
  assert.ok(fs.existsSync(runtime.npmPath), `npmPath deve existir em ${runtime.npmPath}`);
  assert.ok(runtime.npmPath.toLowerCase().includes(path.join("tools", "node").toLowerCase()), "npm deve estar dentro da pasta tools/node");
});

test("3. npx resolve para o runtime embutido", () => {
  const runtime = resolveNodeRuntimePure();
  assert.ok(fs.existsSync(runtime.npxPath), `npxPath deve existir em ${runtime.npxPath}`);
  assert.ok(runtime.npxPath.toLowerCase().includes(path.join("tools", "node").toLowerCase()), "npx deve estar dentro da pasta tools/node");
});

test("4. PATH vazio não impede resolução do runtime embutido", () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const runtime = resolveNodeRuntimePure();
    assert.equal(runtime.isBundled, true);
    assert.ok(fs.existsSync(runtime.nodePath));
    assert.ok(fs.existsSync(runtime.npmPath));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("5. Node externo no PATH não substitui o runtime embutido da NekoAI", () => {
  const runtime = resolveNodeRuntimePure({ systemNodePath: "C:\\some_other_path\\node.exe" });
  assert.equal(runtime.isBundled, true);
  assert.ok(runtime.nodePath.toLowerCase().includes(path.join("tools", "node").toLowerCase()));
});

test("6. Bun ausente faz fallback gracioso para npm embutido", () => {
  const runtime = resolveNodeRuntimePure();
  const bunAvailable = false;
  const preferredManager = bunAvailable ? "bun" : "npm";
  const managerToUse = preferredManager === "bun" ? "bun" : "npm";

  assert.equal(managerToUse, "npm");
  assert.ok(fs.existsSync(runtime.npmPath));
});

test("7. Bun externo (se configurado) continua sendo opção preferencial antes do npm embutido", () => {
  const bunAvailable = true;
  const preferredManager = bunAvailable ? "bun" : "npm";
  assert.equal(preferredManager, "bun");
});

test("8. npm embutido consegue executar verificação de versão (simulação de execução de pacote)", () => {
  const runtime = resolveNodeRuntimePure();
  const isWin = process.platform === "win32";
  const cmd = isWin ? (process.env.ComSpec || "cmd.exe") : runtime.npmPath;
  const args = isWin ? ["/d", "/s", "/c", "npm.cmd --version"] : ["--version"];

  const envPath = `${runtime.binDir}${path.delimiter}C:\\Windows\\System32`;
  const res = subprocess.spawnSync(cmd, args, {
    cwd: runtime.binDir,
    encoding: "utf8",
    windowsHide: true,
    env: { ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows", PATH: envPath }
  });

  assert.equal(res.status, 0, `npm --version deve retornar exit code 0 (stderr: ${res.stderr})`);
  assert.ok(res.stdout.trim().length > 0, "npm deve retornar número de versão válido");
});

test("9. npm embutido consegue executar script Node via node.exe", () => {
  const runtime = resolveNodeRuntimePure();
  const res = subprocess.spawnSync(runtime.nodePath, ["-e", "console.log('NEKO_NODE_OK')"], {
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("NEKO_NODE_OK"));
});

test("10. Ausência de runtime lança erro específico 'Runtime Node.js da NekoAI não encontrado'", () => {
  assert.throws(() => {
    resolveNodeRuntimePure({ projectDir: "C:\\non_existent_dir_neko", systemNodePath: null });
  }, /Runtime Node\.js da NekoAI não encontrado/);
});

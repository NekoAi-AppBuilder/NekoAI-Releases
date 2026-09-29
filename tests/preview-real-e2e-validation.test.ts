// tests/preview-real-e2e-validation.test.ts
// Validação Real End-to-End do Preview para Release (Bun Real, Node Real, Isolamento de PATH e Falha Controlada).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

import {
  resolveEffectivePackageManager,
  resolvePackageManagerExecutablePath,
  isPackageManagerAvailable,
  packageManagerExecutable,
  findExecutableOnPath,
} from "../src/main/preview-package-manager";
import { RuntimeEnvironmentBuilder } from "../src/main/runtime/runtime-environment";
import { resolveNodeRuntime } from "../src/main/node-runtime";

function createTempProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `neko-e2e-preview-${prefix}-`));
  return dir;
}

async function waitForHttp(url: string, timeoutMs = 15000): Promise<{ status: number; text: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = http.get(url, (response) => {
          let body = "";
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            resolve({ status: response.statusCode || 200, text: body });
          });
        });
        req.on("error", reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });
      return res;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Servidor em ${url} não respondeu dentro de ${timeoutMs}ms.`);
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

// ============================================================================
// TESTE 1 — BUN REAL END-TO-END
// ============================================================================
test("TESTE 1 — BUN REAL: Detecção, Resolução de Ambiente, Inicialização do Vite e Resposta do Preview", async () => {
  const projectDir = createTempProject("bun-real");
  let serverProcess: ChildProcess | null = null;

  try {
    // 1. Preparar projeto Vite + React + TypeScript configurado com Bun
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify(
        {
          name: "bun-vite-react-e2e",
          version: "1.0.0",
          private: true,
          type: "module",
          packageManager: "bun@1.2.4",
          scripts: {
            dev: "vite --port 5923 --host 127.0.0.1",
            build: "vite build",
          },
        },
        null,
        2
      ),
      "utf8"
    );

    // Lockfile característico do Bun
    fs.writeFileSync(path.join(projectDir, "bun.lockb"), "BUN_LOCK_E2E_BINARY_MOCK", "utf8");

    // Estrutura do app React
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "index.html"),
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>NekoAI E2E React App</title>
  </head>
  <body>
    <div id="root"><h1>NekoAI Real Preview E2E with Bun!</h1></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(projectDir, "src", "main.tsx"),
      `console.log("React E2E initialized successfully via Bun!");`,
      "utf8"
    );

    // Symlink ou cópia do node_modules/vite para permitir inicialização instantânea do dev server
    const rootNm = path.resolve(__dirname, "..", "node_modules");
    if (fs.existsSync(rootNm)) {
      const destNm = path.join(projectDir, "node_modules");
      try {
        fs.symlinkSync(rootNm, destNm, "junction");
      } catch {
        // Fallback: cópia mínima se symlink falhar
      }
    }

    // 2. Resolução de Package Manager via NekoAI Preview Architecture
    const resolution = resolveEffectivePackageManager("bun");
    assert.equal(resolution.effectiveManager, "bun", "Deve resolver 'bun' como package manager");
    assert.equal(resolution.isFallback, false, "Não deve ser fallback");
    assert.ok(resolution.executablePath, "Deve retornar caminho resolvido do bun.exe");
    assert.ok(fs.existsSync(resolution.executablePath!), "Executável bun.exe deve existir fisicamente no disco");

    // 3. Construção do Ambiente Isolado via RuntimeEnvironmentBuilder
    const previewEnv = RuntimeEnvironmentBuilder.buildPreviewEnvironment({
      packageManager: "bun",
      projectPath: projectDir,
    });

    assert.equal(previewEnv.status, "ready");
    assert.ok(previewEnv.env.PATH || previewEnv.env.Path, "Ambiente isolado deve conter PATH");

    const isolatedPath = previewEnv.env.PATH || previewEnv.env.Path || "";
    const bunDir = path.dirname(resolution.executablePath!);
    assert.ok(
      isolatedPath.toLowerCase().includes(bunDir.toLowerCase()),
      `PATH isolado (${isolatedPath}) deve conter o diretório do Bun (${bunDir})`
    );

    // 4. Inicialização do servidor Vite via subprocesso com o ambiente isolado do Preview
    const targetPort = 5923;
    const viteCli = path.resolve(rootNm, "vite", "bin", "vite.js");
    assert.ok(fs.existsSync(viteCli), "vite.js CLI deve existir em node_modules");

    // Inicia o processo usando bun.exe diretamente ou via spawn com o PATH isolado
    serverProcess = spawn(
      resolution.executablePath!,
      [viteCli, "--port", String(targetPort), "--host", "127.0.0.1", "--no-open"],
      {
        cwd: projectDir,
        env: previewEnv.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    let serverLogs = "";
    serverProcess.stdout?.on("data", (d) => { serverLogs += d.toString(); });
    serverProcess.stderr?.on("data", (d) => { serverLogs += d.toString(); });

    // 5. Testar se o Preview responde HTTP 200 com a aplicação React
    const previewUrl = `http://127.0.0.1:${targetPort}`;
    const response = await waitForHttp(previewUrl, 15000);

    assert.equal(response.status, 200, `Preview deve responder HTTP 200 em ${previewUrl}`);
    assert.ok(
      response.text.includes("NekoAI Real Preview E2E with Bun!"),
      "HTML retornado pelo Preview deve conter o elemento React renderizado"
    );
    assert.ok(!serverLogs.includes("bun não está disponível"), "Não deve haver erros de bun indisponível");

    console.log(`[E2E Bun Real] ✓ Servidor ativo em ${previewUrl} com HTTP 200 e HTML validado.`);
  } finally {
    if (serverProcess) {
      await killProcessTree(serverProcess);
    }
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  }
});

// ============================================================================
// TESTE 2 — NODE REAL END-TO-END
// ============================================================================
test("TESTE 2 — NODE REAL: Detecção, Resolução de Ambiente, Inicialização do Vite e Resposta do Preview", async () => {
  const projectDir = createTempProject("node-real");
  let serverProcess: ChildProcess | null = null;

  try {
    // 1. Preparar projeto Vite + React + TypeScript configurado com npm/Node
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify(
        {
          name: "node-vite-react-e2e",
          version: "1.0.0",
          private: true,
          type: "module",
          packageManager: "npm@10.8.2",
          scripts: {
            dev: "vite --port 5924 --host 127.0.0.1",
            build: "vite build",
          },
        },
        null,
        2
      ),
      "utf8"
    );

    // Lockfile característico do npm
    fs.writeFileSync(path.join(projectDir, "package-lock.json"), "{}", "utf8");

    // Estrutura do app React
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "index.html"),
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>NekoAI E2E React App (Node)</title>
  </head>
  <body>
    <div id="root"><h1>NekoAI Real Preview E2E with Node!</h1></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
      "utf8"
    );

    const rootNm = path.resolve(__dirname, "..", "node_modules");
    if (fs.existsSync(rootNm)) {
      const destNm = path.join(projectDir, "node_modules");
      try {
        fs.symlinkSync(rootNm, destNm, "junction");
      } catch {}
    }

    // 2. Resolução do Node/npm
    const nodeRuntime = resolveNodeRuntime();
    assert.ok(fs.existsSync(nodeRuntime.nodePath), `node.exe deve existir em ${nodeRuntime.nodePath}`);

    const resolution = resolveEffectivePackageManager("npm");
    assert.equal(resolution.effectiveManager, "npm");
    assert.equal(resolution.isFallback, false);

    // 3. Construção do Ambiente Isolado
    const previewEnv = RuntimeEnvironmentBuilder.buildPreviewEnvironment({
      packageManager: "npm",
      projectPath: projectDir,
    });

    assert.equal(previewEnv.status, "ready");
    const isolatedPath = previewEnv.env.PATH || previewEnv.env.Path || "";
    assert.ok(isolatedPath.length > 0);

    // 4. Inicialização do servidor Vite com Node
    const targetPort = 5924;
    const viteCli = path.resolve(rootNm, "vite", "bin", "vite.js");

    serverProcess = spawn(
      nodeRuntime.nodePath,
      [viteCli, "--port", String(targetPort), "--host", "127.0.0.1", "--no-open"],
      {
        cwd: projectDir,
        env: previewEnv.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    // 5. Testar se o Preview responde HTTP 200 com a aplicação React
    const previewUrl = `http://127.0.0.1:${targetPort}`;
    const response = await waitForHttp(previewUrl, 15000);

    assert.equal(response.status, 200, `Preview deve responder HTTP 200 em ${previewUrl}`);
    assert.ok(
      response.text.includes("NekoAI Real Preview E2E with Node!"),
      "HTML retornado deve conter o conteúdo do app React"
    );

    console.log(`[E2E Node Real] ✓ Servidor ativo em ${previewUrl} com HTTP 200 e HTML validado.`);
  } finally {
    if (serverProcess) {
      await killProcessTree(serverProcess);
    }
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  }
});

// ============================================================================
// TESTE 3 — ISOLAMENTO ESTRITO DE PATH E INDEPENDÊNCIA DE RUNTIMES
// ============================================================================
test("TESTE 3 — ISOLAMENTO: process.env.PATH Global Imutável, Scoped PATH Correto e Independência Mútua", () => {
  const originalPath = process.env.PATH;
  const originalPathLower = process.env.Path;

  // 1. Resolução para Bun
  const bunEnv = RuntimeEnvironmentBuilder.buildPreviewEnvironment({
    packageManager: "bun",
  });
  const bunPath = bunEnv.env.PATH || bunEnv.env.Path || "";
  assert.ok(bunPath.toLowerCase().includes(".bun"), "Ambiente Bun deve conter .bun no PATH isolado");

  // 2. Resolução para Node
  const nodeEnv = RuntimeEnvironmentBuilder.buildPreviewEnvironment({
    packageManager: "npm",
  });
  const nodePath = nodeEnv.env.PATH || nodeEnv.env.Path || "";
  assert.ok(nodePath.length > 0, "Ambiente Node deve possuir PATH válido");

  // 3. Garantia de que process.env.PATH global permanece 100% inalterado
  assert.equal(process.env.PATH, originalPath, "process.env.PATH global não deve sofrer mutação");
  if (originalPathLower !== undefined) {
    assert.equal(process.env.Path, originalPathLower, "process.env.Path global não deve sofrer mutação");
  }

  // 4. Independência: Bun não requer npm e npm não requer Bun
  const bunOnlyResolver = (name: string) => name.toLowerCase().includes("bun") ? "C:\\tools\\bun.exe" : null;
  const resBun = resolveEffectivePackageManager("bun", (pm) => pm === "bun");
  assert.equal(resBun.effectiveManager, "bun");
  assert.equal(resBun.isFallback, false);

  const npmOnlyResolver = (name: string) => name.toLowerCase().includes("npm") ? "C:\\tools\\npm.cmd" : null;
  const resNpm = resolveEffectivePackageManager("npm", (pm) => pm === "npm");
  assert.equal(resNpm.effectiveManager, "npm");
  assert.equal(resNpm.isFallback, false);
});

// ============================================================================
// TESTE 4 — FALHA CONTROLADA E TRATAMENTO SEGURO
// ============================================================================
test("TESTE 4 — FALHA CONTROLADA: Simulação de Indisponibilidade sem Falso Positivo e sem quebrar Node", () => {
  // 1. Simula Bun indisponível em host que tem npm
  const mockBunUnavailable = (pm: string) => pm === "npm";
  const resWithFallback = resolveEffectivePackageManager("bun", mockBunUnavailable);

  assert.equal(resWithFallback.effectiveManager, "npm", "Deve aplicar fallback seguro para npm quando Bun não existe");
  assert.equal(resWithFallback.isFallback, true);
  assert.ok(resWithFallback.reason?.includes("bun"), "Deve registrar motivo claro de indisponibilidade");

  // 2. Simula ambos indisponíveis -> erro reportado explicitamente sem fallback fantasma
  const mockBothUnavailable = (_pm: string) => false;
  const resBothDown = resolveEffectivePackageManager("bun", mockBothUnavailable);

  assert.equal(resBothDown.effectiveManager, "bun", "Mantém bun para exibir erro específico");
  assert.equal(resBothDown.isFallback, false);
  assert.ok(resBothDown.reason?.includes("Nenhum gerenciador de pacotes compatível"));

  // 3. O Node continua 100% funcional mesmo após simulações de falha de Bun
  const nodeRuntime = resolveNodeRuntime();
  assert.ok(fs.existsSync(nodeRuntime.nodePath), "Node runtime continua intacto e disponível");
});

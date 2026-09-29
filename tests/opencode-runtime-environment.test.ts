import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  resolveNodeRuntime,
  resolveGitRuntime,
  getEmbeddedRuntimeEnv,
  clearNodeRuntimeCache,
  clearGitRuntimeCache,
} from "../src/main/node-runtime.ts";

async function createTempDir(prefix: string): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// ============================================================================
// SUÍTE DE TESTES: OPENCODE INTERNAL RUNTIME ENVIRONMENT INTEGRATION
// ============================================================================

test("1. getEmbeddedRuntimeEnv: inclui o binDir do Node.js no PATH", () => {
  clearNodeRuntimeCache();
  clearGitRuntimeCache();
  const nodeRuntime = resolveNodeRuntime();
  const env = getEmbeddedRuntimeEnv();

  const pathVal = env.PATH || env.Path || "";
  assert.ok(nodeRuntime.binDir, "binDir do Node deve existir");
  assert.ok(pathVal.includes(nodeRuntime.binDir), `PATH deve conter a pasta do Node (${nodeRuntime.binDir})`);
});

test("2. getEmbeddedRuntimeEnv: inclui os diretórios bin do Git no PATH se disponíveis", () => {
  clearNodeRuntimeCache();
  clearGitRuntimeCache();
  const gitRuntime = resolveGitRuntime();
  const env = getEmbeddedRuntimeEnv();

  const pathVal = env.PATH || env.Path || "";
  assert.ok(gitRuntime, "Git runtime deve ser resolvido (embutido ou fallback de sistema)");

  for (const binDir of gitRuntime.binDirs) {
    assert.ok(pathVal.includes(binDir), `PATH deve conter o diretório do Git: ${binDir}`);
  }
});

test("3. getEmbeddedRuntimeEnv: caminhos embutidos têm precedência (ficam no início) sobre o PATH global", () => {
  clearNodeRuntimeCache();
  clearGitRuntimeCache();
  const nodeRuntime = resolveNodeRuntime();
  const gitRuntime = resolveGitRuntime();
  const env = getEmbeddedRuntimeEnv();

  const pathVal = env.PATH || env.Path || "";
  const segments = pathVal.split(path.delimiter);

  assert.equal(segments[0], nodeRuntime.binDir, "O primeiro segmento do PATH deve ser o binDir do Node");
  if (gitRuntime?.binDirs && gitRuntime.binDirs.length > 0) {
    for (const binDir of gitRuntime.binDirs) {
      const idx = segments.indexOf(binDir);
      assert.ok(idx >= 0, `Diretório do Git (${binDir}) deve estar presente nos primeiros segmentos do PATH`);
    }
  }
});

test("4. getEmbeddedRuntimeEnv: preserva variáveis existentes de process.env e flags de ambiente do OpenCode", () => {
  clearNodeRuntimeCache();
  clearGitRuntimeCache();

  const mockBaseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_NEKO_VAR: "active_neko_value",
    OPENCODE_EXPERIMENTAL_PLAN_MODE: "true",
  };

  const env = getEmbeddedRuntimeEnv(mockBaseEnv);

  assert.equal(env.TEST_NEKO_VAR, "active_neko_value", "Variáveis customizadas de ambiente devem ser preservadas");
  assert.equal(env.OPENCODE_EXPERIMENTAL_PLAN_MODE, "true", "Flags de modo do OpenCode devem ser preservadas");
});

test("5. getEmbeddedRuntimeEnv: NÃO sofre mutação global em process.env.PATH", () => {
  clearNodeRuntimeCache();
  clearGitRuntimeCache();

  const initialGlobalPath = process.env.PATH;
  const env = getEmbeddedRuntimeEnv();

  assert.equal(process.env.PATH, initialGlobalPath, "process.env.PATH global NÃO pode sofrer mutação");
  assert.notEqual(env.PATH, initialGlobalPath, "O objeto env retornado deve ter o PATH enriquecido");
});

test("6. Simulação de Máquina Limpa (NEKO_NODE_PATH e NEKO_GIT_PATH override): OpenCode recebe runtimes mockados no topo do PATH", async () => {
  const tempDir = await createTempDir("opencode-env-mock");
  const isWin = process.platform === "win32";

  const fakeNodeDir = path.join(tempDir, "tools", "node");
  const fakeGitCmdDir = path.join(tempDir, "tools", "git", "cmd");
  const fakeGitMingwDir = path.join(tempDir, "tools", "git", "mingw64", "bin");
  const fakeGitUsrDir = path.join(tempDir, "tools", "git", "usr", "bin");

  await fs.mkdir(fakeNodeDir, { recursive: true });
  await fs.mkdir(fakeGitCmdDir, { recursive: true });
  await fs.mkdir(fakeGitMingwDir, { recursive: true });
  await fs.mkdir(fakeGitUsrDir, { recursive: true });

  const fakeNode = path.join(fakeNodeDir, isWin ? "node.exe" : "node");
  const fakeGit = path.join(fakeGitCmdDir, isWin ? "git.exe" : "git");

  await fs.writeFile(fakeNode, "fake node binary");
  await fs.writeFile(fakeGit, "fake git binary");

  const origNodeEnv = process.env.NEKO_NODE_PATH;
  const origGitEnv = process.env.NEKO_GIT_PATH;

  process.env.NEKO_NODE_PATH = fakeNode;
  process.env.NEKO_GIT_PATH = fakeGit;

  clearNodeRuntimeCache();
  clearGitRuntimeCache();

  try {
    const env = getEmbeddedRuntimeEnv();
    const pathVal = env.PATH || env.Path || "";
    const segments = pathVal.split(path.delimiter);

    assert.equal(segments[0], fakeNodeDir, "O Node.js mockado deve ser o primeiro item no PATH");
    assert.ok(segments.includes(fakeGitCmdDir), "O diretório cmd do Git mockado deve estar no PATH");
    assert.ok(segments.includes(fakeGitMingwDir), "O diretório mingw64/bin do Git mockado deve estar no PATH");
    assert.ok(segments.includes(fakeGitUsrDir), "O diretório usr/bin do Git mockado deve estar no PATH");

    // Validar montagem final do env para o OpenCode
    const finalOpenCodeEnv = {
      ...env,
      OPENCODE_EXPERIMENTAL_PLAN_MODE: "true",
    };

    assert.equal(finalOpenCodeEnv.OPENCODE_EXPERIMENTAL_PLAN_MODE, "true");
    assert.ok(finalOpenCodeEnv.PATH?.startsWith(fakeNodeDir));
  } finally {
    if (origNodeEnv !== undefined) process.env.NEKO_NODE_PATH = origNodeEnv;
    else delete process.env.NEKO_NODE_PATH;

    if (origGitEnv !== undefined) process.env.NEKO_GIT_PATH = origGitEnv;
    else delete process.env.NEKO_GIT_PATH;

    clearNodeRuntimeCache();
    clearGitRuntimeCache();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. Execução Real de Subprocesso: processo filho herdando getEmbeddedRuntimeEnv resolve executáveis embutidos", () => {
  clearNodeRuntimeCache();
  clearGitRuntimeCache();

  const runtimeEnv = getEmbeddedRuntimeEnv();
  const isWin = process.platform === "win32";

  // Testar execução de Node.js via ambiente enriquecido
  const resNode = spawnSync(isWin ? "node.exe" : "node", ["--version"], {
    env: runtimeEnv,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(resNode.status, 0, "O comando node --version via runtimeEnv deve executar com sucesso (código 0)");
  assert.ok(resNode.stdout.trim().startsWith("v"), "A saída do Node deve retornar a versão vX.Y.Z");

  // Testar execução de Git via ambiente enriquecido
  const resGit = spawnSync(isWin ? "git.exe" : "git", ["--version"], {
    env: runtimeEnv,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(resGit.status, 0, "O comando git --version via runtimeEnv deve executar com sucesso (código 0)");
  assert.ok(resGit.stdout.trim().toLowerCase().includes("git version"), "A saída do Git deve retornar 'git version'");
});

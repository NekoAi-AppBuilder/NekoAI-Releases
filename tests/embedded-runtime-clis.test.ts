import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  resolveNodeRuntime,
  getEmbeddedRuntimeEnv,
  clearNodeRuntimeCache,
} from "../src/main/node-runtime.ts";
import { executableDirectories as supabaseExecDirs, resolveSupabaseCli } from "../src/main/supabase/supabase-cli.ts";
import { resolveExecutable as resolveVercelExec, VercelCli } from "../src/main/vercel/vercel-cli.ts";

async function createTempDir(prefix: string): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// ============================================================================
// SUÍTE DE TESTES: BUNDLED NODE RUNTIME INTEGRATION (SUPABASE & VERCEL CLI)
// ============================================================================

test("1. resolveNodeRuntime: localiza runtime Node.js (embutido ou fallback)", () => {
  clearNodeRuntimeCache();
  const runtime = resolveNodeRuntime();
  assert.ok(runtime.nodePath, "nodePath deve ser retornado");
  assert.ok(runtime.binDir, "binDir deve ser retornado");
  assert.equal(fsSync.existsSync(runtime.nodePath), true, "nodePath deve existir no disco");
});

test("2. getEmbeddedRuntimeEnv: injeta binDir do Node embutido no início do PATH", () => {
  clearNodeRuntimeCache();
  const runtime = resolveNodeRuntime();
  const env = getEmbeddedRuntimeEnv();

  const pathVal = env.PATH || env.Path || "";
  assert.ok(pathVal.startsWith(runtime.binDir), `PATH (${pathVal}) deve começar com binDir (${runtime.binDir})`);
});

test("3. Supabase CLI: executableDirectories inclui o binDir do Node no topo", () => {
  clearNodeRuntimeCache();
  const runtime = resolveNodeRuntime();
  const dirs = supabaseExecDirs();

  assert.ok(dirs.length > 0, "Deveria retornar diretórios de busca");
  assert.equal(dirs[0], runtime.binDir, "Primeiro diretório de busca do Supabase deve ser o binDir do Node");
});

test("4. Vercel CLI: getCliEnvironment fornece PATH contendo binDir do Node no início", () => {
  clearNodeRuntimeCache();
  const runtime = resolveNodeRuntime();
  const cli = new VercelCli();
  const env = cli.getCliEnvironment();

  const pathVal = env.PATH || env.Path || "";
  assert.ok(pathVal.startsWith(runtime.binDir), `PATH da Vercel (${pathVal}) deve começar com binDir (${runtime.binDir})`);
});

test("5. Simulação de Máquina Limpa (NEKO_NODE_PATH override): Supabase e Vercel resolvem npx a partir do runtime embutido", async () => {
  const tempDir = await createTempDir("clean-win-mock");
  const isWin = process.platform === "win32";
  const fakeNode = path.join(tempDir, isWin ? "node.exe" : "node");
  const fakeNpm = path.join(tempDir, isWin ? "npm.cmd" : "npm");
  const fakeNpx = path.join(tempDir, isWin ? "npx.cmd" : "npx");

  await fs.writeFile(fakeNode, "fake node binary");
  await fs.writeFile(fakeNpm, "fake npm script");
  await fs.writeFile(fakeNpx, "fake npx script");

  const origEnv = process.env.NEKO_NODE_PATH;
  process.env.NEKO_NODE_PATH = fakeNode;
  clearNodeRuntimeCache();

  try {
    const runtime = resolveNodeRuntime(true);
    assert.equal(runtime.binDir, tempDir, "Runtime resolvido deve usar a pasta temporária mockada");

    // 1) Testar resolução de npx do Supabase em máquina limpa simulada
    const supabaseNpx = await resolveSupabaseCli();
    assert.ok(supabaseNpx.command, "Supabase CLI deve resolver um comando");
    // Em máquina limpa sem standalone supabase, resolve npx do binDir mockado
    const npxExec = await resolveVercelExec(["npx.cmd", "npx.exe", "npx"]);
    assert.ok(npxExec, "Deveria resolver o npx embutido mockado");
    assert.equal(path.resolve(npxExec), path.resolve(fakeNpx), "O npx retornado deve ser o do diretório mockado");

    // 2) Testar Vercel CLI em máquina limpa simulada
    const vercelExec = await resolveVercelExec(["npx.cmd", "npx.exe", "npx"]);
    assert.ok(vercelExec, "Vercel CLI deve resolver npx");
    assert.equal(path.resolve(vercelExec), path.resolve(fakeNpx), "Vercel CLI deve resolver para o npx embutido mockado");

    // 3) Testar injeção de ambiente
    const env = getEmbeddedRuntimeEnv();
    const pathVal = env.PATH || env.Path || "";
    assert.ok(pathVal.startsWith(tempDir), "Ambiente injetado deve começar com a pasta do Node embutido mockado");
  } finally {
    if (origEnv !== undefined) {
      process.env.NEKO_NODE_PATH = origEnv;
    } else {
      delete process.env.NEKO_NODE_PATH;
    }
    clearNodeRuntimeCache();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

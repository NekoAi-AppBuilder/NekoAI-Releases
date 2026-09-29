import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Auto Commit Decoupling & Isolation
 * Valida a desassociação entre validação de build e o acionamento do Auto Commit no GitHub.
 */

interface BuildResult {
  ok: boolean;
  skipped: boolean;
  message: string;
  output: string;
}

interface GitStatus {
  initialized: boolean;
  remote: boolean;
  linkedRepo: string | null;
  dirty: boolean;
  branch: string | null;
}

interface AutoCommitResult {
  ok: boolean;
  committed?: boolean;
  pushed?: boolean;
  skipped?: boolean;
  reason?: string;
  message?: string;
  error?: string;
}

// Simula o orquestrador do NekoAI desacoplado
async function runPostTaskProcess(
  build: BuildResult,
  githubConfigured: boolean,
  gitStatus: GitStatus,
  githubOnline: boolean
): Promise<{ validationState: "done" | "error"; autoCommitResult: AutoCommitResult }> {
  // 1. Independent Build Validation Reporting
  const validationState = build.ok ? "done" : "error";

  // 2. Independent Auto Commit Dispatch
  if (!githubConfigured || !gitStatus.initialized || !gitStatus.linkedRepo) {
    return {
      validationState,
      autoCommitResult: { ok: false, skipped: true, reason: "not-linked", message: "Projeto não conectado ao GitHub." }
    };
  }

  if (!githubOnline) {
    return {
      validationState,
      autoCommitResult: { ok: false, skipped: false, error: "Falha de conexão com a API do GitHub." }
    };
  }

  if (!gitStatus.dirty) {
    return {
      validationState,
      autoCommitResult: { ok: true, committed: false, pushed: false, message: "Nenhuma alteração pendente para enviar ao GitHub." }
    };
  }

  // Simula commit e push bem-sucedidos
  return {
    validationState,
    autoCommitResult: { ok: true, committed: true, pushed: true, message: "Alterações enviadas automaticamente para o GitHub." }
  };
}

test("A) Supabase nativo + build OK -> Auto Commit executado com sucesso", async () => {
  const build: BuildResult = { ok: true, skipped: false, message: "Build validado.", output: "" };
  const gitStatus: GitStatus = { initialized: true, remote: true, linkedRepo: "user/supabase-app", dirty: true, branch: "main" };
  
  const result = await runPostTaskProcess(build, true, gitStatus, true);
  
  assert.equal(result.validationState, "done");
  assert.equal(result.autoCommitResult.ok, true);
  assert.equal(result.autoCommitResult.committed, true);
  assert.equal(result.autoCommitResult.pushed, true);
});

test("B) Lovable Cloud + build FAIL/WARNING -> Auto Commit AINDA É TENTADO e executado", async () => {
  const build: BuildResult = { ok: false, skipped: false, message: "O build encontrou erros.", output: "TS2304: Cannot find name 'Vite'" };
  const gitStatus: GitStatus = { initialized: true, remote: true, linkedRepo: "user/lovable-app", dirty: true, branch: "main" };
  
  const result = await runPostTaskProcess(build, true, gitStatus, true);
  
  // A validação reporta aviso/erro, mas o Auto Commit NÃO É BLOQUEADO!
  assert.equal(result.validationState, "error");
  assert.equal(result.autoCommitResult.ok, true);
  assert.equal(result.autoCommitResult.committed, true);
  assert.equal(result.autoCommitResult.pushed, true);
});

test("C) Build FAIL + GitHub indisponível -> erro explícito de rede sem fingir sucesso", async () => {
  const build: BuildResult = { ok: false, skipped: false, message: "O build encontrou erros.", output: "Warning" };
  const gitStatus: GitStatus = { initialized: true, remote: true, linkedRepo: "user/app", dirty: true, branch: "main" };
  
  const result = await runPostTaskProcess(build, true, gitStatus, false); // GitHub offline
  
  assert.equal(result.validationState, "error");
  assert.equal(result.autoCommitResult.ok, false);
  assert.match(result.autoCommitResult.error || "", /Falha de conexão/);
});

test("D) Auto Commit falha por repositório não vinculado -> status skipped/not-linked retornado", async () => {
  const build: BuildResult = { ok: true, skipped: false, message: "Build validado.", output: "" };
  const gitStatus: GitStatus = { initialized: true, remote: false, linkedRepo: null, dirty: true, branch: null };
  
  const result = await runPostTaskProcess(build, false, gitStatus, true);
  
  assert.equal(result.autoCommitResult.ok, false);
  assert.equal(result.autoCommitResult.skipped, true);
  assert.equal(result.autoCommitResult.reason, "not-linked");
});

test("E) Auto Commit funciona -> commit + push confirmados", async () => {
  const build: BuildResult = { ok: true, skipped: false, message: "Build validado.", output: "" };
  const gitStatus: GitStatus = { initialized: true, remote: true, linkedRepo: "user/repo", dirty: true, branch: "main" };
  
  const result = await runPostTaskProcess(build, true, gitStatus, true);
  
  assert.equal(result.autoCommitResult.committed, true);
  assert.equal(result.autoCommitResult.pushed, true);
  assert.equal(result.autoCommitResult.message, "Alterações enviadas automaticamente para o GitHub.");
});

test("F) Nenhuma alteração Git -> não criar commit vazio", async () => {
  const build: BuildResult = { ok: true, skipped: false, message: "Build validado.", output: "" };
  const gitStatus: GitStatus = { initialized: true, remote: true, linkedRepo: "user/repo", dirty: false, branch: "main" }; // clean
  
  const result = await runPostTaskProcess(build, true, gitStatus, true);
  
  assert.equal(result.autoCommitResult.ok, true);
  assert.equal(result.autoCommitResult.committed, false);
  assert.equal(result.autoCommitResult.pushed, false);
  assert.match(result.autoCommitResult.message || "", /Nenhuma alteração pendente/);
});

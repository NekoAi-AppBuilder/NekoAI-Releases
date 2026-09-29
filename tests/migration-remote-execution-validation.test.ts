import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { MigrationManager } from "../src/main/supabase/migration-manager.ts";
import { isMigrationErrorText } from "../src/main/security/sql-guard.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neko-test-migration-${prefix}-`));
}

test("A. Arquivo SQL criado sem chamada remota -> NÃO SUCCESS", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_a",
    projectRef: "valid-ref-123",
    name: "create_users",
    sql: "CREATE TABLE users (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_a")!;
  assert.ok(proposal, "Proposta deve existir");
  assert.equal(proposal.status, "PENDING");
  assert.notEqual(proposal.status, "SUCCESS", "Arquivo SQL criado sem chamada remota não pode ser SUCCESS");
});

test("B. OpenCode retorna completed, mas nenhuma ferramenta remota foi executada -> NÃO SUCCESS", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_b",
    projectRef: "valid-ref-456",
    name: "unexecuted_tool",
    sql: "CREATE TABLE posts (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_b")!;
  await manager.replyProposal(proposal.id, true);
  manager.notifyToolExecuting(proposal.id);

  // Notifica conclusão sem remoteApplied (sem ferramenta remota executada)
  await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: false });

  assert.notEqual(proposal.status, "SUCCESS", "Sem aplicação remota confirmada, não pode ser SUCCESS");
  assert.equal(proposal.status, "FAILED");
  assert.match(proposal.error || "", /confirmação de aplicação remota/);
});

test("C. projectRef válido, mas aplicação remota não executada -> NÃO SUCCESS", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_c",
    projectRef: "valid-ref-789",
    name: "valid_ref_no_remote",
    sql: "CREATE TABLE t_c (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_c")!;
  await manager.replyProposal(proposal.id, true);

  assert.notEqual(proposal.status, "SUCCESS", "projectRef válido sem execução remota não marca SUCCESS");
  assert.equal(proposal.status, "APPROVED");
});

test("D. Ferramenta remota retorna falha estruturada -> FAILED", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_d",
    projectRef: "valid-ref-000",
    name: "fail_struct",
    sql: "CREATE TABLE t_d (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_d")!;
  await manager.replyProposal(proposal.id, true);

  manager.notifyToolExecuting(proposal.id);
  await manager.notifyToolCompleted(proposal.id, true, undefined, {
    remoteApplied: true,
    structuredResult: { isError: true, error: "PostgreSQL Syntax Error at line 1" }
  });

  assert.equal(proposal.status, "FAILED");
  assert.match(proposal.error || "", /Syntax Error/);
});

test("E. Ferramenta remota retorna exit code diferente de zero -> FAILED", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_e",
    projectRef: "valid-ref-111",
    name: "exit_nonzero",
    sql: "CREATE TABLE t_e (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_e")!;
  await manager.replyProposal(proposal.id, true);

  manager.notifyToolExecuting(proposal.id);
  await manager.notifyToolCompleted(proposal.id, true, undefined, {
    remoteApplied: true,
    exitCode: 1,
    stderr: "Error: Process exited with code 1"
  });

  assert.equal(proposal.status, "FAILED");
  assert.match(proposal.error || "", /código de saída 1|Process exited/);
});

test("F. Ferramenta remota retorna sucesso confirmado -> SUCCESS", async () => {
  const manager = new MigrationManager();
  const dir = createTempDir("valid-f");
  try {
    const promise = manager.proposeMigration({
      sessionId: "sess_f",
      projectRef: "valid-ref-f",
      name: "valid_f",
      sql: "CREATE TABLE t_f (id uuid primary key);",
      projectRoot: dir
    });

    const proposal = manager.getPendingProposalForSession("sess_f")!;
    await manager.replyProposal(proposal.id, true);

    manager.notifyToolExecuting(proposal.id);
    await manager.notifyToolCompleted(proposal.id, true, undefined, {
      remoteApplied: true,
      exitCode: 0,
      providerConfirmed: true
    });

    const res = await promise;
    assert.equal(res.status, "SUCCESS");
    assert.equal(proposal.status, "SUCCESS");
    assert.ok(proposal.appliedFilename?.includes("supabase/migrations/"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G. Resultado de outra migration/proposalId não pode concluir a proposta atual", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_g",
    projectRef: "valid-ref-g",
    name: "prop_g",
    sql: "CREATE TABLE t_g (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_g")!;
  await manager.replyProposal(proposal.id, true);
  manager.notifyToolExecuting(proposal.id);

  // Tenta notificar com ID inexistente ou de outra proposta
  await manager.notifyToolCompleted("wrong-proposal-id-999", true, undefined, { remoteApplied: true });

  assert.equal(proposal.status, "EXECUTING", "Proposta atual não pode ser concluída por ID de outra proposta");
});

test("H. Falha de autenticação ou vínculo remoto -> FAILED", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_h",
    projectRef: "none", // Vínculo inválido
    name: "auth_fail",
    sql: "CREATE TABLE t_h (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_h")!;
  await manager.replyProposal(proposal.id, true);

  await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: true });
  assert.equal(proposal.status, "FAILED", "Vínculo remoto inválido ('none') deve falhar");
  assert.match(proposal.error || "", /Nenhum projeto remoto vinculado/);
});

test("I. Timeout ou resposta inconclusiva -> NÃO SUCCESS", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_i",
    projectRef: "ref-i",
    name: "inconclusive",
    sql: "CREATE TABLE t_i (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_i")!;
  await manager.replyProposal(proposal.id, true);

  manager.notifyToolExecuting(proposal.id);
  // Resposta inconclusiva sem remoteApplied
  await manager.notifyToolCompleted(proposal.id, true, undefined, {});

  assert.notEqual(proposal.status, "SUCCESS");
  assert.equal(proposal.status, "FAILED");
});

test("J. A execução não pode ser finalizada duas vezes por eventos duplicados do OpenCode", async () => {
  const manager = new MigrationManager();
  const dir = createTempDir("dup-j");
  try {
    const promise = manager.proposeMigration({
      sessionId: "sess_j",
      projectRef: "ref-j",
      name: "idempotent_j",
      sql: "CREATE TABLE t_j (id uuid primary key);",
      projectRoot: dir
    });

    const proposal = manager.getPendingProposalForSession("sess_j")!;
    await manager.replyProposal(proposal.id, true);
    manager.notifyToolExecuting(proposal.id);

    // Primeira notificação -> SUCCESS
    await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: true, exitCode: 0 });
    assert.equal(proposal.status, "SUCCESS");

    // Segunda notificação tardia/duplicada com erro -> IGNORADA
    await manager.notifyToolCompleted(proposal.id, false, "Late duplicate error", { remoteApplied: false });
    assert.equal(proposal.status, "SUCCESS", "Estado terminal SUCCESS não pode ser sobrescrito por evento duplicado");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("K. Fluxo de criação local permanece separado da aplicação remota", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_k",
    projectRef: "ref-k",
    name: "local_sep",
    sql: "CREATE TABLE t_k (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_k")!;
  await manager.replyProposal(proposal.id, true);

  // Aprovação do usuário coloca em APPROVED, mas NÃO é SUCCESS remoto
  assert.equal(proposal.status, "APPROVED");
  assert.notEqual(proposal.status, "SUCCESS");
});

test("L. TESTE DE FALSO SUCESSO (Reprodução exata do bug do PC limpo)", async () => {
  const manager = new MigrationManager();
  const dir = createTempDir("bug-repro");

  try {
    // 1. Cria o arquivo de migração localmente
    const migrationFile = path.join(dir, "supabase", "migrations", "20260926_test.sql");
    fs.mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
    fs.writeFileSync(migrationFile, "CREATE TABLE bug_test (id int);", "utf8");

    // 2. Projeta e aprova a proposta no MigrationManager
    const promise = manager.proposeMigration({
      sessionId: "sess_bug",
      projectRef: "ref-bug",
      name: "bug_test",
      sql: "CREATE TABLE bug_test (id int);",
      projectRoot: dir
    });

    const proposal = manager.getPendingProposalForSession("sess_bug")!;
    await manager.replyProposal(proposal.id, true);

    // 3. Simula que a aplicação remota NÃO FOI EXECUTADA
    // O fluxo termina sem notificar sucesso remoto comprovado
    assert.notEqual(proposal.status, "SUCCESS", "REQUISITO OBRIGATÓRIO: O resultado NÃO pode ser SUCCESS quando a aplicação remota não foi confirmada");
    assert.equal(proposal.status, "APPROVED", "Status deve permanecer em APPROVED/PENDING/FAILED, jamais SUCCESS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

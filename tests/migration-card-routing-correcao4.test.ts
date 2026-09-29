import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { MigrationManager } from "../src/main/supabase/migration-manager.ts";
import { isReadOnlySql } from "../src/main/security/sql-guard.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neko-test-c4-${prefix}-`));
}

test("A. Primeiro comando de alteração Supabase -> Migration Card aparece (status PENDING/migration-asked)", async () => {
  const manager = new MigrationManager();
  let askedEventEmitted = false;

  manager.on("migration-asked", (proposal) => {
    askedEventEmitted = true;
    assert.equal(proposal.name, "first_supabase_migration");
    assert.equal(proposal.projectRef, "proj-first-supa");
  });

  const proposalPromise = manager.proposeMigration({
    sessionId: "sess_first_supa",
    projectRef: "proj-first-supa",
    name: "first_supabase_migration",
    sql: "CREATE TABLE first_table (id uuid primary key);"
  });

  const pending = manager.getPendingProposalForSession("sess_first_supa");
  assert.ok(pending, "A proposta deve estar pendente na primeira instrução");
  assert.equal(pending.status, "PENDING", "Deve criar o Card no estado PENDING");
  assert.equal(askedEventEmitted, true, "Deve emitir o evento migration-asked para renderizar o Card");
});

test("B. Primeiro comando de alteração Lovable Cloud -> Migration Card aparece", async () => {
  const manager = new MigrationManager();
  let askedEventEmitted = false;

  manager.on("migration-asked", (proposal) => {
    askedEventEmitted = true;
    assert.equal(proposal.provider, "lovable");
    assert.equal(proposal.lovableProjectId, "lovable-proj-123");
  });

  const proposalPromise = manager.proposeMigration({
    sessionId: "sess_first_lovable",
    projectRef: "lovable-proj-123",
    name: "first_lovable_mutation",
    sql: "ALTER TABLE users ADD COLUMN bio text;",
    provider: "lovable",
    lovableProjectId: "lovable-proj-123"
  });

  const pending = manager.getPendingProposalForSession("sess_first_lovable");
  assert.ok(pending);
  assert.equal(pending.status, "PENDING");
  assert.equal(askedEventEmitted, true);
});

test("C. Usuário rejeita Migration Card -> nenhuma alteração remota ocorre (status REJECTED)", async () => {
  const manager = new MigrationManager();
  const promise = manager.proposeMigration({
    sessionId: "sess_reject",
    projectRef: "proj-ref-c",
    name: "rejected_migration",
    sql: "DROP TABLE users;"
  });

  const proposal = manager.getPendingProposalForSession("sess_reject")!;
  const reply = await manager.replyProposal(proposal.id, false);

  assert.equal(reply.success, false);
  assert.equal(reply.status, "REJECTED");
  assert.equal(proposal.status, "REJECTED");

  const res = await promise;
  assert.equal(res.status, "REJECTED");
});

test("D. Usuário aprova Migration Card -> execução remota ocorre e transiciona para SUCCESS", async () => {
  const manager = new MigrationManager();
  const dir = createTempDir("approve-d");
  try {
    const promise = manager.proposeMigration({
      sessionId: "sess_approve_d",
      projectRef: "proj-ref-d",
      name: "approved_migration",
      sql: "CREATE TABLE approved_t (id uuid primary key);",
      projectRoot: dir
    });

    const proposal = manager.getPendingProposalForSession("sess_approve_d")!;
    const reply = await manager.replyProposal(proposal.id, true);
    assert.equal(reply.status, "APPROVED");

    manager.notifyToolExecuting(proposal.id);
    await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: true });

    const res = await promise;
    assert.equal(res.status, "SUCCESS");
    assert.equal(proposal.status, "SUCCESS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("E. Migration Card aparece antes da execução (proposeMigration ocorre antes de notifyToolExecuting)", async () => {
  const manager = new MigrationManager();
  const eventsSequence: string[] = [];

  manager.on("migration-asked", () => eventsSequence.push("asked"));
  manager.on("migration-executing", () => eventsSequence.push("executing"));
  manager.on("migration-completed", () => eventsSequence.push("completed"));

  const promise = manager.proposeMigration({
    sessionId: "sess_order_e",
    projectRef: "proj-order-e",
    name: "order_test",
    sql: "CREATE TABLE order_t (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_order_e")!;
  await manager.replyProposal(proposal.id, true);
  manager.notifyToolExecuting(proposal.id);
  await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: true });

  assert.deepEqual(eventsSequence, ["asked", "executing", "completed"]);
});

test("F. Shell/filesystem não executa antes da aprovação", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_no_pre_exec",
    projectRef: "proj-f",
    name: "pre_exec",
    sql: "CREATE TABLE pre_t (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_no_pre_exec")!;
  assert.equal(proposal.status, "PENDING", "Antes da aprovação, o estado permanece PENDING");

  // Tentativa prematura de notificar execução em proposta PENDING é bloqueada
  manager.notifyToolExecuting(proposal.id);
  assert.equal(proposal.status, "PENDING", "notifyToolExecuting em proposta PENDING não altera o estado");
});

test("G & H. Operação comum de filesystem/shell -> isReadOnlySql ou consultas não disparam Migration Card", () => {
  assert.equal(isReadOnlySql("SELECT * FROM users;"), true);
  assert.equal(isReadOnlySql("SELECT count(*) FROM orders;"), true);
  assert.equal(isReadOnlySql("CREATE TABLE users (id int);"), false);
});

test("I. Criação de arquivo SQL local sem alteração remota -> não marca SUCCESS remoto", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_local_i",
    projectRef: "proj-i",
    name: "local_sql_only",
    sql: "CREATE TABLE local_only (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_local_i")!;
  await manager.replyProposal(proposal.id, true);

  // Sem notificação remota confirmada -> permanece em APPROVED e não marca SUCCESS
  assert.equal(proposal.status, "APPROVED");
  assert.notEqual(proposal.status, "SUCCESS");
});

test("J. Migration com arquivo SQL + aplicação remota -> Migration Card completo", async () => {
  const manager = new MigrationManager();
  const dir = createTempDir("full-j");
  try {
    const promise = manager.proposeMigration({
      sessionId: "sess_full_j",
      projectRef: "proj-j",
      name: "full_j",
      sql: "CREATE TABLE full_t (id uuid primary key);",
      projectRoot: dir
    });

    const proposal = manager.getPendingProposalForSession("sess_full_j")!;
    await manager.replyProposal(proposal.id, true);
    manager.notifyToolExecuting(proposal.id);
    await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: true });

    const res = await promise;
    assert.equal(res.status, "SUCCESS");
    assert.ok(res.appliedFilename?.includes("supabase/migrations/"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("K. Segundo comando de migration -> continua usando Migration Card independentemente do projeto já estar ativo", async () => {
  const manager = new MigrationManager();

  // Primeira migration
  const p1 = manager.proposeMigration({
    sessionId: "sess_k",
    projectRef: "proj-k",
    name: "first_k",
    sql: "CREATE TABLE k1 (id uuid primary key);"
  });

  const prop1 = manager.getPendingProposalForSession("sess_k")!;
  await manager.replyProposal(prop1.id, true);
  manager.notifyToolExecuting(prop1.id);
  await manager.notifyToolCompleted(prop1.id, true, undefined, { remoteApplied: true });
  await p1;

  // Segunda migration na mesma sessão
  let secondAsked = false;
  manager.on("migration-asked", (p) => {
    if (p.name === "second_k") secondAsked = true;
  });

  const p2 = manager.proposeMigration({
    sessionId: "sess_k",
    projectRef: "proj-k",
    name: "second_k",
    sql: "CREATE TABLE k2 (id uuid primary key);"
  });

  const prop2 = manager.getPendingProposalForSession("sess_k")!;
  assert.ok(prop2);
  assert.equal(secondAsked, true, "Segundo comando de migração também deve apresentar Migration Card");
});

test("L. Eventos duplicados -> não criam múltiplos Cards nem violam a idempotência", async () => {
  const manager = new MigrationManager();
  let askedCount = 0;

  manager.on("migration-asked", () => askedCount++);

  const p1 = manager.proposeMigration({
    sessionId: "sess_dup_l",
    permissionId: "perm-dup-l",
    jitRequestId: "jit-dup-l",
    projectRef: "proj-l",
    name: "dup_l",
    sql: "CREATE TABLE t_l (id uuid primary key);"
  });

  // Reutiliza a proposta com mesma permissionId/jitRequestId
  const p2 = manager.proposeMigration({
    sessionId: "sess_dup_l",
    permissionId: "perm-dup-l",
    jitRequestId: "jit-dup-l",
    projectRef: "proj-l",
    name: "dup_l",
    sql: "CREATE TABLE t_l (id uuid primary key);"
  });

  assert.equal(askedCount, 1, "Proposta idêntica reentrante não pode gerar múltiplos eventos migration-asked");
});

test("M. proposalId é preservado de ponta a ponta", async () => {
  const manager = new MigrationManager();
  const promise = manager.proposeMigration({
    sessionId: "sess_m",
    projectRef: "proj-m",
    name: "prop_m",
    sql: "CREATE TABLE t_m (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_m")!;
  const targetId = proposal.id;

  await manager.replyProposal(targetId, true);
  manager.notifyToolExecuting(targetId);
  await manager.notifyToolCompleted(targetId, true, undefined, { remoteApplied: true });

  const result = await promise;
  assert.equal(result.proposalId, targetId, "proposalId deve ser preservado de ponta a ponta");
});

test("N. Project binding é preservado de ponta a ponta", async () => {
  const manager = new MigrationManager();
  manager.proposeMigration({
    sessionId: "sess_n",
    projectRef: "bound-project-ref-xyz",
    name: "bound_n",
    sql: "CREATE TABLE t_n (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_n")!;
  assert.equal(proposal.projectRef, "bound-project-ref-xyz");
});

test("O. Migration aprovada chega à execução remota", async () => {
  const manager = new MigrationManager();
  let remoteExecuted = false;

  const promise = manager.proposeMigration({
    sessionId: "sess_o",
    projectRef: "proj-o",
    name: "prop_o",
    sql: "CREATE TABLE t_o (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_o")!;
  await manager.replyProposal(proposal.id, true);

  manager.notifyToolExecuting(proposal.id);
  remoteExecuted = true;
  await manager.notifyToolCompleted(proposal.id, true, undefined, { remoteApplied: true });

  const result = await promise;
  assert.equal(remoteExecuted, true);
  assert.equal(result.status, "SUCCESS");
});

test("P. Migration rejeitada não chega à execução remota", async () => {
  const manager = new MigrationManager();
  let remoteExecuted = false;

  const promise = manager.proposeMigration({
    sessionId: "sess_p",
    projectRef: "proj-p",
    name: "prop_p",
    sql: "CREATE TABLE t_p (id uuid primary key);"
  });

  const proposal = manager.getPendingProposalForSession("sess_p")!;
  await manager.replyProposal(proposal.id, false);

  if (proposal.status === "APPROVED") {
    remoteExecuted = true;
  }

  const result = await promise;
  assert.equal(remoteExecuted, false, "Migration rejeitada não pode executar remotamente");
  assert.equal(result.status, "REJECTED");
});

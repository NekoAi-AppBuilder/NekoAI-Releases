import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  validateMigrationSql,
  normalizeSqlForHash,
  extractAffectedTablesFromSql,
  classifySqlRisk,
  isReadOnlySql
} from "../src/main/security/sql-guard.ts";

import {
  MigrationManager,
  APPROVAL_TIMEOUT_MS
} from "../src/main/supabase/migration-manager.ts";

import {
  MigrationProposalRequest,
  MigrationExecutionResult
} from "../src/main/supabase/migration-types.ts";

// ============================================================
// 1. TESTES DE VALIDAÇÃO SQL PARA MIGRATIONS (DDL / MUTATION)
// ============================================================

test("Migration SQL Guard: Permite DDL válido e declarações múltiplas", () => {
  const validDdl = `
    CREATE TABLE IF NOT EXISTS todos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task TEXT NOT NULL,
      completed BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority INT DEFAULT 1;

    CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at);
  `;

  const res = validateMigrationSql(validDdl);
  assert.equal(res.valid, true);
  assert.equal(res.risk, "SAFE_WRITE");
  assert.deepEqual(res.affectedTables.sort(), ["todos"]);
});

test("Migration SQL Guard: Detecta risco DESTRUCTIVE para DROP e TRUNCATE", () => {
  const destructiveQueries = [
    { sql: "DROP TABLE users CASCADE;", expectedTable: "users" },
    { sql: "TRUNCATE TABLE orders;", expectedTable: "orders" },
    { sql: "ALTER TABLE products DROP COLUMN obsolete_field;", expectedTable: "products" }
  ];

  for (const item of destructiveQueries) {
    const res = validateMigrationSql(item.sql);
    assert.equal(res.valid, true);
    assert.equal(res.risk, "DESTRUCTIVE");
    assert.ok(res.affectedTables.includes(item.expectedTable));
  }
});

test("Migration SQL Guard: Bloqueia funções perigosas de sistema", () => {
  const dangerous = [
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity;",
    "SELECT lo_import('/etc/passwd');",
    "SELECT dblink_connect('myconn', 'host=localhost');"
  ];

  for (const sql of dangerous) {
    const res = validateMigrationSql(sql);
    assert.equal(res.valid, false);
    assert.ok(res.reason?.includes("não permitida") || res.reason?.includes("puramente de leitura"));
  }
});

test("Migration SQL Guard: Rejeita consultas puras de leitura em fluxo de migração", () => {
  const readQueries = [
    "SELECT * FROM users;",
    "SELECT count(*) FROM orders WHERE status = 'pending';"
  ];

  for (const sql of readQueries) {
    const res = validateMigrationSql(sql);
    assert.equal(res.valid, false);
    assert.ok(res.reason?.includes("puramente de leitura"));
  }
});

test("Migration SQL Guard: Extração exata de tabelas afetadas", () => {
  const complexSql = `
    CREATE TABLE customers (id INT);
    ALTER TABLE public.orders ADD COLUMN note TEXT;
    DROP TABLE IF EXISTS "archived_logs";
    INSERT INTO audit_log (action) VALUES ('init');
    UPDATE user_settings SET theme = 'dark';
    DELETE FROM sessions WHERE expired = true;
  `;

  const tables = extractAffectedTablesFromSql(complexSql);
  assert.deepEqual(tables.sort(), [
    "archived_logs",
    "audit_log",
    "customers",
    "public.orders",
    "sessions",
    "user_settings"
  ].sort());
});

test("P0 Compatibility: isReadOnlySql permanece 100% intacto", () => {
  assert.equal(isReadOnlySql("SELECT id FROM users"), true);
  assert.equal(isReadOnlySql("INSERT INTO users VALUES (1)"), false);
  assert.equal(isReadOnlySql("DROP TABLE users"), false);
});

// ============================================================
// 2. TESTES DA MÁQUINA DE ESTADOS DO MIGRATION MANAGER
// ============================================================

test("MigrationManager: Fluxo de aprovação e execução bem-sucedida", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-mig-test-"));
  const manager = new MigrationManager();

  let askedEmitted = false;
  let executingEmitted = false;
  let completedEmitted = false;

  manager.on("migration-asked", (p) => {
    askedEmitted = true;
    assert.equal(p.status, "PENDING");
    assert.equal(p.name, "create_profiles");
  });

  manager.on("migration-executing", (p) => {
    executingEmitted = true;
    assert.equal(p.status, "EXECUTING");
  });

  manager.on("migration-completed", ({ proposal, result }) => {
    completedEmitted = true;
    assert.equal(proposal.status, "SUCCESS");
    assert.equal(result.success, true);
  });

  const mockFetch: typeof fetch = async (url, init) => {
    assert.ok(String(url).includes("/database/query"));
    return new Response(JSON.stringify([{ message: "ok" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const req: MigrationProposalRequest = {
    sessionId: "sess-123",
    projectRef: "xyzabcdefg",
    name: "create_profiles",
    sql: "CREATE TABLE profiles (id UUID PRIMARY KEY, bio TEXT);",
    summary: "Cria a tabela de perfis",
    accessToken: "fake-token",
    projectRoot: tempDir
  };

  const proposalPromise = manager.proposeMigration(req, mockFetch);

  // Proposta deve estar em memória como PENDING
  const active = manager.getPendingProposals();
  assert.equal(active.length, 1);
  assert.equal(active[0].status, "PENDING");
  assert.equal(askedEmitted, true);

  // Usuário aprova
  const replyResult = await manager.replyProposal(active[0].id, true, mockFetch);
  assert.equal(replyResult.success, true);
  assert.equal(replyResult.status, "SUCCESS");
  assert.ok(replyResult.appliedFilename?.includes("create_profiles.sql"));

  const finalResult = await proposalPromise;
  assert.equal(finalResult.success, true);
  assert.equal(finalResult.status, "SUCCESS");
  assert.equal(executingEmitted, true);
  assert.equal(completedEmitted, true);

  // Verifica gravação no disco
  const writtenFilePath = path.join(tempDir, replyResult.appliedFilename!);
  const writtenContent = await fs.readFile(writtenFilePath, "utf8");
  assert.ok(writtenContent.includes("CREATE TABLE profiles"));

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("MigrationManager: Fluxo de rejeição explícita pelo usuário", async () => {
  const manager = new MigrationManager();
  let repliedEmitted = false;

  manager.on("migration-replied", ({ approved }) => {
    repliedEmitted = true;
    assert.equal(approved, false);
  });

  const req: MigrationProposalRequest = {
    sessionId: "sess-reject",
    projectRef: "proj-ref-1",
    name: "drop_table_test",
    sql: "DROP TABLE old_records;",
    summary: "Remove registros antigos",
    accessToken: "token"
  };

  const promise = manager.proposeMigration(req);
  const pending = manager.getPendingProposals();
  assert.equal(pending.length, 1);

  const reply = await manager.replyProposal(pending[0].id, false);
  assert.equal(reply.success, false);
  assert.equal(reply.status, "REJECTED");
  assert.equal(repliedEmitted, true);

  const outcome = await promise;
  assert.equal(outcome.success, false);
  assert.equal(outcome.status, "REJECTED");
});

test("MigrationManager: Anti-duplicação impede reaplicação do mesmo hash", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-dup-test-"));
  const manager = new MigrationManager();

  const mockFetch: typeof fetch = async () => new Response("[]", { status: 200 });

  const req: MigrationProposalRequest = {
    sessionId: "sess-dup",
    projectRef: "proj-dup",
    name: "add_column",
    sql: "ALTER TABLE users ADD COLUMN age INT;",
    accessToken: "tok",
    projectRoot: tempDir
  };

  // Primeira execução com sucesso
  const p1 = manager.proposeMigration(req, mockFetch);
  const id1 = manager.getPendingProposals()[0].id;
  await manager.replyProposal(id1, true, mockFetch);
  await p1;

  // Segunda tentativa com mesmo SQL e projectRef -> deve ser rejeitada imediatamente
  await assert.rejects(
    async () => {
      await manager.proposeMigration(req, mockFetch);
    },
    /já foi aprovada e executada anteriormente/
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("MigrationManager: Cancelamento explícito da proposta", async () => {
  const manager = new MigrationManager();

  const req: MigrationProposalRequest = {
    sessionId: "sess-cancel",
    projectRef: "proj-c",
    name: "alter_table",
    sql: "ALTER TABLE items ADD COLUMN active BOOLEAN;",
    accessToken: "tok"
  };

  const promise = manager.proposeMigration(req);
  const id = manager.getPendingProposals()[0].id;

  const cancelled = manager.cancelProposal(id);
  assert.equal(cancelled, true);

  const result = await promise;
  assert.equal(result.success, false);
  assert.equal(result.status, "CANCELLED");

  // Tentativa de responder proposta cancelada deve falhar
  await assert.rejects(
    async () => {
      await manager.replyProposal(id, true);
    },
    /A proposta não está em estado PENDING/
  );
});

test("MigrationManager: Revalidação de hash e integridade impede execução se SQL for alterado", async () => {
  const manager = new MigrationManager();

  const req: MigrationProposalRequest = {
    sessionId: "sess-tamper",
    projectRef: "proj-tamper",
    name: "tamper_test",
    sql: "CREATE TABLE secure_log (id INT);",
    accessToken: "tok"
  };

  const promise = manager.proposeMigration(req);
  const proposal = manager.getPendingProposals()[0];

  // Simula adulteração in-memory do SQL sem recomputar hash
  proposal.originalSql = "DROP TABLE users CASCADE;";

  const result = await manager.replyProposal(proposal.id, true);
  assert.equal(result.success, false);
  assert.equal(result.status, "FAILED");
  assert.ok(result.error?.includes("Inconsistência de integridade"));

  const outcome = await promise;
  assert.equal(outcome.status, "FAILED");
});

test("MigrationManager: Formatação e sanitização de nome e timestamp", () => {
  const manager = new MigrationManager();

  assert.equal(manager.sanitizeMigrationName("Criar Tabela Usuários!"), "criar_tabela_usu_rios");
  assert.equal(manager.sanitizeMigrationName("2026---mig_nova__"), "2026_mig_nova");

  const ts = manager.formatTimestamp(new Date(2026, 8, 16, 14, 30, 45));
  assert.equal(ts, "20260916143045");
});

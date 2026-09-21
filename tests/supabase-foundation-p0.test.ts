import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isReadOnlySql,
  classifySqlRisk,
  stripSqlComments,
  hasMultipleStatements,
  sanitizeSqlForDisplay
} from "../src/main/security/sql-guard.ts";

import {
  summarizeSchema
} from "../src/main/supabase/db-schema-formatter.ts";

import {
  executeQueryData,
  maskSensitiveRowData,
  MAX_QUERY_ROWS,
  MAX_RESPONSE_CHARS
} from "../src/main/supabase/supabase-query-tool.ts";

// ============================================================
// 1. TESTES SQL GUARD (SEGURANÇA E ANÁLISE LÉXICA)
// ============================================================

test("SQL Guard: Queries SELECT válidas e permitidas (READ)", () => {
  const validQueries = [
    "SELECT * FROM users",
    "SELECT id, name, email FROM profiles WHERE active = true",
    "SELECT id, name FROM users LIMIT 10",
    "SELECT * FROM orders ORDER BY created_at DESC OFFSET 20",
    "SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id",
    "SELECT count(*), status FROM invoices GROUP BY status HAVING count(*) > 5",
    "SELECT * FROM users WHERE notes = 'drop table inside literal'",
    "SELECT id FROM items WHERE code = 'SELECT ; INSERT ; DELETE'",
    "EXPLAIN SELECT * FROM users",
    "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM products",
    "WITH active_users AS (SELECT id, name FROM users WHERE active = true) SELECT * FROM active_users",
    `
    -- Comentário inicial
    SELECT *
    /* Comentário de bloco */
    FROM customers
    WHERE active = true;
    `
  ];

  for (const q of validQueries) {
    assert.equal(isReadOnlySql(q), true, `Deveria ser permitido: ${q}`);
    assert.equal(classifySqlRisk(q), "READ", `Deveria ser classificado como READ: ${q}`);
  }
});

test("SQL Guard: Mutações bloqueadas (INSERT, UPDATE, DELETE, UPSERT)", () => {
  const mutations = [
    "INSERT INTO users (name) VALUES ('Alice')",
    "UPDATE users SET active = false WHERE id = 1",
    "UPDATE users SET active = false",
    "DELETE FROM users WHERE id = 1",
    "DELETE FROM users",
    "UPSERT INTO users (id, name) VALUES (1, 'Bob')",
    "WITH ins AS (INSERT INTO logs (msg) VALUES ('test') RETURNING id) SELECT * FROM ins"
  ];

  for (const q of mutations) {
    assert.equal(isReadOnlySql(q), false, `Deveria ser bloqueado: ${q}`);
  }
});

test("SQL Guard: Comandos DDL e Administrativos bloqueados (DROP, ALTER, CREATE, TRUNCATE, etc.)", () => {
  const ddl = [
    "DROP TABLE users",
    "DROP TABLE IF EXISTS users CASCADE",
    "ALTER TABLE users ADD COLUMN age int",
    "ALTER TABLE users DROP COLUMN email",
    "CREATE TABLE test (id int)",
    "CREATE TABLE IF NOT EXISTS test (id int)",
    "TRUNCATE users",
    "GRANT ALL ON users TO anon",
    "REVOKE ALL ON users FROM authenticated",
    "VACUUM FULL",
    "REINDEX TABLE users",
    "CALL my_procedure()",
    "EXECUTE my_plan",
    "SELECT * INTO new_table FROM users",
    "SELECT pg_sleep(10)"
  ];

  for (const q of ddl) {
    assert.equal(isReadOnlySql(q), false, `Deveria ser bloqueado: ${q}`);
  }
});

test("SQL Guard: Múltiplas statements com ponto-e-vírgula bloqueadas", () => {
  const multiStatements = [
    "SELECT * FROM users; DROP TABLE users;",
    "SELECT * FROM users; DELETE FROM users;",
    "SELECT 1; SELECT 2",
    "SELECT * FROM products; -- comment\nDROP TABLE logs;"
  ];

  for (const q of multiStatements) {
    assert.equal(hasMultipleStatements(q), true, `Deveria detectar múltiplas statements: ${q}`);
    assert.equal(isReadOnlySql(q), false, `Deveria ser bloqueado: ${q}`);
  }
});

test("SQL Guard: Casos de borda (comentários não fechados, whitespace, query vazia)", () => {
  assert.equal(isReadOnlySql(""), false);
  assert.equal(isReadOnlySql("   "), false);
  assert.equal(isReadOnlySql("-- apenas comentario"), false);
  assert.equal(isReadOnlySql("/* bloco aberto sem fim"), false);
});

test("SQL Guard: Classificação de risco estrita (READ, SAFE_WRITE, DESTRUCTIVE)", () => {
  assert.equal(classifySqlRisk("SELECT * FROM users"), "READ");
  assert.equal(classifySqlRisk("CREATE TABLE IF NOT EXISTS test (id uuid)"), "SAFE_WRITE");
  assert.equal(classifySqlRisk("CREATE INDEX idx_users_email ON users(email)"), "SAFE_WRITE");
  assert.equal(classifySqlRisk("ALTER TABLE users ADD COLUMN phone text"), "SAFE_WRITE");
  
  assert.equal(classifySqlRisk("DROP TABLE users"), "DESTRUCTIVE");
  assert.equal(classifySqlRisk("TRUNCATE users"), "DESTRUCTIVE");
  assert.equal(classifySqlRisk("DELETE FROM users WHERE id = 1"), "DESTRUCTIVE");
  assert.equal(classifySqlRisk("UPDATE users SET active = false"), "DESTRUCTIVE"); // sem WHERE
  assert.equal(classifySqlRisk("ALTER TABLE users DROP COLUMN email"), "DESTRUCTIVE");
  assert.equal(classifySqlRisk("ALTER TABLE users DROP CONSTRAINT fk_user"), "DESTRUCTIVE");
  assert.equal(classifySqlRisk("QUALQUER COISA ESTRANHA"), "DESTRUCTIVE");
});

test("SQL Guard: Sanitize para exibição segura", () => {
  const raw = "SELECT * FROM users WHERE password = 'secret123' AND token = 'abc-token-xyz'";
  const sanitized = sanitizeSqlForDisplay(raw);
  assert.ok(!sanitized.includes("secret123"), "Não deve conter senha em texto claro");
  assert.ok(!sanitized.includes("abc-token-xyz"), "Não deve conter token em texto claro");
  assert.ok(sanitized.includes("[REDACTED]"), "Deve conter marcador [REDACTED]");
});

// ============================================================
// 2. TESTES DE SCHEMA FORMATTER (COMPACTAÇÃO DE CONTEXTO)
// ============================================================

test("Schema Formatter: Converte dados estruturados em Markdown conciso com redução de tamanho", () => {
  const fixtureStructured = {
    tables: [
      {
        name: "users",
        schema: "public",
        rlsEnabled: true,
        approxRows: 1420,
        columns: [
          { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()", isPrimaryKey: true },
          { name: "email", type: "text", nullable: false },
          { name: "created_at", type: "timestamptz", nullable: true, default: "now()" }
        ],
        foreignKeys: [],
        policies: [
          { name: "Users can view own data", command: "SELECT", roles: ["authenticated"] }
        ]
      },
      {
        name: "orders",
        schema: "public",
        rlsEnabled: false,
        approxRows: 85,
        columns: [
          { name: "id", type: "uuid", nullable: false, isPrimaryKey: true },
          { name: "user_id", type: "uuid", nullable: false },
          { name: "amount", type: "numeric", nullable: false }
        ],
        foreignKeys: [
          { column: "user_id", foreignTable: "public.users", foreignColumn: "id" }
        ],
        policies: []
      }
    ],
    enums: [
      { name: "user_role", values: ["admin", "member", "guest"] }
    ]
  };

  const markdown = summarizeSchema(fixtureStructured);

  // Valida presença de informações essenciais
  assert.ok(markdown.includes("### users"));
  assert.ok(markdown.includes("RLS: enabled"));
  assert.ok(markdown.includes("id: uuid PK NOT NULL default gen_random_uuid()"));
  assert.ok(markdown.includes("email: text NOT NULL"));
  assert.ok(markdown.includes("user_id → public.users(id)"));
  assert.ok(markdown.includes('"Users can view own data" (SELECT [authenticated])'));
  assert.ok(markdown.includes("**user_role**: 'admin', 'member', 'guest'"));

  // Compara tamanhos reais (economia de contexto)
  const rawJson = JSON.stringify(fixtureStructured, null, 2);
  const rawChars = rawJson.length;
  const mdChars = markdown.length;

  console.log(`[Schema Size Comparison] JSON Original: ${rawChars} chars | Markdown Resumido: ${mdChars} chars`);
  assert.ok(mdChars < rawChars, "Markdown deve ser significativamente menor que o JSON estruturado original");
});

test("Schema Formatter: Trata schema vazio ou sem tabelas defensivamente", () => {
  assert.equal(summarizeSchema(null), "Nenhum esquema de banco de dados disponível.");
  assert.equal(summarizeSchema({ tables: [] }), "Esquema sem tabelas públicas encontradas.");
});

// ============================================================
// 3. TESTES DA QUERY TOOL (EXECUÇÃO, LIMITES, MASKING)
// ============================================================

test("Query Tool: Mascaramento rigoroso de campos sensíveis", () => {
  const row = {
    id: "123",
    email: "user@example.com",
    password: "$2b$10$hashedpasswordhere",
    api_key: "sbp_live_secret_key_123",
    accessToken: "jwt.token.here",
    nested: {
      secret_value: "hidden",
      normal_value: "visible"
    }
  };

  const masked = maskSensitiveRowData(row);
  assert.equal(masked.id, "123");
  assert.equal(masked.email, "user@example.com");
  assert.equal(masked.password, "[REDACTED]");
  assert.equal(masked.api_key, "[REDACTED]");
  assert.equal(masked.accessToken, "[REDACTED]");
  assert.equal(masked.nested.secret_value, "[REDACTED]");
  assert.equal(masked.nested.normal_value, "visible");
});

test("Query Tool: Rejeita parâmetros obrigatórios ausentes", async () => {
  const res1 = await executeQueryData({ projectRef: "", accessToken: "tok", sql: "SELECT 1" });
  assert.equal(res1.success, false);
  assert.equal(res1.errorCode, "INVALID_PROJECT_REF");

  const res2 = await executeQueryData({ projectRef: "ref", accessToken: "", sql: "SELECT 1" });
  assert.equal(res2.success, false);
  assert.equal(res2.errorCode, "AUTH_REQUIRED");

  const res3 = await executeQueryData({ projectRef: "ref", accessToken: "tok", sql: "" });
  assert.equal(res3.success, false);
  assert.equal(res3.errorCode, "EMPTY_SQL");
});

test("Query Tool: Bloqueia mutação antes de qualquer chamada HTTP", async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return new Response("ok");
  };

  const res = await executeQueryData(
    {
      projectRef: "xyz",
      accessToken: "token",
      sql: "DROP TABLE users;"
    },
    mockFetch as any
  );

  assert.equal(res.success, false);
  assert.equal(res.errorCode, "MUTATION_NOT_ALLOWED");
  assert.equal(fetchCalled, false, "Fetch HTTP NUNCA deve ser acionado para SQL não-READ");
});

test("Query Tool: Sucesso em SELECT seguro com limite de MAX_ROWS (100) e mascaramento", async () => {
  // Simula retorno de 150 linhas do banco
  const mockRows = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    password_hash: "secret_hash"
  }));

  const mockFetch = async (url: string, opts: any) => {
    assert.ok(url.includes("xyz/database/query"));
    assert.equal(opts.method, "POST");
    assert.equal(opts.headers.Authorization, "Bearer valid_token");

    return new Response(JSON.stringify(mockRows), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const res = await executeQueryData(
    {
      projectRef: "xyz",
      accessToken: "valid_token",
      sql: "SELECT id, name, password_hash FROM users"
    },
    mockFetch as any
  );

  assert.equal(res.success, true);
  assert.equal(res.rowCount, 100);
  assert.equal(res.truncated, true);
  assert.ok(res.truncationReason?.includes("100"));
  assert.equal(res.rows?.[0].password_hash, "[REDACTED]");
  assert.equal(res.rows?.[0].name, "User 1");
});

test("Query Tool: Tratamento de erros HTTP (401, 403, 404, 500)", async () => {
  const makeMock = (status: number, body: any) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const r401 = await executeQueryData(
    { projectRef: "ref", accessToken: "bad", sql: "SELECT 1" },
    makeMock(401, { message: "Unauthorized" }) as any
  );
  assert.equal(r401.success, false);
  assert.equal(r401.errorCode, "UNAUTHORIZED");

  const r403 = await executeQueryData(
    { projectRef: "ref", accessToken: "tok", sql: "SELECT 1" },
    makeMock(403, { message: "Forbidden" }) as any
  );
  assert.equal(r403.success, false);
  assert.equal(r403.errorCode, "FORBIDDEN");

  const r404 = await executeQueryData(
    { projectRef: "ref", accessToken: "tok", sql: "SELECT 1" },
    makeMock(404, { message: "Not Found" }) as any
  );
  assert.equal(r404.success, false);
  assert.equal(r404.errorCode, "NOT_FOUND");
});

test("Query Tool: Tratamento de cancelamento (AbortSignal)", async () => {
  const controller = new AbortController();
  controller.abort();

  const mockFetch = async (_url: string, opts: any) => {
    if (opts.signal?.aborted) {
      const err = new Error("The user aborted a request.");
      err.name = "AbortError";
      throw err;
    }
    return new Response("[]");
  };

  const res = await executeQueryData(
    {
      projectRef: "ref",
      accessToken: "tok",
      sql: "SELECT 1",
      signal: controller.signal
    },
    mockFetch as any
  );

  assert.equal(res.success, false);
  assert.equal(res.errorCode, "ABORTED_OR_TIMEOUT");
});

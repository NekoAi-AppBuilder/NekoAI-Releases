import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LovableCloudManager } from "../dist/main/lovable/lovable-cloud-manager.js";
import { LovableMcpServer } from "../dist/main/lovable/lovable-mcp-server.js";
import { isReadOnlySql } from "../dist/main/security/sql-guard.js";
import { sanitizeErrorMessage } from "../dist/shared/error-extractor.js";

async function createTempDir(prefix) {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// ============================================================================
// SUÍTE DE TESTES: LOVABLE CLOUD MCP READ-ONLY (ETAPA 3A)
// ============================================================================

test("1. Lovable MCP Server inicia SOMENTE em loopback 127.0.0.1", async () => {
  const mcp = new LovableMcpServer();
  const port = await mcp.start(0);

  try {
    assert.ok(port > 0, "A porta do servidor MCP deve ser maior que 0");
    const url = mcp.getUrl();
    assert.ok(url.startsWith("http://127.0.0.1:"), `URL deve obrigatoriamente apontar para 127.0.0.1: ${url}`);
  } finally {
    await mcp.stop();
  }
});

test("2 & 3 & 4. Tools/list retorna 'ver_estrutura_do_banco', 'consultar_dados' e 'alterar_banco'", async () => {
  const mcp = new LovableMcpServer();
  await mcp.start(0);

  try {
    const listReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const res = await mcp.handleJsonRpcMessage(listReq);
    assert.ok(res.result?.tools, "Resposta deve conter lista de ferramentas");

    const tools = res.result.tools;
    const toolNames = tools.map((t) => t.name);

    assert.equal(toolNames.includes("consultar_dados"), true, "'consultar_dados' deve estar registrada");
    assert.equal(toolNames.includes("ver_estrutura_do_banco"), true, "'ver_estrutura_do_banco' deve estar registrada");
    assert.equal(toolNames.includes("alterar_banco"), true, "'alterar_banco' deve existir (Etapa 3B)");
  } finally {
    await mcp.stop();
  }
});

test("5. SQL Guard: SELECT simples é aceito como READ_ONLY", () => {
  const queries = [
    "SELECT * FROM users",
    "SELECT id, email FROM profiles WHERE active = true",
    "SELECT count(*) FROM orders",
  ];
  for (const q of queries) {
    assert.equal(isReadOnlySql(q), true, `SELECT deve ser aceito: ${q}`);
  }
});

test("6. SQL Guard: WITH em bloco de leitura é aceito como READ_ONLY", () => {
  const withQuery = "WITH active_users AS (SELECT id, name FROM users WHERE active = true) SELECT * FROM active_users";
  assert.equal(isReadOnlySql(withQuery), true);
});

test("7..12. SQL Guard: Rejeição de mutações (INSERT, UPDATE, DELETE, ALTER, DROP, TRUNCATE)", () => {
  const mutationQueries = [
    { type: "INSERT", sql: "INSERT INTO users (name) VALUES ('Teste')" },
    { type: "UPDATE", sql: "UPDATE users SET name = 'Novo' WHERE id = 1" },
    { type: "DELETE", sql: "DELETE FROM users WHERE id = 1" },
    { type: "ALTER", sql: "ALTER TABLE users ADD COLUMN phone text" },
    { type: "DROP", sql: "DROP TABLE users" },
    { type: "TRUNCATE", sql: "TRUNCATE TABLE users" },
  ];

  for (const item of mutationQueries) {
    assert.equal(isReadOnlySql(item.sql), false, `Operação ${item.type} deve ser REJEITADA`);
  }
});

test("13. SQL Guard: Múltiplas instruções encadeadas são rejeitadas", () => {
  const multiSql = "SELECT * FROM users; DROP TABLE users;";
  assert.equal(isReadOnlySql(multiSql), false, "Múltiplas instruções devem ser rejeitadas pelo SQL Guard");
});

test("14 & 15. MCP obtém projectId EXCLUSIVAMENTE do workspace e ignora projectId arbitrário vindo do Agent", async () => {
  const manager = new LovableCloudManager();
  const mcp = new LovableMcpServer(manager);
  await mcp.start(0);

  try {
    // Tentar executar sem workspace conectado
    const callReq = {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "consultar_dados",
        arguments: {
          query: "SELECT 1;",
          projectId: "arbitrary-uuid-9999-9999", // Agent tenta injetar projectId arbitrário
        },
      },
    };

    const res = await mcp.handleJsonRpcMessage(callReq);
    assert.equal(res.result.isError, true);
    assert.ok(
      res.result.content[0].text.includes("Este projeto não possui um Lovable Cloud conectado."),
      "Não deve aceitar projectId arbitrário"
    );
  } finally {
    await mcp.stop();
  }
});

test("16. Workspace sem Lovable conectado falha com mensagem clara", async () => {
  const manager = new LovableCloudManager();
  const mcp = new LovableMcpServer(manager);
  await mcp.start(0);

  try {
    const callReq = {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "ver_estrutura_do_banco",
        arguments: {},
      },
    };

    const res = await mcp.handleJsonRpcMessage(callReq);
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, "Este projeto não possui um Lovable Cloud conectado.");
  } finally {
    await mcp.stop();
  }
});

test("17 & 18. Token/JWT nunca aparece na resposta ou nos logs do MCP", () => {
  const mockJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjo0Mn0.signature123456";
  const rawLog = `[Neko/LovableMCP] Executando query no Lovable Cloud com Bearer ${mockJwt}`;

  const sanitizedLog = sanitizeErrorMessage(rawLog);
  assert.equal(sanitizedLog.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false, "Token não pode constar no log");
  assert.ok(sanitizedLog.includes("Bearer [REDACTED]"));
});

test("19. Erros do Lovable Cloud são sanitizados pelo error extractor", () => {
  const rawError = "API do Lovable Cloud respondeu com status 403: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
  const sanitized = sanitizeErrorMessage(rawError);

  assert.equal(sanitized.includes("eyJhbGci"), false);
  assert.ok(sanitized.includes("Bearer [REDACTED]"));
});

test("20. Controle de geração (projectGeneration) impede que workspace antigo opere em novo contexto", async () => {
  const manager = new LovableCloudManager();
  const tempDirA = await createTempDir("ws-gen-a");
  const tempDirB = await createTempDir("ws-gen-b");

  try {
    await manager.setProject(tempDirA);
    const genA = manager.getProjectGeneration();

    // Trocar de projeto para B
    await manager.setProject(tempDirB);

    // Tentar executar query com a geração antiga A
    await assert.rejects(
      async () => {
        await manager.executeQuery("SELECT 1;", {
          projectPath: tempDirA,
          generation: genA,
        });
      },
      (err) => {
        return err.message.includes("Troca de workspace detectada") || err.message.includes("Acesso negado");
      },
      "Deve rejeitar requisição de geração/workspace antigo"
    );
  } finally {
    await fs.rm(tempDirA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempDirB, { recursive: true, force: true }).catch(() => {});
  }
});

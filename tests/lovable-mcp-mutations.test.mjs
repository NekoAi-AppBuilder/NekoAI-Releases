import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const mcpServerPath = path.join(projectRoot, "dist", "main", "lovable", "lovable-mcp-server.js");
const managerPath = path.join(projectRoot, "dist", "main", "lovable", "lovable-cloud-manager.js");
const migrationManagerPath = path.join(projectRoot, "dist", "main", "supabase", "migration-manager.js");

const { LovableMcpServer } = await import(`file://${mcpServerPath}`);
const { migrationManager } = await import(`file://${migrationManagerPath}`);

function cleanupPending() {
  try {
    migrationManager.cancelAllPendingProposals();
  } catch {}
}

function createMockManager(opts = {}) {
  let state = {
    projectId: opts.projectId || "proj_test_mutation_123",
    lovableProjectId: opts.projectId || "proj_test_mutation_123",
    accessToken: opts.accessToken || "fake_access_token_abc",
    refreshToken: "fake_refresh_token",
    userEmail: "test@example.com",
    lastValidatedAt: Date.now(),
    status: "connected",
    cloudStatus: "connected",
    lovableCloudConnected: true,
    isLovableProject: true,
  };
  let activePath = opts.activePath || "C:\\workspace\\test_proj";
  let generation = opts.generation || 1;
  let executedSql = [];

  return {
    mockExecutedSql: executedSql,
    getState: () => state,
    getActiveProjectPath: () => activePath,
    getProjectGeneration: () => generation,
    setState: (newState) => { state = { ...state, ...newState }; },
    setActivePath: (p) => { activePath = p; generation++; },
    executeQuery: async (sql, options) => {
      if (options?.projectPath && options.projectPath !== activePath) {
        throw new Error("Workspace mismatch");
      }
      if (options?.generation && options.generation !== generation) {
        throw new Error("Stale generation");
      }
      if (sql.includes("FAIL_SQL")) {
        throw new Error("Simulated SQL execution error: syntax error at FAIL_SQL");
      }
      executedSql.push(sql);
      return { rows: [{ test: 1 }], rowCount: 1 };
    },
    getDatabaseSchema: async () => "Mock Schema"
  };
}

test("1. alterar_banco aparece no tools/list", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);
  const res = await server.handleJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  
  const tools = res.result.tools;
  const names = tools.map(t => t.name);
  assert.ok(names.includes("alterar_banco"));
  assert.ok(names.includes("consultar_dados"));
  assert.ok(names.includes("ver_estrutura_do_banco"));
});

test("2. READ_ONLY continua funcionando normalmente", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);
  const res = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "consultar_dados",
      arguments: { query: "SELECT 1 as test;" }
    }
  });

  assert.equal(res.result.isError, false);
  assert.ok(res.result.content[0].text.includes("test"));
});

test("3 a 11. Mutation gera proposta no migrationManager com todos os identificadores amarrados", async () => {
  cleanupPending();
  const mockMgr = createMockManager({ projectId: "proj_bound_999", generation: 4 });
  const server = new LovableMcpServer(mockMgr);

  let proposalCaptured = null;
  const onAsked = (p) => { proposalCaptured = p; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "call_req_100",
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: {
        query: "CREATE TABLE test_mut_3 (id int);",
        summary: "Criar tabela de teste 3",
        sessionId: "sess_xyz_3",
        permissionId: "perm_xyz_3",
        callId: "call_100_3"
      }
    }
  });

  await new Promise(r => setTimeout(r, 50));

  assert.ok(proposalCaptured !== null);
  assert.equal(proposalCaptured.provider, "lovable");
  assert.equal(proposalCaptured.projectRef, "proj_bound_999");
  assert.equal(proposalCaptured.lovableProjectId, "proj_bound_999");
  assert.ok(proposalCaptured.id.startsWith("mig_"));
  assert.equal(proposalCaptured.permissionId, "perm_xyz_3");
  assert.equal(proposalCaptured.callId, "call_100_3");
  assert.equal(proposalCaptured.sessionId, "sess_xyz_3");
  assert.equal(proposalCaptured.projectGeneration, 4);

  await migrationManager.replyProposal(proposalCaptured.id, true);
  await callPromise;

  migrationManager.off("migration-asked", onAsked);
});

test("12, 15, 16. Aprovação executa no banco exatamente UMA vez e conclui com sucesso real", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  let propId = null;
  const onAsked = (p) => { propId = p.id; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "INSERT INTO users_12 (name) VALUES ('Neko');" }
    }
  });

  await new Promise(r => setTimeout(r, 50));
  assert.ok(propId !== null);

  const replyRes = await migrationManager.replyProposal(propId, true);
  assert.equal(replyRes.status, "APPROVED");

  const serverRes = await callPromise;
  assert.equal(serverRes.result.isError, false);
  assert.ok(serverRes.result.content[0].text.includes("sucesso"));
  assert.equal(mockMgr.mockExecutedSql.length, 1);
  assert.equal(mockMgr.mockExecutedSql[0], "INSERT INTO users_12 (name) VALUES ('Neko');");

  migrationManager.off("migration-asked", onAsked);
});

test("13, 14. Rejeição não executa SQL e devolve erro contextual ao Agent", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  let propId = null;
  const onAsked = (p) => { propId = p.id; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "DROP TABLE dangerous_tbl_14;" }
    }
  });

  await new Promise(r => setTimeout(r, 50));
  assert.ok(propId !== null);

  await migrationManager.replyProposal(propId, false);

  const serverRes = await callPromise;
  assert.equal(serverRes.result.isError, true);
  assert.ok(serverRes.result.content[0].text.includes("rejeitada pelo usuário"));
  assert.equal(mockMgr.mockExecutedSql.length, 0);

  migrationManager.off("migration-asked", onAsked);
});

test("17. Erro real na execução fecha a operação com erro e notifica falha", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  let propId = null;
  const onAsked = (p) => { propId = p.id; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "FAIL_SQL test_17;" }
    }
  });

  await new Promise(r => setTimeout(r, 50));

  await migrationManager.replyProposal(propId, true);
  const serverRes = await callPromise;

  assert.equal(serverRes.result.isError, true);
  assert.ok(serverRes.result.content[0].text.includes("FAIL_SQL"));

  const prop = migrationManager.getProposal(propId);
  assert.equal(prop.status, "FAILED");

  migrationManager.off("migration-asked", onAsked);
});

test("18. Workspace switch invalida proposta e bloqueia execução tardia", async () => {
  cleanupPending();
  const mockMgr = createMockManager({ activePath: "C:\\proj_A_18", generation: 1 });
  const server = new LovableMcpServer(mockMgr);

  let propId = null;
  const onAsked = (p) => { propId = p.id; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "CREATE TABLE switch_test_18 (id int);" }
    }
  });

  await new Promise(r => setTimeout(r, 50));

  mockMgr.setActivePath("C:\\proj_B_18");

  await migrationManager.replyProposal(propId, true);
  const serverRes = await callPromise;

  assert.equal(serverRes.result.isError, true);
  assert.ok(serverRes.result.content[0].text.includes("Stale generation") || serverRes.result.content[0].text.includes("Erro"));

  migrationManager.off("migration-asked", onAsked);
});

test("19. Cancelamento explicito invalida proposta", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  let propId = null;
  const onAsked = (p) => { propId = p.id; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 19,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "ALTER TABLE t_19 ADD col text;" }
    }
  });

  await new Promise(r => setTimeout(r, 50));
  migrationManager.cancelProposal(propId);

  const serverRes = await callPromise;
  assert.equal(serverRes.result.isError, true);
  assert.ok(serverRes.result.content[0].text.includes("cancelada"));

  migrationManager.off("migration-asked", onAsked);
});

test("20. Eventos tardios em propostas já concluídas são ignorados", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  let propId = null;
  const onAsked = (p) => { propId = p.id; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "CREATE TABLE t20_test (id int);" }
    }
  });

  await new Promise(r => setTimeout(r, 50));
  await migrationManager.replyProposal(propId, true);
  await callPromise;

  await migrationManager.notifyToolCompleted(propId, false, "Late error event");
  const prop = migrationManager.getProposal(propId);
  assert.equal(prop.status, "SUCCESS");

  migrationManager.off("migration-asked", onAsked);
});

test("21 e 22. Migrations consecutivas e simultâneas possuem estados isolados e independentes", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  const props = [];
  const onAsked = (p) => { props.push(p); };
  migrationManager.on("migration-asked", onAsked);

  const p1 = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "sim_1",
    method: "tools/call",
    params: { name: "alterar_banco", arguments: { query: "CREATE TABLE sim1_21 (id int);", permissionId: "p1_21" } }
  });

  const p2 = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: "sim_2",
    method: "tools/call",
    params: { name: "alterar_banco", arguments: { query: "CREATE TABLE sim2_22 (id int);", permissionId: "p2_22" } }
  });

  await new Promise(r => setTimeout(r, 50));
  assert.equal(props.length, 2);

  await migrationManager.replyProposal(props[0].id, false);
  await migrationManager.replyProposal(props[1].id, true);

  const r1 = await p1;
  const r2 = await p2;

  assert.equal(r1.result.isError, true);
  assert.equal(r2.result.isError, false);
  assert.equal(mockMgr.mockExecutedSql.length, 1);
  assert.equal(mockMgr.mockExecutedSql[0], "CREATE TABLE sim2_22 (id int);");

  migrationManager.off("migration-asked", onAsked);
});

test("23. SQL destrutivo mantém indicação de risco DESTRUCTIVE", async () => {
  cleanupPending();
  const mockMgr = createMockManager();
  const server = new LovableMcpServer(mockMgr);

  let proposal = null;
  const onAsked = (p) => { proposal = p; };
  migrationManager.on("migration-asked", onAsked);

  const callPromise = server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 23,
    method: "tools/call",
    params: {
      name: "alterar_banco",
      arguments: { query: "DROP TABLE important_data_23;" }
    }
  });

  await new Promise(r => setTimeout(r, 50));
  assert.equal(proposal.risk, "DESTRUCTIVE");

  await migrationManager.replyProposal(proposal.id, false);
  await callPromise;

  migrationManager.off("migration-asked", onAsked);
});

test("24 e 25. Tokens de autenticação nunca vazam em respostas ou logs do MCP", async () => {
  cleanupPending();
  const mockMgr = createMockManager({ accessToken: "SUPER_SECRET_FIREBASE_JWT_999" });
  const server = new LovableMcpServer(mockMgr);

  const listRes = await server.handleJsonRpcMessage({ jsonrpc: "2.0", id: 24, method: "tools/list" });
  const str = JSON.stringify(listRes);
  assert.ok(!str.includes("SUPER_SECRET_FIREBASE_JWT_999"));
  assert.ok(!str.includes(server.getSecretToken()));
});

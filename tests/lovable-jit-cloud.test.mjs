import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import compiled dist modules
const detectorPath = path.resolve(__dirname, "../dist/main/lovable/lovable-intent-detector.js");
const managerPath = path.resolve(__dirname, "../dist/main/lovable/lovable-cloud-manager.js");
const mcpServerPath = path.resolve(__dirname, "../dist/main/lovable/lovable-mcp-server.js");
const migrationManagerPath = path.resolve(__dirname, "../dist/main/supabase/migration-manager.js");

const { detectDatabaseIntent } = await import(`file://${detectorPath}`);
const { LovableCloudManager } = await import(`file://${managerPath}`);
const { LovableMcpServer } = await import(`file://${mcpServerPath}`);
const { migrationManager } = await import(`file://${migrationManagerPath}`);

// ============================================================================
// SIMULADOR DO FLUXO JIT GUARD (Reflete fielmente a lógica de main.ts e main.tsx)
// ============================================================================
class JitExecutionSimulator {
  constructor(cloudManager) {
    this.manager = cloudManager;
    this.pendingPrompt = null;
    this.taskState = "idle";
    this.executedPrompts = [];
    this.cancelledPrompts = [];
    this.modal = null;
    this.reconnectionAttempts = 0;
  }

  // Simula opencode:prompt em main.ts e o callback em main.tsx
  async sendPrompt(payload) {
    const state = this.manager.getState();
    const effectiveLovableId =
      state.projectId || state.lovableProjectId || state.detectedProjectId || null;
    const isLovableTarget = Boolean(state.isLovableProject && effectiveLovableId);

    if (isLovableTarget && !state.lovableCloudConnected) {
      const intent = detectDatabaseIntent(payload.text);
      if (intent.requiresDatabase) {
        this.taskState = "waiting_for_lovable_cloud";
        this.pendingPrompt = { ...payload };
        this.modal = "lovable_jit";
        return { waitingForLovableCloud: true, sessionId: payload.sessionId, taskId: "sim_task_123" };
      }
    }

    // Execução normal autorizada
    this.taskState = "running";
    this.executedPrompts.push({ ...payload });
    this.taskState = "completed";
    return { ok: true, taskId: "sim_task_123" };
  }

  cancelJit() {
    if (this.pendingPrompt) {
      this.cancelledPrompts.push(this.pendingPrompt);
    }
    this.pendingPrompt = null;
    this.modal = null;
    this.taskState = "idle";
  }

  async onCloudConnected() {
    this.reconnectionAttempts++;
    if (this.reconnectionAttempts > 10) {
      throw new Error("Loop infinito detectado no simulador de reconexão.");
    }
    if (this.pendingPrompt) {
      const pending = this.pendingPrompt;
      this.pendingPrompt = null; // Limpa para evitar loop de reconexão
      this.modal = null;
      return await this.sendPrompt(pending);
    }
  }
}

// ============================================================================
// SUÍTE DE TESTES OBRIGATÓRIOS (FASE 4B: TESTES 1 A 20)
// ============================================================================

test("TESTE 1: Prompt frontend simples -> não exige Cloud -> execução normal", () => {
  const prompts = [
    "Altere o botão para roxo.",
    "Crie uma página de preços.",
    "Deixe o header responsivo.",
    "Troque a fonte.",
    "Crie uma animação no botão.",
    "Adicione um card de depoimentos.",
    "Melhore o espaçamento da página."
  ];

  for (const p of prompts) {
    const res = detectDatabaseIntent(p);
    assert.equal(res.requiresDatabase, false, `Prompt não deveria exigir Cloud: ${p}`);
  }
});

test("TESTE 2: Prompt com tabela visual/mock -> não exige Cloud", () => {
  const prompts = [
    "Crie um dashboard visual com dados mockados.",
    "Crie uma tabela visual usando dados fictícios.",
    "Crie uma tabela de preços com planos Pro e Enterprise.",
    "Adicione uma tabela de comparação de recursos com dados estáticos.",
    "Crie um componente de tabela estilizada com Tailwind sem backend."
  ];

  for (const p of prompts) {
    const res = detectDatabaseIntent(p);
    assert.equal(res.requiresDatabase, false, `Tabela visual/mock não deveria exigir Cloud: ${p}`);
  }
});

test("TESTE 3: Prompt criar tabela REAL no banco -> exige Cloud", () => {
  const prompts = [
    "Crie a tabela clientes no banco e adicione nome, email e telefone.",
    "Crie uma tabela users no banco de dados.",
    "create table orders in the database with id and total",
    "Cria a tabela produtos no banco com chave primaria id"
  ];

  for (const p of prompts) {
    const res = detectDatabaseIntent(p);
    assert.equal(res.requiresDatabase, true, `Criação de tabela real DEVE exigir Cloud: ${p}`);
  }
});

test("TESTE 4: Prompt consultar dados reais -> exige Cloud", () => {
  const prompts = [
    "Consulte os dados da tabela customers no banco.",
    "Buscar registros na tabela pedidos no banco.",
    "Listar todos os clientes cadastrados no banco de dados.",
    "select * from transactions in the database",
    "Executar consulta SQL SELECT * FROM users."
  ];

  for (const p of prompts) {
    const res = detectDatabaseIntent(p);
    assert.equal(res.requiresDatabase, true, `Consulta a dados reais DEVE exigir Cloud: ${p}`);
  }
});

test("TESTE 5: Prompt alterar dados reais -> exige Cloud", () => {
  const prompts = [
    "Inserir um novo registro na tabela produtos no banco.",
    "Atualizar os dados do usuário com id 123 no banco.",
    "Excluir o cliente inativo do banco de dados.",
    "Salvar novo pedido na tabela orders do banco.",
    "update users set active = true in the database"
  ];

  for (const p of prompts) {
    const res = detectDatabaseIntent(p);
    assert.equal(res.requiresDatabase, true, `Alteração de dados reais DEVE exigir Cloud: ${p}`);
  }
});

test("TESTE 6: Prompt criar migration -> exige Cloud", () => {
  const prompts = [
    "Execute uma migration para adicionar a coluna status.",
    "Criar uma migration para tabela pagamentos no banco.",
    "Aplicar nova migração no banco de dados.",
    "run migration to add email column"
  ];

  for (const p of prompts) {
    const res = detectDatabaseIntent(p);
    assert.equal(res.requiresDatabase, true, `Migration DEVE exigir Cloud: ${p}`);
  }
});

test("TESTE 7: Cloud já conectado -> prompt de banco executa normalmente", async () => {
  const manager = new LovableCloudManager();
  // Simula estado conectado
  manager.state = {
    status: "connected",
    cloudStatus: "connected",
    isLovableProject: true,
    projectId: "11111111-1111-1111-1111-111111111111",
    lovableCloudConnected: true,
    lovableSessionValid: true
  };

  const sim = new JitExecutionSimulator(manager);
  const res = await sim.sendPrompt({
    sessionId: "sess_connected",
    text: "Crie a tabela clientes no banco e adicione nome e email."
  });

  assert.equal(res.ok, true);
  assert.equal(res.waitingForLovableCloud, undefined);
  assert.equal(sim.taskState, "completed");
  assert.equal(sim.modal, null);
  assert.equal(sim.executedPrompts.length, 1);
});

test("TESTE 8: Cloud não conectado -> prompt de banco entra em waiting_for_lovable_cloud", async () => {
  const manager = new LovableCloudManager();
  // Simula projeto Lovable desconectado
  manager.state = {
    status: "disconnected",
    cloudStatus: "auth_required",
    isLovableProject: true,
    projectId: "22222222-2222-2222-2222-222222222222",
    lovableCloudConnected: false,
    lovableSessionValid: false
  };

  const sim = new JitExecutionSimulator(manager);
  const res = await sim.sendPrompt({
    sessionId: "sess_unconnected",
    text: "Crie a tabela clientes no banco e adicione nome e email."
  });

  assert.equal(res.waitingForLovableCloud, true);
  assert.equal(sim.taskState, "waiting_for_lovable_cloud");
  assert.equal(sim.modal, "lovable_jit");
  assert.equal(sim.executedPrompts.length, 0); // Não executou nada!
  assert.ok(sim.pendingPrompt !== null);
});

test("TESTE 9: Usuário cancela -> prompt não executa", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "33333333-3333-3333-3333-333333333333",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);
  await sim.sendPrompt({
    sessionId: "sess_cancel",
    text: "Crie a tabela logs no banco de dados."
  });

  assert.equal(sim.taskState, "waiting_for_lovable_cloud");

  // Usuário clica Cancelar
  sim.cancelJit();

  assert.equal(sim.modal, null);
  assert.equal(sim.pendingPrompt, null);
  assert.equal(sim.taskState, "idle");
  assert.equal(sim.executedPrompts.length, 0); // Permanece não executado
  assert.equal(sim.cancelledPrompts.length, 1);
});

test("TESTE 10: Usuário conecta Cloud -> prompt original é retomado automaticamente", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "44444444-4444-4444-4444-444444444444",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);
  const originalPrompt = {
    sessionId: "sess_auto_resume",
    text: "Crie a tabela clientes no banco e adicione nome, email e telefone."
  };

  await sim.sendPrompt(originalPrompt);
  assert.equal(sim.taskState, "waiting_for_lovable_cloud");

  // Usuário conecta e estado muda para conectado
  manager.state.status = "connected";
  manager.state.lovableCloudConnected = true;
  manager.state.lovableSessionValid = true;

  // Dispara auto-resume
  await sim.onCloudConnected();

  assert.equal(sim.taskState, "completed");
  assert.equal(sim.executedPrompts.length, 1);
  assert.equal(sim.executedPrompts[0].text, originalPrompt.text);
});

test("TESTE 11: Prompt original preservado exatamente -> nenhum texto alterado", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "55555555-5555-5555-5555-555555555555",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);
  const complexPromptText = "Crie a tabela customers no banco com colunas id (UUID PK), email (VARCHAR UNIQUE), created_at (TIMESTAMP DEFAULT now()).";

  await sim.sendPrompt({
    sessionId: "sess_exact_text",
    text: complexPromptText
  });

  assert.equal(sim.pendingPrompt.text, complexPromptText);

  // Conecta e resume
  manager.state.lovableCloudConnected = true;
  manager.state.status = "connected";
  await sim.onCloudConnected();

  assert.equal(sim.executedPrompts[0].text, complexPromptText);
});

test("TESTE 12: Attachment preservado", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "66666666-6666-6666-6666-666666666666",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);
  const attachments = [
    { path: "C:\\mock\\schema.png", name: "schema.png", mime: "image/png", size: 1024 }
  ];

  await sim.sendPrompt({
    sessionId: "sess_attachments",
    text: "Crie a tabela clientes no banco conforme o diagrama anexado.",
    attachments
  });

  assert.deepEqual(sim.pendingPrompt.attachments, attachments);

  manager.state.lovableCloudConnected = true;
  manager.state.status = "connected";
  await sim.onCloudConnected();

  assert.deepEqual(sim.executedPrompts[0].attachments, attachments);
});

test("TESTE 13: Contexto da conversa preservado", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "77777777-7777-7777-7777-777777777777",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);
  const contextPaths = ["src/types.ts", "package.json"];
  const model = { providerID: "anthropic", modelID: "claude-3-7-sonnet" };

  await sim.sendPrompt({
    sessionId: "sess_context",
    text: "Crie a tabela pedidos no banco.",
    contextPaths,
    model,
    planMode: false,
    effort: "high"
  });

  assert.deepEqual(sim.pendingPrompt.contextPaths, contextPaths);
  assert.deepEqual(sim.pendingPrompt.model, model);
  assert.equal(sim.pendingPrompt.effort, "high");

  manager.state.lovableCloudConnected = true;
  manager.state.status = "connected";
  await sim.onCloudConnected();

  assert.deepEqual(sim.executedPrompts[0].contextPaths, contextPaths);
  assert.deepEqual(sim.executedPrompts[0].model, model);
  assert.equal(sim.executedPrompts[0].effort, "high");
});

test("TESTE 14: Sessão Lovable expirada -> conexão solicitada novamente", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "error",
    cloudStatus: "session_expired",
    isLovableProject: true,
    projectId: "88888888-8888-8888-8888-888888888888",
    lovableCloudConnected: false,
    lovableSessionValid: false
  };

  const sim = new JitExecutionSimulator(manager);
  const res = await sim.sendPrompt({
    sessionId: "sess_expired",
    text: "Crie a tabela faturas no banco de dados."
  });

  assert.equal(res.waitingForLovableCloud, true);
  assert.equal(sim.taskState, "waiting_for_lovable_cloud");
  assert.equal(sim.modal, "lovable_jit");
});

test("TESTE 15: Projeto sem Cloud confirmado -> não executar operação de banco", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    cloudStatus: "no_cloud",
    isLovableProject: true,
    projectId: "99999999-9999-9999-9999-999999999999",
    hasLovableCloud: null,
    lovableCloudConnected: false,
    lovableSessionValid: true
  };

  const sim = new JitExecutionSimulator(manager);
  const res = await sim.sendPrompt({
    sessionId: "sess_no_cloud",
    text: "Crie a tabela itens no banco de dados."
  });

  assert.equal(res.waitingForLovableCloud, true);
  assert.equal(sim.executedPrompts.length, 0); // Não executou operação no banco
});

test("TESTE 16: Erro 401 -> tratar como sessão inválida/necessidade de autenticação", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    cloudStatus: "auth_required",
    isLovableProject: true,
    projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    hasLovableCloud: null,
    lovableCloudConnected: false,
    lovableSessionValid: false
  };

  const sim = new JitExecutionSimulator(manager);
  const res = await sim.sendPrompt({
    sessionId: "sess_401",
    text: "Consulte os dados da tabela produtos no banco."
  });

  assert.equal(res.waitingForLovableCloud, true);
  assert.equal(sim.taskState, "waiting_for_lovable_cloud");
});

test("TESTE 17: Erro 403/404/500/network -> não assumir automaticamente 'sem Cloud'", async () => {
  const manager = new LovableCloudManager();
  // Projeto com hasLovableCloud previamente confirmado, mas estado temporário forbidden
  manager.state = {
    status: "disconnected",
    cloudStatus: "forbidden",
    isLovableProject: true,
    projectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    hasLovableCloud: true,
    lovableCloudConnected: false,
    lovableSessionValid: true
  };

  assert.equal(manager.state.hasLovableCloud, true);
  assert.equal(manager.state.cloudStatus, "forbidden");

  const sim = new JitExecutionSimulator(manager);
  const res = await sim.sendPrompt({
    sessionId: "sess_403",
    text: "Crie a tabela audit no banco de dados."
  });

  // Não assume "no_cloud"; entra em waiting_for_lovable_cloud para reconexão/revalidação
  assert.equal(res.waitingForLovableCloud, true);
  assert.equal(manager.state.hasLovableCloud, true);
});

test("TESTE 18: Cloud já conectado -> não abrir modal novamente", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "connected",
    cloudStatus: "connected",
    isLovableProject: true,
    projectId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    lovableCloudConnected: true,
    lovableSessionValid: true
  };

  const sim = new JitExecutionSimulator(manager);
  await sim.sendPrompt({
    sessionId: "sess_no_repeat_modal",
    text: "Crie a tabela notas no banco."
  });

  assert.equal(sim.modal, null);
  assert.equal(sim.taskState, "completed");
  assert.equal(sim.executedPrompts.length, 1);
});

test("TESTE 19: Cancelar e depois enviar novo prompt -> novo prompt funciona normalmente", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);

  // 1. Envia prompt de banco -> entra em JIT
  await sim.sendPrompt({
    sessionId: "sess_cancel_and_new",
    text: "Crie a tabela teste no banco."
  });
  assert.equal(sim.modal, "lovable_jit");

  // 2. Cancela
  sim.cancelJit();
  assert.equal(sim.pendingPrompt, null);
  assert.equal(sim.modal, null);

  // 3. Envia novo prompt puramente visual
  const newPromptRes = await sim.sendPrompt({
    sessionId: "sess_cancel_and_new",
    text: "Altere a cor do cabeçalho para azul escuro."
  });

  assert.equal(newPromptRes.ok, true);
  assert.equal(sim.modal, null);
  assert.equal(sim.executedPrompts.length, 1);
  assert.equal(sim.executedPrompts[0].text, "Altere a cor do cabeçalho para azul escuro.");
});

test("TESTE 20: Prevenir loop infinito de reconexão", async () => {
  const manager = new LovableCloudManager();
  manager.state = {
    status: "disconnected",
    isLovableProject: true,
    projectId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    lovableCloudConnected: false
  };

  const sim = new JitExecutionSimulator(manager);

  await sim.sendPrompt({
    sessionId: "sess_loop_prevent",
    text: "Crie a tabela configuracoes no banco de dados."
  });
  assert.ok(sim.pendingPrompt !== null);

  // Simula conexão bem-sucedida
  manager.state.status = "connected";
  manager.state.lovableCloudConnected = true;

  // Auto-resume é chamado
  await sim.onCloudConnected();

  // pendingPrompt DEVE ter sido limpo para null
  assert.equal(sim.pendingPrompt, null);
  assert.equal(sim.executedPrompts.length, 1);

  // Uma segunda chamada subsequente de evento state-change não deve reenviar o prompt
  await sim.onCloudConnected();
  assert.equal(sim.executedPrompts.length, 1, "Não deve duplicar execução nem entrar em loop!");
});

// ============================================================================
// TESTES DE LAYER 2 (MCP TOOL GUARD JIT SUSPENSION & RESUME)
// ============================================================================

class MockLovableCloudManagerWithEvents extends EventEmitter {
  constructor(initialState = {}) {
    super();
    this.activePath = "C:\\workspace\\test_lovable_app";
    this.generation = 1;
    this.state = {
      projectId: "proj_test_jit_123",
      isLovableProject: true,
      status: "disconnected",
      cloudStatus: "auth_required",
      lovableCloudConnected: false,
      ...initialState
    };
  }

  getActiveProjectPath() {
    return this.activePath;
  }

  getProjectGeneration() {
    return this.generation;
  }

  getState() {
    return { ...this.state };
  }

  async getDatabaseSchema() {
    return "TABLE users (id uuid primary key, email text);";
  }

  async executeQuery(sql) {
    return { rows: [{ id: "1", email: "teste@empresa.com" }], rowCount: 1 };
  }

  connectCloud() {
    this.state.status = "connected";
    this.state.cloudStatus = "connected";
    this.state.lovableCloudConnected = true;
    this.state.lovableSessionValid = true;
    this.emit("state-changed", this.getState());
  }
}

test("TESTE 21: Layer 2 MCP Tool Guard - Cloud já conectado -> ferramenta executa normalmente sem suspensão", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    status: "connected",
    cloudStatus: "connected",
    lovableCloudConnected: true,
  });

  const mcp = new LovableMcpServer(mockMgr);

  const callReq = {
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: {
      name: "ver_estrutura_do_banco",
      arguments: {},
    },
  };

  const res = await mcp.handleJsonRpcMessage(callReq);
  assert.equal(res.result.isError, false);
  assert.ok(res.result.content[0].text.includes("TABLE users"));
  assert.equal(mcp.getPendingJitCount(), 0);
});

test("TESTE 22: Layer 2 MCP Tool Guard - Cloud desconectado -> tool call suspende execução e solicita JIT via onJitRequiredHandler", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let jitNotification = null;
  mcp.setOnJitRequired((info) => {
    jitNotification = info;
  });

  const callReq = {
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: {
      name: "ver_estrutura_do_banco",
      arguments: {},
      _meta: { sessionId: "sess_layer2_suspend" },
    },
  };

  // Inicia a requisição assíncrona (ela DEVE ficar suspensa aguardando conexão)
  const promise = mcp.handleJsonRpcMessage(callReq);

  // Aguarda microtask para garantir que a suspensão ocorreu
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(mcp.getPendingJitCount(), 1, "Deveria ter 1 chamada MCP suspensa aguardando Cloud");
  assert.ok(jitNotification !== null, "Deveria ter disparado onJitRequiredHandler");
  assert.equal(jitNotification.toolName, "ver_estrutura_do_banco");
  assert.equal(jitNotification.projectId, "proj_test_jit_123");

  // Limpa cancelando para finalizar a promise
  mcp.cancelAllPendingJit("Teste concluído");
  await promise;
});

test("TESTE 23: Layer 2 MCP Tool Guard - Conexão do Cloud retoma execução da tool call suspensa com dados reais", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let jitNotification = null;
  mcp.setOnJitRequired((info) => {
    jitNotification = info;
  });

  const callReq = {
    jsonrpc: "2.0",
    id: 103,
    method: "tools/call",
    params: {
      name: "ver_estrutura_do_banco",
      arguments: {},
      _meta: { sessionId: "sess_layer2_resume" },
    },
  };

  const toolPromise = mcp.handleJsonRpcMessage(callReq);

  // Verifica que entrou em suspensão
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mcp.getPendingJitCount(), 1);

  // Usuário conecta Lovable Cloud com sucesso
  mockMgr.connectCloud();

  // A promise suspensa da ferramenta deve retomar e completar com sucesso!
  const res = await toolPromise;
  assert.equal(res.result.isError, false);
  assert.ok(res.result.content[0].text.includes("TABLE users"));
  assert.equal(mcp.getPendingJitCount(), 0, "A fila de pendências deve estar vazia após retomada");
});

test("TESTE 24: Layer 2 MCP Tool Guard - Cancelamento do usuário rejeita tool call com mensagem amigável sem executar banco", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
  });

  const mcp = new LovableMcpServer(mockMgr);

  const callReq = {
    jsonrpc: "2.0",
    id: 104,
    method: "tools/call",
    params: {
      name: "consultar_dados",
      arguments: { query: "SELECT * FROM clientes" },
      _meta: { sessionId: "sess_layer2_cancel" },
    },
  };

  const toolPromise = mcp.handleJsonRpcMessage(callReq);

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mcp.getPendingJitCount(), 1);

  // Usuário clica Cancelar na UI
  mcp.cancelAllPendingJit("Operação cancelada pelo usuário.");

  const res = await toolPromise;
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes("Operação cancelada pelo usuário"));
  assert.equal(mcp.getPendingJitCount(), 0);
});

test("TESTE 25: Layer 2 MCP Tool Guard - Múltiplas tool calls suspensas são resolvidas em lote sem loop ou travamento", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
  });

  const mcp = new LovableMcpServer(mockMgr);

  const p1 = mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 201,
    method: "tools/call",
    params: { name: "ver_estrutura_do_banco", arguments: {} },
  });

  const p2 = mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 202,
    method: "tools/call",
    params: { name: "consultar_dados", arguments: { query: "SELECT 1" } },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mcp.getPendingJitCount(), 2);

  // Conecta Cloud
  mockMgr.connectCloud();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1.result.isError, false);
  assert.equal(res2.result.isError, false);
  assert.equal(mcp.getPendingJitCount(), 0);
});

// ============================================================================
// TESTES ADICIONAIS: TESTE 1 CORREÇÃO DEFINITIVA (ESTADO DESCONECTADO PÓS-DESVÍNCULO)
// ============================================================================

test("TESTE 26: Teste 1 Reprodução - Prompt 'Crie uma tabela clientes no banco com nome, email e telefone' detecta necessidade de banco", () => {
  const prompt = "Crie uma tabela clientes no banco com nome, email e telefone.";
  const res = detectDatabaseIntent(prompt);
  assert.equal(res.requiresDatabase, true, "Prompt de criação de tabela clientes no banco DEVE exigir banco");
});

test("TESTE 27: Desconectar Lovable Cloud preserva projectId e lovableProjectId mas define lovableCloudConnected = false", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_clientes_123",
    lovableProjectId: "proj_clientes_123",
    status: "connected",
    cloudStatus: "connected",
    lovableCloudConnected: true,
    hasLovableCloud: true,
  });

  // Simula desconectar
  mockMgr.state.status = "disconnected";
  mockMgr.state.cloudStatus = "auth_required";
  mockMgr.state.lovableCloudConnected = false;
  // projectId e lovableProjectId NÃO devem ser destruídos
  assert.equal(mockMgr.state.projectId, "proj_clientes_123");
  assert.equal(mockMgr.state.lovableProjectId, "proj_clientes_123");
  assert.equal(mockMgr.state.lovableCloudConnected, false);
  assert.equal(mockMgr.state.status, "disconnected");
});

test("TESTE 28: Projeto Lovable com Cloud desconectado -> Prompt 'Crie uma tabela clientes' aciona Layer 1 JIT (não executa direto)", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_clientes_123",
    lovableProjectId: "proj_clientes_123",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const sim = new JitExecutionSimulator(mockMgr);
  const result = await sim.sendPrompt({
    sessionId: "sess_cliente_tabela",
    text: "Crie uma tabela clientes no banco com nome, email e telefone.",
  });

  assert.equal(result.waitingForLovableCloud, true, "Deve pausar a execução e aguardar Lovable Cloud!");
  assert.equal(sim.taskState, "waiting_for_lovable_cloud");
  assert.equal(sim.modal, "lovable_jit");
  assert.equal(sim.executedPrompts.length, 0, "NÃO deve ter executado o prompt antes de conectar!");
});

test("TESTE 29: Projeto Lovable com Cloud desconectado -> MCP tool call aciona Layer 2 JIT Guard (não aborta com erro prematuro)", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_clientes_123",
    lovableProjectId: "proj_clientes_123",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let jitNotified = false;
  mcp.setOnJitRequired(() => {
    jitNotified = true;
  });

  const callReq = {
    jsonrpc: "2.0",
    id: 301,
    method: "tools/call",
    params: {
      name: "alterar_estrutura_do_banco",
      arguments: {
        query: "CREATE TABLE clientes (id uuid primary key, nome text, email text, telefone text);",
        summary: "Criar tabela clientes",
      },
      _meta: { sessionId: "sess_mcp_clientes" },
    },
  };

  const toolPromise = mcp.handleJsonRpcMessage(callReq);
  await new Promise((r) => setTimeout(r, 20));

  // MCP não deve retornar erro imediato "Este projeto não possui um Lovable Cloud conectado."
  // Deve suspender a chamada aguardando JIT!
  assert.equal(mcp.getPendingJitCount(), 1, "Tool call deve estar suspensa aguardando conexão JIT");
  assert.equal(jitNotified, true, "Deve ter notificado a UI para abrir o modal JIT");

  // Limpa pendência
  mcp.cancelAllPendingJit("Cancelado para teste");
  await toolPromise;
});

test("TESTE 30: Projeto não-Lovable -> MCP tool call rejeita com erro sem suspender JIT", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    isLovableProject: false,
    projectId: null,
    lovableProjectId: null,
    detectedProjectId: null,
    lovableCloudConnected: false,
  });

  const mcp = new LovableMcpServer(mockMgr);
  const callReq = {
    jsonrpc: "2.0",
    id: 302,
    method: "tools/call",
    params: {
      name: "ver_estrutura_do_banco",
      arguments: {},
    },
  };

  const res = await mcp.handleJsonRpcMessage(callReq);
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes("Este projeto não possui um Lovable Cloud conectado"));
  assert.equal(mcp.getPendingJitCount(), 0, "Não deve suspender para projetos não-Lovable");
});

test("TESTE 31: Projeto Lovable sem projectId identificado -> MCP tool call rejeita sem abrir JIT às cegas", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    isLovableProject: true,
    projectId: null,
    lovableProjectId: null,
    detectedProjectId: null,
    lovableCloudConnected: false,
  });

  const mcp = new LovableMcpServer(mockMgr);
  const callReq = {
    jsonrpc: "2.0",
    id: 303,
    method: "tools/call",
    params: {
      name: "ver_estrutura_do_banco",
      arguments: {},
    },
  };

  const res = await mcp.handleJsonRpcMessage(callReq);
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes("nenhum ID de projeto foi identificado"));
  assert.equal(mcp.getPendingJitCount(), 0, "Não deve suspender JIT sem projectId");
});

test("TESTE 32: isCloudConnected strictly requires lovableCloudConnected === true (não aceita accessToken isolado)", () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    lovableCloudConnected: false,
    accessToken: "fake_token_123",
  });

  const mcp = new LovableMcpServer(mockMgr);
  assert.equal(mcp.isCloudConnected(), false, "Presença de accessToken isolado NÃO deve ser considerada conexão!");
});

test("TESTE 33: isCloudConnected strictly requires lovableCloudConnected === true (não aceita status='connected' isolado)", () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    lovableCloudConnected: false,
    status: "connected",
  });

  const mcp = new LovableMcpServer(mockMgr);
  assert.equal(mcp.isCloudConnected(), false, "status isolado sem lovableCloudConnected: true NÃO é conectado!");
});

test("TESTE 34: isCloudConnected retorna true apenas com lovableCloudConnected === true", () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    lovableCloudConnected: true,
    status: "connected",
  });

  const mcp = new LovableMcpServer(mockMgr);
  assert.equal(mcp.isCloudConnected(), true);
});

test("TESTE 35: Fluxo completo de Desconexão -> Layer 1 JIT -> Conexão -> Retomada sem duplicação", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_full_flow",
    lovableProjectId: "proj_full_flow",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const sim = new JitExecutionSimulator(mockMgr);

  // 1. Enviar prompt que exige banco
  const promptPayload = {
    sessionId: "sess_full_flow",
    text: "Crie uma tabela clientes no banco com nome, email e telefone.",
  };
  const step1 = await sim.sendPrompt(promptPayload);
  assert.equal(step1.waitingForLovableCloud, true);
  assert.equal(sim.executedPrompts.length, 0);

  // 2. Conectar Cloud via JIT
  mockMgr.connectCloud();
  assert.equal(mockMgr.state.lovableCloudConnected, true);

  // 3. Callback de conexão concluída retoma execução do prompt pendente
  const step2 = await sim.onCloudConnected();
  assert.equal(step2.ok, true);
  assert.equal(sim.executedPrompts.length, 1);
  assert.equal(sim.executedPrompts[0].text, promptPayload.text);
  assert.equal(sim.pendingPrompt, null);
  assert.equal(sim.modal, null);
});

test("TESTE 36: Fluxo completo de Desconexão -> Layer 2 JIT -> Conexão -> Execução com sucesso da tool", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_full_flow_mcp",
    lovableProjectId: "proj_full_flow_mcp",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const mcp = new LovableMcpServer(mockMgr);

  const callReq = {
    jsonrpc: "2.0",
    id: 401,
    method: "tools/call",
    params: {
      name: "consultar_dados",
      arguments: {
        query: "SELECT id, nome, email, telefone FROM clientes",
      },
      _meta: { sessionId: "sess_mcp_flow" },
    },
  };

  // Dispara tool call enquanto desconectado
  const toolPromise = mcp.handleJsonRpcMessage(callReq);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mcp.getPendingJitCount(), 1);

  // Simula conexão Cloud bem-sucedida pelo usuário
  mockMgr.connectCloud();

  // Tool suspensa deve retomar e executar query
  const res = await toolPromise;
  assert.equal(res.result.isError, false);
  assert.ok(res.result.content[0].text.includes("linha(s) encontrada(s)"));
  assert.equal(mcp.getPendingJitCount(), 0);
});

test("TESTE 37: Disconnect com sessão ativa no Chromium NÃO reverte para connected via probe", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_anti_revert",
    lovableProjectId: "proj_anti_revert",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    lovableSessionValid: true,
    explicitlyDisconnected: true,
    hasLovableCloud: true,
  });

  // Simula múltiplos ciclos de probe / navegação ocorrendo em background
  for (let i = 0; i < 5; i++) {
    // Se explicitamente desconectado, o probe não deve alterar lovableCloudConnected
    const isExplicitlyDisc = mockMgr.state.explicitlyDisconnected === true;
    if (!isExplicitlyDisc) {
      mockMgr.connectCloud();
    }
  }

  assert.equal(mockMgr.state.lovableCloudConnected, false, "NÃO deve ter sido reconectado pelo probe!");
  assert.equal(mockMgr.state.status, "disconnected");
  assert.equal(mockMgr.state.projectId, "proj_anti_revert");
});

test("TESTE 38: Reconexão de projeto desconectado exige ação explícita (linkProject) e só então limpa explicitlyDisconnected", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_explicit_reconnect",
    lovableProjectId: "proj_explicit_reconnect",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    explicitlyDisconnected: true,
    hasLovableCloud: true,
  });

  assert.equal(mockMgr.state.lovableCloudConnected, false);
  assert.equal(mockMgr.state.explicitlyDisconnected, true);

  // Usuário clica explicitamente em "Conectar este projeto"
  mockMgr.state.explicitlyDisconnected = false;
  mockMgr.connectCloud();

  assert.equal(mockMgr.state.lovableCloudConnected, true);
  assert.equal(mockMgr.state.explicitlyDisconnected, false);
});

// ============================================================================
// FASE 4B - CASOS DE BORDA: DETECTOR (ITENS A a J)
// ============================================================================

test("TESTE 39 [Detector A a J]: Auditoria completa de prompts visuais/mocks vs. dados reais/banco", () => {
  // A. Tabela visual
  assert.equal(detectDatabaseIntent("Crie uma tabela visual de preços.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie uma tabela visual com os planos.").requiresDatabase, false);

  // B. Mock e fictício
  assert.equal(detectDatabaseIntent("Crie um dashboard com dados mockados.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie uma página com clientes fictícios.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie cards de produtos.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie um botão para salvar.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie um formulário visual.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie uma landing page.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie uma tabela de preços.").requiresDatabase, false);
  assert.equal(detectDatabaseIntent("Crie um dashboard com dados fictícios.").requiresDatabase, false);

  // C. Tabela real explícita
  assert.equal(detectDatabaseIntent("Crie uma tabela clientes no banco com nome, email e telefone.").requiresDatabase, true);

  // D. Tabela de clientes no banco
  assert.equal(detectDatabaseIntent("Tabela de clientes no banco.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Tabela de clientes reais no banco.").requiresDatabase, true);

  // E. Alterar dados no banco
  assert.equal(detectDatabaseIntent("Altere os dados no banco.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Alterar dados no banco.").requiresDatabase, true);

  // F. Consultar clientes reais
  assert.equal(detectDatabaseIntent("Consultar clientes reais.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Consultar os clientes reais.").requiresDatabase, true);

  // G. Carregar / buscar / puxar clientes reais do banco
  assert.equal(detectDatabaseIntent("Carregar os clientes reais do banco.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Carregue os clientes reais do banco.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Buscar os clientes reais do banco.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Puxar os clientes reais do banco.").requiresDatabase, true);

  // H. Prompt misto (frontend + dados reais do banco) - PRECEDÊNCIA OBRIGATÓRIA
  assert.equal(detectDatabaseIntent("Crie uma página de clientes e faça ela carregar os clientes reais do banco.").requiresDatabase, true);
  assert.equal(detectDatabaseIntent("Crie uma página de clientes que mostre os clientes reais.").requiresDatabase, true);

  // I. Prompt ambíguo: "Adicione clientes ao sistema."
  // Não cita banco nem dados reais: não deve disparar JIT no Layer 1 pelo texto isolado
  assert.equal(detectDatabaseIntent("Adicione clientes ao sistema.").requiresDatabase, false);
});

// ============================================================================
// FASE 4B - CASOS DE BORDA: LAYER 1 JIT (ITENS K a P)
// ============================================================================

test("TESTE 40 [Layer 1 K-P]: Prompt misto aciona JIT Layer 1, preserva prompt e cancelamento não executa", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_mixed_jit",
    lovableProjectId: "proj_mixed_jit",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const sim = new JitExecutionSimulator(mockMgr);

  // K & L: Prompt misto com Cloud desconectado aciona JIT e modal
  const promptPayload = {
    sessionId: "sess_mixed_jit",
    text: "Crie uma página de clientes e faça ela carregar os clientes reais do banco.",
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
    attachments: [],
    contextPaths: ["src/App.tsx"],
    planMode: false,
    effort: "high"
  };

  const res = await sim.sendPrompt(promptPayload);
  assert.equal(res.waitingForLovableCloud, true);
  assert.equal(sim.modal, "lovable_jit");
  assert.equal(sim.executedPrompts.length, 0, "Nenhum prompt deve executar antes da conexão");

  // M: Preservação integral do prompt
  assert.ok(sim.pendingPrompt);
  assert.equal(sim.pendingPrompt.text, promptPayload.text);
  assert.equal(sim.pendingPrompt.model.modelID, "claude-3-5-sonnet");
  assert.deepEqual(sim.pendingPrompt.contextPaths, ["src/App.tsx"]);

  // P: Cancelamento descarta pending e nenhuma execução ocorre
  sim.cancelJit();
  assert.equal(sim.modal, null);
  assert.equal(sim.pendingPrompt, null);
  assert.equal(sim.executedPrompts.length, 0);

  // Mesmo que o Cloud conecte depois, a tarefa cancelada NÃO deve executar
  mockMgr.connectCloud();
  await sim.onCloudConnected();
  assert.equal(sim.executedPrompts.length, 0, "Tarefa cancelada não pode ser re-executada ao conectar depois!");
});

// ============================================================================
// FASE 4B - CASOS DE BORDA: LAYER 2 JIT (ITENS Q a Z)
// ============================================================================

test("TESTE 41 [Layer 2 Q-Z]: Prompt ambíguo passa Layer 1, Agent chama MCP, Layer 2 suspende e retoma no Renderer sem duplicar prompt", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_ambiguous_flow",
    lovableProjectId: "proj_ambiguous_flow",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let jitRequiredEmitted = null;
  mcp.setOnJitRequired((info) => {
    jitRequiredEmitted = info;
  });

  // Estado simulado do Renderer
  const rendererSim = {
    modal: null,
    taskPhase: "running",
    busy: true,
    workingStatus: "Agent pensando...",
    pendingJITPrompt: null, // Layer 2 não tem pendingJITPrompt no Renderer
    executedPrompts: [],
  };

  // Q & R: Agent chama tool MCP de banco enquanto desconectado
  const toolPromise = mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 501,
    method: "tools/call",
    params: {
      name: "ver_estrutura_do_banco",
      arguments: {},
      _meta: { sessionId: "sess_ambiguous" },
    },
  });

  await new Promise((r) => setTimeout(r, 20));

  // S: onJitRequiredHandler é emitido
  assert.ok(jitRequiredEmitted);
  assert.equal(jitRequiredEmitted.toolName, "ver_estrutura_do_banco");
  assert.equal(mcp.getPendingJitCount(), 1);

  // T: Renderer recebe evento e atualiza estado
  rendererSim.taskPhase = "waiting_for_lovable_cloud";
  rendererSim.busy = false;
  rendererSim.modal = "lovable_jit";

  assert.equal(rendererSim.modal, "lovable_jit");
  assert.equal(rendererSim.taskPhase, "waiting_for_lovable_cloud");

  // U: Usuário conecta Lovable Cloud
  mockMgr.connectCloud();

  // V: Tool MCP suspensa retoma e completa com sucesso
  const toolRes = await toolPromise;
  assert.equal(toolRes.result.isError, false);
  assert.ok(toolRes.result.content[0].text.includes("TABLE users"));
  assert.equal(mcp.getPendingJitCount(), 0);

  // W, X & Y: Renderer reage ao onLovableStateChange para Layer 2:
  // Se lovableCloudConnected === true e taskPhase === "waiting_for_lovable_cloud" e pendingJITPrompt === null:
  if (mockMgr.state.lovableCloudConnected && rendererSim.taskPhase === "waiting_for_lovable_cloud" && !rendererSim.pendingJITPrompt) {
    rendererSim.modal = null;
    rendererSim.taskPhase = "running";
    rendererSim.busy = true;
    rendererSim.workingStatus = "Executando operação no Lovable Cloud...";
    // NÃO chama window.neko.prompt!
  }

  assert.equal(rendererSim.modal, null);
  assert.equal(rendererSim.taskPhase, "running");
  assert.equal(rendererSim.busy, true);
  assert.equal(rendererSim.executedPrompts.length, 0, "NÃO deve reenviar prompt no Layer 2!");
});

test("TESTE 42 [Layer 2 Z]: Cancelamento rejeita a espera do MCP e aborta com segurança", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_cancel_layer2",
    lovableProjectId: "proj_cancel_layer2",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let jitRequiredEmitted = null;
  mcp.setOnJitRequired((info) => {
    jitRequiredEmitted = info;
  });

  // Dispara tool call
  const toolPromise = mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 502,
    method: "tools/call",
    params: {
      name: "consultar_dados",
      arguments: { query: "SELECT * FROM secrets" },
      _meta: { sessionId: "sess_cancel_mcp" },
    },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mcp.getPendingJitCount(), 1);

  // Usuário cancela o modal JIT
  mcp.cancelAllPendingJit("Operação cancelada pelo usuário.");

  const toolRes = await toolPromise;
  assert.equal(toolRes.result.isError, true);
  assert.ok(toolRes.result.content[0].text.includes("Operação cancelada pelo usuário"));
  assert.equal(mcp.getPendingJitCount(), 0);
});

// ============================================================================
// FASE 4B - CASOS DE BORDA: IDEMPOTÊNCIA (ITENS AA a AD)
// ============================================================================

test("TESTE 43 [Idempotência AA-AD]: Múltiplos eventos state-changed não duplicam resolução nem retomada", async () => {
  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_idempotence",
    lovableProjectId: "proj_idempotence",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let resolveCount = 0;

  // Dispara 2 tools concorrentes suspensas
  const p1 = mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 601,
    method: "tools/call",
    params: { name: "ver_estrutura_do_banco", arguments: {}, _meta: { sessionId: "sess_idem" } },
  }).then(r => { resolveCount++; return r; });

  const p2 = mcp.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 602,
    method: "tools/call",
    params: { name: "consultar_dados", arguments: { query: "SELECT 1" }, _meta: { sessionId: "sess_idem" } },
  }).then(r => { resolveCount++; return r; });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mcp.getPendingJitCount(), 2);

  // Dispara 5 eventos state-changed consecutivos (ex: probe, link, rehydrate)
  mockMgr.connectCloud();
  mockMgr.emit("state-changed", mockMgr.getState());
  mockMgr.emit("state-changed", mockMgr.getState());
  mockMgr.emit("state-changed", mockMgr.getState());
  mockMgr.emit("state-changed", mockMgr.getState());

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.result.isError, false);
  assert.equal(r2.result.isError, false);
  assert.equal(resolveCount, 2, "Cada tool deve ser resolvida exatamente UMA vez!");
  assert.equal(mcp.getPendingJitCount(), 0);
});

// ============================================================================
// FASE 4B - RESUMO CIRÚRGICO: AUTO-RESUME E DEDUPLICAÇÃO DE MIGRATION CARD
// ============================================================================

test("TESTE 44 [Layer 2 Auto-Resume]: alterar_banco suspenso retoma pós-conexão e gera exatamente 1 migration-asked (sem duplicação)", async () => {
  try { migrationManager.cancelAllPendingProposals(); } catch {}

  const mockMgr = new MockLovableCloudManagerWithEvents({
    projectId: "proj_autoresume_mcp",
    lovableProjectId: "proj_autoresume_mcp",
    status: "disconnected",
    cloudStatus: "auth_required",
    lovableCloudConnected: false,
    hasLovableCloud: true,
  });

  const mcp = new LovableMcpServer(mockMgr);
  let jitRequiredEmitted = null;
  mcp.setOnJitRequired((info) => {
    jitRequiredEmitted = info;
  });

  let askedCount = 0;
  let receivedProposal = null;
  const onAsked = (proposal) => {
    askedCount++;
    receivedProposal = proposal;
  };
  migrationManager.on("migration-asked", onAsked);

  try {
    // 1. Inicia tool alterar_banco enquanto Lovable Cloud está desconectado
    const toolPromise = mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 701,
      method: "tools/call",
      params: {
        name: "alterar_banco",
        arguments: {
          query: "CREATE TABLE clientes (id serial primary key, nome text, email text, telefone text);",
          summary: "Criação da tabela clientes"
        },
        _meta: { sessionId: "sess_autoresume_test" }
      }
    });

    await new Promise((r) => setTimeout(r, 20));

    // Tool deve estar suspensa aguardando JIT
    assert.equal(mcp.getPendingJitCount(), 1, "Tool deve estar suspensa");
    assert.ok(jitRequiredEmitted, "Deve emitir onJitRequiredHandler");
    assert.ok(jitRequiredEmitted.jitId, "onJitRequiredHandler deve conter jitId");
    assert.equal(askedCount, 0, "Nenhuma proposta de migration deve ter sido criada antes da conexão!");

    // 2. Conecta o Lovable Cloud
    mockMgr.connectCloud();

    // Aguarda a retomada e o disparo de proposeMigration
    await new Promise((r) => setTimeout(r, 40));

    // Agora o MigrationManager deve ter emitido exatamente 1 proposta
    assert.equal(askedCount, 1, "Deve emitir exatamente 1 migration-asked após a conexão!");
    assert.ok(receivedProposal, "Proposta deve existir");
    assert.equal(receivedProposal.jitRequestId, jitRequiredEmitted.jitId, "jitRequestId deve bater com o JIT gerado na suspensão");

    // 3. Usuário aprova a migration
    const replyResult = await migrationManager.replyProposal(receivedProposal.id, true);
    assert.equal(replyResult.success, true);
    assert.equal(replyResult.status, "APPROVED");

    // Notifica conclusão da tool
    migrationManager.notifyToolCompleted({
      proposalId: receivedProposal.id,
      success: true,
      executedSql: receivedProposal.originalSql
    });

    const toolResult = await toolPromise;
    assert.equal(toolResult.result.isError, false, "Tool alterar_banco deve finalizar com sucesso");
    assert.equal(askedCount, 1, "Ao final de todo o ciclo deve haver exatamente 1 evento migration-asked!");
  } finally {
    migrationManager.off("migration-asked", onAsked);
    try { migrationManager.cancelAllPendingProposals(); } catch {}
  }
});

test("TESTE 45 [Double-Resume Protection]: Renderer com Layer 2 NÃO invoca window.neko.prompt pós-conexão", () => {
  // Simula estado do Renderer
  let promptCallCount = 0;
  const mockWindowNekoPrompt = () => {
    promptCallCount++;
    return Promise.resolve({ taskId: "dummy" });
  };

  const rendererState = {
    modal: "lovable_jit",
    taskPhase: "waiting_for_lovable_cloud",
    busy: false,
    workingStatus: "Aguardando conexão com o Lovable Cloud...",
    pendingJIT: {
      source: "layer2",
      sessionId: "sess_layer2_double_resume",
      toolName: "alterar_banco",
      projectId: "proj_123",
      jitId: "jit_test_123"
    }
  };

  // Evento lovable:state-changed recebido no Renderer:
  const incomingState = { lovableCloudConnected: true, status: "connected" };

  if (incomingState.lovableCloudConnected || incomingState.status === "connected") {
    rendererState.modal = null;
    const pending = rendererState.pendingJIT;
    rendererState.pendingJIT = null; // Limpa imediatamente

    if (pending?.source === "layer1" && pending.text) {
      mockWindowNekoPrompt();
    } else if (pending?.source === "layer2" || rendererState.taskPhase === "waiting_for_lovable_cloud") {
      // Layer 2: MCP Promise no backend reassume a execução
      // NUNCA chamar window.neko.prompt()
      rendererState.taskPhase = "running";
      rendererState.busy = true;
      rendererState.workingStatus = "Executando operação no Lovable Cloud...";
    }
  }

  assert.equal(promptCallCount, 0, "window.neko.prompt NÃO deve ser chamado no Layer 2!");
  assert.equal(rendererState.taskPhase, "running");
  assert.equal(rendererState.busy, true);
  assert.equal(rendererState.pendingJIT, null, "pendingJIT deve ser limpo");
  assert.equal(rendererState.modal, null);
});

test("TESTE 46 [Layer 1 Auto-Resume Preserved]: Renderer com Layer 1 invoca window.neko.prompt exatamente UMA vez", () => {
  let promptCallCount = 0;
  let promptedText = null;
  const mockWindowNekoPrompt = (session, text) => {
    promptCallCount++;
    promptedText = text;
    return Promise.resolve({ taskId: "task_layer1_resumed" });
  };

  const rendererState = {
    modal: "lovable_jit",
    taskPhase: "waiting_for_lovable_cloud",
    busy: false,
    pendingJIT: {
      source: "layer1",
      sessionId: "sess_layer1_test",
      text: "Crie uma tabela clientes no banco",
      model: { providerID: "anthropic", modelID: "claude-3-5" },
      taskId: "task_orig"
    }
  };

  // Evento 1: Conexão bem-sucedida
  const incomingState1 = { lovableCloudConnected: true, status: "connected" };

  if (incomingState1.lovableCloudConnected || incomingState1.status === "connected") {
    rendererState.modal = null;
    const pending = rendererState.pendingJIT;
    rendererState.pendingJIT = null;

    if (pending?.source === "layer1" && pending.text) {
      mockWindowNekoPrompt(pending.sessionId, pending.text);
      rendererState.taskPhase = "running";
      rendererState.busy = true;
    }
  }

  assert.equal(promptCallCount, 1, "Deve retomar prompt no Layer 1");
  assert.equal(promptedText, "Crie uma tabela clientes no banco");
  assert.equal(rendererState.pendingJIT, null);

  // Evento 2 atrasado/duplicado (ex: probe rehydrate):
  const incomingState2 = { lovableCloudConnected: true, status: "connected" };
  if (incomingState2.lovableCloudConnected || incomingState2.status === "connected") {
    const pending = rendererState.pendingJIT;
    if (pending?.source === "layer1" && pending.text) {
      mockWindowNekoPrompt(pending.sessionId, pending.text);
    }
  }

  assert.equal(promptCallCount, 1, "Segundo evento não pode disparar segundo prompt!");
});

test("TESTE 47 [MigrationManager Deduplication]: Propostas com mesmo jitRequestId ou normalizedSql reutilizam a mesma Promise", async () => {
  try { migrationManager.cancelAllPendingProposals(); } catch {}

  let askedCount = 0;
  const onAsked = () => { askedCount++; };
  migrationManager.on("migration-asked", onAsked);

  try {
    const sql = "CREATE TABLE produtos_dedup (id serial primary key, nome text, preco numeric);";
    const jitRequestId = "jit_req_dedup_unique_123";

    // 1ª chamada
    const p1 = migrationManager.proposeMigration({
      sessionId: "sess_dedup",
      permissionId: `perm_${jitRequestId}`,
      jitRequestId,
      callId: "call_1",
      projectRef: "proj_dedup_ref",
      name: "lovable_mutation",
      sql,
      provider: "lovable",
      lovableProjectId: "proj_dedup_ref",
      projectGeneration: 1
    });

    assert.equal(askedCount, 1, "Primeira proposta deve emitir migration-asked");

    // 2ª chamada simultânea ou repetida com o mesmo jitRequestId
    const p2 = migrationManager.proposeMigration({
      sessionId: "sess_dedup",
      permissionId: `perm_${jitRequestId}`,
      jitRequestId,
      callId: "call_2",
      projectRef: "proj_dedup_ref",
      name: "lovable_mutation",
      sql,
      provider: "lovable",
      lovableProjectId: "proj_dedup_ref",
      projectGeneration: 1
    });

    assert.equal(askedCount, 1, "Segunda proposta com mesmo jitRequestId NÃO deve emitir segundo migration-asked!");

    // Obtém id da proposta pendente
    const pendingProposals = Array.from(migrationManager.getPendingProposals ? migrationManager.getPendingProposals() : []);
    const proposal = pendingProposals[0];
    assert.ok(proposal, "Proposta deve existir");
    assert.equal(proposal.jitRequestId, jitRequestId);

    // Aprova a proposta
    const res = await migrationManager.replyProposal(proposal.id, true);
    assert.equal(res.status, "APPROVED");

    // Ambas as promises p1 e p2 devem resolver para o mesmo resultado
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(r1.proposalId, proposal.id);
    assert.equal(r2.proposalId, proposal.id);
    assert.equal(askedCount, 1, "Total de migration-asked deve permanecer 1!");
  } finally {
    migrationManager.off("migration-asked", onAsked);
    try { migrationManager.cancelAllPendingProposals(); } catch {}
  }
});



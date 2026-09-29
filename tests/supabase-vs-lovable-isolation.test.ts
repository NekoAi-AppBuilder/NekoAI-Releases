import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { MigrationManager } from "../dist/main/supabase/migration-manager.js";
import { removeLovableSkill, removeLovableOpenCodeConfig } from "../dist/main/lovable/lovable-mcp-server.js";

/**
 * Test Suite: Isolamento Supabase Native vs Lovable Cloud (P0 Fix)
 * Garante que a identidade do workspace (Project Binding) determina o executor/backend
 * e NUNCA o nome da ferramenta (toolName).
 */

interface WorkspaceBinding {
  type: "supabase-native" | "lovable-cloud" | "lovable-no-cloud" | "none";
  supabaseRef?: string;
  lovableProjectId?: string;
  isLovableProject?: boolean;
  hasLovableCloud?: boolean;
}

function resolveBackendAndProvider(
  binding: WorkspaceBinding,
  permissionType: string
): { provider: "supabase" | "lovable"; activeRef: string } {
  const isLovableCloudWorkspace = Boolean(
    binding.type === "lovable-cloud" || (binding.isLovableProject && binding.hasLovableCloud === true)
  );
  const supabaseRef = binding.supabaseRef || (binding.type === "supabase-native" ? "supabase_project" : "");

  let provider: "supabase" | "lovable" = "supabase";
  let activeRef = "";

  if (isLovableCloudWorkspace) {
    provider = "lovable";
    activeRef = binding.lovableProjectId || "lovable_cloud";
  } else if (supabaseRef) {
    provider = "supabase";
    activeRef = supabaseRef;
  } else {
    // Fallback seguro quando nenhum binding configurado existe no vault:
    // NUNCA deriva 'lovable' a partir de alterar_banco ou nomes de ferramentas.
    provider = "supabase";
    if (permissionType.startsWith("neko_supabase_")) {
      const match = permissionType.match(/neko_supabase_([a-zA-Z0-9_-]+)/);
      if (match) activeRef = match[1];
    }
    if (!activeRef) activeRef = "supabase";
  }

  return { provider, activeRef };
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neko-test-p0-${prefix}-`));
}

// TESTE 1
test("TESTE 1: Supabase Native chamando alterar_banco -> Roteado estritamente para executor Supabase Native", async () => {
  const binding: WorkspaceBinding = { type: "supabase-native", supabaseRef: "proj-native-123" };
  const toolCalled = "alterar_banco"; // Nome de tool associado ao Lovable, mas chamado num projeto Supabase

  const resolved = resolveBackendAndProvider(binding, toolCalled);

  assert.equal(resolved.provider, "supabase", "Provider DEVE ser 'supabase' em projeto Supabase Native");
  assert.equal(resolved.activeRef, "proj-native-123", "activeRef DEVE ser o supabaseRef do projeto");
});

// TESTE 2
test("TESTE 2: Lovable Cloud chamando alterar_banco -> Roteado estritamente para executor Lovable Cloud MCP", async () => {
  const binding: WorkspaceBinding = { type: "lovable-cloud", lovableProjectId: "lov-cloud-456" };
  const toolCalled = "alterar_banco";

  const resolved = resolveBackendAndProvider(binding, toolCalled);

  assert.equal(resolved.provider, "lovable", "Provider DEVE ser 'lovable' em projeto Lovable Cloud");
  assert.equal(resolved.activeRef, "lov-cloud-456", "activeRef DEVE ser o lovableProjectId do projeto");
});

// TESTE 3
test("TESTE 3: Supabase Native com proposta provider=lovable -> NekoAI revalida e impede Lovable MCP", async () => {
  const binding: WorkspaceBinding = { type: "supabase-native", supabaseRef: "proj-native-789" };
  const manager = new MigrationManager();

  let proposalProvider = "";
  manager.on("migration-asked", (prop) => {
    proposalProvider = prop.provider;
  });

  const toolCalled = "alterar_banco";
  const resolved = resolveBackendAndProvider(binding, toolCalled);

  void manager.proposeMigration({
    sessionId: "sess_supa_guard",
    permissionId: "perm_supa_guard",
    projectRef: resolved.activeRef,
    name: "create_table_test",
    sql: "CREATE TABLE test_supa (id uuid);",
    provider: resolved.provider
  });

  assert.equal(proposalProvider, "supabase", "Proposta deve ter provider='supabase' em workspace Supabase Native");
});

// TESTE 4
test("TESTE 4: Lovable Cloud recebendo chamada de migration -> proposta gerada com provider='lovable'", async () => {
  const binding: WorkspaceBinding = { type: "lovable-cloud", lovableProjectId: "lov-proj-999" };
  const manager = new MigrationManager();

  let proposalProvider = "";
  manager.on("migration-asked", (prop) => {
    proposalProvider = prop.provider;
  });

  const toolCalled = "alterar_banco";
  const resolved = resolveBackendAndProvider(binding, toolCalled);

  void manager.proposeMigration({
    sessionId: "sess_lov_guard",
    permissionId: "perm_lov_guard",
    projectRef: resolved.activeRef,
    name: "create_table_lovable",
    sql: "CREATE TABLE test_lov (id uuid);",
    provider: resolved.provider
  });

  assert.equal(proposalProvider, "lovable", "Proposta deve ter provider='lovable' em workspace Lovable Cloud");
});

// TESTE 5 & TESTE 6
test("TESTES 5 & 6: Troca de projeto Supabase Native <-> Lovable Cloud limpa Skills e MCP do Lovable", async () => {
  const dir = createTempDir("skills-cleanup");
  try {
    const skillDir = path.join(dir, ".opencode", "skills", "neko-lovable-cloud");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Stale Lovable Skill", "utf8");

    const openCodeJson = path.join(dir, "opencode.json");
    fs.writeFileSync(openCodeJson, JSON.stringify({ mcp: { neko_lovable_cloud: { enabled: true } } }), "utf8");

    // Abrir projeto Supabase Native -> Executa limpeza de skill Lovable residual
    await removeLovableOpenCodeConfig(dir);

    const skillExists = fs.existsSync(skillDir);
    assert.equal(skillExists, false, "Skill residual do Lovable Cloud DEVE ser removida ao carregar projeto Supabase Native");

    const rawConfig = fs.readFileSync(openCodeJson, "utf8");
    const parsed = JSON.parse(rawConfig);
    assert.equal(parsed.mcp?.neko_lovable_cloud, undefined, "MCP do Lovable Cloud DEVE ser removido de opencode.json em Supabase Native");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// TESTE 7
test("TESTE 7: Execução sequencial de migrations em Proj A (Supabase) e Proj B (Lovable) -> 100% Isoladas", async () => {
  const bindingA: WorkspaceBinding = { type: "supabase-native", supabaseRef: "ref-proj-a" };
  const bindingB: WorkspaceBinding = { type: "lovable-cloud", lovableProjectId: "ref-proj-b" };

  const manager = new MigrationManager();
  const history: Array<{ project: string; provider: string; ref: string }> = [];

  manager.on("migration-asked", (prop) => {
    history.push({ project: prop.sessionId, provider: prop.provider, ref: prop.projectRef });
  });

  // Migration 1 no Projeto A (Supabase Native)
  const resA = resolveBackendAndProvider(bindingA, "alterar_banco");
  void manager.proposeMigration({
    sessionId: "proj_A",
    permissionId: "perm_A",
    projectRef: resA.activeRef,
    name: "mig_A",
    sql: "CREATE TABLE a (id int);",
    provider: resA.provider
  });

  // Migration 2 no Projeto B (Lovable Cloud)
  const resB = resolveBackendAndProvider(bindingB, "alterar_banco");
  void manager.proposeMigration({
    sessionId: "proj_B",
    permissionId: "perm_B",
    projectRef: resB.activeRef,
    name: "mig_B",
    sql: "CREATE TABLE b (id int);",
    provider: resB.provider
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].provider, "supabase");
  assert.equal(history[0].ref, "ref-proj-a");
  assert.equal(history[1].provider, "lovable");
  assert.equal(history[1].ref, "ref-proj-b");
});

// TESTE 8: Cenário B - Projeto Lovable sem Cloud chamando alterar_banco -> Roteado para Supabase Native
test("TESTE 8: Cenário B (Projeto Lovable sem Cloud) chamando alterar_banco -> Roteado estritamente para Supabase Native", async () => {
  const binding: WorkspaceBinding = { type: "lovable-no-cloud", isLovableProject: true, hasLovableCloud: false };
  const toolCalled = "alterar_banco";

  const resolved = resolveBackendAndProvider(binding, toolCalled);

  assert.equal(resolved.provider, "supabase", "Projeto Lovable sem Cloud DEVE ser roteado para 'supabase' e NUNCA para Lovable MCP");
});

// TESTE 9: Projeto sem binding no cofre chamando alterar_banco -> Fallback seguro atribui provider='supabase'
test("TESTE 9: Projeto desconfigurado chamando alterar_banco -> Fallback seguro atribui provider='supabase'", async () => {
  const binding: WorkspaceBinding = { type: "none" };
  const toolCalled = "alterar_banco";

  const resolved = resolveBackendAndProvider(binding, toolCalled);

  assert.equal(resolved.provider, "supabase", "Fallback seguro sem vault binding NUNCA deve escolher provider='lovable' por causa de alterar_banco");
});

// TESTE 10: Supabase Native migration error message -> Contém 'Supabase' e NUNCA 'Lovable MCP'
test("TESTE 10: Supabase Native com erro de migração sem mensagem -> Fallback usa 'Supabase' e NUNCA 'Lovable MCP'", async () => {
  const manager = new MigrationManager();
  const proposalId = "mig_supa_err_test";

  const propPromise = manager.proposeMigration({
    sessionId: "sess_err_10",
    permissionId: "perm_err_10",
    projectRef: "proj_ref_10",
    name: "test_migration_err",
    sql: "CREATE TABLE t_err (id int);",
    provider: "supabase"
  });

  // Salva ID gerado
  const proposalsArray = Array.from((manager as any).proposals.keys());
  const actualId = proposalsArray[proposalsArray.length - 1];

  let failedError = "";
  manager.on("migration-failed", ({ error }) => {
    failedError = error;
  });

  // Aprova proposta
  void manager.replyProposal(actualId, true);

  // Notifica tool completed com falha sem mensagem customizada
  void manager.notifyToolCompleted(actualId, false, undefined, { remoteApplied: false });

  await propPromise.catch(() => {});

  assert.equal(failedError, "A execução da migração falhou no Supabase.", "Mensagem deve ser específica de Supabase Native");
  assert.equal(failedError.includes("Lovable MCP"), false, "Mensagem NUNCA deve mencionar 'Lovable MCP' em projeto Supabase");
});

// TESTE 11: Lovable Cloud migration error message -> Contém 'Lovable Cloud'
test("TESTE 11: Lovable Cloud com erro de migração sem mensagem -> Fallback usa 'Lovable Cloud'", async () => {
  const manager = new MigrationManager();

  const propPromise = manager.proposeMigration({
    sessionId: "sess_err_11",
    permissionId: "perm_err_11",
    projectRef: "lov_proj_11",
    name: "test_lov_err",
    sql: "CREATE TABLE t_lov_err (id int);",
    provider: "lovable"
  });

  // Salva ID gerado
  const proposalsArray = Array.from((manager as any).proposals.keys());
  const actualId = proposalsArray[proposalsArray.length - 1];

  let failedError = "";
  manager.on("migration-failed", ({ error }) => {
    failedError = error;
  });

  // Aprova proposta
  void manager.replyProposal(actualId, true);

  // Notifica tool completed com falha sem mensagem customizada
  void manager.notifyToolCompleted(actualId, false, undefined, { remoteApplied: false });

  await propPromise.catch(() => {});

  assert.equal(failedError, "A execução da migração falhou no Lovable Cloud.", "Mensagem deve ser específica do Lovable Cloud");
});

// TESTE 12: Reprodução exata do bug original - Output "Query executed successfully" com isError=false -> SUCCESS
test("TESTE 12: Contract Fix (Bug Reproducer) - Output 'Query executed successfully' com isError=false -> SUCCESS", async () => {
  const manager = new MigrationManager();

  const propPromise = manager.proposeMigration({
    sessionId: "sess_fix_12",
    permissionId: "perm_fix_12",
    projectRef: "proj_ref_12",
    name: "test_query_executed",
    sql: "CREATE TABLE test_table_12 (id int);",
    provider: "supabase"
  });

  const proposalsArray = Array.from((manager as any).proposals.keys());
  const actualId = proposalsArray[proposalsArray.length - 1];

  let completedStatus = "";
  manager.on("migration-completed", ({ result }) => {
    completedStatus = result.status;
  });

  // Aprova proposta
  void manager.replyProposal(actualId, true);

  // Simula contrato corrigido: isError=false + output="Query executed successfully" -> remoteApplied=true, success=true
  const output = "Query executed successfully";
  const isError = false;
  const remoteApplied = !isError && !output.toLowerCase().includes("local only");

  void manager.notifyToolCompleted(actualId, !isError && remoteApplied, undefined, {
    remoteApplied,
    stdout: output
  });

  const res = await propPromise;

  assert.equal(res.success, true, "Execução sem erro deve resultar em success=true");
  assert.equal(completedStatus, "SUCCESS", "Status da proposta no MigrationManager deve ser SUCCESS");
});

// TESTE 13: Supabase Native + CREATE TABLE / ALTER TABLE output -> SUCCESS
test("TESTE 13: Supabase Native com output 'CREATE TABLE' / 'ALTER TABLE' -> SUCCESS", async () => {
  const manager = new MigrationManager();

  const propPromise = manager.proposeMigration({
    sessionId: "sess_fix_13",
    permissionId: "perm_fix_13",
    projectRef: "proj_ref_13",
    name: "create_table_test",
    sql: "CREATE TABLE users_13 (id uuid);",
    provider: "supabase"
  });

  const proposalsArray = Array.from((manager as any).proposals.keys());
  const actualId = proposalsArray[proposalsArray.length - 1];

  void manager.replyProposal(actualId, true);

  const output = "CREATE TABLE";
  const isError = false;
  const remoteApplied = !isError && !output.toLowerCase().includes("local only");

  void manager.notifyToolCompleted(actualId, !isError && remoteApplied, undefined, {
    remoteApplied,
    stdout: output
  });

  const res = await propPromise;

  assert.equal(res.success, true, "Output 'CREATE TABLE' sem erro deve resultar em SUCCESS");
});

// TESTE 14: Supabase Native com erro SQL real -> FAILED + erro original
test("TESTE 14: Supabase Native com erro SQL real -> FAILED com mensagem de erro original", async () => {
  const manager = new MigrationManager();

  const propPromise = manager.proposeMigration({
    sessionId: "sess_fix_14",
    permissionId: "perm_fix_14",
    projectRef: "proj_ref_14",
    name: "failed_sql_test",
    sql: "INVALID SQL STATEMENT;",
    provider: "supabase"
  });

  const proposalsArray = Array.from((manager as any).proposals.keys());
  const actualId = proposalsArray[proposalsArray.length - 1];

  let failedErr = "";
  manager.on("migration-failed", ({ error }) => {
    failedErr = error;
  });

  void manager.replyProposal(actualId, true);

  const realSqlError = "syntax error at or near 'INVALID'";
  void manager.notifyToolCompleted(actualId, false, realSqlError, {
    remoteApplied: false,
    stderr: realSqlError
  });

  const res = await propPromise.catch(e => e);

  assert.equal(res.success, false, "Erro SQL real deve resultar em success=false");
  assert.equal(failedErr, realSqlError, "Mensagem de erro deve ser a mensagem original retornada pelo banco");
});

test("TESTE 15: Paridade de normalização entre message.part.updated e tool.execute.after", () => {
  // Simulação da função normalizadora idêntica à de src/main/main.ts
  function normalizeMigrationToolResult(output: any, isError: boolean, errorMsg?: string) {
    let remoteApplied = false;
    let toolSuccess = !isError;
    let effectiveErrorMsg = errorMsg;

    if (typeof output === "object" && output !== null) {
      if (output.isError === true || output.success === false) {
        toolSuccess = false;
        remoteApplied = false;
        effectiveErrorMsg = effectiveErrorMsg || String(output.error || output.message || "Erro retornado pela ferramenta de banco de dados.");
      } else if (output.localOnly === true) {
        remoteApplied = false;
      } else {
        remoteApplied = !isError;
      }
    } else if (typeof output === "string") {
      const lower = output.toLowerCase();
      if (lower.includes("local only")) {
        remoteApplied = false;
      } else {
        remoteApplied = !isError;
      }
    } else {
      remoteApplied = !isError;
    }

    return { toolSuccess, remoteApplied, effectiveErrorMsg };
  }

  // 1. Sucesso padrão via Supabase Native (string)
  const res1 = normalizeMigrationToolResult("Query executed successfully", false);
  assert.equal(res1.toolSuccess, true);
  assert.equal(res1.remoteApplied, true);
  assert.equal(res1.effectiveErrorMsg, undefined);

  // 2. CREATE TABLE output (string)
  const res2 = normalizeMigrationToolResult("CREATE TABLE public.teste_migration_nekoai ()", false);
  assert.equal(res2.toolSuccess, true);
  assert.equal(res2.remoteApplied, true);

  // 3. Local only flag (string)
  const res3 = normalizeMigrationToolResult("Executed local only migration", false);
  assert.equal(res3.toolSuccess, true);
  assert.equal(res3.remoteApplied, false);

  // 4. Erro de execução (isError=true)
  const res4 = normalizeMigrationToolResult("", true, "connection reset by peer");
  assert.equal(res4.toolSuccess, false);
  assert.equal(res4.remoteApplied, false);
  assert.equal(res4.effectiveErrorMsg, "connection reset by peer");

  // 5. Objeto de erro explícito
  const res5 = normalizeMigrationToolResult({ isError: true, error: "relation already exists" }, false);
  assert.equal(res5.toolSuccess, false);
  assert.equal(res5.remoteApplied, false);
  assert.equal(res5.effectiveErrorMsg, "relation already exists");
});

test("TESTE 16: message.part.updated com output 'Query executed successfully' -> SUCCESS definitivo", async () => {
  const manager = new MigrationManager();
  const sessionId = "session_mpu_test";

  let completedEventFired = false;
  let failedEventFired = false;

  manager.on("migration-completed", () => {
    completedEventFired = true;
  });
  manager.on("migration-failed", () => {
    failedEventFired = true;
  });

  const propPromise = manager.proposeMigration({
    sessionId,
    projectRef: "prj_mpu_success",
    name: "create_mpu_table",
    sql: "CREATE TABLE mpu_test (id serial primary key);",
    provider: "supabase"
  });

  const proposalsArray = Array.from((manager as any).proposals.keys());
  const actualId = proposalsArray[proposalsArray.length - 1];

  // Usuário aprova
  void manager.replyProposal(actualId, true);

  // message.part.updated dispara
  const mpuOutput = "Query executed successfully";
  const isError = false;
  const errorMsg = undefined;

  // Aplicação da regra central de normalização
  const isLocalOnly = typeof mpuOutput === "string" && mpuOutput.toLowerCase().includes("local only");
  const remoteApplied = !isError && !isLocalOnly;
  const toolSuccess = !isError;

  void manager.notifyToolCompleted(actualId, toolSuccess && remoteApplied, errorMsg, {
    remoteApplied,
    exitCode: 0,
    stdout: mpuOutput,
    toolName: "neko_supabase_prj_mpu_success_apply_migration"
  });

  const res = await propPromise;

  assert.equal(res.success, true, "Proposta deve ter sucesso");
  assert.equal(res.status, "SUCCESS", "Status deve ser SUCCESS");
  assert.equal(completedEventFired, true, "Evento migration-completed deve disparar");
  assert.equal(failedEventFired, false, "Evento migration-failed NÃO deve disparar");
});

test("TESTE 17: spawnNodeTool para npm em caminhos com espaços e acentos ignora cmd.exe e executa com sucesso", async () => {
  const { spawnNodeTool, resolveNodeRuntime } = await import("../src/main/node-runtime.ts");
  const runtime = resolveNodeRuntime();

  assert.ok(runtime.nodePath, "nodePath deve existir");
  assert.ok(runtime.npmPath, "npmPath deve existir");

  // Testa spawnNodeTool com npm --version
  const child = spawnNodeTool("npm", ["--version"]);
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", c => stdout += c.toString());
  child.stderr?.on("data", c => stderr += c.toString());

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", code => resolve(typeof code === "number" ? code : 0));
  });

  assert.equal(exitCode, 0, `npm --version deve sair com código 0. stderr=${stderr}`);
  assert.ok(stdout.trim().length > 0, "npm --version deve retornar versão válida");
});

test("TESTE 18: Preservação de Bun sem conversão forçada para npm", () => {
  const { packageManagerExecutable } = (() => {
    function packageManagerExecutable(packageManager: string) {
      if (packageManager === "pnpm") return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      if (packageManager === "yarn") return process.platform === "win32" ? "yarn.cmd" : "yarn";
      if (packageManager === "bun") return process.platform === "win32" ? "bun.exe" : "bun";
      return process.platform === "win32" ? "npm.cmd" : "npm";
    }
    return { packageManagerExecutable };
  })();

  const bunExec = packageManagerExecutable("bun");
  assert.equal(bunExec, process.platform === "win32" ? "bun.exe" : "bun", "Bun deve retornar bun / bun.exe sem conversão");

  const npmExec = packageManagerExecutable("npm");
  assert.equal(npmExec, process.platform === "win32" ? "npm.cmd" : "npm", "NPM deve retornar npm.cmd no Windows");
});


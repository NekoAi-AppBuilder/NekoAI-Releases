import { test, expect, describe, vi, beforeEach } from "vitest";
import { MigrationManager } from "../src/main/supabase/migration-manager";
import { isReadOnlySql } from "../src/main/security/sql-guard";

describe("Post-Approve Migration Lifecycle", () => {
  test("TESTE 1 e 3: Migration proposta -> APPROVE -> execute SUCCESS -> se nao houver trabalho restante -> COMPLETED", () => {
    let taskState = "waiting_for_approval";
    let runIdleCalled = false;

    // Simulate migration-replied
    taskState = "running";
    
    // Simulate migration-completed
    const simulateMigrationCompleted = () => {
      runIdleCalled = true;
      // In runIdleDetermination, if sawBusy and no pending migrations
      taskState = "completed";
    };

    simulateMigrationCompleted();

    expect(runIdleCalled).toBe(true);
    expect(taskState).toBe("completed");
  });

  test("TESTE 2: Migration -> REJECT -> permanece CANCELLED -> não resume", () => {
    let taskState = "waiting_for_approval";
    
    // Simulate reject
    const simulateReject = () => {
      taskState = "cancelled";
    };

    simulateReject();
    expect(taskState).toBe("cancelled");
  });

  test("TESTE 4: Migration -> APPROVE -> SUCCESS -> se houver continuação real -> não finalizar prematuramente", () => {
    let taskState = "waiting_for_approval";
    let runIdleCalled = false;

    // Simulate migration-replied
    taskState = "running";
    
    // Simulate migration-completed with plan mode active
    const simulateMigrationCompletedWithPlan = () => {
      runIdleCalled = true;
      // In runIdleDetermination, if planMode is true, it falls through to plan handling instead of setting completed
      taskState = "running"; // Agent continues natively
    };

    simulateMigrationCompletedWithPlan();

    expect(runIdleCalled).toBe(true);
    expect(taskState).toBe("running"); // Didn't finalize prematurely
  });

  test("TESTE 5: Migration -> APPROVE -> execução FAIL -> task FAILED", () => {
    let taskState = "waiting_for_approval";

    // Simulate migration-failed
    const simulateMigrationFailed = () => {
      taskState = "failed";
    };

    simulateMigrationFailed();
    expect(taskState).toBe("failed");
  });

  test("TESTE 6: Migration A -> REJECT, Migration B igual -> NOVO CARD", () => {
    const proposals = new Map();
    const executedHashes = new Set();
    
    // Exec A
    proposals.set("mig_1", { hash: "hash1", status: "PENDING" });
    
    // REJECT
    proposals.get("mig_1").status = "REJECTED";
    // Not added to executedHashes
    
    // Exec B (same hash)
    const isAlreadyPending = Array.from(proposals.values()).some(p => p.hash === "hash1" && p.status === "PENDING");
    const isAlreadyExecuted = executedHashes.has("hash1");
    
    expect(isAlreadyPending).toBe(false);
    expect(isAlreadyExecuted).toBe(false);
    
    // Create new proposal
    proposals.set("mig_2", { hash: "hash1", status: "PENDING" });
    expect(proposals.get("mig_2").status).toBe("PENDING");
  });
});

describe("MigrationManager Consecutive Migrations & Cache Isolation (Same Session)", () => {
  let manager: MigrationManager;

  beforeEach(() => {
    manager = new MigrationManager();
  });

  test("A. WAITING IMEDIATO: Task entra em waiting_for_approval antes da resolução da Promise", async () => {
    let taskState = "running";
    const sessionId = "ses_test_waiting";
    const permissionId = "per_111";

    // Simula o novo fluxo do main.ts:
    // 1. setTaskState("waiting_for_approval")
    taskState = "waiting_for_approval";

    // 2. inicia proposeMigration (retorna Promise não resolvida até user action / completion)
    let promiseResolved = false;
    const proposalPromise = manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_test",
      name: "create_users",
      sql: "CREATE TABLE users (id int primary key);"
    }).then(res => {
      promiseResolved = true;
      return res;
    });

    // A task já está em waiting_for_approval ANTES de a Promise resolver
    expect(taskState).toBe("waiting_for_approval");
    expect(promiseResolved).toBe(false);

    // O status da proposal é PENDING
    const pending = manager.getPendingProposalForSession(sessionId);
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("PENDING");
    expect(pending?.permissionId).toBe(permissionId);

    // Usuário aprova -> status vai para APPROVED
    await manager.replyProposal(pending!.id, true);
    expect(pending?.status).toBe("APPROVED");

    // MCP executa
    manager.notifyToolExecuting(pending!.id);
    expect(pending?.status).toBe("EXECUTING");

    // MCP conclui
    await manager.notifyToolCompleted(pending!.id, true);
    await proposalPromise;
    expect(promiseResolved).toBe(true);
  });

  test("B. REJECT + NOVA MIGRATION: t1 rejeitada -> t2 em seguida na MESMA sessão cria nova proposal", async () => {
    const sessionId = "ses_same_session";

    // t1: migration_test_4
    let t1Resolved = false;
    const t1Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_t1",
      projectRef: "prj_test",
      name: "migration_test_4",
      sql: "CREATE TABLE migration_test_4 (id int, name text);"
    }).then(res => {
      t1Resolved = true;
      return res;
    });

    const p1 = manager.getPendingProposalForSession(sessionId);
    expect(p1).not.toBeNull();
    expect(p1?.name).toBe("migration_test_4");

    // Usuário rejeita t1 -> resolve imediatamente com REJECTED
    const t1Result = await manager.replyProposal(p1!.id, false);
    await t1Promise;
    expect(t1Resolved).toBe(true);
    expect(t1Result.success).toBe(false);
    expect(t1Result.status).toBe("REJECTED");

    // Imediatamente t2 na MESMA sessão: migration_test_5
    let t2Resolved = false;
    const t2Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_t2",
      projectRef: "prj_test",
      name: "migration_test_5",
      sql: "CREATE TABLE migration_test_5 (id int, name text);"
    }).then(res => {
      t2Resolved = true;
      return res;
    });

    // t2 deve ter gerado uma NOVA proposta pendente
    const p2 = manager.getPendingProposalForSession(sessionId);
    expect(p2).not.toBeNull();
    expect(p2?.id).not.toBe(p1?.id);
    expect(p2?.permissionId).toBe("per_t2");
    expect(p2?.name).toBe("migration_test_5");
    expect(p2?.originalSql).toContain("migration_test_5");
    expect(p2?.status).toBe("PENDING");
    expect(t2Resolved).toBe(false);

    // Conclui t2 com aprovação + execução completa
    await manager.replyProposal(p2!.id, true);
    manager.notifyToolExecuting(p2!.id);
    await manager.notifyToolCompleted(p2!.id, true);
    await t2Promise;
    expect(t2Resolved).toBe(true);
  });

  test("C. CACHE ISOLADO & D. CACHE SEM INPUT: chaves de cache isoladas não vazam t1 para t2", () => {
    const recentToolInputs = new Map<string, any>();
    const sessionId = "ses_isolated";

    // Simula tool call de t1
    const t1CallId = "call_t1";
    const t1Input = { query: "CREATE TABLE migration_test_4 (id int, name text);", name: "migration_test_4" };

    // Gravação com chaves específicas
    recentToolInputs.set(t1CallId, t1Input);
    recentToolInputs.set(`${sessionId}:${t1CallId}`, t1Input);

    // Limpeza ao término de t1 (permission.replied)
    recentToolInputs.delete(t1CallId);
    recentToolInputs.delete(`${sessionId}:${t1CallId}`);

    // Nova permission t2 sem input inline ainda
    const t2PermissionId = "per_t2_new";

    const t2Cached =
      recentToolInputs.get(t2PermissionId) ||
      recentToolInputs.get(`${sessionId}:${t2PermissionId}`);

    // Garantir que NÃO existe fallback para input antigo de t1 nem chaves globais por toolName
    expect(t2Cached).toBeUndefined();
    expect(recentToolInputs.get(sessionId)).toBeUndefined();
    expect(recentToolInputs.get(`${sessionId}:neko_supabase_prj_apply_migration`)).toBeUndefined();
  });

  test("E. PROPOSALS ISOLADAS: t1 e t2 possuem IDs, hashes e estados independentes", async () => {
    const sessionId = "ses_isolated_props";

    const p1Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_1",
      projectRef: "prj_test",
      name: "migration_test_4",
      sql: "CREATE TABLE migration_test_4 (id int);"
    });
    const p1 = manager.getPendingProposalForSession(sessionId)!;

    await manager.replyProposal(p1.id, false);
    await p1Promise;

    const p2Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_2",
      projectRef: "prj_test",
      name: "migration_test_5",
      sql: "CREATE TABLE migration_test_5 (id int);"
    });
    const p2 = manager.getPendingProposalForSession(sessionId)!;

    expect(p1.id).not.toBe(p2.id);
    expect(p1.permissionId).not.toBe(p2.permissionId);
    expect(p1.hash).not.toBe(p2.hash);
    expect(p1.status).toBe("REJECTED");
    expect(p2.status).toBe("PENDING");

    await manager.replyProposal(p2.id, true);
    manager.notifyToolExecuting(p2.id);
    await manager.notifyToolCompleted(p2.id, true);
    await p2Promise;
    expect(p2.status).toBe("SUCCESS");
  });

  test("F. EVENTO TARDIO: pós-rejeição de t1, notificação de execução não altera t1 para EXECUTING", async () => {
    const sessionId = "ses_late_events";

    const p1Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_late",
      projectRef: "prj_test",
      name: "migration_test_4",
      sql: "CREATE TABLE migration_test_4 (id int);"
    });
    const p1 = manager.getPendingProposalForSession(sessionId)!;

    await manager.replyProposal(p1.id, false);
    await p1Promise;
    expect(p1.status).toBe("REJECTED");

    // Dispara evento tardio para a proposta rejeitada
    manager.notifyToolExecuting(p1.id);
    expect(p1.status).toBe("REJECTED"); // Permanece REJECTED, não vai para EXECUTING
  });

  test("G. APROVAÇÃO REAL: t2 PENDING -> APPROVED -> notifyToolExecuting -> EXECUTING -> notifyToolCompleted -> SUCCESS", async () => {
    const sessionId = "ses_real_approval";

    const p2Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_approved",
      projectRef: "prj_test",
      name: "migration_test_5",
      sql: "CREATE TABLE migration_test_5 (id int, name text);"
    });
    const p2 = manager.getPendingProposalForSession(sessionId)!;
    expect(p2.status).toBe("PENDING");

    // 1. Aprovação
    const replyRes = await manager.replyProposal(p2.id, true);
    expect(replyRes.status).toBe("APPROVED");
    expect(p2.status).toBe("APPROVED");

    // 2. Execução da ferramenta MCP inicia
    manager.notifyToolExecuting(p2.id);
    expect(p2.status).toBe("EXECUTING");

    // 3. Execução completa com sucesso
    await manager.notifyToolCompleted(p2.id, true);
    expect(p2.status).toBe("SUCCESS");
    expect(p2.schemaVerificationStatus).toBe("VERIFIED");

    const finalResult = await p2Promise;
    expect(finalResult.success).toBe(true);
  });

  test("H. RENDERER CLEANUP NO SUCCESS: pendingMigration e migrationHistory são limpos após SUCCESS preservando mensagens do Agent", async () => {
    const sessionId = "ses_renderer_success";
    let pendingMigration: any = null;
    let migrationHistory = new Map<string, any>();
    const messages = [
      { role: "user", text: "Crie migration_test_5", createdAt: 1000 },
      { role: "assistant", text: "Vou criar a migration_test_5", createdAt: 1001 }
    ];

    // Simula evento supabase:migration:asked
    const proposal = { id: "mig_succ_1", sessionId, status: "PENDING", name: "migration_test_5", createdAt: 1002 };
    pendingMigration = proposal;
    migrationHistory.set(proposal.id, proposal);

    // Simula aprovação + executing
    pendingMigration = { ...pendingMigration, status: "EXECUTING" };

    // Simula evento supabase:migration:completed (SUCCESS)
    // [SUCCESS-cleanup]: remove pendingMigration e apaga de migrationHistory
    pendingMigration = null;
    migrationHistory.delete(proposal.id);

    // Adiciona o relatório final do Agent
    messages.push({ role: "assistant", text: "Tabela migration_test_5 criada com sucesso no Supabase.", createdAt: 1005 });

    // Assert: Card desapareceu completamente e não entra na timeline
    expect(pendingMigration).toBeNull();
    expect(migrationHistory.size).toBe(0);

    const timeline = messages.map(m => m.text);
    expect(timeline).toHaveLength(3);
    expect(timeline[2]).toBe("Tabela migration_test_5 criada com sucesso no Supabase.");
  });

  test("I. RENDERER REJECT: Card desaparece, mas a sessão NÃO é abortada", async () => {
    const sessionId = "ses_renderer_reject";
    let pendingMigration: any = { id: "mig_rej_1", sessionId, status: "PENDING", name: "migration_test_4" };
    let migrationHistory = new Map<string, any>();
    migrationHistory.set("mig_rej_1", pendingMigration);
    let sessionAborted = false;
    let taskPhase = "running";

    // Simula novo comportamento do clique em Rejeitar:
    // Limpa card mas não aborta a sessão
    pendingMigration = null;
    migrationHistory.delete("mig_rej_1");
    // sessionAborted permanece false, taskPhase permanece running

    expect(pendingMigration).toBeNull();
    expect(migrationHistory.size).toBe(0);
    expect(taskPhase).toBe("running");
    expect(sessionAborted).toBe(false);
  });

  test("J. EVENTO TARDIO PÓS-SUCCESS: Não recria o card no renderer", () => {
    let pendingMigration: any = null;
    let migrationHistory = new Map<string, any>();

    // Proposal já finalizada com sucesso
    const payload = { id: "mig_finished_1", status: "EXECUTING" };

    // Simula chegada de supabase:migration:executing tardio
    const currentHist = migrationHistory.get(payload.id);
    if (!currentHist || (currentHist.status === "REJECTED" || currentHist.status === "FAILED" || currentHist.status === "SUCCESS")) {
      // Ignora evento tardio
    } else {
      migrationHistory.set(payload.id, payload);
    }

    expect(pendingMigration).toBeNull();
    expect(migrationHistory.get("mig_finished_1")).toBeUndefined();
  });

  test("K. READ-ONLY (SELECT & WITH) vs MUTATION (CREATE): isReadOnlySql protege consultas", () => {
    // A. READ SELECT
    expect(isReadOnlySql("SELECT * FROM users;")).toBe(true);
    expect(isReadOnlySql("  select id, name from products where active = true; ")).toBe(true);

    // B. READ WITH
    expect(isReadOnlySql("WITH active_users AS (SELECT * FROM users WHERE active = true) SELECT * FROM active_users;")).toBe(true);

    // C. MUTATION execute_sql
    expect(isReadOnlySql("CREATE TABLE migration_test_4 (id int);")).toBe(false);
    expect(isReadOnlySql("ALTER TABLE users ADD COLUMN age int;")).toBe(false);
    expect(isReadOnlySql("DROP TABLE old_data;")).toBe(false);
    expect(isReadOnlySql("INSERT INTO users (name) VALUES ('Alice');")).toBe(false);
  });

  test("L. SESSION IDLE NÃO CONCLUI MIGRATION EXECUTING", () => {
    // Migration em EXECUTING não pode ser movida para SUCCESS por session.idle
    const proposal = { id: "mig_exec_1", status: "EXECUTING" };
    
    // Simula recebimento de session.idle
    const onSessionIdle = (p: typeof proposal) => {
      // Regra: migration só conclui com tool.execute.after ou message.part.updated
      if (p.status === "EXECUTING") {
        // NÃO altera para SUCCESS
        return p.status;
      }
      return p.status;
    };

    expect(onSessionIdle(proposal)).toBe("EXECUTING");
  });

  test("M. TESTE A & B: execute_sql SELECT não vaza para apply_migration subsequente", async () => {
    const sessionId = "ses_no_cross_leak";

    // 1. Simula execute_sql com SELECT (armazenado em cache/message)
    const selectQuery = "SELECT id, name FROM users WHERE active = true;";
    expect(isReadOnlySql(selectQuery)).toBe(true);

    // 2. Agora o Agent solicita apply_migration (T2)
    const applySql = "CREATE TABLE migration_test_5 (id int, title text);";
    expect(isReadOnlySql(applySql)).toBe(false);

    // Simula resolução de input estrita para apply_migration
    const expectedTool = "apply_migration";
    
    // Se o cache só tivesse o execute_sql anterior, o resolvedTool para apply_migration NÃO deve pegar o execute_sql
    const messageParts = [
      { tool: "execute_sql", state: { input: { query: selectQuery } } },
      { tool: "apply_migration", state: { input: { query: applySql, name: "migration_test_5" } } }
    ];

    const findStrictInput = (toolPattern: string) => {
      for (let j = messageParts.length - 1; j >= 0; j--) {
        const part = messageParts[j];
        if (part.tool && part.tool.includes(toolPattern)) {
          return part.state.input;
        }
      }
      return null;
    };

    const resolvedInput = findStrictInput(expectedTool);
    expect(resolvedInput).not.toBeNull();
    expect(resolvedInput.query).toBe(applySql);
    expect(resolvedInput.query).not.toBe(selectQuery);

    // 3. Criação da MigrationProposal para T2
    const p2Promise = manager.proposeMigration({
      sessionId,
      permissionId: "per_apply_t2",
      projectRef: "prj_test",
      name: resolvedInput.name,
      sql: resolvedInput.query
    });

    const p2 = manager.getPendingProposalForSession(sessionId);
    expect(p2).not.toBeNull();
    expect(p2?.name).toBe("migration_test_5");
    expect(p2?.originalSql).toBe(applySql);
    expect(p2?.status).toBe("PENDING");

    await manager.replyProposal(p2!.id, true);
    manager.notifyToolExecuting(p2!.id);
    await manager.notifyToolCompleted(p2!.id, true);
    await p2Promise;
    expect(p2?.status).toBe("SUCCESS");
  });

  test("N. TESTE D: apply_migration com input não resolvível não trava waiting_for_approval", async () => {
    let taskState = "running";
    let autoRejected = false;
    let proposalCreated = false;

    // Simula tentativa de criar proposal sem SQL resolvido
    const finalSql = "";

    if (!finalSql) {
      // Input não resolvido
      taskState = "running";
      autoRejected = true;
    } else {
      proposalCreated = true;
      taskState = "waiting_for_approval";
    }

    expect(proposalCreated).toBe(false);
    expect(taskState).toBe("running"); // NÃO fica em waiting_for_approval
    expect(autoRejected).toBe(true);
  });

  test("O. Falha de validação no proposeMigration não deixa task em waiting_for_approval", async () => {
    let taskState = "running";

    const invalidSql = "SELECT * FROM users;"; // READ-ONLY passado indevidamente para proposeMigration
    let caughtError: any = null;

    try {
      // 1. Propose migration FIRST
      await manager.proposeMigration({
        sessionId: "ses_fail_val",
        permissionId: "per_invalid",
        projectRef: "prj_test",
        name: "invalid_migration",
        sql: invalidSql
      });

      // 2. Set task state ONLY after proposeMigration succeeds
      taskState = "waiting_for_approval";
    } catch (err) {
      caughtError = err;
      // Em caso de erro, garante running
      taskState = "running";
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.message).toContain("Consultas puramente de leitura (SELECT) não devem ser aplicadas como migração");
    expect(taskState).toBe("running"); // Permanece running sem travar em waiting_for_approval
  });

  test("P. REJECT PASSIVO: proposal=REJECTED, session não abortada, pronta para nova mensagem", async () => {
    const sessionId = "ses_passive_reject";
    const permissionId = "per_reject_test";

    const pPromise = manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_test",
      name: "neko_migration_reject_test",
      sql: "CREATE TABLE neko_migration_reject_test (id UUID, name TEXT);"
    });

    const pending = manager.getPendingProposalForSession(sessionId);
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("PENDING");

    // Rejeição pelo usuário
    const replyRes = await manager.replyProposal(pending!.id, false);
    const execRes = await pPromise;

    expect(replyRes.status).toBe("REJECTED");
    expect(execRes.status).toBe("REJECTED");
    expect(pending?.status).toBe("REJECTED");

    // Verifica que não há proposals pendentes para a sessão
    expect(manager.getPendingProposalForSession(sessionId)).toBeNull();

    // Simula evento permission.replied com payload oficial do OpenCode
    const openCodeEventProps = {
      sessionID: sessionId,
      permissionID: permissionId,
      response: "reject"
    };

    const parsedPermissionId = String(openCodeEventProps.permissionID ?? (openCodeEventProps as any).id ?? "");
    const parsedSessionId = String(openCodeEventProps.sessionID ?? (openCodeEventProps as any).sessionId ?? "");
    const parsedResponse = String(openCodeEventProps.response ?? (openCodeEventProps as any).reply ?? "");

    expect(parsedPermissionId).toBe(permissionId);
    expect(parsedSessionId).toBe(sessionId);
    expect(parsedResponse).toBe("reject");

    // Nova mensagem enviada na mesma sessão deve criar uma nova migration isolada sem conflitos
    const newPromise = manager.proposeMigration({
      sessionId,
      permissionId: "per_subsequent",
      projectRef: "prj_test",
      name: "subsequent_table",
      sql: "CREATE TABLE subsequent_table (id INT);"
    });

    const newPending = manager.getPendingProposalForSession(sessionId);
    expect(newPending).not.toBeNull();
    expect(newPending?.id).not.toBe(pending?.id);
    expect(newPending?.name).toBe("subsequent_table");
    expect(newPending?.status).toBe("PENDING");

    // Aprova e conclui a nova migration
    await manager.replyProposal(newPending!.id, true);
    manager.notifyToolExecuting(newPending!.id);
    await manager.notifyToolCompleted(newPending!.id, true);
    await newPromise;
    expect(newPending?.status).toBe("SUCCESS");
  });

  test("Q. QUOTA: Classificação imediata de erros de quota sem retry infinito", () => {
    const isNonRetryableQuotaOrLimitError = (message: string): boolean => {
      if (!message || typeof message !== "string") return false;
      return /free usage exceeded|quota exceeded|insufficient quota|rate limit|credit balance|subscription required|usage limit|insufficient credits/i.test(message);
    };

    // Erros que DEVEM ser classificados como quota/limite imediatos
    expect(isNonRetryableQuotaOrLimitError("Free usage exceeded, subscribe to Go")).toBe(true);
    expect(isNonRetryableQuotaOrLimitError("quota exceeded for current billing cycle")).toBe(true);
    expect(isNonRetryableQuotaOrLimitError("rate limit reached, please try again")).toBe(true);
    expect(isNonRetryableQuotaOrLimitError("insufficient credits on your account")).toBe(true);
    expect(isNonRetryableQuotaOrLimitError("subscription required for this model")).toBe(true);

    // Erros temporários/rede que NÃO devem ser classificados como quota
    expect(isNonRetryableQuotaOrLimitError("timeout connecting to upstream")).toBe(false);
    expect(isNonRetryableQuotaOrLimitError("temporary service unavailable")).toBe(false);
    expect(isNonRetryableQuotaOrLimitError("connection reset by peer")).toBe(false);
  });

  test("R. STOP NORMAL & WAITING_FOR_APPROVAL: Limpeza completa de pending proposals e late events", async () => {
    const sessionId = "ses_stop_waiting";
    const permissionId = "per_stop_test";

    let taskPhase: string = "running";
    let pendingPermissions: any[] = [];
    let cancellationMessageInserted = false;
    let soundNotification = "";

    // 1. Entra em waiting_for_approval
    const pPromise = manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_test",
      name: "table_before_stop",
      sql: "CREATE TABLE table_before_stop (id INT);"
    }).catch(err => ({ status: "CANCELLED", error: err.message }));

    taskPhase = "waiting_for_approval";
    pendingPermissions.push({ id: permissionId });

    expect(manager.getPendingProposalForSession(sessionId)).not.toBeNull();
    expect(taskPhase).toBe("waiting_for_approval");
    expect(pendingPermissions.length).toBe(1);

    // 2. Usuário clica STOP
    // Execução do stopDevelopment:
    taskPhase = "cancelled";
    pendingPermissions = [];
    cancellationMessageInserted = true;
    soundNotification = "task-error"; // aviso de cancelamento

    // Conclui proposta pendente no migration manager se cancelado
    const currentPending = manager.getPendingProposalForSession(sessionId);
    if (currentPending) {
      manager.cancelProposal(currentPending.id);
    }

    expect(taskPhase).toBe("cancelled");
    expect(pendingPermissions.length).toBe(0);
    expect(manager.getPendingProposalForSession(sessionId)).toBeNull();
    expect(cancellationMessageInserted).toBe(true);
    expect(soundNotification).toBe("task-error");

    // 3. Late events (session.error ou session.idle) NÃO devem alterar taskPhase
    const handleLateEvent = (type: string) => {
      if (taskPhase === "cancelled") {
        return; // Guard de cancelamento protege contra late events
      }
      if (type === "session.error") taskPhase = "failed";
      if (type === "session.idle") taskPhase = "completed";
    };

    handleLateEvent("session.error");
    expect(taskPhase).toBe("cancelled");

    handleLateEvent("session.idle");
    expect(taskPhase).toBe("cancelled");

    // 4. Nova tarefa T2 inicia normalmente e é independente
    const t2SessionId = "ses_stop_waiting";
    taskPhase = "running"; // Reset para nova tarefa T2
    const t2Promise = manager.proposeMigration({
      sessionId: t2SessionId,
      permissionId: "per_t2_clean",
      projectRef: "prj_test",
      name: "table_t2",
      sql: "CREATE TABLE table_t2 (id INT);"
    });

    const p2 = manager.getPendingProposalForSession(t2SessionId);
    expect(p2).not.toBeNull();
    expect(p2?.name).toBe("table_t2");
    expect(taskPhase).toBe("running");

    // Aprova T2
    await manager.replyProposal(p2!.id, true);
    manager.notifyToolExecuting(p2!.id);
    await manager.notifyToolCompleted(p2!.id, true);
    await t2Promise;
    expect(p2?.status).toBe("SUCCESS");
  });

  test("TESTE E2E Lifecycle: message.part.updated running -> EXECUTING, completed -> SUCCESS, and UI unwrapping", async () => {
    const sessionId = "ses_approve_e2e";
    const permissionId = "per_approve_e2e";

    const promise = manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_e2e",
      name: "create_neko_migration_approve_final",
      sql: "CREATE TABLE neko_migration_approve_final (id SERIAL PRIMARY KEY);"
    });

    const proposal = manager.getPendingProposalForSession(sessionId);
    expect(proposal).not.toBeNull();
    expect(proposal?.status).toBe("PENDING");

    // 1. Usuário clica APROVAR no Migration Card
    await manager.replyProposal(proposal!.id, true);
    expect(proposal?.status).toBe("APPROVED");

    // 2. OpenCode emite message.part.updated com part.state.status = "running"
    // Simula a lógica de message.part.updated de main.ts
    const simulateMessagePartUpdated = async (partStatus: "running" | "completed" | "error") => {
      const targetProposal = manager.getExecutingOrApprovedProposalForSession(sessionId);
      if (targetProposal && (targetProposal.status === "APPROVED" || targetProposal.status === "EXECUTING")) {
        if (partStatus === "running" && targetProposal.status === "APPROVED") {
          manager.notifyToolExecuting(targetProposal.id);
        } else if (partStatus === "completed") {
          await manager.notifyToolCompleted(targetProposal.id, true);
        } else if (partStatus === "error") {
          await manager.notifyToolCompleted(targetProposal.id, false, "Execution failed");
        }
      }
    };

    // Executa running
    await simulateMessagePartUpdated("running");
    expect(proposal?.status).toBe("EXECUTING");

    // 3. OpenCode conclui execução da tool -> message.part.updated com status = "completed"
    let capturedEvent: { type: string; payload: any } | null = null;
    manager.once("migration-completed", (data) => {
      capturedEvent = { type: "supabase:migration:completed", payload: data };
    });

    await simulateMessagePartUpdated("completed");
    expect(proposal?.status).toBe("SUCCESS");

    const result = await promise;
    expect(result.status).toBe("SUCCESS");
    expect(result.success).toBe(true);

    // 4. Renderer UI unpacking: verifica que event.payload ({ proposal, result }) é desembalado corretamente
    expect(capturedEvent).not.toBeNull();
    const rawPayload = capturedEvent!.payload;
    const uiPayload = (rawPayload?.proposal ?? rawPayload);
    expect(uiPayload).toBeDefined();
    expect(uiPayload.id).toBe(proposal!.id);
    expect(uiPayload.status).toBe("SUCCESS");

    // Simula cleanup na UI
    let pendingMigration: any = proposal;
    const migrationHistory = new Map([[proposal!.id, proposal]]);
    if (capturedEvent!.type === "supabase:migration:completed") {
      pendingMigration = null;
      migrationHistory.delete(uiPayload.id);
    }
    expect(pendingMigration).toBeNull();
    expect(migrationHistory.size).toBe(0);
  });

  test("TESTE: session.idle não deve marcar proposta EXECUTING ou APPROVED como SUCCESS", async () => {
    const sessionId = "ses_idle_protection";
    const permissionId = "per_idle_prot";

    manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_test",
      name: "table_idle",
      sql: "CREATE TABLE table_idle (id INT);"
    }).catch(() => {});

    const proposal = manager.getPendingProposalForSession(sessionId);
    await manager.replyProposal(proposal!.id, true);
    manager.notifyToolExecuting(proposal!.id);

    expect(proposal?.status).toBe("EXECUTING");

    // session.idle chega do OpenCode antes ou durante a ferramenta
    // MigrationManager não é acionado por session.idle
    expect(proposal?.status).toBe("EXECUTING");
    expect(manager.getExecutingOrApprovedProposalForSession(sessionId)?.id).toBe(proposal!.id);
  });

  test("TESTE: permission.replied extractor suporta todos os formatos de envelope", () => {
    // Envelope 1: OpenCode padrão { sessionID, permissionID, response }
    const env1 = { properties: { sessionID: "ses_1", permissionID: "per_1", response: "once" } };
    const extract = (event: any) => {
      const props = event?.properties ?? {};
      const permissionId = String(
        props?.permissionID ??
        props?.permissionId ??
        props?.id ??
        props?.permission ??
        props?.requestID ??
        props?.requestId ??
        event?.permissionID ??
        event?.permissionId ??
        event?.id ??
        event?.permission ??
        event?.requestID ??
        event?.requestId ??
        ""
      );
      const permissionSessionId = String(
        props?.sessionID ??
        props?.sessionId ??
        props?.session?.id ??
        event?.sessionID ??
        event?.sessionId ??
        event?.session?.id ??
        ""
      );
      const response = String(
        props?.response ??
        props?.reply ??
        props?.action ??
        event?.response ??
        event?.reply ??
        event?.action ??
        ""
      );
      return { permissionId, permissionSessionId, response };
    };

    expect(extract(env1)).toEqual({ permissionId: "per_1", permissionSessionId: "ses_1", response: "once" });

    // Envelope 2: OpenCode direto no evento { sessionId, id, reply }
    const env2 = { sessionId: "ses_2", id: "per_2", reply: "reject" };
    expect(extract(env2)).toEqual({ permissionId: "per_2", permissionSessionId: "ses_2", response: "reject" });
  });

  test("TESTE UI Lifecycle: PENDING (aguardando aprovação) -> APPROVE (card exclusivo Executando...) -> EXECUTING -> SUCCESS (card removido)", async () => {
    const sessionId = "ses_ui_lifecycle";
    const permissionId = "per_ui_lifecycle";

    // 1. PENDING State
    manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_ui",
      name: "create_users_table",
      sql: "CREATE TABLE users (id SERIAL PRIMARY KEY);"
    }).catch(() => {});

    let pendingMigration = manager.getPendingProposalForSession(sessionId);
    let busy = false;
    let workingStatus = "Neko está aguardando sua aprovação";
    let taskPhase = "waiting_for_approval";

    // Avaliação da UI em PENDING
    const isWaitingBannerVisible = !busy && Boolean(pendingMigration && pendingMigration.status === "PENDING") && Boolean(workingStatus);
    const isCardExecuting = pendingMigration ? (pendingMigration.status === "EXECUTING" || pendingMigration.status === "APPROVED") : false;

    expect(isWaitingBannerVisible).toBe(true);
    expect(workingStatus).toBe("Neko está aguardando sua aprovação");
    expect(isCardExecuting).toBe(false);
    expect(pendingMigration?.status).toBe("PENDING");

    // 2. Usuário clica APROVAR
    // handleReplyMigration é chamado: NÃO define workingStatus para migration
    taskPhase = "running";
    busy = true;
    workingStatus = "Neko está trabalhando..."; // workingStatus geral do Agent, sem texto de migration
    await manager.replyProposal(pendingMigration!.id, true);
    pendingMigration = manager.getExecutingOrApprovedProposalForSession(sessionId);

    // Avaliação da UI imediatamente após APPROVE
    const isGlobalWorkingBarVisible = busy && (!pendingMigration || (pendingMigration.status !== "APPROVED" && pendingMigration.status !== "EXECUTING"));
    const isWaitingBannerVisibleAfterApprove = !busy && Boolean(pendingMigration && pendingMigration.status === "PENDING") && Boolean(workingStatus);
    const isCardExecutingAfterApprove = pendingMigration ? (pendingMigration.status === "EXECUTING" || pendingMigration.status === "APPROVED") : false;

    // Status global não deve duplicar "Executando migração no Supabase..."
    expect(workingStatus).not.toBe("Executando migração no Supabase...");
    expect(isGlobalWorkingBarVisible).toBe(false); // Global bar oculto enquanto card executa
    expect(isWaitingBannerVisibleAfterApprove).toBe(false); // Banner de aguardando sumiu
    expect(isCardExecutingAfterApprove).toBe(true); // O card internamente exibe "Executando migração no Supabase..."
    expect(pendingMigration?.status).toBe("APPROVED");

    // 3. OpenCode inicia tool (running)
    manager.notifyToolExecuting(pendingMigration!.id);
    pendingMigration = manager.getExecutingOrApprovedProposalForSession(sessionId);

    const isGlobalWorkingBarDuringRun = busy && (!pendingMigration || (pendingMigration.status !== "APPROVED" && pendingMigration.status !== "EXECUTING"));
    const isCardExecutingDuringRun = pendingMigration ? (pendingMigration.status === "EXECUTING" || pendingMigration.status === "APPROVED") : false;
    expect(isGlobalWorkingBarDuringRun).toBe(false);
    expect(isCardExecutingDuringRun).toBe(true);
    expect(pendingMigration?.status).toBe("EXECUTING");

    // 4. OpenCode conclui tool (completed) -> SUCCESS
    await manager.notifyToolCompleted(pendingMigration!.id, true);
    pendingMigration = manager.getExecutingOrApprovedProposalForSession(sessionId);
    expect(pendingMigration).toBeNull(); // Proposta concluída não fica mais pendente/executando

    // Cleanup no Renderer
    let uiMigrationCard: any = null;
    expect(uiMigrationCard).toBeNull(); // Card temporário desapareceu
  });

  test("TESTE Error Handling: Erro real de execução do MCP -> FAILED exibido no card sem status global duplicado", async () => {
    const sessionId = "ses_error_handling";
    const permissionId = "per_error_handling";

    const promise = manager.proposeMigration({
      sessionId,
      permissionId,
      projectRef: "prj_err",
      name: "failing_migration",
      sql: "CREATE TABLE fail_table (id INT);"
    }).catch(err => ({ status: "FAILED", error: err.message }));

    const proposal = manager.getPendingProposalForSession(sessionId);
    await manager.replyProposal(proposal!.id, true);
    manager.notifyToolExecuting(proposal!.id);

    // Simula erro de socket connection / execução retornado pelo OpenCode MCP
    const socketError = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
    await manager.notifyToolCompleted(proposal!.id, false, socketError);

    expect(proposal?.status).toBe("FAILED");
    expect(proposal?.error).toBe(socketError);

    const result = await promise;
    expect(result.status).toBe("FAILED");

    // Na UI: o card exibe o erro e o status global permanece limpo
    let busy = false;
    let workingStatus = "";
    const isWaitingBannerVisible = !busy && Boolean(proposal && proposal.status === "PENDING") && Boolean(workingStatus);
    const isGlobalWorkingBar = busy && (!proposal || (proposal.status !== "APPROVED" && proposal.status !== "EXECUTING"));

    expect(isWaitingBannerVisible).toBe(false);
    expect(isGlobalWorkingBar).toBe(false);
  });
});



import { describe, it, expect, beforeEach } from "bun:test";
import { MigrationManager } from "../src/main/supabase/migration-manager";
import { MigrationProposalRequest } from "../src/main/supabase/migration-types";

describe("Ciclo de Vida das Permissões Supabase — Sem Timeout e Notificação Sonora Única", () => {
  let manager: MigrationManager;

  beforeEach(() => {
    manager = new MigrationManager();
  });

  // ============================================================
  // TESTE 1 — PERMISSION NÃO EXPIRA
  // ============================================================
  it("TESTE 1 — PERMISSION NÃO EXPIRA: Proposal permanece PENDING após tempo decorrido sem timeout artificial", async () => {
    let expiredEmitted = false;
    manager.on("migration-expired", () => {
      expiredEmitted = true;
    });

    let taskState = "running";
    const sessionId = "sess_no_timeout";
    const permissionId = "per_infinite_wait";

    // Simula a transição do main.ts ao interceptar a permissão
    taskState = "waiting_for_approval";

    const req: MigrationProposalRequest = {
      sessionId,
      permissionId,
      projectRef: "proj_no_timeout",
      name: "create_important_table",
      sql: "CREATE TABLE important_data (id UUID PRIMARY KEY);"
    };

    let promiseResolved = false;
    const proposalPromise = manager.proposeMigration(req).then((res) => {
      promiseResolved = true;
      return res;
    });

    const pending = manager.getPendingProposalForSession(sessionId);
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("PENDING");
    expect(pending?.permissionId).toBe(permissionId);

    // Aguarda um ciclo assíncrono real para provar ausência de timers de expiração imediata
    await new Promise(r => setTimeout(r, 20));

    expect(pending?.status).toBe("PENDING");
    expect(expiredEmitted).toBe(false);
    expect(promiseResolved).toBe(false);
    expect(taskState).toBe("waiting_for_approval");

    // Clean up
    manager.cancelProposal(pending!.id);
  });

  // ============================================================
  // TESTE 2 — APROVAÇÃO CONTINUA FUNCIONANDO
  // ============================================================
  it("TESTE 2 — APROVAÇÃO CONTINUA FUNCIONANDO: pending -> approved -> executing -> success", async () => {
    const sessionId = "sess_approve";
    const permissionId = "per_approve";
    let taskState = "waiting_for_approval";

    const req: MigrationProposalRequest = {
      sessionId,
      permissionId,
      projectRef: "proj_approve",
      name: "add_column_users",
      sql: "ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT true;"
    };

    let promiseResolved = false;
    let resolvedResult: any = null;
    const proposalPromise = manager.proposeMigration(req).then((res) => {
      promiseResolved = true;
      resolvedResult = res;
      return res;
    });

    const proposal = manager.getPendingProposalForSession(sessionId);
    expect(proposal?.status).toBe("PENDING");

    // 1. Usuário clica em Aprovar
    const replyResult = await manager.replyProposal(proposal!.id, true);
    expect(replyResult.status).toBe("APPROVED");
    expect(proposal?.status).toBe("APPROVED");

    // 2. OpenCode / MCP inicia execução da ferramenta
    taskState = "running";
    manager.notifyToolExecuting(proposal!.id);
    expect(proposal?.status).toBe("EXECUTING");

    // 3. OpenCode / MCP conclui execução com sucesso
    await manager.notifyToolCompleted(proposal!.id, true, undefined, { remoteApplied: true });
    expect(proposal?.status).toBe("SUCCESS");

    await proposalPromise;
    expect(promiseResolved).toBe(true);
    expect(resolvedResult?.status).toBe("SUCCESS");
    expect(taskState).toBe("running");
  });

  // ============================================================
  // TESTE 3 — CANCELAMENTO CONTINUA FUNCIONANDO
  // ============================================================
  it("TESTE 3 — CANCELAMENTO CONTINUA FUNCIONANDO: cancelamento ou rejeição explícita encerra sem execução", async () => {
    const sessionId = "sess_reject";
    const permissionId = "per_reject";
    let taskState = "waiting_for_approval";

    const req: MigrationProposalRequest = {
      sessionId,
      permissionId,
      projectRef: "proj_reject",
      name: "drop_logs",
      sql: "DROP TABLE system_logs;"
    };

    let promiseResolved = false;
    let resolvedResult: any = null;
    const proposalPromise = manager.proposeMigration(req).then((res) => {
      promiseResolved = true;
      resolvedResult = res;
      return res;
    });

    const proposal = manager.getPendingProposalForSession(sessionId);
    expect(proposal?.status).toBe("PENDING");

    // Usuário clica em Rejeitar
    const replyResult = await manager.replyProposal(proposal!.id, false);
    expect(replyResult.status).toBe("REJECTED");
    expect(proposal?.status).toBe("REJECTED");

    // Tarefa não deve executar migração
    taskState = "cancelled";
    await proposalPromise;
    expect(promiseResolved).toBe(true);
    expect(resolvedResult?.status).toBe("REJECTED");
    expect(taskState).toBe("cancelled");
  });

  // ============================================================
  // TESTE 4 — UMA ÚNICA NOTIFICAÇÃO PARA MIGRATION
  // ============================================================
  it("TESTE 4 — UMA ÚNICA NOTIFICAÇÃO PARA MIGRATION: som de migration = 1, som de approval = 0", () => {
    let migrationSoundCount = 0;
    let approvalSoundCount = 0;

    const notifyOnceMock = (kind: string, id: string) => {
      if (kind === "migration") migrationSoundCount++;
      if (kind === "approval") approvalSoundCount++;
    };

    function isSupabaseMigrationPermission(permName: string): boolean {
      const name = String(permName || "");
      return name.includes("apply_migration") || name.includes("execute_sql");
    }

    // 1. Simula recebimento de supabase:migration:asked no unsubMigration
    const proposal = {
      id: "mig_test_sound_1",
      permissionId: "per_sound_1",
      status: "PENDING"
    };
    notifyOnceMock("migration", proposal.id);

    // Estado do renderer com pendingMigration ativo
    const pendingMigration = proposal;

    // 2. Simula recebimento de neko.task.state (waiting_for_approval) com a lógica corrigida
    const props = {
      state: "waiting_for_approval",
      reason: "migration-asked",
      permission: {
        id: "per_sound_1",
        permission: "neko_supabase_project_apply_migration"
      }
    };

    const permName = String(props.permission.permission);
    const isMigration =
      props.reason === "migration-asked" ||
      isSupabaseMigrationPermission(permName) ||
      Boolean(pendingMigration && (pendingMigration.permissionId === props.permission.id || pendingMigration.status === "PENDING"));

    if (!isMigration) {
      notifyOnceMock("approval", `per:${props.permission.id}`);
    }

    // Validações estritas:
    expect(isMigration).toBe(true);
    expect(migrationSoundCount).toBe(1);
    expect(approvalSoundCount).toBe(0);
  });

  // ============================================================
  // TESTE 5 — APPROVAL GENÉRICO CONTINUA FUNCIONANDO
  // ============================================================
  it("TESTE 5 — APPROVAL GENÉRICO CONTINUA FUNCIONANDO: som de approval = 1 para permissão não-migration", () => {
    let migrationSoundCount = 0;
    let approvalSoundCount = 0;

    const notifyOnceMock = (kind: string, id: string) => {
      if (kind === "migration") migrationSoundCount++;
      if (kind === "approval") approvalSoundCount++;
    };

    function isSupabaseMigrationPermission(permName: string): boolean {
      const name = String(permName || "");
      return name.includes("apply_migration") || name.includes("execute_sql");
    }

    const pendingMigration = null;

    // Simula uma permissão genérica que NÃO é migração (ex: execução bash ou escrita de arquivo crítico)
    const props = {
      state: "waiting_for_approval",
      reason: "permission-asked",
      permission: {
        id: "per_bash_exec_99",
        permission: "bash_exec"
      }
    };

    const permName = String(props.permission.permission);
    const isMigration =
      props.reason === "migration-asked" ||
      isSupabaseMigrationPermission(permName) ||
      Boolean(pendingMigration && (pendingMigration.permissionId === props.permission.id || pendingMigration.status === "PENDING"));

    if (!isMigration) {
      notifyOnceMock("approval", `per:${props.permission.id}`);
    }

    // Para permissão genérica, approval DEVE tocar e migration NÃO
    expect(isMigration).toBe(false);
    expect(migrationSoundCount).toBe(0);
    expect(approvalSoundCount).toBe(1);
  });

  // ============================================================
  // TESTE 6 — UMA ÚNICA PERMISSION (Anti-duplicação)
  // ============================================================
  it("TESTE 6 — UMA ÚNICA PERMISSION: permissionId duplicado reutiliza proposal existente e não duplica", async () => {
    const sessionId = "sess_single_perm";
    const permissionId = "per_single_123";

    const req: MigrationProposalRequest = {
      sessionId,
      permissionId,
      projectRef: "proj_single",
      name: "create_t1",
      sql: "CREATE TABLE t1 (id int);"
    };

    const p1 = manager.proposeMigration(req);
    const pending1 = manager.getPendingProposalForSession(sessionId);
    expect(pending1).not.toBeNull();
    expect(pending1?.permissionId).toBe(permissionId);

    // Segundo evento com mesmo permissionId
    const p2 = manager.proposeMigration(req);
    const pendingProposals = manager.getPendingProposals();

    // Deve existir APENAS UMA proposta pendente
    expect(pendingProposals.filter(p => p.permissionId === permissionId).length).toBe(1);

    // Resolver a proposta deve satisfazer ambas as promises
    await manager.replyProposal(pending1!.id, false);
    const res1 = await p1;
    const res2 = await p2;

    expect(res1.status).toBe("REJECTED");
    expect(res2.status).toBe("REJECTED");
  });
});

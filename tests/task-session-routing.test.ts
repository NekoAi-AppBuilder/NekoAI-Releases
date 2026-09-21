import { describe, it, expect, beforeEach } from "vitest";
import {
  sessionParentMap,
  registerSessionParent,
  resolveRootSessionId,
  clearSessionTree
} from "../src/main/session-tree";

describe("Deterministic Session Hierarchy & Routing", () => {
  const taskRecords = new Map<string, { taskId: string; state: string }>();

  function resolveTaskId(sessionId: string): string {
    const direct = taskRecords.get(sessionId);
    if (direct?.taskId) return direct.taskId;
    const rootId = resolveRootSessionId(sessionId, (sid) => taskRecords.has(sid));
    if (rootId) {
      return taskRecords.get(rootId)?.taskId ?? "";
    }
    return "";
  }

  function resolvePermissionDetails(sessionId: string) {
    const isDirectRoot = Boolean(sessionId && taskRecords.has(sessionId));
    const rootSessionId = isDirectRoot ? sessionId : resolveRootSessionId(sessionId, (sid) => taskRecords.has(sid));
    const record = rootSessionId ? taskRecords.get(rootSessionId) : undefined;
    const resolvedTaskId = record?.taskId ?? resolveTaskId(sessionId);
    const relation = isDirectRoot ? "root" : (record ? "child" : "unknown");
    return { isDirectRoot, rootSessionId, record, resolvedTaskId, relation };
  }

  beforeEach(() => {
    clearSessionTree();
    taskRecords.clear();
  });

  it("1. Root session: resolve diretamente para si mesma e para sua task", () => {
    taskRecords.set("ses_root_1", { taskId: "t1", state: "running" });

    const rootId = resolveRootSessionId("ses_root_1", (sid) => taskRecords.has(sid));
    const taskId = resolveTaskId("ses_root_1");
    const perm = resolvePermissionDetails("ses_root_1");

    expect(rootId).toBe("ses_root_1");
    expect(taskId).toBe("t1");
    expect(perm.relation).toBe("root");
    expect(perm.rootSessionId).toBe("ses_root_1");
    expect(perm.resolvedTaskId).toBe("t1");
  });

  it("2. Child direto: resolve deterministicamente para a sessao raiz e task raiz", () => {
    taskRecords.set("ses_root_1", { taskId: "t1", state: "running" });
    registerSessionParent("ses_child_1", "ses_root_1");

    const rootId = resolveRootSessionId("ses_child_1", (sid) => taskRecords.has(sid));
    const taskId = resolveTaskId("ses_child_1");
    const perm = resolvePermissionDetails("ses_child_1");

    expect(rootId).toBe("ses_root_1");
    expect(taskId).toBe("t1");
    expect(perm.relation).toBe("child");
    expect(perm.rootSessionId).toBe("ses_root_1");
    expect(perm.resolvedTaskId).toBe("t1");
  });

  it("3. Child de segundo nivel (grandchild: C2 -> C1 -> Root): sobe a arvore ate a raiz", () => {
    taskRecords.set("ses_root_1", { taskId: "t1", state: "running" });
    registerSessionParent("ses_child_1", "ses_root_1");
    registerSessionParent("ses_child_2", "ses_child_1");

    const rootId = resolveRootSessionId("ses_child_2", (sid) => taskRecords.has(sid));
    const taskId = resolveTaskId("ses_child_2");
    const perm = resolvePermissionDetails("ses_child_2");

    expect(rootId).toBe("ses_root_1");
    expect(taskId).toBe("t1");
    expect(perm.relation).toBe("child");
    expect(perm.rootSessionId).toBe("ses_root_1");
    expect(perm.resolvedTaskId).toBe("t1");
  });

  it("4. Child desconhecido: sem parent e sem registro em taskRecords retorna vazio / unknown", () => {
    taskRecords.set("ses_root_1", { taskId: "t1", state: "running" });

    const rootId = resolveRootSessionId("ses_unknown", (sid) => taskRecords.has(sid));
    const taskId = resolveTaskId("ses_unknown");
    const perm = resolvePermissionDetails("ses_unknown");

    expect(rootId).toBe("");
    expect(taskId).toBe("");
    expect(perm.relation).toBe("unknown");
    expect(perm.resolvedTaskId).toBe("");
  });

  it("5. Ciclo de parentID (A -> B -> A): protege contra loop infinito e encerra com seguranca", () => {
    registerSessionParent("ses_cycle_A", "ses_cycle_B");
    registerSessionParent("ses_cycle_B", "ses_cycle_A");

    const rootId = resolveRootSessionId("ses_cycle_A", (sid) => taskRecords.has(sid));
    const taskId = resolveTaskId("ses_cycle_A");
    const perm = resolvePermissionDetails("ses_cycle_A");

    expect(rootId).toBe("");
    expect(taskId).toBe("");
    expect(perm.relation).toBe("unknown");
  });

  it("6. Duas tasks simultaneas: isolamento estrito entre tarefas independentes", () => {
    // Task A
    taskRecords.set("ses_root_A", { taskId: "t1", state: "running" });
    registerSessionParent("ses_child_A1", "ses_root_A");
    registerSessionParent("ses_child_A2", "ses_child_A1");

    // Task B
    taskRecords.set("ses_root_B", { taskId: "t2", state: "running" });
    registerSessionParent("ses_child_B1", "ses_root_B");

    // Validacao Task A
    const permA = resolvePermissionDetails("ses_child_A2");
    expect(permA.rootSessionId).toBe("ses_root_A");
    expect(permA.resolvedTaskId).toBe("t1");
    expect(permA.relation).toBe("child");

    // Validacao Task B
    const permB = resolvePermissionDetails("ses_child_B1");
    expect(permB.rootSessionId).toBe("ses_root_B");
    expect(permB.resolvedTaskId).toBe("t2");
    expect(permB.relation).toBe("child");

    // Garantia de nao contaminacao cruzada
    expect(permA.resolvedTaskId).not.toBe(permB.resolvedTaskId);
    expect(permA.rootSessionId).not.toBe(permB.rootSessionId);
  });

  it("7. Child session sem parentID: nao associa indevidamente a nenhuma task", () => {
    taskRecords.set("ses_root_1", { taskId: "t1", state: "running" });
    // Child criada sem pai
    registerSessionParent("ses_orphan", "");

    const rootId = resolveRootSessionId("ses_orphan", (sid) => taskRecords.has(sid));
    const taskId = resolveTaskId("ses_orphan");
    const perm = resolvePermissionDetails("ses_orphan");

    expect(rootId).toBe("");
    expect(taskId).toBe("");
    expect(perm.relation).toBe("unknown");
  });

  it("8. Permission de child sendo resolvida para task raiz no caso real reproduzido", () => {
    const realRootSession = "ses_f407d5820ffeiuVViMxa1FrNqZ";
    const realChildSession = "ses_f407cd11fffeStAal6wd6wVW0X";

    taskRecords.set(realRootSession, { taskId: "t1", state: "running" });
    registerSessionParent(realChildSession, realRootSession);

    const perm = resolvePermissionDetails(realChildSession);

    expect(perm.isDirectRoot).toBe(false);
    expect(perm.rootSessionId).toBe(realRootSession);
    expect(perm.resolvedTaskId).toBe("t1");
    expect(perm.relation).toBe("child");
  });
});

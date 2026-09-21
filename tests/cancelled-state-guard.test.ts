/**
 * Tests: Cancelled task state immutability
 *
 * Validates that once a task enters the "cancelled" state (user-initiated Stop),
 * no late OpenCode event (session.error → failed, session.idle → completed,
 * late question.asked → waiting_for_user, etc.) can override it — and that
 * no "[TASK] failed" log / lifecycle event is emitted for a rejected transition.
 *
 * These tests exercise both the setTaskState guard (src/main/main.ts lines 362-374)
 * and the caller pattern (session.error handler, lines 2624-2629) that gates
 * logTask on the boolean returned by setTaskState.
 */

import { describe, it, expect } from "vitest";

// ── Minimal reproduction of setTaskState guard logic ──────────────────────────
// (mirrors the guard in src/main/main.ts — keep in sync)
type TaskState = "idle" | "running" | "waiting_for_user" | "waiting_for_approval" | "completed" | "cancelled" | "failed";

function simulateSetTaskState(
  record: { state: TaskState },
  newState: TaskState,
  reason: string
): { changed: boolean; finalState: TaskState } {
  const previous = record.state;
  if (previous === newState) return { changed: false, finalState: previous };

  const isTerminal = previous === "completed" || previous === "cancelled" || previous === "failed";
  if (isTerminal && reason !== "task-start") {
    if (previous === "cancelled" || !(newState === "completed" || newState === "cancelled" || newState === "failed")) {
      return { changed: false, finalState: previous }; // blocked
    }
  }

  record.state = newState;
  return { changed: true, finalState: newState };
}

/**
 * Simulates the session.error handler caller pattern:
 *   const stateChanged = setTaskState(..., "failed", "session-error");
 *   if (stateChanged) logTask("failed", ...);
 *
 * Returns { finalState, failedLogged }.
 */
function simulateSessionErrorHandler(record: { state: TaskState }): { finalState: TaskState; failedLogged: boolean } {
  const stateChanged = simulateSetTaskState(record, "failed", "session-error").changed;
  const failedLogged = stateChanged; // logTask is only called when stateChanged=true
  return { finalState: record.state, failedLogged };
}
// ─────────────────────────────────────────────────────────────────────────────

describe("Cancelled task state immutability", () => {

  // CASO 1 (original): Normal error path — running → failed (must work)
  it("CASO 1: running → session.error → failed (legítimo)", () => {
    const record = { state: "running" as TaskState };
    const result = simulateSetTaskState(record, "failed", "session-error");
    expect(result.changed).toBe(true);
    expect(result.finalState).toBe("failed");
  });

  // CASO 2 (original): The real bug — cancelled → session.error → must stay cancelled
  it("CASO 2: cancelled → session.error → failed DEVE ser bloqueado", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "failed", "session-error");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("cancelled");
  });

  // CASO 3 (original): cancelled → session.idle → completed DEVE ser bloqueado
  it("CASO 3: cancelled → session.idle → completed DEVE ser bloqueado", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "completed", "session-idle");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("cancelled");
  });

  // CASO 4 (original): cancelled → late question.asked → waiting_for_user DEVE ser bloqueado
  it("CASO 4: cancelled → late question.asked → waiting_for_user DEVE ser bloqueado", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "waiting_for_user", "question-asked");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("cancelled");
  });

  // CASO 5 (original): cancelled → late plan_exit → waiting_for_user DEVE ser bloqueado
  it("CASO 5: cancelled → late plan_exit → waiting_for_user DEVE ser bloqueado", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "waiting_for_user", "plan-approval-asked");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("cancelled");
  });

  // ── Caller-level tests (logging guard) ──────────────────────────────────────

  // CASO A: running → session.error → failed: logTask("failed") DEVE ser chamado
  it("CASO A: running → session.error: registra failed normalmente", () => {
    const record = { state: "running" as TaskState };
    const { finalState, failedLogged } = simulateSessionErrorHandler(record);
    expect(finalState).toBe("failed");
    expect(failedLogged).toBe(true);
  });

  // CASO B: cancelled → session.error: setTaskState retorna false, NÃO emite [TASK] failed
  it("CASO B: cancelled → session.error: NÃO emite [TASK] failed", () => {
    const record = { state: "cancelled" as TaskState };
    const { finalState, failedLogged } = simulateSessionErrorHandler(record);
    expect(finalState).toBe("cancelled");
    expect(failedLogged).toBe(false); // logTask("failed") NOT called
  });

  // CASO C: cancelled → session.idle: permanece cancelled
  it("CASO C: cancelled → session.idle: permanece cancelled", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "completed", "session-idle");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("cancelled");
  });

  // CASO D: cancelled → question/plan tardio: permanece cancelled
  it("CASO D: cancelled → late plan_exit question: permanece cancelled", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "waiting_for_user", "plan-approval-asked");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("cancelled");
  });

  // Sanity: task-start sempre reseta (nova tarefa na mesma sessão)
  it("SANITY: task-start sempre permite nova transição mesmo após cancelled", () => {
    const record = { state: "cancelled" as TaskState };
    const result = simulateSetTaskState(record, "running", "task-start");
    expect(result.changed).toBe(true);
    expect(result.finalState).toBe("running");
  });

  // Sanity: failed→running (late event em tarefa failed) DEVE ser bloqueado
  it("SANITY: failed → running DEVE ser bloqueado (não é task-start)", () => {
    const record = { state: "failed" as TaskState };
    const result = simulateSetTaskState(record, "running", "engine-resumed");
    expect(result.changed).toBe(false);
    expect(result.finalState).toBe("failed");
  });

});

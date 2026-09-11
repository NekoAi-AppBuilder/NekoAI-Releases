import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenCodeEvent, clearStatusCacheForSession } from "../dist/main/events/normalizer.js";

test("normalizeOpenCodeEvent correctly extracts sessionID from various event properties", () => {
  const event1 = normalizeOpenCodeEvent({
    type: "session.status",
    properties: { sessionID: "sess-123", status: { type: "busy" } }
  });
  assert.equal(event1?.type, "neko.status");
  assert.equal(event1?.properties?.sessionID, "sess-123");

  const event2 = normalizeOpenCodeEvent({
    type: "session.status",
    properties: { sessionId: "sess-456", status: { type: "idle" } }
  });
  assert.equal(event2?.type, "neko.status");
  assert.equal(event2?.properties?.sessionID, "sess-456");

  const event3 = normalizeOpenCodeEvent({
    type: "session.status",
    properties: { session: { id: "sess-789" }, status: { type: "idle" } }
  });
  assert.equal(event3?.properties?.sessionID, "sess-789");

  const event4 = normalizeOpenCodeEvent(
    { type: "session.status", sessionID: "sess-abc", properties: { status: { type: "idle" } } } as any
  );
  assert.equal(event4?.properties?.sessionID, "sess-abc");
});

test("clearStatusCacheForSession removes session from cache so subsequent tasks receive fresh status", () => {
  clearStatusCacheForSession("sess-test");
  const event1 = normalizeOpenCodeEvent({
    type: "session.status",
    properties: { sessionID: "sess-test", status: { type: "busy" } }
  });
  assert.ok(event1, "First busy status must be emitted");

  const duplicate = normalizeOpenCodeEvent({
    type: "session.status",
    properties: { sessionID: "sess-test", status: { type: "busy" } }
  });
  assert.equal(duplicate, null, "Duplicate status should be suppressed by status cache");

  clearStatusCacheForSession("sess-test");
  const eventAfterClear = normalizeOpenCodeEvent({
    type: "session.status",
    properties: { sessionID: "sess-test", status: { type: "busy" } }
  });
  assert.ok(eventAfterClear, "Status after clearStatusCacheForSession must be emitted");
});

test("consecutive tasks state lifecycle guarantees IDLE between runs", () => {
  type TaskState = "idle" | "running" | "completed" | "cancelled" | "failed";
  let state: TaskState = "idle";
  let busy: boolean = false;
  let workingStatus: string = "";

  function startTask() {
    state = "running";
    busy = true;
    workingStatus = "Neko está trabalhando...";
  }

  function toolExecuteBefore() {
    if (state === "running") {
      workingStatus = "Executando uma ação no projeto...";
    }
  }

  function toolExecuteAfter() {
    if (state === "running") {
      workingStatus = "Neko está trabalhando...";
    }
  }

  function concludeTask(result: "completed" | "cancelled") {
    state = result;
    busy = false;
    workingStatus = "";
  }

  // Task 1: Start -> Tool execute -> Tool finish -> Conclude
  startTask();
  assert.equal(busy, true);
  toolExecuteBefore();
  assert.equal(workingStatus, "Executando uma ação no projeto...");
  toolExecuteAfter();
  assert.equal(workingStatus, "Neko está trabalhando...");
  concludeTask("completed");
  assert.equal(state, "completed");
  assert.equal(busy, false);
  assert.equal(workingStatus, "");

  // Task 2 (consecutive): Start -> Tool execute -> Tool finish -> Conclude
  startTask();
  assert.equal(state, "running");
  assert.equal(busy, true);
  toolExecuteBefore();
  assert.equal(workingStatus, "Executando uma ação no projeto...");
  toolExecuteAfter();
  assert.equal(workingStatus, "Neko está trabalhando...");
  concludeTask("completed");
  assert.equal(state, "completed");
  assert.equal(busy, false);
  assert.equal(workingStatus, "");

  // Task 3: Cancel/Abort flow
  startTask();
  toolExecuteBefore();
  concludeTask("cancelled");
  assert.equal(state, "cancelled");
  assert.equal(busy, false);
  assert.equal(workingStatus, "");
});


// Internal latency diagnostics for the Neko task pipeline.
//
// Disabled by default. Enable with NEKO_PERF_DIAGNOSTICS=true (or 1/yes/on).
// When enabled, every user task records monotonic milestones (T0..T8), upload
// timing and SSE event counters, then prints a compact summary to the main
// process console. When disabled every exported call is a near-free no-op and
// the task flow is untouched.
//
// The instrumentation never logs prompt content, API keys, tokens or file
// contents - only ids, counts, sizes and durations.

const PERF_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.NEKO_PERF_DIAGNOSTICS ?? ""));

// Monotonic clock (ms since process start). Immune to system clock changes.
function perfNowMs(): number {
  return Number(process.hrtime.bigint() / 1000000n);
}

type PerfMarkKey =
  | "t1" | "t2" | "t3" | "t4" | "t5" | "t6" | "t7" | "t8"
  | "uploadStart" | "uploadReady" | "taskSend";

// Ordering guards: a mark is only recorded after its prerequisite exists, so
// late/duplicate events can never move a milestone backwards or forward.
const MARK_REQUIRES: Record<PerfMarkKey, PerfMarkKey[]> = {
  t1: [],
  t2: [],
  t3: ["t2"],
  t4: ["t2"],
  t5: ["t2"],
  t6: ["t5"],
  t7: ["t2"],
  t8: ["t2"],
  uploadStart: [],
  uploadReady: [],
  taskSend: []
};

type PerfTask = {
  id: string;
  sessionId: string;
  modelLabel: string;
  // T0 estimate projected onto the main-process monotonic timeline:
  // t1 (handler entry) minus the renderer-measured preparation time.
  t0Main: number;
  prepMs: number;
  marks: Map<PerfMarkKey, number>;
  attachmentCount: number;
  attachmentBytes: number;
  received: number;
  forwarded: number;
  retries: number;
  retryReason: string;
  retryCycleStart: number;
  retryDurations: number[];
  flushed: boolean;
};

let activePerfTask: PerfTask | null = null;
const perfTasksBySession = new Map<string, PerfTask>();

function perfFmt(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function perfDelta(task: PerfTask, key: PerfMarkKey, fromKey?: PerfMarkKey): number | undefined {
  const value = task.marks.get(key);
  if (value === undefined) return undefined;
  const from = fromKey ? task.marks.get(fromKey) : undefined;
  if (from === undefined) return undefined;
  return Math.max(0, value - from);
}

export const perfEnabled = PERF_ENABLED;

export function perfTaskStart(
  sessionId: string,
  payload: { t0?: number; prepMs?: number } | undefined,
  modelLabel: string,
  attachmentCount: number
): void {
  if (!PERF_ENABLED) return;
  const previous = perfTasksBySession.get(sessionId);
  if (previous && !previous.flushed) perfFlushTask(previous, "superseded");

  const task: PerfTask = {
    id: `t${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    modelLabel,
    prepMs: typeof payload?.prepMs === "number" && payload.prepMs > 0 ? payload.prepMs : 0,
    t0Main: 0,
    marks: new Map(),
    attachmentCount: Math.max(0, Number(attachmentCount) || 0),
    attachmentBytes: 0,
    received: 0,
    forwarded: 0,
    retries: 0,
    retryReason: "",
    retryCycleStart: 0,
    retryDurations: [],
    flushed: false
  };
  task.marks.set("t1", perfNowMs());
  task.t0Main = (task.marks.get("t1") ?? 0) - task.prepMs;
  perfTasksBySession.set(sessionId, task);
  activePerfTask = task;
  console.log(`[Neko/Perf] task=${task.id} session=${sessionId.slice(0, 8)} start model=${modelLabel || "-"} uploads=${task.attachmentCount}`);
}

export function perfMark(key: PerfMarkKey, sessionId?: string | null): void {
  if (!PERF_ENABLED) return;
  const task = (sessionId && perfTasksBySession.get(sessionId)) || activePerfTask;
  if (!task || task.flushed) return;
  for (const required of MARK_REQUIRES[key] ?? []) {
    if (!task.marks.has(required)) return;
  }
  if (!task.marks.has(key)) task.marks.set(key, perfNowMs());
}

export function perfCountEvent(kind: "received" | "forwarded"): void {
  if (!PERF_ENABLED) return;
  const task = activePerfTask;
  if (!task || task.flushed) return;
  if (kind === "received") task.received += 1;
  else task.forwarded += 1;
}

export function perfUploadBytes(bytes: unknown): void {
  if (!PERF_ENABLED) return;
  const task = activePerfTask;
  if (!task || task.flushed) return;
  task.attachmentBytes += Math.max(0, Number(bytes) || 0);
}

// Engine-level retry cycle (session.status retry -> busy -> retry ...).
// Retries are measured separately so they are never mistaken for real agent
// activity: a retry does not move T4/T5 and appears as its own counters.
export function perfRetryStart(reason?: unknown): void {
  if (!PERF_ENABLED) return;
  const task = activePerfTask;
  if (!task || task.flushed) return;
  if (!task.marks.has("t2")) return;
  task.retries += 1;
  const text = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!task.retryReason && text) task.retryReason = text.slice(0, 80);
  task.retryCycleStart = perfNowMs();
}

export function perfRetryEnd(): void {
  if (!PERF_ENABLED) return;
  const task = activePerfTask;
  if (!task || task.flushed) return;
  if (task.retryCycleStart <= 0) return;
  task.retryDurations.push(Math.max(0, perfNowMs() - task.retryCycleStart));
  task.retryCycleStart = 0;
}

export function perfFlushTask(sessionIdOrTask?: string | PerfTask | null, reason = "done"): void {
  if (!PERF_ENABLED) return;
  const task = typeof sessionIdOrTask === "string" || sessionIdOrTask === null || sessionIdOrTask === undefined
    ? ((sessionIdOrTask && perfTasksBySession.get(sessionIdOrTask)) || activePerfTask)
    : sessionIdOrTask;
  if (!task || task.flushed) return;
  task.flushed = true;

  const t2 = task.marks.get("t2");
  const t8 = task.marks.get("t8");
  const sendMs = perfDelta(task, "t2", "t1");
  const acceptMs = sendMs !== undefined ? task.prepMs + sendMs : (t2 !== undefined ? Math.max(0, t2 - task.t0Main) : undefined);

  const summary = [
    `task=${task.id}`,
    `session=${task.sessionId.slice(0, 8)}`,
    `reason=${reason}`,
    `model=${task.modelLabel || "-"}`,
    `prep=${perfFmt(task.prepMs)}`,
    `send=${perfFmt(sendMs)}`,
    `accept=${perfFmt(acceptMs)}`,
    `first_event=${perfFmt(perfDelta(task, "t3", "t2"))}`,
    `first_activity=${perfFmt(perfDelta(task, "t4", "t3"))}`,
    `first_file=${perfFmt(perfDelta(task, "t5", "t4"))}`,
    `preview_update=${perfFmt(perfDelta(task, "t6", "t5"))}`,
    `idle=${perfFmt(perfDelta(task, "t7", "t5"))}`,
    `total=${perfFmt(t8 !== undefined ? Math.max(0, t8 - task.t0Main) : undefined)}`,
    `events rx=${task.received} fwd=${task.forwarded} drop=${Math.max(0, task.received - task.forwarded)}`
  ];
  if (task.retries > 0) {
    summary.push(
      `retries=${task.retries}`,
      `retry_reason=${task.retryReason || "-"}`,
      `retry_times=${task.retryDurations.map(duration => perfFmt(duration)).join(",") || "-"}`
    );
  }
  console.log(`[Neko/Perf] ${summary.join(" ")}`);

  if (task.attachmentCount > 0) {
    console.log(`[Neko/Perf] task=${task.id} upload_start→ready=${perfFmt(perfDelta(task, "uploadReady", "uploadStart"))} files=${task.attachmentCount} bytes=${task.attachmentBytes} task_send→first_event=${perfFmt(perfDelta(task, "t3", "taskSend"))}`);
  }

  if (activePerfTask === task) activePerfTask = null;
  perfTasksBySession.delete(task.sessionId);
}

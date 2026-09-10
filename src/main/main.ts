import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell, WebContentsView, webFrameMain, type OpenDialogOptions } from "electron";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { normalizeOpenCodeEvent, clearStatusCache, clearStatusCacheForSession } from "./events/normalizer";
import { shouldIgnoreEventPath } from "./events/filters";
import { perfEnabled, perfTaskStart, perfMark, perfCountEvent, perfUploadBytes, perfFlushTask, perfRetryStart, perfRetryEnd } from "./perf";
import { supabaseManager } from "./supabase/supabase-manager";
import { parseSupabaseError } from "./supabase/supabase-cli";
import { SupabaseCreateProjectPayload } from "./supabase/supabase-types";
import { vercelManager, getSupabaseEnvironmentNames } from "./vercel/vercel-manager";
import { isValidVercelProjectName } from "./vercel/vercel-types";
import { licenseManager } from "./license/license-manager";
import { updaterManager } from "./updater";
import { getModelCapabilities, isVisionImage, buildVisionContext, VISION_FALLBACK_MODEL, VISION_FALLBACK_PROVIDER_CANDIDATES } from "../shared/vision";
import { analyzeImagesWithMiMo, cancelVisionFallbackFor, clearVisionFallbackSessions, isVisionFallbackSession } from "./vision-fallback";
import { discoverPreviewRoutes, routeFromUrl, normalizeRoutePath, isDynamicSegment, type PreviewRoute } from "./preview-routes";
import { analyzeSite, cancelAllSiteClones, importSiteAssets, type SiteCloneAnalysis, type SiteCloneLimits } from "./site-clone";
import { captureSiteChromium } from "./site-capture";
import { recentProjectsManager, detectProjectTechnology, checkProjectExistsOnDisk, normalizeProjectPath } from "./recent-projects-manager";
import { appPreferencesManager, isValidDirectory } from "./app-preferences-manager";
import { thumbnailService } from "./thumbnail-service";
// Electron/Chromium cache and Service Worker storage must not depend on a
// redirected/synced user profile (for example OneDrive). Keep browser cache
// data in the local Windows profile while keeping NekoAI user preferences
// under app.getPath("userData") as before. This prevents non-fatal cache/DB
// permission errors from slowing or destabilizing the renderer.
if (process.platform === "win32") {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const nekoLocalData = path.join(localAppData, "NekoAI");
  try {
    fs.mkdirSync(nekoLocalData, { recursive: true });
    // Electron does not expose a standalone "cache" app path. Chromium
    // stores its cache/database/service-worker data under sessionData.
    // Redirect that supported path outside OneDrive before app ready.
    const sessionDataPath = path.join(nekoLocalData, "SessionData");
    app.setPath("sessionData", sessionDataPath);
    console.log("[Neko/Electron] local sessionData", sessionDataPath);
  } catch (error) {
    console.warn("[Neko/Electron] could not configure local browser storage", error);
  }
}

interface WorkspaceContext {
  readonly generation: number;
  readonly projectPath: string;
  opencodeProcess: ChildProcess | null;
  opencodeUrl: string;
  opencodePort: number | null;
  previewProcess: ChildProcess | null;
  previewStaticServer: http.Server | null;
  previewPort: number | null;
  previewUrl: string | null;
  watcher: fs.FSWatcher | null;
  eventAbort: AbortController | null;
  status: "starting" | "ready" | "stopping" | "stopped";
}

let activeWorkspace: WorkspaceContext | null = null;
let mainWindow: BrowserWindow | null = null;
let opencodeProcess: ChildProcess | null = null;
let opencodeUrl = "http://127.0.0.1:4097";
let currentProject: string | null = null;
let eventAbort: AbortController | null = null;
let sseReconnectTimer: NodeJS.Timeout | null = null;
let sseReconnectAttempts = 0;

function cancelSseReconnect(reason = "cancelled") {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
    console.log(`[OpenCode/SSE] reconnect cancelled reason=${reason}`);
  }
  sseReconnectAttempts = 0;
}
let projectWatcher: fs.FSWatcher | null = null;
let projectWatchTimer: NodeJS.Timeout | null = null;

// Service readiness gate. A server "start" spans process spawn + the first
// successful health check. Dependent IPC handlers (providers:list, models:list,
// ...) await this gate instead of connecting immediately, which eliminates the
// ECONNREFUSED race that happened when the renderer asked for providers while
// the internal service was still binding its port.
let serviceReady = false;
let serviceReadyUrl = "";
let serviceStartPromise: Promise<unknown> | null = null;
let serviceGeneration = 0;
let projectTransitionGeneration = 0;
let activeWorkspaceTransitionPromise: Promise<any> | null = null;
let isStoppingOpencodeIntentionally = false;

function logService(step: string, extra?: string) {
  console.log(`[Neko/Service] ${step}${extra ? ` ${extra}` : ""}`);
}

// ============================================================
// PROJECT ROOT vs APPLICATION ROOT
// ------------------------------------------------------------
// applicationRoot: where NekoAI is installed/running (its own code).
// projectRoot: the user's open workspace. These can NEVER be the same.
//
// The active workspace (activeWorkspace.projectPath) is the single source
// of truth. There is NO fallback to process.cwd(), __dirname or
// app.getAppPath() when resolving the user project: if the root cannot be
// determined or points inside NekoAI itself, the operation is blocked.
// ============================================================

let cachedApplicationRoot: string | null = null;

function getApplicationRoot(): string {
  if (cachedApplicationRoot) return cachedApplicationRoot;
  try {
    cachedApplicationRoot = path.resolve(app.getAppPath());
  } catch {
    cachedApplicationRoot = path.resolve(process.cwd());
  }
  return cachedApplicationRoot;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function isInsideNekoApplication(root: string): boolean {
  try {
    return isPathInside(getApplicationRoot(), root);
  } catch {
    return true;
  }
}

// Validates a candidate project root. Throws when the root is missing or
// when it points inside the NekoAI application itself. Never falls back.
function assertProjectRootSafe(root: string | null | undefined, operation: string): string {
  if (!root || !String(root).trim()) {
    throw new Error("Não foi possível determinar o diretório do projeto ativo.");
  }
  const resolved = path.resolve(String(root).trim());
  if (isInsideNekoApplication(resolved)) {
    console.warn(`[PROJECT WORKSPACE] operation=${operation} blocked reason=nekoai-directory projectRoot=${resolved} applicationRoot=${getApplicationRoot()}`);
    throw new Error("Não é permitido utilizar o diretório do NekoAI como workspace do projeto.");
  }
  return resolved;
}

// Best-effort read of the current project root. Returns null instead of
// throwing so headers/SSE streams can degrade safely without a fallback.
function getActiveProjectRoot(): string | null {
  const candidate = activeWorkspace?.projectPath ?? currentProject;
  if (!candidate) return null;
  try {
    const resolved = path.resolve(candidate);
    if (isInsideNekoApplication(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function logProjectWorkspace(operation: string, projectRoot: string | null) {
  console.log(`[PROJECT WORKSPACE] operation=${operation} projectId=${projectRoot ? path.basename(projectRoot) : "none"} projectRoot=${projectRoot ?? "none"} applicationRoot=${getApplicationRoot()}`);
}

function invalidateServiceGate() {
  serviceGeneration += 1;
  serviceReady = false;
  serviceReadyUrl = "";
  serviceStartPromise = null;
}

async function waitForServiceReady(): Promise<void> {
  if (serviceReady) return;
  if (activeWorkspaceTransitionPromise) {
    logService("waiting-for-transition");
    try {
      await activeWorkspaceTransitionPromise;
    } catch {}
    if (serviceReady) return;
  }
  const gate = serviceStartPromise;
  if (gate) {
    logService("waiting-for-ready");
    try {
      await gate;
    } catch {}
    if (serviceReady) return;
    throw new Error("O serviço interno não ficou pronto a tempo.");
  }
}

type ActiveAgentRequest = { requestBody: any; attempts: number; maxAttempts: number; retryTimer?: NodeJS.Timeout; isRetrying?: boolean };
const activeAgentRequests = new Map<string, ActiveAgentRequest>();
const forwardedSessionStatus = new Map<string, string>();
const AGENT_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000, 60000, 120000, 180000];

// Engine-level retry watchdog. OpenCode can alternate session.status between
// retry and busy without ever producing real activity (tool/file events). The
// watchdog counts full retry cycles (busy -> retry) per session and, when the
// limit is reached with zero progress, surfaces a real error instead of
// leaving the user stuck on "trabalhando". Real agent activity resets the
// counter, so a valid recovery returns to the working state.
const ENGINE_MAX_RETRY_CYCLES = 3;
type EngineRetryState = { cycles: number; phase: "retry" | "busy" | "idle"; reason: string; lastRetryAt: number };
const engineRetryStates = new Map<string, EngineRetryState>();
const retryExhaustedSessions = new Set<string>();
const sessionModelLabels = new Map<string, string>();
const attemptedErrorSignatures = new Map<string, { count: number; lastAttempt: number }>();

function logSafeText(value: unknown, limit = 160): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .slice(0, limit)
    .trim();
}

function sanitizeErrorMessage(msg: string): string {
  return String(msg ?? "")
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(password["':\s=]+)[^\s"&,]+/gi, "$1[REDACTED]")
    .replace(/(token["':\s=]+)[^\s"&,]+/gi, "$1[REDACTED]")
    .replace(/(key["':\s=]+)[a-zA-Z0-9_\-]{8,}/gi, "$1[REDACTED]");
}

// Handlers globais de erro para prevenir crashes silenciosos no processo principal
process.on("uncaughtException", (error: Error) => {
  const safeMsg = sanitizeErrorMessage(error?.message ?? String(error));
  const safeStack = sanitizeErrorMessage(error?.stack ?? "");
  console.error(`[FATAL/UncaughtException] ${safeMsg}\n${safeStack}`);
});

process.on("unhandledRejection", (reason: unknown) => {
  const raw = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  const safeReason = sanitizeErrorMessage(raw);
  console.error(`[FATAL/UnhandledRejection] ${safeReason}`);
});

// Task correlation. Every prompt receives an internal id that is attached to
// the session.idle events of that task, so the renderer can distinguish the
// idle of task A from the idle of task B and never conclude the wrong task.
let promptTaskCounter = 0;
const sessionTaskIds = new Map<string, string>();
function newTaskCorrelationId(sessionId: string): string {
  const id = `t${(++promptTaskCounter).toString(36)}`;
  sessionTaskIds.set(sessionId, id);
  return id;
}

// ============================================================
// TASK STATE MACHINE
// ------------------------------------------------------------
// TASK / AGENT / TOOL / PREVIEW / UI are independent concepts.
// The agent session is the only source of truth for task progress; the
// Preview (Vite/HMR) never influences task states. This machine is owned by
// the main process and every transition is pushed to the renderer through
// the authoritative `neko.task.state` event.
//
// States: idle, running, waiting_for_user, waiting_for_approval,
//         completed, cancelled, failed
// ============================================================
type TaskState = "idle" | "running" | "waiting_for_user" | "waiting_for_approval" | "completed" | "cancelled" | "failed";
type TaskRecord = {
  taskId: string;
  sessionId: string;
  state: TaskState;
  planMode: boolean;
  createdAt: number;
  stateAt: number;
  // True once the engine actually started processing this task (busy status
  // or real tool/file activity). An idle BEFORE the task started is engine
  // chatter and can never finalize the task.
  sawBusy: boolean;
  // Timestamp of the last busy status / real activity. Used to debounce the
  // completion determination against transient idle chatter mid-cycle.
  lastActivityAt: number;
  lastAssistantMessageId: string;
  askedQuestionIds: string[];
  // Newest assistant message id the event stream has referred to for this
  // session (message.part.updated / message.updated). Used to detect the
  // message-commit race: an idle can arrive before the message endpoint
  // exposes the very message the engine just streamed.
  lastStreamedAssistantMessageId: string;
};
const taskRecords = new Map<string, TaskRecord>();
let taskQuestionCounter = 0;
const idleDeterminationGate = new Map<string, { running: boolean; lastAt: number }>();
const idleRecheckTimers = new Map<string, NodeJS.Timeout>();
// Single short recheck for the message-commit race (see runIdleDetermination).
// Deduplicated by task+session so only one recheck ever runs per idle cycle.
const questionRecheckTimers = new Map<string, { timer: NodeJS.Timeout; taskId: string }>();
const previewErrorEmissionAt = new Map<string, number>();
// Safety net against tasks stuck in "running": OpenCode can accept a prompt and
// then never emit activity, messages, tool calls or session.idle. Conclusion
// only happens inside runIdleDetermination (triggered by session.idle), so such
// a task would stay running forever. One bounded timer per non-plan task: 3
// minutes by default, overridable for tests. It never invents questions, never
// emits waiting_for_user, and defers to busy/retry/unknown instead of failing.
const AGENT_INACTIVE_LIMIT_MS = Math.max(5_000, Number(process.env.NEKO_AGENT_STALE_LIMIT_MS) || 180_000);
// When the first watchdog check finds the session unknown/absent, a SINGLE
// short recheck (~30s) is armed instead of a new full cycle. If the second
// probe is still unknown/absent the task fails: the watchdog never re-arms
// indefinitely. If the session returns to busy/retry/idle meanwhile, the
// normal flow takes over. No loops, no periodic polling.
const AGENT_INACTIVE_UNKNOWN_RECHECK_MS = Math.max(5_000, Number(process.env.NEKO_AGENT_STALE_UNKNOWN_RECHECK_MS) || 30_000);
type AgentInactiveEntry = { timer: NodeJS.Timeout; taskId: string; unknownRecheck: boolean };
const agentInactiveTimers = new Map<string, AgentInactiveEntry>();
// Diagnostic-only trackers (never decide state): unknown-status transitions,
// sampled SSE message logging and one-shot post-ACK probes.
const unknownStatusTrack = new Map<string, { enteredAt: number; persistedLogged: boolean }>();
const diagMessageLogCounts = new Map<string, number>();
const postAckDiagScheduled = new Set<string>();

// In-memory capability cache for the provider catalog, refreshed whenever
// the renderer loads providers. Vision capability decisions never trigger
// an additional providers:list request — they only read this cache.
const providerCatalogCache = new Map<string, { attachment: boolean }>();

// Resolves the REAL provider id for the Vision Fallback model against the
// catalog cache. The catalog of OpenCode 1.18.x exposes OpenCode Zen as
// `opencode` (historically `opencode-zen`); candidates are checked in order
// so both catalogs keep working. No providers:list request is made here.
function resolveVisionFallbackProvider(): string {
  for (const candidate of VISION_FALLBACK_PROVIDER_CANDIDATES) {
    if (providerCatalogCache.has(`${candidate}:${VISION_FALLBACK_MODEL.modelID}`)) return candidate;
  }
  return VISION_FALLBACK_MODEL.providerID;
}

function logTask(event: string, taskId: string, sessionId: string, extra = "") {
  console.log(`[TASK] ${event} taskId=${taskId || "none"} sessionId=${(sessionId || "none").slice(0, 8)} at=${Date.now()}${extra ? ` ${extra}` : ""}`);
}

function setTaskState(sessionId: string, state: TaskState, reason: string, extra: Record<string, any> = {}): boolean {
  if (!sessionId) return false;
  let record = taskRecords.get(sessionId);
  if (!record) {
    record = {
      taskId: sessionTaskIds.get(sessionId) ?? "",
      sessionId,
      state: "idle",
      planMode: false,
      createdAt: Date.now(),
      stateAt: 0,
      sawBusy: false,
      lastActivityAt: 0,
      lastAssistantMessageId: "",
      askedQuestionIds: [],
      lastStreamedAssistantMessageId: ""
    };
    taskRecords.set(sessionId, record);
  }
  const previous = record.state;
  if (previous === state) return false;

  // Guarda de estado terminal: eventos atrasados não podem ressuscitar uma tarefa finalizada
  const isTerminal = previous === "completed" || previous === "cancelled" || previous === "failed";
  if (isTerminal && reason !== "task-start" && state !== "completed" && state !== "cancelled" && state !== "failed") {
    console.log(`[TaskState] Ignorando transição tardia de estado terminal (${previous} -> ${state}) sessionId=${sessionId.slice(0, 8)} taskId=${record.taskId || "none"} reason=${logSafeText(reason)}`);
    return false;
  }

  record.state = state;
  record.stateAt = Date.now();
  logTask("state-change", record.taskId, sessionId, `state=${state} previous=${previous} reason=${logSafeText(reason)}`);
  mainWindow?.webContents.send("opencode:event", {
    type: "neko.task.state",
    properties: {
      sessionID: sessionId,
      taskId: record.taskId || undefined,
      state,
      previous,
      reason: logSafeText(reason),
      at: Date.now(),
      ...extra
    }
  });
  // Inactivity watchdog: arm a single bounded timer whenever a (non-plan) task
  // enters running and disarm it as soon as it leaves running (user STOP,
  // question, approval or completion). Plan mode keeps its own deadline.
  if (state === "running") {
    scheduleAgentInactivityWatchdog(sessionId, record.taskId);
  } else {
    cancelAgentInactivityWatchdog(sessionId);
  }
  return true;
}

function resolveTaskIdForSession(sessionId: string): string {
  const record = taskRecords.get(sessionId);
  if (record?.taskId) return record.taskId;
  let taskId = sessionTaskIds.get(sessionId) ?? "";
  if (!taskId && sessionTaskIds.size === 1) {
    taskId = Array.from(sessionTaskIds.values())[0] || "";
  }
  return taskId;
}

function normalizeTimestamp(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
}

// Pending permissions are the engine's approval requests. Only permissions
// created after the current task started count: an old permission must never
// block or influence a new task.
async function fetchPendingPermissions(sessionId: string, timeoutMs = 4000): Promise<any[]> {
  try {
    const response = await fetchWithTimeout(`${opencodeUrl}/permission`, { headers: opencodeRequestHeaders() }, timeoutMs);
    if (!response.ok) return [];
    const payload = await response.json();
    const list = Array.isArray(payload) ? payload : (payload?.data ?? payload?.permissions ?? []);
    if (!Array.isArray(list)) return [];
    const record = taskRecords.get(sessionId);
    const since = normalizeTimestamp(record?.createdAt ?? 0);
    return list
      .filter((item: any) => item?.sessionID === sessionId)
      .filter((item: any) => normalizeTimestamp(item?.time?.created ?? 0) >= since)
      .sort((a: any, b: any) => normalizeTimestamp(a?.time?.created ?? 0) - normalizeTimestamp(b?.time?.created ?? 0));
  } catch {
    return [];
  }
}

async function fetchLatestAssistantMessage(sessionId: string, timeoutMs = 4000): Promise<{ id: string; text: string; created: number } | null> {
  try {
    const response = await fetchWithTimeout(
      `${opencodeUrl}/session/${encodeURIComponent(sessionId)}/message`,
      { headers: opencodeRequestHeaders() },
      timeoutMs
    );
    if (!response.ok) return null;
    const payload: any = await response.json();
    const entries: any[] = Array.isArray(payload) ? payload : (payload?.data ?? []);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const role = entry?.info?.role ?? entry?.role;
      if (role !== "assistant") continue;
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      const text = parts
        .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
        .map((part: any) => part.text.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (!text) continue;
      const created = normalizeTimestamp(entry?.info?.time?.created ?? entry?.time?.created ?? entry?.createdAt ?? 0);
      return { id: String(entry?.info?.id ?? entry?.id ?? ""), text, created };
    }
    return null;
  } catch {
    return null;
  }
}

// The engine can ask questions via native tool or trailing text question.
// A question ends asking the user or offers choice options.
function detectQuestion(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  // Tolerate small trailing formatting differences (a stray period, closing
  // quote/bracket, line break or whitespace) without turning arbitrary text
  // into a question. The message still has to actually end with a "?".
  const cleaned = normalized.replace(/[)}\]"'`»“”]+$/, "");
  if (/[?？]\s*$/.test(cleaned)) return true;
  if (/[?？]/.test(normalized) && extractQuestionOptions(normalized).length >= 2) return true;
  return false;
}

function extractQuestionOptions(text: string): string[] {
  const options: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:(\d+)[.)]|[-*])\s+(.{2,140})$/);
    if (match) options.push((match[1] ? `${match[1]}. ` : "") + match[2].trim());
  }
  return options.length >= 2 ? options : [];
}

// Authoritative cross-check of the engine state. The determination only
// finalizes while the engine reports itself idle: an idle event that races a
// busy engine (long tool execution, mid-cycle pause) must never conclude a
// task that is still being processed.
async function fetchSessionEngineStatus(sessionId: string, timeoutMs = 4000): Promise<"busy" | "retry" | "idle" | "unknown"> {
  try {
    const response = await fetchWithTimeout(`${opencodeUrl}/session/status`, { headers: opencodeRequestHeaders() }, timeoutMs);
    if (!response.ok) {
      trackUnknownStatus(sessionId, "unknown");
      return "unknown";
    }
    const payload: any = await response.json();
    const statuses = payload?.data ?? payload ?? {};
    const status = statuses?.[sessionId];
    const engineStatus = String(status?.type ?? status ?? "").toLowerCase();
    trackUnknownStatus(sessionId, engineStatus === "" ? "unknown" : engineStatus);
    if (engineStatus === "busy" || engineStatus === "retry" || engineStatus === "idle") return engineStatus;
    return "unknown";
  } catch {
    trackUnknownStatus(sessionId, "unknown");
    return "unknown";
  }
}

// Arms or re-arms the single inactivity watchdog for a task. While waiting for
// user input/approval, the watchdog is cancelled. A short unknown-recheck cycle
// (unknownRecheck=true) is just a one-time ~30s probe.
function scheduleAgentInactivityWatchdog(sessionId: string, taskId: string, unknownRecheck = false) {
  const record = taskRecords.get(sessionId);
  if (!record) return;
  const existing = agentInactiveTimers.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  const delay = unknownRecheck ? AGENT_INACTIVE_UNKNOWN_RECHECK_MS : AGENT_INACTIVE_LIMIT_MS;
  const timer = setTimeout(() => {
    agentInactiveTimers.delete(sessionId);
    void checkAgentInactivity(sessionId, unknownRecheck);
  }, delay);
  agentInactiveTimers.set(sessionId, { timer, taskId, unknownRecheck });
}

function cancelAgentInactivityWatchdog(sessionId: string) {
  const existing = agentInactiveTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    agentInactiveTimers.delete(sessionId);
  }
}

// Diagnostic only: logs unknown-status transitions for a task session —
// entering unknown, persisting >=5s (once), and leaving unknown. Never logs
// every call, never decides state.
function trackUnknownStatus(sessionId: string, status: string) {
  if (!sessionId) return;
  const taskLabel = resolveTaskIdForSession(sessionId) || "-";
  if (status !== "unknown") {
    const entry = unknownStatusTrack.get(sessionId);
    if (entry) {
      console.log(`[TASK][diag] task=${taskLabel} session=${sessionId} status=${status} previouslyUnknownMs=${Date.now() - entry.enteredAt}`);
      unknownStatusTrack.delete(sessionId);
    }
    return;
  }
  const now = Date.now();
  const entry = unknownStatusTrack.get(sessionId);
  if (!entry) {
    unknownStatusTrack.set(sessionId, { enteredAt: now, persistedLogged: false });
    console.log(`[TASK][diag] task=${taskLabel} session=${sessionId} status=unknown durationMs=0`);
    return;
  }
  const durationMs = now - entry.enteredAt;
  if (durationMs >= 5000 && !entry.persistedLogged) {
    entry.persistedLogged = true;
    console.log(`[TASK][diag] task=${taskLabel} session=${sessionId} status=unknown durationMs=${durationMs}`);
  }
}

// One-time post-ACK probe (BUILD only): ~5s after prompt_async accepts, read
// /session/status and /session/{id}/message once and log structural facts.
// Deduplicated by taskId:sessionId, never repeated, skipped on terminal states.
async function runPostAckDiag(sessionId: string, taskId: string) {
  const record = taskRecords.get(sessionId);
  if (!record) return;
  if (["completed", "failed", "cancelled", "waiting_for_user", "waiting_for_approval"].includes(record.state)) return;
  const engineStatus = await fetchSessionEngineStatus(sessionId);
  let messageCount = 0;
  let lastRole = "";
  let lastMessageId = "";
  let lastMessageAgeMs = -1;
  try {
    const response = await fetchWithTimeout(
      `${opencodeUrl}/session/${encodeURIComponent(sessionId)}/message`,
      { headers: opencodeRequestHeaders() },
      5000
    );
    if (response.ok) {
      const payload: any = await response.json();
      const entries: any[] = Array.isArray(payload) ? payload : (payload?.data ?? []);
      messageCount = entries.length;
      const last = entries[entries.length - 1];
      if (last) {
        lastRole = String(last?.info?.role ?? last?.role ?? "");
        lastMessageId = String(last?.info?.id ?? last?.id ?? "");
        const created = Number(last?.info?.time?.created ?? last?.time?.created ?? last?.createdAt ?? 0);
        lastMessageAgeMs = created > 0 ? Math.max(0, Date.now() - created * 1000) : -1;
      }
    }
  } catch {}
  console.log(`[TASK][diag] post-ack session=${sessionId} task=${taskId || "-"} engineStatus=${engineStatus} sessionPresent=${engineStatus === "unknown" ? "false" : "true"} messages=${messageCount} lastRole=${lastRole || "-"} lastMessageId=${lastMessageId || "-"} lastMessageAgeMs=${lastMessageAgeMs}`);
}

// Sampled, structural-only logging for SSE message events. For streaming parts
// it logs the first 3 of a message, then every 25th (bounded even for very
// long streams). Text content is never logged, only the length.
function logSampledMessageEvent(eventType: string, props: any, sessionId: string) {
  const messageId = String(props?.part?.messageID ?? props?.messageID ?? props?.info?.id ?? "");
  const role = String(props?.info?.role ?? props?.part?.role ?? props?.part?.state?.role ?? "");
  const partType = String(props?.part?.type ?? (eventType === "message.updated" ? "message" : ""));
  const infoParts = Array.isArray(props?.info?.parts) ? props.info.parts : [];
  const textLength = eventType === "message.updated"
    ? infoParts
        .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
        .reduce((sum: number, p: any) => sum + p.text.length, 0)
    : typeof props?.part?.text === "string" ? props.part.text.length : 0;
  const key = `${eventType}:${sessionId}:${messageId || "-"}`;
  const count = (diagMessageLogCounts.get(key) ?? 0) + 1;
  diagMessageLogCounts.set(key, count);
  if (eventType === "message.part.updated" && count > 3 && count % 25 !== 0) return;
  console.log(`[Neko/OpenCode][diag] event=${eventType} session=${sessionId} message=${messageId || "-"} role=${role || "-"} part=${partType || "-"} textLength=${textLength} seq=${count}`);
}

// Deadline reached for a "running" task with no real agent activity. Fails only
// when the engine itself confirms the session stopped making progress: busy and
// retry re-arm the normal full cycle (a slow-but-alive agent is never killed).
// Unknown/absent is re-checked exactly once after ~30s; still unknown then
// means the task is really orphaned and becomes failed. Question/approval
// outcomes are still decided by the existing determination; the watchdog never
// synthesizes a question and never emits waiting_for_user.
async function checkAgentInactivity(sessionId: string, isUnknownRecheck = false) {
  const record = taskRecords.get(sessionId);
  if (!record || record.state !== "running") return;
  const active = activeAgentRequests.get(sessionId);
  if (active?.isRetrying || active?.retryTimer) {
    scheduleAgentInactivityWatchdog(sessionId, record.taskId);
    return;
  }
  const sinceLastRealActivity = Date.now() - (record.lastActivityAt || record.createdAt);
  if (sinceLastRealActivity < AGENT_INACTIVE_LIMIT_MS) {
    // Activity happened after the watchdog was armed: re-arm from now.
    scheduleAgentInactivityWatchdog(sessionId, record.taskId);
    return;
  }
  const engineStatus = await fetchSessionEngineStatus(sessionId);
  const current = taskRecords.get(sessionId);
  if (current !== record || record.state !== "running") return; // replaced/concluded meanwhile
  if (engineStatus === "busy" || engineStatus === "retry") {
    scheduleAgentInactivityWatchdog(sessionId, record.taskId); // still processing
    return;
  }
  if (engineStatus === "unknown") {
    if (!isUnknownRecheck) {
      // First unknown probe: give the session one short recheck, never loop.
      scheduleAgentInactivityWatchdog(sessionId, record.taskId, true);
    } else {
      // Second probe still unknown/absent: the session is orphaned.
      setTaskState(sessionId, "failed", "agent-inactive");
      logTask("failed", resolveTaskIdForSession(sessionId), sessionId, "reason=agent-inactive unknown-persistent");
      clearActiveAgentRequest(sessionId);
      cancelAgentInactivityWatchdog(sessionId);
    }
    return;
  }
  // engineStatus === "idle": the session stopped but nothing concluded on its
  // own. Let the authoritative determination decide once (question, approval or
  // completion all flow through it). If it still cannot conclude, the task is
  // really stuck beyond the deadline.
  await runIdleDetermination(sessionId, record.taskId, true);
  const after = taskRecords.get(sessionId);
  if (after && after.state === "running") {
    setTaskState(sessionId, "failed", "agent-inactive");
    logTask("failed", resolveTaskIdForSession(sessionId), sessionId, "reason=agent-inactive");
    clearActiveAgentRequest(sessionId);
  }
  cancelAgentInactivityWatchdog(sessionId);
}

// Authoritative completion/queue determination, executed every time the
// engine signals the session finished its current cycle (session.idle).
// 1) pending permission  -> waiting_for_approval (UI shows the approval)
// 2) trailing question   -> waiting_for_user     (UI shows the question)
// 3) otherwise           -> completed            (real completion)
// The determination runs BEFORE the idle event is forwarded, so the renderer
// can never conclude a task that actually needs user input.
//
// A question does NOT depend on sawBusy: a turn that ends in a text question
// (no tool/file/permission afterwards) may never produce a busy status. The
// fresh assistant message alone is enough evidence the engine worked on THIS
// task, so the sawBusy guard only protects the "completed" decision, never
// the question detection.
function scheduleIdleRecheck(sessionId: string, taskId: string) {
  if (idleRecheckTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    idleRecheckTimers.delete(sessionId);
    void runIdleDetermination(sessionId, taskId);
  }, 1100);
  idleRecheckTimers.set(sessionId, timer);
}

// Single short recheck for the message-commit race: session.idle can arrive
// before the final assistant text is visible in the message endpoint. Instead
// of concluding "completed" (and missing a real question), we wait one short
// bounded cycle and re-run the determination. Deduplicated by task+session:
// at most one pending recheck at a time, and it never loops.
function scheduleQuestionCommitRecheck(sessionId: string, taskId: string) {
  const key = taskId ? `${taskId}:${sessionId}` : `:${sessionId}`;
  if (questionRecheckTimers.has(key)) return;
  const timer = setTimeout(() => {
    questionRecheckTimers.delete(key);
    // isQuestionRecheck=true: if the recheck still finds no new question it
    // must follow the normal completion flow instead of re-scheduling again.
    void runIdleDetermination(sessionId, taskId, true);
  }, 900);
  questionRecheckTimers.set(key, { timer, taskId });
}

// Shared question detection: a fresh (>= task start) assistant message that
// clearly ends with "?" transitions the task to waiting_for_user. Returns
// true when it did. Duplicates are tracked by lastAssistantMessageId so the
// same message never re-asks the user. When in planMode, text questions serve
// as a graceful fallback when the model did not invoke the native plan_exit tool.
function tryDetectQuestion(record: TaskRecord, latest: { id: string; text: string; created: number } | null): boolean {
  if (!latest?.text) return false;
  if (!(normalizeTimestamp(latest.created) >= normalizeTimestamp(record.createdAt))) return false; // message from an older task
  if (record.lastAssistantMessageId === latest.id && record.askedQuestionIds.length > 0) return false; // duplicate
  if (detectQuestion(latest.text)) {
    const isPlanApproval = Boolean(record.planMode);
    record.lastAssistantMessageId = latest.id;
    const questionId = `q${(++taskQuestionCounter).toString(36)}`;
    record.askedQuestionIds.push(questionId);
    setTaskState(record.sessionId, "waiting_for_user", isPlanApproval ? "plan-approval-asked" : "question-asked", {
      questionId,
      question: latest.text,
      options: extractQuestionOptions(latest.text),
      allowFreeText: true,
      isPlanApproval,
      isTextualFallback: isPlanApproval
    });
    logTask("question", record.taskId, record.sessionId, `questionId=${questionId} planFallback=${isPlanApproval}`);
    return true;
  }
  return false;
}

async function runIdleDetermination(sessionId: string, taskId: string, isQuestionRecheck = false) {
  if (!sessionId) return;
  const record = taskRecords.get(sessionId);
  if (!record) return; // idle without an in-flight task is not a task event
  if (record.state === "completed" || record.state === "cancelled" || record.state === "failed") return;

  // An idle before the engine ever started processing this task is chatter
  // (for example the idle state left by the previous task). It must never
  // conclude the task. BUT a turn that ends in a plain-text question may
  // never have produced a busy status; the fresh assistant message is enough
  // evidence it worked on THIS task. sawBusy must not block that question.
  if (!record.sawBusy) {
    // The engine must be genuinely idle: session.idle can race a busy engine
    // and a partial streamed text ending in "?" is not a real question.
    const engineStatus = await fetchSessionEngineStatus(sessionId);
    const currentAfterStatus = taskRecords.get(sessionId);
    if (currentAfterStatus !== record) return; // a new task replaced this one mid-check
    if (engineStatus === "busy" || engineStatus === "retry") {
      scheduleIdleRecheck(sessionId, taskId);
      return;
    }
    if (engineStatus === "unknown") return;
    const latest = await fetchLatestAssistantMessage(sessionId);
    const currentAfterMessages = taskRecords.get(sessionId);
    if (currentAfterMessages !== record) return; // a new task replaced this one mid-check
    if (tryDetectQuestion(record, latest)) return;
    // Pure chatter (no busy, no question): never conclude.
    return;
  }

  // Debounce: OpenCode can emit transient idle between queued actions. Only
  // finalize after the engine stayed quiet for ~1s; a recheck is scheduled
  // in case no further idle event arrives.
  const quietFor = Date.now() - (record.lastActivityAt || record.createdAt);
  if (quietFor < 900) {
    scheduleIdleRecheck(sessionId, taskId);
    return;
  }

  if (record.state === "waiting_for_user" || record.state === "waiting_for_approval") {
    // Re-check pending permissions: an approval can appear after a question
    // was already detected.
    if (record.state === "waiting_for_user") {
      const pending = await fetchPendingPermissions(sessionId);
      const current = taskRecords.get(sessionId);
      if (current !== record) return; // a new task replaced this one
      if (pending.length) {
        const latestPermission = pending[pending.length - 1];
        setTaskState(sessionId, "waiting_for_approval", "permission-pending", { permission: latestPermission });
        logTask("approval-required", taskId, sessionId, `permission=${String(latestPermission?.id ?? "").slice(0, 12)}`);
      }
    }
    return;
  }

  const gate = idleDeterminationGate.get(sessionId);
  const now = Date.now();
  if (gate?.running) return;
  if (gate && now - gate.lastAt < 750) return;
  idleDeterminationGate.set(sessionId, { running: true, lastAt: now });
  try {
    // The engine must be idle for the completion/queue decision. A busy or
    // retrying engine means the task is still being processed: schedule a
    // recheck instead of finalizing prematurely.
    const engineStatus = await fetchSessionEngineStatus(sessionId);
    const currentBeforePermission = taskRecords.get(sessionId);
    if (currentBeforePermission !== record) return; // a new task replaced this one mid-check
    if (engineStatus === "busy" || engineStatus === "retry") {
      scheduleIdleRecheck(sessionId, taskId);
      return;
    }
    const pending = await fetchPendingPermissions(sessionId);
    const current = taskRecords.get(sessionId);
    if (current !== record) return; // a new task replaced this one mid-check
    if (pending.length) {
      const latestPermission = pending[pending.length - 1];
      setTaskState(sessionId, "waiting_for_approval", "permission-pending", { permission: latestPermission });
      logTask("approval-required", taskId, sessionId, `permission=${String(latestPermission?.id ?? "").slice(0, 12)}`);
      return;
    }
    const latest = await fetchLatestAssistantMessage(sessionId);
    const currentAfterMessages = taskRecords.get(sessionId);
    if (currentAfterMessages !== record) return; // a new task replaced this one mid-check
    if (tryDetectQuestion(record, latest)) return;
    // Message-commit race: the engine reached idle but the message endpoint
    // is not exposing the newest streamed assistant message yet (an older,
    // non-question assistant message can be returned instead). Concluding
    // "completed" on that older message would miss a question that is only
    // seconds away. One short deduplicated recheck gives the commit a chance;
    // after that recheck (isQuestionRecheck=true) the normal flow below runs.
    const messageIsFresh = Boolean(latest?.id) && latest != null && latest.created >= record.createdAt;
    const streamedAnchor = record.lastStreamedAssistantMessageId;
    const commitRacing = Boolean(streamedAnchor) && latest != null && latest.id !== streamedAnchor;
    if (!isQuestionRecheck && (!messageIsFresh || commitRacing)) {
      scheduleQuestionCommitRecheck(sessionId, taskId);
      return;
    }
    clearActiveAgentRequest(sessionId);
    setTaskState(sessionId, "completed", "session-idle");
    logTask("completion-detected", taskId, sessionId);
    logTask("completed", taskId, sessionId);
  } finally {
    const gateEntry = idleDeterminationGate.get(sessionId);
    if (gateEntry) {
      gateEntry.running = false;
      gateEntry.lastAt = Date.now();
    }
  }
}

function resetTaskRuntime() {
  cancelSseReconnect("task-runtime-reset");
  for (const active of activeAgentRequests.values()) {
    if (active.retryTimer) clearTimeout(active.retryTimer);
  }
  activeAgentRequests.clear();
  forwardedSessionStatus.clear();
  engineRetryStates.clear();
  retryExhaustedSessions.clear();
  taskRecords.clear();
  sessionTaskIds.clear();
  taskQuestionCounter = 0;
  idleDeterminationGate.clear();
  for (const timer of idleRecheckTimers.values()) clearTimeout(timer);
  idleRecheckTimers.clear();
  for (const entry of questionRecheckTimers.values()) clearTimeout(entry.timer);
  questionRecheckTimers.clear();
  for (const entry of agentInactiveTimers.values()) clearTimeout(entry.timer);
  agentInactiveTimers.clear();
  unknownStatusTrack.clear();
  diagMessageLogCounts.clear();
  postAckDiagScheduled.clear();
  previewErrorEmissionAt.clear();
  clearVisionFallbackSessions();
  cancelAllSiteClones();
  clearStatusCache();
}

// True when the event shows the agent doing real work (tools, commands,
// permissions or a real project file), as opposed to status chatter.
// file.watcher.updated is NOT agent activity: the filesystem watcher fires
// for HMR writes, external editors and build caches as well, so it must
// never count as agent progress.
function isRealAgentActivity(eventType: string, props: any): boolean {
  if (eventType.startsWith("tool.")) return true;
  if (eventType === "command.executed" || eventType === "permission.asked" || eventType === "question.asked") return true;
  if (eventType === "message.part.updated" && String(props?.part?.type ?? "") === "tool") return true;
  // message.part.updated always belongs to the assistant message being
  // streamed (user messages arrive as message.updated with their own role),
  // exactly like the tool-part case above. A real text part of that message
  // is agent activity: it proves the engine is producing content for THIS
  // task. Synthetic/ignored parts (system chatter, token bookkeeping) are NOT
  // activity and never count.
  if (eventType === "message.part.updated" && String(props?.part?.type ?? "") === "text") {
    const text = props?.part?.text;
    if (typeof text !== "string" || !text.trim()) return false;
    if (props?.part?.synthetic === true || props?.part?.ignored === true) return false;
    return true;
  }
  if (eventType === "file.edited") {
    const filePath = String(props?.file?.path ?? props?.filePath ?? props?.path ?? (typeof props?.file === "string" ? props.file : "") ?? "");
    return Boolean(filePath) && !shouldIgnoreEventPath(filePath);
  }
  return false;
}

function extractAgentError(raw: any) {
  const error = raw?.error ?? raw?.properties?.error ?? raw;
  const data = error?.data ?? {};
  const responseBody = data?.responseBody ?? error?.responseBody ?? "";
  let body: any = {};
  if (typeof responseBody === "string" && responseBody.trim()) { try { body = JSON.parse(responseBody); } catch {} }
  else if (responseBody && typeof responseBody === "object") body = responseBody;
  const nested = body?.error ?? data?.error ?? {};
  const statusCode = Number(data?.statusCode ?? error?.statusCode ?? raw?.statusCode ?? 0) || 0;
  const code = String(nested?.code ?? data?.code ?? error?.code ?? "").trim();
  const message = String(nested?.message ?? data?.message ?? error?.message ?? raw?.message ?? "").trim();
  const retryable = typeof data?.isRetryable === "boolean" ? data.isRetryable : undefined;
  return { statusCode, code, message, retryable };
}

function isRecoverableAgentError(raw: any) {
  const { statusCode, message, retryable } = extractAgentError(raw);
  if (retryable === false) return false;
  if (retryable === true) return true;
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500 || /temporar|overload|upstream|timeout|streaming|gateway|connection reset|service unavailable/i.test(message);
}

function emitAgentRetry(sessionId: string, attempt: number, delayMs: number, reason: string) {
  mainWindow?.webContents.send("opencode:event", { type: "neko.agent.retrying", properties: { sessionID: sessionId, attempt, maxAttempts: AGENT_RETRY_DELAYS_MS.length + 1, delayMs, reason } });
}

function clearActiveAgentRequest(sessionId: string) {
  const active = activeAgentRequests.get(sessionId);
  if (active?.retryTimer) clearTimeout(active.retryTimer);
  activeAgentRequests.delete(sessionId);
}

function scheduleAgentRetry(sessionId: string, rawError: any) {
  const active = activeAgentRequests.get(sessionId);
  if (!active || active.retryTimer) return Boolean(active);
  const index = active.attempts - 1;
  if (index >= AGENT_RETRY_DELAYS_MS.length) return false;
  const delayMs = AGENT_RETRY_DELAYS_MS[index];
  const diagnostic = extractAgentError(rawError);
  const reason = diagnostic.message || (diagnostic.statusCode ? `HTTP ${diagnostic.statusCode}` : "falha temporária do serviço");
  active.attempts += 1;
  active.isRetrying = true;
  emitAgentRetry(sessionId, active.attempts - 1, delayMs, reason);
  active.retryTimer = setTimeout(async () => {
    const current = activeAgentRequests.get(sessionId);
    if (!current) return;
    current.retryTimer = undefined;
    try {
      const response = await fetchWithTimeout(`${opencodeUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json", ...opencodeRequestHeaders() }, body: JSON.stringify(current.requestBody) }, 30000);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const synthetic = { error: { data: { statusCode: response.status, message: body.slice(0, 500), isRetryable: response.status >= 500 || response.status === 429 } } };
        if (!scheduleAgentRetry(sessionId, synthetic)) {
          mainWindow?.webContents.send("opencode:event", { type: "session.error", properties: synthetic.error });
          clearActiveAgentRequest(sessionId);
        }
        return;
      }
      current.isRetrying = false;
      perfMark("t2", sessionId);
      console.log(`[Neko/Agent] retry aceito session=${sessionId} attempt=${current.attempts}`);
    } catch (error: any) {
      const synthetic = { error: { data: { message: String(error?.message ?? error), isRetryable: true } } };
      if (!scheduleAgentRetry(sessionId, synthetic)) {
        mainWindow?.webContents.send("opencode:event", { type: "session.error", properties: synthetic.error });
        clearActiveAgentRequest(sessionId);
      }
    }
  }, delayMs);
  return true;
}

// GitHub integration (desktop Device Flow)
// The Client ID is public by design; the Device Flow does not require a client secret.
const GITHUB_CLIENT_ID = "Iv23liMdHRjxBRF0WoHo";
const GITHUB_APP_SLUG = "nekoai-built-for-creators";
const githubAuthFile = () => path.join(app.getPath("userData"), "github-auth.json");

// GitHub Device Flow lifecycle state
interface GithubAuthState {
  attemptId: string | null;
  abortController: AbortController | null;
  pollPromise: Promise<void> | null;
  activeTimeout: NodeJS.Timeout | null;
  isStarting: boolean;
}

const githubAuthState: GithubAuthState = {
  attemptId: null,
  abortController: null,
  pollPromise: null,
  activeTimeout: null,
  isStarting: false,
};

function cancelGithubAuthorization(reason: string = "unspecified"): void {
  console.log(`[GitHub OAuth] Cleanup started (reason: ${reason})`);
  console.log("[GitHub OAuth] Authorization cancelled");

  if (githubAuthState.activeTimeout) {
    try {
      clearTimeout(githubAuthState.activeTimeout);
    } catch {}
    githubAuthState.activeTimeout = null;
  }

  if (githubAuthState.abortController) {
    try {
      console.log("[GitHub OAuth] Polling aborted");
      githubAuthState.abortController.abort();
    } catch {}
    githubAuthState.abortController = null;
  }

  githubAuthState.attemptId = null;
  githubAuthState.pollPromise = null;
  githubAuthState.isStarting = false;

  console.log("[GitHub OAuth] Authorization state cleared");
  console.log("[GitHub OAuth] Cleanup completed");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(new DOMException("Aborted", "AbortError"));
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      if (githubAuthState.activeTimeout === timer) {
        githubAuthState.activeTimeout = null;
      }
      resolve();
    }, ms);

    githubAuthState.activeTimeout = timer;

    const onAbort = () => {
      clearTimeout(timer);
      if (githubAuthState.activeTimeout === timer) {
        githubAuthState.activeTimeout = null;
      }
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type GithubUser = { login: string; name?: string | null; avatarUrl?: string | null; id?: number | null; email?: string | null };
type GithubRepo = { id: number; name: string; fullName: string; private: boolean; htmlUrl: string; defaultBranch?: string | null };
type GithubCapabilities = { canReadRepositories: boolean; canWriteContents: boolean; canCreateRepository: boolean };
type GitChangedFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  staged: boolean;
};

type GitStatusSummary = {
  modified: number;
  untracked: number;
  deleted: number;
  staged: number;
  total: number;
};

type GitStatus = {
  initialized: boolean;
  branch: string | null;
  remote: string | null;
  linkedRepo: string | null;
  dirty: boolean;
  changedFiles?: GitChangedFile[];
  summary?: GitStatusSummary;
};


type GithubAuthRecord = { token: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number };

function readGithubAuth(): GithubAuthRecord | null {
  try {
    const raw = fs.readFileSync(githubAuthFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.encrypted, "base64")));
  } catch {
    return null;
  }
}

function writeGithubAuth(record: GithubAuthRecord) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("O armazenamento seguro do Windows não está disponível.");
  const encrypted = safeStorage.encryptString(JSON.stringify(record)).toString("base64");
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(githubAuthFile(), JSON.stringify({ encrypted }, null, 2), "utf8");
}

function clearGithubAuth() {
  try { fs.rmSync(githubAuthFile(), { force: true }); } catch {}
}


async function getGithubAccessToken(): Promise<string> {
  let auth = readGithubAuth();
  if (!auth?.token) throw new Error("GitHub não está conectado.");

  if (auth.expiresAt && Date.now() >= auth.expiresAt - 60_000) {
    if (!auth.refreshToken) throw new Error("A autorização do GitHub expirou. Conecte o GitHub novamente.");
    const refreshed = await refreshGithubAccessToken(auth).catch(() => false);
    if (!refreshed) {
      clearGithubAuth();
      throw new Error("A autorização do GitHub expirou. Conecte o GitHub novamente.");
    }
    auth = readGithubAuth();
  }

  if (!auth?.token) throw new Error("GitHub não está conectado.");
  return auth.token;
}

function formatGitHubGitError(result: { code: number; stdout: string; stderr: string }, action: string) {
  const raw = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  const lower = raw.toLowerCase();

  if (result.code === 124 || lower.includes("demorou mais que o esperado") || lower.includes("timed out") || lower.includes("operation timed out")) {
    return "O Git demorou mais que o esperado para responder. Verifique sua conexão e tente novamente.";
  }
  if (lower.includes("authentication failed") || lower.includes("invalid username or token") || lower.includes("could not read username")) {
    return `Não foi possível autenticar no GitHub durante ${action}. Conecte o GitHub novamente e tente outra vez.`;
  }
  if (lower.includes("repository not found") || /\b404\b/.test(lower)) {
    return `O repositório não foi encontrado ou o NekoAI não tem acesso a ele.`;
  }
  if (/\b403\b/.test(lower) || lower.includes("forbidden") || lower.includes("permission to")) {
    return `O GitHub recusou o acesso ao repositório. Verifique as permissões do NekoAI para este repositório.`;
  }
  if (/\b401\b/.test(lower) || lower.includes("unauthorized")) {
    return `A autorização do GitHub não permitiu esta operação. Conecte o GitHub novamente e tente outra vez.`;
  }
  if (lower.includes("could not resolve host") || lower.includes("failed to connect") || lower.includes("connection timed out")) {
    return `Não foi possível conectar ao GitHub durante ${action}. Verifique sua conexão com a internet e tente novamente.`;
  }
  if (lower.includes("local changes") || lower.includes("would be overwritten by checkout") || lower.includes("please commit your changes or stash them")) {
    return "Existem alterações locais não salvas que seriam sobrescritas. Faça commit ou descarte as alterações antes de trocar de branch.";
  }
  if (lower.includes("already exists") || lower.includes("already on")) {
    return `Não foi possível ${action}. O branch já existe ou já está ativo.`;
  }
  if (lower.includes("conflict") || lower.includes("merge conflict")) {
    return "Não foi possível trocar de branch porque existem conflitos ou alterações incompatíveis.";
  }
  if (lower.includes("not a commit and a branch") || lower.includes("not a valid object name")) {
    return `Não foi possível ${action}. O branch especificado não existe ou é inválido.`;
  }

  return `Não foi possível ${action}. ${raw || "O Git retornou um erro inesperado."}`;
}

type TaskCheckpointFile = { relativePath: string; data: Buffer; mode?: number };
type TaskCheckpoint = { id: string; projectPath: string; createdAt: number; files: TaskCheckpointFile[]; totalBytes: number };
const taskCheckpoints = new Map<string, TaskCheckpoint>();

function invalidateProjectCheckpoints(projectPath: string) {
  const root = path.resolve(projectPath);
  for (const [key, value] of taskCheckpoints) {
    if (value.projectPath === root) taskCheckpoints.delete(key);
  }
}

type ActiveGitProcess = {
  pid: number;
  projectPath: string;
  args: string[];
  startTime: number;
  child: ChildProcess;
};
const activeGitProcesses = new Map<number, ActiveGitProcess>();
let activePublishAbortController: AbortController | null = null;

function killChildProcessTree(pid: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function isGitProcessRunningForProject(projectPath: string): Promise<boolean> {
  const normPath = path.resolve(projectPath).toLowerCase();

  // 1. Check internal NekoAI git processes
  for (const proc of activeGitProcesses.values()) {
    if (path.resolve(proc.projectPath).toLowerCase() === normPath) {
      return true;
    }
  }

  // 2. Check external OS processes (Windows)
  if (process.platform === "win32") {
    try {
      const check = await new Promise<boolean>((resolve) => {
        const ps = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name = 'git.exe' or Name = 'git-remote-https.exe'" | Select-Object -ExpandProperty CommandLine`
        ], { windowsHide: true });
        let out = "";
        ps.stdout?.on("data", c => { out += c.toString(); });
        ps.on("close", () => {
          const lines = out.toLowerCase();
          if (lines.includes(normPath) || lines.includes(normPath.replace(/\\/g, "/"))) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        ps.on("error", () => resolve(false));
        setTimeout(() => {
          try { ps.kill(); } catch {}
          resolve(false);
        }, 1500);
      });
      if (check) return true;
    } catch {}
  }

  return false;
}

function isFileHandleLocked(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r+");
    fs.closeSync(fd);
    return false;
  } catch (err: any) {
    if (err?.code === "EBUSY" || err?.code === "EPERM" || err?.code === "EACCES") {
      return true;
    }
    return false;
  }
}

async function cleanupStaleGitLocks(projectPath: string): Promise<void> {
  const gitDir = path.join(projectPath, ".git");
  if (!fs.existsSync(gitDir)) return;

  const lockFiles: string[] = [];
  const indexLock = path.join(gitDir, "index.lock");
  if (fs.existsSync(indexLock)) lockFiles.push(indexLock);

  const headLock = path.join(gitDir, "HEAD.lock");
  if (fs.existsSync(headLock)) lockFiles.push(headLock);

  const configLock = path.join(gitDir, "config.lock");
  if (fs.existsSync(configLock)) lockFiles.push(configLock);

  const refsDir = path.join(gitDir, "refs");
  if (fs.existsSync(refsDir)) {
    const findRefLocks = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) findRefLocks(full);
          else if (entry.isFile() && entry.name.endsWith(".lock")) lockFiles.push(full);
        }
      } catch {}
    };
    findRefLocks(refsDir);
  }

  if (lockFiles.length === 0) return;

  // Check if an active git process is running
  let isRunning = await isGitProcessRunningForProject(projectPath);
  if (isRunning) {
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 300));
      isRunning = await isGitProcessRunningForProject(projectPath);
      if (!isRunning) break;
    }
  }

  if (isRunning) {
    throw new Error(
      "Existe outro processo do Git em execução neste repositório. Aguarde o término da operação ou finalize o processo antes de continuar."
    );
  }

  // No active git process running - lock is stale/orphaned
  for (const lockFile of lockFiles) {
    try {
      if (fs.existsSync(lockFile)) {
        if (isFileHandleLocked(lockFile)) {
          await new Promise(r => setTimeout(r, 400));
        }
        fs.rmSync(lockFile, { force: true });
        console.log(`[Neko/Git] Lock órfão removido com sucesso: ${path.relative(projectPath, lockFile)}`);
      }
    } catch (err) {
      console.warn(`[Neko/Git] Não foi possível remover lock órfão ${lockFile}:`, err);
    }
  }
}

function cancelCurrentPublishOperation(projectPath?: string) {
  if (activePublishAbortController) {
    try { activePublishAbortController.abort(); } catch {}
    activePublishAbortController = null;
  }
  if (projectPath) {
    const norm = path.resolve(projectPath).toLowerCase();
    for (const [pid, proc] of activeGitProcesses) {
      if (path.resolve(proc.projectPath).toLowerCase() === norm) {
        killChildProcessTree(pid);
        activeGitProcesses.delete(pid);
      }
    }
    setTimeout(() => {
      cleanupStaleGitLocks(projectPath).catch(() => {});
    }, 200);
  }
}

async function ensureGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, ".gitignore");
  const defaultEntries = [
    "node_modules",
    "dist",
    "build",
    ".neko",
    ".env",
    ".env.local",
    ".env.*.local",
    "*.log",
    ".DS_Store",
    "Thumbs.db"
  ];

  if (!fs.existsSync(gitignorePath)) {
    const content = defaultEntries.join("\n") + "\n";
    await fs.promises.writeFile(gitignorePath, content, "utf8");
    console.log("[Neko/Git] Arquivo .gitignore criado com sucesso.");
  } else {
    try {
      const existing = await fs.promises.readFile(gitignorePath, "utf8");
      const lines = existing.split(/\r?\n/).map(l => l.trim());
      const missing = defaultEntries.filter(e => !lines.includes(e));
      if (missing.length > 0) {
        const append = (existing.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n";
        await fs.promises.writeFile(gitignorePath, existing + append, "utf8");
      }
    } catch {}
  }
}

const gitProjectLocks = new Map<string, Promise<any>>();

async function withProjectGitLock<T>(projectPath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectPath);
  const previous = gitProjectLocks.get(key) || Promise.resolve();
  let release: () => void;
  const current = new Promise<void>(res => { release = res; });
  gitProjectLocks.set(key, previous.then(() => current, () => current));

  try {
    await previous;
    await cleanupStaleGitLocks(projectPath);
    return await task();
  } finally {
    try {
      await cleanupStaleGitLocks(projectPath);
    } catch {}
    release!();
    if (gitProjectLocks.get(key) === current) {
      gitProjectLocks.delete(key);
    }
  }
}

async function refreshGithubAccessToken(auth: GithubAuthRecord) {
  if (!auth.refreshToken) return false;
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken
    })
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) return false;
  writeGithubAuth({
    token: String(data.access_token),
    expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : auth.expiresAt,
    refreshToken: data.refresh_token ? String(data.refresh_token) : auth.refreshToken,
    refreshExpiresAt: typeof data.refresh_token_expires_in === "number" ? Date.now() + data.refresh_token_expires_in * 1000 : auth.refreshExpiresAt
  });
  return true;
}

async function githubApi(pathname: string, init: RequestInit = {}) {
  const auth = readGithubAuth();
  if (!auth?.token) throw new Error("GitHub não está conectado.");
  const response = await fetchWithTimeout(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${auth.token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      ...(init.headers || {})
    }
  });
  if (response.status === 401) {
    clearGithubAuth();
    throw new Error("A autorização do GitHub expirou ou foi revogada.");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
  }
  return response;
}


function runGit(
  projectPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 45000,
  signal?: AbortSignal
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Operação Git cancelada."));
    }

    let resolved = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn("git", args, {
      cwd: projectPath,
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const pid = child.pid;
    if (pid) {
      activeGitProcesses.set(pid, {
        pid,
        projectPath,
        args,
        startTime: Date.now(),
        child
      });
    }

    const cleanupProcess = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pid) activeGitProcesses.delete(pid);
    };

    const abortHandler = () => {
      if (resolved) return;
      resolved = true;
      cleanupProcess();
      if (pid) killChildProcessTree(pid);
      reject(new Error("Operação Git cancelada."));
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    let stdout = "";
    let stderr = "";

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanupProcess();
        if (pid) killChildProcessTree(pid);
        resolve({
          code: 124,
          stdout: stdout.trim(),
          stderr: "O Git demorou mais que o esperado para responder. Verifique sua conexão e tente novamente."
        });
      }, timeoutMs);
    }

    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", err => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      cleanupProcess();
      if (resolved) return;
      resolved = true;
      reject(err);
    });
    child.on("exit", code => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      cleanupProcess();
      if (resolved) return;
      resolved = true;
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

async function runGitWithGithubAuth(
  projectPath: string,
  args: string[],
  token: string,
  timeoutMs = 45000,
  signal?: AbortSignal
) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nekoai-git-auth-"));
  const askpassPath = path.join(tempRoot, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");

  try {
    // The token is supplied only through the child process environment and a
    // short-lived askpass helper. It is never placed in Git's command-line
    // arguments, remote URLs, or .git/config.
    if (process.platform === "win32") {
      const script = "@echo off\r\necho %NEKO_GITHUB_TOKEN%\r\n";
      await fs.promises.writeFile(askpassPath, script, { encoding: "utf8", mode: 0o700 });
    } else {
      const script = "#!/bin/sh\nprintf '%s\\n' \"$NEKO_GITHUB_TOKEN\"\n";
      await fs.promises.writeFile(askpassPath, script, { encoding: "utf8", mode: 0o700 });
      await fs.promises.chmod(askpassPath, 0o700);
    }

    return await runGit(projectPath, [
      // Disable every configured Git credential helper for this operation.
      // Otherwise Windows Git Credential Manager can intercept the request
      // and open its own "Connect to GitHub" window, forcing a second login.
      "-c",
      "credential.helper=",
      "-c",
      "credential.username=x-access-token",
      ...args
    ], {
      // Force Git to use our short-lived askpass helper instead of any
      // interactive credential UI. The token never reaches argv, the remote
      // URL, or .git/config.
      GIT_ASKPASS: askpassPath,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
      NEKO_GITHUB_TOKEN: token
    }, timeoutMs, signal);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function parseGitStatusPorcelain(output: string): { files: GitChangedFile[]; summary: GitStatusSummary } {
  const files: GitChangedFile[] = [];
  const lines = output.split(/\r?\n/).filter(line => line.length >= 3);
  let modifiedCount = 0;
  let untrackedCount = 0;
  let deletedCount = 0;
  let stagedCount = 0;

  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    let filePath = line.slice(3).trim();
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ")[1].trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    let status: GitChangedFile["status"] = "modified";
    const isStaged = x !== " " && x !== "?" && x !== "!";

    if (x === "?" && y === "?") {
      status = "untracked";
      untrackedCount++;
    } else if (x === "D" || y === "D") {
      status = "deleted";
      deletedCount++;
    } else if (x === "A" || y === "A") {
      status = "added";
      modifiedCount++;
    } else if (x === "R" || y === "R") {
      status = "renamed";
      modifiedCount++;
    } else {
      status = "modified";
      modifiedCount++;
    }

    if (isStaged) {
      stagedCount++;
    }

    files.push({
      path: filePath.replaceAll("\\", "/"),
      status,
      staged: isStaged
    });
  }

  return {
    files,
    summary: {
      modified: modifiedCount,
      untracked: untrackedCount,
      deleted: deletedCount,
      staged: stagedCount,
      total: files.length
    }
  };
}

const GIT_PROTECTED_DISCARD_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.git/i,
  /^\.neko/i,
  /^node_modules/i
];

function isProtectedFromDiscard(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const base = path.basename(normalized);
  return GIT_PROTECTED_DISCARD_PATTERNS.some(pattern => pattern.test(base) || pattern.test(normalized));
}

async function getGitStatus(): Promise<GitStatus> {
  const emptySummary: GitStatusSummary = { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 };
  if (!currentProject) {
    return { initialized: false, branch: null, remote: null, linkedRepo: null, dirty: false, changedFiles: [], summary: emptySummary };
  }

  const inside = await runGit(currentProject, ["rev-parse", "--is-inside-work-tree"], {}, 10000);
  if (inside.code !== 0 || inside.stdout !== "true") {
    return { initialized: false, branch: null, remote: null, linkedRepo: null, dirty: false, changedFiles: [], summary: emptySummary };
  }

  const branchResult = await runGit(currentProject, ["branch", "--show-current"], {}, 10000);
  const remoteResult = await runGit(currentProject, ["remote", "get-url", "origin"], {}, 10000);
  const dirtyResult = await runGit(currentProject, ["status", "--porcelain", "-uall"], {}, 15000);

  const parsed = parseGitStatusPorcelain(dirtyResult.stdout);

  const remote = remoteResult.code === 0 && remoteResult.stdout ? remoteResult.stdout : null;
  const linkedRepo = remote
    ? remote
        .replace(/^git@github\.com:/i, "")
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "")
    : null;

  return {
    initialized: true,
    branch: branchResult.code === 0 && branchResult.stdout ? branchResult.stdout : null,
    remote,
    linkedRepo,
    dirty: parsed.files.length > 0,
    changedFiles: parsed.files,
    summary: parsed.summary
  };
}

async function getGithubStatus() {
  let auth = readGithubAuth();
  if (!auth?.token) return { connected: false, repos: [] as GithubRepo[] };
  if (auth.expiresAt && Date.now() >= auth.expiresAt - 60_000 && auth.refreshToken) {
    const refreshed = await refreshGithubAccessToken(auth).catch(() => false);
    if (refreshed) auth = readGithubAuth();
  }
  try {
    const userResponse = await githubApi("/user");
    const userJson: any = await userResponse.json();
    const user: GithubUser = {
      login: String(userJson.login || ""),
      name: userJson.name ?? null,
      avatarUrl: userJson.avatar_url ?? null,
      id: typeof userJson.id === "number" ? userJson.id : null,
      email: userJson.email ?? null
    };

    // GitHub App user access tokens do NOT use OAuth scopes. Their effective
    // permissions come from the GitHub App + the user's approved installation.
    // The installation endpoint exposes the permissions actually granted.
    const installations: any[] = [];
    for (let page = 1; ; page++) {
      const installationsResponse = await githubApi(`/user/installations?per_page=100&page=${page}`);
      const installationsJson: any = await installationsResponse.json();
      const pageItems = Array.isArray(installationsJson?.installations) ? installationsJson.installations : [];
      installations.push(...pageItems);
      if (pageItems.length < 100) break;
    }

    const appInstallations = installations.filter((installation: any) => {
      const slug = String(installation?.app_slug || "").toLowerCase();
      const name = String(installation?.app?.name || "").toLowerCase();
      return slug === GITHUB_APP_SLUG || slug.includes("nekoai") || name.includes("nekoai");
    });

    const permissionsList = appInstallations.map((installation: any) => installation?.permissions || {});
    const hasContentsWrite = permissionsList.some((permissions: any) => String(permissions.contents || "").toLowerCase() === "write");
    const hasAdministrationWrite = permissionsList.some((permissions: any) => String(permissions.administration || "").toLowerCase() === "write");
    const capabilities: GithubCapabilities = {
      canReadRepositories: appInstallations.length > 0,
      canWriteContents: hasContentsWrite,
      canCreateRepository: hasAdministrationWrite
    };

    if (appInstallations.length === 0) {
      return {
        connected: true,
        user,
        repos: [],
        needsInstallation: true,
        needsReauthorization: false,
        capabilities,
        installUrl: `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`
      };
    }

    const repoMap = new Map<number, GithubRepo>();
    for (const installation of appInstallations) {
      const installationId = Number(installation?.id);
      if (!installationId) continue;

      for (let page = 1; ; page++) {
        const reposResponse = await githubApi(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
        const reposJson: any = await reposResponse.json();
        const repos = Array.isArray(reposJson?.repositories) ? reposJson.repositories : [];

        for (const repo of repos) {
          repoMap.set(Number(repo.id), {
            id: Number(repo.id),
            name: String(repo.name),
            fullName: String(repo.full_name),
            private: Boolean(repo.private),
            htmlUrl: String(repo.html_url),
            defaultBranch: repo.default_branch ?? null
          });
        }

        if (repos.length < 100) break;
      }
    }

    // Missing repository permissions are a configuration/approval issue, not
    // an OAuth-scope issue. Do not create a reauthorization loop for valid
    // GitHub App user tokens.
    const needsPermissions = !capabilities.canWriteContents || !capabilities.canCreateRepository;

    return {
      connected: true,
      user,
      repos: Array.from(repoMap.values()).sort((a, b) => a.fullName.localeCompare(b.fullName)),
      needsInstallation: false,
      needsReauthorization: false,
      needsPermissions,
      capabilities,
      installUrl: `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`
    };
  } catch (error) {
    return { connected: false, repos: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function pollGithubDevice(deviceCode: string, intervalSeconds: number, attemptId: string, signal: AbortSignal) {
  let waitSeconds = Math.max(5, Number(intervalSeconds) || 5);
  const deadline = Date.now() + 15 * 60 * 1000;

  try {
    while (Date.now() < deadline) {
      if (signal.aborted || githubAuthState.attemptId !== attemptId) {
        return;
      }

      await abortableDelay(waitSeconds * 1000, signal);

      if (signal.aborted || githubAuthState.attemptId !== attemptId) {
        return;
      }

      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }),
        signal
      });

      if (signal.aborted || githubAuthState.attemptId !== attemptId) {
        return;
      }

      const data: any = await response.json().catch(() => ({}));

      if (signal.aborted || githubAuthState.attemptId !== attemptId) {
        return;
      }

      if (data.access_token) {
        writeGithubAuth({
          token: String(data.access_token),
          expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
          refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
          refreshExpiresAt: typeof data.refresh_token_expires_in === "number" ? Date.now() + data.refresh_token_expires_in * 1000 : undefined
        });

        // Clean up pending session state on completion
        if (githubAuthState.attemptId === attemptId) {
          githubAuthState.attemptId = null;
          githubAuthState.abortController = null;
          githubAuthState.pollPromise = null;
          githubAuthState.isStarting = false;
        }

        const status = await getGithubStatus();
        mainWindow?.webContents.send("github:event", { type: "github.connected", properties: status });
        return;
      }

      const error = String(data.error || "");
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        waitSeconds = Math.max(waitSeconds + 5, Number(data.interval) || waitSeconds + 5);
        continue;
      }
      if (error === "expired_token") throw new Error("O código de autorização do GitHub expirou.");
      if (error === "access_denied") throw new Error("A autorização do GitHub foi recusada.");
      if (error) throw new Error(`GitHub: ${error}`);
    }

    throw new Error("O tempo para autorizar o GitHub terminou. Inicie a conexão novamente.");
  } catch (error: any) {
    if (signal.aborted || error?.name === "AbortError" || githubAuthState.attemptId !== attemptId) {
      return;
    }
    throw error;
  }
}

// Basic Auth headers for a locally-authenticated OpenCode server. When the
// OPENCODE_SERVER_USERNAME/PASSWORD env vars are present, OpenCode enables
// HTTP Basic Auth on every endpoint; without the header every request (health,
// session, message, permission, event...) returns 401. These credentials are
// consumed ONLY by this helper and are NEVER logged. With no env vars set the
// helper returns an empty object so the pre-existing unauthenticated flow is
// unchanged. Applies solely to the local OpenCode server, never to external
// hosts (GitHub/Supabase/Vercel/Resend) — the token is only layered into the
// OpenCode-destined headers below.
function opencodeAuthHeaders(): Record<string, string> {
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!username && !password) return {};
  const token = Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

// Combined headers for any HTTP request aimed at the local OpenCode server:
// Basic Auth (when configured) plus the existing x-opencode-directory header.
function opencodeRequestHeaders(): Record<string, string> {
  return { ...opencodeAuthHeaders(), ...opencodeDirectoryHeaders() };
}

function opencodeDirectoryHeaders(): Record<string, string> {
  const root = getActiveProjectRoot();
  return root ? { "x-opencode-directory": encodeURIComponent(root) } : {};
}

async function getOpencodeClient() {
  const sdk = await import("@opencode-ai/sdk");
  const directory = getActiveProjectRoot();
  return sdk.createOpencodeClient({
    baseUrl: opencodeUrl,
    throwOnError: true,
    // Keep the original x-opencode-directory behavior; layer the Basic Auth
    // header when the local server requires it.
    headers: opencodeAuthHeaders(),
    ...(directory ? { directory } : {})
  });
}

function resolveExecutableFromPath(name: string): string | null {
  if (process.platform === "win32") {
    try {
      const res = spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => Boolean(l) && fs.existsSync(l));

        if (lines.length > 0) {
          // 1. Prefer binary executable if available (.exe)
          const exeMatch = lines.find(l => l.toLowerCase().endsWith(".exe"));
          if (exeMatch) return exeMatch;

          // 2. Prefer Windows cmd launcher (.cmd)
          const cmdMatch = lines.find(l => l.toLowerCase().endsWith(".cmd"));
          if (cmdMatch) return cmdMatch;

          // 3. Prefer batch file (.bat)
          const batMatch = lines.find(l => l.toLowerCase().endsWith(".bat"));
          if (batMatch) return batMatch;

          // 4. If an extensionless file is matched (e.g. npm bash wrapper), check if corresponding .cmd exists
          for (const line of lines) {
            const potentialCmd = `${line}.cmd`;
            if (fs.existsSync(potentialCmd)) return potentialCmd;
            const potentialExe = `${line}.exe`;
            if (fs.existsSync(potentialExe)) return potentialExe;
          }

          // Fallback to first line if nothing else matched
          return lines[0];
        }
      }
    } catch {}
  }

  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const ext of extensions) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, ext ? `${name}${ext}` : name);
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            if (process.platform === "win32" && !ext) {
              const cmdSibling = `${candidate}.cmd`;
              if (fs.existsSync(cmdSibling)) return cmdSibling;
              const exeSibling = `${candidate}.exe`;
              if (fs.existsSync(exeSibling)) return exeSibling;
            }
            return candidate;
          }
        } catch {}
      }
    }
  }
  return null;
}

function getOpencodePath(): string {
  // 1) Explicit override remains supported for development/troubleshooting.
  if (process.env.NEKO_OPENCODE_PATH) {
    const override = path.resolve(process.env.NEKO_OPENCODE_PATH);
    if (fs.existsSync(override)) {
      if (process.platform === "win32" && !path.extname(override)) {
        const cmdSibling = `${override}.cmd`;
        if (fs.existsSync(cmdSibling)) return cmdSibling;
        const exeSibling = `${override}.exe`;
        if (fs.existsSync(exeSibling)) return exeSibling;
      }
      return override;
    }
    console.warn("[Neko/OpenCode] NEKO_OPENCODE_PATH was set but does not exist:", override);
  }

  const candidateNames = process.platform === "win32"
    ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    : ["opencode"];

  // 2) Bundled with the source/dev build: <project>/tools/opencode(.exe/.cmd)
  for (const name of candidateNames) {
    const projectTools = path.resolve(__dirname, "..", "..", "tools", name);
    if (fs.existsSync(projectTools)) return projectTools;
  }

  // 3) Packaged Electron app: extraResource copied to resources/tools.
  for (const name of candidateNames) {
    const packagedTools = path.join(process.resourcesPath, "tools", name);
    if (fs.existsSync(packagedTools)) return packagedTools;
  }

  // 4) Development fallback for bun installed binaries
  for (const name of candidateNames) {
    const bunPath = path.join(os.homedir(), ".bun", "bin", name);
    if (fs.existsSync(bunPath)) return bunPath;
  }

  // 5) Search system PATH and where.exe (handles npm global install like opencode.cmd, bun, scoop, etc.)
  const resolved = resolveExecutableFromPath("opencode");
  if (resolved) return resolved;

  // 6) Last resort: allow OpenCode to be invoked by name on PATH.
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer(url: string, timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${url}/global/health`, { headers: opencodeRequestHeaders() });
      if (response.ok) return await response.json();
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`OpenCode não iniciou em ${url}.`);
}

function stopProjectWatcher() {
  if (projectWatchTimer) { clearTimeout(projectWatchTimer); projectWatchTimer = null; }
  try { projectWatcher?.close(); } catch {}
  projectWatcher = null;
}

const WATCHER_IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".vite", ".cache", ".next", ".nuxt", ".output", ".turbo", "coverage", ".astro", ".svelte-kit", "tmp", "temp"
]);
const WATCHER_IGNORED_SUFFIXES = [".lock", ".log", ".tmp"];
const WATCHER_IGNORED_PATTERNS = [/\.timestamp-[^/]+\.mjs$/i];

function shouldIgnoreWatcherPath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return true;
  const parts = normalized.split("/");
  if (parts.some(part => WATCHER_IGNORED_DIRS.has(part))) return true;
  if (WATCHER_IGNORED_SUFFIXES.some(suffix => normalized.toLowerCase().endsWith(suffix))) return true;
  if (WATCHER_IGNORED_PATTERNS.some(pattern => pattern.test(normalized))) return true;
  return false;
}

function startProjectWatcher(projectPath: string, gen?: number) {
  stopProjectWatcher();
  const watcherGen = typeof gen === "number" ? gen : projectTransitionGeneration;
  try {
    const watcher = fs.watch(projectPath, { recursive: true }, (_eventType, filename) => {
      const changedPath = filename ? String(filename).replaceAll("\\", "/") : "";
      if (shouldIgnoreWatcherPath(changedPath)) return;
      if (activeWorkspace && activeWorkspace.generation !== watcherGen) {
        console.log(`[Watcher] stale event ignored path=${changedPath} generation=${watcherGen} activeGeneration=${activeWorkspace.generation}`);
        return;
      }
      if (projectWatchTimer) clearTimeout(projectWatchTimer);
      projectWatchTimer = setTimeout(() => {
        projectWatchTimer = null;
        if (activeWorkspace && activeWorkspace.generation !== watcherGen) return;
        console.log("[Neko/Files] alteração detectada", changedPath || "projeto");
        perfMark("t5");
        mainWindow?.webContents.send("opencode:event", {
          type: "neko.project.changed",
          properties: { path: changedPath, generation: watcherGen }
        });
        handleProjectFileChange(projectPath, changedPath);
      }, 120);
    });
    watcher.on("error", (err: any) => {
      console.warn("[Neko/Files] watcher error:", err?.message ?? err);
      stopProjectWatcher();
    });
    projectWatcher = watcher;
    if (activeWorkspace && activeWorkspace.generation === watcherGen) {
      activeWorkspace.watcher = watcher;
    }
    console.log("[Neko/Files] watcher ativo", projectPath, `gen=${watcherGen}`);
  } catch (error: any) {
    console.warn("[Neko/Files] não foi possível iniciar watcher:", error?.message ?? error);
  }
}

async function startOpenCodeInternal(projectPath: string, transitionGen?: number) {
  const safeProjectPath = assertProjectRootSafe(projectPath, "start-service");
  logProjectWorkspace("start-service", safeProjectPath);
  clearStatusCache();
  forwardedSessionStatus.clear();

  const executable = getOpencodePath();
  const port = await findFreePort(4097);
  opencodeUrl = `http://127.0.0.1:${port}`;
  currentProject = safeProjectPath;
  startProjectWatcher(safeProjectPath, transitionGen);

  console.log("[Neko/OpenCode] starting", { executable, projectPath: safeProjectPath, port, generation: transitionGen });
  logService("starting", `project=${safeProjectPath} port=${port} gen=${transitionGen}`);

  const isWindows = process.platform === "win32";
  const isCmdLauncher = isWindows && /\.(cmd|bat)$/i.test(executable);
  const spawnExecutable = isCmdLauncher ? (process.env.ComSpec || "cmd.exe") : executable;
  const rawArgs = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
  const spawnArgs = isCmdLauncher
    ? ["/d", "/s", "/c", windowsCommandLine(executable, rawArgs)]
    : rawArgs;

  const child = spawn(
    spawnExecutable,
    spawnArgs,
    {
      cwd: safeProjectPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  opencodeProcess = child;
  const processRef = child;
  let exited = false;
  let exitMessage = "";
  const stderrLogs: string[] = [];
  const stdoutLogs: string[] = [];

  if (activeWorkspace && (typeof transitionGen !== "number" || activeWorkspace.generation === transitionGen)) {
    activeWorkspace.opencodeProcess = child;
    activeWorkspace.opencodeUrl = opencodeUrl;
    activeWorkspace.opencodePort = port;
  }

  processRef.stdout?.on("data", chunk => {
    const text = chunk.toString();
    console.log("[Neko/OpenCode]", text);
    if (stdoutLogs.length < 20) stdoutLogs.push(text.trim());
    mainWindow?.webContents.send("preview:event", { type: "terminal.output", properties: { stream: "stdout", text, source: "Neko" } });
  });

  processRef.stderr?.on("data", chunk => {
    const text = chunk.toString();
    console.error("[Neko/OpenCode]", text);
    if (stderrLogs.length < 20) stderrLogs.push(text.trim());
    mainWindow?.webContents.send("preview:event", { type: "terminal.output", properties: { stream: "stderr", text, source: "Neko" } });
    if (/ServeError|Error:|Unexpected error|EADDRINUSE|address already in use/i.test(text)) {
      exitMessage = text.trim();
    }
  });

  processRef.on("error", error => {
    exited = true;
    exitMessage = `Erro ao executar ${spawnExecutable}: ${error.message}`;
    console.error("[Neko/OpenCode] process error:", error);
    if (!isStoppingOpencodeIntentionally) {
      mainWindow?.webContents.send("opencode:event", {
        type: "neko.process.error",
        properties: { message: exitMessage, generation: transitionGen }
      });
    }
  });

  processRef.on("exit", (code, signal) => {
    exited = true;
    if (!exitMessage) {
      const details = stderrLogs.join(" | ") || stdoutLogs.join(" | ");
      exitMessage = `OpenCode encerrou (código ${code}, ${signal ?? "sem sinal"}). Executável: ${executable}.${details ? ` Detalhes: ${details}` : ""}`;
    }
    if (typeof transitionGen === "number" && activeWorkspace && activeWorkspace.generation !== transitionGen) {
      console.log(`[OpenCode] stale process exit ignored { generation: ${transitionGen}, activeGeneration: ${activeWorkspace.generation} }`);
      return;
    }
    if (isStoppingOpencodeIntentionally) {
      console.log("[Neko/OpenCode] exited (encerramento normal)", { code, signal, generation: transitionGen });
    } else {
      console.log("[Neko/OpenCode] exited", { code, signal, generation: transitionGen });
    }
    if (opencodeProcess === processRef) opencodeProcess = null;
    if (activeWorkspace && (typeof transitionGen !== "number" || activeWorkspace.generation === transitionGen)) {
      activeWorkspace.opencodeProcess = null;
      activeWorkspace.status = "stopped";
    }
  });

  // The gate promise resolves only when THIS start is confirmed healthy. A
  // later generation (stop/reopen) invalidates any readiness claim made by a
  // stale start.
  const generation = serviceGeneration;
  const startPromise = (async () => {
    const startedAt = Date.now();
    const timeout = 20000;
    let lastError = "";

    while (Date.now() - startedAt < timeout) {
      if (exited) {
        throw new Error(`OpenCode não conseguiu iniciar. ${exitMessage}`.trim());
      }

      try {
        const response = await fetchWithTimeout(`${opencodeUrl}/global/health`, { headers: opencodeRequestHeaders() }, 2500);
        if (response.ok) {
          const health = await response.json();
          if (generation !== serviceGeneration || (typeof transitionGen === "number" && transitionGen !== projectTransitionGeneration)) {
            throw new Error("Inicialização do serviço interrompida.");
          }
          serviceReady = true;
          serviceReadyUrl = opencodeUrl;
          logService("ready", opencodeUrl);
          void subscribeEvents(transitionGen);

          // The renderer may ask for providers before OpenCode is ready.
          // Emit a dedicated readiness event only after the health endpoint
          // confirms that this project's OpenCode instance is usable.
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            try {
              mainWindow.webContents.send("opencode:event", {
                type: "neko.opencode.ready",
                properties: { projectPath: safeProjectPath, url: opencodeUrl, port, generation: transitionGen }
              });
            } catch {}
          }

          return health;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error: any) {
        lastError = String(error?.message ?? error);
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`OpenCode não iniciou em ${opencodeUrl}. ${lastError}`.trim());
  })();

  serviceStartPromise = startPromise;
  try {
    return await startPromise;
  } finally {
    if (serviceStartPromise === startPromise) serviceStartPromise = null;
  }
}

async function startOpenCode(projectPath: string) {
  await stopOpenCode();
  await stopPreview();
  void supabaseManager.setProject(projectPath);
  void vercelManager.setProject(projectPath);
  return startOpenCodeInternal(projectPath);
}

async function stopOpenCode() {
  cancelSseReconnect("stop-opencode");
  isStoppingOpencodeIntentionally = true;
  clearStatusCache();
  perfFlushTask(null, "stopped");
  engineRetryStates.clear();
  retryExhaustedSessions.clear();
  sessionModelLabels.clear();
  sessionTaskIds.clear();
  attemptedErrorSignatures.clear();
  invalidateServiceGate();
  for (const [sessionId, active] of activeAgentRequests) {
    if (active.retryTimer) clearTimeout(active.retryTimer);
    activeAgentRequests.delete(sessionId);
  }
  stopProjectWatcher();
  eventAbort?.abort();
  eventAbort = null;

  const proc = opencodeProcess;
  opencodeProcess = null;

  if (!proc) {
    isStoppingOpencodeIntentionally = false;
    return;
  }

  try {
    if (process.platform === "win32" && proc.pid) {
      await new Promise<void>(resolve => {
        const killer = spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
    } else {
      try { proc.kill("SIGTERM"); } catch {}
    }
  } finally {
    isStoppingOpencodeIntentionally = false;
  }
}

async function subscribeEvents(gen?: number) {
  const streamGen = typeof gen === "number" ? gen : (activeWorkspace?.generation ?? projectTransitionGeneration);
  if (isStoppingOpencodeIntentionally || !opencodeProcess) {
    return;
  }
  if (activeWorkspace && activeWorkspace.generation !== streamGen) {
    return;
  }

  // Clear any existing reconnect timer when (re)connecting
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  eventAbort?.abort();
  eventAbort = new AbortController();
  const currentSignal = eventAbort.signal;
  if (activeWorkspace && activeWorkspace.generation === streamGen) {
    activeWorkspace.eventAbort = eventAbort;
  }

  const isReconnect = sseReconnectAttempts > 0;

  try {
    const response = await fetch(`${opencodeUrl}/event`, {
      signal: currentSignal,
      headers: { Accept: "text/event-stream", ...opencodeRequestHeaders() }
    });

    if (!response.ok || !response.body) {
      throw new Error(`OpenCode events retornou HTTP ${response.status}.`);
    }

    if (currentSignal.aborted) return;
    if (activeWorkspace && activeWorkspace.generation !== streamGen) return;

    if (isReconnect) {
      console.log(`[OpenCode/SSE] reconnect success gen=${streamGen}`);
    } else {
      console.log(`[OpenCode/SSE] connected gen=${streamGen}`);
    }
    sseReconnectAttempts = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!currentSignal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find(line => line.startsWith("data:"));
        if (!dataLine) continue;

        try {
          const event = JSON.parse(dataLine.slice(5).trim());
          const eventType = String(event?.type ?? "");
          const props = event?.properties ?? {};
          perfCountEvent("received");
          const perfSessionId = String(props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? event?.sessionID ?? event?.sessionId ?? "");
          // The Vision Fallback runs on an auxiliary session. Its events must
          // never reach the renderer: no terminal noise, no busy revival, no
          // permission cards, no task state influence.
          const fallbackIdCandidates = [perfSessionId, String(props?.info?.id ?? ""), String(event?.sessionID ?? "")];
          if (fallbackIdCandidates.some(id => id && isVisionFallbackSession(id))) {
            continue;
          }
          // Observed-only diagnostics for message events (never changes logic,
          // never logs text content — only structural facts, sampled).
          if (eventType === "message.updated" || eventType === "message.part.updated") {
            logSampledMessageEvent(eventType, props, perfSessionId);
          }
          if (eventType.startsWith("tool.execute") || eventType.startsWith("file.") || eventType.startsWith("permission.") || eventType.startsWith("session.") || eventType === "command.executed") {
            const toolName = props?.tool ?? props?.name ?? props?.part?.tool ?? "";
            const toolInput = props?.input ?? props?.part?.state?.input ?? {};
            const filePath = props?.file?.path ?? props?.filePath ?? props?.path ?? props?.file ?? "";
            const command = toolInput?.command ?? toolInput?.cmd ?? "";
            const status = props?.status?.type ?? props?.status ?? "";
            const permission = props?.permission ?? props?.permissionID ?? props?.id ?? "";
            const detail = eventType.startsWith("tool.") ? `tool=${String(toolName).slice(0, 80)}${filePath ? ` path=${String(filePath).slice(-160)}` : ""}${command ? ` cmd=${String(command).slice(0, 160)}` : ""}`
              : eventType.startsWith("file.") ? `path=${String(filePath).slice(-180)}`
              : eventType.startsWith("permission.") ? `permission=${String(permission).slice(0, 100)}`
              : eventType.startsWith("session.") ? `status=${String(status)}`
              : `command=${String(command).slice(0, 160)}`;
            // Avoid flooding stdout with the very high-frequency OpenCode
            // session.updated/session.diff/busy events. Logging every event can
            // become surprisingly expensive on Windows terminals and makes it
            // harder to diagnose the actual model/tool latency. Tool/file/error
            // events remain fully visible; repetitive session events are sampled.
            const repetitiveSessionEvent = eventType === "session.updated" || eventType === "session.diff" || (eventType === "session.status" && (status === "busy" || status === "idle"));
            if (!repetitiveSessionEvent) {
              console.log(`[Neko/Agent] ${eventType} ${detail}`);
            } else {
              const now = Date.now();
              const last = (globalThis as any).__nekoLastSessionLog ?? 0;
              if (now - last >= 2500) {
                (globalThis as any).__nekoLastSessionLog = now;
                console.log(`[Neko/Agent] ${eventType} ${detail} (amostrado)`);
              }
            }
          }
          // Real agent activity (tools, commands, permissions, real files).
          // Status chatter (busy/retry/idle) is never activity. Real activity
          // proves the engine recovered and resets the retry watchdog.
          const realActivity = isRealAgentActivity(eventType, props);
          if (realActivity && perfSessionId) {
            const retryState = engineRetryStates.get(perfSessionId);
            if (retryState) retryState.cycles = 0;
            const taskRecord = taskRecords.get(perfSessionId);
            if (taskRecord) {
              taskRecord.sawBusy = true;
              taskRecord.lastActivityAt = Date.now();
            }
          }
          // Track the newest assistant message the stream exposed. This is the
          // commit-race anchor: if session.idle arrives but the message API
          // does not yet return THIS message, the final text is still being
          // committed and the task must not conclude as completed (it could be
          // a question that is seconds away).
          if (perfSessionId) {
            const streamedMessageId =
              eventType === "message.updated" && String(props?.info?.role ?? "") === "assistant"
                ? String(props?.info?.id ?? "")
                : eventType === "message.part.updated"
                  ? String(props?.part?.messageID ?? props?.info?.id ?? "")
                  : "";
            if (streamedMessageId) {
              const taskRecord = taskRecords.get(perfSessionId);
              if (taskRecord) taskRecord.lastStreamedAssistantMessageId = streamedMessageId;
            }
          }
          // session.idle is the engine's completion confirmation for the task.
          // Before forwarding it, the state machine decides whether this idle
          // is a real completion, an approval request or an interactive
          // question. The resulting state is pushed first so the renderer can
          // never conclude a task that needs user input.
          if (eventType === "session.idle") {
            const idleSessionId = perfSessionId;
            const active = activeAgentRequests.get(idleSessionId);
            if (active?.retryTimer || active?.isRetrying) {
              console.log(`[Neko/Agent] session.idle recebido durante retry ativo (ignorado) session=${idleSessionId}`);
              continue;
            }
            const taskId = resolveTaskIdForSession(idleSessionId);
            console.log(`[TaskLifecycle] event=session.idle session=${idleSessionId || "default"} taskId=${taskId || "none"}`);
            perfMark("t8", idleSessionId);
            perfFlushTask(idleSessionId, "idle");
            await runIdleDetermination(idleSessionId, taskId);
            event.properties = { ...(event.properties ?? {}), taskId: taskId || undefined, sessionID: idleSessionId || undefined };
          }
          if (perfEnabled) {
            // First event of the session after acceptance (T3).
            perfMark("t3", perfSessionId);
            // First real agent activity (T4). Retries/busy are NOT activity.
            if (realActivity) perfMark("t4", perfSessionId);
            // First real file altered by the agent (T5): file events whose
            // path survives the technical-path filter (.git, node_modules...).
            if (eventType.startsWith("file.")) {
              const perfFilePath = String(props?.file?.path ?? props?.filePath ?? props?.path ?? (typeof props?.file === "string" ? props.file : "") ?? "");
              if (perfFilePath && !shouldIgnoreEventPath(perfFilePath)) perfMark("t5", perfSessionId);
            }
          }
          if (eventType === "session.error") {
            const sessionId = String(props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? "");
            if (sessionId && isRecoverableAgentError(event) && scheduleAgentRetry(sessionId, event)) continue;
            if (sessionId) {
              clearActiveAgentRequest(sessionId);
              engineRetryStates.delete(sessionId);
              if (taskRecords.has(sessionId)) {
                setTaskState(sessionId, "failed", "session-error");
                logTask("failed", resolveTaskIdForSession(sessionId), sessionId);
              }
            }
            perfFlushTask(sessionId, "error");
          }
          if (eventType === "session.status") {
            const sessionId = String(props?.sessionID ?? props?.sessionId ?? props?.session?.id ?? "");
            const statusType = String(props?.status?.type ?? props?.status ?? "").toLowerCase();
            const statusMessage = String(props?.status?.message ?? props?.status?.error ?? "");
            if (["idle", "completed", "done"].includes(statusType)) perfMark("t7", sessionId);
            if (statusType === "retry" && sessionId && !retryExhaustedSessions.has(sessionId)) {
              let retryState = engineRetryStates.get(sessionId);
              if (!retryState) {
                retryState = { cycles: 0, phase: "idle", reason: "", lastRetryAt: 0 };
                engineRetryStates.set(sessionId, retryState);
              }
              // A full failed cycle is busy -> retry. busy -> busy -> retry
              // chatter counts only once.
              if (retryState.phase === "busy") retryState.cycles += 1;
              retryState.phase = "retry";
              if (statusMessage && !retryState.reason) retryState.reason = statusMessage;
              const retryGap = retryState.lastRetryAt > 0 ? Date.now() - retryState.lastRetryAt : 0;
              retryState.lastRetryAt = Date.now();
              console.warn(`[Neko/Agent] retry do motor session=${sessionId.slice(0, 8)} model=${sessionModelLabels.get(sessionId) ?? "?"} cycles=${retryState.cycles}${retryGap ? ` gap=${retryGap}ms` : ""} reason=${logSafeText(statusMessage || retryState.reason) || "-"}`);
              perfRetryStart(statusMessage || retryState.reason);
              if (retryState.cycles >= ENGINE_MAX_RETRY_CYCLES) {
                // Recovery failed: stop the endless retry loop, tell the user
                // and keep the diagnostics. Never abandon the task silently.
                const finalReason = logSafeText(retryState.reason, 280);
                console.error(`[Neko/Agent] recuperação falhou session=${sessionId.slice(0, 8)} model=${sessionModelLabels.get(sessionId) ?? "?"} cycles=${retryState.cycles} reason=${finalReason || "-"}`);
                engineRetryStates.delete(sessionId);
                retryExhaustedSessions.add(sessionId);
                clearActiveAgentRequest(sessionId);
                if (taskRecords.has(sessionId)) {
                  setTaskState(sessionId, "failed", "retry-exhausted");
                  logTask("failed", resolveTaskIdForSession(sessionId), sessionId);
                }
                // Ask the engine to stop its internal retry loop.
                void fetch(`${opencodeUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
                  method: "POST",
                  headers: opencodeRequestHeaders()
                }).catch(() => {});
                mainWindow?.webContents.send("opencode:event", {
                  type: "session.error",
                  properties: {
                    sessionID: sessionId,
                    error: {
                      data: {
                        message: finalReason
                          ? `A execução não avançou após várias tentativas. Motivo: ${finalReason}`
                          : "A execução não avançou após várias tentativas. Verifique o provedor e o modelo selecionados e tente novamente.",
                        isRetryable: false
                      }
                    }
                  }
                });
                perfFlushTask(sessionId, "recovery-failed");
              }
            } else if (statusType === "busy") {
              perfRetryEnd();
              const retryState = engineRetryStates.get(sessionId);
              if (retryState) retryState.phase = "busy";
              // The engine resumed by itself (for example an auto-approved
              // permission): approval state goes back to running.
              // NOTE: waiting_for_user is NOT cleared here because the engine stays
              // busy while awaiting the user's answer to the native question tool.
              const record = taskRecords.get(sessionId);
              if (record) {
                record.sawBusy = true;
                record.lastActivityAt = Date.now();
                if (record.state === "waiting_for_approval") {
                  setTaskState(sessionId, "running", "engine-resumed");
                }
              }
            } else if (statusType === "idle" || statusType === "completed" || statusType === "done") {
              engineRetryStates.delete(sessionId);
              const taskId = resolveTaskIdForSession(sessionId);
              event.properties = { ...(event.properties ?? {}), taskId: taskId || undefined, sessionID: sessionId || undefined };
              console.log(`[TaskLifecycle] event=session.status(${statusType}) session=${sessionId || "default"} taskId=${taskId || "none"}`);
              perfMark("t8", sessionId);
              perfFlushTask(sessionId, "idle");
              // Some engine builds only surface completion through status
              // idle. The determination is deduplicated and safe to run here.
              void runIdleDetermination(sessionId, taskId);
            }
            if (sessionId && (statusType === "idle" || statusType === "completed" || statusType === "done")) {
              const active = activeAgentRequests.get(sessionId);
              if (!active?.retryTimer && !active?.isRetrying) clearActiveAgentRequest(sessionId);
            }
            // Only forward a real status transition. OpenCode can emit the same
            // busy/idle state many times per second; those repetitions do not
            // change the Neko UI and only create renderer/React work.
            if (sessionId) {
              const active = activeAgentRequests.get(sessionId);
              if ((active?.retryTimer || active?.isRetrying) && (statusType === "idle" || statusType === "completed" || statusType === "done")) {
                continue;
              }
              const previous = forwardedSessionStatus.get(sessionId);
              if (previous === statusType) continue;
              forwardedSessionStatus.set(sessionId, statusType);
            }
          }
          // session.updated/diff are internal synchronization chatter. Nothing in
          // the Neko renderer consumes them, so keep them inside the main process.
          if (eventType === "session.updated" || eventType === "session.diff") continue;
          // Native question protocol: OpenCode emits question.asked when the
          // agent uses the question tool. The task machine immediately moves to
          // waiting_for_user with the question details and requestId.
          if (eventType === "question.asked") {
            const questionSessionId = String(props?.sessionID ?? props?.sessionId ?? perfSessionId ?? "");
            const requestId = String(props?.id ?? "");
            const firstQ = Array.isArray(props?.questions) ? props.questions[0] : props?.questions;
            const questionText = String(firstQ?.question ?? props?.question ?? "").trim();
            const rawOptions = Array.isArray(firstQ?.options) ? firstQ.options : (Array.isArray(props?.options) ? props.options : []);
            const options: string[] = rawOptions.map((opt: any) => {
              if (typeof opt === "string") return opt;
              if (opt && typeof opt === "object") {
                const title = String(opt.title ?? opt.label ?? "").trim();
                const desc = String(opt.description ?? "").trim();
                if (title && desc) return `${title} — ${desc}`;
                return title || desc || JSON.stringify(opt);
              }
              return String(opt ?? "");
            }).filter(Boolean);
            const allowFreeText = firstQ?.custom !== false && props?.custom !== false;
            const questionId = requestId || `q${(++taskQuestionCounter).toString(36)}`;

            const record = taskRecords.get(questionSessionId);
            const header = String(firstQ?.header ?? props?.header ?? "").trim();
            const isPlanApproval =
              header.toLowerCase() === "build agent" ||
              /plan\s+at\s+.*is\s+complete/i.test(questionText) ||
              props?.tool === "plan_exit" ||
              Boolean(record?.planMode && options.some(o => /switch to build agent|start implementing|stay with plan/i.test(o)));

            if (record) {
              record.askedQuestionIds.push(questionId);
            }
            console.log(`[TaskLifecycle] native question.asked session=${questionSessionId} requestId=${requestId} isPlan=${isPlanApproval} text=${questionText.slice(0, 60)}`);
            setTaskState(questionSessionId, "waiting_for_user", isPlanApproval ? "plan-approval-asked" : "question-asked", {
              questionId,
              requestId,
              isNativeTool: true,
              isPlanApproval,
              question: questionText,
              options,
              allowFreeText
            });
            logTask("question", record?.taskId ?? "", questionSessionId, `requestId=${requestId} native=true planApproval=${isPlanApproval}`);
          }
          if (eventType === "question.replied" || eventType === "question.rejected") {
            const questionSessionId = String(props?.sessionID ?? props?.sessionId ?? perfSessionId ?? "");
            if (questionSessionId && taskRecords.has(questionSessionId)) {
              setTaskState(questionSessionId, "running", eventType);
              logTask("user-response", resolveTaskIdForSession(questionSessionId), questionSessionId, `event=${eventType}`);
            }
          }
          // Approval protocol: permission.updated is the engine asking for an
          // approval. It is normalized to permission.asked for the renderer and
          // the task machine moves to waiting_for_approval. permission.replied
          // is the user's decision (approve or reject); the agent continues
          // from where it stopped — a rejection is never a technical error.
          if (eventType === "permission.updated") {
            const permissionSessionId = String(props?.sessionID ?? props?.sessionId ?? "");
            if (permissionSessionId && taskRecords.has(permissionSessionId)) {
              setTaskState(permissionSessionId, "waiting_for_approval", "permission-asked", { permission: props });
              logTask("approval-required", resolveTaskIdForSession(permissionSessionId), permissionSessionId, `permission=${String(props?.id ?? "").slice(0, 12)}`);
            }
            event.type = "permission.asked";
          }
          if (eventType === "permission.replied") {
            const permissionSessionId = String(props?.sessionID ?? props?.sessionId ?? "");
            if (permissionSessionId && taskRecords.has(permissionSessionId)) {
              const response = String(props?.response ?? "");
              setTaskState(permissionSessionId, "running", "permission-replied");
              logTask("user-approval", resolveTaskIdForSession(permissionSessionId), permissionSessionId, `response=${response || "answered"}`);
            }
          }
          const nekoEvent = normalizeOpenCodeEvent(event);
          if (nekoEvent) {
            perfCountEvent("forwarded");
            mainWindow?.webContents.send("opencode:event", nekoEvent);
          }
        } catch {
          // Ignore malformed SSE payloads.
        }
      }
    }
    console.log(`[OpenCode/SSE] disconnected gen=${streamGen}`);
  } catch (error: any) {
    if (error?.name !== "AbortError" && (!activeWorkspace || activeWorkspace.generation === streamGen)) {
      console.error("[Neko/OpenCode] event stream error:", error);
    }
  }

  // Auto-reconexão progressiva caso o stream tenha caído inesperadamente
  const shouldReconnect =
    !currentSignal.aborted &&
    !isStoppingOpencodeIntentionally &&
    Boolean(opencodeProcess) &&
    (!activeWorkspace || activeWorkspace.generation === streamGen);

  if (shouldReconnect) {
    if (sseReconnectAttempts < 10) {
      sseReconnectAttempts++;
      const delayMs = Math.min(10000, Math.round(500 * Math.pow(1.8, sseReconnectAttempts - 1)));
      console.log(`[OpenCode/SSE] reconnect scheduled attempt=${sseReconnectAttempts} delayMs=${delayMs} gen=${streamGen}`);
      sseReconnectTimer = setTimeout(() => {
        sseReconnectTimer = null;
        void subscribeEvents(streamGen);
      }, delayMs);
    } else {
      console.warn(`[OpenCode/SSE] reconnect attempts exhausted (${sseReconnectAttempts}) gen=${streamGen}`);
      mainWindow?.webContents.send("opencode:event", {
        type: "neko.connection.error",
        properties: { message: "Conexão com o serviço de eventos interrompida após várias tentativas.", generation: streamGen }
      });
    }
  }
}


function safePathWithinProject(projectPath: string, relativePath: string): string {
  const root = path.resolve(projectPath);
  const target = path.resolve(root, relativePath);

  if (process.platform === "win32") {
    const rootNorm = root.toLowerCase();
    const targetNorm = target.toLowerCase();
    const rootPrefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (targetNorm !== rootNorm && !targetNorm.startsWith(rootPrefix)) {
      throw new Error("Caminho fora do projeto.");
    }
  } else {
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (target !== root && !target.startsWith(rootPrefix)) {
      throw new Error("Caminho fora do projeto.");
    }
  }
  return target;
}

const IGNORED = new Set([
  "node_modules", ".git", ".next", ".turbo", "dist", "build", ".vite", ".cache"
]);

async function readTree(projectPath: string, relative = ""): Promise<any[]> {
  const absolute = safePathWithinProject(projectPath, relative);
  const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
  const result: any[] = [];

  for (const entry of entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  })) {
    if (IGNORED.has(entry.name)) continue;
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: rel.replaceAll("\\", "/"),
        type: "directory",
        children: await readTree(projectPath, rel)
      });
    } else {
      result.push({
        name: entry.name,
        path: rel.replaceAll("\\", "/"),
        type: "file"
      });
    }
  }
  return result;
}

type PreviewManagerState = {
  status: "idle" | "detecting" | "installing" | "starting" | "ready" | "error" | "stopped";
  framework: string | null;
  packageManager: string | null;
  port: number | null;
  url: string | null;
  message?: string;
  internalSession?: number;
};

let previewState: PreviewManagerState = {
  status: "idle",
  framework: null,
  packageManager: null,
  port: null,
  url: null
};

export type ProjectRuntimeType = "STATIC_HTML" | "NODE_DEV_SERVER" | "UNSUPPORTED";

export interface ProjectRuntimeDescriptor {
  type: ProjectRuntimeType;
  framework: string;
  projectRoot: string;
  preferredPort: number;
  entryHtml?: string;
  pkg?: Record<string, any> | null;
  devScript?: string | null;
  packageManager?: string;
  runtimeEntry?: string | null;
}

let previewProcess: ChildProcess | null = null;
let previewStaticServer: http.Server | null = null;
let previewPort: number | null = null;
let previewProjectPath: string | null = null;
let previewStartPromise: Promise<PreviewManagerState> | null = null;
let previewSessionCounter = 0;
let activePreviewSessionId = 0;
let previewRestartDebounceTimer: NodeJS.Timeout | null = null;
let previewStaticReloadDebounceTimer: NodeJS.Timeout | null = null;
let previewRuntimeDescriptor: ProjectRuntimeDescriptor | null = null;

// The iframe renderer remains available as a reversible fallback.  The view
// below is the opt-in internal surface: it loads the already-running Preview
// URL in a top-level guest WebContents, avoiding iframe-only behavior in SSR
// applications while keeping the dev-server lifecycle unchanged.
type InternalPreviewState = "idle" | "loading" | "ready" | "failed" | "crashed";
let internalPreviewView: WebContentsView | null = null;
let internalPreviewUrl = "";
let internalPreviewState: InternalPreviewState = "idle";
let internalPreviewSession = 0;

function logInternalPreview(state: InternalPreviewState, extra = "") {
  internalPreviewState = state;
  console.log(`[Preview/Internal] session=${internalPreviewSession} url=${internalPreviewUrl || "none"} state=${state}${extra ? ` ${extra}` : ""}`);
  try {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send("preview:event", {
      type: `preview.internal.${state}`,
      properties: { session: internalPreviewSession, url: internalPreviewUrl || null, state, message: extra || undefined }
    });
  } catch {}
}

function detachInternalPreviewView(destroy = false) {
  const view = internalPreviewView;
  if (!view) return;
  try { mainWindow?.contentView.removeChildView(view); } catch {}
  if (destroy) {
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
    internalPreviewView = null;
    internalPreviewUrl = "";
    logInternalPreview("idle");
  }
}

function isAllowedInternalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch { return false; }
}

function ensureInternalPreviewView(): WebContentsView | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (internalPreviewView && !internalPreviewView.webContents.isDestroyed()) return internalPreviewView;
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  internalPreviewView = view;
  view.webContents.setWindowOpenHandler(({ url }) => ({ action: "deny" }));
  view.webContents.on("did-start-loading", () => logInternalPreview("loading"));
  view.webContents.on("did-finish-load", () => {
    logInternalPreview("ready");
    emitInternalPreviewRoute(view.webContents.getURL());
  });
  // SPA history routing uses pushState/replaceState (did-navigate-in-page).
  // Keep the Page Selector in sync when the user clicks an internal link.
  view.webContents.on("did-navigate-in-page", (_event, url, _isMainFrame) => {
    if (!url || !isAllowedInternalPreviewUrl(url)) return;
    emitInternalPreviewRoute(url);
  });
  view.webContents.on("did-navigate", (_event, url) => {
    if (!url || !isAllowedInternalPreviewUrl(url)) return;
    emitInternalPreviewRoute(url);
  });
  view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    logInternalPreview("failed", `error=${code} description=${logSafeText(description, 160)} url=${sanitizeExternalPreviewUrl(url)}`);
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    logInternalPreview("crashed", `reason=${details.reason} exitCode=${details.exitCode}`);
  });
  view.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    mainWindow?.webContents.send("preview:event", {
      type: "preview.console",
      properties: { level, message, lineNumber: line, sourceId, internal: true }
    });
  });
  return view;
}

function emitPreview(type: string, properties: Record<string, any> = {}) {
  previewState = { ...previewState, ...properties };
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send("preview:event", { type, properties: previewState });
  } catch {}
}

// Preview Page Selector: per-project route cache to avoid rescanning on every
// call. Re-discovered on project change or explicit request; never polled.
type PreviewRoutesCache = { projectPath: string; routes: PreviewRoute[]; at: number };
let previewRoutesCache: PreviewRoutesCache | null = null;
const PREVIEW_ROUTES_CACHE_MS = 8000;

async function getPreviewRoutes(force = false): Promise<PreviewRoute[]> {
  const root = getActiveProjectRoot();
  if (!root) return [];
  if (!force && previewRoutesCache && previewRoutesCache.projectPath === root && Date.now() - previewRoutesCache.at < PREVIEW_ROUTES_CACHE_MS) {
    return previewRoutesCache.routes;
  }
  const routes = await discoverPreviewRoutes(root);
  previewRoutesCache = { projectPath: root, routes, at: Date.now() };
  return routes;
}

// Emits the current internal-preview route to the renderer so the selector
// stays in sync (used after navigate, internal link clicks and HMR reloads).
function emitInternalPreviewRoute(url: string) {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const path = routeFromUrl(url);
    mainWindow.webContents.send("preview:event", { type: "preview.route-changed", properties: { path } });
  } catch {}
}

async function readPackage(projectPath: string): Promise<Record<string, any> | null> {
  try {
    const file = path.join(projectPath, "package.json");
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolvePreviewProjectRoot(workspacePath: string, maxDepth = 3): Promise<string | null> {
  const root = path.resolve(workspacePath);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const candidates: Array<{ dir: string; depth: number; hasDev: boolean }> = [];

  while (queue.length) {
    const current = queue.shift()!;
    try {
      const pkg = await readPackage(current.dir);
      if (pkg) {
        const scripts = pkg.scripts || {};
        const hasDev = Boolean(scripts.dev || scripts.start || scripts.serve || scripts.preview);
        candidates.push({ dir: current.dir, depth: current.depth, hasDev });
      }
    } catch {}

    if (current.depth >= maxDepth) continue;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || WATCHER_IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  candidates.sort((a, b) => Number(b.hasDev) - Number(a.hasDev) || a.depth - b.depth);
  return candidates[0]?.dir ?? null;
}

async function detectProject(projectPath: string) {
  const pkg = await readPackage(projectPath);
  if (!pkg) {
    return {
      exists: false,
      pkg: null,
      framework: "Node",
      preferredPort: 3000,
      devScript: null,
      packageManager: "npm",
      runtimeEntry: null
    };
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let framework = "Node";
  let preferredPort = 3000;
  let runtimeEntry: string | null = null;

  if (deps.next) { framework = "Next.js"; preferredPort = 3000; runtimeEntry = "next"; }
  else if (deps.astro) { framework = "Astro"; preferredPort = 4321; runtimeEntry = "astro"; }
  else if (deps.remix || deps["@remix-run/react"]) { framework = "Remix"; preferredPort = 3000; runtimeEntry = "@remix-run/dev"; }
  else if (deps.nuxt) { framework = "Nuxt"; preferredPort = 3000; runtimeEntry = "nuxt"; }
  else if (deps.svelte || deps["@sveltejs/kit"]) { framework = "Svelte"; preferredPort = 5173; runtimeEntry = deps.vite ? "vite" : "@sveltejs/kit"; }
  else if (deps.vue) { framework = "Vue"; preferredPort = 5173; runtimeEntry = deps.vite ? "vite" : "vue"; }
  else if (deps["react-scripts"]) { framework = "Create React App"; preferredPort = 3000; runtimeEntry = "react-scripts"; }
  else if (deps.vite) { framework = "Vite"; preferredPort = 5173; runtimeEntry = "vite"; }

  const scripts = pkg.scripts || {};
  let devScript: string | null = null;
  if (scripts.dev) devScript = "dev";
  else if (scripts.start) devScript = "start";
  else if (scripts.serve) devScript = "serve";
  else if (scripts.preview) devScript = "preview";

  const files: string[] = await fs.promises.readdir(projectPath).catch((): string[] => []);
  let packageManager = "npm";

  // Check packageManager field first (e.g. "pnpm@8.0.0", "yarn@3.0.0", "bun@1.0.0")
  if (typeof pkg.packageManager === "string") {
    const pmLower = pkg.packageManager.toLowerCase();
    if (pmLower.startsWith("pnpm")) packageManager = "pnpm";
    else if (pmLower.startsWith("yarn")) packageManager = "yarn";
    else if (pmLower.startsWith("bun")) packageManager = "bun";
    else if (pmLower.startsWith("npm")) packageManager = "npm";
  } else if (files.includes("pnpm-lock.yaml")) {
    packageManager = "pnpm";
  } else if (files.includes("yarn.lock")) {
    packageManager = "yarn";
  } else if (files.includes("bun.lockb") || files.includes("bun.lock")) {
    packageManager = "bun";
  } else if (files.includes("package-lock.json")) {
    packageManager = "npm";
  }

  // Infer runtime entry from dev script command if not found from deps
  if (!runtimeEntry && devScript && typeof scripts[devScript] === "string") {
    const cmd = scripts[devScript].trim();
    const firstWord = cmd.split(/\s+/)[0]?.toLowerCase();
    if (["vite", "next", "astro", "nuxt", "remix", "react-scripts"].includes(firstWord)) {
      runtimeEntry = firstWord;
    }
  }

  return {
    exists: true,
    pkg,
    framework,
    preferredPort,
    devScript,
    packageManager,
    runtimeEntry
  };
}

function packageManagerExecutable(packageManager: string) {
  if (packageManager === "pnpm") return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (packageManager === "yarn") return process.platform === "win32" ? "yarn.cmd" : "yarn";
  if (packageManager === "bun") return process.platform === "win32" ? "bun.exe" : "bun";
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".xml": "application/xml; charset=utf-8"
};

async function startStaticHttpServer(projectRoot: string, port: number): Promise<http.Server> {
  const safeRoot = path.resolve(projectRoot);

  return new Promise<http.Server>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // 1. Only allow GET and HEAD methods
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed");
        return;
      }

      try {
        // 2. Decode and normalize path
        const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
        let decodedPath = "";
        try {
          decodedPath = decodeURIComponent(reqUrl.pathname);
        } catch {
          decodedPath = reqUrl.pathname;
        }

        // 3. Resolve absolute path and enforce strict directory traversal protection
        const relativePath = decodedPath.replace(/^\/+/, "");
        let targetPath = path.resolve(safeRoot, relativePath);

        const isInsideRoot = targetPath === safeRoot || targetPath.startsWith(safeRoot + path.sep);
        if (!isInsideRoot) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Forbidden: Access Denied");
          return;
        }

        // 4. File existence & directory resolution
        let fileStat: fs.Stats | null = null;
        try {
          fileStat = await fs.promises.stat(targetPath);
        } catch {}

        // If directory, try index.html inside it
        if (fileStat && fileStat.isDirectory()) {
          const indexCandidate = path.join(targetPath, "index.html");
          try {
            const indexStat = await fs.promises.stat(indexCandidate);
            if (indexStat.isFile()) {
              targetPath = indexCandidate;
              fileStat = indexStat;
            } else {
              fileStat = null;
            }
          } catch {
            fileStat = null;
          }
        }

        // If not found and has no extension, try targetPath + ".html" (clean URLs e.g. /sobre -> /sobre.html)
        if (!fileStat && !path.extname(targetPath)) {
          const htmlCandidate = targetPath + ".html";
          try {
            const htmlStat = await fs.promises.stat(htmlCandidate);
            if (htmlStat.isFile()) {
              targetPath = htmlCandidate;
              fileStat = htmlStat;
            }
          } catch {}
        }

        // 5. 404 Not Found
        if (!fileStat || !fileStat.isFile()) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>404 Not Found</title><style>body{font-family:sans-serif;padding:40px;background:#18181b;color:#f4f4f5;text-align:center;}h1{color:#ef4444;}</style></head><body><h1>404 — Página não encontrada</h1><p>O arquivo solicitado não foi encontrado no projeto.</p></body></html>`);
          return;
        }

        // 6. Content headers
        const ext = path.extname(targetPath).toLowerCase();
        const contentType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
        const headers: Record<string, string | number> = {
          "Content-Type": contentType,
          "Content-Length": fileStat.size,
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Access-Control-Allow-Origin": "*"
        };

        if (req.method === "HEAD") {
          res.writeHead(200, headers);
          res.end();
          return;
        }

        res.writeHead(200, headers);
        const stream = fs.createReadStream(targetPath);
        stream.on("error", streamErr => {
          console.warn("[Neko/StaticServer] stream error:", streamErr);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Internal Server Error");
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
      } catch (err: any) {
        console.warn("[Neko/StaticServer] request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Internal Server Error");
        } else {
          res.destroy();
        }
      }
    });

    server.once("error", err => {
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`[Neko/StaticServer] servidor ativo em http://127.0.0.1:${port} (root: ${safeRoot})`);
      resolve(server);
    });
  });
}

async function detectProjectRuntime(workspacePath: string): Promise<ProjectRuntimeDescriptor> {
  const root = path.resolve(workspacePath);

  // 1. Prioridade 1: Projeto com package.json válido + script de desenvolvimento (NODE_DEV_SERVER)
  const nodeProjectRoot = await resolvePreviewProjectRoot(root);
  if (nodeProjectRoot) {
    const nodeInfo = await detectProject(nodeProjectRoot);
    if (nodeInfo.exists && nodeInfo.devScript) {
      return {
        type: "NODE_DEV_SERVER",
        framework: nodeInfo.framework,
        projectRoot: nodeProjectRoot,
        preferredPort: nodeInfo.preferredPort,
        pkg: nodeInfo.pkg,
        devScript: nodeInfo.devScript,
        packageManager: nodeInfo.packageManager,
        runtimeEntry: nodeInfo.runtimeEntry
      };
    }
  }

  // 2. Prioridade 2: Projeto com index.html navegável (STATIC_HTML)
  const candidateDirs = [
    root,
    path.join(root, "public"),
    path.join(root, "dist"),
    path.join(root, "src")
  ];

  for (const dir of candidateDirs) {
    const candidateHtml = path.join(dir, "index.html");
    try {
      const stat = await fs.promises.stat(candidateHtml);
      if (stat.isFile()) {
        console.log(`[Neko/Preview] runtime STATIC_HTML detectado em ${dir}`);
        return {
          type: "STATIC_HTML",
          framework: "HTML/JS Estático",
          projectRoot: dir,
          preferredPort: 3000,
          entryHtml: path.relative(dir, candidateHtml) || "index.html"
        };
      }
    } catch {}
  }

  // Also check if any .html file exists in the root directory
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    const htmlEntry = entries.find(e => e.isFile() && e.name.toLowerCase().endsWith(".html"));
    if (htmlEntry) {
      console.log(`[Neko/Preview] runtime STATIC_HTML (arquivo: ${htmlEntry.name}) detectado em ${root}`);
      return {
        type: "STATIC_HTML",
        framework: "HTML/JS Estático",
        projectRoot: root,
        preferredPort: 3000,
        entryHtml: htmlEntry.name
      };
    }
  } catch {}

  // 3. Prioridade 3: Nenhum runtime reconhecido
  return {
    type: "UNSUPPORTED",
    framework: "Desconhecido",
    projectRoot: root,
    preferredPort: 3000
  };
}

async function hasDependencies(projectPath: string) {
  try {
    const stat = await fs.promises.stat(path.join(projectPath, "node_modules"));
    return stat.isDirectory();
  } catch { return false; }
}

function dependencyResolutionFailure(output: string) {
  const text = String(output || "").toLowerCase();
  return [
    "err_module_not_found",
    "cannot find package",
    "cannot find module",
    "module not found",
    "err_pnpm_",
    "missing package",
    "failed to resolve dependency",
    "could not resolve",
    "tar_entry_error",
    "enotempty",
    "missing peer dependency"
  ].some(marker => text.includes(marker));
}

async function removeNodeModules(projectPath: string): Promise<void> {
  const nodeModulesPath = path.join(projectPath, "node_modules");
  try {
    const exists = await fs.promises.stat(nodeModulesPath).then(() => true).catch(() => false);
    if (!exists) return;
  } catch {
    return;
  }

  console.log(`[Preview/Cleanup] started path=${nodeModulesPath}`);

  // Stop any active preview process first to release file locks on Windows
  await stopPreviewProcessOnly();

  // Retry loop with progressive backoff (up to 5 attempts) to accommodate Windows filesystem / OneDrive locks
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.promises.rm(nodeModulesPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
      const stillExists = await fs.promises.stat(nodeModulesPath).then(() => true).catch(() => false);
      if (!stillExists) {
        console.log(`[Preview/Cleanup] completed`);
        return;
      }
    } catch (fsErr: any) {
      console.warn(`[Preview/Cleanup] tentativa ${attempt} de remoção direta falhou:`, fsErr?.message);
    }

    if (process.platform === "win32") {
      const trashDir = path.join(projectPath, `.trash_nm_${Date.now()}_${attempt}`);
      try {
        await fs.promises.rename(nodeModulesPath, trashDir);
        // Exclusão assíncrona da pasta renomeada via Node.js nativo (evita cmd.exe com interpolação)
        void fs.promises.rm(trashDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
        console.log(`[Preview/Cleanup] completed (renamed to ${trashDir})`);
        return;
      } catch (renameErr: any) {
        console.warn(`[Preview/Cleanup] tentativa ${attempt} de rename fallback falhou:`, renameErr?.message);
        await new Promise<void>(resolve => {
          const safeTarget = path.normalize(nodeModulesPath);
          const killer = spawn("cmd.exe", ["/s", "/c", "rmdir", "/s", "/q", safeTarget], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => resolve());
          killer.once("exit", () => resolve());
        });
      }
    }

    const check = await fs.promises.stat(nodeModulesPath).then(() => true).catch(() => false);
    if (!check) {
      console.log(`[Preview/Cleanup] completed`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 400));
  }

  console.log(`[Preview/Cleanup] completed (final attempt finished)`);
}

async function verifyRuntimeDependency(projectPath: string, info: any) {
  console.log(`[Preview/Install] validation started`);
  const entry = info.runtimeEntry || (info.framework === "Vite" ? "vite" : null);
  
  // 1. Basic node_modules check
  const nmPath = path.join(projectPath, "node_modules");
  const nmExists = await fs.promises.stat(nmPath).then(s => s.isDirectory()).catch(() => false);
  if (!nmExists) {
    console.warn(`[Preview/Install] validation failed: diretório node_modules não existe.`);
    throw new Error("Diretório node_modules não existe.");
  }

  if (!entry) {
    console.log(`[Preview/Install] validation passed (basic node_modules verified)`);
    return;
  }

  // 2. Fast check: package directory exists inside node_modules
  const pkgDir = path.join(nmPath, entry);
  const pkgDirExists = await fs.promises.stat(pkgDir).then(s => s.isDirectory()).catch(() => false);
  if (!pkgDirExists) {
    console.warn(`[Preview/Install] validation failed: Pacote runtime '${entry}' não encontrado em node_modules.`);
    throw new Error(`Pacote runtime '${entry}' não encontrado em node_modules.`);
  }

  // 3. Deep runtime import validation via Node process
  const script = `import(${JSON.stringify(entry)}).then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1)})`;
  try {
    await runCommand(process.platform === "win32" ? "node.exe" : "node", ["--input-type=module", "-e", script], projectPath, "Dependency-Check");
    console.log(`[Preview/Install] validation passed`);
  } catch (err: any) {
    console.warn(`[Preview/Install] validation failed: erro ao importar '${entry}':`, err?.message || err);
    throw new Error(`Validação de integridade do runtime '${entry}' falhou.`);
  }
}

function quoteWindowsArg(value: string) {
  const s = String(value);
  if (!/[ \t&()<>^|]/.test(s)) return s;
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

function windowsCommandLine(command: string, args: string[]) {
  return [command, ...args].map((value, index) => {
    return index === 0 ? value : quoteWindowsArg(value);
  }).join(" ");
}

async function runCommand(command: string, args: string[], cwd: string, label: string) {
  return new Promise<void>((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec || "cmd.exe") : command;
    const childArgs = isWindows
      ? ["/d", "/s", "/c", windowsCommandLine(command, args)]
      : args;
    console.log(`[Neko/Preview/${label}] Executando: ${isWindows ? windowsCommandLine(command, args) : [command, ...args].join(" ")}`);
    const child = spawn(executable, childArgs, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      console.log(`[Neko/Preview/${label}]`, text);
    });
    child.stderr?.on("data", chunk => {
      const text = chunk.toString();
      stderr += text;
      console.error(`[Neko/Preview/${label}]`, text);
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${label} terminou com código ${code}.`), { code, stdout, stderr }));
    });
  });
}

async function installDependencies(projectPath: string, packageManager: string) {
  console.log(`[Preview/Install] started pm=${packageManager}`);
  const files: string[] = await fs.promises.readdir(projectPath).catch((): string[] => []);
  const hasLock = files.includes("package-lock.json");

  // Prefer clean/frozen install if lockfile is present
  if (packageManager === "npm" && hasLock) {
    try {
      await runCommand(packageManagerExecutable("npm"), ["ci"], projectPath, "Install-CI");
      console.log(`[Preview/Install] completed pm=${packageManager}`);
      return;
    } catch (ciErr) {
      console.warn("[Neko/Preview/Install] npm ci falhou, tentando fallback com npm install:", ciErr);
    }
  }

  let installArgs = ["install"];
  if (packageManager === "pnpm" && files.includes("pnpm-lock.yaml")) {
    installArgs = ["install", "--frozen-lockfile"];
  } else if (packageManager === "yarn" && files.includes("yarn.lock")) {
    installArgs = ["install", "--frozen-lockfile"];
  } else if (packageManager === "bun" && (files.includes("bun.lockb") || files.includes("bun.lock"))) {
    installArgs = ["install", "--frozen-lockfile"];
  }

  try {
    await runCommand(packageManagerExecutable(packageManager), installArgs, projectPath, "Install");
  } catch (err) {
    if (installArgs.includes("--frozen-lockfile")) {
      // Fallback without frozen lockfile
      await runCommand(packageManagerExecutable(packageManager), ["install"], projectPath, "Install-Relaxed");
    } else {
      throw err;
    }
  }
  console.log(`[Preview/Install] completed pm=${packageManager}`);
}

async function installDependenciesWithFallback(projectPath: string, preferredManager: string, info: any) {
  // Step 1: Attempt installation with preferred package manager
  let primaryPassed = false;
  try {
    await installDependencies(projectPath, preferredManager);
    await verifyRuntimeDependency(projectPath, info);
    primaryPassed = true;
    return preferredManager;
  } catch (primaryErr: any) {
    console.warn(`[Preview/Install] Falha na instalação/validação com ${preferredManager}:`, primaryErr?.message || primaryErr);
  }

  if (primaryPassed) return preferredManager;

  // If preferred manager was already npm and failed, we reached terminal failure
  if (preferredManager === "npm") {
    console.error(`[Preview] terminal failure: npm install failed`);
    throw new Error("Falha ao instalar dependências. A instalação foi tentada com npm, mas o node_modules permaneceu inválido.");
  }

  // Step 2: Single bounded fallback to npm
  console.log(`[Preview/Fallback] npm started`);
  emitPreview("preview.installing", {
    status: "installing",
    packageManager: "npm",
    message: "Ajustando as dependências com npm para iniciar o preview..."
  });

  try {
    await removeNodeModules(projectPath);
    await installDependencies(projectPath, "npm");
    await verifyRuntimeDependency(projectPath, info);
    console.log(`[Preview/Fallback] npm completed`);
    return "npm";
  } catch (fallbackErr: any) {
    console.error(`[Preview] terminal failure: fallback to npm also failed:`, fallbackErr?.message || fallbackErr);
    throw new Error("Falha ao instalar dependências. A instalação foi tentada com Bun e npm, mas o node_modules permaneceu inválido.");
  }
}

async function findFreePort(start: number, maxAttempts = 30) {
  const net = await import("node:net");
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = start + offset;
    const available = await new Promise<boolean>(resolve => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`Não encontrei uma porta livre a partir de ${start}.`);
}

async function isHttpAlive(url: string, timeoutMs = 700): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "manual" }).catch(() =>
      fetch(url, { method: "GET", signal: controller.signal, redirect: "manual" })
    );
    clearTimeout(timer);
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, timeout = 45000, processRef?: ChildProcess) {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeout) {
    if (processRef && processRef.exitCode !== null) {
      throw new Error("O servidor encerrou antes de ficar disponível.");
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error: any) {
      lastError = String(error?.message ?? error);
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`O servidor não ficou pronto em ${timeout / 1000}s. ${lastError}`.trim());
}

function previewArgs(framework: string, port: number, devScript = "dev") {
  const scriptName = devScript || "dev";
  if (framework === "Next.js" || framework === "Nuxt") return ["run", scriptName, "--", "--hostname", "127.0.0.1", "--port", String(port)];
  if (framework === "Astro") return ["run", scriptName, "--", "--host", "127.0.0.1", "--port", String(port)];
  if (framework === "Vite" || framework === "Vue" || framework === "Svelte") return ["run", scriptName, "--", "--host", "127.0.0.1", "--port", String(port)];
  if (framework === "Create React App") return ["run", scriptName];
  return ["run", scriptName, "--", "--host", "127.0.0.1", "--port", String(port)];
}

async function stopPreviewProcessOnly(): Promise<void> {
  if (previewStaticServer) {
    try {
      const server = previewStaticServer;
      previewStaticServer = null;
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        setTimeout(resolve, 300);
      });
      console.log("[Preview] static HTTP server stopped");
    } catch (err) {
      console.warn("[Preview] error stopping static HTTP server:", err);
    }
  }
  if (previewProcess) {
    const proc = previewProcess;
    previewProcess = null;
    console.log(`[Preview] cleaning up previous preview process (PID ${proc.pid})`);
    if (process.platform === "win32" && proc.pid) {
      await new Promise<void>(resolve => {
        const killer = spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
    } else {
      try { proc.kill("SIGTERM"); } catch {}
    }
  }
  previewPort = null;
}

async function stopPreview(): Promise<void> {
  const currentSession = ++previewSessionCounter;
  activePreviewSessionId = currentSession;
  console.log(`[Preview] stop session=${currentSession} path=${previewProjectPath || "none"}`);
  detachInternalPreviewView(true);
  await stopPreviewProcessOnly();
  previewProjectPath = null;
  if (activeWorkspace) {
    activeWorkspace.previewProcess = null;
    activeWorkspace.previewStaticServer = null;
    activeWorkspace.previewPort = null;
    activeWorkspace.previewUrl = null;
  }
  previewRuntimeDescriptor = null;
  previewState = { status: "stopped", framework: previewState.framework, packageManager: previewState.packageManager, port: null, url: null };
  emitPreview("preview.stopped");
}

function handleProjectFileChange(projectPath: string, changedPath: string) {
  if (!currentProject || path.resolve(currentProject) !== path.resolve(projectPath)) return;
  const normalized = (changedPath || "").replaceAll("\\", "/").toLowerCase();
  if (normalized.startsWith(".neko/") || normalized.includes("/.neko/")) return;

  // Concurrency guard: Only ONE install/boot per projectPath and generation
  if (previewStartPromise || ["detecting", "installing", "starting", "ready"].includes(previewState.status)) {
    // 1. If active preview runtime is STATIC_HTML and status is ready:
    if (previewRuntimeDescriptor?.type === "STATIC_HTML" && previewState.status === "ready") {
      const ext = path.extname(normalized);
      const isStaticAsset = [".html", ".htm", ".css", ".js", ".mjs", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".json", ".woff", ".woff2", ".ttf"].includes(ext);
      if (isStaticAsset) {
        if (previewStaticReloadDebounceTimer) clearTimeout(previewStaticReloadDebounceTimer);
        previewStaticReloadDebounceTimer = setTimeout(() => {
          previewStaticReloadDebounceTimer = null;
          if (!currentProject || path.resolve(currentProject) !== path.resolve(projectPath)) return;
          console.log(`[Neko/PreviewWatcher] Arquivo estático modificado (${changedPath}). Recarregando preview...`);
          try {
            if (internalPreviewView && !internalPreviewView.webContents.isDestroyed()) {
              internalPreviewView.webContents.reload();
            }
          } catch {}
          mainWindow?.webContents.send("preview:event", { type: "preview.frame-loading", properties: {} });
        }, 150);
      }
      return;
    }

    // 2. If active preview is NODE_DEV_SERVER: only trigger restart on config file change
    const isConfigFile = normalized.endsWith("package.json") ||
      normalized.includes("vite.config") ||
      normalized.includes("next.config") ||
      normalized.includes("astro.config") ||
      normalized.includes("nuxt.config") ||
      normalized.includes("webpack.config") ||
      normalized.includes("tsconfig.json");

    if (isConfigFile && previewState.status === "ready") {
      if (previewRestartDebounceTimer) clearTimeout(previewRestartDebounceTimer);
      previewRestartDebounceTimer = setTimeout(async () => {
        previewRestartDebounceTimer = null;
        if (!currentProject || path.resolve(currentProject) !== path.resolve(projectPath)) return;
        console.log(`[Neko/PreviewWatcher] Arquivo de configuração modificado (${changedPath}). Reiniciando dev server...`);
        void startPreview(projectPath, undefined, true).catch(err => {
          console.warn("[Neko/PreviewWatcher] Falha ao reiniciar preview:", err);
        });
      }, 1000);
    }
    return;
  }

  // 3. If preview is idle/stopped/error and a project structure appeared (index.html or package.json):
  if (!previewProcess && !previewStaticServer && (previewState.status === "idle" || previewState.status === "stopped" || previewState.status === "error")) {
    const isStructureTrigger = normalized.endsWith("package.json") || normalized.endsWith("index.html") || normalized.endsWith(".html");
    if (isStructureTrigger) {
      void detectProjectRuntime(projectPath).then(runtime => {
        if (runtime.type !== "UNSUPPORTED" && (!previewProcess && !previewStaticServer && (previewState.status === "idle" || previewState.status === "stopped" || previewState.status === "error"))) {
          console.log(`[Neko/PreviewWatcher] Estrutura de projeto (${runtime.type}) detectada em ${runtime.projectRoot}. Iniciando preview automaticamente...`);
          void startPreview(projectPath).catch(err => {
            console.warn("[Neko/PreviewWatcher] Falha na auto-inicialização do preview:", err);
          });
        }
      });
    }
  }
}

function captureProjectPreviewThumbnail(projectPath: string, url: string, force = false) {
  thumbnailService.queueCapture(projectPath, url, { force });
}

async function launchPreviewProcess(projectPath: string, info: any, packageManager: string, port: number) {
  const executable = packageManagerExecutable(packageManager);
  const args = previewArgs(info.framework, port, info.devScript);
  const previewIsWindows = process.platform === "win32";
  const previewSpawnExecutable = previewIsWindows ? (process.env.ComSpec || "cmd.exe") : executable;
  const previewSpawnArgs = previewIsWindows
    ? ["/d", "/s", "/c", windowsCommandLine(executable, args)]
    : args;

  const processRef = spawn(previewSpawnExecutable, previewSpawnArgs, {
    cwd: projectPath,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  processRef.stdout?.on("data", chunk => {
    const text = chunk.toString();
    output += text;
    mainWindow?.webContents.send("preview:event", { type: "preview.output", properties: { stream: "stdout", text, source: "Preview" } });
    console.log("[Neko/Preview]", text);
  });
  processRef.stderr?.on("data", chunk => {
    const text = chunk.toString();
    output += text;
    mainWindow?.webContents.send("preview:event", { type: "preview.output", properties: { stream: "stderr", text, source: "Preview" } });
    console.error("[Neko/Preview]", text);
  });

  const exitPromise = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    processRef.on("error", reject);
    processRef.on("exit", (code, signal) => resolve({ code: typeof code === "number" ? code : 1, signal }));
  });

  return { processRef, exitPromise, getOutput: () => output };
}

async function startStaticPreviewInternal(projectRoot: string, info: ProjectRuntimeDescriptor, sessionId: number): Promise<PreviewManagerState> {
  if (sessionId !== activePreviewSessionId) return previewState;

  emitPreview("preview.detected", {
    status: "detecting",
    framework: "HTML / Estático",
    packageManager: "none",
    message: "Projeto HTML/Estático detectado."
  });

  if (sessionId !== activePreviewSessionId) return previewState;

  const port = await findFreePort(3000);
  emitPreview("preview.starting", {
    status: "starting",
    packageManager: "none",
    port,
    message: `Iniciando servidor estático na porta ${port}...`
  });

  try {
    const server = await startStaticHttpServer(projectRoot, port);
    if (sessionId !== activePreviewSessionId) {
      server.close();
      return previewState;
    }

    server.on("close", () => {
      if (previewStaticServer === server) {
        previewStaticServer = null;
        previewPort = null;
        emitPreview("preview.exit", {
          status: "stopped",
          port: null,
          url: null,
          message: "Servidor estático encerrado."
        });
      }
    });

    previewStaticServer = server;
    previewPort = port;
    const url = `http://127.0.0.1:${port}`;
    await waitForHttp(url, 5000);

    if (sessionId !== activePreviewSessionId) {
      server.close();
      if (previewStaticServer === server) previewStaticServer = null;
      return previewState;
    }

    const ready: PreviewManagerState = {
      status: "ready",
      framework: "HTML / Estático",
      packageManager: "none",
      port,
      url,
      message: "Preview estático pronto.",
      internalSession: sessionId
    };
    previewState = ready;
    previewRuntimeDescriptor = info;
    if (activeWorkspace) {
      activeWorkspace.previewStaticServer = server;
      activeWorkspace.previewPort = port;
      activeWorkspace.previewUrl = url;
    }
    console.log(`[Preview] static ready session=${sessionId} url=${url}`);
    mainWindow?.webContents.send("preview:event", { type: "preview.ready", properties: ready });
    void captureProjectPreviewThumbnail(projectRoot, url);
    return ready;
  } catch (error: any) {
    await stopPreviewProcessOnly();
    emitPreview("preview.error", { status: "error", message: String(error?.message ?? error), port: null, url: null });
    return previewState;
  }
}

async function startPreviewInternal(projectRoot: string, info: any, sessionId: number): Promise<PreviewManagerState> {
  if (sessionId !== activePreviewSessionId) return previewState;

  let packageManager = (info as any).packageManager ?? "npm";
  emitPreview("preview.detected", {
    status: "detecting",
    framework: info.framework,
    packageManager,
    message: `Projeto ${info.framework} detectado.`
  });

  if (!info.devScript) {
    emitPreview("preview.unsupported", { status: "idle", message: "O projeto não possui um script dev ou start no package.json." });
    return previewState;
  }

  // 1. Initial dependency check and installation
  const hasNM = await hasDependencies(projectRoot);
  let needsInstall = !hasNM;

  if (hasNM) {
    try {
      await verifyRuntimeDependency(projectRoot, info);
    } catch (checkErr: any) {
      console.warn("[Neko/Preview] Integridade de dependências falhou:", checkErr?.message);
      needsInstall = true;
    }
  }

  if (needsInstall) {
    if (sessionId !== activePreviewSessionId) return previewState;
    emitPreview("preview.installing", { status: "installing", packageManager, message: `Instalando dependências com ${packageManager}...` });
    try {
      packageManager = await installDependenciesWithFallback(projectRoot, packageManager, info);
    } catch (error: any) {
      if (sessionId !== activePreviewSessionId) return previewState;
      const errorMsg = String(error?.message ?? error);
      emitPreview("preview.error", { status: "error", message: errorMsg, port: null, url: null });
      return previewState;
    }
  }

  if (sessionId !== activePreviewSessionId) return previewState;

  const port = await findFreePort(info.preferredPort);
  emitPreview("preview.starting", { status: "starting", packageManager, port, message: `Iniciando ${info.framework} na porta ${port}...` });

  let launch: Awaited<ReturnType<typeof launchPreviewProcess>> | null = null;
  try {
    launch = await launchPreviewProcess(projectRoot, info, packageManager, port);
    if (sessionId !== activePreviewSessionId) {
      try {
        if (process.platform === "win32" && launch.processRef.pid) {
          spawn("taskkill.exe", ["/PID", String(launch.processRef.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          launch.processRef.kill("SIGTERM");
        }
      } catch {}
      return previewState;
    }
    previewProcess = launch.processRef;

    const processRef = launch.processRef;
    processRef.on("exit", (code, signal) => {
      if (previewProcess === processRef) {
        previewProcess = null;
        previewPort = null;
        emitPreview("preview.exit", { status: code === 0 ? "stopped" : "error", port: null, url: null, message: code === 0 ? "Servidor encerrado." : `Servidor encerrou (código ${code}, ${signal ?? "sem sinal"}).` });
      }
    });

    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForHttp(url, 45000, processRef);
      if (sessionId !== activePreviewSessionId) {
        try {
          if (process.platform === "win32" && processRef.pid) {
            spawn("taskkill.exe", ["/PID", String(processRef.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          } else {
            processRef.kill("SIGTERM");
          }
        } catch {}
        return previewState;
      }
      previewPort = port;
      const ready = { status: "ready" as const, framework: info.framework, packageManager, port, url, message: "Preview pronto.", internalSession: sessionId };
      previewState = ready;
      previewRuntimeDescriptor = info;
      if (activeWorkspace) {
        activeWorkspace.previewProcess = processRef;
        activeWorkspace.previewPort = port;
        activeWorkspace.previewUrl = url;
      }
      console.log(`[Preview] ready session=${sessionId} url=${url}`);
      mainWindow?.webContents.send("preview:event", { type: "preview.ready", properties: ready });
      void captureProjectPreviewThumbnail(projectRoot, url);
      return ready;
    } catch (error: any) {
      const output = launch.getOutput();
      const message = String(error?.message ?? error);

      // Clean recovery cycle: if server failed to start due to dependency resolution error or early crash
      // Limit to ONE fallback repair with npm
      if (packageManager !== "npm" && (dependencyResolutionFailure(output) || dependencyResolutionFailure(message) || (processRef.exitCode !== null && processRef.exitCode !== 0))) {
        await stopPreviewProcessOnly();
        console.log(`[Preview/Fallback] npm started`);
        emitPreview("preview.installing", {
          status: "installing",
          packageManager: "npm",
          message: "O Neko encontrou um problema nas dependências. Reparando com npm e tentando novamente..."
        });
        try {
          await removeNodeModules(projectRoot);
          await installDependencies(projectRoot, "npm");
          await verifyRuntimeDependency(projectRoot, info);
          console.log(`[Preview/Fallback] npm completed`);
          packageManager = "npm";
          const retryPort = await findFreePort(info.preferredPort);
          emitPreview("preview.starting", { status: "starting", packageManager: "npm", port: retryPort, message: `Tentando iniciar ${info.framework} novamente...` });
          const retry = await launchPreviewProcess(projectRoot, info, "npm", retryPort);
          if (sessionId !== activePreviewSessionId) {
            try {
              if (process.platform === "win32" && retry.processRef.pid) {
                spawn("taskkill.exe", ["/PID", String(retry.processRef.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
              } else {
                retry.processRef.kill("SIGTERM");
              }
            } catch {}
            return previewState;
          }
          previewProcess = retry.processRef;
          const retryProcess = retry.processRef;
          retryProcess.on("exit", (code, signal) => {
            if (previewProcess === retryProcess) {
              previewProcess = null;
              previewPort = null;
              emitPreview("preview.exit", { status: code === 0 ? "stopped" : "error", port: null, url: null, message: code === 0 ? "Servidor encerrado." : `Servidor encerrou (código ${code}, ${signal ?? "sem sinal"}).` });
            }
          });
          const retryUrl = `http://127.0.0.1:${retryPort}`;
          await waitForHttp(retryUrl, 45000, retryProcess);
          if (sessionId !== activePreviewSessionId) {
            try {
              if (process.platform === "win32" && retryProcess.pid) {
                spawn("taskkill.exe", ["/PID", String(retryProcess.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
              } else {
                retryProcess.kill("SIGTERM");
              }
            } catch {}
            return previewState;
          }
          previewPort = retryPort;
          const ready = { status: "ready" as const, framework: info.framework, packageManager: "npm", port: retryPort, url: retryUrl, message: "Preview pronto.", internalSession: sessionId };
          previewState = ready;
          previewRuntimeDescriptor = info;
          mainWindow?.webContents.send("preview:event", { type: "preview.ready", properties: ready });
          captureProjectPreviewThumbnail(projectRoot, retryUrl);
          return ready;
        } catch (fallbackError: any) {
          console.error(`[Preview] terminal failure: npm recovery failed:`, fallbackError?.message || fallbackError);
          await stopPreviewProcessOnly();
          emitPreview("preview.error", {
            status: "error",
            message: "Falha ao instalar dependências. A instalação foi tentada com Bun e npm, mas o node_modules permaneceu inválido.",
            port: null,
            url: null
          });
          return previewState;
        }
      }

      await stopPreviewProcessOnly();
      emitPreview("preview.error", {
        status: "error",
        message: dependencyResolutionFailure(output)
          ? "Falha ao instalar dependências. A instalação foi tentada com Bun e npm, mas o node_modules permaneceu inválido."
          : message,
        port: null,
        url: null
      });
      return previewState;
    }
  } catch (error: any) {
    await stopPreviewProcessOnly();
    emitPreview("preview.error", { status: "error", message: String(error?.message ?? error), port: null, url: null });
    return previewState;
  }
}

async function startPreview(projectPath: string, _sourceGen?: number, forceRestart = false): Promise<PreviewManagerState> {
  if (isInsideNekoApplication(projectPath)) {
    throw new Error("Não é permitido utilizar o diretório do NekoAI como workspace do projeto.");
  }
  const workspace = path.resolve(projectPath);

  // 1. Se já está rodando e saudável no mesmo projeto, NÃO matar! Reutilizar e reemitir ready!
  const hasActiveRunner = (previewProcess && previewProcess.exitCode === null) || Boolean(previewStaticServer);
  if (!forceRestart && previewProjectPath === workspace && hasActiveRunner && previewState.status === "ready" && previewState.url) {
    const alive = await isHttpAlive(previewState.url);
    if (alive) {
      console.log(`[Preview] Servidor já ativo e saudável em ${previewState.url} (mantido sem interrupção).`);
      emitPreview("preview.ready", previewState);
      if (previewState.url) {
        captureProjectPreviewThumbnail(workspace, previewState.url);
      }
      return previewState;
    }
  }

  // 2. Concurrency guard: Se já existe uma inicialização em andamento para este mesmo projeto, aguarda a mesma
  if (!forceRestart && previewProjectPath === workspace && previewStartPromise) {
    return previewStartPromise;
  }

  const session = ++previewSessionCounter;
  activePreviewSessionId = session;
  console.log(`[Preview] start session=${session} path=${workspace}${forceRestart ? " (forceRestart)" : ""}`);

  previewProjectPath = workspace;
  previewStartPromise = (async () => {
    emitPreview("preview.detecting", { status: "detecting", message: "Analisando estrutura do projeto..." });
    const runtime = await detectProjectRuntime(workspace);
    if (session !== activePreviewSessionId) return previewState;

    if (runtime.type === "UNSUPPORTED") {
      emitPreview("preview.unsupported", { status: "idle", message: "Aguardando criação da estrutura do projeto..." });
      return previewState;
    }

    await stopPreviewProcessOnly();
    console.log("[Neko/Preview] project runtime resolved", { workspace, runtimeType: runtime.type, projectRoot: runtime.projectRoot, session });

    if (runtime.type === "STATIC_HTML") {
      return startStaticPreviewInternal(runtime.projectRoot, runtime, session);
    }

    return startPreviewInternal(runtime.projectRoot, runtime, session);
  })().finally(() => {
    previewStartPromise = null;
  });

  return previewStartPromise;
}


type ModelSettingMap = Record<string, boolean>;
type ProviderSettingMap = Record<string, boolean>;

async function getProviderSettings(): Promise<ProviderSettingMap> {
  try {
    const settingsPath = path.join(app.getPath("userData"), "provider-settings.json");
    const raw = await fs.promises.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveProviderSettings(settings: ProviderSettingMap) {
  const settingsPath = path.join(app.getPath("userData"), "provider-settings.json");
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}


async function getModelSettings(): Promise<ModelSettingMap> {
  try {
    const settingsPath = path.join(app.getPath("userData"), "model-settings.json");
    const raw = await fs.promises.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveModelSettings(settings: ModelSettingMap) {
  const settingsPath = path.join(app.getPath("userData"), "model-settings.json");
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

async function getProviders() {
  console.log(`[Providers] request generation=${activeWorkspace?.generation ?? 0} projectPath=${activeWorkspace?.projectPath ?? "none"} currentProject=${currentProject ?? "none"} transitionGeneration=${projectTransitionGeneration} transitionState=${activeWorkspace?.status ?? "none"}`);

  if (!serviceReady) logService("providers:list queued");
  await waitForServiceReady();
  logService("providers:list started");

  // There is no OpenCode instance until a project is opened. Returning an
  // empty catalog avoids connection-refused noise from the renderer during
  // the initial Home/empty-project state. The real catalog is loaded again
  // from the `neko.opencode.ready` event after OpenCode becomes healthy.
  if (!currentProject || !opencodeProcess) {
    logService("providers:list completed", "sem projeto ativo");
    console.log(`[Providers] response generation=${activeWorkspace?.generation ?? 0} projectPath=${activeWorkspace?.projectPath ?? "none"} currentProject=${currentProject ?? "none"} transitionGeneration=${projectTransitionGeneration} count=0 (sem projeto ativo)`);
    return { providers: [], models: [], managedModels: [] };
  }

  try {
    const client: any = await getOpencodeClient();
    const result = await Promise.race([
      client.provider.list(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo esgotado ao carregar os provedores.")), 8000))
    ]);
    const data = result?.data ?? result ?? {};
    const all = Array.isArray(data.all) ? data.all : Array.isArray(data.providers) ? data.providers : [];
    const connected = new Set<string>(Array.isArray(data.connected) ? data.connected : []);
    const defaults = data.default ?? {};
    const disabledSettings = await getModelSettings();
    const providerSettings = await getProviderSettings();

    const models: any[] = [];
    const providers = all.map((provider: any) => {
      const providerID = provider.id ?? provider.providerID;
      const providerName = provider.name ?? providerID;
      const providerModels = provider.models ?? {};
      const isConnected = connected.has(providerID) || provider.connected === true;
      const providerEnabled = providerSettings[providerID] !== false;

      const providerModelList = Object.entries(providerModels as Record<string, any>).map(([modelID, model]: [string, any]) => {
        const key = `${providerID}:${modelID}`;
        const catalogEnabled = model?.enabled !== false;
        const userEnabled = disabledSettings[key] !== false;
        // Capability cache: vision decisions read this without any extra
        // providers:list request. Catalog metadata may be untrustworthy, so
        // getModelCapabilities applies the NekoAI overrides on top.
        providerCatalogCache.set(key, { attachment: model?.attachment === true });

        return {
          providerID,
          providerName,
          modelID,
          name: model?.name ?? modelID,
          variants: model?.variants && typeof model.variants === "object" ? Object.keys(model.variants) : [],
          enabled: providerEnabled && catalogEnabled && userEnabled,
          connected: isConnected,
          catalogEnabled,
          attachment: model?.attachment === true,
        };
      });

      models.push(...providerModelList);
      return {
        id: providerID,
        name: providerName,
        connected: isConnected,
        enabled: providerEnabled,
        methods: [],
        models: providerModelList
      };
    });

    try {
      const authResult = await client.provider.auth();
      const authData = authResult?.data ?? authResult ?? {};
      for (const provider of providers) {
        provider.methods = Array.isArray(authData[provider.id]) ? authData[provider.id].map((method: any) => ({
          type: method.type ?? method.label ?? "api",
          label: method.label ?? method.type
        })) : [];
      }
    } catch {}

    const managedModels = models.filter(m => m.connected && m.catalogEnabled);
    const activeModels = managedModels.filter(m => m.enabled);

    logService("providers:list completed");
    console.log(`[Providers] response generation=${activeWorkspace?.generation ?? 0} projectPath=${activeWorkspace?.projectPath ?? "none"} currentProject=${currentProject ?? "none"} transitionGeneration=${projectTransitionGeneration} count=${providers.length}`);
    return { providers, models: activeModels, managedModels, defaults };
  } catch (error: any) {
    if (!currentProject || !opencodeProcess || !serviceReady) {
      logService("providers:list completed", "cancelado durante encerramento");
      console.log(`[Providers] response generation=${activeWorkspace?.generation ?? 0} projectPath=${activeWorkspace?.projectPath ?? "none"} currentProject=${currentProject ?? "none"} transitionGeneration=${projectTransitionGeneration} count=0 (cancelado)`);
      return { providers: [], models: [], managedModels: [] };
    }
    logService("providers:list ERROR", `msg=${logSafeText(error?.message ?? error)}`);
    throw error;
  }
}

async function getModels() {
  return getProviders();
}


const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = 10;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".js", ".jsx", ".ts", ".tsx",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".xml", ".yml", ".yaml", ".toml",
  ".ini", ".env", ".sh", ".bat", ".ps1", ".sql", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".php", ".vue", ".svelte", ".astro", ".graphql", ".gql",
  ".log", ".conf", ".config",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf"]);

function attachmentMime(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string,string> = {
    ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp",
    ".txt":"text/plain", ".md":"text/markdown", ".markdown":"text/markdown", ".json":"application/json", ".csv":"text/csv",
    ".js":"text/javascript", ".jsx":"text/javascript", ".ts":"text/typescript", ".tsx":"text/typescript", ".css":"text/css",
    ".html":"text/html", ".htm":"text/html", ".xml":"application/xml", ".yml":"text/yaml", ".yaml":"text/yaml",
    ".pdf":"application/pdf", ".doc":"application/msword",
    ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls":"application/vnd.ms-excel", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt":"application/vnd.ms-powerpoint", ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rtf":"application/rtf",
  };
  return map[ext] ?? (TEXT_EXTENSIONS.has(ext) ? "text/plain" : "application/octet-stream");
}
function attachmentKind(filePath: string): "image" | "document" | "text" {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "text";
}
function isSupportedAttachment(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
}
async function makeImagePreview(filePath: string) {
  try {
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return undefined;
    const thumbnail = image.resize({ width: 220, height: 140, quality: "good" });
    return `data:image/png;base64,${thumbnail.toPNG().toString("base64")}`;
  } catch { return undefined; }
}
async function validateAttachment(filePath: string) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(`Não é um arquivo: ${filePath}`);
  if (stat.size > ATTACHMENT_MAX_BYTES) throw new Error(`${path.basename(filePath)} excede 20 MB por arquivo.`);
  if (!isSupportedAttachment(filePath)) throw new Error(`${path.basename(filePath)} não é compatível.`);
  const kind = attachmentKind(filePath);
  return { path:filePath, name:path.basename(filePath), mime:attachmentMime(filePath), size:stat.size, url:pathToFileURL(filePath).toString(), previewUrl:kind === "image" ? await makeImagePreview(filePath) : undefined, kind, extension:path.extname(filePath).replace(".","").toUpperCase() || "FILE" };
}
function errorInfo(error: unknown, filePath: string) { return { name:path.basename(filePath), message:error instanceof Error ? error.message : String(error), extension:path.extname(filePath).replace(".","").toUpperCase() || "FILE" }; }
async function collectAttachmentPaths(filePaths: string[]) {
  const items:any[]=[]; const errors:any[]=[]; let total=0;
  for (const filePath of filePaths) {
    if (items.length >= ATTACHMENT_MAX_COUNT) { errors.push({ ...errorInfo(new Error("Limite de 10 arquivos por mensagem."), filePath) }); continue; }
    try { const item=await validateAttachment(filePath); if (total+item.size>ATTACHMENT_TOTAL_BYTES) { errors.push({ ...errorInfo(new Error("O total dos anexos não pode ultrapassar 50 MB."), filePath) }); continue; } total+=item.size; items.push(item); }
    catch(error){ errors.push(errorInfo(error,filePath)); }
  }
  return {items,errors,total};
}
async function saveClipboardDataUrl(dataUrl: string, mime: string) {
  const match=dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if(!match) throw new Error("Imagem da área de transferência inválida.");
  const detectedMime=match[1]||mime||"image/png"; if(!detectedMime.startsWith("image/")) throw new Error("A área de transferência não contém uma imagem.");
  const ext=detectedMime==="image/jpeg"?".jpg":detectedMime==="image/webp"?".webp":detectedMime==="image/gif"?".gif":".png";
  const buffer=Buffer.from(match[2],"base64"); if(buffer.length>ATTACHMENT_MAX_BYTES) throw new Error("A imagem colada excede 20 MB.");
  const dir=path.join(app.getPath("userData"),"attachments"); await fs.promises.mkdir(dir,{recursive:true});
  const filePath=path.join(dir,`clipboard-${Date.now()}${ext}`); await fs.promises.writeFile(filePath,buffer); return validateAttachment(filePath);
}

ipcMain.handle("attachments:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Adicionar arquivos ao prompt", properties: ["openFile", "multiSelections"],
    filters: [{ name: "Arquivos compatíveis", extensions: ["png","jpg","jpeg","gif","webp","txt","md","json","csv","tsv","js","jsx","ts","tsx","css","scss","html","xml","yml","yaml","toml","ini","sh","bat","ps1","sql","py","rb","go","rs","java","c","h","cpp","hpp","php","vue","svelte","astro","graphql","gql","log","conf","config","pdf","doc","docx","xls","xlsx","ppt","pptx","rtf"] }, { name: "Todos os arquivos", extensions: ["*"] }]
  });
  if (result.canceled) return { items: [], errors: [] };
  return collectAttachmentPaths(result.filePaths);
});
ipcMain.handle("attachments:clipboard", async (_event, payload: {dataUrl:string; mime:string}) => {
  try { return { item: await saveClipboardDataUrl(payload.dataUrl,payload.mime), error:null }; }
  catch(error){ return { item:null, error:{ name:"Imagem", message:error instanceof Error?error.message:String(error), extension:"IMG" } }; }
});
ipcMain.handle("attachments:paths", async (_event, filePaths: string[]) => collectAttachmentPaths(Array.isArray(filePaths)?filePaths:[]));


async function searchProjectFiles(query: string, projectRoot: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const results: Array<{
    name: string;
    path: string;
    type: "file" | "directory";
  }> = [];

  async function walk(relative = ""): Promise<void> {
    const absolute = safePathWithinProject(projectRoot, relative);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;

      const rel = path.join(relative, entry.name).replaceAll("\\", "/");
      const matches = entry.name.toLowerCase().includes(normalized);

      if (entry.isDirectory()) {
        if (matches) {
          results.push({
            name: entry.name,
            path: rel,
            type: "directory"
          });
        }
        await walk(rel);
      } else if (matches) {
        results.push({
          name: entry.name,
          path: rel,
          type: "file"
        });
      }
    }
  }

  await walk();

  return results
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 200);
}

ipcMain.handle("project:search", async (_event, query: string) => {
  licenseManager.assertAccess("pesquisa de arquivos");
  const projectRoot = assertProjectRootSafe(currentProject, "search");
  return searchProjectFiles(query, projectRoot);
});

ipcMain.handle("commands:list", async () => {
  try {
    const response = await fetch(`${opencodeUrl}/command`, { headers: opencodeRequestHeaders() });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : (data?.commands ?? data?.data ?? []);
  } catch { return []; }
});

ipcMain.handle("opencode:command", async (_event, payload: { sessionId: string; command: string; arguments?: string; model?: { providerID: string; modelID: string } }) => {
  licenseManager.assertAccess("comandos do assistente");
  const projectRoot = assertProjectRootSafe(currentProject, "command");
  logProjectWorkspace("command", projectRoot);
  if (!payload.sessionId) throw new Error("Sessão do Neko não encontrada.");
  const response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opencodeRequestHeaders() },
    body: JSON.stringify({
      command: payload.command.replace(/^\//, ""),
      arguments: payload.arguments ?? "",
      agent: "build",
      ...(payload.model ? { model: payload.model } : {})
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha no comando /${payload.command} (HTTP ${response.status}).${body ? ` ${body.slice(0,240)}` : ""}`);
  }
  return response.json().catch(() => ({ ok: true }));
});


ipcMain.handle("github:status", async (_event, refresh: boolean = false) => {
  const status = await getGithubStatus();
  if (status.error && refresh) throw new Error(status.error);
  return status;
});

ipcMain.handle("github:open", async (_event, url: string) => {
  if (!/^https:\/\/github\.com\//i.test(url)) throw new Error("URL do GitHub inválida.");
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("github:start", async (_event, forceReauthorize: boolean = false) => {
  const existing = await getGithubStatus();
  if (existing.connected && !forceReauthorize && !existing.needsReauthorization) return { device: null, status: existing };

  // Prevent multiple concurrent initiations within the exact same tick / double-click
  if (githubAuthState.isStarting) {
    console.warn("[GitHub OAuth] Initiation already in progress, ignoring duplicate call.");
    return { device: null, status: { connected: false, repos: [] } };
  }

  githubAuthState.isStarting = true;

  try {
    // If there is any existing polling attempt from before, cancel it cleanly
    if (githubAuthState.attemptId || githubAuthState.pollPromise || githubAuthState.abortController) {
      cancelGithubAuthorization("superseded_by_new_start");
      githubAuthState.isStarting = true;
    }

    console.log("[GitHub OAuth] Authorization started");

    const attemptId = crypto.randomUUID();
    const abortController = new AbortController();

    githubAuthState.attemptId = attemptId;
    githubAuthState.abortController = abortController;

    const response = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID }),
      signal: abortController.signal
    });

    if (abortController.signal.aborted || githubAuthState.attemptId !== attemptId) {
      return { device: null, status: { connected: false, repos: [] } };
    }

    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !data.device_code || !data.user_code) {
      throw new Error(`Não foi possível iniciar o Device Flow do GitHub${data.error ? `: ${data.error}` : "."}`);
    }

    const device = {
      userCode: String(data.user_code),
      verificationUri: String(data.verification_uri || "https://github.com/login/device"),
      expiresIn: Number(data.expires_in || 900),
      interval: Number(data.interval || 5)
    };

    await shell.openExternal(device.verificationUri);

    console.log("[GitHub OAuth] Polling started");

    const pollPromise = pollGithubDevice(String(data.device_code), device.interval, attemptId, abortController.signal)
      .catch(error => {
        if (abortController.signal.aborted || githubAuthState.attemptId !== attemptId) return;
        console.error("[Neko/GitHub] Device Flow error:", error);
        mainWindow?.webContents.send("github:event", { type: "github.error", properties: { message: error instanceof Error ? error.message : String(error) } });
      })
      .finally(() => {
        if (githubAuthState.attemptId === attemptId) {
          githubAuthState.pollPromise = null;
          githubAuthState.abortController = null;
          githubAuthState.attemptId = null;
          githubAuthState.isStarting = false;
        }
      });

    githubAuthState.pollPromise = pollPromise;
    githubAuthState.isStarting = false;

    return { device, status: { connected: false, repos: [] } };
  } catch (error) {
    githubAuthState.isStarting = false;
    if (githubAuthState.abortController?.signal.aborted) {
      return { device: null, status: { connected: false, repos: [] } };
    }
    cancelGithubAuthorization("start_failed");
    throw error;
  }
});

ipcMain.handle("github:cancel", async () => {
  cancelGithubAuthorization("renderer_requested");
  mainWindow?.webContents.send("github:event", { type: "github.cancelled" });
  return { ok: true };
});

ipcMain.handle("github:disconnect", async () => {
  cancelGithubAuthorization("disconnect");
  clearGithubAuth();
  mainWindow?.webContents.send("github:event", { type: "github.disconnected", properties: { connected: false, repos: [] } });
  return true;
});



ipcMain.handle("github:listBranches", async (_event, _repoFullName: string) => {
  if (!currentProject) return [];
  const projectPath = assertProjectRootSafe(currentProject, "git-list");

  return withProjectGitLock(projectPath, async () => {
    const status = await getGitStatus();
    if (!status.initialized) return [];

    const names = new Set<string>();
    const remoteUrl = status.remote;

    // Refresh remote refs with GitHub authentication so private repositories
    // expose their current branches as well, and prune stale remote tracking branches.
    let remoteSyncSuccess = false;
    if (remoteUrl) {
      try {
        const token = await getGithubAccessToken();
        const fetched = await runGitWithGithubAuth(projectPath, ["fetch", "--prune", "origin"], token, 20000);
        if (fetched.code === 0) {
          remoteSyncSuccess = true;
        } else {
          console.warn("[Neko/GitHub] Não foi possível atualizar branches remotas:", fetched.stderr || fetched.stdout);
        }
      } catch (error) {
        console.warn("[Neko/GitHub] Falha na autenticação ao atualizar branches:", error);
      }
    }

    const remoteRefs = new Set<string>();
    if (remoteUrl) {
      const remote = await runGit(projectPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], {}, 15000);
      if (remote.code === 0) {
        for (const name of remote.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
          if (name !== "origin/HEAD" && name !== "origin" && name !== "HEAD") {
            const cleanName = name.replace(/^origin\//, "");
            remoteRefs.add(cleanName);
            names.add(cleanName);
          }
        }
      }
    }

    const local = await runGit(projectPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {}, 15000);
    if (local.code === 0) {
      const localBranches = local.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      for (const name of localBranches) {
        // If remote repository is connected and sync succeeded, prune stale unreferenced local branches
        // that were deleted upstream and are not the currently active branch.
        if (remoteUrl && remoteSyncSuccess && !remoteRefs.has(name) && name !== status.branch) {
          try {
            await runGit(projectPath, ["branch", "-D", name], {}, 10000);
          } catch (e) {
            console.warn(`[Neko/GitHub] Não foi possível podar branch local obsoleta ${name}:`, e);
          }
        } else if (!remoteUrl || !remoteSyncSuccess || remoteRefs.has(name) || name === status.branch) {
          names.add(name);
        }
      }
    }

    if (status.branch) names.add(status.branch);

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  });
});

ipcMain.handle("github:checkoutBranch", async (_event, branchName: string) => {
  if (!currentProject) throw new Error("Abra um projeto antes de trocar de branch.");
  const projectPath = assertProjectRootSafe(currentProject, "git-write");

  if (activeAgentRequests.size > 0) {
    throw new Error("Uma tarefa do assistente está em execução no momento. Aguarde a conclusão da tarefa antes de trocar de branch.");
  }

  const name = String(branchName || "").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("/") || name.endsWith("/")) {
    throw new Error("Nome de branch inválido.");
  }

  return withProjectGitLock(projectPath, async () => {
    const status = await getGitStatus();
    if (!status.initialized) throw new Error("O projeto ainda não possui um repositório Git.");
    if (status.branch === name) return status;
    if (status.dirty) throw new Error("Existem alterações locais não salvas. Faça commit ou descarte as alterações antes de trocar de branch.");

    // 1. Check if branch exists locally
    const local = await runGit(projectPath, ["rev-parse", "--verify", `refs/heads/${name}`], {}, 15000);
    if (local.code === 0) {
      const checkout = await runGit(projectPath, ["checkout", name], {}, 20000);
      if (checkout.code !== 0) throw new Error(formatGitHubGitError(checkout, `trocar para a branch "${name}"`));
      invalidateProjectCheckpoints(projectPath);
      mainWindow?.webContents.send("opencode:event", {
        type: "neko.project.changed",
        properties: { path: "", reason: "branch.checkout", branch: name }
      });
      return await getGitStatus();
    }

    // 2. Check if remote tracking ref already exists locally
    let remoteRef = await runGit(projectPath, ["rev-parse", "--verify", `refs/remotes/origin/${name}`], {}, 15000);

    // If not yet available in refs/remotes/origin, fetch from remote
    if (remoteRef.code !== 0) {
      let token = "";
      try {
        token = await getGithubAccessToken();
      } catch {
        throw new Error("Conecte o GitHub para baixar o branch remoto.");
      }

      const remoteCheck = await runGitWithGithubAuth(projectPath, ["ls-remote", "--heads", "origin", name], token, 20000);
      if (remoteCheck.code !== 0) {
        throw new Error(formatGitHubGitError(remoteCheck, `localizar a branch "${name}"`));
      }
      if (!remoteCheck.stdout) {
        throw new Error(`Não foi possível encontrar a branch "${name}" no repositório remoto.`);
      }

      // Safe fetch: prune all origin refs without destroying single ref
      const fetch = await runGitWithGithubAuth(projectPath, ["fetch", "--prune", "origin"], token, 30000);
      if (fetch.code !== 0) {
        throw new Error(formatGitHubGitError(fetch, `baixar a branch "${name}"`));
      }

      remoteRef = await runGit(projectPath, ["rev-parse", "--verify", `refs/remotes/origin/${name}`], {}, 15000);
    }

    if (remoteRef.code !== 0) {
      throw new Error(`Não foi possível encontrar a branch "${name}" no repositório remoto.`);
    }

    // 3. Create and track local branch from origin/<name>
    const checkoutTrack = await runGit(projectPath, ["checkout", "-b", name, "--track", `origin/${name}`], {}, 20000);
    if (checkoutTrack.code !== 0) {
      // Fallback: if branch exists or -B needed
      const checkoutFallback = await runGit(projectPath, ["checkout", "-B", name, `origin/${name}`], {}, 20000);
      if (checkoutFallback.code !== 0) {
        throw new Error(formatGitHubGitError(checkoutFallback, `trocar para a branch "${name}"`));
      }
      await runGit(projectPath, ["branch", `--set-upstream-to=origin/${name}`, name], {}, 15000);
    }

    invalidateProjectCheckpoints(projectPath);
    mainWindow?.webContents.send("opencode:event", {
      type: "neko.project.changed",
      properties: { path: "", reason: "branch.checkout", branch: name }
    });

    return await getGitStatus();
  });
});

ipcMain.handle("github:chooseCloneDestination", async () => {
  let defaultPath: string | undefined = undefined;
  const lastDir = await appPreferencesManager.getLastProjectDirectory();
  if (lastDir) {
    defaultPath = lastDir;
  }

  const dialogOptions: OpenDialogOptions = {
    title: "Escolha onde salvar o projeto do GitHub",
    properties: ["openDirectory", "createDirectory"]
  };
  if (defaultPath) {
    dialogOptions.defaultPath = defaultPath;
  }

  const destination = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (destination.canceled || !destination.filePaths[0]) return { canceled: true };
  return { canceled: false, path: destination.filePaths[0] };
});

ipcMain.handle("github:openFolder", async (_event, folderPath: string) => {
  const value = String(folderPath || "").trim();
  if (!value) throw new Error("Pasta não informada.");
  await shell.openPath(value);
  return true;
});

ipcMain.handle("github:cloneProject", async (_event, payload: { repoFullName: string; parentPath?: string; projectName?: string }) => {
  licenseManager.assertAccess("clonagem de projetos GitHub");
  const repoFullName = String(payload?.repoFullName || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
    throw new Error("Repositório do GitHub inválido.");
  }

  const token = await getGithubAccessToken();

  const parent = String(payload?.parentPath || "").trim();
  if (!parent) throw new Error("Escolha uma pasta para salvar o projeto.");
  const safeParent = assertProjectRootSafe(parent, "git-clone-parent");
  const parentStat = await fs.promises.stat(safeParent).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error("A pasta escolhida não existe ou não é válida.");
  const repoName = repoFullName.split("/").pop() || "projeto";
  const projectName = String(payload?.projectName || repoName).trim();
  if (!/^[^\\/:*?"<>|]+$/.test(projectName) || projectName === "." || projectName === "..") {
    throw new Error("Escolha um nome de projeto válido.");
  }
  const target = path.join(safeParent, projectName);

  try {
    await fs.promises.access(target, fs.constants.F_OK);
    throw new Error(`A pasta "${projectName}" já existe em "${parent}". Escolha outra pasta.`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const cloneUrl = `https://github.com/${repoFullName}.git`;
  const clone = await runGitWithGithubAuth(safeParent, ["clone", cloneUrl, projectName], token);

  if (clone.code !== 0) {
    // Git may leave a partial destination after an interrupted/failed clone.
    // It is safe to remove it because we verified it did not exist beforehand.
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(formatGitHubGitError(clone, `clonar ${repoFullName}`));
  }

  const inside = await runGit(target, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout !== "true") {
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error("O GitHub informou que o clone terminou, mas o projeto local não contém um repositório Git válido.");
  }

  const remote = await runGit(target, ["remote", "get-url", "origin"]);
  if (remote.code !== 0 || remote.stdout !== cloneUrl) {
    const setRemote = await runGit(target, ["remote", "set-url", "origin", cloneUrl]);
    if (setRemote.code !== 0) {
      await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error("O clone foi concluído, mas não foi possível configurar o remote origin com segurança.");
    }
  }

  // No ZIP fallback here: Clone means a real Git clone with .git, history,
  // refs and remote preserved. Import-from-ZIP remains a separate future flow.
  return { canceled: false, path: target, repoFullName, archive: false };
});

ipcMain.handle("github:commitPush", async (_event, payload: { message: string }) => {
  licenseManager.assertAccess("envio de commits para o GitHub");
  if (!currentProject) throw new Error("Abra um projeto antes de enviar alterações.");
  const projectPath = assertProjectRootSafe(currentProject, "git-write");
  const message = String(payload?.message || "").trim();
  if (!message) throw new Error("Digite uma mensagem para o commit.");

  return withProjectGitLock(projectPath, async () => {
    const status = await getGitStatus();
    if (!status.initialized || !status.remote || !status.linkedRepo) {
      throw new Error("Este projeto ainda não está conectado a um repositório GitHub.");
    }
    const token = await getGithubAccessToken();
    const branch = status.branch || "main";

    // Ensure .gitignore exists and is populated
    await ensureGitignore(projectPath);

    // Configure user.name and user.email if not set
    const name = await runGit(projectPath, ["config", "user.name"], {}, 5000);
    if (name.code !== 0 || !name.stdout) {
      const auth = await githubApi("/user").then(r => r.json()).catch(() => ({} as any));
      const fallbackName = String((auth as any)?.name || (auth as any)?.login || "NekoAI User");
      const setName = await runGit(projectPath, ["config", "user.name", fallbackName], {}, 10000);
      if (setName.code !== 0) throw new Error("Não foi possível configurar o autor do commit.");
    }

    const email = await runGit(projectPath, ["config", "user.email"], {}, 5000);
    if (email.code !== 0 || !email.stdout) {
      const auth = await githubApi("/user").then(r => r.json()).catch(() => ({} as any));
      const id = typeof (auth as any)?.id === "number" ? (auth as any).id : null;
      const login = String((auth as any)?.login || "nekoai");
      const fallbackEmail = id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
      const setEmail = await runGit(projectPath, ["config", "user.email", fallbackEmail], {}, 10000);
      if (setEmail.code !== 0) throw new Error("Não foi possível configurar o e-mail do commit.");
    }

    // Check if HEAD has commits
    const headCheck = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], {}, 5000);
    const hasExistingCommits = headCheck.code === 0;

    // If no branch is currently active and no commits exist, ensure branch is main
    if (!hasExistingCommits) {
      await runGit(projectPath, ["branch", "-M", branch], {}, 5000);
    }

    const add = await runGit(projectPath, ["add", "-A"], {}, 20000);
    if (add.code !== 0) throw new Error(formatGitHubGitError(add, "preparar arquivos para o commit"));

    const commit = await runGit(projectPath, ["commit", "-m", message], {}, 20000);
    if (commit.code !== 0) {
      const raw = `${commit.stderr} ${commit.stdout}`.toLowerCase();
      if (raw.includes("nothing to commit")) {
        if (hasExistingCommits) {
          const push = await runGitWithGithubAuth(projectPath, ["push", "origin", branch], token, 35000);
          if (push.code !== 0) {
            const pushTrack = await runGitWithGithubAuth(projectPath, ["push", "-u", "origin", branch], token, 35000);
            if (pushTrack.code !== 0) throw new Error(formatGitHubGitError(pushTrack, `enviar o commit para a branch "${branch}"`));
          }
          return { ok: true, committed: false, pushed: true, status: await getGitStatus(), message: "Alterações enviadas para o GitHub." };
        }
        return { ok: true, committed: false, pushed: false, status: await getGitStatus(), message: "Não há alterações para enviar." };
      }
      throw new Error(formatGitHubGitError(commit, "criar o commit"));
    }

    // Push with upstream fallback
    let push = await runGitWithGithubAuth(projectPath, ["push", "-u", "origin", branch], token, 35000);
    if (push.code !== 0) {
      push = await runGitWithGithubAuth(projectPath, ["push", "origin", branch], token, 35000);
      if (push.code !== 0) {
        throw new Error(formatGitHubGitError(push, `enviar o commit para a branch "${branch}"`));
      }
    }

    return { ok: true, committed: true, pushed: true, status: await getGitStatus(), message: "Commit criado e enviado para o GitHub." };
  });
});

ipcMain.handle("github:publishProject", async (_event, payload: { repoName: string; private?: boolean }) => {
  licenseManager.assertAccess("publicação de repositórios no GitHub");
  if (!currentProject) throw new Error("Abra um projeto antes de publicá-lo no GitHub.");
  const projectPath = assertProjectRootSafe(currentProject, "git-write");

  const repoName = String(payload?.repoName || "").trim();
  const isPrivate = Boolean(payload?.private);
  if (!/^[A-Za-z0-9_.-]+$/.test(repoName) || repoName.length > 100) {
    throw new Error("Escolha um nome de repositório válido para o GitHub.");
  }

  // Cancel any existing publish operation on this project before starting
  cancelCurrentPublishOperation(projectPath);
  const abortController = new AbortController();
  activePublishAbortController = abortController;
  const signal = abortController.signal;

  return withProjectGitLock(projectPath, async () => {
    try {
      const token = await getGithubAccessToken();

      let createdRepo: any = null;
      let cloneUrl = "";
      let defaultBranch = "main";

      const createResponse = await fetchWithTimeout("https://api.github.com/user/repos", {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: repoName,
          private: isPrivate,
          auto_init: false
        })
      }, 20000);

      if (!createResponse.ok) {
        const body = await createResponse.text().catch(() => "");
        let isAlreadyExists = false;
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed?.errors) && parsed.errors.some((e: any) => String(e?.message || "").toLowerCase().includes("already exists"))) {
            isAlreadyExists = true;
          }
        } catch {}

        if (isAlreadyExists || createResponse.status === 422) {
          // Check if repo exists on authenticated user's account and reuse it
          const userAuth = await githubApi("/user").then(r => r.json()).catch(() => null);
          if (userAuth?.login) {
            const existingRepoRes = await fetchWithTimeout(`https://api.github.com/repos/${userAuth.login}/${repoName}`, {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28"
              }
            }, 10000).catch(() => null);
            if (existingRepoRes && existingRepoRes.ok) {
              createdRepo = await existingRepoRes.json();
              cloneUrl = String(createdRepo?.clone_url || `https://github.com/${createdRepo?.full_name}.git`);
              defaultBranch = String(createdRepo?.default_branch || "main");
            }
          }
        }

        if (!createdRepo) {
          let detail = "";
          try {
            const parsed = JSON.parse(body);
            detail = parsed?.message || "";
            if (Array.isArray(parsed?.errors) && parsed.errors[0]?.message) {
              detail = `${detail} (${parsed.errors[0].message})`;
            }
          } catch {}
          throw new Error(`Não foi possível criar o repositório no GitHub (HTTP ${createResponse.status})${detail ? `: ${detail}` : ""}.`);
        }
      } else {
        createdRepo = await createResponse.json();
        cloneUrl = String(createdRepo?.clone_url || `https://github.com/${createdRepo?.full_name}.git`);
        defaultBranch = String(createdRepo?.default_branch || "main");
      }

      if (signal.aborted) throw new Error("Publicação cancelada pelo usuário.");

      // Ensure .gitignore
      await ensureGitignore(projectPath);

      // Verify/init git
      const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"], {}, 5000, signal);
      if (inside.code !== 0 || inside.stdout !== "true") {
        const init = await runGit(projectPath, ["init", "-b", defaultBranch], {}, 15000, signal);
        if (init.code !== 0) throw new Error(formatGitHubGitError(init, "inicializar o Git"));
      }

      const currentBranch = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"], {}, 5000, signal);
      const branchName = (currentBranch.code === 0 && currentBranch.stdout.trim()) ? currentBranch.stdout.trim() : defaultBranch;
      if (branchName !== defaultBranch) {
        await runGit(projectPath, ["branch", "-M", defaultBranch], {}, 5000, signal);
      }

      const remoteCheck = await runGit(projectPath, ["remote", "get-url", "origin"], {}, 5000, signal);
      if (remoteCheck.code === 0) {
        await runGit(projectPath, ["remote", "set-url", "origin", cloneUrl], {}, 10000, signal);
      } else {
        const remoteAdd = await runGit(projectPath, ["remote", "add", "origin", cloneUrl], {}, 10000, signal);
        if (remoteAdd.code !== 0) throw new Error(formatGitHubGitError(remoteAdd, "configurar o remote origin"));
      }

      const name = await runGit(projectPath, ["config", "user.name"], {}, 5000, signal);
      if (name.code !== 0 || !name.stdout) {
        const auth = await githubApi("/user").then(r => r.json()).catch(() => ({} as any));
        const fallbackName = String((auth as any)?.name || (auth as any)?.login || "NekoAI User");
        await runGit(projectPath, ["config", "user.name", fallbackName], {}, 10000, signal);
      }

      const email = await runGit(projectPath, ["config", "user.email"], {}, 5000, signal);
      if (email.code !== 0 || !email.stdout) {
        const auth = await githubApi("/user").then(r => r.json()).catch(() => ({} as any));
        const id = typeof (auth as any)?.id === "number" ? (auth as any).id : null;
        const login = String((auth as any)?.login || "nekoai");
        const fallbackEmail = id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
        await runGit(projectPath, ["config", "user.email", fallbackEmail], {}, 10000, signal);
      }

      await runGit(projectPath, ["add", "-A"], {}, 20000, signal);

      const commitCheck = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], {}, 5000, signal);
      if (commitCheck.code !== 0) {
        const commit = await runGit(projectPath, ["commit", "-m", "Initial commit from NekoAI"], {}, 20000, signal);
        if (commit.code !== 0 && !commit.stdout.includes("nothing to commit")) {
          throw new Error(formatGitHubGitError(commit, "criar o commit inicial"));
        }
      } else {
        await runGit(projectPath, ["commit", "-m", "Update from NekoAI"], {}, 20000, signal);
      }

      const push = await runGitWithGithubAuth(projectPath, ["push", "-u", "origin", defaultBranch], token, 35000, signal);
      if (push.code !== 0) {
        throw new Error(formatGitHubGitError(push, `publicar os arquivos na branch "${defaultBranch}"`));
      }

      return {
        ok: true,
        repo: {
          id: createdRepo.id,
          name: createdRepo.name,
          fullName: createdRepo.full_name,
          private: createdRepo.private,
          htmlUrl: createdRepo.html_url,
          defaultBranch
        },
        status: await getGitStatus()
      };
    } finally {
      if (activePublishAbortController === abortController) {
        activePublishAbortController = null;
      }
    }
  });
});

ipcMain.handle("github:cancelPublish", async () => {
  if (currentProject) {
    cancelCurrentPublishOperation(currentProject);
  } else {
    cancelCurrentPublishOperation();
  }
  return { ok: true, canceled: true };
});

ipcMain.handle("github:gitStatus", async () => getGitStatus());

ipcMain.handle("github:discardChanges", async () => {
  licenseManager.assertAccess("descarte de alterações no Git");
  if (!currentProject) throw new Error("Abra um projeto antes de descartar alterações.");
  const projectPath = assertProjectRootSafe(currentProject, "git-write");

  return withProjectGitLock(projectPath, async () => {
    const status = await getGitStatus();
    if (!status.initialized) throw new Error("O projeto não possui um repositório Git.");

    // 1. Reset staged files to HEAD
    const reset = await runGit(projectPath, ["reset", "HEAD", "."], {}, 20000);
    if (reset.code !== 0) {
      console.warn("[Neko/Git] Aviso ao resetar staged:", reset.stderr);
    }

    // 2. Restore tracked modified and deleted files
    const restore = await runGit(projectPath, ["checkout", "--", "."], {}, 20000);
    if (restore.code !== 0) {
      const fallbackRestore = await runGit(projectPath, ["restore", "."], {}, 20000);
      if (fallbackRestore.code !== 0) {
        throw new Error(formatGitHubGitError(restore, "descartar alterações rastreadas"));
      }
    }

    // 3. Remove untracked files safely (excluding protected .env and system files)
    const statusAfterRestore = await runGit(projectPath, ["status", "--porcelain", "-uall"], {}, 15000);
    if (statusAfterRestore.code === 0 && statusAfterRestore.stdout) {
      const lines = statusAfterRestore.stdout.split(/\r?\n/).filter(line => line.startsWith("?? "));
      const canonicalProject = path.resolve(projectPath);

      for (const line of lines) {
        let rel = line.slice(3).trim();
        if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
        if (isProtectedFromDiscard(rel)) {
          continue;
        }

        const abs = path.resolve(projectPath, rel);
        if (abs === canonicalProject || !abs.startsWith(canonicalProject + path.sep)) {
          console.warn("[Neko/Git] Caminho ignorado fora do projeto:", abs);
          continue;
        }

        try {
          await fs.promises.rm(abs, { recursive: true, force: true });
        } catch (rmError) {
          console.warn("[Neko/Git] Não foi possível remover arquivo não rastreado:", abs, rmError);
        }
      }
    }

    invalidateProjectCheckpoints(projectPath);
    mainWindow?.webContents.send("opencode:event", {
      type: "neko.project.changed",
      properties: { path: "", reason: "git.discard" }
    });

    return await getGitStatus();
  });
});

const SAFE_IGNORED_ENTRIES_FOR_CLONE = new Set([
  ".git",
  ".neko",
  ".vscode",
  ".idea",
  ".ds_store",
  "thumbs.db",
  "desktop.ini"
]);

async function inspectFolderForClone(folderPath: string): Promise<{ isEmptyOrSafe: boolean; fileCount: number; nonSafeEntries: string[] }> {
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const nonSafe: string[] = [];
    let totalFiles = 0;

    for (const entry of entries) {
      const nameLower = entry.name.toLowerCase();
      if (!SAFE_IGNORED_ENTRIES_FOR_CLONE.has(nameLower)) {
        nonSafe.push(entry.name);
      }
      totalFiles++;
    }

    return {
      isEmptyOrSafe: nonSafe.length === 0,
      fileCount: totalFiles,
      nonSafeEntries: nonSafe
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { isEmptyOrSafe: true, fileCount: 0, nonSafeEntries: [] };
    }
    throw error;
  }
}

async function cleanFolderForClone(folderPath: string): Promise<void> {
  const entries = await fs.promises.readdir(folderPath, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    try {
      await fs.promises.rm(fullPath, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[Neko/Git] Não foi possível remover item ao limpar pasta: ${fullPath}`, e);
    }
  }
}

ipcMain.handle("github:linkProject", async (_event, payload: { repoFullName: string; replaceRemote?: boolean; overwriteLocalContent?: boolean }) => {
  licenseManager.assertAccess("vinculação de repositórios no GitHub");
  if (!currentProject) throw new Error("Abra um projeto antes de conectá-lo ao GitHub.");
  const projectPath = assertProjectRootSafe(currentProject, "git-write");

  const repoFullName = String(payload?.repoFullName || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
    throw new Error("Repositório do GitHub inválido.");
  }

  return withProjectGitLock(projectPath, async () => {
    const token = await getGithubAccessToken();
    const desiredRemote = `https://github.com/${repoFullName}.git`;

    // 1. Validate repository access and discover default branch / heads
    const lsRemote = await runGitWithGithubAuth(projectPath, ["ls-remote", "--symref", desiredRemote], token, 20000);
    if (lsRemote.code !== 0) {
      throw new Error(formatGitHubGitError(lsRemote, `validar o acesso a ${repoFullName}`));
    }

    // Check if remote repository is completely empty (no branches/heads)
    const headsCheck = await runGitWithGithubAuth(projectPath, ["ls-remote", "--heads", desiredRemote], token, 20000);
    const hasRemoteHeads = headsCheck.code === 0 && Boolean(headsCheck.stdout.trim());

    if (!hasRemoteHeads) {
      return {
        ok: false,
        emptyRemote: true,
        repoFullName,
        message: "Este repositório está vazio. Utilize a opção de publicar projeto para enviar seu código para ele.",
        status: await getGitStatus()
      };
    }

    // Determine remote default branch
    let defaultBranch = "main";
    const symrefMatch = lsRemote.stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    if (symrefMatch?.[1]) {
      defaultBranch = symrefMatch[1];
    } else {
      // Fallback: check heads
      const heads = headsCheck.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (heads.some(h => h.endsWith("/main"))) defaultBranch = "main";
      else if (heads.some(h => h.endsWith("/master"))) defaultBranch = "master";
      else if (heads.length > 0) {
        const firstHead = heads[0].split(/\s+/)[1]?.replace(/^refs\/heads\//, "");
        if (firstHead) defaultBranch = firstHead;
      }
    }

    // 2. Check if local directory already contains a working clone of this repo (FLUXO 3: Abrir repositório existente)
    const currentGitStatus = await getGitStatus();
    if (currentGitStatus.initialized && currentGitStatus.remote) {
      const isSameRepo = currentGitStatus.linkedRepo?.toLowerCase() === repoFullName.toLowerCase();
      const headVerify = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], {}, 5000);
      const isCompleteClone = headVerify.code === 0;

      if (isSameRepo && isCompleteClone) {
        // Already fully linked and cloned
        return {
          ok: true,
          repoFullName,
          alreadyCloned: true,
          status: currentGitStatus,
          message: "Projeto já conectado ao repositório GitHub."
        };
      }
    }

    // 3. Inspect local directory content
    const folderInspection = await inspectFolderForClone(projectPath);

    if (!folderInspection.isEmptyOrSafe && !payload?.overwriteLocalContent) {
      return {
        ok: false,
        requiresConfirmation: true,
        repoFullName,
        nonSafeEntries: folderInspection.nonSafeEntries,
        message: "Esta pasta já contém arquivos. Para conectar ao repositório existente, o NekoAI precisa trazer os arquivos do GitHub.",
        status: currentGitStatus
      };
    }

    // 4. Perform TRUE CLONE into the current project directory (FLUXO 2)
    // If folder was not empty and user explicitly approved overwrite, clean it first
    if (!folderInspection.isEmptyOrSafe && payload?.overwriteLocalContent) {
      await cleanFolderForClone(projectPath);
    } else {
      // Clean stale/partial .git if it was just an empty init
      const gitDir = path.join(projectPath, ".git");
      if (fs.existsSync(gitDir)) {
        await fs.promises.rm(gitDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Execute authenticated clone into current folder (.)
    const cloneResult = await runGitWithGithubAuth(projectPath, ["clone", desiredRemote, "."], token, 60000);
    if (cloneResult.code !== 0) {
      throw new Error(formatGitHubGitError(cloneResult, `clonar o repositório ${repoFullName}`));
    }

    // 5. Post-clone Validations
    const insideWorkTree = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"], {}, 5000);
    if (insideWorkTree.code !== 0 || insideWorkTree.stdout !== "true") {
      throw new Error("O clone foi finalizado mas o diretório não contém uma árvore Git de trabalho válida.");
    }

    const verifiedRemote = await runGit(projectPath, ["remote", "get-url", "origin"], {}, 5000);
    if (verifiedRemote.code !== 0 || !verifiedRemote.stdout.includes(repoFullName)) {
      await runGit(projectPath, ["remote", "set-url", "origin", desiredRemote], {}, 5000);
    }

    // Ensure proper default branch checkout and HEAD
    const currentBranchCheck = await runGit(projectPath, ["branch", "--show-current"], {}, 5000);
    const checkedOutBranch = (currentBranchCheck.code === 0 && currentBranchCheck.stdout.trim()) ? currentBranchCheck.stdout.trim() : defaultBranch;

    if (!checkedOutBranch || checkedOutBranch === "HEAD") {
      await runGit(projectPath, ["checkout", defaultBranch], {}, 10000).catch(() => {});
    }

    // Invalidate checkpoints, reload trees and notify workspace
    invalidateProjectCheckpoints(projectPath);
    mainWindow?.webContents.send("opencode:event", {
      type: "neko.project.changed",
      properties: { path: projectPath, reason: "git.clone" }
    });

    const finalStatus = await getGitStatus();

    return {
      ok: true,
      repoFullName,
      cloned: true,
      branch: finalStatus.branch || defaultBranch,
      status: finalStatus,
      message: "Repositório clonado com sucesso."
    };
  });
});

ipcMain.handle("projects:getRecent", async () => {
  return await recentProjectsManager.getRecentProjectsWithStatus();
});

ipcMain.handle("projects:touchRecent", async (_event, projectPath: string) => {
  const updated = await recentProjectsManager.touchRecentProject(projectPath);
  mainWindow?.webContents.send("recent-projects:updated", await recentProjectsManager.getRecentProjectsWithStatus());
  return updated;
});

ipcMain.handle("projects:removeRecent", async (_event, projectPath: string) => {
  const updated = await recentProjectsManager.removeRecentProject(projectPath);
  mainWindow?.webContents.send("recent-projects:updated", await recentProjectsManager.getRecentProjectsWithStatus());
  return updated;
});

ipcMain.handle("projects:toggleFavorite", async (_event, projectPath: string) => {
  const updated = await recentProjectsManager.toggleFavoriteProject(projectPath);
  mainWindow?.webContents.send("recent-projects:updated", await recentProjectsManager.getRecentProjectsWithStatus());
  return updated;
});

ipcMain.handle("projects:saveRecent", async (_event, projects: any[]) => {
  const updated = await recentProjectsManager.saveRecentProjects(projects);
  mainWindow?.webContents.send("recent-projects:updated", await recentProjectsManager.getRecentProjectsWithStatus());
  return updated;
});

ipcMain.handle("projects:detectTechnology", async (_event, projectPath: string) => {
  return await detectProjectTechnology(projectPath);
});

ipcMain.handle("preferences:getLastProjectDirectory", async () => {
  return await appPreferencesManager.getLastProjectDirectory();
});

ipcMain.handle("project:exists", async (_event, projectPath: string) => {
  const value = String(projectPath || "").trim();
  if (!value) return false;
  try {
    return (await fs.promises.stat(value)).isDirectory();
  } catch {
    return false;
  }
});

ipcMain.handle("project:isInsideApplicationRoot", (_event, projectPath: string) => {
  const value = String(projectPath || "").trim();
  if (!value) return true;
  try {
    return isInsideNekoApplication(path.resolve(value));
  } catch {
    return true;
  }
});

ipcMain.handle("project:thumbnail", async (_event, projectPath: string) => {
  const root = String(projectPath || "").trim();
  if (!root) return null;
  try {
    const thumbPath = path.join(root, ".neko", "thumbnail.png");
    const exists = await fs.promises.access(thumbPath).then(() => true).catch(() => false);
    if (!exists) return null;
    const buffer = await fs.promises.readFile(thumbPath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
});

ipcMain.handle("project:saveThumbnail", async (_event, payload: { projectPath: string; dataUrl: string }) => {
  const root = String(payload?.projectPath || "").trim();
  const dataUrl = String(payload?.dataUrl || "").trim();
  if (!root || !dataUrl.startsWith("data:image/")) return { ok: false };
  if (isInsideNekoApplication(root)) {
    console.warn(`[PROJECT WORKSPACE] operation=saveThumbnail blocked reason=nekoai-directory projectRoot=${path.resolve(root)} applicationRoot=${getApplicationRoot()}`);
    return { ok: false };
  }
  try {
    const nekoDir = path.join(root, ".neko");
    await fs.promises.mkdir(nekoDir, { recursive: true });
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const thumbFile = path.join(nekoDir, "thumbnail.png");
    await fs.promises.writeFile(thumbFile, buffer);
    void recentProjectsManager.updateProjectThumbnail(root, {
      thumbnail: dataUrl,
      thumbnailPath: thumbFile,
      thumbnailUpdatedAt: Date.now()
    }).then(async () => {
      try {
        const enriched = await recentProjectsManager.getRecentProjectsWithStatus();
        mainWindow?.webContents.send("recent-projects:updated", enriched);
      } catch {}
    }).catch(() => {});
    return { ok: true };
  } catch (error) {
    console.warn("[Neko/Thumbnail] failed to save thumbnail:", error);
    return { ok: false };
  }
});

ipcMain.handle("project:lastEdited", async (_event, projectPath: string) => {
  const root = String(projectPath || "").trim();
  if (!root) return Date.now();
  try {
    const stat = await fs.promises.stat(root);
    let latest = stat.mtimeMs;
    // Check key source dirs if present (src, app, components, index.html)
    const scanDirs = ["src", "app", "pages", "components", "public", ""];
    for (const sub of scanDirs) {
      const full = path.join(root, sub);
      try {
        const subStat = await fs.promises.stat(full);
        if (subStat.mtimeMs > latest) latest = subStat.mtimeMs;
      } catch {}
    }
    return Math.round(latest);
  } catch {
    return Date.now();
  }
});

ipcMain.handle("project:choose", async (_event, options?: { defaultPath?: string }) => {
  let defaultPath: string | undefined = undefined;

  if (options?.defaultPath && isValidDirectory(options.defaultPath)) {
    defaultPath = normalizeProjectPath(options.defaultPath);
  } else {
    const lastDir = await appPreferencesManager.getLastProjectDirectory();
    if (lastDir) {
      defaultPath = lastDir;
    }
  }

  const dialogOptions: OpenDialogOptions = {
    title: "Abrir pasta do projeto",
    properties: ["openDirectory"]
  };

  if (defaultPath) {
    dialogOptions.defaultPath = defaultPath;
  }

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

async function switchWorkspaceInternal(targetInput: string | { projectPath: string; source?: string }, defaultSource = "unknown") {
  console.log("[BLACKSCREEN] switchWorkspace:start", { targetInput: typeof targetInput === "string" ? targetInput : targetInput?.projectPath, source: defaultSource, currentProject, hasActiveWorkspace: !!activeWorkspace, activeWorkspaceStatus: activeWorkspace?.status });
  licenseManager.assertAccess("o workspace do NekoAI");
  const projectPath = typeof targetInput === "string" ? targetInput : targetInput?.projectPath;
  const source = (typeof targetInput === "object" && targetInput?.source) ? targetInput.source : defaultSource;

  if (!projectPath) throw new Error("Pasta do projeto não informada.");

  const targetPath = assertProjectRootSafe(projectPath, "switch");

  const isCreatingNew = source === "NewProject" || source === "create";
  if (!isCreatingNew) {
    const exists = await fs.promises.stat(targetPath).then(s => s.isDirectory()).catch(() => false);
    if (!exists) {
      throw new Error(`Pasta não encontrada no disco: ${targetPath}`);
    }
  }

  const transitionGen = ++projectTransitionGeneration;
  logProjectWorkspace("switch", targetPath);
  console.log(`[ProjectSwitch] REQUEST source=${source} target=${targetPath} generation=${transitionGen}`);
  console.log("[BLACKSCREEN] switchWorkspace:before-work", { targetPath, transitionGen, licenseState: licenseManager.getState().state });
  logService("transition-start", `target=${targetPath} gen=${transitionGen}`);

  // A new workspace gets a completely fresh task runtime: no old task,
  // permission, question, retry or listener state can leak across projects.
  resetTaskRuntime();
  logTask("runtime-reset", "-", "-", `target=${path.basename(targetPath)} generation=${transitionGen}`);

  // Create WorkspaceContext immediately
  const newWorkspace: WorkspaceContext = {
    generation: transitionGen,
    projectPath: targetPath,
    opencodeProcess: null,
    opencodeUrl: "http://127.0.0.1:4097",
    opencodePort: null,
    previewProcess: null,
    previewStaticServer: null,
    previewPort: null,
    previewUrl: null,
    watcher: null,
    eventAbort: null,
    status: "starting"
  };
  activeWorkspace = newWorkspace;
  currentProject = targetPath;

  const transitionPromise = (async () => {
    // 1. Ensure project directory exists only if explicitly creating a new project
    if (isCreatingNew) {
      await fs.promises.mkdir(targetPath, { recursive: true });
    }

    // 2. Terminate prior services cleanly
    await stopPreview();
    await stopOpenCode();

    if (transitionGen !== projectTransitionGeneration) {
      throw new Error("Troca de projeto interrompida por nova seleção.");
    }

    // 3. Set current project and update Supabase & Vercel
    currentProject = targetPath;
    void supabaseManager.setProject(targetPath);
    void vercelManager.setProject(targetPath);

    // 4. Start OpenCode on new project
    const health = await startOpenCodeInternal(targetPath, transitionGen);
    if (transitionGen !== projectTransitionGeneration) {
      throw new Error("Troca de projeto interrompida por nova seleção.");
    }

    // 5. Create fresh session
    const client = await getOpencodeClient();
    const session = await Promise.race([
      client.session.create({ body: { title: "NekoAI Workspace" } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo esgotado ao criar a sessão do Neko.")), 10000))
    ]);

    if (transitionGen !== projectTransitionGeneration) {
      throw new Error("Troca de projeto interrompida por nova seleção.");
    }

    // 6. Read tree, git status, supabase and vercel state
    const tree = await readTree(targetPath);
    const gitStatus = await getGitStatus();
    const supabaseState = supabaseManager.getState();
    const vercelState = vercelManager.getState();

    // 7. Start preview in background
    void startPreview(targetPath, transitionGen).then(preview => {
      if (transitionGen !== projectTransitionGeneration) return;
      if (preview.status === "ready") {
        mainWindow?.webContents.send("preview:event", {
          type: "preview.ready",
          properties: preview
        });
      }
    }).catch(error => {
      console.warn("[Neko/Preview] background start failed:", error);
    });

    newWorkspace.status = "ready";
    logService("transition-ready", `target=${targetPath} gen=${transitionGen}`);
    console.log("[BLACKSCREEN] switchWorkspace:transition-ready", { targetPath, sessionData: !!(session as any).data, treeNodes: tree.length, supabaseStatus: supabaseState?.status, vercelStatus: vercelState?.connection });

    // Registra projeto recente universalmente na conclusão do workspace
    void recentProjectsManager.touchRecentProject(targetPath).then(async () => {
      try {
        const enriched = await recentProjectsManager.getRecentProjectsWithStatus();
        mainWindow?.webContents.send("recent-projects:updated", enriched);
      } catch {}
    }).catch(err => {
      console.warn("[Neko/RecentProjects] Erro ao registrar projeto recente:", err);
    });

    // Salva a pasta pai como última pasta utilizada (lastProjectDirectory)
    void appPreferencesManager.saveLastProjectDirectoryFromProjectPath(targetPath).catch(err => {
      console.warn("[Neko/Preferences] Erro ao salvar última pasta do projeto:", err);
    });

    const result = {
      path: targetPath,
      opencodeUrl,
      health,
      session: (session as any).data,
      tree,
      preview: previewState,
      gitStatus,
      supabaseState,
      vercelState
    };
    console.log("[BLACKSCREEN] switchWorkspace:returning-result", { path: result.path, hasSession: !!result.session, hasTree: !!result.tree, hasSupabase: !!result.supabaseState, hasVercel: !!result.vercelState, supabaseKeys: result.supabaseState ? Object.keys(result.supabaseState) : null });
    return result;
  })();

  activeWorkspaceTransitionPromise = transitionPromise;
  try {
    console.log("[BLACKSCREEN] switchWorkspace:before-await");
    const result = await transitionPromise;
    console.log("[BLACKSCREEN] switchWorkspace:after-await", { path: result?.path });
    return result;
  } finally {
    if (activeWorkspaceTransitionPromise === transitionPromise) {
      activeWorkspaceTransitionPromise = null;
    }
  }
}

ipcMain.handle("project:create", async (_event, payload: string | { projectPath: string; source?: string }) => {
  console.log("[BLACKSCREEN] IPC:project:create", { payload: typeof payload === "string" ? payload : payload?.projectPath });
  const result = await switchWorkspaceInternal(payload, "ipc");
  console.log("[BLACKSCREEN] IPC:project:create:complete", { path: result?.path });
  return result;
});



// Per-task in-memory checkpoints. They intentionally exclude generated/runtime
// directories so Undo restores the source workspace without touching the
// Preview server's dependency cache. Keeping the snapshot in memory avoids
// persisting project secrets such as .env files to disk.
const TASK_CHECKPOINT_MAX_BYTES = 250 * 1024 * 1024;
const TASK_CHECKPOINT_MAX_FILES = 5000;

async function collectCheckpointFiles(projectPath: string, relative = "", files: TaskCheckpointFile[] = [], state = { totalBytes: 0 }) {
  if (files.length > TASK_CHECKPOINT_MAX_FILES) throw new Error("O projeto possui arquivos demais para criar um checkpoint seguro.");
  const dir = path.join(projectPath, relative);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreWatcherPath(path.join(relative, entry.name))) continue;
    const rel = path.join(relative, entry.name);
    const abs = path.join(projectPath, rel);
    if (entry.isDirectory()) {
      await collectCheckpointFiles(projectPath, rel, files, state);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(abs);
    state.totalBytes += stat.size;
    if (state.totalBytes > TASK_CHECKPOINT_MAX_BYTES) {
      throw new Error("O projeto é grande demais para o Undo automático desta tarefa.");
    }
    files.push({ relativePath: rel.replaceAll("\\", "/"), data: await fs.promises.readFile(abs), mode: stat.mode });
  }
  return { files, totalBytes: state.totalBytes };
}

async function createTaskCheckpoint(projectPath: string) {
  const root = path.resolve(projectPath);
  const id = `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const collected = await collectCheckpointFiles(root);
  const checkpoint: TaskCheckpoint = { id, projectPath: root, createdAt: Date.now(), files: collected.files, totalBytes: collected.totalBytes };
  // Keep only the latest checkpoint for each project. A separate project can
  // have its own active checkpoint, allowing multiple Neko instances/projects.
  for (const [key, value] of taskCheckpoints) {
    if (value.projectPath === root) taskCheckpoints.delete(key);
  }
  taskCheckpoints.set(id, checkpoint);
  return { id, files: checkpoint.files.length, bytes: checkpoint.totalBytes };
}

async function removeCurrentSourceFiles(projectPath: string, relative = "") {
  const dir = path.join(projectPath, relative);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  for (const entry of entries) {
    if (shouldIgnoreWatcherPath(path.join(relative, entry.name))) continue;
    const rel = path.join(relative, entry.name);
    const abs = path.join(projectPath, rel);
    if (entry.isDirectory()) {
      await removeCurrentSourceFiles(projectPath, rel);
      try {
        const remaining = await fs.promises.readdir(abs);
        if (remaining.length === 0) await fs.promises.rmdir(abs);
      } catch {}
    } else if (entry.isFile()) {
      await fs.promises.rm(abs, { force: true });
    }
  }
}

async function undoTaskCheckpoint(taskId: string) {
  const checkpoint = taskCheckpoints.get(String(taskId || ""));
  if (!checkpoint) throw new Error("O histórico desta tarefa não está mais disponível para Undo.");
  if (!currentProject || path.resolve(currentProject) !== checkpoint.projectPath) {
    throw new Error("Abra o mesmo projeto para desfazer esta tarefa.");
  }
  await removeCurrentSourceFiles(checkpoint.projectPath);
  for (const file of checkpoint.files) {
    const abs = safePathWithinProject(checkpoint.projectPath, file.relativePath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, file.data);
    if (process.platform !== "win32" && file.mode) {
      try { await fs.promises.chmod(abs, file.mode); } catch {}
    }
  }
  await stopPreview();
  void startPreview(checkpoint.projectPath).catch(error => console.warn("[Neko/Preview] Undo preview restart failed:", error));
  mainWindow?.webContents.send("opencode:event", { type: "neko.project.changed", properties: { path: checkpoint.projectPath, reason: "undo" } });
  taskCheckpoints.delete(taskId);
  return { ok: true, restoredFiles: checkpoint.files.length };
}

ipcMain.handle("project:checkpointTask", async () => {
  licenseManager.assertAccess("checkpoints do projeto");
  const projectRoot = assertProjectRootSafe(currentProject, "checkpoint");
  logProjectWorkspace("checkpoint", projectRoot);
  return createTaskCheckpoint(projectRoot);
});

ipcMain.handle("project:undoTask", async (_event, taskId: string) => {
  licenseManager.assertAccess("restauração de checkpoint");
  const projectRoot = assertProjectRootSafe(currentProject, "undo");
  logProjectWorkspace("undo", projectRoot);
  return undoTaskCheckpoint(taskId);
});

ipcMain.handle("project:tree", async () => {
  licenseManager.assertAccess("árvore de arquivos do projeto");
  const projectRoot = assertProjectRootSafe(currentProject, "tree");
  logProjectWorkspace("tree", projectRoot);
  return readTree(projectRoot);
});

ipcMain.handle("project:file", async (_event, relativePath: string) => {
  licenseManager.assertAccess("leitura de arquivos");
  const projectRoot = assertProjectRootSafe(currentProject, "read");
  logProjectWorkspace("read", projectRoot);
  const filePath = safePathWithinProject(projectRoot, relativePath);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Não é um arquivo.");
  const content = await fs.promises.readFile(filePath, "utf8");
  return { path: relativePath, content };
});

ipcMain.handle("project:refresh", async () => {
  licenseManager.assertAccess("atualização do workspace");
  if (!getActiveProjectRoot()) return { tree: [], preview: null };
  const projectRoot = assertProjectRootSafe(currentProject, "refresh");
  logProjectWorkspace("refresh", projectRoot);
  const tree = await readTree(projectRoot);
  return { tree, preview: previewState };
});

ipcMain.handle("models:list", async () => getModels());
ipcMain.handle("providers:list", async () => getProviders());
ipcMain.handle("model:setEnabled", async (_event, payload: { providerID: string; modelID: string; enabled: boolean }) => {
  if (!payload?.providerID || !payload?.modelID) throw new Error("Modelo não informado.");

  const settings = await getModelSettings();
  const key = `${payload.providerID}:${payload.modelID}`;

  if (payload.enabled) delete settings[key];
  else settings[key] = false;

  await saveModelSettings(settings);
  return getProviders();
});
ipcMain.handle("provider:setEnabled", async (_event, payload: { providerID: string; enabled: boolean }) => {
  if (!payload?.providerID) throw new Error("Provedor não informado.");
  const settings = await getProviderSettings();
  if (payload.enabled) delete settings[payload.providerID];
  else settings[payload.providerID] = false;
  await saveProviderSettings(settings);
  return getProviders();
});

async function readConnectedProviderIDs(): Promise<Set<string>> {
  try {
    const client: any = await getOpencodeClient();
    const result = await Promise.race([
      client.provider.list(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))
    ]);
    const data = (result as any)?.data ?? result ?? {};
    const connected = Array.isArray(data.connected) ? data.connected : [];
    return new Set(connected.map((value: unknown) => String(value)));
  } catch {
    return new Set();
  }
}

async function disposeOpenCodeInstance() {
  // Provider state is cached by OpenCode. Disposing the instance forces the
  // next /provider request to rebuild its state from auth.json.
  await fetchWithTimeout(`${opencodeUrl}/instance/dispose`, { method: "POST", headers: opencodeRequestHeaders() }, 10000).catch(() => {});
}

ipcMain.handle("provider:connect", async (_event, payload: { providerID: string; key: string }) => {
  const id = String(payload?.providerID || "").trim();
  const key = String(payload?.key || "").trim();
  if (!id || !key) throw new Error("Provedor ou chave de API não informados.");

  const connectedBefore = await readConnectedProviderIDs();
  if (connectedBefore.has(id)) {
    // Connecting an already-connected provider must be idempotent. In
    // particular, never overwrite its credential just because the user
    // clicked its row in the provider list.
    return { ok: true, alreadyConnected: true };
  }

  // Use the provider credential endpoint directly instead of client.auth.set.
  // In newer OpenCode SDKs `auth.remove`/`auth.set` names overlap with the MCP
  // auth API, which caused the old disconnect implementation to call
  // DELETE /mcp/{name}/auth and return "MCP server not found".
  const response = await fetchWithTimeout(`${opencodeUrl}/auth/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...opencodeRequestHeaders() },
    body: JSON.stringify({ type: "api", key })
  }, 10000);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Não foi possível conectar o provedor: HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  await disposeOpenCodeInstance();
  return { ok: true, alreadyConnected: false };
});

ipcMain.handle("provider:disconnect", async (_event, providerID: string) => {
  const id = String(providerID || "").trim();
  if (!id) throw new Error("Provedor não informado.");

  const connectedBefore = await readConnectedProviderIDs();
  if (!connectedBefore.has(id)) {
    await disposeOpenCodeInstance();
    return { ok: true, alreadyDisconnected: true };
  }

  // IMPORTANT: call the provider credential endpoint directly. Do not use
  // client.auth.remove(), because in the installed SDK that method maps to
  // MCP OAuth removal (/mcp/{name}/auth), producing the exact 404 seen in the
  // NekoAI terminal. OpenCode's provider credentials use DELETE /auth/:id.
  const response = await fetchWithTimeout(`${opencodeUrl}/auth/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: opencodeRequestHeaders()
  }, 10000);

  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Não foi possível desconectar o provedor: HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  await disposeOpenCodeInstance();

  // Verify the state after cache invalidation. This prevents the renderer from
  // reporting success while OpenCode still thinks the provider is connected.
  const connectedAfter = await readConnectedProviderIDs();
  if (connectedAfter.has(id)) {
    throw new Error("O OpenCode ainda informa que este provedor está conectado. Tente novamente.");
  }

  return { ok: true, alreadyDisconnected: false };
});

async function runValidationBuild(projectPath: string) {
  const root = (await resolvePreviewProjectRoot(projectPath)) || projectPath;
  const info = await detectProject(root);
  if (!info.exists || !info.pkg) {
    return { ok: true, skipped: true, message: "Projeto ainda não possui package.json.", output: "" };
  }
  if (!info.pkg?.scripts?.build) {
    return { ok: true, skipped: true, message: "Este projeto não possui script de build.", output: "" };
  }
  const manager = info.packageManager || "npm";
  const command = packageManagerExecutable(manager);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec || "cmd.exe") : command;
    const args = isWindows ? ["/d", "/s", "/c", windowsCommandLine(command, ["run", "build"])] : ["run", "build"];
    const child = spawn(executable, args, { cwd: root, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { const text = chunk.toString(); stdout += text; mainWindow?.webContents.send("preview:event", { type: "preview.output", properties: { stream: "stdout", text, source: "Build" } }); });
    child.stderr?.on("data", chunk => { const text = chunk.toString(); stderr += text; mainWindow?.webContents.send("preview:event", { type: "preview.output", properties: { stream: "stderr", text, source: "Build" } }); });
    child.on("error", reject);
    child.on("exit", code => resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return { ok: result.code === 0, skipped: false, message: result.code === 0 ? "Build validado." : "O build encontrou erros.", output: output.slice(-12000) };
}

ipcMain.handle("project:validateBuild", async () => {
  licenseManager.assertAccess("validação de build");
  const projectRoot = assertProjectRootSafe(currentProject, "validateBuild");
  logProjectWorkspace("validateBuild", projectRoot);
  return runValidationBuild(projectRoot);
});

ipcMain.handle("preview:start", async () => {
  licenseManager.assertAccess("servidor de preview");
  const projectRoot = assertProjectRootSafe(currentProject, "preview");
  logProjectWorkspace("preview", projectRoot);
  return startPreview(projectRoot);
});

ipcMain.handle("preview:stop", async () => {
  await stopPreview();
  return true;
});

ipcMain.handle("opencode:status", async () => {
  const projectRoot = getActiveProjectRoot();
  try {
    const response = await fetch(`${opencodeUrl}/global/health`, { headers: opencodeRequestHeaders() });
    if (!response.ok) throw new Error("offline");

    return {
      online: true,
      ...(await response.json()),
      project: projectRoot
    };
  } catch {
    return { online: false, project: projectRoot };
  }
});

ipcMain.handle("opencode:sessionStatus", async (_event, sessionId: string) => {
  if (!sessionId) return "idle";
  const active = activeAgentRequests.get(sessionId);
  if (active?.retryTimer || active?.isRetrying) {
    return "retry";
  }
  try {
    const response = await fetch(`${opencodeUrl}/session/status`, { headers: opencodeRequestHeaders() });
    if (!response.ok) return (active?.retryTimer || active?.isRetrying) ? "retry" : "unknown";
    const payload: any = await response.json();
    const statuses = payload?.data ?? payload ?? {};
    const status = statuses?.[sessionId];
    const engineStatus = status?.type ?? status ?? "idle";
    if (active?.retryTimer || active?.isRetrying) {
      return "retry";
    }
    return engineStatus;
  } catch {
    return (active?.retryTimer || active?.isRetrying) ? "retry" : "unknown";
  }
});

ipcMain.handle("opencode:messages", async (_event, sessionId: string) => {
  if (!sessionId) throw new Error("Sessão do Neko não encontrada.");
  const client: any = await getOpencodeClient();
  const result = await client.session.messages({ path: { id: sessionId } });
  return result?.data ?? result ?? [];
});

ipcMain.handle("opencode:prompt", async (_event, payload: {
  sessionId: string;
  text: string;
  model?: { providerID: string; modelID: string; variant?: string };
  attachments?: { path: string; name: string; mime: string; size?: number }[];
  contextPaths?: string[];
  planMode?: boolean;
  effort?: string;
  perf?: { t0?: number; prepMs?: number };
}) => {
  licenseManager.assertAccess("assistente de IA");
  const projectRoot = assertProjectRootSafe(currentProject, "analyze");
  logProjectWorkspace("analyze", projectRoot);
  if (!payload.sessionId) throw new Error("Sessão do Neko não encontrada.");

  const uploadCount = (payload.attachments?.length ?? 0) + (payload.contextPaths?.length ?? 0);
  const modelLabel = payload.model ? `${payload.model.providerID ?? "?"}/${payload.model.modelID ?? "?"}` : "";
  perfTaskStart(payload.sessionId, payload.perf, modelLabel, uploadCount);
  // A brand-new task resets the previous retry watchdog verdict for the
  // session: the new request gets a fresh chance before another error is raised.
  sessionModelLabels.set(payload.sessionId, modelLabel || "padrão da sessão");
  retryExhaustedSessions.delete(payload.sessionId);
  engineRetryStates.delete(payload.sessionId);
  forwardedSessionStatus.delete(payload.sessionId);
  clearStatusCacheForSession(payload.sessionId);
  const taskCorrelationId = newTaskCorrelationId(payload.sessionId);
  // A new prompt is a new task: fresh state record for the session so old
  // permissions/questions never leak into this execution.
  const previousRecord = taskRecords.get(payload.sessionId);
  if (previousRecord?.state === "waiting_for_user") {
    logTask("user-response", previousRecord.taskId, payload.sessionId);
  }
  taskRecords.set(payload.sessionId, {
    taskId: taskCorrelationId,
    sessionId: payload.sessionId,
    state: "idle",
    planMode: Boolean(payload.planMode),
    createdAt: Date.now(),
    stateAt: 0,
    sawBusy: false,
    lastActivityAt: 0,
    lastAssistantMessageId: "",
    askedQuestionIds: [],
    lastStreamedAssistantMessageId: ""
  });
  logTask("created", taskCorrelationId, payload.sessionId, `model=${modelLabel}${payload.planMode ? " mode=plan" : ""}`);

  if (uploadCount > 0) perfMark("uploadStart", payload.sessionId);
  const contextParts: any[] = [];
  const imageAttachments: Array<{ url: string; filename: string; mime: string }> = [];
  for (const rel of (payload.contextPaths ?? [])) {
    try {
      const absolute = safePathWithinProject(projectRoot, rel);
      const item = await validateAttachment(absolute);
      perfUploadBytes(item.size);
      contextParts.push({ type: "file", url: item.url, filename: item.name, mime: item.mime });
    } catch {}
  }
  for (const attachment of (payload.attachments ?? [])) {
    const item = await validateAttachment(attachment.path);
    perfUploadBytes(item.size);
    const filePart = { type: "file", url: item.url, filename: item.name, mime: item.mime };
    if (isVisionImage(item.name, item.mime)) {
      imageAttachments.push(filePart);
    } else {
      contextParts.push(filePart);
    }
  }
  perfMark("uploadReady", payload.sessionId);

  // ============================================================
  // VISION CAPABILITY / FALLBACK (MiMo V2.5 Free)
  // ------------------------------------------------------------
  // Decided once per prompt, from the cached provider catalog. Never
  // triggers a new providers:list request and never changes the user's
  // selected model. When the main model accepts images, images flow to it
  // directly. Otherwise MiMo V2.5 Free (free tier, auxiliary session)
  // interprets the images and the resulting text context is injected into
  // the main prompt with zero instruction authority.
  // ============================================================
  let userRequestText = payload.text;
  if (imageAttachments.length > 0) {
    const providerId = payload.model?.providerID ?? "";
    const modelId = payload.model?.modelID ?? "";
    const catalogMeta = payload.model ? providerCatalogCache.get(`${providerId}:${modelId}`) : undefined;
    const capabilities = getModelCapabilities(providerId, modelId, catalogMeta);
    console.log(`[Vision] capability-check provider=${providerId || "default"} model=${modelId || "default"} imageInput=${capabilities.imageInput} images=${imageAttachments.length}`);
    if (capabilities.imageInput) {
      contextParts.push(...imageAttachments);
      console.log(`[Vision] direct-send provider=${providerId || "default"} model=${modelId || "default"} images=${imageAttachments.length}`);
    } else {
      const fallbackProviderID = resolveVisionFallbackProvider();
      console.log(`[Vision] fallback-required provider=${providerId || "default"} model=${modelId || "default"} reason=image-input-unsupported images=${imageAttachments.length}`);
      console.log(`[Vision] fallback-start model=${fallbackProviderID}/${VISION_FALLBACK_MODEL.modelID} images=${imageAttachments.length}`);
      const fallback = await analyzeImagesWithMiMo({
        mainSessionId: payload.sessionId,
        opencodeUrl,
        headers: opencodeRequestHeaders(),
        images: imageAttachments,
        userPrompt: payload.text || "Analise a imagem anexada.",
        model: { providerID: fallbackProviderID, modelID: VISION_FALLBACK_MODEL.modelID }
      });
      // STOP during the fallback: never send the main prompt, never throw a
      // technical error — the renderer keeps the cancelled state untouched.
      if (fallback.ok === false && fallback.cancelled) {
        return { cancelled: true };
      }
      const currentRecord = taskRecords.get(payload.sessionId);
      if (currentRecord?.state === "cancelled") {
        return { cancelled: true };
      }
      if (!fallback.ok) {
        console.log(`[Vision] fallback-error reason=${fallback.reason}`);
        throw new Error(fallback.userMessage);
      }
      console.log(`[Vision] fallback-success images=${imageAttachments.length} chars=${fallback.analysis.length}`);
      userRequestText = buildVisionContext(fallback.analysis, imageAttachments.length, payload.text);
    }
  }

  const languageInstruction = `IDIOMA OBRIGATÓRIO DA INTERFACE: Português do Brasil (pt-BR).
Todas as respostas destinadas ao usuário devem ser escritas em português do Brasil, incluindo resumo, conclusão, explicações, nomes de etapas e qualquer texto final. Não responda em inglês, espanhol ou outro idioma. Preserve nomes técnicos inevitáveis (por exemplo, nomes de arquivos, APIs, bibliotecas, comandos, variáveis e URLs) somente quando forem necessários, mas explique o restante em português. Nunca copie ou reproduza logs, mensagens ou respostas internas de ferramentas como se fossem uma resposta ao usuário. Gere uma única resposta final, exclusivamente em português do Brasil. Não inclua uma versão em inglês antes ou depois da resposta em português.`;

  const planInstruction = `You are NekoAI's planning agent. Analyze the user's request and the current project, then create a comprehensive, implementation-ready plan. Do not edit project files directly. Formulate the plan clearly, detailing what will be changed, where it will be changed, and how it will be validated. When your plan is ready, you must call the native plan_exit tool to request user approval before any implementation begins. If you need any clarification or architectural choices from the user during planning, use the native question tool.

${languageInstruction}

USER REQUEST:
${userRequestText}`;

  const requestBody = {
    agent: payload.planMode ? "plan" : "build",
    ...(payload.planMode ? {} : {
      system: `You are the NekoAI software development agent. You have received an APPROVED PLAN from the user. Execute it now by modifying the project files directly in the current workspace. Do not merely describe the changes and do not ask for another approval. Do not run long-lived development servers such as npm run dev in the foreground and wait for them. The NekoAI Preview Manager handles dev servers separately. Focus on implementing the requested application, creating or editing files, installing dependencies when needed, and validating with short-lived commands. After implementation, verify that the requested changes actually exist in the files and report which files were changed. If you encounter critical ambiguity between multiple valid implementations or need the user's architectural choice, use the native question tool to ask the user.

${languageInstruction}`
    }),
    ...(payload.model ? { model: payload.model } : {}),
    parts: [{ type: "text", text: payload.planMode ? planInstruction : userRequestText }, ...contextParts]
  };

  const promptStartedAt = Date.now();
  console.log(`[Neko/Agent] enviando tarefa session=${payload.sessionId} model=${payload.model?.providerID ?? "default"}/${payload.model?.modelID ?? "default"} effort=${payload.effort ?? "default"}`);
  clearActiveAgentRequest(payload.sessionId);
  activeAgentRequests.set(payload.sessionId, { requestBody, attempts: 1, maxAttempts: AGENT_RETRY_DELAYS_MS.length + 1, isRetrying: false });
  perfMark("taskSend", payload.sessionId);
  const response = await fetchWithTimeout(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opencodeRequestHeaders() },
    body: JSON.stringify(requestBody)
  });
  const promptAckDurationMs = Date.now() - promptStartedAt;
  const promptModelLabel = `${payload.model?.providerID ?? "default"}/${payload.model?.modelID ?? "default"}`;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.log(`[Neko/Agent] prompt_async response task=${taskCorrelationId} session=${payload.sessionId} model=${promptModelLabel} status=${response.status} ok=false durationMs=${promptAckDurationMs} bodyChars=${body.length}`);
    const failed = { error: { data: { statusCode: response.status, message: body.slice(0, 500), isRetryable: response.status >= 500 || response.status === 429 } } };
    if (isRecoverableAgentError(failed) && scheduleAgentRetry(payload.sessionId, failed)) {
      setTaskState(payload.sessionId, "running", "prompt-retrying");
      logTask("started", taskCorrelationId, payload.sessionId, "retrying=true");
      return { accepted: true, retrying: true, acceptedInMs: promptAckDurationMs, taskId: taskCorrelationId };
    }
    clearActiveAgentRequest(payload.sessionId);
    setTaskState(payload.sessionId, "failed", "prompt-rejected");
    logTask("failed", taskCorrelationId, payload.sessionId, `status=${response.status}`);
    throw new Error(`Falha ao enviar tarefa ao agente (HTTP ${response.status}).${body ? ` ${body.slice(0, 240)}` : ""}`);
  }
  perfMark("t2", payload.sessionId);
  setTaskState(payload.sessionId, "running", "prompt-accepted");
  logTask("started", taskCorrelationId, payload.sessionId);

  console.log(`[Neko/Agent] prompt_async response task=${taskCorrelationId} session=${payload.sessionId} model=${promptModelLabel} status=${response.status} ok=true durationMs=${promptAckDurationMs}`);
  console.log(`[Neko/Agent] tarefa aceita em ${promptAckDurationMs}ms; execução agora é assíncrona no OpenCode`);

  // BUILD diagnostics only: one-shot post-ACK probe (~5s) to distinguish
  // "accepted but never ran" from slow/stale SSE. Deduplicated, never repeated.
  const postAckKey = `${taskCorrelationId}:${payload.sessionId}`;
  if (!postAckDiagScheduled.has(postAckKey)) {
    postAckDiagScheduled.add(postAckKey);
    setTimeout(() => {
      postAckDiagScheduled.delete(postAckKey);
      void runPostAckDiag(payload.sessionId, taskCorrelationId);
    }, 5000);
  }
  return { accepted: true, acceptedInMs: promptAckDurationMs, taskId: taskCorrelationId };
});

ipcMain.handle("opencode:permissions", async (_event, sessionId: string) => {
  if (!sessionId) return [];
  try {
    const response = await fetch(`${opencodeUrl}/permission`, { headers: opencodeRequestHeaders() });
    if (!response.ok) return [];
    const payload = await response.json();
    const list = Array.isArray(payload) ? payload : (payload?.data ?? payload?.permissions ?? []);
    return (Array.isArray(list) ? list : []).filter((item: any) => item?.sessionID === sessionId);
  } catch {
    return [];
  }
});

ipcMain.handle("opencode:permissionReply", async (_event, payload: {
  sessionId: string;
  permissionId: string;
  response: "once" | "always" | "reject";
  remember?: boolean;
}) => {
  licenseManager.assertAccess("permissões de execução");
  if (!payload?.sessionId || !payload?.permissionId) throw new Error("Pedido de permissão inválido.");
  const bodyPayload = { response: payload.response, ...(payload.remember ? { remember: true } : {}) };
  const headers = { "Content-Type": "application/json", ...opencodeRequestHeaders() };
  let response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/permissions/${encodeURIComponent(payload.permissionId)}`, {
    method: "POST", headers, body: JSON.stringify(bodyPayload)
  });

  // Some OpenCode builds expose the legacy permission reply route instead of
  // the session-scoped route. Retry the same request against that endpoint,
  // still pinned to the active project instance.
  if (!response.ok && (response.status === 404 || response.status === 405)) {
    response = await fetch(`${opencodeUrl}/permission/${encodeURIComponent(payload.permissionId)}/reply`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload)
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Não foi possível responder à confirmação (HTTP ${response.status}).${body ? ` ${body.slice(0, 220)}` : ""}`);
  }
  return true;
});

ipcMain.handle("opencode:questionReply", async (_event, payload: {
  sessionId: string;
  requestId: string;
  answers: string[];
}) => {
  licenseManager.assertAccess("respostas de interação");
  if (!payload?.sessionId || !payload?.requestId) throw new Error("Pedido de resposta inválido.");
  const answersFormatted = (Array.isArray(payload.answers) ? payload.answers : [String(payload.answers || "")])
    .map(a => Array.isArray(a) ? a : [String(a)]);
  const bodyPayload = { answers: answersFormatted };
  const headers = { "Content-Type": "application/json", ...opencodeRequestHeaders() };

  // 1. Primary OpenCode endpoint: POST /question/{id}/reply
  let response = await fetch(`${opencodeUrl}/question/${encodeURIComponent(payload.requestId)}/reply`, {
    method: "POST", headers, body: JSON.stringify(bodyPayload)
  });

  // 2. Fallback route: POST /session/{sessionId}/question/{requestId}/reply
  if (!response.ok && (response.status === 404 || response.status === 405)) {
    response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/question/${encodeURIComponent(payload.requestId)}/reply`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload)
    });
  }

  // 3. Fallback route 2: POST /api/session/{sessionId}/question/{requestId}/reply
  if (!response.ok && (response.status === 404 || response.status === 405)) {
    response = await fetch(`${opencodeUrl}/api/session/${encodeURIComponent(payload.sessionId)}/question/${encodeURIComponent(payload.requestId)}/reply`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload)
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Não foi possível enviar a resposta (HTTP ${response.status}).${body ? ` ${body.slice(0, 220)}` : ""}`);
  }

  const record = taskRecords.get(payload.sessionId);
  if (record && record.state === "waiting_for_user") {
    record.state = "running";
    record.sawBusy = true;
    record.lastActivityAt = Date.now();
    logTask("user-response", record.taskId, payload.sessionId, `requestId=${payload.requestId}`);
    setTaskState(payload.sessionId, "running", "user-answered", { requestId: payload.requestId });
  }

  return true;
});

ipcMain.handle("opencode:questionReject", async (_event, payload: {
  sessionId: string;
  requestId: string;
}) => {
  licenseManager.assertAccess("respostas de interação");
  if (!payload?.sessionId || !payload?.requestId) throw new Error("Pedido de rejeição inválido.");
  const headers = { "Content-Type": "application/json", ...opencodeRequestHeaders() };

  // 1. Primary OpenCode endpoint: POST /question/{id}/reject
  let response = await fetch(`${opencodeUrl}/question/${encodeURIComponent(payload.requestId)}/reject`, {
    method: "POST", headers, body: JSON.stringify({})
  });

  // 2. Fallback route: POST /session/{sessionId}/question/{requestId}/reject
  if (!response.ok && (response.status === 404 || response.status === 405)) {
    response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/question/${encodeURIComponent(payload.requestId)}/reject`, {
      method: "POST", headers, body: JSON.stringify({})
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Não foi possível rejeitar a pergunta (HTTP ${response.status}).${body ? ` ${body.slice(0, 220)}` : ""}`);
  }

  const record = taskRecords.get(payload.sessionId);
  if (record && record.state === "waiting_for_user") {
    record.state = "running";
    record.sawBusy = true;
    record.lastActivityAt = Date.now();
    logTask("user-rejected", record.taskId, payload.sessionId, `requestId=${payload.requestId}`);
    setTaskState(payload.sessionId, "running", "user-rejected", { requestId: payload.requestId });
  }

  return true;
});

ipcMain.handle("opencode:abort", async (_event, sessionId: string) => {
  if (!sessionId) throw new Error("Sessão do Neko não encontrada.");
  clearActiveAgentRequest(sessionId);
  engineRetryStates.delete(sessionId);
  const recheckTimer = idleRecheckTimers.get(sessionId);
  if (recheckTimer) {
    clearTimeout(recheckTimer);
    idleRecheckTimers.delete(sessionId);
  }
  for (const [key, item] of questionRecheckTimers.entries()) {
    if (key.endsWith(`:${sessionId}`)) {
      clearTimeout(item.timer);
      questionRecheckTimers.delete(key);
    }
  }
  cancelAgentInactivityWatchdog(sessionId);
  if (!opencodeUrl) throw new Error("OpenCode não está conectado.");

  const response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
    method: "POST",
    headers: opencodeRequestHeaders()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao interromper a sessão (HTTP ${response.status}).${body ? ` ${body.slice(0, 240)}` : ""}`);
  }

  // STOP cancels the execution, never the already-written files. The agent
  // is asked to stop, the task transitions to cancelled and the Preview and
  // workspace stay exactly as they are. A running Vision Fallback for this
  // session is cancelled together with the task: a late visual analysis can
  // never resurrect a cancelled task.
  if (taskRecords.has(sessionId)) {
    setTaskState(sessionId, "cancelled", "user-stop");
    logTask("cancelled", resolveTaskIdForSession(sessionId), sessionId);
  }
  cancelVisionFallbackFor(sessionId);
  perfFlushTask(sessionId, "aborted");
  try {
    return Boolean(await response.json());
  } catch {
    return true;
  }
});

ipcMain.handle("preview:styleFrame", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const frames = ((mainWindow.webContents.mainFrame as any)?.framesInSubtree ?? []) as any[];
  let styled = false;
  for (const frame of frames) {
    const frameUrl = String(frame?.url || "");
    if (!frameUrl.includes("127.0.0.1") && !frameUrl.includes("localhost")) continue;
    try {
      styled = (await injectPreviewScrollbar(frame)) || styled;
    } catch (err) {
      console.warn("[Neko/Preview] scrollbar inject failed for frame", frameUrl, err instanceof Error ? err.message : String(err));
    }
  }
  if (styled) perfMark("t6");
  // ALWAYS emit frame-ready — scrollbar theming is cosmetic, visibility is mandatory
  mainWindow.webContents.send("preview:event", { type: "preview.frame-ready", properties: {} });
  return true;
});

ipcMain.handle("preview:internalSync", async (_event, payload: any) => {
  const visible = Boolean(payload?.visible);
  const url = typeof payload?.url === "string" ? payload.url : "";
  const session = Number(payload?.session);
  const rawBounds = payload?.bounds;
  if (!visible) {
    detachInternalPreviewView(false);
    return { enabled: false, state: internalPreviewState };
  }
  if (!Number.isInteger(session) || session !== activePreviewSessionId || !isAllowedInternalPreviewUrl(url)) {
    throw new Error("Preview interno recusou uma sessão ou URL inválida.");
  }
  // The URL must point to the ACTIVE Preview server. Only the origin matters:
  // the route (pathname/search/hash) is the current page and never a server
  // change, so legitimate route/query URLs must be accepted.
  if (!previewState.url || !previewServerOriginMatches(url, previewState.url)) {
    throw new Error("A URL do Preview interno não corresponde ao servidor ativo.");
  }
  const x = Math.max(0, Math.round(Number(rawBounds?.x)) || 0);
  const y = Math.max(0, Math.round(Number(rawBounds?.y)) || 0);
  const width = Math.max(1, Math.round(Number(rawBounds?.width)) || 0);
  const height = Math.max(1, Math.round(Number(rawBounds?.height)) || 0);
  const view = ensureInternalPreviewView();
  if (!view) return { enabled: false, state: "idle" as const };
  try { mainWindow?.contentView.addChildView(view); } catch {}
  view.setBounds({ x, y, width, height });
  internalPreviewSession = session;
  if (!previewUrlsMatch(internalPreviewUrl, url)) {
    internalPreviewUrl = url;
    logInternalPreview("loading", "navigation=requested");
    await view.webContents.loadURL(url);
  }
  return { enabled: true, state: internalPreviewState };
});

// "Atualizar Preview": reloads the current page NATIVELY, without changing
// the URL. The internal WebContents keeps its current route (pathname,
// search and hash are all preserved by a reload). This never adds artificial
// query parameters such as "?t=timestamp".
ipcMain.handle("preview:refresh", async () => {
  const view = internalPreviewView;
  if (!view || view.webContents.isDestroyed()) {
    return { ok: false, reason: "no-internal-view" };
  }
  try {
    const current = view.webContents.getURL();
    console.log(`[Preview] refresh origin=${(() => { try { return new URL(current).origin; } catch { return ""; } })()} url=${sanitizeExternalPreviewUrl(current)}`);
    view.webContents.reload();
    const activeRoot = getActiveProjectRoot();
    if (activeRoot && current) {
      setTimeout(() => {
        captureProjectPreviewThumbnail(activeRoot, current, true);
      }, 1500);
    }
    return { ok: true, method: "reload" };
  } catch (error) {
    console.warn(`[Preview] refresh failed: ${String((error as any)?.message ?? error)}`);
    return { ok: false, reason: String((error as any)?.message ?? error) };
  }
});

// Page Selector overlay support. The internal Preview is a native
// WebContentsView, which Electron always paints ABOVE the renderer DOM — no
// CSS z-index can raise a DOM dropdown over it. While a DOM overlay (the page
// selector dropdown) is open we hide the native view so the dropdown paints
// fully on top; it is restored as soon as the overlay closes.
ipcMain.handle("preview:internalOverlay", async (_event, overlay: boolean) => {
  const view = internalPreviewView;
  if (!view || view.webContents.isDestroyed()) {
    return { ok: false, visible: !overlay };
  }
  try {
    view.setVisible(!overlay);
  } catch {}
  return { ok: true, visible: !overlay };
});

// Page Selector: returns the discovered routes of the active project.
ipcMain.handle("preview:routes", async (_event, payload?: { force?: boolean }) => {
  const projectRoot = assertProjectRootSafe(currentProject, "preview-routes");
  const routes = await getPreviewRoutes(Boolean(payload?.force));
  return { routes, projectPath: projectRoot };
});

// Page Selector: navigate the internal preview to a discovered route,
// preserving the origin and never adding artificial query parameters.
ipcMain.handle("preview:navigate", async (_event, routePath: string) => {
  const normalized = normalizeRoutePath(routePath);
  if (normalized === "/" || !normalized) throw new Error("Rota de Preview inválida.");
  // Dynamic detail routes (/equipamentos/:id) cannot be opened without real
  // parameters. Never invent them: open the static prefix instead (safe).
  let openable = normalized;
  if (openable !== "/") {
    const parts = openable.split("/");
    while (parts.length > 1 && isDynamicSegment(parts[parts.length - 1])) parts.pop();
    openable = parts.join("/") || "/";
    openable = normalizeRoutePath(openable);
  }
  const originSource = internalPreviewUrl || previewState.url || "";
  let origin = "";
  try { origin = new URL(originSource).origin; } catch {}
  if (!origin) throw new Error("Nenhum servidor de Preview ativo no momento.");
  const target = new URL(openable, origin).toString();
  console.log(`[Preview Routes] navigate origin=${origin} route=${normalized} openable=${openable}`);
  const view = internalPreviewView;
  if (!view || view.webContents.isDestroyed()) {
    // No internal surface yet: just reflect intent on the state URL.
    if (!previewUrlsMatch(internalPreviewUrl, target)) {
      internalPreviewUrl = target;
      emitInternalPreviewRoute(target);
    }
    return { ok: true, target, method: "state" };
  }
  // Only a real navigation if the route actually changed; otherwise reload is
  // handled by "Atualizar Preview" (native reload, route preserved).
  if (!previewUrlsMatch(internalPreviewUrl, target)) {
    internalPreviewUrl = target;
    logInternalPreview("loading", "navigation=route");
    await view.webContents.loadURL(target);
    emitInternalPreviewRoute(view.webContents.getURL());
  }
  return { ok: true, target, method: "load" };
});

// Site Clone — analysis IPC. Deterministic static crawl of a public URL.
// Progress is streamed to the renderer through "siteclone:event".
ipcMain.handle("siteClone:analyze", async (_event, payload: { url: string; limits?: SiteCloneLimits }) => {
  const send = (type: string, properties: Record<string, any>) => {
    try {
      mainWindow?.webContents.send("siteclone:event", { type, properties });
    } catch {}
  };
  send("start", { url: String(payload?.url ?? "") });
  const analysis: SiteCloneAnalysis = await analyzeSite(String(payload?.url ?? ""), payload?.limits, info => {
    send("progress", { scanned: info.scanned, currentUrl: info.currentUrl });
  });
  send(analysis.ok ? "done" : "error", { ok: analysis.ok, pages: analysis.pages?.length ?? 0, error: analysis.error ?? null });
  return analysis;
});

ipcMain.handle("siteClone:cancel", async () => {
  cancelAllSiteClones();
  return { ok: true };
});

// Clonar Site V2 — captura com Chromium real (DOM executado + estilos). Cria
// uma janela oculta com partition isolada, navega só a origem fornecida e
// devolve um snapshot estruturado. Nunca substitui o Preview normal.
ipcMain.handle("siteClone:capture", async (_event, payload: { url?: string }) => {
  const rawUrl = String(payload?.url ?? "").trim();
  console.log(`[SiteClone] capture-request url=${rawUrl}`);
  const snapshot = await captureSiteChromium(rawUrl, { BrowserWindow });
  console.log(`[SiteClone] capture-result ok=${snapshot.ok} pages=${snapshot.pages?.length ?? 0} assets=${snapshot.assets?.length ?? 0} error=${snapshot.error ?? ""}`);
  return snapshot;
});

// Download public image/font assets into the ACTIVE project (public/clone-assets)
// so the reconstruction uses real local files instead of placeholders/hotlinks.
ipcMain.handle("siteClone:importAssets", async (_event, payload: { assets?: { url: string; kind: string }[] }) => {
  const projectRoot = assertProjectRootSafe(currentProject, "site-clone-assets");
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  console.log(`[SiteClone] import-assets project=${projectRoot} count=${assets.length}`);
  const result = await importSiteAssets(projectRoot, assets);
  console.log(`[SiteClone] import-assets ok=${result.ok} imported=${result.imported.length} failed=${result.failed.length}`);
  return result;
});

// The external Preview window is created once and reused while open. The
// state below removes the races between window creation, loadURL, Vite HMR
// reloads and window close/reopen:
// - a single creation promise prevents two BrowserWindows for the same Preview;
// - the latest requested URL always wins (a newer loadURL supersedes the
//   previous one instead of running concurrent navigations on the same
//   WebContents, which is what produced ERR_ABORTED);
// - the window stays hidden until the page for the latest requested URL
//   finished loading, so a stale page never flashes before the new one.
let externalPreviewWindow: BrowserWindow | null = null;
let externalPreviewCreating: Promise<BrowserWindow> | null = null;
let externalPreviewTargetUrl = "";
let externalPreviewClosing = false;

function logExternalPreview(step: string, extra?: string) {
  console.log(`[Neko/PreviewExternal] ${step}${extra ? ` ${extra}` : ""}`);
}

function sanitizeExternalPreviewUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(value || "").replace(/[?&][^=]*=.*$/, "?…") || "<vazio>";
  }
}

function isExpectedNavigationAbort(error: unknown): boolean {
  const errno = Number((error as any)?.errno ?? 0);
  const code = String((error as any)?.code ?? "");
  const message = String((error as any)?.message ?? "");
  return errno === -3 || code === "ERR_ABORTED" || /ERR_ABORTED/i.test(message);
}

function previewUrlsMatch(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    return urlA.origin === urlB.origin && urlA.pathname === urlB.pathname && urlA.search === urlB.search;
  } catch {
    return a === b;
  }
}

// The active Preview server is identified by its ORIGIN only. A current route
// (pathname/search/hash) never means "a different server", so route changes
// and legitimate query parameters must not be treated as a server mismatch.
function previewServerOriginMatches(url: string, serverUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return url === serverUrl;
  }
}

async function createExternalPreviewWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#070510",
    title: "NekoAI Preview",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  logExternalPreview("window-create");
  win.on("close", () => {
    if (externalPreviewWindow === win) externalPreviewClosing = true;
    logExternalPreview("close");
  });
  win.on("closed", () => {
    if (externalPreviewWindow === win) {
      externalPreviewWindow = null;
      externalPreviewClosing = false;
    }
    try { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch {}
    logExternalPreview("closed");
  });
  // Theme preparation is a visual fallback only. It must never block window
  // creation, listener registration, loadURL, ready-to-show, did-finish-load
  // or show. debugger.attach()/sendCommand() on a hidden, not-yet-navigated
  // window can hang forever, so it runs fire-and-forget with its own catch.
  void installPreviewDocumentStartTheme(win.webContents).catch((error) => {
    console.warn("[Neko/Preview] não foi possível preparar o tema do Preview externo:", error);
  });
  win.once("ready-to-show", () => {
    logExternalPreview("ready-to-show");
  });
  win.webContents.on("did-finish-load", () => {
    // Reveal only when the finished page is the one the user asked for.
    // A navigation superseded by a newer load must never flash on screen.
    logExternalPreview("did-finish-load", `url=${sanitizeExternalPreviewUrl(win.webContents.getURL())}`);
    if (!win.isDestroyed() && previewUrlsMatch(win.webContents.getURL(), externalPreviewTargetUrl)) {
      void injectPreviewScrollbar(win.webContents.mainFrame).then(() => {
        if (!win.isDestroyed()) {
          win.show();
          logExternalPreview("show");
        }
      });
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    // -3 (ERR_ABORTED) is the normal result of a superseded navigation; real
    // failures are logged for diagnostics but never block the handler.
    if (errorCode === -3) {
      logExternalPreview("did-fail-load", "code=-3 navegação substituída (esperado)");
      return;
    }
    logExternalPreview("did-fail-load", `code=${errorCode} desc=${logSafeText(errorDescription, 100)} url=${sanitizeExternalPreviewUrl(validatedURL)}`);
  });
  win.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (!isMainFrame) void injectPreviewScrollbar((webFrameMain as any).fromId(frameProcessId, frameRoutingId));
  });
  return win;
}

async function getExternalPreviewWindow(): Promise<BrowserWindow> {
  if (externalPreviewWindow && !externalPreviewWindow.isDestroyed() && !externalPreviewWindow.webContents.isDestroyed() && !externalPreviewClosing) {
    logExternalPreview("window-reuse");
    return externalPreviewWindow;
  }
  if (!externalPreviewCreating) {
    externalPreviewCreating = createExternalPreviewWindow().then(win => {
      externalPreviewWindow = win;
      // The previous window may still be finishing its close; the new one is
      // usable immediately.
      externalPreviewClosing = false;
      return win;
    }).finally(() => {
      externalPreviewCreating = null;
    });
  }
  return externalPreviewCreating;
}

function loadExternalPreviewUrl(win: BrowserWindow, target: string): Promise<void> {
  const contents = win.webContents;
  if (!contents.isLoading() && previewUrlsMatch(contents.getURL(), target)) {
    logExternalPreview("load-skip", "url atual já corresponde");
    return Promise.resolve();
  }
  logExternalPreview("load-start", `url=${sanitizeExternalPreviewUrl(target)}`);
  return contents.loadURL(target).then(
    () => undefined,
    (error) => {
      // ERR_ABORTED is the expected result of a superseded navigation (rapid
      // re-click, HMR full reload, manual refresh) or of the window being
      // closed while loading. Real navigation failures (DNS, connection
      // refused, bad certificate...) keep propagating to the caller.
      if (!isExpectedNavigationAbort(error)) {
        logExternalPreview("ERROR", `step=load-url code=${String((error as any)?.errno ?? (error as any)?.code ?? "")} msg=${logSafeText(error instanceof Error ? error.message : error)}`);
        throw error;
      }
      const superseded = !win.isDestroyed() && (contents.isLoading() || previewUrlsMatch(contents.getURL(), target));
      logExternalPreview("nav-aborted", superseded ? "navegação substituída (esperado)" : "janela fechada durante carregamento (esperado)");
    }
  );
}

function isLocalhostPreviewUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && /^https?:$/.test(parsed.protocol);
  } catch {
    return false;
  }
}

ipcMain.handle("preview:openExternal", async (_event, rawUrl: string) => {
  console.log(`[Preview] external open requested rawUrl=${sanitizeExternalPreviewUrl(rawUrl)} previewState.url=${sanitizeExternalPreviewUrl(previewState.url || "")} previewState.status=${previewState.status}`);
  const currentPreviewUrl = typeof previewState.url === "string" ? previewState.url : "";
  let value = "";

  // Prefer the CURRENT route of the internal preview WebContents: if the user
  // navigated internally to /dashboard, "Abrir em nova janela" must open
  // /dashboard — not the server root. Otherwise fall back to the renderer
  // provided URL and then to the server base.
  try {
    const internal = internalPreviewView;
    if (internal && !internal.webContents.isDestroyed()) {
      const internalCurrent = internal.webContents.getURL();
      if (internalCurrent && isLocalhostPreviewUrl(internalCurrent) && currentPreviewUrl && previewServerOriginMatches(internalCurrent, currentPreviewUrl)) {
        value = internalCurrent;
      }
    }
  } catch {}

  if (!value) {
    const requested = String(rawUrl || "").trim();
    if (requested && currentPreviewUrl && previewServerOriginMatches(requested, currentPreviewUrl)) {
      value = requested;
    } else if (currentPreviewUrl && previewState.status === "ready") {
      value = currentPreviewUrl;
    } else if (requested) {
      value = requested;
    }
  }

  if (!value) {
    console.log("[Preview] external open failed: no preview URL available");
    throw new Error("Nenhum servidor de Preview ativo no momento.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    console.log(`[Preview] external open failed: invalid URL ${value}`);
    throw new Error("Endereço de Preview inválido.");
  }
  if (!((url.hostname === "127.0.0.1" || url.hostname === "localhost") && /^https?:$/.test(url.protocol))) {
    console.log(`[Preview] external open failed: non-local URL rejected ${value}`);
    throw new Error("Por segurança, apenas o Preview local pode ser aberto nesta janela.");
  }

  try {
    const target = url.toString();
    console.log(`[Preview] external open url=${target} session=${activePreviewSessionId}`);
    const win = await getExternalPreviewWindow();
    externalPreviewTargetUrl = target;
    await loadExternalPreviewUrl(win, target);
    if (!win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    console.log(`[Preview] external open success url=${target}`);
    return true;
  } catch (error) {
    console.log(`[Preview] external open failed url=${value} error=${String((error as any)?.message ?? error)}`);
    throw error;
  }
});

ipcMain.handle("project:stop", async (_event, payload?: { source?: string }) => {
  const source = payload?.source || "renderer";
  console.log(`[ProjectSwitch] REQUEST source=${source} target=null (stop)`);
  if (activeWorkspace) {
    activeWorkspace.status = "stopping";
  }
  currentProject = null;
  activeWorkspace = null;
  void supabaseManager.setProject(null);
  void vercelManager.setProject(null);
  await stopOpenCode();
  await stopPreview();
  return true;
});

ipcMain.handle("supabase:get-state", async () => {
  return supabaseManager.getState();
});

ipcMain.handle("supabase:connect-with-token", async (_event, token: string) => {
  try {
    return await supabaseManager.connectWithToken(token);
  } catch (error: any) {
    const parsed = parseSupabaseError(error);
    return {
      ...supabaseManager.getState(),
      error: parsed.message,
      structuredError: parsed,
    };
  }
});

ipcMain.handle("supabase:refresh-projects", async (_event, clearNotice: boolean = false) => {
  try {
    return await supabaseManager.refreshProjects(clearNotice);
  } catch (error: any) {
    const parsed = parseSupabaseError(error);
    return {
      ...supabaseManager.getState(),
      error: parsed.message,
      structuredError: parsed,
    };
  }
});

ipcMain.handle("supabase:create-project", async (_event, payload: SupabaseCreateProjectPayload) => {
  try {
    return await supabaseManager.createProject(payload);
  } catch (error: any) {
    const parsed = parseSupabaseError(error);
    return {
      ...supabaseManager.getState(),
      error: parsed.message,
      structuredError: parsed,
    };
  }
});

ipcMain.handle("supabase:select-project", async (_event, ref: string) => {
  const projectRoot = getActiveProjectRoot();
  if (!projectRoot) {
    const parsed = parseSupabaseError("Nenhum projeto ativo.");
    return {
      ...supabaseManager.getState(),
      error: parsed.message,
      structuredError: parsed,
    };
  }
  try {
    const info = await detectProject(projectRoot).catch(() => null);
    return await supabaseManager.selectProject(projectRoot, ref, {
      framework: info?.framework || "Node",
      packageManager: info?.packageManager || "npm",
    });
  } catch (error: any) {
    const parsed = parseSupabaseError(error);
    return {
      ...supabaseManager.getState(),
      error: parsed.message,
      structuredError: parsed,
    };
  }
});

ipcMain.handle("supabase:disconnect", async () => {
  const projectRoot = assertProjectRootSafe(currentProject, "supabase-disconnect");
  return await supabaseManager.disconnect(projectRoot);
});

ipcMain.handle("supabase:open-token-page", async () => {
  await shell.openExternal("https://supabase.com/dashboard/account/tokens");
  return { success: true };
});

ipcMain.handle("supabase:open-dashboard", async () => {
  await shell.openExternal("https://supabase.com/dashboard");
  return { success: true };
});

let vercelPublishInProgress = false;

ipcMain.handle("vercel:get-state", async () => {
  return vercelManager.getState();
});

ipcMain.handle("vercel:connect", async () => {
  return await vercelManager.connect();
});

ipcMain.handle("vercel:disconnect", async () => {
  return await vercelManager.disconnect();
});

ipcMain.handle("vercel:publish", async (_event, customProjectName?: string) => {
  licenseManager.assertAccess("publicação na Vercel");
  if (vercelPublishInProgress) {
    throw new Error("Já existe uma publicação na Vercel em andamento.");
  }
  const projectRoot = assertProjectRootSafe(currentProject, "vercel-publish");
  logProjectWorkspace("vercel-publish", projectRoot);

  const isLinked = fs.existsSync(path.join(projectRoot, ".vercel", "project.json"));
  let validatedProjectName: string | undefined;

  if (!isLinked) {
    const rawName = String(customProjectName || "").trim();
    if (!rawName) {
      throw new Error("Informe o nome do projeto na Vercel.");
    }
    if (!isValidVercelProjectName(rawName)) {
      throw new Error(
        "Nome do projeto inválido. O nome deve ter até 100 caracteres, estar em minúsculas e conter apenas letras, números, '.', '_' e '-' (sem '---')."
      );
    }
    validatedProjectName = rawName;
  }

  vercelPublishInProgress = true;
  try {
    const environment: Record<string, string> = {};
    const info = await detectProject(projectRoot).catch(() => null);
    const supabaseIntegration = await supabaseManager.getIntegration(projectRoot);
    if (supabaseIntegration) {
      const names = getSupabaseEnvironmentNames(info?.framework || "Vite");
      environment[names.url] = supabaseIntegration.projectUrl;
      environment[names.publishableKey] = supabaseIntegration.publishableKey;
    }
    return await vercelManager.deploy(projectRoot, environment, validatedProjectName);
  } finally {
    vercelPublishInProgress = false;
  }
});

ipcMain.handle("vercel:open-deployment", async () => {
  const url = vercelManager.getState().deploymentUrl;
  if (!url) return { success: false };
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
      await shell.openExternal(parsed.toString());
      return { success: true };
    }
  } catch {}
  return { success: false };
});

ipcMain.handle("vercel:open-dashboard", async () => {
  await shell.openExternal("https://vercel.com/dashboard");
  return { success: true };
});




const NEKO_PREVIEW_SCROLLBAR_CSS = `
  html, body, * {
    scrollbar-width: thin !important;
    scrollbar-color: rgba(151,132,178,.42) transparent !important;
  }
  ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
  ::-webkit-scrollbar-track { background: transparent !important; }
  ::-webkit-scrollbar-thumb { background: rgba(151,132,178,.38) !important; border-radius: 999px !important; border: 1px solid transparent !important; background-clip: padding-box !important; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(176,145,221,.62) !important; }
  ::-webkit-scrollbar-corner { background: transparent !important; }
`;

const NEKO_PREVIEW_SCROLLBAR_JS = `(function(){
  const css = ${JSON.stringify(NEKO_PREVIEW_SCROLLBAR_CSS)};
  const id = "__neko_scrollbar_theme";
  function apply(){
    try {
      const root = document.documentElement;
      if (!root) return false;
      let style = document.getElementById(id);
      if (!style) {
        style = document.createElement("style");
        style.id = id;
        root.appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
      return true;
    } catch (_) { return false; }
  }
  if (!apply()) {
    const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  }
  return true;
})()`;

const NEKO_PREVIEW_DOCUMENT_START_JS = `(function(){
  try {
    const host = String(location.hostname || "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost") return;
    ${NEKO_PREVIEW_SCROLLBAR_JS.slice(11, -2)}
  } catch (_) {}
})()`;

async function installPreviewDocumentStartTheme(contents: Electron.WebContents) {
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: NEKO_PREVIEW_DOCUMENT_START_JS,
      worldName: "NekoPreviewTheme"
    });
  } catch (error) {
    console.warn("[Neko/Preview] não foi possível preparar o tema inicial do Preview:", error instanceof Error ? error.message : String(error));
  }
}

async function injectPreviewScrollbar(frame: any) {
  if (!frame) return false;
  try { await frame.executeJavaScript?.(NEKO_PREVIEW_SCROLLBAR_JS, true); return true; } catch { return false; }
}

function createWindow() {
  const windowIconPath = process.platform === "win32"
    ? path.join(__dirname, "../assets/icon.ico")
    : path.join(__dirname, "../assets/icon.png");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    backgroundColor: "#070510",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    // Start maximized like a normal Windows desktop app.
    // This preserves the title bar and Windows taskbar (unlike kiosk/fullscreen).
    mainWindow?.maximize();
    mainWindow?.show();
  });

  thumbnailService.setMainWindowGetter(() => mainWindow);
  thumbnailService.setInternalPreviewViewGetter(() => internalPreviewView);
  thumbnailService.setIsInsideAppRootChecker((p: string) => isInsideNekoApplication(p));

  supabaseManager.on("state-changed", (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("supabase:state-changed", state);
    }
  });

  vercelManager.on("state-changed", (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("vercel:state-changed", state);
    }
  });

  vercelManager.on("log", (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("vercel:log", message);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error("[Neko/Renderer] did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
    // Detect preview subframe load failures and notify the renderer
    if (!isMainFrame && (validatedURL.includes("127.0.0.1") || validatedURL.includes("localhost"))) {
      mainWindow?.webContents.send("preview:event", {
        type: "preview.frame-error",
        properties: { errorCode, errorDescription, url: validatedURL }
      });
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Neko/Renderer] render-process-gone", details);
    console.error("[BLACKSCREEN-RENDERER] render-process-gone", { reason: details.reason, exitCode: details.exitCode });
  });

  // Detecta se uma mensagem de console representa um erro real do Preview
// (ignora warnings, HMR, logs de desenvolvimento, logs internos do Vite)
function isRealPreviewError(message: string, level: number, source: string): boolean {
  if (!message.trim()) return false;
  // Apenas erros (level >= 3) são considerados erros reais
  if (level < 3) return false;
  // Ignora mensagens de HMR/desenvolvimento do Vite
  if (message.includes("[vite]") && (message.includes("hmr") || message.includes("hmr update") || message.includes("connected") || message.includes("update"))) return false;
  // Ignora mensagens de hot module replacement
  if (message.includes("hmr") || message.includes("hot module")) return false;
  // Ignora logs de desenvolvimento do webpack/vite
  if (message.includes("webpack") || message.includes("vite") && message.includes("dev")) return false;
  // Ignora source map warnings
  if (message.includes("source map") || message.includes("sourcemap")) return false;
  // Ignora warnings de depreciação
  if (level === 2 && (message.includes("deprecat") || message.includes("Deprecation"))) return false;
  // Ignora avisos de React sobre chaves, props, etc. (warnings, não erros)
  if (level === 2) return false;
  return true;
}

// Gera uma assinatura simples do erro para detectar loops de correção
function generateErrorSignature(message: string, source: string): string {
  // Normaliza a mensagem: remove números de linha, colunas, caminhos absolutos, timestamps
  let normalized = message
    .replace(/at\s+.*?:(\d+):(\d+)/g, "") // remove stack traces com line:col
    .replace(/\(.*?:\d+:\d+\)/g, "") // remove (file:line:col)
    .replace(/\/[^\s]+\.(js|jsx|ts|tsx|vue|svelte)/g, "") // remove caminhos de arquivo
    .replace(/\\.*?\.(js|jsx|ts|tsx|vue|svelte)/g, "") // remove caminhos Windows
    .replace(/\d+/g, "") // remove números
    .replace(/\s+/g, " ") // normaliza espaços
    .trim()
    .toLowerCase();
  // Hash simples (djb2)
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// Sanitiza mensagem de erro para envio ao Agent (remove credenciais, paths sensíveis, etc.)
function sanitizeDiagnosticForAgent(message: string, source: string): string {
  return message
    // Remove URLs com credenciais
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    // Remove tokens/API keys
    .replace(/[a-zA-Z0-9_-]{20,}/g, "[TOKEN]")
    // Remove caminhos absolutos de usuário
    .replace(/\/home\/[^\s]+/g, "[HOME]")
    .replace(/\/Users\/[^\s]+/g, "[USERS]")
    .replace(/C:\\Users\\[^\\]+/g, "[USERS]")
    // Remove tokens JWT
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT]")
    // Remove bearer tokens
    .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "bearer [TOKEN]")
    // Limita tamanho
    .slice(0, 3000);
}

// Gera diagnóstico estruturado para o Agent
function createStructuredDiagnostic(errorMessage: string, source: string, lineNumber: number, level: number): { signature: string; diagnostic: string; timestamp: number } {
  const signature = generateErrorSignature(errorMessage, source);
  const sanitized = sanitizeDiagnosticForAgent(errorMessage, source);
  const location = lineNumber > 0 ? ` (linha ${lineNumber})` : "";
  const diagnostic = `Erro detectado no Preview${location}:\n${sanitized}`;

  // Contenção de memória: remover entradas antigas (>10min) ou limitar a 50
  if (attemptedErrorSignatures.size > 50) {
    const now = Date.now();
    for (const [key, val] of attemptedErrorSignatures.entries()) {
      if (now - val.lastAttempt > 600000) attemptedErrorSignatures.delete(key);
    }
    if (attemptedErrorSignatures.size > 50) {
      const oldestKey = attemptedErrorSignatures.keys().next().value;
      if (oldestKey) attemptedErrorSignatures.delete(oldestKey);
    }
  }

  return { signature, diagnostic, timestamp: Date.now() };
}

  // Electron has shipped multiple console-message callback shapes across versions:
  // 1) Modern Electron (v30+ / v44): event object contains { level, message, lineNumber, sourceId, frame }
  // 2) Positional with event: (event, level, message, lineNumber, sourceId)
  // 3) Positional details: (event, { level, message, lineNumber, sourceId })
  // 4) Legacy positional without event: (level, message, lineNumber, sourceId)
  mainWindow.webContents.on("console-message", ((arg0: any, arg1: any, arg2?: any, arg3?: any, arg4?: any) => {
    let rawLevel: unknown = 0;
    let message = "";
    let lineNumber = 0;
    let sourceId = "";

    if (arg0 && typeof arg0 === "object" && ("message" in arg0 || "level" in arg0)) {
      rawLevel = arg0.level ?? 0;
      message = String(arg0.message ?? "");
      lineNumber = Number(arg0.lineNumber ?? 0);
      sourceId = String(arg0.sourceId ?? "");
    } else if (arg1 && typeof arg1 === "object" && ("message" in arg1 || "level" in arg1)) {
      rawLevel = arg1.level ?? 0;
      message = String(arg1.message ?? "");
      lineNumber = Number(arg1.lineNumber ?? 0);
      sourceId = String(arg1.sourceId ?? "");
    } else if (typeof arg1 === "number" || typeof arg1 === "string") {
      rawLevel = arg1;
      message = String(arg2 ?? "");
      lineNumber = Number(arg3 ?? 0);
      sourceId = String(arg4 ?? "");
    } else {
      rawLevel = arg0;
      message = String(arg1 ?? "");
      lineNumber = Number(arg2 ?? 0);
      sourceId = String(arg3 ?? "");
    }

    const level = typeof rawLevel === "string"
      ? ({ verbose: 0, info: 1, warning: 2, warn: 2, error: 3 } as Record<string, number>)[rawLevel.toLowerCase()] ?? 1
      : Number(rawLevel ?? 0);
    const payload = { level, message, line: lineNumber, sourceId };
    const source = String(sourceId || "");
    // Preview frames can report a source URL with a different local hostname
    // representation. Do not require an exact port match for diagnostics.
    const isPreviewConsole = Boolean(previewPort && (source.includes("127.0.0.1") || source.includes("localhost"))) ||
      (Boolean(previewPort) && source.includes(`:${previewPort}`));

    // [BLACKSCREEN-RENDERER] Capture renderer errors (not preview) from console-message
    if (!isPreviewConsole && level >= 3 && message.trim()) {
      console.error("[BLACKSCREEN-RENDERER] console-error", { message: message.slice(0, 500), line: lineNumber, source: source.slice(0, 200) });
    }

    if (isPreviewConsole && message.trim()) {
      if (level >= 2) console.error("[Neko/Preview] console", payload);
      if (message.includes("[vite]")) perfMark("t6");
      
      // Detecta erro real do Preview
      const isRealError = isRealPreviewError(message, level, source);
      if (isRealError) {
        const diagnosticInfo = createStructuredDiagnostic(message, sourceId, lineNumber, level);
        console.log(`[Neko/PreviewDiag] error-detected signature=${diagnosticInfo.signature} level=${level} line=${lineNumber}`);
        
        // Verifica se já tentamos corrigir este erro muitas vezes
        const attemptInfo = attemptedErrorSignatures.get(diagnosticInfo.signature);
        const attemptCount = attemptInfo?.count ?? 0;
        
        // Log de diagnóstico
        console.log(`[Neko/PreviewDiag] error-detected signature=${diagnosticInfo.signature} attempt=${attemptCount + 1}/3`);
        
        // Envia diagnóstico estruturado para o renderer. A emissão é limitada:
        // no máximo 3 tentativas por assinatura e um intervalo mínimo entre
        // emissões idênticas, para que um erro repetitivo do Preview nunca
        // dispare várias execuções do agente.
        const nowEmission = Date.now();
        const lastEmission = previewErrorEmissionAt.get(diagnosticInfo.signature) ?? 0;
        if (attemptCount < 3 && nowEmission - lastEmission >= 3000) {
          previewErrorEmissionAt.set(diagnosticInfo.signature, nowEmission);
          mainWindow?.webContents.send("preview:event", { 
            type: "preview.error-detected", 
            properties: { 
              ...diagnosticInfo,
              attempt: attemptCount + 1,
              maxAttempts: 3
            } 
          });
        }
      }
      
      if (message.includes("[vite]")) perfMark("t6");
      mainWindow?.webContents.send("preview:event", { type: "preview.console", properties: payload });
    }
  }) as any);

  // The Preview runs inside an iframe, so the Neko scrollbar theme must be
  // injected into that frame itself. This also covers HMR and route changes.
  mainWindow.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    try {
      const frame = (webFrameMain as any).fromId(frameProcessId, frameRoutingId);
      const frameUrl = String(frame?.url || "");
      const previewPortText = previewPort ? `:${previewPort}` : "";
      if (frameUrl.includes("127.0.0.1") || frameUrl.includes("localhost") || (previewPortText && frameUrl.includes(previewPortText))) {
        void injectPreviewScrollbar(frame).then(ok => {
          if (ok) {
            perfMark("t6");
            mainWindow?.webContents.send("preview:event", { type: "preview.frame-ready", properties: {} });
          }
        });
      }
    } catch {}
  });

  mainWindow.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) return;
    try {
      const frames = (mainWindow?.webContents.mainFrame as any)?.framesInSubtree ?? [];
      const target = frames.find((frame: any) => String(frame?.url || "") === String(url));
      if (target) {
        perfMark("t6");
        void injectPreviewScrollbar(target);
      }
    } catch {}
  });

  // Prepare a document-start hook for local Preview frames. The hook is a
  // fallback/first-paint guarantee; the renderer still keeps the iframe hidden
  // until the frame has received the final theme.
  void installPreviewDocumentStartTheme(mainWindow.webContents);

  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    const frameUrl = String(url || "");
    if (frameUrl.includes("127.0.0.1") || frameUrl.includes("localhost")) {
      mainWindow?.webContents.send("preview:event", { type: "preview.frame-loading", properties: {} });
      try {
        const frame = (webFrameMain as any).fromId(frameProcessId, frameRoutingId);
        void injectPreviewScrollbar(frame);
      } catch {}
    }
    void isInPlace;
  });

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    const rendererIndex = path.join(__dirname, "../renderer/index.html");
    console.log("[Neko/Renderer] loading", rendererIndex);
    void mainWindow.loadFile(rendererIndex);
  }
}

app.whenReady().then(() => {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("renderer:report-error", (_event, payload: { type: string; message: string; filename: string; lineno: number; colno: number; stack: string }) => {
    console.error(`[BLACKSCREEN-RENDERER] ${payload.type}`, { message: payload.message?.slice(0, 500), filename: payload.filename?.slice(0, 200), lineno: payload.lineno, colno: payload.colno, stack: payload.stack?.slice(0, 1000) });
  });
  ipcMain.handle("app:openExternal", async (_event, url: string) => {
    const raw = String(url || "").trim();
    if (/^https?:\/\//i.test(raw)) {
      await shell.openExternal(raw);
      return true;
    }
    return false;
  });
  void supabaseManager.initialize();
  void vercelManager.initialize();
  void licenseManager.initialize();

  licenseManager.setOnStateChange(async (newState, prevState) => {
    console.log(`[Neko/License] Estado alterado de ${prevState.state} para ${newState.state}`);
    console.log(`[BLACKSCREEN] license-state-change:main`, { from: prevState.state, to: newState.state, wasLicensed: prevState.isLicensed, nowLicensed: newState.isLicensed, currentProject });
    // Envia evento de alteração de estado para o Renderer
    mainWindow?.webContents.send("license:state-changed", newState);

    // Se perdeu o acesso licenciado (transferência para outro PC, revogação ou expiração), fecha o workspace imediatamente
    if (!newState.isLicensed && prevState.isLicensed) {
      console.warn("[Neko/License] Licença perdida/transferida. Encerrando workspace e servidores ativos imediatamente.");
      console.warn("[BLACKSCREEN] license-revoked:killing-workspace", { currentProject, hasActiveWorkspace: !!activeWorkspace });
      await stopPreview();
      await stopOpenCode();
      currentProject = null;
      activeWorkspace = null;
      mainWindow?.webContents.send("opencode:event", {
        type: "neko.project.closed",
        properties: { reason: "license.revoked_or_transferred" }
      });
    }
  });

  ipcMain.handle("license:get-state", () => licenseManager.getState());
  ipcMain.handle("license:activate", (_event, payload: { licenseKey: string }) =>
    licenseManager.activate(payload?.licenseKey)
  );
  ipcMain.handle("license:reset-device", (_event, payload: { licenseKey: string }) =>
    licenseManager.resetDevice(payload?.licenseKey)
  );
  ipcMain.handle("license:validate", () =>
    licenseManager.validate()
  );
  ipcMain.handle("license:deactivate", async (_event, payload?: { licenseId?: string }) => {
    const res = await licenseManager.deactivate(payload?.licenseId);
    if (res.ok) {
      await stopPreview();
      await stopOpenCode();
      currentProject = null;
      activeWorkspace = null;
      mainWindow?.webContents.send("opencode:event", {
        type: "neko.project.closed",
        properties: { reason: "license.deactivated" }
      });
    }
    return res;
  });

  createWindow();
  updaterManager.initialize(mainWindow);

  ipcMain.handle("updater:get-state", () => updaterManager.getState());
  ipcMain.handle("updater:check", () => updaterManager.checkForUpdates());
  ipcMain.handle("updater:download", () => updaterManager.downloadUpdate());
  ipcMain.handle("updater:install", () => {
    updaterManager.quitAndInstall();
    return { ok: true };
  });

  // Verificação automática silenciosa em segundo plano após inicialização da janela
  setTimeout(() => {
    void updaterManager.checkForUpdates().catch(err => {
      console.warn("[Neko/Updater] Verificação inicial de atualização falhou silenciosamente:", err);
    });
  }, 4000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      updaterManager.setWindow(mainWindow);
    }
  });
});

app.on("before-quit", () => {
  cancelGithubAuthorization("app_before_quit");
  licenseManager.shutdown();
  supabaseManager.shutdown();
  vercelManager.shutdown();
  void stopPreview();
  void stopOpenCode();
});

app.on("will-quit", () => {
  cancelGithubAuthorization("app_will_quit");
  void stopPreview();
  void stopOpenCode();
});

app.on("window-all-closed", () => {
  cancelGithubAuthorization("window_all_closed");
  if (process.platform !== "darwin") app.quit();
});

// Process-level safety net: se o processo Node/Electron sofrer encerramento abrupto,
// garantir a eliminação síncrona de processos órfãos no SO.
process.on("exit", () => {
  cancelGithubAuthorization("process_exit");
  if (process.platform === "win32") {
    if (opencodeProcess?.pid) {
      try { spawnSync("taskkill.exe", ["/PID", String(opencodeProcess.pid), "/T", "/F"], { windowsHide: true }); } catch {}
    }
    if (previewProcess?.pid) {
      try { spawnSync("taskkill.exe", ["/PID", String(previewProcess.pid), "/T", "/F"], { windowsHide: true }); } catch {}
    }
  }
});

process.on("SIGINT", () => {
  cancelGithubAuthorization("sigint");
  void stopPreview();
  void stopOpenCode();
  app.quit();
});

process.on("SIGTERM", () => {
  cancelGithubAuthorization("sigterm");
  void stopPreview();
  void stopOpenCode();
  app.quit();
});

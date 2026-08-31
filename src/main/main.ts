import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell, webFrameMain } from "electron";
import path from "node:path";
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
import { licenseManager } from "./license/license-manager";
import { updaterManager } from "./updater";

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

// True when the event shows the agent doing real work (tools, commands,
// permissions or a real project file), as opposed to status chatter.
function isRealAgentActivity(eventType: string, props: any): boolean {
  if (eventType.startsWith("tool.")) return true;
  if (eventType === "command.executed" || eventType === "permission.asked") return true;
  if (eventType === "message.part.updated" && String(props?.part?.type ?? "") === "tool") return true;
  if (eventType.startsWith("file.")) {
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
      const response = await fetchWithTimeout(`${opencodeUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json", ...opencodeDirectoryHeaders() }, body: JSON.stringify(current.requestBody) }, 30000);
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
let githubPollPromise: Promise<void> | null = null;

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

async function pollGithubDevice(deviceCode: string, intervalSeconds: number) {
  let waitSeconds = Math.max(5, Number(intervalSeconds) || 5);
  const deadline = Date.now() + 15 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
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
      })
    });

    const data: any = await response.json().catch(() => ({}));
    if (data.access_token) {
      writeGithubAuth({
        token: String(data.access_token),
        expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
        refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
        refreshExpiresAt: typeof data.refresh_token_expires_in === "number" ? Date.now() + data.refresh_token_expires_in * 1000 : undefined
      });
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
}

function opencodeDirectoryHeaders(): Record<string, string> {
  return currentProject ? { "x-opencode-directory": encodeURIComponent(currentProject) } : {};
}

async function getOpencodeClient() {
  const sdk = await import("@opencode-ai/sdk");
  return sdk.createOpencodeClient({ baseUrl: opencodeUrl, throwOnError: true });
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
      const response = await fetch(`${url}/global/health`);
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
  clearStatusCache();
  forwardedSessionStatus.clear();

  const executable = getOpencodePath();
  const port = await findFreePort(4097);
  opencodeUrl = `http://127.0.0.1:${port}`;
  currentProject = projectPath;
  startProjectWatcher(projectPath, transitionGen);

  console.log("[Neko/OpenCode] starting", { executable, projectPath, port, generation: transitionGen });
  logService("starting", `project=${projectPath} port=${port} gen=${transitionGen}`);

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
      cwd: projectPath,
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
        const response = await fetchWithTimeout(`${opencodeUrl}/global/health`, {}, 2500);
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
                properties: { projectPath, url: opencodeUrl, port, generation: transitionGen }
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
  eventAbort?.abort();
  eventAbort = new AbortController();
  if (activeWorkspace && activeWorkspace.generation === streamGen) {
    activeWorkspace.eventAbort = eventAbort;
  }

  try {
    const response = await fetch(`${opencodeUrl}/event`, {
      signal: eventAbort.signal,
      headers: { Accept: "text/event-stream", ...opencodeDirectoryHeaders() }
    });

    if (!response.ok || !response.body) {
      throw new Error(`OpenCode events retornou HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!eventAbort.signal.aborted) {
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
          }
          // session.idle is the engine's completion confirmation for the task.
          // Attach the task correlation id so the renderer can tell task A's
          // idle from task B's idle.
          if (eventType === "session.idle") {
            const active = activeAgentRequests.get(perfSessionId);
            if (active?.retryTimer || active?.isRetrying) {
              console.log(`[Neko/Agent] session.idle recebido durante retry ativo (ignorado) session=${perfSessionId}`);
              continue;
            }
            let taskId = sessionTaskIds.get(perfSessionId) ?? "";
            if (!taskId && sessionTaskIds.size === 1) {
              taskId = Array.from(sessionTaskIds.values())[0] || "";
            }
            event.properties = { ...(event.properties ?? {}), taskId, sessionID: perfSessionId || undefined };
            console.log(`[TaskLifecycle] event=session.idle session=${perfSessionId || "default"} taskId=${taskId || "none"}`);
            perfMark("t8", perfSessionId);
            perfFlushTask(perfSessionId, "idle");
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
            if (sessionId) clearActiveAgentRequest(sessionId);
            engineRetryStates.delete(sessionId);
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
                // Ask the engine to stop its internal retry loop.
                void fetch(`${opencodeUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
                  method: "POST",
                  headers: opencodeDirectoryHeaders()
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
            } else if (statusType === "idle" || statusType === "completed" || statusType === "done") {
              engineRetryStates.delete(sessionId);
              let taskId = sessionTaskIds.get(sessionId) ?? "";
              if (!taskId && sessionTaskIds.size === 1) {
                taskId = Array.from(sessionTaskIds.values())[0] || "";
              }
              event.properties = { ...(event.properties ?? {}), taskId: taskId || undefined, sessionID: sessionId || undefined };
              console.log(`[TaskLifecycle] event=session.status(${statusType}) session=${sessionId || "default"} taskId=${taskId || "none"}`);
              perfMark("t8", sessionId);
              perfFlushTask(sessionId, "idle");
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
  } catch (error: any) {
    if (error?.name !== "AbortError" && (!activeWorkspace || activeWorkspace.generation === streamGen)) {
      console.error("[Neko/OpenCode] event stream error:", error);
      mainWindow?.webContents.send("opencode:event", {
        type: "neko.connection.error",
        properties: { message: String(error?.message ?? error), generation: streamGen }
      });
    }
  }
}


function safePathWithinProject(projectPath: string, relativePath: string) {
  const root = path.resolve(projectPath);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Caminho fora do projeto.");
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
};

let previewState: PreviewManagerState = {
  status: "idle",
  framework: null,
  packageManager: null,
  port: null,
  url: null
};

let previewProcess: ChildProcess | null = null;
let previewPort: number | null = null;
let previewProjectPath: string | null = null;
let previewStartPromise: Promise<PreviewManagerState> | null = null;
let previewSessionCounter = 0;
let activePreviewSessionId = 0;
let previewRestartDebounceTimer: NodeJS.Timeout | null = null;

function emitPreview(type: string, properties: Record<string, any> = {}) {
  previewState = { ...previewState, ...properties };
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send("preview:event", { type, properties: previewState });
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
      packageManager: "npm"
    };
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let framework = "Node";
  let preferredPort = 3000;

  if (deps.next) { framework = "Next.js"; preferredPort = 3000; }
  else if (deps.astro) { framework = "Astro"; preferredPort = 4321; }
  else if (deps.vite) { framework = "Vite"; preferredPort = 5173; }
  else if (deps["react-scripts"]) { framework = "Create React App"; preferredPort = 3000; }
  else if (deps.nuxt) { framework = "Nuxt"; preferredPort = 3000; }
  else if (deps.vue) { framework = "Vue"; preferredPort = 5173; }
  else if (deps.svelte || deps["@sveltejs/kit"]) { framework = "Svelte"; preferredPort = 5173; }

  const scripts = pkg.scripts || {};
  let devScript: string | null = null;
  if (scripts.dev) devScript = "dev";
  else if (scripts.start) devScript = "start";
  else if (scripts.serve) devScript = "serve";
  else if (scripts.preview) devScript = "preview";

  const files: string[] = await fs.promises.readdir(projectPath).catch((): string[] => []);
  let packageManager = "npm";
  if (files.includes("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (files.includes("yarn.lock")) packageManager = "yarn";
  else if (files.includes("bun.lockb") || files.includes("bun.lock")) packageManager = "bun";

  return {
    exists: true,
    pkg,
    framework,
    preferredPort,
    devScript,
    packageManager
  };
}

function packageManagerExecutable(packageManager: string) {
  if (packageManager === "pnpm") return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (packageManager === "yarn") return process.platform === "win32" ? "yarn.cmd" : "yarn";
  if (packageManager === "bun") return process.platform === "win32" ? "bun.exe" : "bun";
  return process.platform === "win32" ? "npm.cmd" : "npm";
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
    "could not resolve"
  ].some(marker => text.includes(marker));
}

async function removeNodeModules(projectPath: string) {
  await fs.promises.rm(path.join(projectPath, "node_modules"), { recursive: true, force: true });
}

async function verifyRuntimeDependency(projectPath: string, framework: string) {
  const entryByFramework: Record<string, string> = {
    Vite: "vite",
    "Next.js": "next",
    Astro: "astro",
    Nuxt: "nuxt",
    Vue: "vite",
    Svelte: "vite",
    "Create React App": "react-scripts"
  };
  const entry = entryByFramework[framework];
  if (!entry) return;

  const script = `import(${JSON.stringify(entry)}).then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1)})`;
  await runCommand(process.platform === "win32" ? "node.exe" : "node", ["--input-type=module", "-e", script], projectPath, "Dependency-Check");
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
  await runCommand(packageManagerExecutable(packageManager), ["install"], projectPath, "Install");
}

async function installDependenciesWithFallback(projectPath: string, preferredManager: string) {
  try {
    await installDependencies(projectPath, preferredManager);
    return preferredManager;
  } catch (error: any) {
    if (preferredManager !== "bun") throw error;
    const output = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
    if (!dependencyResolutionFailure(output)) throw error;

    emitPreview("preview.installing", {
      status: "installing",
      packageManager: "npm",
      message: "Ajustando as dependências para iniciar o preview..."
    });
    await removeNodeModules(projectPath);
    await runCommand(packageManagerExecutable("npm"), ["install", "--no-package-lock"], projectPath, "Install-Fallback");
    return "npm";
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
  await stopPreviewProcessOnly();
  previewProjectPath = null;
  if (activeWorkspace) {
    activeWorkspace.previewProcess = null;
    activeWorkspace.previewPort = null;
    activeWorkspace.previewUrl = null;
  }
  previewState = { status: "stopped", framework: previewState.framework, packageManager: previewState.packageManager, port: null, url: null };
  emitPreview("preview.stopped");
}

function handleProjectFileChange(projectPath: string, changedPath: string) {
  if (!currentProject || path.resolve(currentProject) !== path.resolve(projectPath)) return;
  const normalized = (changedPath || "").replaceAll("\\", "/").toLowerCase();

  // 1. Se o preview não estiver rodando (idle, stopped ou error),
  // e um package.json surgir, inicia o preview de forma autônoma!
  if (!previewProcess || previewState.status === "idle" || previewState.status === "stopped" || previewState.status === "error") {
    void resolvePreviewProjectRoot(projectPath).then(root => {
      if (root && (!previewProcess || previewState.status === "idle" || previewState.status === "stopped" || previewState.status === "error")) {
        console.log(`[Neko/PreviewWatcher] package.json detectado em ${root}. Iniciando preview automaticamente...`);
        void startPreview(projectPath).catch(err => {
          console.warn("[Neko/PreviewWatcher] Falha na auto-inicialização do preview:", err);
        });
      }
    });
    return;
  }

  // 2. Se o preview já está rodando (ready, starting, etc.):
  // Para alterações de código comum (src/**, index.html, App.tsx, etc.), não faz nada
  // pois o Vite / Next / Astro HMR atualiza em tempo real.
  // Apenas alterações em package.json ou configs do bundler requerem reinicialização do dev server.
  const isConfigFile = normalized.endsWith("package.json") ||
    normalized.includes("vite.config") ||
    normalized.includes("next.config") ||
    normalized.includes("astro.config") ||
    normalized.includes("nuxt.config") ||
    normalized.includes("webpack.config") ||
    normalized.includes("tsconfig.json");

  if (isConfigFile) {
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
}

async function captureProjectPreviewThumbnail(projectPath: string, url: string) {
  let offscreenWin: BrowserWindow | null = null;
  try {
    offscreenWin = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        offscreen: true
      }
    });
    await offscreenWin.loadURL(url);
    await new Promise(r => setTimeout(r, 1800));
    const image = await offscreenWin.webContents.capturePage();
    if (!image.isEmpty()) {
      const nekoDir = path.join(projectPath, ".neko");
      await fs.promises.mkdir(nekoDir, { recursive: true });
      const thumbBuffer = image.resize({ width: 640 }).toPNG();
      await fs.promises.writeFile(path.join(nekoDir, "thumbnail.png"), thumbBuffer);
      console.log("[Neko/Preview] real thumbnail saved for project:", projectPath);
    }
  } catch (err) {
    console.warn("[Neko/Preview] offscreen thumbnail capture skipped:", err);
  } finally {
    try { if (offscreenWin && !offscreenWin.isDestroyed()) offscreenWin.close(); } catch {}
  }
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

  if (!(await hasDependencies(projectRoot))) {
    if (sessionId !== activePreviewSessionId) return previewState;
    emitPreview("preview.installing", { status: "installing", message: `Instalando dependências com ${packageManager}...` });
    try {
      packageManager = await installDependenciesWithFallback(projectRoot, packageManager);
    } catch (error: any) {
      if (sessionId !== activePreviewSessionId) return previewState;
      emitPreview("preview.error", { status: "error", message: `Falha ao instalar dependências: ${String(error?.message ?? error)}` });
      return previewState;
    }
  }

  if (sessionId !== activePreviewSessionId) return previewState;

  if (packageManager === "bun") {
    try {
      await verifyRuntimeDependency(projectRoot, info.framework);
    } catch (error: any) {
      if (sessionId !== activePreviewSessionId) return previewState;
      console.error("[Neko/Preview] Bun dependency check failed:", error);
      emitPreview("preview.installing", {
        status: "installing",
        packageManager: "npm",
        message: "O Neko encontrou uma incompatibilidade nas dependências. Ajustando e tentando novamente..."
      });
      try {
        await removeNodeModules(projectRoot);
        await runCommand(packageManagerExecutable("npm"), ["install", "--no-package-lock"], projectRoot, "Install-Fallback");
        packageManager = "npm";
      } catch (fallbackError: any) {
        console.error("[Neko/Preview] Falha na recuperação das dependências:", fallbackError);
        emitPreview("preview.error", {
          status: "error",
          packageManager,
          message: "Não foi possível preparar as dependências para iniciar o preview.",
          port: null,
          url: null
        });
        return previewState;
      }
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
      const ready = { status: "ready" as const, framework: info.framework, packageManager, port, url, message: "Preview pronto." };
      previewState = ready;
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

      if (packageManager === "bun" && (dependencyResolutionFailure(output) || dependencyResolutionFailure(message) || (processRef.exitCode !== null && processRef.exitCode !== 0))) {
        await stopPreviewProcessOnly();
        emitPreview("preview.installing", {
          status: "installing",
          packageManager: "npm",
          message: "O Neko encontrou uma incompatibilidade nas dependências. Ajustando e tentando novamente..."
        });
        try {
          await removeNodeModules(projectRoot);
          await runCommand(packageManagerExecutable("npm"), ["install", "--no-package-lock"], projectRoot, "Install-Fallback");
          packageManager = "npm";
          const retryPort = await findFreePort(info.preferredPort);
          emitPreview("preview.starting", { status: "starting", packageManager, port: retryPort, message: `Tentando iniciar ${info.framework} novamente...` });
          const retry = await launchPreviewProcess(projectRoot, info, packageManager, retryPort);
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
          const ready = { status: "ready" as const, framework: info.framework, packageManager, port: retryPort, url: retryUrl, message: "Preview pronto." };
          previewState = ready;
          mainWindow?.webContents.send("preview:event", { type: "preview.ready", properties: ready });
          return ready;
        } catch (fallbackError: any) {
          await stopPreviewProcessOnly();
          emitPreview("preview.error", {
            status: "error",
            message: "Não foi possível iniciar o preview após ajustar as dependências. Verifique o projeto e tente novamente.",
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
          ? "Não foi possível resolver as dependências deste projeto."
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
  const workspace = path.resolve(projectPath);

  // 1. Se já está rodando e saudável no mesmo projeto, NÃO matar! Reutilizar e reemitir ready!
  if (!forceRestart && previewProjectPath === workspace && previewProcess && previewProcess.exitCode === null && previewState.status === "ready" && previewState.url) {
    const alive = await isHttpAlive(previewState.url);
    if (alive) {
      console.log(`[Preview] Servidor já ativo e saudável em ${previewState.url} (mantido sem interrupção).`);
      emitPreview("preview.ready", previewState);
      return previewState;
    }
  }

  // 2. Se já existe uma inicialização em andamento para este mesmo projeto, aguarda a mesma
  if (!forceRestart && previewProjectPath === workspace && previewStartPromise) {
    return previewStartPromise;
  }

  const session = ++previewSessionCounter;
  activePreviewSessionId = session;
  console.log(`[Preview] start session=${session} path=${workspace}${forceRestart ? " (forceRestart)" : ""}`);

  previewProjectPath = workspace;
  previewStartPromise = (async () => {
    emitPreview("preview.detecting", { status: "detecting", message: "Analisando estrutura do projeto..." });
    const projectRoot = await resolvePreviewProjectRoot(workspace);
    if (!projectRoot) {
      if (session === activePreviewSessionId) {
        emitPreview("preview.unsupported", { status: "idle", message: "Aguardando criação da estrutura do projeto (package.json)..." });
      }
      return previewState;
    }
    if (session !== activePreviewSessionId) return previewState;

    const info = await detectProject(projectRoot);
    if (!info.exists || !info.devScript) {
      if (session === activePreviewSessionId) {
        emitPreview("preview.unsupported", { status: "idle", message: "O projeto não possui um script dev ou start no package.json." });
      }
      return previewState;
    }

    await stopPreviewProcessOnly();
    console.log("[Neko/Preview] project root resolved", { workspace, projectRoot, session });
    return startPreviewInternal(projectRoot, info, session);
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

        return {
          providerID,
          providerName,
          modelID,
          name: model?.name ?? modelID,
          variants: model?.variants && typeof model.variants === "object" ? Object.keys(model.variants) : [],
          enabled: providerEnabled && catalogEnabled && userEnabled,
          connected: isConnected,
          catalogEnabled,
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


async function searchProjectFiles(query: string) {
  if (!currentProject) return [];
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const results: Array<{
    name: string;
    path: string;
    type: "file" | "directory";
  }> = [];

  async function walk(relative = ""): Promise<void> {
    const absolute = safePathWithinProject(currentProject!, relative);

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
  return searchProjectFiles(query);
});

ipcMain.handle("commands:list", async () => {
  try {
    const response = await fetch(`${opencodeUrl}/command`);
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : (data?.commands ?? data?.data ?? []);
  } catch { return []; }
});

ipcMain.handle("opencode:command", async (_event, payload: { sessionId: string; command: string; arguments?: string; model?: { providerID: string; modelID: string } }) => {
  licenseManager.assertAccess("comandos do assistente");
  if (!currentProject) throw new Error("Nenhum projeto aberto.");
  if (!payload.sessionId) throw new Error("Sessão do Neko não encontrada.");
  const response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  if (githubPollPromise) throw new Error("Já existe uma autorização do GitHub em andamento.");

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID })
  });
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
  githubPollPromise = pollGithubDevice(String(data.device_code), device.interval)
    .catch(error => {
      console.error("[Neko/GitHub] Device Flow error:", error);
      mainWindow?.webContents.send("github:event", { type: "github.error", properties: { message: error instanceof Error ? error.message : String(error) } });
    })
    .finally(() => { githubPollPromise = null; });

  return { device, status: { connected: false, repos: [] } };
});

ipcMain.handle("github:disconnect", async () => {
  clearGithubAuth();
  mainWindow?.webContents.send("github:event", { type: "github.disconnected", properties: { connected: false, repos: [] } });
  return true;
});



ipcMain.handle("github:listBranches", async (_event, _repoFullName: string) => {
  if (!currentProject) return [];
  const projectPath = currentProject;

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
  const projectPath = currentProject;

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
  const destination = await dialog.showOpenDialog(mainWindow!, {
    title: "Escolha onde salvar o projeto do GitHub",
    properties: ["openDirectory", "createDirectory"]
  });
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
  const parentStat = await fs.promises.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error("A pasta escolhida não existe ou não é válida.");
  const repoName = repoFullName.split("/").pop() || "projeto";
  const projectName = String(payload?.projectName || repoName).trim();
  if (!/^[^\\/:*?"<>|]+$/.test(projectName) || projectName === "." || projectName === "..") {
    throw new Error("Escolha um nome de projeto válido.");
  }
  const target = path.join(parent, projectName);

  try {
    await fs.promises.access(target, fs.constants.F_OK);
    throw new Error(`A pasta "${projectName}" já existe em "${parent}". Escolha outra pasta.`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const cloneUrl = `https://github.com/${repoFullName}.git`;
  const clone = await runGitWithGithubAuth(parent, ["clone", cloneUrl, projectName], token);

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
  const projectPath = currentProject;
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
  const projectPath = currentProject;

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
  const projectPath = currentProject;

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

ipcMain.handle("github:linkProject", async (_event, payload: { repoFullName: string; replaceRemote?: boolean }) => {
  licenseManager.assertAccess("vinculação de repositórios no GitHub");
  if (!currentProject) throw new Error("Abra um projeto antes de vinculá-lo ao GitHub.");
  const projectPath = currentProject;

  const repoFullName = String(payload?.repoFullName || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
    throw new Error("Repositório do GitHub inválido.");
  }

  return withProjectGitLock(projectPath, async () => {
    const token = await getGithubAccessToken();
    const desiredRemote = `https://github.com/${repoFullName}.git`;

    // Validate access before changing the local project remote. This prevents a
    // project from being linked to a repository the current GitHub authorization
    // cannot actually reach.
    const accessCheck = await runGitWithGithubAuth(projectPath, ["ls-remote", "--heads", desiredRemote], token, 20000);
    if (accessCheck.code !== 0) {
      throw new Error(formatGitHubGitError(accessCheck, `validar o acesso a ${repoFullName}`));
    }

    const existing = await getGitStatus();
    if (!existing.initialized) {
      const init = await runGit(projectPath, ["init"], {}, 15000);
      if (init.code !== 0) {
        throw new Error(init.stderr || "Não foi possível inicializar o Git neste projeto.");
      }
    }

    const currentRemote = await runGit(projectPath, ["remote", "get-url", "origin"], {}, 10000);

    if (currentRemote.code === 0 && currentRemote.stdout && currentRemote.stdout !== desiredRemote) {
      if (!payload?.replaceRemote) {
        throw new Error(`O projeto já possui um remote "origin": ${currentRemote.stdout}. Confirme a substituição para vincular este repositório.`);
      }

      const set = await runGit(projectPath, ["remote", "set-url", "origin", desiredRemote], {}, 10000);
      if (set.code !== 0) {
        throw new Error(set.stderr || "Não foi possível substituir o remote origin.");
      }
    } else if (currentRemote.code !== 0 || !currentRemote.stdout) {
      const add = await runGit(projectPath, ["remote", "add", "origin", desiredRemote], {}, 10000);
      if (add.code !== 0) {
        throw new Error(add.stderr || "Não foi possível adicionar o remote origin.");
      }
    }

    return {
      ok: true,
      repoFullName,
      status: await getGitStatus()
    };
  });
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
  try {
    const nekoDir = path.join(root, ".neko");
    await fs.promises.mkdir(nekoDir, { recursive: true });
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    await fs.promises.writeFile(path.join(nekoDir, "thumbnail.png"), buffer);
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

ipcMain.handle("project:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Abrir pasta do projeto",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

async function switchWorkspaceInternal(targetInput: string | { projectPath: string; source?: string }, defaultSource = "unknown") {
  licenseManager.assertAccess("o workspace do NekoAI");
  const projectPath = typeof targetInput === "string" ? targetInput : targetInput?.projectPath;
  const source = (typeof targetInput === "object" && targetInput?.source) ? targetInput.source : defaultSource;

  if (!projectPath) throw new Error("Pasta do projeto não informada.");

  const targetPath = path.resolve(projectPath);
  const transitionGen = ++projectTransitionGeneration;
  console.log(`[ProjectSwitch] REQUEST source=${source} target=${targetPath} generation=${transitionGen}`);
  logService("transition-start", `target=${targetPath} gen=${transitionGen}`);

  // Create WorkspaceContext immediately
  const newWorkspace: WorkspaceContext = {
    generation: transitionGen,
    projectPath: targetPath,
    opencodeProcess: null,
    opencodeUrl: "http://127.0.0.1:4097",
    opencodePort: null,
    previewProcess: null,
    previewPort: null,
    previewUrl: null,
    watcher: null,
    eventAbort: null,
    status: "starting"
  };
  activeWorkspace = newWorkspace;
  currentProject = targetPath;

  const transitionPromise = (async () => {
    // 1. Ensure project directory exists
    await fs.promises.mkdir(targetPath, { recursive: true });

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

    return {
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
  })();

  activeWorkspaceTransitionPromise = transitionPromise;
  try {
    return await transitionPromise;
  } finally {
    if (activeWorkspaceTransitionPromise === transitionPromise) {
      activeWorkspaceTransitionPromise = null;
    }
  }
}

ipcMain.handle("project:create", async (_event, payload: string | { projectPath: string; source?: string }) => {
  return switchWorkspaceInternal(payload, "ipc");
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
  if (!currentProject) throw new Error("Nenhum projeto aberto.");
  return createTaskCheckpoint(currentProject);
});

ipcMain.handle("project:undoTask", async (_event, taskId: string) => {
  licenseManager.assertAccess("restauração de checkpoint");
  return undoTaskCheckpoint(taskId);
});

ipcMain.handle("project:tree", async () => {
  licenseManager.assertAccess("árvore de arquivos do projeto");
  if (!currentProject) return [];
  return readTree(currentProject);
});

ipcMain.handle("project:file", async (_event, relativePath: string) => {
  licenseManager.assertAccess("leitura de arquivos");
  if (!currentProject) throw new Error("Nenhum projeto aberto.");
  const filePath = safePathWithinProject(currentProject, relativePath);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("Não é um arquivo.");
  const content = await fs.promises.readFile(filePath, "utf8");
  return { path: relativePath, content };
});

ipcMain.handle("project:refresh", async () => {
  licenseManager.assertAccess("atualização do workspace");
  if (!currentProject) return { tree: [], preview: null };
  const tree = await readTree(currentProject);
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
  await fetchWithTimeout(`${opencodeUrl}/instance/dispose`, { method: "POST" }, 10000).catch(() => {});
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
    headers: { "Content-Type": "application/json" },
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
    method: "DELETE"
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
  if (!currentProject) throw new Error("Nenhum projeto aberto.");
  return runValidationBuild(currentProject);
});

ipcMain.handle("preview:start", async () => {
  licenseManager.assertAccess("servidor de preview");
  if (!currentProject) throw new Error("Nenhum projeto aberto.");
  return startPreview(currentProject);
});

ipcMain.handle("preview:stop", async () => {
  await stopPreview();
  return true;
});

ipcMain.handle("opencode:status", async () => {
  try {
    const response = await fetch(`${opencodeUrl}/global/health`);
    if (!response.ok) throw new Error("offline");

    return {
      online: true,
      ...(await response.json()),
      project: currentProject
    };
  } catch {
    return { online: false, project: currentProject };
  }
});

ipcMain.handle("opencode:sessionStatus", async (_event, sessionId: string) => {
  if (!sessionId) return "idle";
  const active = activeAgentRequests.get(sessionId);
  if (active?.retryTimer || active?.isRetrying) {
    return "retry";
  }
  try {
    const response = await fetch(`${opencodeUrl}/session/status`, { headers: opencodeDirectoryHeaders() });
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
  if (!currentProject) throw new Error("Nenhum projeto aberto.");
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

  if (uploadCount > 0) perfMark("uploadStart", payload.sessionId);
  const contextParts: any[] = [];
  for (const rel of (payload.contextPaths ?? [])) {
    try {
      const absolute = safePathWithinProject(currentProject, rel);
      const item = await validateAttachment(absolute);
      perfUploadBytes(item.size);
      contextParts.push({ type: "file", url: item.url, filename: item.name, mime: item.mime });
    } catch {}
  }
  for (const attachment of (payload.attachments ?? [])) {
    const item = await validateAttachment(attachment.path);
    perfUploadBytes(item.size);
    contextParts.push({ type: "file", url: item.url, filename: item.name, mime: item.mime });
  }
  perfMark("uploadReady", payload.sessionId);

  const languageInstruction = `IDIOMA OBRIGATÓRIO DA INTERFACE: Português do Brasil (pt-BR).
Todas as respostas destinadas ao usuário devem ser escritas em português do Brasil, incluindo resumo, conclusão, explicações, nomes de etapas e qualquer texto final. Não responda em inglês, espanhol ou outro idioma. Preserve nomes técnicos inevitáveis (por exemplo, nomes de arquivos, APIs, bibliotecas, comandos, variáveis e URLs) somente quando forem necessários, mas explique o restante em português. Nunca copie ou reproduza logs, mensagens ou respostas internas de ferramentas como se fossem uma resposta ao usuário. Gere uma única resposta final, exclusivamente em português do Brasil. Não inclua uma versão em inglês antes ou depois da resposta em português.`;

  const planInstruction = `You are NekoAI's planning agent. Analyze the user's request and the current project, then return a concrete, implementation-ready plan for another agent to execute. Do not modify files. Do not ask the user whether you may proceed; the NekoAI UI handles approval separately. Your response must clearly state WHAT will be changed, WHERE it will be changed (files/components when you can determine them), and HOW it will be implemented. Include relevant validation steps.

${languageInstruction}

USER REQUEST:
${payload.text}`;

  const requestBody = {
    agent: payload.planMode ? "plan" : "build",
    ...(payload.planMode ? {} : {
      system: `You are the NekoAI software development agent. You have received an APPROVED PLAN from the user. Execute it now by modifying the project files directly in the current workspace. Do not merely describe the changes and do not ask for another approval. Do not run long-lived development servers such as npm run dev in the foreground and wait for them. The NekoAI Preview Manager handles dev servers separately. Focus on implementing the requested application, creating or editing files, installing dependencies when needed, and validating with short-lived commands. After implementation, verify that the requested changes actually exist in the files and report which files were changed.

${languageInstruction}`
    }),
    ...(payload.model ? { model: payload.model } : {}),
    parts: [{ type: "text", text: payload.planMode ? planInstruction : payload.text }, ...contextParts]
  };

  // Plan is asynchronous in OpenCode. We start the prompt and then watch the
  // same session for a NEW assistant message. This is more reliable than relying
  // on a fixed timeout or on session.status alone (which can be delayed/missing).
  if (payload.planMode) {
    const startedAt = Date.now();

    // Snapshot assistant message IDs before sending the plan so we never mistake
    // an older assistant response for the current plan.
    let baselineAssistantIds = new Set<string>();
    try {
      const client: any = await getOpencodeClient();
      const historyResult = await client.session.messages({ path: { id: payload.sessionId } });
      const historyData: any = historyResult?.data ?? historyResult ?? [];
      const entries: any[] = Array.isArray(historyData) ? historyData : [];
      baselineAssistantIds = new Set(entries
        .filter((entry: any) => (entry?.info?.role ?? entry?.role) === "assistant")
        .map((entry: any) => String(entry?.info?.id ?? entry?.id ?? ""))
        .filter(Boolean));
    } catch {}

    perfMark("taskSend", payload.sessionId);
    const response = await fetchWithTimeout(
      `${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/prompt_async`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opencodeDirectoryHeaders() },
        body: JSON.stringify(requestBody)
      },
      15000
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Falha ao iniciar o modo Plan (HTTP ${response.status}).${body ? ` ${body.slice(0, 240)}` : ""}`);
    }
    perfMark("t2", payload.sessionId);

    // Maximum safety guard only. Normal completion is driven by the session's
    // fresh assistant message, not by this timer.
    const safetyDeadline = Date.now() + 10 * 60 * 1000;
    let lastText = "";
    let stableSince = 0;

    while (Date.now() < safetyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 700));

      let statusType = "";
      try {
        const statusResponse = await fetchWithTimeout(`${opencodeUrl}/session/status`, {}, 5000);
        if (statusResponse.ok) {
          const statusPayload: any = await statusResponse.json();
          const statuses = statusPayload?.data ?? statusPayload ?? {};
          const sessionStatus = statuses?.[payload.sessionId];
          statusType = String(sessionStatus?.type ?? sessionStatus ?? "").toLowerCase();
        }
      } catch {}

      try {
        const messagesResponse = await fetchWithTimeout(
          `${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/message`,
          { headers: opencodeDirectoryHeaders() },
          8000
        );
        if (!messagesResponse.ok) continue;
        const messagesPayload: any = await messagesResponse.json();
        const entries: any[] = Array.isArray(messagesPayload) ? messagesPayload : (messagesPayload?.data ?? []);
        const assistants = entries.filter((entry: any) => (entry?.info?.role ?? entry?.role) === "assistant");

        // Prefer the most recent assistant message that was not present before
        // this Plan request. Do not use timestamps because OpenCode versions may
        // expose message times in different shapes/units.
        const fresh = assistants.filter((entry: any) => {
          const id = String(entry?.info?.id ?? entry?.id ?? "");
          return id && !baselineAssistantIds.has(id);
        });
        const latest = (fresh.length ? fresh : (assistants.length ? [assistants[assistants.length - 1]] : []))[fresh.length ? fresh.length - 1 : 0];
        const parts = Array.isArray(latest?.parts) ? latest.parts : [];
        const text = parts
          .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
          .map((part: any) => part.text.trim())
          .filter(Boolean)
          .join("\n\n")
          .trim();

        if (text) {
          if (text !== lastText) {
            lastText = text;
            stableSince = Date.now();
          }

          const idle = ["idle", "completed", "done", ""].includes(statusType);
          const stable = stableSince > 0 && Date.now() - stableSince >= 1200;
          if (fresh.length && (idle || stable)) {
            perfMark("t8", payload.sessionId);
            perfFlushTask(payload.sessionId, "plan");
            return { accepted: true, plan: text, taskId: taskCorrelationId };
          }
        }
      } catch {}
    }

    throw new Error("O modo Plan não retornou um plano dentro de 10 minutos. O OpenCode pode estar aguardando uma ação ou permissão.");
  }

  const promptStartedAt = Date.now();
  console.log(`[Neko/Agent] enviando tarefa session=${payload.sessionId} model=${payload.model?.providerID ?? "default"}/${payload.model?.modelID ?? "default"} effort=${payload.effort ?? "default"}`);
  clearActiveAgentRequest(payload.sessionId);
  activeAgentRequests.set(payload.sessionId, { requestBody, attempts: 1, maxAttempts: AGENT_RETRY_DELAYS_MS.length + 1, isRetrying: false });
  perfMark("taskSend", payload.sessionId);
  const response = await fetchWithTimeout(`${opencodeUrl}/session/${encodeURIComponent(payload.sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opencodeDirectoryHeaders() },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const failed = { error: { data: { statusCode: response.status, message: body.slice(0, 500), isRetryable: response.status >= 500 || response.status === 429 } } };
    if (isRecoverableAgentError(failed) && scheduleAgentRetry(payload.sessionId, failed)) {
      return { accepted: true, retrying: true, acceptedInMs: Date.now() - promptStartedAt, taskId: taskCorrelationId };
    }
    clearActiveAgentRequest(payload.sessionId);
    throw new Error(`Falha ao enviar tarefa ao agente (HTTP ${response.status}).${body ? ` ${body.slice(0, 240)}` : ""}`);
  }
  perfMark("t2", payload.sessionId);

  console.log(`[Neko/Agent] tarefa aceita em ${Date.now() - promptStartedAt}ms; execução agora é assíncrona no OpenCode`);
  return { accepted: true, acceptedInMs: Date.now() - promptStartedAt, taskId: taskCorrelationId };
});

ipcMain.handle("opencode:permissions", async (_event, sessionId: string) => {
  if (!sessionId) return [];
  try {
    const response = await fetch(`${opencodeUrl}/permission`, { headers: opencodeDirectoryHeaders() });
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
  const headers = { "Content-Type": "application/json", ...opencodeDirectoryHeaders() };
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

ipcMain.handle("opencode:abort", async (_event, sessionId: string) => {
  if (!sessionId) throw new Error("Sessão do Neko não encontrada.");
  clearActiveAgentRequest(sessionId);
  engineRetryStates.delete(sessionId);
  if (!opencodeUrl) throw new Error("OpenCode não está conectado.");

  const response = await fetch(`${opencodeUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
    method: "POST",
    headers: opencodeDirectoryHeaders()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao interromper a sessão (HTTP ${response.status}).${body ? ` ${body.slice(0, 240)}` : ""}`);
  }

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
    styled = (await injectPreviewScrollbar(frame)) || styled;
  }
  if (styled) {
    perfMark("t6");
    mainWindow.webContents.send("preview:event", { type: "preview.frame-ready", properties: {} });
  }
  return styled;
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
  let value = String(rawUrl || "").trim();
  const currentPreviewUrl = typeof previewState.url === "string" ? previewState.url : "";

  // Always prefer the Main Process authoritative URL
  if (currentPreviewUrl && previewState.status === "ready") {
    if (value && !previewUrlsMatch(value, currentPreviewUrl)) {
      console.log(`[Preview] external url-corrected from=${sanitizeExternalPreviewUrl(value)} to=${sanitizeExternalPreviewUrl(currentPreviewUrl)}`);
    }
    value = currentPreviewUrl;
  } else if (!value) {
    if (currentPreviewUrl) {
      value = currentPreviewUrl;
      console.log(`[Preview] external url-fallback to=${sanitizeExternalPreviewUrl(value)}`);
    } else {
      console.log("[Preview] external open failed: no preview URL available");
      throw new Error("Nenhum servidor de Preview ativo no momento.");
    }
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
  if (!currentProject) {
    const parsed = parseSupabaseError("Nenhum projeto ativo.");
    return {
      ...supabaseManager.getState(),
      error: parsed.message,
      structuredError: parsed,
    };
  }
  try {
    const info = await detectProject(currentProject).catch(() => null);
    return await supabaseManager.selectProject(currentProject, ref, {
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
  if (!currentProject) throw new Error("Nenhum projeto ativo.");
  return await supabaseManager.disconnect(currentProject);
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

ipcMain.handle("vercel:publish", async () => {
  licenseManager.assertAccess("publicação na Vercel");
  if (vercelPublishInProgress) {
    throw new Error("Já existe uma publicação na Vercel em andamento.");
  }
  if (!currentProject) {
    throw new Error("Selecione um projeto antes de publicar na Vercel.");
  }
  vercelPublishInProgress = true;
  try {
    const environment: Record<string, string> = {};
    const info = await detectProject(currentProject).catch(() => null);
    const supabaseIntegration = await supabaseManager.getIntegration(currentProject);
    if (supabaseIntegration) {
      const names = getSupabaseEnvironmentNames(info?.framework || "Vite");
      environment[names.url] = supabaseIntegration.projectUrl;
      environment[names.publishableKey] = supabaseIntegration.publishableKey;
    }
    return await vercelManager.deploy(currentProject, environment);
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

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[Neko/Renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Neko/Renderer] render-process-gone", details);
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
        
        // Envia diagnóstico estruturado para o renderer
        mainWindow?.webContents.send("preview:event", { 
          type: "preview.error-detected", 
          properties: { 
            ...diagnosticInfo,
            attempt: attemptCount + 1,
            maxAttempts: 3
          } 
        });
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
    // Envia evento de alteração de estado para o Renderer
    mainWindow?.webContents.send("license:state-changed", newState);

    // Se perdeu o acesso licenciado (transferência para outro PC, revogação ou expiração), fecha o workspace imediatamente
    if (!newState.isLicensed && prevState.isLicensed) {
      console.warn("[Neko/License] Licença perdida/transferida. Encerrando workspace e servidores ativos imediatamente.");
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
  licenseManager.shutdown();
  supabaseManager.shutdown();
  vercelManager.shutdown();
  void stopPreview();
  void stopOpenCode();
});

app.on("will-quit", () => {
  void stopPreview();
  void stopOpenCode();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Process-level safety net: se o processo Node/Electron sofrer encerramento abrupto,
// garantir a eliminação síncrona de processos órfãos no SO.
process.on("exit", () => {
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
  void stopPreview();
  void stopOpenCode();
  app.quit();
});

process.on("SIGTERM", () => {
  void stopPreview();
  void stopOpenCode();
  app.quit();
});

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { normalizeRepoRelativePath } from "./git-path-normalizer";
export { normalizeRepoRelativePath };

export interface GitChangedFile {
  path: string;
  status: "modified" | "untracked" | "deleted" | "added" | "renamed";
  staged: boolean;
}

export interface GitStatusSummary {
  modified: number;
  untracked: number;
  deleted: number;
  staged: number;
  total: number;
}

export interface GitSyncCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitSyncFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export type GitSyncStateKind =
  | "synced"
  | "behind"
  | "ahead"
  | "diverged"
  | "dirty-behind"
  | "dirty-diverged"
  | "no-remote"
  | "no-upstream"
  | "unborn"
  | "not-initialized"
  | "error";

export interface GitSyncStatus {
  initialized: boolean;
  branch: string | null;
  remote: string | null;
  linkedRepo: string | null;
  ahead: number;
  behind: number;
  workingTreeDirty: boolean;
  diverged: boolean;
  canFastForward: boolean;
  status: GitSyncStateKind;
  hasRemote: boolean;
  hasUpstream: boolean;
  fetchSuccess: boolean;
  fetchError?: string | null;
  changedFiles: GitChangedFile[];
  summary: GitStatusSummary;
  remoteCommits?: GitSyncCommit[];
  localCommits?: GitSyncCommit[];
  remoteChangedFiles?: GitSyncFileDiff[];
}

export interface PullResult {
  ok: boolean;
  pulled: boolean;
  message: string;
  syncStatus: GitSyncStatus;
}

export interface GitConflictHunk {
  id: string;
  localContent: string;
  githubContent: string;
  baseContent?: string;
  startLine?: number;
}

export interface GitConflictFile {
  path: string;
  localContent: string;
  githubContent: string;
  baseContent?: string;
  resolution?: "local" | "github" | "both" | null;
  status: "pending" | "resolved";
  resolutionLabel?: string;
  canCombineSafely?: boolean;
  combinedContent?: string;
  diffHunks?: GitConflictHunk[];
}

export interface GitSyncCombineResult {
  ok: boolean;
  hasConflicts: boolean;
  conflictFiles?: GitConflictFile[];
  message: string;
  syncStatus: GitSyncStatus;
}


export type GitRunnerResult = { code: number; stdout: string; stderr: string };

export type GitRunner = (
  projectPath: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMs?: number,
  signal?: AbortSignal
) => Promise<GitRunnerResult>;

export type AuthenticatedGitRunner = (
  projectPath: string,
  args: string[],
  token: string,
  timeoutMs?: number,
  signal?: AbortSignal
) => Promise<GitRunnerResult>;

export function parseGitStatusPorcelain(output: string): { files: GitChangedFile[]; summary: GitStatusSummary } {
  const files: GitChangedFile[] = [];
  const lines = output.split(/\r?\n/).filter(line => line.length >= 2);
  let modifiedCount = 0;
  let untrackedCount = 0;
  let deletedCount = 0;
  let stagedCount = 0;

  for (const line of lines) {
    let x = " ";
    let y = " ";
    let rawPath = "";

    // Regex robusta para Git Status Porcelain v1:
    // Captura código de 1 ou 2 caracteres e o caminho completo.
    // Suporta status com espaço inicial preservado (" M index.html", "?? index.html")
    // e status cujo espaço inicial foi removido por trim ("M index.html", "D index.html").
    const match = line.match(/^([ MADRCU?!]{1,2})\s+(.+)$/);
    if (match) {
      const statusCode = match[1];
      rawPath = match[2].trim();
      if (statusCode.length === 1) {
        // O espaço da primeira coluna (index) foi removido por trim; logo coluna 1 é ' ', coluna 2 é statusCode[0]
        x = " ";
        y = statusCode[0];
      } else {
        x = statusCode[0];
        y = statusCode[1];
      }
    } else {
      x = line[0] || " ";
      y = line[1] || " ";
      rawPath = line.slice(2).trim();
    }

    if (rawPath.includes(" -> ")) {
      rawPath = rawPath.split(" -> ")[1].trim();
    }
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
      rawPath = rawPath.slice(1, -1);
    }

    const cleanPath = normalizeRepoRelativePath(rawPath);
    console.log(`[SELECTIVE-COMMIT] status path: ${cleanPath}`);

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
      path: cleanPath,
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

export function parseGitCommitLog(output: string): GitSyncCommit[] {
  const commits: GitSyncCommit[] = [];
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length >= 4) {
      const hash = parts[0].trim();
      const message = parts[1].trim();
      const author = parts[2].trim();
      const date = parts.slice(3).join("|").trim();
      commits.push({
        hash,
        shortHash: hash.slice(0, 7),
        message: message || "Sem mensagem de commit",
        author: author || "Autor desconhecido",
        date: date || new Date().toISOString()
      });
    } else if (line.length > 0) {
      // Fallback for oneline format: <hash> <message>
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/i);
      if (match) {
        commits.push({
          hash: match[1],
          shortHash: match[1].slice(0, 7),
          message: match[2],
          author: "",
          date: ""
        });
      }
    }
  }

  return commits;
}

export function parseGitNameStatusDiff(output: string): GitSyncFileDiff[] {
  const diffs: GitSyncFileDiff[] = [];
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split(/\t+|\s+/);
    if (parts.length >= 2) {
      const statusCode = parts[0][0]?.toUpperCase();
      let filePath = parts[1];
      if (parts.length > 2 && (statusCode === "R" || statusCode === "C")) {
        filePath = parts[2];
      }
      let status: GitSyncFileDiff["status"] = "modified";
      if (statusCode === "A") status = "added";
      else if (statusCode === "D") status = "deleted";
      else if (statusCode === "R") status = "renamed";

      diffs.push({
        path: filePath.replaceAll("\\", "/"),
        status
      });
    }
  }

  return diffs;
}

export function parseLinkedRepo(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  return remoteUrl
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .trim() || null;
}

/**
 * Default process-based Git runner when none is explicitly injected.
 */
export function createDefaultGitRunner(gitExecutable = "git"): GitRunner {
  return (projectPath: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeoutMs = 45000, signal?: AbortSignal) => {
    return new Promise<GitRunnerResult>((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error("Operação Git cancelada."));
      }

      let resolved = false;
      let timer: NodeJS.Timeout | null = null;

      const child = spawn(gitExecutable, args, {
        cwd: projectPath,
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          cleanup();
          try { child.kill(); } catch {}
          resolve({
            code: 124,
            stdout: "",
            stderr: "Tempo limite excedido na operação Git."
          });
        }, timeoutMs);
      }

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
      child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", err => {
        cleanup();
        if (resolved) return;
        resolved = true;
        reject(err);
      });
      child.on("exit", code => {
        cleanup();
        if (resolved) return;
        resolved = true;
        resolve({
          code: typeof code === "number" ? code : 1,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });
    });
  };
}

export interface CheckSyncOptions {
  fetch?: boolean;
  token?: string;
  gitRunner?: GitRunner;
  authenticatedGitRunner?: AuthenticatedGitRunner;
  signal?: AbortSignal;
}

/**
 * Reads and evaluates complete Git sync state against remote tracking branch.
 */
export async function checkGitSyncStatus(
  projectPath: string,
  options: CheckSyncOptions = {}
): Promise<GitSyncStatus> {
  const runner = options.gitRunner || createDefaultGitRunner();
  const emptySummary: GitStatusSummary = { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 };

  const defaultEmptyStatus: GitSyncStatus = {
    initialized: false,
    branch: null,
    remote: null,
    linkedRepo: null,
    ahead: 0,
    behind: 0,
    workingTreeDirty: false,
    diverged: false,
    canFastForward: false,
    status: "not-initialized",
    hasRemote: false,
    hasUpstream: false,
    fetchSuccess: false,
    fetchError: null,
    changedFiles: [],
    summary: emptySummary
  };

  if (!projectPath) {
    return defaultEmptyStatus;
  }

  // 1. Check if inside work tree
  const inside = await runner(projectPath, ["rev-parse", "--is-inside-work-tree"], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (inside.code !== 0 || inside.stdout !== "true") {
    return defaultEmptyStatus;
  }

  // 2. Discover current branch
  const branchResult = await runner(projectPath, ["branch", "--show-current"], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  let currentBranch = branchResult.code === 0 && branchResult.stdout ? branchResult.stdout.trim() : null;

  if (!currentBranch) {
    // Check symbolic-ref or detached HEAD
    const symRef = await runner(projectPath, ["symbolic-ref", "--short", "HEAD"], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (symRef.code === 0 && symRef.stdout) {
      currentBranch = symRef.stdout.trim();
    }
  }

  // 3. Discover remote origin
  const remoteResult = await runner(projectPath, ["remote", "get-url", "origin"], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const remote = remoteResult.code === 0 && remoteResult.stdout ? remoteResult.stdout.trim() : null;
  const linkedRepo = parseLinkedRepo(remote);
  const hasRemote = Boolean(remote);

  // 4. Check working tree dirty status
  const dirtyResult = await runner(projectPath, ["status", "--porcelain", "-uall"], {}, 15000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const parsed = parseGitStatusPorcelain(dirtyResult.stdout || "");
  const workingTreeDirty = parsed.files.length > 0;

  // 5. Check if local HEAD has any commits
  const headCheck = await runner(projectPath, ["rev-parse", "--verify", "HEAD"], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const hasLocalCommits = headCheck.code === 0;

  if (!hasRemote) {
    return {
      initialized: true,
      branch: currentBranch,
      remote: null,
      linkedRepo: null,
      ahead: hasLocalCommits ? 1 : 0,
      behind: 0,
      workingTreeDirty,
      diverged: false,
      canFastForward: false,
      status: "no-remote",
      hasRemote: false,
      hasUpstream: false,
      fetchSuccess: false,
      fetchError: null,
      changedFiles: parsed.files,
      summary: parsed.summary
    };
  }

  if (!currentBranch) {
    return {
      initialized: true,
      branch: null,
      remote,
      linkedRepo,
      ahead: 0,
      behind: 0,
      workingTreeDirty,
      diverged: false,
      canFastForward: false,
      status: "unborn",
      hasRemote: true,
      hasUpstream: false,
      fetchSuccess: false,
      fetchError: null,
      changedFiles: parsed.files,
      summary: parsed.summary
    };
  }

  // 6. Fetch origin if requested
  let fetchSuccess = false;
  let fetchError: string | null = null;

  if (options.fetch !== false) {
    try {
      let fetchResult: GitRunnerResult;
      if (options.token && options.authenticatedGitRunner) {
        fetchResult = await options.authenticatedGitRunner(projectPath, ["fetch", "--prune", "origin"], options.token, 25000, options.signal);
      } else {
        fetchResult = await runner(projectPath, ["fetch", "--prune", "origin"], {}, 25000, options.signal);
      }

      if (fetchResult.code === 0) {
        fetchSuccess = true;
      } else {
        fetchSuccess = false;
        fetchError = fetchResult.stderr || fetchResult.stdout || "Falha ao consultar repositório remoto.";
      }
    } catch (err: any) {
      fetchSuccess = false;
      fetchError = err?.message || String(err);
    }
  }

  // 7. Check if upstream tracking branch refs/remotes/origin/<branch> exists
  const remoteRefName = `refs/remotes/origin/${currentBranch}`;
  const remoteRefCheck = await runner(projectPath, ["rev-parse", "--verify", remoteRefName], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const hasUpstream = remoteRefCheck.code === 0;

  if (!hasUpstream) {
    let localCommitCount = 0;
    if (hasLocalCommits) {
      const countRes = await runner(projectPath, ["rev-list", "--count", "HEAD"], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "0", stderr: "" }));
      localCommitCount = parseInt(countRes.stdout.trim() || "0", 10) || 0;
    }

    return {
      initialized: true,
      branch: currentBranch,
      remote,
      linkedRepo,
      ahead: localCommitCount,
      behind: 0,
      workingTreeDirty,
      diverged: false,
      canFastForward: false,
      status: "no-upstream",
      hasRemote: true,
      hasUpstream: false,
      fetchSuccess,
      fetchError,
      changedFiles: parsed.files,
      summary: parsed.summary
    };
  }

  if (!hasLocalCommits) {
    // Local unborn branch, but remote ref exists
    const remoteCountRes = await runner(projectPath, ["rev-list", "--count", remoteRefName], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "0", stderr: "" }));
    const behindCount = parseInt(remoteCountRes.stdout.trim() || "0", 10) || 0;

    return {
      initialized: true,
      branch: currentBranch,
      remote,
      linkedRepo,
      ahead: 0,
      behind: behindCount,
      workingTreeDirty,
      diverged: false,
      canFastForward: behindCount > 0 && !workingTreeDirty,
      status: behindCount > 0 ? (workingTreeDirty ? "dirty-behind" : "behind") : "synced",
      hasRemote: true,
      hasUpstream: true,
      fetchSuccess,
      fetchError,
      changedFiles: parsed.files,
      summary: parsed.summary
    };
  }

  // 8. Calculate ahead & behind
  const aheadCheck = await runner(projectPath, ["rev-list", "--count", `${remoteRefName}..HEAD`], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "0", stderr: "" }));
  const behindCheck = await runner(projectPath, ["rev-list", "--count", `HEAD..${remoteRefName}`], {}, 5000, options.signal).catch(() => ({ code: 1, stdout: "0", stderr: "" }));

  const ahead = aheadCheck.code === 0 ? parseInt(aheadCheck.stdout.trim() || "0", 10) || 0 : 0;
  const behind = behindCheck.code === 0 ? parseInt(behindCheck.stdout.trim() || "0", 10) || 0 : 0;
  const diverged = ahead > 0 && behind > 0;
  const canFastForward = ahead === 0 && behind > 0 && !workingTreeDirty;

  let stateKind: GitSyncStateKind = "synced";
  if (diverged) {
    stateKind = workingTreeDirty ? "dirty-diverged" : "diverged";
  } else if (behind > 0) {
    stateKind = workingTreeDirty ? "dirty-behind" : "behind";
  } else if (ahead > 0) {
    stateKind = "ahead";
  } else {
    stateKind = "synced";
  }

  // 9. Collect commit logs and diff details if relevant
  let remoteCommits: GitSyncCommit[] | undefined = undefined;
  let localCommits: GitSyncCommit[] | undefined = undefined;
  let remoteChangedFiles: GitSyncFileDiff[] | undefined = undefined;

  if (behind > 0 || diverged) {
    const logRes = await runner(projectPath, ["log", "--format=%H|%s|%an|%cI", "-n", "10", `HEAD..${remoteRefName}`], {}, 10000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (logRes.code === 0 && logRes.stdout) {
      remoteCommits = parseGitCommitLog(logRes.stdout);
    }

    const diffRes = await runner(projectPath, ["diff", "--name-status", `HEAD..${remoteRefName}`], {}, 10000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (diffRes.code === 0 && diffRes.stdout) {
      remoteChangedFiles = parseGitNameStatusDiff(diffRes.stdout);
    }
  }

  if (ahead > 0 || diverged) {
    const logRes = await runner(projectPath, ["log", "--format=%H|%s|%an|%cI", "-n", "10", `${remoteRefName}..HEAD`], {}, 10000, options.signal).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (logRes.code === 0 && logRes.stdout) {
      localCommits = parseGitCommitLog(logRes.stdout);
    }
  }

  return {
    initialized: true,
    branch: currentBranch,
    remote,
    linkedRepo,
    ahead,
    behind,
    workingTreeDirty,
    diverged,
    canFastForward,
    status: stateKind,
    hasRemote: true,
    hasUpstream: true,
    fetchSuccess,
    fetchError,
    changedFiles: parsed.files,
    summary: parsed.summary,
    remoteCommits,
    localCommits,
    remoteChangedFiles
  };
}

export interface PullFastForwardOptions {
  token?: string;
  gitRunner?: GitRunner;
  authenticatedGitRunner?: AuthenticatedGitRunner;
  signal?: AbortSignal;
}

/**
 * Performs safe git pull --ff-only on the current branch.
 * Enforces strict safety:
 * - Local working tree MUST be clean.
 * - ahead MUST be 0 (no local unpushed commits diverged from remote).
 * - behind MUST be > 0.
 * Never executes destructive operations (reset --hard, clean, silent merge).
 */
export async function pullFastForwardOnly(
  projectPath: string,
  options: PullFastForwardOptions = {}
): Promise<PullResult> {
  const runner = options.gitRunner || createDefaultGitRunner();

  // 1. Check current sync state with fresh fetch
  const syncStatus = await checkGitSyncStatus(projectPath, {
    fetch: true,
    token: options.token,
    gitRunner: options.gitRunner,
    authenticatedGitRunner: options.authenticatedGitRunner,
    signal: options.signal
  });

  if (!syncStatus.initialized) {
    throw new Error("O projeto não possui um repositório Git inicializado.");
  }

  if (!syncStatus.hasRemote || !syncStatus.remote) {
    throw new Error("O projeto não possui um repositório remoto configurado.");
  }

  if (!syncStatus.branch) {
    throw new Error("Não foi possível determinar a branch atual do projeto.");
  }

  // Safety Constraint 1: Working tree must be clean
  if (syncStatus.workingTreeDirty) {
    throw new Error(
      "Existem alterações locais não salvas no projeto. O NekoAI preservou seus arquivos e bloqueou a sincronização automática para evitar perda de dados. Salve ou descarte suas alterações locais antes de trazer as alterações do GitHub."
    );
  }

  // Safety Constraint 2: Local commits must not be diverged (ahead must be 0)
  if (syncStatus.diverged || syncStatus.ahead > 0) {
    throw new Error(
      `O projeto possui alterações locais divergentes (${syncStatus.ahead} commit(s) local(is) e ${syncStatus.behind} commit(s) no GitHub). Pull fast-forward não é possível sem resolução manual.`
    );
  }

  // Check if there is anything to pull
  if (syncStatus.behind === 0) {
    return {
      ok: true,
      pulled: false,
      message: "O projeto já está sincronizado com o GitHub.",
      syncStatus
    };
  }

  // Execute git pull --ff-only
  const branch = syncStatus.branch;
  let pullResult: GitRunnerResult;

  if (options.token && options.authenticatedGitRunner) {
    pullResult = await options.authenticatedGitRunner(
      projectPath,
      ["pull", "--ff-only", "origin", branch],
      options.token,
      35000,
      options.signal
    );
  } else {
    pullResult = await runner(
      projectPath,
      ["pull", "--ff-only", "origin", branch],
      {},
      35000,
      options.signal
    );
  }

  if (pullResult.code !== 0) {
    const errText = pullResult.stderr || pullResult.stdout || "Erro desconhecido ao executar git pull --ff-only.";
    throw new Error(`Falha ao sincronizar com GitHub (--ff-only): ${errText}`);
  }

  // Re-check sync status after successful pull (without re-fetching to be fast)
  const updatedStatus = await checkGitSyncStatus(projectPath, {
    fetch: false,
    gitRunner: options.gitRunner,
    signal: options.signal
  });

  return {
    ok: true,
    pulled: true,
    message: "Alterações trazidas do GitHub com sucesso.",
    syncStatus: updatedStatus
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type DiffOp = { type: "same" | "add" | "del"; line: string };

function diffSimple(orig: string[], mod: string[]): DiffOp[] {
  // Classic DP LCS-based diff for lines
  const m = orig.length;
  const n = mod.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (orig[i - 1] === mod[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && orig[i - 1] === mod[j - 1]) {
      ops.unshift({ type: "same", line: orig[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "add", line: mod[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      ops.unshift({ type: "del", line: orig[i - 1] });
      i--;
    }
  }

  return ops;
}

interface BaseAlignedChunk {
  baseLines: string[];
  localLines: string[];
  githubLines: string[];
}

export function diff3MergeLines(
  localLines: string[],
  baseLines: string[],
  githubLines: string[]
): { hasConflict: boolean; lines: string[] } {
  if (arraysEqual(localLines, baseLines)) {
    return { hasConflict: false, lines: [...githubLines] };
  }
  if (arraysEqual(githubLines, baseLines)) {
    return { hasConflict: false, lines: [...localLines] };
  }
  if (arraysEqual(localLines, githubLines)) {
    return { hasConflict: false, lines: [...localLines] };
  }

  if (baseLines.length === 0) {
    if (localLines.length === 0) return { hasConflict: false, lines: [...githubLines] };
    if (githubLines.length === 0) return { hasConflict: false, lines: [...localLines] };
    return { hasConflict: true, lines: [] };
  }

  const diffLocal = diffSimple(baseLines, localLines);
  const diffGithub = diffSimple(baseLines, githubLines);

  // Group diffs by common base lines
  const locChunks: Array<{ base: string[]; mod: string[] }> = [];
  let curBaseLoc: string[] = [];
  let curModLoc: string[] = [];

  for (const op of diffLocal) {
    if (op.type === "same") {
      locChunks.push({ base: curBaseLoc, mod: curModLoc });
      curBaseLoc = [op.line];
      curModLoc = [op.line];
    } else if (op.type === "del") {
      curBaseLoc.push(op.line);
    } else if (op.type === "add") {
      curModLoc.push(op.line);
    }
  }
  locChunks.push({ base: curBaseLoc, mod: curModLoc });

  const ghChunks: Array<{ base: string[]; mod: string[] }> = [];
  let curBaseGh: string[] = [];
  let curModGh: string[] = [];

  for (const op of diffGithub) {
    if (op.type === "same") {
      ghChunks.push({ base: curBaseGh, mod: curModGh });
      curBaseGh = [op.line];
      curModGh = [op.line];
    } else if (op.type === "del") {
      curBaseGh.push(op.line);
    } else if (op.type === "add") {
      curModGh.push(op.line);
    }
  }
  ghChunks.push({ base: curBaseGh, mod: curModGh });

  // If number of same-anchor points matches cleanly
  if (locChunks.length === ghChunks.length) {
    const merged: string[] = [];
    for (let idx = 0; idx < locChunks.length; idx++) {
      const lc = locChunks[idx];
      const gc = ghChunks[idx];
      const lChanged = !arraysEqual(lc.base, lc.mod);
      const gChanged = !arraysEqual(gc.base, gc.mod);

      if (!lChanged && !gChanged) {
        merged.push(...lc.mod);
      } else if (lChanged && !gChanged) {
        merged.push(...lc.mod);
      } else if (!lChanged && gChanged) {
        merged.push(...gc.mod);
      } else if (arraysEqual(lc.mod, gc.mod)) {
        merged.push(...lc.mod);
      } else {
        // Real overlapping conflict in this hunk
        return { hasConflict: true, lines: [] };
      }
    }
    return { hasConflict: false, lines: merged };
  }

  // If structures diverged irregularly, flag conflict safely
  return { hasConflict: true, lines: [] };
}

export function trySmartCombine(
  arg1: string,
  arg2: string,
  arg3?: string
): {
  canCombine: boolean;
  canCombineSafely: boolean;
  combined: string;
  combinedContent: string;
  diffHunks: GitConflictHunk[];
  reason?: string;
} {
  let base = "";
  let local = "";
  let github = "";

  if (arg3 !== undefined) {
    // trySmartCombine(local, github, base)
    local = arg1;
    github = arg2;
    base = arg3;
  } else {
    // trySmartCombine(local, github) - without base
    local = arg1;
    github = arg2;
    base = "";
  }

  if (local === github) {
    return {
      canCombine: true,
      canCombineSafely: true,
      combined: local,
      combinedContent: local,
      diffHunks: []
    };
  }
  if (!base || base === local) {
    return {
      canCombine: true,
      canCombineSafely: true,
      combined: github,
      combinedContent: github,
      diffHunks: []
    };
  }
  if (base === github) {
    return {
      canCombine: true,
      canCombineSafely: true,
      combined: local,
      combinedContent: local,
      diffHunks: []
    };
  }

  const localLines = local.split(/\r?\n/);
  const githubLines = github.split(/\r?\n/);
  const baseLines = base ? base.split(/\r?\n/) : [];

  const result = diff3MergeLines(localLines, baseLines, githubLines);
  if (result.hasConflict) {
    const diffLocal = diffSimple(baseLines, localLines);
    const diffGh = diffSimple(baseLines, githubLines);
    const locHunk = diffLocal.filter(d => d.type === "add").map(d => d.line).join("\n");
    const ghHunk = diffGh.filter(d => d.type === "add").map(d => d.line).join("\n");

    return {
      canCombine: false,
      canCombineSafely: false,
      combined: "",
      combinedContent: "",
      diffHunks: [
        {
          id: "hunk-1",
          localContent: locHunk || local,
          githubContent: ghHunk || github,
          baseContent: base
        }
      ],
      reason:
        "As alterações do GitHub e locais modificam as mesmas linhas e não podem ser mescladas automaticamente com segurança. Escolha Manter local ou Usar GitHub."
    };
  }

  const mergedStr = result.lines.join("\n");
  return {
    canCombine: true,
    canCombineSafely: true,
    combined: mergedStr,
    combinedContent: mergedStr,
    diffHunks: []
  };
}

export function parseConflictMarkers(content: string): {
  hasMarkers: boolean;
  hasConflict: boolean;
  hunks: GitConflictHunk[];
  localVersion: string;
  localOnly: string;
  githubVersion: string;
  githubOnly: string;
} {
  const lines = content.split(/\r?\n/);
  const hunks: GitConflictHunk[] = [];
  let hasMarkers = false;

  let inConflict = false;
  let inTheirs = false;
  let currentOurs: string[] = [];
  let currentTheirs: string[] = [];
  let startLine = 1;

  const localLinesAll: string[] = [];
  const githubLinesAll: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      hasMarkers = true;
      inConflict = true;
      inTheirs = false;
      currentOurs = [];
      currentTheirs = [];
      startLine = i + 1;
    } else if (line.startsWith("=======") && inConflict) {
      inTheirs = true;
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      inConflict = false;
      const hunkId = `hunk-${hunks.length + 1}`;
      // In git conflict markers: HEAD (ours) is first, incoming (theirs) is second
      const oursChunk = currentOurs.join("\n");
      const theirsChunk = currentTheirs.join("\n");

      hunks.push({
        id: hunkId,
        localContent: oursChunk,
        githubContent: theirsChunk,
        startLine
      });

      localLinesAll.push(...currentOurs);
      githubLinesAll.push(...currentTheirs);
    } else if (inConflict) {
      if (inTheirs) {
        currentTheirs.push(line);
      } else {
        currentOurs.push(line);
      }
    } else {
      localLinesAll.push(line);
      githubLinesAll.push(line);
    }
  }

  const locStr = localLinesAll.join("\n");
  const ghStr = githubLinesAll.join("\n");

  return {
    hasMarkers,
    hasConflict: hasMarkers,
    hunks,
    localVersion: locStr,
    localOnly: locStr,
    githubVersion: ghStr,
    githubOnly: ghStr
  };
}

export async function getConflictFiles(
  projectPath: string,
  runner: GitRunner = createDefaultGitRunner()
): Promise<GitConflictFile[]> {
  const unmergedRes = await runner(projectPath, ["diff", "--name-only", "--diff-filter=U"], {}, 10000);
  let fileList = (unmergedRes.stdout || "")
    .split(/\r?\n/)
    .map(l => l.trim().replaceAll("\\", "/"))
    .filter(Boolean);

  if (fileList.length === 0) {
    const statusRes = await runner(projectPath, ["status", "--porcelain"], {}, 10000);
    const lines = (statusRes.stdout || "").split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      const code = l.slice(0, 2);
      if (code.includes("U") || code === "AA" || code === "DD") {
        let p = l.slice(3).trim().replaceAll("\\", "/");
        if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
        if (!fileList.includes(p)) fileList.push(p);
      }
    }
  }

  const conflicts: GitConflictFile[] = [];

  for (const relPath of fileList) {
    // Stage 1: Base/Ancestor
    const baseRes = await runner(projectPath, ["show", `:1:${relPath}`], {}, 5000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    // Stage 2: Ours (HEAD -> Remote after ff pull)
    const stage2Res = await runner(projectPath, ["show", `:2:${relPath}`], {}, 5000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    // Stage 3: Theirs (Stash -> Local)
    const stage3Res = await runner(projectPath, ["show", `:3:${relPath}`], {}, 5000).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    let localContent = stage3Res.code === 0 ? stage3Res.stdout : "";
    let githubContent = stage2Res.code === 0 ? stage2Res.stdout : "";
    const baseContent = baseRes.code === 0 ? baseRes.stdout : "";

    // Fallback: If stages are not populated, check file on disk for conflict markers
    if (stage2Res.code !== 0 && stage3Res.code !== 0) {
      try {
        const diskContent = await fs.promises.readFile(path.join(projectPath, relPath), "utf8");
        const parsed = parseConflictMarkers(diskContent);
        if (parsed.hasMarkers) {
          localContent = parsed.localVersion;
          githubContent = parsed.githubVersion;
        } else {
          localContent = diskContent;
        }
      } catch {}
    }

    const smart = trySmartCombine(baseContent, localContent, githubContent);

    conflicts.push({
      path: relPath,
      localContent,
      githubContent,
      baseContent: baseContent || undefined,
      status: "pending",
      resolution: null,
      canCombineSafely: smart.canCombine,
      combinedContent: smart.canCombine ? smart.combined : undefined
    });
  }

  return conflicts;
}

export interface SyncCombineOptions {
  token?: string;
  gitRunner?: GitRunner;
  authenticatedGitRunner?: AuthenticatedGitRunner;
  signal?: AbortSignal;
}

export async function syncAndCombineProject(
  projectPath: string,
  options: SyncCombineOptions = {}
): Promise<GitSyncCombineResult> {
  const runner = options.gitRunner || createDefaultGitRunner();

  // 1. Initial fresh sync check
  const syncStatus = await checkGitSyncStatus(projectPath, {
    fetch: true,
    token: options.token,
    gitRunner: options.gitRunner,
    authenticatedGitRunner: options.authenticatedGitRunner,
    signal: options.signal
  });

  if (!syncStatus.initialized) {
    throw new Error("O projeto não possui um repositório Git inicializado.");
  }
  if (!syncStatus.hasRemote || !syncStatus.remote) {
    throw new Error("O projeto não possui um repositório remoto configurado.");
  }
  if (!syncStatus.branch) {
    throw new Error("Não foi possível determinar a branch atual do projeto.");
  }

  // Scenario A: Already synced
  if (syncStatus.behind === 0 && syncStatus.ahead === 0 && !syncStatus.workingTreeDirty) {
    return {
      ok: true,
      hasConflicts: false,
      message: "O projeto já está totalmente sincronizado com o GitHub.",
      syncStatus
    };
  }

  // Scenario B: Remote ahead & Clean working tree & ahead === 0 -> Simple Fast-Forward
  if (syncStatus.behind > 0 && syncStatus.ahead === 0 && !syncStatus.workingTreeDirty) {
    const pullRes = await pullFastForwardOnly(projectPath, {
      token: options.token,
      gitRunner: options.gitRunner,
      authenticatedGitRunner: options.authenticatedGitRunner,
      signal: options.signal
    });
    return {
      ok: true,
      hasConflicts: false,
      message: "Alterações trazidas do GitHub com sucesso.",
      syncStatus: pullRes.syncStatus
    };
  }

  // Scenario C & D: Remote ahead with local changes (dirty working tree or local commits)
  const branch = syncStatus.branch;
  const isDirty = syncStatus.workingTreeDirty;
  let checkpointStashCreated = false;

  // Step 1: Create safe checkpoint stash of working tree if dirty
  if (isDirty) {
    const stashMsg = `neko-sync-checkpoint-${Date.now()}`;
    const stashRes = await runner(projectPath, ["stash", "push", "--include-untracked", "-m", stashMsg], {}, 25000, options.signal);
    if (stashRes.code === 0 && !stashRes.stdout.includes("No local changes to save")) {
      checkpointStashCreated = true;
    }
  }

  try {
    // Step 2: Bring remote updates
    if (syncStatus.ahead === 0) {
      // Pull fast-forward remote branch to HEAD
      let pullResult: GitRunnerResult;
      if (options.token && options.authenticatedGitRunner) {
        pullResult = await options.authenticatedGitRunner(projectPath, ["pull", "--ff-only", "origin", branch], options.token, 35000, options.signal);
      } else {
        pullResult = await runner(projectPath, ["pull", "--ff-only", "origin", branch], {}, 35000, options.signal);
      }

      if (pullResult.code !== 0) {
        throw new Error(`Falha ao puxar alterações do GitHub: ${pullResult.stderr || pullResult.stdout}`);
      }
    } else {
      // Merge remote commits with local commits
      let mergeResult: GitRunnerResult;
      if (options.token && options.authenticatedGitRunner) {
        await options.authenticatedGitRunner(projectPath, ["fetch", "origin", branch], options.token, 30000, options.signal);
      } else {
        await runner(projectPath, ["fetch", "origin", branch], {}, 30000, options.signal);
      }

      mergeResult = await runner(projectPath, ["merge", `origin/${branch}`, "--no-edit", "-m", `NekoAI: sincronização com origin/${branch}`], {}, 35000, options.signal);
      if (mergeResult.code !== 0) {
        // Merge produced conflict directly between commits
        const conflicts = await getConflictFiles(projectPath, runner);
        const updatedStatus = await checkGitSyncStatus(projectPath, { fetch: false, gitRunner: runner, signal: options.signal });
        return {
          ok: true,
          hasConflicts: true,
          conflictFiles: conflicts,
          message: "Existem alterações no mesmo trecho que precisam da sua decisão.",
          syncStatus: updatedStatus
        };
      }
    }

    // Step 3: Re-apply local uncommitted changes from stash if stashed
    if (checkpointStashCreated) {
      const stashApply = await runner(projectPath, ["stash", "apply", "stash@{0}"], {}, 25000, options.signal);

      // Check if there are unmerged conflicts
      const conflicts = await getConflictFiles(projectPath, runner);
      if (conflicts.length > 0 || stashApply.code !== 0) {
        // Conflicts present! Do NOT drop stash yet (keep it as safe recovery)
        const updatedStatus = await checkGitSyncStatus(projectPath, { fetch: false, gitRunner: runner, signal: options.signal });
        return {
          ok: true,
          hasConflicts: true,
          conflictFiles: conflicts,
          message: "Existem alterações no mesmo trecho que precisam da sua decisão.",
          syncStatus: updatedStatus
        };
      }

      // Stash applied cleanly with 0 conflicts -> Safe to drop temporary checkpoint stash
      await runner(projectPath, ["stash", "drop", "stash@{0}"], {}, 15000).catch(() => {});
    }

    // All clean! Refresh status
    const finalStatus = await checkGitSyncStatus(projectPath, { fetch: false, gitRunner: runner, signal: options.signal });
    return {
      ok: true,
      hasConflicts: false,
      message: "Projeto sincronizado e alterações combinadas com sucesso.",
      syncStatus: finalStatus
    };
  } catch (err: any) {
    // If an error occurred and we created a stash, leave it safely intact
    throw err;
  }
}

export async function resolveConflictFile(
  projectPathOrPayload: string | { projectPath?: string; filePath: string; resolution: "local" | "github" | "both"; customContent?: string },
  filePathArg?: string,
  resolutionArg?: "local" | "github" | "both",
  customContentArg?: string,
  runnerArg?: GitRunner
): Promise<{ ok: boolean; filePath: string; resolution: string }> {
  let projectPath: string;
  let filePath: string;
  let resolution: "local" | "github" | "both";
  let customContent: string | undefined;
  const runner: GitRunner = runnerArg || createDefaultGitRunner();

  if (typeof projectPathOrPayload === "object" && projectPathOrPayload !== null) {
    projectPath = projectPathOrPayload.projectPath || process.cwd();
    filePath = projectPathOrPayload.filePath;
    resolution = projectPathOrPayload.resolution;
    customContent = projectPathOrPayload.customContent;
  } else {
    projectPath = projectPathOrPayload;
    filePath = filePathArg!;
    resolution = resolutionArg!;
    customContent = customContentArg;
  }

  const normRelPath = (filePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const absPath = path.resolve(projectPath, normRelPath);

  // Security check: ensure path is within project
  if (!absPath.startsWith(path.resolve(projectPath) + path.sep)) {
    throw new Error("Caminho de arquivo inválido para resolução de conflito.");
  }

  let contentToWrite = customContent;

  if (contentToWrite === undefined) {
    if (resolution === "local") {
      const stage3 = await runner(projectPath, ["show", `:3:${normRelPath}`], {}, 5000);
      if (stage3.code === 0) contentToWrite = stage3.stdout;
    } else if (resolution === "github") {
      const stage2 = await runner(projectPath, ["show", `:2:${normRelPath}`], {}, 5000);
      if (stage2.code === 0) contentToWrite = stage2.stdout;
    }
  }

  if (contentToWrite !== undefined) {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, contentToWrite, "utf8");
  }

  // Mark file as resolved in Git index
  const addRes = await runner(projectPath, ["add", normRelPath], {}, 15000);
  if (addRes.code !== 0) {
    throw new Error(`Falha ao registrar resolução do arquivo ${normRelPath}: ${addRes.stderr || addRes.stdout}`);
  }

  return { ok: true, filePath: normRelPath, resolution };
}

export async function finalizeConflictResolution(
  projectPathOrPayload: string | { projectPath?: string; message?: string; runner?: GitRunner; signal?: AbortSignal },
  optionsArg: { message?: string; runner?: GitRunner; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; message: string; syncStatus: GitSyncStatus }> {
  let projectPath: string;
  let options: { message?: string; runner?: GitRunner; signal?: AbortSignal } = optionsArg;

  if (typeof projectPathOrPayload === "object" && projectPathOrPayload !== null) {
    projectPath = projectPathOrPayload.projectPath || process.cwd();
    options = { ...optionsArg, ...projectPathOrPayload };
  } else {
    projectPath = projectPathOrPayload;
  }

  const runner = options.runner || createDefaultGitRunner();

  // Verify that all conflicts have been resolved
  const remainingConflicts = await runner(projectPath, ["diff", "--name-only", "--diff-filter=U"], {}, 5000);
  if (remainingConflicts.code === 0 && remainingConflicts.stdout.trim().length > 0) {
    const unmergedList = remainingConflicts.stdout.split(/\r?\n/).filter(Boolean);
    throw new Error(
      `Ainda existem ${unmergedList.length} arquivo(s) com conflitos pendentes de resolução: ${unmergedList.join(", ")}`
    );
  }

  // If in merge state (.git/MERGE_HEAD), complete the merge commit
  const gitDir = path.join(projectPath, ".git");
  const mergeHeadFile = path.join(gitDir, "MERGE_HEAD");
  if (fs.existsSync(mergeHeadFile)) {
    const commitMsg = options.message || "NekoAI: resolução visual de conflitos com GitHub";
    const commitRes = await runner(projectPath, ["commit", "-m", commitMsg], {}, 20000, options.signal);
    if (commitRes.code !== 0 && !commitRes.stdout.includes("nothing to commit")) {
      throw new Error(`Falha ao concluir commit de mesclagem: ${commitRes.stderr || commitRes.stdout}`);
    }
  }

  // Drop temporary checkpoint stash if one was created for sync
  const stashList = await runner(projectPath, ["stash", "list"], {}, 5000);
  if (stashList.code === 0 && stashList.stdout.includes("neko-sync-checkpoint-")) {
    const lines = stashList.stdout.split(/\r?\n/);
    for (const l of lines) {
      if (l.includes("neko-sync-checkpoint-")) {
        const match = l.match(/^(stash@\{\d+\}):/);
        if (match) {
          await runner(projectPath, ["stash", "drop", match[1]], {}, 10000).catch(() => {});
        }
      }
    }
  }

  const syncStatus = await checkGitSyncStatus(projectPath, {
    fetch: false,
    gitRunner: runner,
    signal: options.signal
  });

  return {
    ok: true,
    message: "Conflitos resolvidos e sincronização finalizada com sucesso.",
    syncStatus
  };
}

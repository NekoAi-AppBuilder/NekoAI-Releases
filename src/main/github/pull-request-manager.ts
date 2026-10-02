import path from "node:path";
import fs from "node:fs";
import { fetchWithTimeout } from "../fetch-timeout";
import {
  createDefaultGitRunner,
  checkGitSyncStatus,
  getConflictFiles,
  type GitRunner,
  type AuthenticatedGitRunner,
  type GitConflictFile,
  type GitRunnerResult
} from "../git-sync";

export type NekoPullRequestState =
  | "NO_PR"
  | "PR_OPEN"
  | "PR_READY_TO_MERGE"
  | "PR_BLOCKED"
  | "PR_CONFLICTS"
  | "PR_MERGED"
  | "PR_CLOSED"
  | "PR_UNKNOWN";

export interface NekoPullRequestCheck {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | null;
}

export interface NekoPullRequestStatus {
  ok: boolean;
  state: NekoPullRequestState;
  prNumber?: number;
  title?: string;
  htmlUrl?: string;
  headBranch: string;
  baseBranch: string;
  repoFullName: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  commitsCount?: number;
  author?: string;
  updatedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
  hasConflicts: boolean;
  checksApproved: boolean;
  checksPending: boolean;
  checksFailed: boolean;
  checks: NekoPullRequestCheck[];
  message?: string;
  error?: string;
  alreadyExisted?: boolean;
}

export interface FetchGithubApiOptions {
  token: string;
  timeoutMs?: number;
}

/**
 * Função utilitária para chamadas diretas à API do GitHub usando o token resolvido da conta ativa.
 */
export async function rawGithubFetch(
  pathname: string,
  options: FetchGithubApiOptions,
  init: RequestInit = {}
): Promise<Response> {
  const timeout = options.timeoutMs || 20000;
  const url = pathname.startsWith("http") ? pathname : `https://api.github.com${pathname}`;
  return await fetchWithTimeout(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {})
    }
  }, timeout);
}

/**
 * Consulta a API do GitHub para buscar a Pull Request e seus status de integração/checks.
 */
export async function getPullRequestStatus(params: {
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  token: string;
  prNumber?: number;
}): Promise<NekoPullRequestStatus> {
  const { repoFullName, headBranch, baseBranch, token } = params;

  if (!repoFullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
    return {
      ok: false,
      state: "PR_UNKNOWN",
      headBranch,
      baseBranch,
      repoFullName: repoFullName || "",
      draft: false,
      mergeable: null,
      mergeableState: "unknown",
      hasConflicts: false,
      checksApproved: false,
      checksPending: false,
      checksFailed: false,
      checks: [],
      error: "Repositório do GitHub inválido."
    };
  }

  if (!headBranch || !baseBranch) {
    return {
      ok: false,
      state: "PR_UNKNOWN",
      headBranch,
      baseBranch,
      repoFullName,
      draft: false,
      mergeable: null,
      mergeableState: "unknown",
      hasConflicts: false,
      checksApproved: false,
      checksPending: false,
      checksFailed: false,
      checks: [],
      error: "Branch de origem e destino são obrigatórias."
    };
  }

  try {
    let prData: any = null;

    // Se já tivermos o número da PR, fazemos fetch direto
    if (params.prNumber) {
      const res = await rawGithubFetch(`/repos/${repoFullName}/pulls/${params.prNumber}`, { token });
      if (res.ok) {
        prData = await res.json();
      }
    }

    // Caso não tenha o número da PR ou a busca falhou, procuramos via listagem
    if (!prData) {
      // 1. Procurar por PRs com state=open
      const openPullsRes = await rawGithubFetch(
        `/repos/${repoFullName}/pulls?head=${encodeURIComponent(headBranch)}&base=${encodeURIComponent(baseBranch)}&state=open&sort=updated&direction=desc`,
        { token }
      );
      if (openPullsRes.ok) {
        const list: any[] = await openPullsRes.json();
        if (Array.isArray(list) && list.length > 0) {
          // Busca os detalhes completos da PR (necessário para ver mergeable e mergeable_state)
          const detailRes = await rawGithubFetch(`/repos/${repoFullName}/pulls/${list[0].number}`, { token });
          if (detailRes.ok) prData = await detailRes.json();
        }
      }
    }

    // Se não encontrou PR aberta, procurar por PR fechada/merged recente
    if (!prData) {
      const allPullsRes = await rawGithubFetch(
        `/repos/${repoFullName}/pulls?head=${encodeURIComponent(headBranch)}&base=${encodeURIComponent(baseBranch)}&state=all&sort=updated&direction=desc`,
        { token }
      );
      if (allPullsRes.ok) {
        const list: any[] = await allPullsRes.json();
        if (Array.isArray(list) && list.length > 0) {
          const detailRes = await rawGithubFetch(`/repos/${repoFullName}/pulls/${list[0].number}`, { token });
          if (detailRes.ok) prData = await detailRes.json();
        }
      }
    }

    // Se nenhuma PR foi encontrada
    if (!prData) {
      return {
        ok: true,
        state: "NO_PR",
        headBranch,
        baseBranch,
        repoFullName,
        draft: false,
        mergeable: null,
        mergeableState: "unknown",
        hasConflicts: false,
        checksApproved: false,
        checksPending: false,
        checksFailed: false,
        checks: [],
        message: "Nenhuma Pull Request aberta."
      };
    }

    // Extração de dados da PR encontrada
    const number = Number(prData.number);
    const title = String(prData.title || `PR #${number}`);
    const htmlUrl = String(prData.html_url || `https://github.com/${repoFullName}/pull/${number}`);
    const isDraft = Boolean(prData.draft);
    const prStateStr = String(prData.state || "open").toLowerCase();
    const isMerged = Boolean(prData.merged || prData.merged_at);
    const mergeable = prData.mergeable === true ? true : (prData.mergeable === false ? false : null);
    const mergeableState = String(prData.mergeable_state || "unknown").toLowerCase();
    const headSha = prData.head?.sha;
    const author = prData.user?.login;
    const updatedAt = prData.updated_at;
    const mergedAt = prData.merged_at;
    const mergedBy = prData.merged_by?.login;
    const commitsCount = typeof prData.commits === "number" ? prData.commits : undefined;

    // Busca de Status Checks (Check Runs e Combined Commit Status)
    let checks: NekoPullRequestCheck[] = [];
    let checksApproved = false;
    let checksPending = false;
    let checksFailed = false;

    if (headSha) {
      try {
        const checkRunsRes = await rawGithubFetch(`/repos/${repoFullName}/commits/${headSha}/check-runs`, { token });
        if (checkRunsRes.ok) {
          const checkRunsJson: any = await checkRunsRes.json();
          const runs: any[] = Array.isArray(checkRunsJson?.check_runs) ? checkRunsJson.check_runs : [];
          for (const cr of runs) {
            checks.push({
              name: String(cr.name || "Check"),
              status: cr.status === "completed" ? "completed" : (cr.status === "in_progress" ? "in_progress" : "queued"),
              conclusion: cr.conclusion || null
            });
          }
        }

        const statusRes = await rawGithubFetch(`/repos/${repoFullName}/commits/${headSha}/status`, { token });
        if (statusRes.ok) {
          const statusJson: any = await statusRes.json();
          const statuses: any[] = Array.isArray(statusJson?.statuses) ? statusJson.statuses : [];
          for (const st of statuses) {
            const isDone = st.state === "success" || st.state === "failure" || st.state === "error";
            checks.push({
              name: String(st.context || "Status"),
              status: isDone ? "completed" : "in_progress",
              conclusion: st.state === "success" ? "success" : (st.state === "pending" ? null : "failure")
            });
          }
        }
      } catch (err) {
        console.warn("[Neko/PullRequestManager] Erro ao buscar status de checks:", err);
      }
    }

    if (checks.length > 0) {
      checksFailed = checks.some(c => c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out");
      checksPending = checks.some(c => c.status !== "completed" || (c.status === "completed" && c.conclusion === null));
      checksApproved = checks.every(c => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped"));
    }

    const hasConflicts = mergeable === false || mergeableState === "dirty";

    // Classificação do Estado Interno (NekoPullRequestState)
    let internalState: NekoPullRequestState = "PR_OPEN";

    if (prStateStr === "closed") {
      if (isMerged) {
        internalState = "PR_MERGED";
      } else {
        internalState = "PR_CLOSED";
      }
    } else if (hasConflicts) {
      internalState = "PR_CONFLICTS";
    } else if (isDraft || checksFailed || mergeableState === "unstable") {
      internalState = "PR_BLOCKED";
    } else if (mergeableState === "clean" || (mergeable === true && !checksFailed && !checksPending)) {
      internalState = "PR_READY_TO_MERGE";
    } else if (checksPending || mergeableState === "blocked" || mergeable === null) {
      internalState = "PR_OPEN";
    } else {
      internalState = "PR_OPEN";
    }

    return {
      ok: true,
      state: internalState,
      prNumber: number,
      title,
      htmlUrl,
      headBranch: prData.head?.ref || headBranch,
      baseBranch: prData.base?.ref || baseBranch,
      repoFullName,
      draft: isDraft,
      mergeable,
      mergeableState,
      commitsCount,
      author,
      updatedAt,
      mergedAt,
      mergedBy,
      hasConflicts,
      checksApproved,
      checksPending,
      checksFailed,
      checks
    };
  } catch (error: any) {
    return {
      ok: false,
      state: "PR_UNKNOWN",
      headBranch,
      baseBranch,
      repoFullName,
      draft: false,
      mergeable: null,
      mergeableState: "unknown",
      hasConflicts: false,
      checksApproved: false,
      checksPending: false,
      checksFailed: false,
      checks: [],
      error: error?.message || "Erro de conexão ao consultar Pull Request no GitHub."
    };
  }
}

export interface ListPullRequestsParams {
  repoFullName: string;
  token: string;
  page?: number;
  perPage?: number;
  state?: "all" | "open" | "closed";
}

export interface ListPullRequestsResult {
  ok: boolean;
  prs: NekoPullRequestStatus[];
  page: number;
  perPage: number;
  hasMore: boolean;
  error?: string;
}

/**
 * Lista as Pull Requests de um repositório com paginação real.
 */
export async function listPullRequests(params: ListPullRequestsParams): Promise<ListPullRequestsResult> {
  const { repoFullName, token } = params;
  const page = params.page && params.page > 0 ? params.page : 1;
  const perPage = params.perPage && params.perPage > 0 ? params.perPage : 10;
  const stateFilter = params.state || "all";

  if (!repoFullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) {
    return { ok: false, prs: [], page, perPage, hasMore: false, error: "Repositório do GitHub inválido." };
  }

  try {
    const res = await rawGithubFetch(
      `/repos/${repoFullName}/pulls?state=${stateFilter}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      { token }
    );

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      return { ok: false, prs: [], page, perPage, hasMore: false, error: errJson.message || "Erro ao consultar a lista de Pull Requests." };
    }

    const list: any[] = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: true, prs: [], page, perPage, hasMore: false };
    }

    const prs: NekoPullRequestStatus[] = [];

    for (const prData of list) {
      const prNumber = Number(prData.number);
      const headBranch = String(prData.head?.ref || "");
      const baseBranch = String(prData.base?.ref || "main");

      if (prData.state === "open") {
        const detailedStatus = await getPullRequestStatus({
          repoFullName,
          headBranch,
          baseBranch,
          token,
          prNumber
        }).catch(() => null);

        if (detailedStatus && detailedStatus.ok) {
          prs.push(detailedStatus);
          continue;
        }
      }

      const prStateStr = String(prData.state || "open").toLowerCase();
      const isMerged = Boolean(prData.merged || prData.merged_at);
      let internalState: NekoPullRequestState = "PR_OPEN";

      if (prStateStr === "closed") {
        internalState = isMerged ? "PR_MERGED" : "PR_CLOSED";
      } else if (prData.draft) {
        internalState = "PR_BLOCKED";
      }

      prs.push({
        ok: true,
        state: internalState,
        prNumber,
        title: String(prData.title || `PR #${prNumber}`),
        htmlUrl: String(prData.html_url || `https://github.com/${repoFullName}/pull/${prNumber}`),
        headBranch,
        baseBranch,
        repoFullName,
        draft: Boolean(prData.draft),
        mergeable: prData.mergeable === true ? true : (prData.mergeable === false ? false : null),
        mergeableState: String(prData.mergeable_state || "unknown"),
        author: prData.user?.login,
        updatedAt: prData.updated_at,
        mergedAt: prData.merged_at,
        hasConflicts: false,
        checksApproved: false,
        checksPending: false,
        checksFailed: false,
        checks: []
      });
    }

    const hasMore = list.length === perPage;
    return { ok: true, prs, page, perPage, hasMore };
  } catch (error: any) {
    return { ok: false, prs: [], page, perPage, hasMore: false, error: error?.message || "Erro ao consultar a lista de Pull Requests." };
  }
}

/**
 * Executa o Merge da Pull Request via API oficial do GitHub.
 * Valida o estado antes da execução para evitar race conditions ou commits desatualizados.
 */
export async function mergePullRequest(params: {
  repoFullName: string;
  prNumber: number;
  expectedHeadBranch: string;
  expectedBaseBranch: string;
  token: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}): Promise<{ ok: boolean; message?: string; error?: string; updatedStatus?: NekoPullRequestStatus }> {
  const { repoFullName, prNumber, expectedHeadBranch, expectedBaseBranch, token } = params;
  const mergeMethod = params.mergeMethod || "merge";

  // 1. Revalidação antes de executar o Merge (Requisito 9)
  const currentStatus = await getPullRequestStatus({
    repoFullName,
    headBranch: expectedHeadBranch,
    baseBranch: expectedBaseBranch,
    token,
    prNumber
  });

  if (!currentStatus.ok) {
    return {
      ok: false,
      error: currentStatus.error || "Não foi possível validar o estado da Pull Request antes da integração.",
      updatedStatus: currentStatus
    };
  }

  if (currentStatus.state === "PR_MERGED") {
    return {
      ok: true,
      message: "Esta Pull Request já foi mesclada com sucesso no GitHub.",
      updatedStatus: currentStatus
    };
  }

  if (currentStatus.state === "PR_CLOSED") {
    return {
      ok: false,
      error: "A Pull Request foi fechada no GitHub sem ser integrada.",
      updatedStatus: currentStatus
    };
  }

  if (currentStatus.hasConflicts || currentStatus.state === "PR_CONFLICTS") {
    return {
      ok: false,
      error: `Não é possível mesclar: existem conflitos entre a branch "${expectedHeadBranch}" e a branch "${expectedBaseBranch}".`,
      updatedStatus: currentStatus
    };
  }

  if (currentStatus.state === "PR_BLOCKED" || currentStatus.checksFailed) {
    return {
      ok: false,
      error: "A integração está bloqueada por verificações pendentes ou que falharam no GitHub.",
      updatedStatus: currentStatus
    };
  }

  // 2. Invocação da API oficial PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge
  try {
    const title = params.commitTitle || `Merge pull request #${prNumber} from ${expectedHeadBranch}`;
    const body: any = {
      commit_title: title,
      merge_method: mergeMethod
    };
    if (params.commitMessage) {
      body.commit_message = params.commitMessage;
    }

    const mergeRes = await rawGithubFetch(`/repos/${repoFullName}/pulls/${prNumber}/merge`, { token }, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const resJson: any = await mergeRes.json().catch(() => ({}));

    if (mergeRes.ok && (resJson?.merged || mergeRes.status === 200)) {
      const postMergeStatus = await getPullRequestStatus({
        repoFullName,
        headBranch: expectedHeadBranch,
        baseBranch: expectedBaseBranch,
        token,
        prNumber
      });
      return {
        ok: true,
        message: `Pull Request #${prNumber} mesclada com sucesso na branch "${expectedBaseBranch}".`,
        updatedStatus: postMergeStatus
      };
    }

    let errMsg = resJson?.message || `Erro ao mesclar Pull Request (HTTP ${mergeRes.status}).`;
    if (mergeRes.status === 405) {
      errMsg = `Não foi possível mesclar a PR #${prNumber}: ${resJson?.message || "A branch possui conflitos ou não atende aos requisitos de proteção do GitHub."}`;
    } else if (mergeRes.status === 409) {
      errMsg = `Conflito de concorrência: o SHA da head branch foi alterado. Recarregue e tente novamente.`;
    }

    const postErrorStatus = await getPullRequestStatus({
      repoFullName,
      headBranch: expectedHeadBranch,
      baseBranch: expectedBaseBranch,
      token,
      prNumber
    });

    return {
      ok: false,
      error: errMsg,
      updatedStatus: postErrorStatus
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || "Erro de rede ao executar o merge da Pull Request."
    };
  }
}

export interface PRConflictResolutionPrepResult {
  ok: boolean;
  reason?: "no_longer_conflicted" | "requires_branch_switch" | "local_changes_exist" | "already_merged" | "pr_closed" | "error";
  hasConflicts?: boolean;
  conflictFiles?: GitConflictFile[];
  requiresBranchSwitch?: boolean;
  currentBranch?: string;
  targetBranch?: string;
  isDirty?: boolean;
  prStatus?: NekoPullRequestStatus;
  message?: string;
  error?: string;
}

export async function preparePRConflictResolution(params: {
  projectPath: string;
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  token: string;
  prNumber?: number;
  gitRunner?: GitRunner;
  authenticatedGitRunner?: AuthenticatedGitRunner;
  signal?: AbortSignal;
}): Promise<PRConflictResolutionPrepResult> {
  const { projectPath, repoFullName, headBranch, baseBranch, token, prNumber } = params;
  const runner = params.gitRunner || createDefaultGitRunner();

  // 1. Re-query fresh PR status from GitHub REST API (Section 5 requirement)
  const freshStatus = await getPullRequestStatus({
    repoFullName,
    headBranch,
    baseBranch,
    token,
    prNumber
  });

  if (!freshStatus.ok) {
    return {
      ok: false,
      reason: "error",
      error: freshStatus.error || "Não foi possível verificar o estado atual da Pull Request no GitHub."
    };
  }

  if (freshStatus.state === "PR_MERGED") {
    return {
      ok: false,
      reason: "already_merged",
      prStatus: freshStatus,
      message: "Esta Pull Request já foi mesclada com sucesso no GitHub."
    };
  }

  if (freshStatus.state === "PR_CLOSED") {
    return {
      ok: false,
      reason: "pr_closed",
      prStatus: freshStatus,
      message: "A Pull Request foi fechada no GitHub."
    };
  }

  // If conflicts are no longer present according to GitHub:
  if (!freshStatus.hasConflicts && freshStatus.state !== "PR_CONFLICTS") {
    return {
      ok: true,
      reason: "no_longer_conflicted",
      hasConflicts: false,
      prStatus: freshStatus,
      message: "A Pull Request não possui mais conflitos no GitHub."
    };
  }

  // 2. Check local git status and current branch (Section 6 & 7 requirement)
  const syncStatus = await checkGitSyncStatus(projectPath, {
    fetch: false,
    gitRunner: runner,
    signal: params.signal
  });

  const currentBranch = syncStatus.branch;

  // Check if current branch is NOT headBranch (Section 7 requirement)
  if (currentBranch !== headBranch) {
    return {
      ok: false,
      reason: "requires_branch_switch",
      requiresBranchSwitch: true,
      currentBranch: currentBranch || undefined,
      targetBranch: headBranch,
      prStatus: freshStatus
    };
  }

  // Check if working tree is dirty with uncommitted local changes (Section 6 requirement)
  const gitDir = path.join(projectPath, ".git");
  const isMergeInProgress = fs.existsSync(path.join(gitDir, "MERGE_HEAD"));

  if (syncStatus.workingTreeDirty && !isMergeInProgress) {
    return {
      ok: false,
      reason: "local_changes_exist",
      isDirty: true,
      currentBranch: currentBranch || undefined,
      targetBranch: headBranch,
      prStatus: freshStatus,
      message: "Existem alterações locais que precisam ser preservadas antes de resolver este conflito."
    };
  }

  // 3. Fetch baseBranch and merge origin/<baseBranch> into local <headBranch> (Section 8 requirement)
  try {
    if (token && params.authenticatedGitRunner) {
      await params.authenticatedGitRunner(projectPath, ["fetch", "origin", baseBranch], token, 30000, params.signal);
    } else {
      await runner(projectPath, ["fetch", "origin", baseBranch], {}, 30000, params.signal);
    }

    const mergeResult = await runner(
      projectPath,
      ["merge", `origin/${baseBranch}`, "--no-edit", "-m", `Merge branch '${baseBranch}' into ${headBranch}`],
      {},
      35000,
      params.signal
    );

    const conflictFiles = await getConflictFiles(projectPath, runner);

    if (conflictFiles.length > 0 || mergeResult.code !== 0) {
      return {
        ok: true,
        hasConflicts: true,
        conflictFiles,
        prStatus: freshStatus,
        currentBranch: headBranch
      };
    }

    return {
      ok: true,
      hasConflicts: false,
      prStatus: freshStatus,
      message: `Alterações da branch "${baseBranch}" incorporadas sem conflitos.`
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: "error",
      error: err?.message || "Erro ao preparar o ambiente local de resolução de conflitos."
    };
  }
}

export async function pushPRBranch(params: {
  projectPath: string;
  headBranch: string;
  token: string;
  gitRunner?: GitRunner;
  authenticatedGitRunner?: AuthenticatedGitRunner;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const runner = params.gitRunner || createDefaultGitRunner();
  const { projectPath, headBranch, token } = params;

  let pushRes: GitRunnerResult;
  if (token && params.authenticatedGitRunner) {
    pushRes = await params.authenticatedGitRunner(
      projectPath,
      ["push", "origin", headBranch],
      token,
      45000,
      params.signal
    );
  } else {
    pushRes = await runner(projectPath, ["push", "origin", headBranch], {}, 45000, params.signal);
  }

  if (pushRes.code !== 0) {
    const err = pushRes.stderr || pushRes.stdout || "Erro ao enviar a branch da PR.";
    return {
      ok: false,
      error: `Não foi possível enviar a branch "${headBranch}" para o GitHub: ${err}`
    };
  }

  return {
    ok: true,
    message: `Branch "${headBranch}" enviada com sucesso para o GitHub.`
  };
}

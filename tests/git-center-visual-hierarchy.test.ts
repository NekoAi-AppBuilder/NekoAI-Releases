import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Git Center Visual Hierarchy & PR Contextual Separation
 *
 * Garante que:
 * 1. O banner superior do Git Center represente PRIORITARIAMENTE o estado atual do projeto/branch:
 *    - Prioridade 1: Sem acesso ao repositório
 *    - Prioridade 2: Conflito / operação bloqueada (divergência ou conflito na branch atual)
 *    - Prioridade 3: Alterações locais não salvas/commitadas (isDirty)
 *    - Prioridade 4: Atualizações remotas pendentes (behind > 0)
 *    - Prioridade 5: Commits locais pendentes de envio (ahead > 0)
 *    - Prioridade 6: Tudo sincronizado / Tudo em dia
 *
 * 2. O status de Pull Request (ex: "Resolvido · Pull Request integrado") NUNCA sobrescreva
 *    o banner superior do projeto. O contexto de PR pertence à seção "Pull Requests",
 *    e só é listado quando o headBranch do PR corresponder à branch ativa.
 */

interface GitCenterContext {
  branchName: string;
  isRepoLinked: boolean;
  isAccessible: boolean;
  activeAccountLogin?: string;
  linkedRepo?: string;
  isDirty: boolean;
  changedCount: number;
  ahead: number;
  behind: number;
  diverged: boolean;
  githubPrStatus?: {
    ok: boolean;
    state: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    hasConflicts?: boolean;
    title?: string;
  } | null;
  githubPrList?: Array<{
    prNumber: number;
    title: string;
    headBranch: string;
    baseBranch: string;
    state?: string;
  }>;
}

function computeGitCenterTopBanner(ctx: GitCenterContext) {
  const isRepoLinked = ctx.isRepoLinked;
  const isAccessible = ctx.isAccessible;
  const activeAcc = ctx.activeAccountLogin ? { login: ctx.activeAccountLogin } : null;
  const branchName = ctx.branchName || "main";
  const isDirty = Boolean(ctx.isDirty);
  const changedCount = ctx.changedCount || 0;
  const ahead = ctx.ahead || 0;
  const behind = isAccessible ? (ctx.behind || 0) : 0;
  const diverged = isAccessible && Boolean(ctx.diverged);

  const pr = isAccessible ? ctx.githubPrStatus : null;
  const isPrContextual = Boolean(pr && pr.headBranch === branchName);

  let statusBadgeColor = "#22c55e";
  let statusBadgeText = "Tudo em dia";
  let statusMessage = "O workspace local está sincronizado e pronto para trabalho.";

  if (isRepoLinked && !isAccessible) {
    statusBadgeColor = "#f97316";
    statusBadgeText = "Sem acesso ao repositório";
    statusMessage = activeAcc?.login
      ? `A conta @${activeAcc.login} não possui acesso ao repositório ${ctx.linkedRepo}. As informações locais do projeto continuam disponíveis, mas o NekoAI não pode confirmar o estado remoto.`
      : `A conta selecionada não possui acesso ao repositório ${ctx.linkedRepo}. As informações locais do projeto continuam disponíveis, mas o NekoAI não pode confirmar o estado remoto.`;
  } else if (diverged || (isPrContextual && pr?.hasConflicts)) {
    statusBadgeColor = "#ef4444";
    statusBadgeText = "Ação necessária";
    statusMessage = (isPrContextual && pr?.hasConflicts)
      ? `Existem alterações incompatíveis entre esta branch e a ${pr.baseBranch}.`
      : "O projeto possui alterações locais e remotas divergentes.";
  } else if (isDirty) {
    statusBadgeColor = "#eab308";
    statusBadgeText = "Alterações locais pendentes";
    statusMessage = `Existem ${changedCount} arquivo(s) modificado(s) não commitado(s).`;
  } else if (behind > 0) {
    statusBadgeColor = "#38bdf8";
    statusBadgeText = "Atualização disponível";
    statusMessage = `Há ${behind} alteração(ões) nova(s) no remoto aguardando sincronização.`;
  } else if (ahead > 0) {
    statusBadgeColor = "#a855f7";
    statusBadgeText = "Commits prontos para envio";
    statusMessage = `Há ${ahead} commit(s) local(is) pronto(s) para ser(em) enviado(s) ao GitHub.`;
  }

  return { statusBadgeColor, statusBadgeText, statusMessage };
}

function getContextualPullRequests(ctx: GitCenterContext) {
  if (!ctx.isRepoLinked || !ctx.isAccessible) return [];
  return (ctx.githubPrList || []).filter(pr => pr.headBranch === ctx.branchName);
}

describe("Git Center Visual Hierarchy & PR Contextual Separation", () => {
  it("1. Branch 'main' + PR 'teste-aula -> main' já integrado: NÃO mostrar banner de PR integrado no topo", () => {
    const ctx: GitCenterContext = {
      branchName: "main",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
      diverged: false,
      githubPrStatus: {
        ok: true,
        state: "PR_MERGED",
        prNumber: 1,
        headBranch: "teste-aula",
        baseBranch: "main",
      },
      githubPrList: [
        {
          prNumber: 1,
          title: "PR de teste",
          headBranch: "teste-aula",
          baseBranch: "main",
          state: "PR_MERGED",
        },
      ],
    };

    const banner = computeGitCenterTopBanner(ctx);
    // Banner deve mostrar estado atual da main ("Tudo em dia"), e NUNCA "Resolvido · Pull Request integrado"
    assert.strictEqual(banner.statusBadgeText, "Tudo em dia");
    assert.strictEqual(banner.statusBadgeColor, "#22c55e");
    assert.ok(!banner.statusBadgeText.includes("Pull Request"));
    assert.ok(!banner.statusMessage.includes("já foram integradas"));

    // Na seção Pull Requests da branch main, o PR de outra branch (teste-aula) não é listado
    const prs = getContextualPullRequests(ctx);
    assert.strictEqual(prs.length, 0);
  });

  it("2. Branch 'teste-aula' + PR 'teste-aula -> main': PR aparece na seção Pull Requests contextual", () => {
    const ctx: GitCenterContext = {
      branchName: "teste-aula",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
      diverged: false,
      githubPrStatus: {
        ok: true,
        state: "PR_MERGED",
        prNumber: 1,
        headBranch: "teste-aula",
        baseBranch: "main",
      },
      githubPrList: [
        {
          prNumber: 1,
          title: "PR de teste",
          headBranch: "teste-aula",
          baseBranch: "main",
          state: "PR_MERGED",
        },
      ],
    };

    // Na branch teste-aula, o PR é contextual para a seção Pull Requests
    const prs = getContextualPullRequests(ctx);
    assert.strictEqual(prs.length, 1);
    assert.strictEqual(prs[0].headBranch, "teste-aula");
    assert.strictEqual(prs[0].state, "PR_MERGED");
  });

  it("3. Branch 'main' + 1 arquivo local modificado: banner superior prioriza alteração local sobre qualquer PR", () => {
    const ctx: GitCenterContext = {
      branchName: "main",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: true,
      changedCount: 1,
      ahead: 0,
      behind: 0,
      diverged: false,
      githubPrStatus: {
        ok: true,
        state: "PR_MERGED",
        prNumber: 1,
        headBranch: "teste-aula",
        baseBranch: "main",
      },
    };

    const banner = computeGitCenterTopBanner(ctx);
    assert.strictEqual(banner.statusBadgeText, "Alterações locais pendentes");
    assert.strictEqual(banner.statusBadgeColor, "#eab308");
    assert.strictEqual(banner.statusMessage, "Existem 1 arquivo(s) modificado(s) não commitado(s).");
  });

  it("4. Branch com conflito/divergência: conflito tem prioridade máxima no banner", () => {
    const ctx: GitCenterContext = {
      branchName: "feature-x",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: true, // mesmo com arquivos sujos
      changedCount: 2,
      ahead: 1,
      behind: 1,
      diverged: true,
    };

    const banner = computeGitCenterTopBanner(ctx);
    assert.strictEqual(banner.statusBadgeText, "Ação necessária");
    assert.strictEqual(banner.statusBadgeColor, "#ef4444");
    assert.strictEqual(banner.statusMessage, "O projeto possui alterações locais e remotas divergentes.");
  });

  it("5. Branch atrás do remoto (behind > 0): atualização remota tem prioridade no banner", () => {
    const ctx: GitCenterContext = {
      branchName: "main",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 2,
      diverged: false,
      githubPrStatus: {
        ok: true,
        state: "PR_MERGED",
        prNumber: 1,
        headBranch: "teste-aula",
        baseBranch: "main",
      },
    };

    const banner = computeGitCenterTopBanner(ctx);
    assert.strictEqual(banner.statusBadgeText, "Atualização disponível");
    assert.strictEqual(banner.statusBadgeColor, "#38bdf8");
    assert.strictEqual(banner.statusMessage, "Há 2 alteração(ões) nova(s) no remoto aguardando sincronização.");
  });

  it("6. Branch à frente do remoto (ahead > 0): commits locais têm prioridade no banner", () => {
    const ctx: GitCenterContext = {
      branchName: "main",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: false,
      changedCount: 0,
      ahead: 3,
      behind: 0,
      diverged: false,
    };

    const banner = computeGitCenterTopBanner(ctx);
    assert.strictEqual(banner.statusBadgeText, "Commits prontos para envio");
    assert.strictEqual(banner.statusBadgeColor, "#a855f7");
    assert.strictEqual(banner.statusMessage, "Há 3 commit(s) local(is) pronto(s) para ser(em) enviado(s) ao GitHub.");
  });

  it("7. Tudo sincronizado e sem pendências: banner exibe 'Tudo em dia'", () => {
    const ctx: GitCenterContext = {
      branchName: "main",
      isRepoLinked: true,
      isAccessible: true,
      linkedRepo: "NekoAI-AppBuilder/teste-aula",
      isDirty: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
      diverged: false,
      githubPrStatus: null,
    };

    const banner = computeGitCenterTopBanner(ctx);
    assert.strictEqual(banner.statusBadgeText, "Tudo em dia");
    assert.strictEqual(banner.statusBadgeColor, "#22c55e");
    assert.strictEqual(banner.statusMessage, "O workspace local está sincronizado e pronto para trabalho.");
  });
});

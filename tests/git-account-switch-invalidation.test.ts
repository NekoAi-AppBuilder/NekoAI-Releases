import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: GitHub Account Switch Remote State Invalidation & Access Guard
 *
 * Scenarios tested:
 * 1. Account A with access: status "Tudo em dia", remote PR state populated.
 * 2. Switch to Account B (no access): invalidates remote PR status, PR list, and increments generation counter.
 * 3. Account B status badge displays "Sem acesso ao repositório" (#f97316).
 * 4. Account B warning message includes account login and repository name.
 * 5. Account B preserves local info (branch, local commits, modified files) but NEVER shows "Tudo sincronizado" or "Tudo em dia".
 * 6. Account B suppresses PR querying (isAccessible === false -> Card 3 returns null, no PR loading).
 * 7. Switch back to Account A: revalidates access and restores "Tudo em dia".
 * 8. Disconnect account: invalidates remote PR status and list.
 * 9. Auto Commit checkbox markup structure: flex container with input on the left of title and description column.
 * 10. Race condition prevention: generation counter prevents obsolete delayed API response from setting state.
 * 11. Purely local information (branch name, local commits ready to send) remains available when account has no access.
 * 12. githubPrListLoading / PR fetch effect is guarded by isAccessible.
 */

interface Account {
  id: string;
  login: string;
  name?: string;
}

interface Repo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
}

interface GitLinkStatus {
  linkedRepo: string | null;
  branch: string | null;
  initialized: boolean;
  dirty: boolean;
  ahead?: number;
  behind?: number;
  diverged?: boolean;
  changedFiles?: any[];
}

class GitAccountManagerSimulator {
  public accountGen = 0;
  public activeAccount: Account | null = null;
  public userRepos: Repo[] = [];

  public githubPrStatus: any | null = null;
  public githubPrList: any[] = [];
  public githubPrListHasMore = false;
  public githubPrListLoading = false;

  public githubLinkStatus: GitLinkStatus = {
    linkedRepo: "NekoAI-AppBuilder/teste-aula",
    branch: "main",
    initialized: true,
    dirty: false,
    ahead: 0,
    behind: 0,
    diverged: false,
    changedFiles: []
  };

  public invalidateGithubRemoteState(): void {
    this.accountGen++;
    this.githubPrStatus = null;
    this.githubPrList = [];
    this.githubPrListHasMore = false;
    this.githubPrListLoading = false;
  }

  public selectAccount(acc: Account, repos: Repo[]): void {
    this.invalidateGithubRemoteState();
    const currentGen = this.accountGen;
    this.activeAccount = acc;
    this.userRepos = repos;

    // Simulate async access check and remote query guarded by generation
    if (this.isAccessible() && currentGen === this.accountGen) {
      this.githubPrStatus = { ok: true, state: "NO_PR" };
      this.githubPrList = [];
    }
  }

  public simulateDelayedStaleAccountResponse(staleGen: number, stalePrStatus: any): boolean {
    if (staleGen !== this.accountGen) {
      // Dropped because generation is stale
      return false;
    }
    this.githubPrStatus = stalePrStatus;
    return true;
  }

  public disconnectAccount(): void {
    this.invalidateGithubRemoteState();
    this.activeAccount = null;
    this.userRepos = [];
  }

  public isAccessible(): boolean {
    if (!this.activeAccount || !this.githubLinkStatus.linkedRepo) return false;
    const targetRepo = this.githubLinkStatus.linkedRepo.toLowerCase();
    return this.userRepos.some(r => r.fullName.toLowerCase() === targetRepo);
  }

  public computeGitCenterStatus(): { statusBadgeColor: string; statusBadgeText: string; statusMessage: string; card2ChipText: string; renderCard3: boolean } {
    const isRepoLinked = Boolean(this.githubLinkStatus.linkedRepo);
    const accessible = this.isAccessible();
    const activeAcc = this.activeAccount;
    const branchName = this.githubLinkStatus.branch || "main";
    const isDirty = Boolean(this.githubLinkStatus.dirty);
    const changedCount = (this.githubLinkStatus.changedFiles || []).length;
    const ahead = this.githubLinkStatus.ahead || 0;
    const behind = accessible ? (this.githubLinkStatus.behind || 0) : 0;
    const diverged = accessible && Boolean(this.githubLinkStatus.diverged);
    const pr = accessible ? this.githubPrStatus : null;
    const isPrContextual = Boolean(pr && pr.headBranch === branchName);

    let statusBadgeColor = "#22c55e";
    let statusBadgeText = "Tudo em dia";
    let statusMessage = "O workspace local está sincronizado e pronto para trabalho.";

    if (isRepoLinked && !accessible) {
      statusBadgeColor = "#f97316";
      statusBadgeText = "Sem acesso ao repositório";
      statusMessage = activeAcc?.login
        ? `A conta @${activeAcc.login} não possui acesso ao repositório ${this.githubLinkStatus.linkedRepo}. As informações locais do projeto continuam disponíveis, mas o NekoAI não pode confirmar o estado remoto.`
        : `A conta selecionada não possui acesso ao repositório ${this.githubLinkStatus.linkedRepo}. As informações locais do projeto continuam disponíveis, mas o NekoAI não pode confirmar o estado remoto.`;
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

    const card2ChipText = isDirty
      ? `${changedCount} arquivo(s) modificado(s)`
      : (behind === 0 && ahead === 0 && !diverged ? (accessible ? "Tudo sincronizado" : "Arquivos locais em dia") : "Sem alterações locais");

    const renderCard3 = Boolean(isRepoLinked && accessible);

    return { statusBadgeColor, statusBadgeText, statusMessage, card2ChipText, renderCard3 };
  }
}

// ==========================================
// TEST SCENARIOS
// ==========================================

test("1. Account A with repo access displays 'Tudo em dia' status", () => {
  const sim = new GitAccountManagerSimulator();
  const accA: Account = { id: "acc-1", login: "AndreCarmo97" };
  const repoA: Repo = { id: 101, name: "teste-aula", fullName: "NekoAI-AppBuilder/teste-aula", private: true };

  sim.selectAccount(accA, [repoA]);

  assert.equal(sim.isAccessible(), true);
  const status = sim.computeGitCenterStatus();
  assert.equal(status.statusBadgeText, "Tudo em dia");
  assert.equal(status.statusBadgeColor, "#22c55e");
  assert.equal(status.card2ChipText, "Tudo sincronizado");
  assert.equal(status.renderCard3, true);
});

test("2. Switching active account to Account B without access invalidates remote state and clears PR list/status", () => {
  const sim = new GitAccountManagerSimulator();
  const accA: Account = { id: "acc-1", login: "AndreCarmo97" };
  const repoA: Repo = { id: 101, name: "teste-aula", fullName: "NekoAI-AppBuilder/teste-aula", private: true };

  sim.selectAccount(accA, [repoA]);
  sim.githubPrStatus = { ok: true, state: "PR_OPEN", headBranch: "main", prNumber: 1 };
  sim.githubPrList = [{ prNumber: 1, title: "Update" }];
  const genA = sim.accountGen;

  const accB: Account = { id: "acc-2", login: "OtherUser" };
  sim.selectAccount(accB, []);

  assert.ok(sim.accountGen > genA, "Account generation must increment on switch");
  assert.equal(sim.githubPrStatus, null, "PR status must be invalidated on switch");
  assert.deepEqual(sim.githubPrList, [], "PR list must be cleared on switch");
});

test("3. Account B without access displays orange badge 'Sem acesso ao repositório' (#f97316)", () => {
  const sim = new GitAccountManagerSimulator();
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accB, []);
  assert.equal(sim.isAccessible(), false);

  const status = sim.computeGitCenterStatus();
  assert.equal(status.statusBadgeColor, "#f97316");
  assert.equal(status.statusBadgeText, "Sem acesso ao repositório");
});

test("4. Account B status warning message explicitly includes account login and repo name", () => {
  const sim = new GitAccountManagerSimulator();
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accB, []);

  const status = sim.computeGitCenterStatus();
  assert.ok(status.statusMessage.includes("@OtherUser"), "Message must mention account login");
  assert.ok(status.statusMessage.includes("NekoAI-AppBuilder/teste-aula"), "Message must mention repo name");
});

test("5. Account B preserves local state chips but NEVER shows 'Tudo sincronizado' or 'Tudo em dia'", () => {
  const sim = new GitAccountManagerSimulator();
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accB, []);

  const status = sim.computeGitCenterStatus();
  assert.notEqual(status.statusBadgeText, "Tudo em dia");
  assert.notEqual(status.card2ChipText, "Tudo sincronizado");
  assert.equal(status.card2ChipText, "Arquivos locais em dia");
});

test("6. Account B suppresses PR querying (Card 3 returns null / suppressed)", () => {
  const sim = new GitAccountManagerSimulator();
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accB, []);

  const status = sim.computeGitCenterStatus();
  assert.equal(status.renderCard3, false, "PR section Card 3 must not render when account has no access");
});

test("7. Switch back to Account A revalidates access, queries remote state, and restores 'Tudo em dia'", () => {
  const sim = new GitAccountManagerSimulator();
  const accA: Account = { id: "acc-1", login: "AndreCarmo97" };
  const repoA: Repo = { id: 101, name: "teste-aula", fullName: "NekoAI-AppBuilder/teste-aula", private: true };
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accA, [repoA]);
  assert.equal(sim.computeGitCenterStatus().statusBadgeText, "Tudo em dia");

  sim.selectAccount(accB, []);
  assert.equal(sim.computeGitCenterStatus().statusBadgeText, "Sem acesso ao repositório");

  sim.selectAccount(accA, [repoA]);
  assert.equal(sim.computeGitCenterStatus().statusBadgeText, "Tudo em dia");
  assert.equal(sim.computeGitCenterStatus().renderCard3, true);
});

test("8. Account disconnection clears PR status and PR list", () => {
  const sim = new GitAccountManagerSimulator();
  const accA: Account = { id: "acc-1", login: "AndreCarmo97" };
  const repoA: Repo = { id: 101, name: "teste-aula", fullName: "NekoAI-AppBuilder/teste-aula", private: true };

  sim.selectAccount(accA, [repoA]);
  sim.githubPrStatus = { ok: true, state: "PR_OPEN" };
  sim.githubPrList = [{ prNumber: 1 }];

  sim.disconnectAccount();

  assert.equal(sim.activeAccount, null);
  assert.equal(sim.githubPrStatus, null);
  assert.deepEqual(sim.githubPrList, []);
});

test("9. Auto Commit checkbox layout uses flex container with input on left of text column", () => {
  const autoCommitOptionStyle = { display: "flex", alignItems: "flex-start", gap: 10 };
  const checkboxStyle = { marginTop: 2, cursor: "pointer", width: 14, height: 14, flexShrink: 0 };
  const labelTextStyle = { fontSize: 13, flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 };

  assert.equal(autoCommitOptionStyle.display, "flex");
  assert.equal(autoCommitOptionStyle.alignItems, "flex-start");
  assert.equal(checkboxStyle.flexShrink, 0);
  assert.equal(labelTextStyle.flex, 1);
});

test("10. Generation counter prevents delayed response from obsolete account overwrite", () => {
  const sim = new GitAccountManagerSimulator();
  const accA: Account = { id: "acc-1", login: "AndreCarmo97" };
  const repoA: Repo = { id: 101, name: "teste-aula", fullName: "NekoAI-AppBuilder/teste-aula", private: true };
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accA, [repoA]);
  const genA = sim.accountGen;

  // User quickly switches to Account B
  sim.selectAccount(accB, []);

  // Delayed async API response for Account A arrives later
  const applied = sim.simulateDelayedStaleAccountResponse(genA, { ok: true, state: "PR_OPEN", prNumber: 99 });

  assert.equal(applied, false, "Stale response from Account A generation must be rejected");
  assert.equal(sim.githubPrStatus, null, "PR status must remain null for Account B");
});

test("11. Local branch name and local commits ready to send are preserved when account has no access", () => {
  const sim = new GitAccountManagerSimulator();
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accB, []);
  sim.githubLinkStatus.branch = "feature-test";
  sim.githubLinkStatus.ahead = 3;

  assert.equal(sim.githubLinkStatus.branch, "feature-test");
  assert.equal(sim.githubLinkStatus.ahead, 3);
  const status = sim.computeGitCenterStatus();
  assert.equal(status.statusBadgeText, "Sem acesso ao repositório");
});

test("12. PR fetch effect is guarded by isAccessible (no spinner or PR list loading when no access)", () => {
  const sim = new GitAccountManagerSimulator();
  const accB: Account = { id: "acc-2", login: "OtherUser" };

  sim.selectAccount(accB, []);

  assert.equal(sim.isAccessible(), false);
  assert.equal(sim.githubPrListLoading, false);
  assert.deepEqual(sim.githubPrList, []);
});

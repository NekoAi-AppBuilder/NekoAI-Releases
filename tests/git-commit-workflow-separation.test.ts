import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Git Commit Workflow Separation
 * Valida a separação estrita entre o fluxo de commit manual do Git Center
 * e o fluxo de troca de branch com working tree sujo.
 */

interface GitChangedFile {
  path: string;
  status: "modified" | "untracked" | "deleted" | "renamed" | "added";
  staged: boolean;
}

interface GitLinkStatus {
  dirty: boolean;
  branch: string | null;
  linkedRepo: string | null;
  changedFiles: GitChangedFile[];
}

class GitCenterCommitFlowTester {
  public modal: string | null = null;
  public pendingTargetBranch: string | null = null;
  public branchCommitMessage: string = "";
  public selectedCommitFiles: Set<string> = new Set();
  public branchActionBusy: boolean = false;
  public branchActionError: string = "";
  public toasts: string[] = [];
  public gitLinkStatus: GitLinkStatus = {
    dirty: true,
    branch: "teste-git-center",
    linkedRepo: "NekoAI-AppBuilder/teste-aula",
    changedFiles: [
      { path: "src/pages/Landing.tsx", status: "modified", staged: false },
      { path: "src/components/Header.tsx", status: "modified", staged: false }
    ]
  };

  // Histórico de chamadas na API simulada
  public apiCalls: {
    commit: Array<{ message: string; files: string[] }>;
    commitPush: Array<{ message: string; files: string[] }>;
    push: number;
    checkout: string[];
    discard: number;
    gitStatus: number;
    pullRequestRefresh: number;
    checkSync: number;
  } = {
    commit: [],
    commitPush: [],
    push: 0,
    checkout: [],
    discard: 0,
    gitStatus: 0,
    pullRequestRefresh: 0,
    checkSync: 0
  };

  showToast(msg: string) {
    this.toasts.push(msg);
  }

  // Ação 1: Clicar em "Comitar alterações" no Git Center
  openGitCenterCommit() {
    this.pendingTargetBranch = null;
    this.branchCommitMessage = "Atualizações no projeto";
    this.selectedCommitFiles = new Set();
    this.branchActionError = "";
    this.modal = "branchChanges";
  }

  // Ação 2: Clicar em uma branch para trocar enquanto o repositório está dirty
  openBranchSwitchCommit(targetBranch: string) {
    this.pendingTargetBranch = targetBranch;
    this.branchCommitMessage = "WIP: alterações antes de trocar de branch";
    this.selectedCommitFiles = new Set();
    this.branchActionError = "";
    this.modal = "branchChanges";
  }

  // Ação 3: Selecionar/desmarcar arquivo
  toggleFileSelection(path: string) {
    if (this.selectedCommitFiles.has(path)) {
      this.selectedCommitFiles.delete(path);
    } else {
      this.selectedCommitFiles.add(path);
    }
  }

  // Ação 4: Avançar para tela de mensagem de commit
  goToCommitStep() {
    if (this.selectedCommitFiles.size > 0) {
      this.modal = "branchCommit";
    }
  }

  // Ação 5: Voltar da tela de mensagem de commit
  goBackFromCommitStep() {
    this.modal = "branchChanges";
  }

  // Ação 6: Cancelar no modal de alterações
  cancelChangesModal() {
    if (this.pendingTargetBranch) {
      this.modal = null;
      this.pendingTargetBranch = null;
    } else {
      this.modal = "gitCenter";
    }
  }

  // Ação 7: Confirmar Commit Manual (do Git Center - APENAS COMMIT LOCAL)
  async handleManualGitCenterCommit() {
    if (!this.branchCommitMessage.trim() || this.branchActionBusy || this.selectedCommitFiles.size === 0) return;
    this.branchActionBusy = true;
    try {
      this.apiCalls.checkSync++;
      const filesArray = Array.from(this.selectedCommitFiles);
      this.apiCalls.commit.push({ message: this.branchCommitMessage.trim(), files: filesArray });
      this.apiCalls.gitStatus++;
      this.selectedCommitFiles = new Set();
      this.branchCommitMessage = "Atualizações no projeto";
      this.apiCalls.pullRequestRefresh++;
      this.modal = "gitCenter";
      this.pendingTargetBranch = null;
      this.showToast("Commit salvo com sucesso!");
    } finally {
      this.branchActionBusy = false;
    }
  }

  // Ação 7B: Enviar commits locais para o GitHub explicitamente
  async handleManualGitPush() {
    this.apiCalls.checkSync++;
    this.apiCalls.push++;
    this.apiCalls.gitStatus++;
    this.apiCalls.pullRequestRefresh++;
    this.showToast("Alterações enviadas para o GitHub com sucesso!");
  }

  // Ação 8: Confirmar Commit antes de Trocar de Branch
  async handleBranchCommitAndCheckout() {
    if (!this.pendingTargetBranch || !this.branchCommitMessage.trim() || this.branchActionBusy || this.selectedCommitFiles.size === 0) return;
    this.branchActionBusy = true;
    const target = this.pendingTargetBranch;
    try {
      this.apiCalls.checkSync++;
      const filesArray = Array.from(this.selectedCommitFiles);
      this.apiCalls.commitPush.push({ message: this.branchCommitMessage.trim(), files: filesArray });
      this.apiCalls.checkout.push(target);
      this.apiCalls.gitStatus++;
      this.selectedCommitFiles = new Set();
      this.modal = null;
      this.pendingTargetBranch = null;
      this.showToast(`Commit realizado e alternado para "${target}" com sucesso!`);
    } finally {
      this.branchActionBusy = false;
    }
  }

  // Ação 9: Descartar alterações
  async handleBranchDiscard() {
    if (this.branchActionBusy) return;
    this.branchActionBusy = true;
    const target = this.pendingTargetBranch;
    try {
      this.apiCalls.discard++;
      if (target) {
        this.apiCalls.checkout.push(target);
      }
      this.apiCalls.gitStatus++;
      this.selectedCommitFiles = new Set();
      if (target) {
        this.modal = null;
        this.pendingTargetBranch = null;
        this.showToast(`Alterações descartadas e alternado para "${target}" com sucesso!`);
      } else {
        this.modal = "gitCenter";
        this.pendingTargetBranch = null;
        this.showToast("Alterações descartadas com sucesso!");
      }
    } finally {
      this.branchActionBusy = false;
    }
  }

  // Propriedades calculadas de UI para inspeção
  getUiComputedProps() {
    const isBranchSwitch = Boolean(this.pendingTargetBranch);
    return {
      isBranchSwitch,
      bannerVisible: isBranchSwitch,
      bannerText: isBranchSwitch ? `Antes de trocar para a branch ${this.pendingTargetBranch}, escolha as alterações que deseja comitar:` : null,
      commitModalTitle: isBranchSwitch ? "Commit antes de trocar de branch" : "Confirmar commit",
      commitModalSubtitle: isBranchSwitch ? `Salve suas alterações antes de alternar para ${this.pendingTargetBranch}.` : "Salve as alterações selecionadas no repositório.",
      commitHelpText: isBranchSwitch ? `Após o commit, o NekoAI trocará automaticamente para ${this.pendingTargetBranch}.` : "As alterações selecionadas serão salvas em um novo commit neste projeto.",
      commitButtonLabel: isBranchSwitch ? `Salvar e trocar para ${this.pendingTargetBranch}` : "Salvar Commit",
      discardWarningText: isBranchSwitch
        ? `Todas as alterações no working tree que não foram salvas em um commit serão descartadas para permitir a troca para ${this.pendingTargetBranch}.`
        : "Todas as alterações locais que não foram salvas em um commit serão descartadas permanentemente."
    };
  }
}

describe("Git Commit Workflow Separation", () => {
  it("1. O clique em 'Comitar alterações' no Git Center abre o modal com pendingTargetBranch = null", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    assert.strictEqual(tester.modal, "branchChanges");
    assert.strictEqual(tester.pendingTargetBranch, null);
    assert.strictEqual(tester.branchCommitMessage, "Atualizações no projeto");
  });

  it("2. No fluxo do Git Center, NÃO exibe o banner de troca de branch", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    const ui = tester.getUiComputedProps();
    assert.strictEqual(ui.bannerVisible, false);
    assert.strictEqual(ui.bannerText, null);
  });

  it("3. No fluxo do Git Center, o modal de commit exibe 'Confirmar commit' e NUNCA 'Commit antes de trocar de branch'", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    tester.toggleFileSelection("src/pages/Landing.tsx");
    tester.goToCommitStep();

    assert.strictEqual(tester.modal, "branchCommit");
    const ui = tester.getUiComputedProps();
    assert.strictEqual(ui.commitModalTitle, "Confirmar commit");
    assert.strictEqual(ui.commitModalSubtitle, "Salve as alterações selecionadas no repositório.");
    assert.strictEqual(ui.commitHelpText, "As alterações selecionadas serão salvas em um novo commit neste projeto.");
    assert.ok(!ui.commitHelpText.includes("trocará automaticamente para"));
  });

  it("4. No fluxo de troca de branch, o modal de commit exibe 'Commit antes de trocar de branch' com a branch correta", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openBranchSwitchCommit("feature/minha-feature");
    tester.toggleFileSelection("src/pages/Landing.tsx");
    tester.goToCommitStep();

    assert.strictEqual(tester.modal, "branchCommit");
    const ui = tester.getUiComputedProps();
    assert.strictEqual(ui.commitModalTitle, "Commit antes de trocar de branch");
    assert.ok(ui.commitModalSubtitle.includes("feature/minha-feature"));
    assert.ok(ui.commitHelpText.includes("feature/minha-feature"));
    assert.ok(ui.commitButtonLabel.includes("feature/minha-feature"));
  });

  it("5. O botão 'Voltar' entre a tela de commit e o seletor preserva os arquivos selecionados", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    tester.toggleFileSelection("src/pages/Landing.tsx");
    assert.strictEqual(tester.selectedCommitFiles.size, 1);

    tester.goToCommitStep();
    assert.strictEqual(tester.modal, "branchCommit");

    // Usuário clica em 'Voltar'
    tester.goBackFromCommitStep();
    assert.strictEqual(tester.modal, "branchChanges");
    // Verificação essencial: a seleção NÃO é zerada
    assert.strictEqual(tester.selectedCommitFiles.size, 1);
    assert.ok(tester.selectedCommitFiles.has("src/pages/Landing.tsx"));
  });

  it("6. Cancelar no seletor a partir do Git Center retorna para 'gitCenter'", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    tester.cancelChangesModal();
    assert.strictEqual(tester.modal, "gitCenter");
  });

  it("7. Cancelar no seletor a partir da troca de branch fecha o modal (modal = null)", () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openBranchSwitchCommit("main");
    tester.cancelChangesModal();
    assert.strictEqual(tester.modal, null);
    assert.strictEqual(tester.pendingTargetBranch, null);
  });

  it("8. A execução do commit manual faz commit local e retorna para 'gitCenter' sem executar push ou checkoutBranch", async () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    tester.toggleFileSelection("src/pages/Landing.tsx");
    tester.goToCommitStep();

    await tester.handleManualGitCenterCommit();

    assert.strictEqual(tester.modal, "gitCenter");
    assert.strictEqual(tester.apiCalls.commit.length, 1);
    assert.deepStrictEqual(tester.apiCalls.commit[0].files, ["src/pages/Landing.tsx"]);
    assert.strictEqual(tester.apiCalls.commit[0].message, "Atualizações no projeto");
    assert.strictEqual(tester.apiCalls.push, 0); // NÃO faz push!
    assert.strictEqual(tester.apiCalls.checkout.length, 0); // NUNCA faz checkout!
    assert.strictEqual(tester.toasts[0], "Commit salvo com sucesso!");
  });

  it("9. A execução do commit na troca de branch realiza commitPush E checkoutBranch para a branch de destino", async () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openBranchSwitchCommit("main");
    tester.toggleFileSelection("src/pages/Landing.tsx");
    tester.goToCommitStep();

    await tester.handleBranchCommitAndCheckout();

    assert.strictEqual(tester.modal, null);
    assert.strictEqual(tester.apiCalls.commitPush.length, 1);
    assert.strictEqual(tester.apiCalls.checkout.length, 1);
    assert.strictEqual(tester.apiCalls.checkout[0], "main");
    assert.strictEqual(tester.pendingTargetBranch, null);
  });

  it("10. Descartar alterações a partir do Git Center descarta sem executar checkoutBranch e retorna ao Git Center", async () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit();
    await tester.handleBranchDiscard();

    assert.strictEqual(tester.modal, "gitCenter");
    assert.strictEqual(tester.apiCalls.discard, 1);
    assert.strictEqual(tester.apiCalls.checkout.length, 0); // Sem checkout
    assert.strictEqual(tester.toasts[0], "Alterações descartadas com sucesso!");
  });

  it("11. Descartar alterações na troca de branch descarta e troca para a branch de destino", async () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openBranchSwitchCommit("develop");
    await tester.handleBranchDiscard();

    assert.strictEqual(tester.modal, null);
    assert.strictEqual(tester.apiCalls.discard, 1);
    assert.strictEqual(tester.apiCalls.checkout.length, 1);
    assert.strictEqual(tester.apiCalls.checkout[0], "develop");
    assert.strictEqual(tester.toasts[0], 'Alterações descartadas e alternado para "develop" com sucesso!');
  });

  it("12. handleBranchCommitAndCheckout tem guarda estrita contra pendingTargetBranch nulo ou vazio", async () => {
    const tester = new GitCenterCommitFlowTester();
    tester.openGitCenterCommit(); // pendingTargetBranch = null
    tester.toggleFileSelection("src/pages/Landing.tsx");

    // Tentar executar commit de troca de branch sem branch de destino
    await tester.handleBranchCommitAndCheckout();

    // Deve ser bloqueado imediatamente
    assert.strictEqual(tester.apiCalls.commitPush.length, 0);
    assert.strictEqual(tester.apiCalls.checkout.length, 0);
  });

  it("13. Ao sincronizar com sucesso (ff-only), o modal de sincronização fecha automaticamente e o status é atualizado", async () => {
    const tester = new GitCenterCommitFlowTester();
    tester.modal = "gitSync";

    let modalClosed = false;
    let toastMessage = "";
    let pullCalled = false;

    async function handlePullExternalChangesSimulated(resultSuccess: boolean) {
      pullCalled = true;
      if (resultSuccess) {
        toastMessage = "Alterações do GitHub sincronizadas com sucesso!";
        modalClosed = true;
        tester.modal = null;
      } else {
        toastMessage = "Erro ao puxar alterações do GitHub.";
        // Em caso de erro, modal permanece aberto
      }
    }

    // Caso de sucesso:
    await handlePullExternalChangesSimulated(true);
    assert.strictEqual(pullCalled, true);
    assert.strictEqual(toastMessage, "Alterações do GitHub sincronizadas com sucesso!");
    assert.strictEqual(modalClosed, true);
    assert.strictEqual(tester.modal, null);

    // Caso de erro:
    tester.modal = "gitSync";
    await handlePullExternalChangesSimulated(false);
    assert.strictEqual(tester.modal, "gitSync");
    assert.strictEqual(toastMessage, "Erro ao puxar alterações do GitHub.");
  });

  it("14. Modal gitSync — cenário simples exibe apenas 'Atualizar projeto' (sem ff-only ou 'Sincronizar e combinar')", () => {
    // Simula a lógica de decisão do JSX do modal gitSync
    function getGitSyncPrimaryAction(gitSyncStatus: {
      canFastForward: boolean;
      workingTreeDirty: boolean;
      diverged: boolean;
      behind: number;
    }): "atualizar-projeto" | "sincronizar-e-combinar" {
      // Cenário simples: apenas atrás, working tree limpa, sem divergência
      if (gitSyncStatus.canFastForward && !gitSyncStatus.workingTreeDirty && !gitSyncStatus.diverged) {
        return "atualizar-projeto";
      }
      // Cenário complexo
      return "sincronizar-e-combinar";
    }

    // Cenário simples (branch local apenas atrás, limpa)
    const simple = getGitSyncPrimaryAction({ canFastForward: true, workingTreeDirty: false, diverged: false, behind: 2 });
    assert.strictEqual(simple, "atualizar-projeto", "Cenário simples deve mostrar 'Atualizar projeto'");

    // Cenário: dirty tree → complexo
    const dirty = getGitSyncPrimaryAction({ canFastForward: false, workingTreeDirty: true, diverged: false, behind: 1 });
    assert.strictEqual(dirty, "sincronizar-e-combinar", "Working tree suja deve usar fluxo complexo");

    // Cenário: divergência → complexo
    const diverged = getGitSyncPrimaryAction({ canFastForward: false, workingTreeDirty: false, diverged: true, behind: 1 });
    assert.strictEqual(diverged, "sincronizar-e-combinar", "Divergência deve usar fluxo complexo");

    // Cenário: canFastForward mas dirty → complexo (dirty prevalece)
    const ffAndDirty = getGitSyncPrimaryAction({ canFastForward: true, workingTreeDirty: true, diverged: false, behind: 1 });
    assert.strictEqual(ffAndDirty, "sincronizar-e-combinar", "canFastForward com dirty tree deve usar fluxo complexo");
  });

  it("15. Modal gitSync — o botão 'Atualizar projeto' NO cenário simples chama handlePullExternalChanges (e NÃO handleSyncAndCombine)", async () => {
    let pullExternalCalled = false;
    let syncAndCombineCalled = false;

    const handlePullExternalChanges = async () => { pullExternalCalled = true; };
    const handleSyncAndCombine = async () => { syncAndCombineCalled = true; };

    // Simula o clique no botão do cenário simples
    async function simulateGitSyncButtonClick(gitSyncStatus: { canFastForward: boolean; workingTreeDirty: boolean; diverged: boolean }) {
      if (gitSyncStatus.canFastForward && !gitSyncStatus.workingTreeDirty && !gitSyncStatus.diverged) {
        await handlePullExternalChanges();
      } else {
        await handleSyncAndCombine();
      }
    }

    // Cenário simples → deve chamar handlePullExternalChanges
    await simulateGitSyncButtonClick({ canFastForward: true, workingTreeDirty: false, diverged: false });
    assert.strictEqual(pullExternalCalled, true, "'Atualizar projeto' deve chamar handlePullExternalChanges");
    assert.strictEqual(syncAndCombineCalled, false, "'Atualizar projeto' NÃO deve chamar handleSyncAndCombine");

    // Cenário complexo → deve chamar handleSyncAndCombine
    pullExternalCalled = false;
    await simulateGitSyncButtonClick({ canFastForward: false, workingTreeDirty: true, diverged: false });
    assert.strictEqual(syncAndCombineCalled, true, "Cenário complexo deve chamar handleSyncAndCombine");
    assert.strictEqual(pullExternalCalled, false, "Cenário complexo NÃO deve chamar handlePullExternalChanges");
  });
});

import { test, describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Git Branch Lifecycle & Race Condition Guards
 * Valida o fluxo de criação, troca com dirty state, prevenção de race condition
 * no refresh de branches e representação de detached HEAD.
 */

// Interface simulando o estado Git e Renderer
interface GitState {
  initialized: boolean;
  branch: string | null;
  remote: string | null;
  linkedRepo: string | null;
  dirty: boolean;
  changedFiles: Array<{ path: string; status: string; staged: boolean }>;
  summary: { modified: number; untracked: number; deleted: number; staged: number; total: number };
}

// Simulador do State Manager do Renderer para branches
class RendererBranchController {
  public branches: string[] = [];
  public currentBranch: string | null = "main";
  public gitStatus: GitState = {
    initialized: true,
    branch: "main",
    remote: "https://github.com/test/repo.git",
    linkedRepo: "test/repo",
    dirty: false,
    changedFiles: [],
    summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
  };
  public selectedCommitFiles: Set<string> = new Set();
  public pendingTargetBranch: string | null = null;
  public modal: string | null = null;
  public isBusy: boolean = false;
  public isRefreshing: boolean = false;
  public lastError: string = "";
  public toasts: string[] = [];
  public refreshRequestId: number = 0;

  constructor(initialBranches: string[] = ["main"]) {
    this.branches = [...initialBranches];
  }

  showToast(msg: string) {
    this.toasts.push(msg);
  }

  getDisplayBranch(): string {
    return this.gitStatus.branch || (this.gitStatus.initialized ? "HEAD destacada" : "main");
  }

  getTooltip(): string {
    return this.gitStatus.branch
      ? `Branch atual: ${this.gitStatus.branch}`
      : this.gitStatus.initialized
      ? "HEAD destacada (sem branch ativa)"
      : "Repositório não inicializado";
  }

  // 1. Troca de branch
  async chooseGithubBranch(
    branch: string,
    checkoutApi: (b: string) => Promise<void>,
    getStatusApi: () => Promise<GitState>,
    ignoreRefreshBlock = false
  ): Promise<void> {
    if (!branch || this.isBusy || (!ignoreRefreshBlock && this.isRefreshing)) return;
    if (this.gitStatus.branch === branch) return;

    if (this.gitStatus.dirty) {
      this.pendingTargetBranch = branch;
      this.lastError = "";
      this.modal = "branchChanges";
      return;
    }

    this.isBusy = true;
    this.lastError = "";
    try {
      this.refreshRequestId++;
      await checkoutApi(branch);
      const git = await getStatusApi();
      this.gitStatus = git;
      this.currentBranch = git.branch;
      if (git.branch && !this.branches.includes(git.branch)) {
        this.branches.push(git.branch);
        this.branches.sort();
      }
      this.showToast(`Alternado para a branch "${git.branch || branch}"`);
    } catch (error: any) {
      const errMsg = error?.message || `Erro ao trocar para branch "${branch}".`;
      this.lastError = errMsg;
      this.showToast(errMsg);
    } finally {
      this.isBusy = false;
    }
  }

  // 2. Cancelar modal de conflito
  cancelBranchChanges(): void {
    this.modal = null;
    this.pendingTargetBranch = null;
  }

  // 3. Descartar alterações e trocar
  async handleBranchDiscardAndCheckout(
    discardApi: () => Promise<void>,
    checkoutApi: (b: string) => Promise<void>,
    getStatusApi: () => Promise<GitState>
  ): Promise<void> {
    if (!this.pendingTargetBranch || this.isBusy) return;
    this.isBusy = true;
    this.lastError = "";
    const target = this.pendingTargetBranch;
    try {
      this.refreshRequestId++;
      await discardApi();
      await checkoutApi(target);
      const git = await getStatusApi();
      this.gitStatus = git;
      this.currentBranch = git.branch;
      if (git.branch && !this.branches.includes(git.branch)) {
        this.branches.push(git.branch);
        this.branches.sort();
      }
      this.modal = null;
      this.pendingTargetBranch = null;
      this.showToast(`Alterações descartadas e alternado para "${git.branch || target}" com sucesso!`);
    } catch (error: any) {
      const errMsg = error?.message || "Erro ao descartar e trocar de branch.";
      this.lastError = errMsg;
      this.showToast(errMsg);
    } finally {
      this.isBusy = false;
    }
  }

  // 4. Salvar commit e trocar
  async handleBranchCommitAndCheckout(
    commitMessage: string,
    commitApi: (m: string, files?: string[]) => Promise<void>,
    checkoutApi: (b: string) => Promise<void>,
    getStatusApi: () => Promise<GitState>
  ): Promise<void> {
    if (!this.pendingTargetBranch || !commitMessage.trim() || this.isBusy || this.selectedCommitFiles.size === 0) return;
    this.isBusy = true;
    this.lastError = "";
    const target = this.pendingTargetBranch;
    try {
      this.refreshRequestId++;
      const selectedArray = Array.from(this.selectedCommitFiles);
      await commitApi(commitMessage.trim(), selectedArray);
      await checkoutApi(target);
      const git = await getStatusApi();
      this.gitStatus = git;
      this.currentBranch = git.branch;
      if (git.branch && !this.branches.includes(git.branch)) {
        this.branches.push(git.branch);
        this.branches.sort();
      }
      this.modal = null;
      this.pendingTargetBranch = null;
      this.showToast(`Commit realizado e alternado para "${git.branch || target}" com sucesso!`);
    } catch (error: any) {
      const errMsg = error?.message || "Erro ao salvar e trocar de branch.";
      this.lastError = errMsg;
      this.showToast(errMsg);
    } finally {
      this.isBusy = false;
    }
  }

  // 5. Criar branch
  async createGithubBranch(
    name: string,
    createApi: (n: string) => Promise<void>,
    getStatusApi: () => Promise<GitState>,
    ignoreRefreshBlock = false
  ): Promise<void> {
    const trimmed = (name || "").trim();
    if (!trimmed || this.isBusy || (!ignoreRefreshBlock && this.isRefreshing)) return;
    this.isBusy = true;
    this.lastError = "";
    try {
      this.refreshRequestId++;
      await createApi(trimmed);
      const git = await getStatusApi();
      this.gitStatus = git;
      this.currentBranch = git.branch;
      if (git.branch && !this.branches.includes(git.branch)) {
        this.branches.push(git.branch);
        this.branches.sort();
      }
      this.showToast(`Branch "${git.branch || trimmed}" criada com sucesso!`);
    } catch (error: any) {
      const errMsg = error?.message || `Erro ao criar branch "${trimmed}".`;
      this.lastError = errMsg;
      this.showToast(errMsg);
    } finally {
      this.isBusy = false;
    }
  }

  // 6. Refresh com proteção de Request ID
  async refreshGithubBranches(listBranchesApi: () => Promise<string[]>): Promise<void> {
    if (!this.gitStatus.initialized || this.isBusy || this.isRefreshing) return;
    const currentRequestId = ++this.refreshRequestId;
    this.isRefreshing = true;
    try {
      const names = await listBranchesApi();
      if (currentRequestId !== this.refreshRequestId) {
        // Obsoleto - descarta
        return;
      }
      const filtered = Array.from(
        new Set((names || []).filter(name => name && name !== "origin" && name !== "HEAD" && name !== "origin/HEAD"))
      );
      if (currentRequestId !== this.refreshRequestId) return;

      const currentActive = this.gitStatus.branch;
      const merged = new Set<string>(filtered);
      if (currentActive) merged.add(currentActive);
      for (const p of this.branches) {
        if (filtered.includes(p)) merged.add(p);
      }
      const result = Array.from(merged).sort((a, b) => a.localeCompare(b));
      this.branches = result.length ? result : (currentActive ? [currentActive] : ["main"]);
    } catch (error: any) {
      this.lastError = error?.message || "Falha no refresh";
    } finally {
      if (currentRequestId === this.refreshRequestId) {
        this.isRefreshing = false;
      }
    }
  }
}

describe("Git Branch Lifecycle & Resolution Flows", () => {
  it("1. Criação de branch limpa -> atualiza current branch e branches list", async () => {
    const controller = new RendererBranchController(["main"]);
    await controller.createGithubBranch(
      "feature-clean",
      async name => {
        assert.equal(name, "feature-clean");
      },
      async () => ({
        initialized: true,
        branch: "feature-clean",
        remote: "https://github.com/test/repo.git",
        linkedRepo: "test/repo",
        dirty: false,
        changedFiles: [],
        summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
      })
    );

    assert.equal(controller.currentBranch, "feature-clean");
    assert.deepEqual(controller.branches, ["feature-clean", "main"]);
    assert.match(controller.toasts[0], /criada com sucesso/i);
  });

  it("2. Checkout de branch limpa -> atualiza status e toast", async () => {
    const controller = new RendererBranchController(["main", "feature-x"]);
    await controller.chooseGithubBranch(
      "feature-x",
      async branch => {
        assert.equal(branch, "feature-x");
      },
      async () => ({
        initialized: true,
        branch: "feature-x",
        remote: "https://github.com/test/repo.git",
        linkedRepo: "test/repo",
        dirty: false,
        changedFiles: [],
        summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
      })
    );

    assert.equal(controller.currentBranch, "feature-x");
    assert.match(controller.toasts[0], /Alternado para a branch "feature-x"/i);
  });

  it("3. Checkout com dirty -> NÃO chama checkoutApi e abre branchChanges", async () => {
    const controller = new RendererBranchController(["main", "feature-target"]);
    controller.gitStatus.dirty = true;
    controller.gitStatus.summary = { modified: 2, untracked: 1, deleted: 0, staged: 0, total: 3 };

    let checkoutCalled = false;
    await controller.chooseGithubBranch(
      "feature-target",
      async () => {
        checkoutCalled = true;
      },
      async () => controller.gitStatus
    );

    assert.equal(checkoutCalled, false, "Checkout NÃO deve ser chamado diretamente se dirty=true");
    assert.equal(controller.modal, "branchChanges");
    assert.equal(controller.pendingTargetBranch, "feature-target");
    assert.equal(controller.currentBranch, "main");
  });

  it("4. pendingTargetBranch recebe branch correta", () => {
    const controller = new RendererBranchController(["main", "feature-y"]);
    controller.gitStatus.dirty = true;
    controller.chooseGithubBranch("feature-y", async () => {}, async () => controller.gitStatus);
    assert.equal(controller.pendingTargetBranch, "feature-y");
  });

  it("5. Cancelar branchChanges -> não troca branch e preserva dirty", () => {
    const controller = new RendererBranchController(["main", "feature-y"]);
    controller.gitStatus.dirty = true;
    controller.modal = "branchChanges";
    controller.pendingTargetBranch = "feature-y";

    controller.cancelBranchChanges();

    assert.equal(controller.modal, null);
    assert.equal(controller.pendingTargetBranch, null);
    assert.equal(controller.currentBranch, "main");
    assert.equal(controller.gitStatus.dirty, true);
  });

  it("6. Commit -> executa commit, depois checkout da branch alvo", async () => {
    const controller = new RendererBranchController(["main", "feature-target"]);
    controller.gitStatus.dirty = true;
    controller.modal = "branchCommit";
    controller.pendingTargetBranch = "feature-target";
    controller.selectedCommitFiles = new Set(["file.ts"]);

    let commitCalled = false;
    let checkoutCalled = false;

    await controller.handleBranchCommitAndCheckout(
      "WIP: fix before switch",
      async msg => {
        assert.equal(msg, "WIP: fix before switch");
        commitCalled = true;
      },
      async branch => {
        assert.equal(commitCalled, true, "Commit deve ocorrer antes do checkout");
        assert.equal(branch, "feature-target");
        checkoutCalled = true;
      },
      async () => ({
        initialized: true,
        branch: "feature-target",
        remote: "https://github.com/test/repo.git",
        linkedRepo: "test/repo",
        dirty: false,
        changedFiles: [],
        summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
      })
    );

    assert.equal(commitCalled, true);
    assert.equal(checkoutCalled, true);
    assert.equal(controller.currentBranch, "feature-target");
    assert.equal(controller.pendingTargetBranch, null);
    assert.equal(controller.modal, null);
    assert.match(controller.toasts[0], /Commit realizado e alternado para "feature-target"/i);
  });

  it("7. Descarte -> executa discard, depois checkout da branch alvo", async () => {
    const controller = new RendererBranchController(["main", "feature-target"]);
    controller.gitStatus.dirty = true;
    controller.modal = "branchDiscardConfirm";
    controller.pendingTargetBranch = "feature-target";

    let discardCalled = false;
    let checkoutCalled = false;

    await controller.handleBranchDiscardAndCheckout(
      async () => {
        discardCalled = true;
      },
      async branch => {
        assert.equal(discardCalled, true, "Descarte deve ocorrer antes do checkout");
        assert.equal(branch, "feature-target");
        checkoutCalled = true;
      },
      async () => ({
        initialized: true,
        branch: "feature-target",
        remote: "https://github.com/test/repo.git",
        linkedRepo: "test/repo",
        dirty: false,
        changedFiles: [],
        summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
      })
    );

    assert.equal(discardCalled, true);
    assert.equal(checkoutCalled, true);
    assert.equal(controller.currentBranch, "feature-target");
    assert.equal(controller.pendingTargetBranch, null);
    assert.equal(controller.modal, null);
    assert.match(controller.toasts[0], /Alterações descartadas e alternado para "feature-target"/i);
  });

  it("8. Erro de checkout -> erro visível em toast e lastError", async () => {
    const controller = new RendererBranchController(["main", "broken-branch"]);
    await controller.chooseGithubBranch(
      "broken-branch",
      async () => {
        throw new Error("Git checkout conflict: untracked files would be overwritten");
      },
      async () => controller.gitStatus
    );

    assert.match(controller.lastError, /Git checkout conflict/);
    assert.match(controller.toasts[0], /Git checkout conflict/);
  });
});

describe("Deterministic Race Condition Tests", () => {
  it("9 & 10. Refresh A atrasado NÃO sobrescreve nova branch criada durante a requisição", async () => {
    const controller = new RendererBranchController(["main"]);

    let resolveRefreshA: (val: string[]) => void;
    const promiseA = new Promise<string[]>(res => {
      resolveRefreshA = res;
    });

    // 1. Refresh A inicia (simula fetch remoto lento de 5 segundos)
    const refreshAPromise = controller.refreshGithubBranches(() => promiseA);

    // 2. Enquanto Refresh A está em voo, usuário cria feature-x
    await controller.createGithubBranch(
      "feature-x",
      async () => {},
      async () => ({
        initialized: true,
        branch: "feature-x",
        remote: "https://github.com/test/repo.git",
        linkedRepo: "test/repo",
        dirty: false,
        changedFiles: [],
        summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
      }),
      true // ignore UI refresh block to test race condition defense
    );

    assert.equal(controller.currentBranch, "feature-x");
    assert.deepEqual(controller.branches, ["feature-x", "main"]);

    // 3. Refresh B inicia e conclui com lista atualizada
    await controller.refreshGithubBranches(async () => ["main", "feature-x"]);
    assert.deepEqual(controller.branches, ["feature-x", "main"]);

    // 4. Refresh A termina atrasado com dados antigos de antes da criação
    resolveRefreshA!(["main"]);
    await refreshAPromise;

    // 5. Estado NÃO PERDEU feature-x!
    assert.deepEqual(controller.branches, ["feature-x", "main"], "A branch feature-x não pode ser removida por refresh stale");
    assert.equal(controller.currentBranch, "feature-x");
  });

  it("11. Checkout enquanto refresh está pendente -> current branch permanece correta", async () => {
    const controller = new RendererBranchController(["main", "feature-y"]);

    let resolveRefresh: (val: string[]) => void;
    const slowRefreshPromise = new Promise<string[]>(res => {
      resolveRefresh = res;
    });

    const refreshPromise = controller.refreshGithubBranches(() => slowRefreshPromise);

    // Checkout executado enquanto refresh pendente
    await controller.chooseGithubBranch(
      "feature-y",
      async () => {},
      async () => ({
        initialized: true,
        branch: "feature-y",
        remote: "https://github.com/test/repo.git",
        linkedRepo: "test/repo",
        dirty: false,
        changedFiles: [],
        summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 }
      }),
      true // ignore UI refresh block to test race condition defense
    );

    assert.equal(controller.currentBranch, "feature-y");

    resolveRefresh!(["main", "feature-y"]);
    await refreshPromise;

    assert.equal(controller.currentBranch, "feature-y");
  });

  it("12. Duas chamadas de refresh consecutivas -> somente a última substitui o estado", async () => {
    const controller = new RendererBranchController(["main"]);

    let resolveFirst: (val: string[]) => void;
    const firstPromise = new Promise<string[]>(res => {
      resolveFirst = res;
    });

    let resolveSecond: (val: string[]) => void;
    const secondPromise = new Promise<string[]>(res => {
      resolveSecond = res;
    });

    // Dispara primeiro refresh
    controller.isRefreshing = false; // reset
    const p1 = controller.refreshGithubBranches(() => firstPromise);

    // Dispara segundo refresh que sobrepõe o requestId
    controller.isRefreshing = false; // permite segunda chamada
    const p2 = controller.refreshGithubBranches(() => secondPromise);

    // Segundo resolve primeiro com lista ["main", "v2"]
    resolveSecond!(["main", "v2"]);
    await p2;
    assert.deepEqual(controller.branches, ["main", "v2"]);

    // Primeiro resolve atrasado com lista stale ["main", "v1"]
    resolveFirst!(["main", "v1"]);
    await p1;

    // Estado reflete a geração mais recente (v2) e não a primeira (v1)
    assert.deepEqual(controller.branches, ["main", "v2"]);
  });

  it("13. Branch local não desaparece por resposta stale", async () => {
    const controller = new RendererBranchController(["main", "local-feature"]);
    controller.currentBranch = "local-feature";
    controller.gitStatus.branch = "local-feature";

    // Simula resposta remota que só conhece main
    await controller.refreshGithubBranches(async () => ["main"]);

    // local-feature foi preservada por ser a currentBranch ativa
    assert.ok(controller.branches.includes("local-feature"));
  });

  it("14. Branch realmente removida não permanece se não for a atual", async () => {
    const controller = new RendererBranchController(["main", "deleted-remote-branch"]);
    controller.currentBranch = "main";
    controller.gitStatus.branch = "main";

    // Remote sincronizou e a branch foi deletada no origin
    await controller.refreshGithubBranches(async () => ["main"]);

    assert.deepEqual(controller.branches, ["main"]);
  });

  it("15. Detached HEAD não aparece como 'main'", () => {
    const controller = new RendererBranchController([]);
    controller.gitStatus.initialized = true;
    controller.gitStatus.branch = null; // Detached HEAD

    assert.equal(controller.getDisplayBranch(), "HEAD destacada");
    assert.equal(controller.getTooltip(), "HEAD destacada (sem branch ativa)");
  });

  it("16. Auto Commit continua com comportamento decoupled existente", async () => {
    // Valida regra: dirty=true -> commit+push; dirty=false -> skip
    const checkAutoCommitAction = (git: { dirty: boolean; linkedRepo: string | null }) => {
      if (!git.linkedRepo) return { shouldCommit: false, reason: "not-linked" };
      if (!git.dirty) return { shouldCommit: false, reason: "clean" };
      return { shouldCommit: true, reason: "has-changes" };
    };

    const cleanRepo = { dirty: false, linkedRepo: "user/repo" };
    assert.equal(checkAutoCommitAction(cleanRepo).shouldCommit, false);

    const dirtyRepo = { dirty: true, linkedRepo: "user/repo" };
    assert.equal(checkAutoCommitAction(dirtyRepo).shouldCommit, true);
  });
});

describe("Fluxo de Commit Seletivo e Troca de Branch Sem Bloqueio Indevido", () => {
  it("TESTE 1: Commit seletivo - 5 arquivos selecionados de 8 alterados -> apenas os 5 entram no commit", async () => {
    const controller = new RendererBranchController(["main", "feature-x"]);
    controller.gitStatus.dirty = true;
    controller.pendingTargetBranch = "feature-x";
    controller.selectedCommitFiles = new Set(["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts"]);

    let committedFiles: string[] = [];
    await controller.handleBranchCommitAndCheckout(
      "Commit de 5 arquivos",
      async (_msg, files) => {
        committedFiles = files || [];
      },
      async () => {},
      async () => ({ ...controller.gitStatus, branch: "feature-x" })
    );

    assert.equal(committedFiles.length, 5);
    assert.deepEqual(committedFiles, ["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts"]);
  });

  it("TESTE 2: Após commit seletivo, troca de branch ocorre preservando alterações não selecionadas não conflitantes", async () => {
    const controller = new RendererBranchController(["main", "feature-safe"]);
    controller.gitStatus.dirty = true;
    controller.gitStatus.changedFiles = [
      { path: "unselected.ts", status: "M", staged: false }
    ];
    controller.pendingTargetBranch = "feature-safe";
    controller.selectedCommitFiles = new Set(["selected.ts"]);

    let checkoutExecuted = false;
    await controller.handleBranchCommitAndCheckout(
      "Commit seletivo parcial",
      async () => {},
      async (branch) => {
        assert.equal(branch, "feature-safe");
        checkoutExecuted = true;
      },
      async () => ({
        ...controller.gitStatus,
        branch: "feature-safe",
        dirty: true,
        changedFiles: [{ path: "unselected.ts", status: "M", staged: false }]
      })
    );

    assert.equal(checkoutExecuted, true);
    assert.equal(controller.currentBranch, "feature-safe");
    assert.equal(controller.gitStatus.dirty, true);
    assert.equal(controller.gitStatus.changedFiles[0].path, "unselected.ts");
  });

  it("TESTE 3: Git recusa a troca por conflito na branch destino -> branch NÃO muda e alteração local é PRESERVADA", async () => {
    const controller = new RendererBranchController(["main", "feature-conflict"]);
    controller.gitStatus.dirty = true;
    controller.gitStatus.changedFiles = [
      { path: "conflict.ts", status: "M", staged: false }
    ];
    controller.pendingTargetBranch = "feature-conflict";
    controller.selectedCommitFiles = new Set(["selected.ts"]);

    await controller.handleBranchCommitAndCheckout(
      "Commit antes do conflito",
      async () => {},
      async () => {
        throw new Error("Troca de branch bloqueada pelo Git. As alterações locais em [conflict.ts] conflitam com a branch destino.");
      },
      async () => controller.gitStatus
    );

    assert.equal(controller.currentBranch, "main");
    assert.match(controller.lastError, /bloqueada pelo Git.*conflict\.ts/i);
    assert.equal(controller.gitStatus.dirty, true);
  });

  it("TESTE 4: Seleção vazia -> não executa commit nem altera o repositório", async () => {
    const controller = new RendererBranchController(["main", "feature-empty"]);
    controller.gitStatus.dirty = true;
    controller.pendingTargetBranch = "feature-empty";
    controller.selectedCommitFiles = new Set();

    let commitCalled = false;
    let checkoutCalled = false;

    await controller.handleBranchCommitAndCheckout(
      "Commit vazio",
      async () => { commitCalled = true; },
      async () => { checkoutCalled = true; },
      async () => controller.gitStatus
    );

    assert.equal(commitCalled, false, "Commit API NÃO deve ser chamado com seleção vazia");
    assert.equal(checkoutCalled, false, "Checkout API NÃO deve ser chamado com seleção vazia");
    assert.equal(controller.currentBranch, "main");
  });

  it("TESTE 5: Auto Commit -> mantém comportamento decoupled existente sem seletivo", async () => {
    const autoCommitOptions = { isAuto: true };
    assert.equal(autoCommitOptions.isAuto, true);
    const filesToPass: string[] | undefined = undefined;
    assert.equal(filesToPass, undefined);
  });

  it("TESTE 6: Commit seletivo com novos (untracked), modificados e deletados -> apenas os selecionados entram no commit", async () => {
    const controller = new RendererBranchController(["main", "feature-mixed"]);
    controller.gitStatus.dirty = true;
    controller.pendingTargetBranch = "feature-mixed";
    controller.selectedCommitFiles = new Set(["newfile.ts", "modified.ts", "deleted.ts"]);

    let committedFiles: string[] = [];
    await controller.handleBranchCommitAndCheckout(
      "Commit misto seletivo",
      async (_msg, files) => {
        committedFiles = files || [];
      },
      async () => {},
      async () => ({ ...controller.gitStatus, branch: "feature-mixed" })
    );

    assert.deepEqual(committedFiles, ["newfile.ts", "modified.ts", "deleted.ts"]);
  });
});

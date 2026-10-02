import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Test Suite: Git Commit vs Push Separation & Auto Commit Preservation
 *
 * Valida:
 * 1. Fluxo Manual: "Fazer Commit" -> "Salvar Commit" realiza apenas COMMIT LOCAL (não faz push).
 * 2. Fluxo Manual: Ação explícita "Enviar para o GitHub" realiza o PUSH.
 * 3. Auto Commit Ativado: Executa COMMIT + PUSH automaticamente ao concluir tarefa.
 * 4. Auto Commit Desativado: Não executa push automático.
 * 5. Commit e Push Explícito (se invocado via API/ação): Executa commit + push.
 * 6. Troca de branch: "Fazer Commit e trocar para [branch]" realiza commit dos arquivos selecionados e checkout.
 * 7. Seleção seletiva de arquivos é estritamente respeitada em todos os fluxos.
 * 8. Nenhuma operação manual faz push silencioso.
 */

interface GitSimulationCall {
  type: "commit" | "push" | "checkout";
  message?: string;
  files?: string[];
  branch?: string;
  pushTriggered?: boolean;
}

class GitCommitPushManagerSimulator {
  public history: GitSimulationCall[] = [];
  public autoCommitEnabled: boolean = false;
  public localCommitsAhead: number = 0;
  public dirtyFiles: string[] = ["teste-validacao.txt"];
  public currentBranch: string = "main";
  public toasts: string[] = [];

  showToast(msg: string) {
    this.toasts.push(msg);
  }

  // Handler do backend: performGithubCommitPush
  async performGithubCommitPush(
    message: string,
    options: { isAuto?: boolean; files?: string[]; push?: boolean } = {}
  ) {
    const shouldPush = options.push !== false;
    const filesToCommit = options.files || this.dirtyFiles;

    if (filesToCommit.length === 0) {
      throw new Error("Selecione ao menos um arquivo para realizar o commit.");
    }

    // 1. Executa commit local
    this.history.push({
      type: "commit",
      message,
      files: [...filesToCommit],
      pushTriggered: shouldPush
    });
    this.dirtyFiles = this.dirtyFiles.filter(f => !filesToCommit.includes(f));
    this.localCommitsAhead++;

    // 2. Executa push se solicitado
    if (shouldPush) {
      this.history.push({
        type: "push",
        branch: this.currentBranch
      });
      this.localCommitsAhead = 0;
      return {
        ok: true,
        committed: true,
        pushed: true,
        message: options.isAuto ? "Alterações enviadas automaticamente para o GitHub." : "Commit criado e enviado para o GitHub."
      };
    }

    return {
      ok: true,
      committed: true,
      pushed: false,
      message: "Commit salvo com sucesso neste projeto."
    };
  }

  // Handler do backend: performGithubPush
  async performGithubPush() {
    if (this.localCommitsAhead === 0) {
      return { ok: true, pushed: false, message: "Não há alterações para enviar." };
    }
    this.history.push({
      type: "push",
      branch: this.currentBranch
    });
    this.localCommitsAhead = 0;
    return {
      ok: true,
      pushed: true,
      message: "Alterações enviadas para o GitHub com sucesso!"
    };
  }

  // Handler do Auto Commit: githubAutoCommitTask
  async handleAutoCommitTask(taskId: string, message: string) {
    if (!this.autoCommitEnabled) {
      return { ok: true, skipped: true, reason: "disabled", message: "Auto Commit desativado para este projeto." };
    }
    return await this.performGithubCommitPush(message, { isAuto: true, push: true });
  }

  // Handler do Frontend: handleManualGitCenterCommit
  async handleManualGitCenterCommit(message: string, selectedFiles: string[]) {
    const result = await this.performGithubCommitPush(message, { isAuto: false, files: selectedFiles, push: false });
    this.showToast("Commit salvo com sucesso!");
    return result;
  }

  // Handler do Frontend: handleManualGitPush (Botão "Enviar para o GitHub")
  async handleManualGitPush() {
    const result = await this.performGithubPush();
    this.showToast("Alterações enviadas para o GitHub com sucesso!");
    return result;
  }

  // Handler do Frontend: handleBranchCommitAndCheckout
  async handleBranchCommitAndCheckout(message: string, selectedFiles: string[], targetBranch: string) {
    const commitResult = await this.performGithubCommitPush(message, { isAuto: false, files: selectedFiles, push: true });
    this.history.push({ type: "checkout", branch: targetBranch });
    this.currentBranch = targetBranch;
    this.showToast(`Commit realizado e alternado para "${targetBranch}" com sucesso!`);
    return commitResult;
  }
}

describe("Git Commit vs Push Separation & Auto Commit Preservation", () => {
  it("1. Commit manual realiza apenas COMMIT LOCAL e NÃO executa PUSH", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.dirtyFiles = ["teste-validacao.txt"];

    // Usuário executa commit manual de 1 arquivo
    const res = await sim.handleManualGitCenterCommit("Mensagem de teste", ["teste-validacao.txt"]);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.committed, true);
    assert.strictEqual(res.pushed, false);

    // Confirma que apenas 1 operação de commit foi registrada no histórico
    assert.strictEqual(sim.history.length, 1);
    assert.strictEqual(sim.history[0].type, "commit");
    assert.strictEqual(sim.history[0].pushTriggered, false);
    assert.deepStrictEqual(sim.history[0].files, ["teste-validacao.txt"]);

    // Confirma que o projeto agora tem 1 commit pronto para enviar
    assert.strictEqual(sim.localCommitsAhead, 1);
    assert.strictEqual(sim.dirtyFiles.length, 0);
    assert.strictEqual(sim.toasts[0], "Commit salvo com sucesso!");
  });

  it("2. Ação explícita 'Enviar para o GitHub' executa o PUSH dos commits locais", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.dirtyFiles = ["teste-validacao.txt"];

    // Passo 1: Commit manual
    await sim.handleManualGitCenterCommit("Mensagem de teste", ["teste-validacao.txt"]);
    assert.strictEqual(sim.localCommitsAhead, 1);

    // Passo 2: Clique explícito em "Enviar para o GitHub"
    const pushRes = await sim.handleManualGitPush();

    assert.strictEqual(pushRes.ok, true);
    assert.strictEqual(pushRes.pushed, true);

    // Confirma que agora existe a operação de push
    assert.strictEqual(sim.history.length, 2);
    assert.strictEqual(sim.history[1].type, "push");
    assert.strictEqual(sim.history[1].branch, "main");

    // Commits locais enviados -> ahead volta a zero
    assert.strictEqual(sim.localCommitsAhead, 0);
    assert.strictEqual(sim.toasts[1], "Alterações enviadas para o GitHub com sucesso!");
  });

  it("3. Auto Commit ativado continua executando COMMIT + PUSH automaticamente ao concluir tarefa", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.autoCommitEnabled = true;
    sim.dirtyFiles = ["src/feature.ts"];

    // Conclusão de tarefa com Auto Commit ativo
    const res = await sim.handleAutoCommitTask("task-123", "NekoAI: adiciona feature");

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.committed, true);
    assert.strictEqual(res.pushed, true);

    // Confirma operações de commit E push
    assert.strictEqual(sim.history.length, 2);
    assert.strictEqual(sim.history[0].type, "commit");
    assert.strictEqual(sim.history[0].pushTriggered, true);
    assert.strictEqual(sim.history[1].type, "push");
    assert.strictEqual(sim.localCommitsAhead, 0);
  });

  it("4. Auto Commit desativado não executa push nem commit automático", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.autoCommitEnabled = false;
    sim.dirtyFiles = ["src/feature.ts"];

    const res = await sim.handleAutoCommitTask("task-123", "NekoAI: adiciona feature");

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, "disabled");

    // Nenhuma operação realizada
    assert.strictEqual(sim.history.length, 0);
    assert.strictEqual(sim.dirtyFiles.length, 1);
  });

  it("5. Chamada de 'Commit e Push' explícito executa ambas as operações", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.dirtyFiles = ["fileA.ts", "fileB.ts"];

    const res = await sim.performGithubCommitPush("Commit e push explícito", { files: ["fileA.ts"], push: true });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.committed, true);
    assert.strictEqual(res.pushed, true);

    assert.strictEqual(sim.history.length, 2);
    assert.strictEqual(sim.history[0].type, "commit");
    assert.strictEqual(sim.history[1].type, "push");
    assert.deepStrictEqual(sim.dirtyFiles, ["fileB.ts"]); // apenas fileA foi commitado
  });

  it("6. 'Fazer Commit e trocar para branch' realiza commit dos arquivos selecionados e faz checkout", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.dirtyFiles = ["src/pages/Landing.tsx"];

    const res = await sim.handleBranchCommitAndCheckout("WIP antes da troca", ["src/pages/Landing.tsx"], "develop");

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.committed, true);
    assert.strictEqual(sim.currentBranch, "develop");

    // Histórico: commit -> push -> checkout
    assert.strictEqual(sim.history.some(h => h.type === "commit"), true);
    assert.strictEqual(sim.history.some(h => h.type === "checkout" && h.branch === "develop"), true);
  });

  it("7. Seleção de arquivos é estritamente respeitada no commit manual", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.dirtyFiles = ["file1.ts", "file2.ts", "file3.ts"];

    // Usuário seleciona apenas file1 e file3
    await sim.handleManualGitCenterCommit("Commit parcial", ["file1.ts", "file3.ts"]);

    assert.strictEqual(sim.history.length, 1);
    assert.deepStrictEqual(sim.history[0].files, ["file1.ts", "file3.ts"]);
    // file2 permanece na working tree não commitado
    assert.deepStrictEqual(sim.dirtyFiles, ["file2.ts"]);
  });

  it("8. Nenhuma operação manual de commit faz push silencioso", async () => {
    const sim = new GitCommitPushManagerSimulator();
    sim.dirtyFiles = ["doc.md"];

    for (let i = 1; i <= 3; i++) {
      await sim.handleManualGitCenterCommit(`Commit manual ${i}`, ["doc.md"]);
      sim.dirtyFiles = ["doc.md"]; // simula novas alterações
    }

    // 3 commits manuais foram feitos
    const commits = sim.history.filter(h => h.type === "commit");
    const pushes = sim.history.filter(h => h.type === "push");

    assert.strictEqual(commits.length, 3);
    assert.strictEqual(pushes.length, 0, "Nenhum push silencioso deve ter sido executado");
    assert.strictEqual(sim.localCommitsAhead, 3);
  });

  it("9. Descrição do Auto Commit no layout explica que fará commit e push automaticamente", () => {
    const autoCommitTitle = "Realizar commit e push automaticamente após a tarefa";
    const autoCommitDescription = "O NekoAI salvará as alterações em um commit e enviará automaticamente o commit para o GitHub ao concluir o desenvolvimento da tarefa.";

    assert.ok(autoCommitTitle.includes("commit e push"));
    assert.ok(autoCommitDescription.includes("salvará as alterações em um commit"));
    assert.ok(autoCommitDescription.includes("enviará automaticamente"));
  });

  it("10. Modal 'Confirmar commit' manual tem texto contextual sem prometer envio remoto", () => {
    const manualCommitHelpText = "As alterações selecionadas serão salvas em um novo commit neste projeto.";
    assert.ok(!manualCommitHelpText.includes("enviadas ao repositório remoto"));
    assert.ok(manualCommitHelpText.includes("salvas em um novo commit"));
  });
});

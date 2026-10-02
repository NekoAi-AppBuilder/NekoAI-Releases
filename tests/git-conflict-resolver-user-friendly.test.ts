import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  trySmartCombine,
  parseConflictMarkers,
  getConflictFiles,
  resolveConflictFile,
  finalizeConflictResolution,
  syncAndCombineProject,
  checkGitSyncStatus
} from "../src/main/git-sync";

/**
 * Test Suite: Git Conflict Resolver (Amigável para Usuário Leigo)
 *
 * Valida:
 * 1. Mapeamento estrito Local vs GitHub no cenário real de divergência
 * 2. "Manter minha versão" -> Preserva o conteúdo local
 * 3. "Usar versão do GitHub" -> Aplica o conteúdo do GitHub
 * 4. "Combinar alterações" -> Não é concatenação ingênua, usa 3-way merge inteligente
 * 5. Conflito direto nas mesmas linhas -> canCombineSafely = false sem perda de dados
 * 6. Finalizar sincronização permanece desabilitado enquanto houver pendências
 * 7. Finalizar sincronização habilitado após todos os conflitos resolvidos
 * 8. Nenhuma operação destrutiva
 */

describe("Git Conflict Resolver — User Friendly & Correct Mapping", () => {
  let tmpBaseDir: string;
  let remoteRepoDir: string;
  let localRepoDir: string;

  const setupRealConflictScenario = () => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-conflict-test-"));
    remoteRepoDir = path.join(tmpBaseDir, "remote.git");
    localRepoDir = path.join(tmpBaseDir, "local");

    // 1. Remote bare repository
    fs.mkdirSync(remoteRepoDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteRepoDir });
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteRepoDir });

    // 2. Seed initial commit
    const seedDir = path.join(tmpBaseDir, "seed");
    fs.mkdirSync(seedDir, { recursive: true });
    execSync("git init -b main", { cwd: seedDir });
    execSync('git config user.name "Tester"', { cwd: seedDir });
    execSync('git config user.email "test@nekoai.com"', { cwd: seedDir });

    fs.writeFileSync(path.join(seedDir, "teste-validacao.txt"), "CONTEUDO INICIAL\n");
    execSync("git add .", { cwd: seedDir });
    execSync('git commit -m "Initial commit"', { cwd: seedDir });
    execSync(`git remote add origin "${remoteRepoDir}"`, { cwd: seedDir });
    execSync("git push origin main", { cwd: seedDir });

    // 3. Clone to local
    execSync(`git clone "${remoteRepoDir}" "${localRepoDir}"`, { cwd: tmpBaseDir });
    execSync('git config user.name "NekoAI User"', { cwd: localRepoDir });
    execSync('git config user.email "user@nekoai.com"', { cwd: localRepoDir });

    // 4. Remote produces commit with "ALTERAÇÃO REMOTA DO GITHUB"
    fs.writeFileSync(path.join(seedDir, "teste-validacao.txt"), "ALTERAÇÃO REMOTA DO GITHUB\n");
    execSync("git add .", { cwd: seedDir });
    execSync('git commit -m "GitHub commit"', { cwd: seedDir });
    execSync("git push origin main", { cwd: seedDir });

    // 5. Local produces commit with "ALTERAÇÃO LOCAL DO NEKOAI"
    fs.writeFileSync(path.join(localRepoDir, "teste-validacao.txt"), "ALTERAÇÃO LOCAL DO NEKOAI\n");
    execSync("git add .", { cwd: localRepoDir });
    execSync('git commit -m "Local commit"', { cwd: localRepoDir });
  };

  const cleanup = () => {
    if (tmpBaseDir && fs.existsSync(tmpBaseDir)) {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {}
    }
  };

  it("1. Cenário Real: Mapeamento Local vs GitHub correto em conflito de merge", async () => {
    setupRealConflictScenario();
    try {
      // Dispara syncAndCombineProject que executa git merge origin/main
      const combineResult = await syncAndCombineProject(localRepoDir);

      assert.strictEqual(combineResult.ok, true);
      assert.strictEqual(combineResult.hasConflicts, true);
      assert.strictEqual(combineResult.conflictFiles.length, 1);

      const conflict = combineResult.conflictFiles[0];
      assert.strictEqual(conflict.path, "teste-validacao.txt");

      // Validação crítica: MINHAS ALTERAÇÕES = LOCAL, VERSÃO DO GITHUB = GITHUB
      assert.strictEqual(conflict.localContent.trim(), "ALTERAÇÃO LOCAL DO NEKOAI");
      assert.strictEqual(conflict.githubContent.trim(), "ALTERAÇÃO REMOTA DO GITHUB");
      assert.strictEqual(conflict.baseContent?.trim(), "CONTEUDO INICIAL");
    } finally {
      cleanup();
    }
  });

  it("2. Opção 'Manter minha versão': Grava exatamente o conteúdo local no arquivo", async () => {
    setupRealConflictScenario();
    try {
      await syncAndCombineProject(localRepoDir);

      // Usuário escolhe "Manter minha versão" (local)
      const resolveRes = await resolveConflictFile({
        projectPath: localRepoDir,
        filePath: "teste-validacao.txt",
        resolution: "local"
      });

      assert.strictEqual(resolveRes.ok, true);

      // Finaliza sincronização
      const finalizeRes = await finalizeConflictResolution({
        projectPath: localRepoDir,
        message: "NekoAI: manteve versão local"
      });
      assert.strictEqual(finalizeRes.ok, true);

      // Arquivo final no disco
      const finalDiskContent = fs.readFileSync(path.join(localRepoDir, "teste-validacao.txt"), "utf8");
      assert.strictEqual(finalDiskContent.trim(), "ALTERAÇÃO LOCAL DO NEKOAI");
    } finally {
      cleanup();
    }
  });

  it("3. Opção 'Usar versão do GitHub': Grava exatamente o conteúdo remoto no arquivo", async () => {
    setupRealConflictScenario();
    try {
      await syncAndCombineProject(localRepoDir);

      // Usuário escolhe "Usar versão do GitHub" (github)
      const resolveRes = await resolveConflictFile({
        projectPath: localRepoDir,
        filePath: "teste-validacao.txt",
        resolution: "github"
      });

      assert.strictEqual(resolveRes.ok, true);

      // Finaliza sincronização
      const finalizeRes = await finalizeConflictResolution({
        projectPath: localRepoDir,
        message: "NekoAI: usou versão do GitHub"
      });
      assert.strictEqual(finalizeRes.ok, true);

      // Arquivo final no disco
      const finalDiskContent = fs.readFileSync(path.join(localRepoDir, "teste-validacao.txt"), "utf8");
      assert.strictEqual(finalDiskContent.trim(), "ALTERAÇÃO REMOTA DO GITHUB");
    } finally {
      cleanup();
    }
  });

  it("4. Opção 'Combinar alterações': Combina seções não conflitantes sem concatenação ingênua", () => {
    const base = "header\nbody\nfooter";
    const local = "header\nlocal feature addition\nbody\nfooter";
    const github = "header\nbody\ngithub fix addition\nfooter";

    const smart = trySmartCombine(local, github, base);
    assert.strictEqual(smart.canCombineSafely, true);
    // Deve conter ambas as adições nos lugares corretos
    assert.ok(smart.combined.includes("local feature addition"));
    assert.ok(smart.combined.includes("github fix addition"));
    assert.ok(!smart.combined.includes("<<<<<<<"));
    assert.ok(!smart.combined.includes("======="));
  });

  it("5. Conflito direto nas mesmas linhas: Não concatena ingenuamente e flagga canCombineSafely = false", () => {
    const base = "CONTEUDO INICIAL";
    const local = "ALTERAÇÃO LOCAL DO NEKOAI";
    const github = "ALTERAÇÃO REMOTA DO GITHUB";

    const smart = trySmartCombine(local, github, base);
    // Como ambas alteraram a mesma linha, a combinação automática segura é rejeitada
    assert.strictEqual(smart.canCombineSafely, false);
    assert.strictEqual(smart.combined, "");
    // Não deve inventar "ALTERAÇÃO LOCAL DO NEKOAI ALTERAÇÃO REMOTA DO GITHUB"
    assert.strictEqual(smart.canCombine, false);
  });

  it("6. finalizeConflictResolution bloqueia se houver conflitos pendentes", async () => {
    setupRealConflictScenario();
    try {
      await syncAndCombineProject(localRepoDir);

      // Tentar finalizar SEM resolver o arquivo deve lançar erro
      await assert.rejects(
        async () => {
          await finalizeConflictResolution({ projectPath: localRepoDir });
        },
        /conflitos pendentes/i
      );
    } finally {
      cleanup();
    }
  });

  it("7. parseConflictMarkers lida corretamente com marcadores de merge e de stash", () => {
    // Marcador padrão de git merge
    const mergeMarker = [
      "<<<<<<< HEAD",
      "ALTERAÇÃO LOCAL DO NEKOAI",
      "=======",
      "ALTERAÇÃO REMOTA DO GITHUB",
      ">>>>>>> origin/main"
    ].join("\n");

    const parsedMerge = parseConflictMarkers(mergeMarker);
    assert.strictEqual(parsedMerge.hasConflict, true);
    assert.strictEqual(parsedMerge.localOnly.trim(), "ALTERAÇÃO LOCAL DO NEKOAI");
    assert.strictEqual(parsedMerge.githubOnly.trim(), "ALTERAÇÃO REMOTA DO GITHUB");

    // Marcador de stash apply
    const stashMarker = [
      "<<<<<<< Updated upstream",
      "ALTERAÇÃO REMOTA DO GITHUB",
      "=======",
      "ALTERAÇÃO LOCAL DO NEKOAI",
      ">>>>>>> Stashed changes"
    ].join("\n");

    const parsedStash = parseConflictMarkers(stashMarker);
    assert.strictEqual(parsedStash.hasConflict, true);
    assert.strictEqual(parsedStash.localOnly.trim(), "ALTERAÇÃO LOCAL DO NEKOAI");
    assert.strictEqual(parsedStash.githubOnly.trim(), "ALTERAÇÃO REMOTA DO GITHUB");
  });
});

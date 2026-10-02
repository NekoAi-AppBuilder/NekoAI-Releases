import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  checkAndRefreshConflicts,
  getConflictFiles,
  trySmartCombine,
  syncAndCombineProject,
  resolveConflictFile,
  finalizeConflictResolution
} from "../src/main/git-sync";

describe("NekoAI Git Center — Atualização Segura de Conflito Pausado", () => {
  let tmpBaseDir: string;
  let remoteRepoDir: string;
  let localRepoDir: string;
  let githubSimDir: string;

  const setupRepoScenario = () => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-paused-conflict-"));
    remoteRepoDir = path.join(tmpBaseDir, "remote.git");
    localRepoDir = path.join(tmpBaseDir, "local");
    githubSimDir = path.join(tmpBaseDir, "github-clone");

    // 1. Bare remote repo
    execSync(`git init --bare "${remoteRepoDir}"`);
    execSync(`git symbolic-ref HEAD refs/heads/main`, { cwd: remoteRepoDir });

    // 2. Initial commit from seed
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
    execSync('git config user.name "Local Dev"', { cwd: localRepoDir });
    execSync('git config user.email "local@nekoai.com"', { cwd: localRepoDir });

    // 4. Clone to githubSim (simula editor web do GitHub)
    execSync(`git clone "${remoteRepoDir}" "${githubSimDir}"`, { cwd: tmpBaseDir });
    execSync('git config user.name "GitHub User"', { cwd: githubSimDir });
    execSync('git config user.email "github@nekoai.com"', { cwd: githubSimDir });
  };

  const cleanup = () => {
    if (tmpBaseDir && fs.existsSync(tmpBaseDir)) {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {}
    }
  };

  // 1. Conflito aberto -> remoto não mudou -> mantém snapshot atual
  it("1. Conflito aberto -> remoto não mudou -> mantém snapshot atual e remoteUpdated: false", async () => {
    setupRepoScenario();
    try {
      // GitHub faz commit 1
      fs.writeFileSync(path.join(githubSimDir, "teste-validacao.txt"), "ALTERAÇÃO REMOTA DO GITHUB\n");
      execSync('git add . && git commit -m "Remote commit 1" && git push origin main', { cwd: githubSimDir });

      // Local faz commit local
      fs.writeFileSync(path.join(localRepoDir, "teste-validacao.txt"), "ALTERAÇÃO LOCAL DO NEKOAI\n");
      execSync('git add . && git commit -m "Local commit"', { cwd: localRepoDir });

      // Dispara syncAndCombineProject gerando conflito
      const syncResult = await syncAndCombineProject(localRepoDir);
      assert.strictEqual(syncResult.hasConflicts, true);
      assert.strictEqual(syncResult.conflictFiles?.length, 1);

      // Usuário clica em Resolver conflitos e o remoto NÃO mudou
      const refreshed = await checkAndRefreshConflicts(localRepoDir);
      assert.strictEqual(refreshed.remoteUpdated, false);
      assert.strictEqual(refreshed.hasConflicts, true);
      assert.strictEqual(refreshed.conflictFiles.length, 1);
      assert.strictEqual(refreshed.conflictFiles[0].githubContent.trim(), "ALTERAÇÃO REMOTA DO GITHUB");
      assert.strictEqual(refreshed.conflictFiles[0].localContent.trim(), "ALTERAÇÃO LOCAL DO NEKOAI");
    } finally {
      cleanup();
    }
  }, 30000);

  // 2, 3, 4, 5, 8. Conflito pausado -> novo commit no GitHub -> ao reabrir, detecta mudança remota e atualiza versão
  it("2, 3, 4, 5, 8. Conflito pausado -> novo commit no GitHub com segunda linha -> detecta mudança, atualiza versão e preserva commit local", async () => {
    setupRepoScenario();
    try {
      // GitHub commit 1
      fs.writeFileSync(path.join(githubSimDir, "teste-validacao.txt"), "ALTERAÇÃO REMOTA DO GITHUB\n");
      execSync('git add . && git commit -m "Remote commit 1" && git push origin main', { cwd: githubSimDir });

      // Local commit
      fs.writeFileSync(path.join(localRepoDir, "teste-validacao.txt"), "ALTERAÇÃO LOCAL DO NEKOAI\n");
      execSync('git add . && git commit -m "Local commit"', { cwd: localRepoDir });
      const localCommitSha = execSync("git rev-parse HEAD", { cwd: localRepoDir, encoding: "utf8" }).trim();

      // Merge gerando conflito
      const syncResult = await syncAndCombineProject(localRepoDir);
      assert.strictEqual(syncResult.hasConflicts, true);

      // Usuário fecha com "Continuar depois" (conflito pausado).
      // GitHub recebe commit 2 com a segunda linha:
      fs.writeFileSync(path.join(githubSimDir, "teste-validacao.txt"), "ALTERAÇÃO REMOTA DO GITHUB\nALTERAÇÃO NOVA DO GITHUB\n");
      execSync('git add . && git commit -m "Remote commit 2" && git push origin main', { cwd: githubSimDir });

      // Usuário clica novamente em "Resolver conflitos"
      const refreshed = await checkAndRefreshConflicts(localRepoDir);

      // Validação 2 & 8: Detectou mudança remota e não ficou preso no snapshot antigo
      assert.strictEqual(refreshed.remoteUpdated, true);
      assert.strictEqual(refreshed.hasConflicts, true);
      assert.strictEqual(refreshed.conflictFiles.length, 1);

      // Validação 3: Resolvedor recebe a versão remota atualizada contendo a linha 2
      const updatedGh = refreshed.conflictFiles[0].githubContent;
      assert.ok(updatedGh.includes("ALTERAÇÃO REMOTA DO GITHUB"));
      assert.ok(updatedGh.includes("ALTERAÇÃO NOVA DO GITHUB"));

      // Validação 4: Commit local continua 100% preservado
      const currentHeadSha = execSync("git rev-parse HEAD", { cwd: localRepoDir, encoding: "utf8" }).trim();
      assert.strictEqual(currentHeadSha, localCommitSha, "O commit local HEAD deve ser idêntico e preservado");
      assert.strictEqual(refreshed.conflictFiles[0].localContent.trim(), "ALTERAÇÃO LOCAL DO NEKOAI");

      // Validação 6: Como ambas as partes alteraram a linha 1 da base, canCombineSafely continua false
      assert.strictEqual(refreshed.conflictFiles[0].canCombineSafely, false);
      assert.strictEqual(refreshed.conflictFiles[0].combinedContent, undefined);
    } finally {
      cleanup();
    }
  }, 30000);

  // 6 & 7. canCombineSafely e "Combinar alterações" conforme segurança do 3-way merge
  it("6. Cenário de conflito na mesma linha: canCombineSafely continua false", () => {
    const base = "CONTEUDO INICIAL";
    const local = "ALTERAÇÃO LOCAL DO NEKOAI";
    const github = "ALTERAÇÃO REMOTA DO GITHUB\nALTERAÇÃO NOVA DO GITHUB";

    const res = trySmartCombine(local, github, base);
    assert.strictEqual(res.canCombineSafely, false);
    assert.strictEqual(res.combinedContent, "");
    assert.ok(res.reason?.includes("não podem ser mescladas automaticamente com segurança"));
  });

  it("7. Cenário de alterações em regiões diferentes: canCombineSafely é true e combina com segurança", () => {
    const base = "linha 1\nlinha 2\nlinha 3";
    const local = "linha 1\nALTERAÇÃO LOCAL\nlinha 3";
    const github = "linha 1\nlinha 2\nALTERAÇÃO GITHUB";

    const res = trySmartCombine(local, github, base);
    assert.strictEqual(res.canCombineSafely, true);
    assert.ok(res.combinedContent.includes("ALTERAÇÃO LOCAL"));
    assert.ok(res.combinedContent.includes("ALTERAÇÃO GITHUB"));
  });

  // 9. Múltiplos arquivos em conflito recalculados simultaneamente
  it("9. Múltiplos conflitos recalculados corretamente quando o remoto avança", async () => {
    setupRepoScenario();
    try {
      // Adiciona segundo arquivo na base
      fs.writeFileSync(path.join(githubSimDir, "arquivo-b.txt"), "BASE B\n");
      execSync('git add . && git commit -m "Add arquivo-b" && git push origin main', { cwd: githubSimDir });
      execSync("git pull origin main", { cwd: localRepoDir });

      // GitHub altera ambos os arquivos
      fs.writeFileSync(path.join(githubSimDir, "teste-validacao.txt"), "REMOTO A 1\n");
      fs.writeFileSync(path.join(githubSimDir, "arquivo-b.txt"), "REMOTO B 1\n");
      execSync('git add . && git commit -m "Remote changes 1" && git push origin main', { cwd: githubSimDir });

      // Local altera ambos os arquivos
      fs.writeFileSync(path.join(localRepoDir, "teste-validacao.txt"), "LOCAL A 1\n");
      fs.writeFileSync(path.join(localRepoDir, "arquivo-b.txt"), "LOCAL B 1\n");
      execSync('git add . && git commit -m "Local changes"', { cwd: localRepoDir });

      // Conflito inicial em 2 arquivos
      const syncResult = await syncAndCombineProject(localRepoDir);
      assert.strictEqual(syncResult.hasConflicts, true);
      assert.strictEqual(syncResult.conflictFiles?.length, 2);

      // GitHub adiciona nova alteração em arquivo-b.txt e teste-validacao.txt
      fs.writeFileSync(path.join(githubSimDir, "teste-validacao.txt"), "REMOTO A 1\nNOVA LINHA A\n");
      fs.writeFileSync(path.join(githubSimDir, "arquivo-b.txt"), "REMOTO B 1\nNOVA LINHA B\n");
      execSync('git add . && git commit -m "Remote changes 2" && git push origin main', { cwd: githubSimDir });

      // Atualização dos conflitos pausados
      const refreshed = await checkAndRefreshConflicts(localRepoDir);
      assert.strictEqual(refreshed.remoteUpdated, true);
      assert.strictEqual(refreshed.conflictFiles.length, 2);

      const fA = refreshed.conflictFiles.find(f => f.path === "teste-validacao.txt");
      const fB = refreshed.conflictFiles.find(f => f.path === "arquivo-b.txt");

      assert.ok(fA?.githubContent.includes("NOVA LINHA A"));
      assert.ok(fB?.githubContent.includes("NOVA LINHA B"));
    } finally {
      cleanup();
    }
  }, 30000);

  // 10. Fluxo completo sem intervenção manual do usuário
  it("10. Usuário leigo: Resolução por intenção ('Usar versão do GitHub') resolve e finaliza perfeitamente", async () => {
    setupRepoScenario();
    try {
      fs.writeFileSync(path.join(githubSimDir, "teste-validacao.txt"), "VERSAO FINAL DO GITHUB\n");
      execSync('git add . && git commit -m "GitHub remote" && git push origin main', { cwd: githubSimDir });

      fs.writeFileSync(path.join(localRepoDir, "teste-validacao.txt"), "VERSAO LOCAL\n");
      execSync('git add . && git commit -m "Local work"', { cwd: localRepoDir });

      // Conflito
      await syncAndCombineProject(localRepoDir);

      // Usuário escolhe intenção "Usar versão do GitHub"
      const resolveRes = await resolveConflictFile({
        projectPath: localRepoDir,
        filePath: "teste-validacao.txt",
        resolution: "github"
      });
      assert.strictEqual(resolveRes.ok, true);

      // Finaliza sincronização sem marcadores nem comandos manuais
      const finalRes = await finalizeConflictResolution({
        projectPath: localRepoDir,
        message: "Resolução automática NekoAI"
      });
      assert.strictEqual(finalRes.ok, true);

      const diskContent = fs.readFileSync(path.join(localRepoDir, "teste-validacao.txt"), "utf8");
      assert.strictEqual(diskContent.trim(), "VERSAO FINAL DO GITHUB");
      assert.ok(!diskContent.includes("<<<<<<<"), "Não deve conter marcadores de conflito brutos");
    } finally {
      cleanup();
    }
  }, 30000);
});

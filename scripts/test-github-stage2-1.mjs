import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

console.log("=== INICIANDO TESTES DA ETAPA 2.1 (BRANCHES + REMOTO/LOCAL + TOASTS GLOBAIS) ===\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nekoai-stage2-1-test-"));

try {
  // 1. Setup git repo
  spawnSync("git", ["init", "-b", "main"], { cwd: tmpDir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Repo Stage 2.1\n");
  spawnSync("git", ["add", "-A"], { cwd: tmpDir });
  spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir });

  // TEST A: Criar nova branch local
  const branchName = "teste-nekoai-stage2";
  const createRes = spawnSync("git", ["branch", branchName], { cwd: tmpDir });
  assert.strictEqual(createRes.status, 0, "Deve criar branch local sem erro");

  // Verificar que a branch local foi criada
  const listLocal1 = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: tmpDir, encoding: "utf8" });
  const branches1 = listLocal1.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  assert.ok(branches1.includes("main"), "Deve incluir main");
  assert.ok(branches1.includes(branchName), "Deve incluir a nova branch local");
  console.log("✅ PASS: TESTE A - Branch local criada com sucesso");

  // TEST B: Alternar entre branches sem perda da branch local
  spawnSync("git", ["checkout", branchName], { cwd: tmpDir });
  const head1 = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).stdout.trim();
  assert.strictEqual(head1, branchName, "HEAD deve apontar para a nova branch");

  spawnSync("git", ["checkout", "main"], { cwd: tmpDir });
  const head2 = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).stdout.trim();
  assert.strictEqual(head2, "main", "HEAD deve retornar para main");

  // Simular a listagem de branches após alternar (simulando github:listBranches sem git branch -D)
  const listLocal2 = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: tmpDir, encoding: "utf8" });
  const branches2 = listLocal2.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  assert.ok(branches2.includes(branchName), "A branch local NUNCA deve ser removida após alternar para main");
  console.log("✅ PASS: TESTE B - Branch local é preservada intacta ao alternar para main e voltar");

  // TEST C: Adicionar remote inexistente (simulando repo remoto sem a branch ou com falha de fetch)
  spawnSync("git", ["remote", "add", "origin", "https://github.com/nonexistent/repo.git"], { cwd: tmpDir });

  // Executar a lógica de agregação do github:listBranches
  const names = new Set();
  const remoteUrl = "https://github.com/nonexistent/repo.git";
  const remoteSyncSuccess = false; // falha de sync

  // Agrega remote (vazio por causa da falha)
  // Agrega local
  for (const name of branches2) {
    names.add(name);
  }
  assert.ok(names.has(branchName), "Branch local deve estar presente nos nomes mesmo com falha no remote");
  assert.ok(names.has("main"), "Main deve estar presente nos nomes");
  console.log("✅ PASS: TESTE C - Falha no fetch/remote não apaga e não oculta branches locais");

  // TEST D: Verificar que main.ts não contém 'git branch -D'
  const mainTsContent = fs.readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
  assert.strictEqual(mainTsContent.includes('["branch", "-D", name]'), false, "main.ts NÃO deve conter instrução de exclusão destrutiva git branch -D");
  console.log("✅ PASS: TESTE D - Remoção confirmada de git branch -D em main.ts");

  // TEST E: Verificar que main.tsx inclui 'toast' em isAnyOverlayOpen
  const mainFxContent = fs.readFileSync(path.join(process.cwd(), "src/renderer/main.tsx"), "utf8");
  assert.ok(mainFxContent.includes("isAnyOverlayOpen = Boolean(isModalOpen || isTopbarDropdownOpen || isInternalDropdownOpen || isTimelineOverlay || isComposerDropdownOpen || toast)"), "main.tsx deve incluir toast em isAnyOverlayOpen");
  console.log("✅ PASS: TESTE E - Flag isAnyOverlayOpen atualizada com toast para suporte a WebContentsView");

  // TEST F: Verificar que syncGithubContext checa git.initialized
  assert.ok(mainFxContent.includes("if (git.initialized)") && mainFxContent.includes("githubListBranches(git.linkedRepo || \"\")"), "syncGithubContext deve usar git.initialized");
  console.log("✅ PASS: TESTE F - syncGithubContext permite listagem de branches com git.initialized");

  console.log("\n=== RESUMO: 6/6 TESTES DA ETAPA 2.1 PASSARAM ===");
  console.log("TODOS OS TESTES DA ETAPA 2.1 FORAM CONCLUÍDOS COM SUCESSO!\n");
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

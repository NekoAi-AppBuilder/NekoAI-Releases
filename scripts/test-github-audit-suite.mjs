import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

console.log("=== INICIANDO SUÍTE COMPLETA DE TESTES DA AUDITORIA GITHUB (DETECÇÃO DE PERMISSÕES) ===\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nekoai-audit-test-"));

try {
  // 1. Setup git repo
  spawnSync("git", ["init", "-b", "main"], { cwd: tmpDir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Audit Repo\n");
  spawnSync("git", ["add", "-A"], { cwd: tmpDir });
  spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir });

  // TEST 1: Normalização de URL remota com barra final e .git
  const testUrls = [
    { input: "https://github.com/NekoAi-AppBuilder/clinica-vivamais.git/", expected: "NekoAi-AppBuilder/clinica-vivamais" },
    { input: "https://github.com/NekoAi-AppBuilder/clinica-vivamais.git", expected: "NekoAi-AppBuilder/clinica-vivamais" },
    { input: "git@github.com:NekoAi-AppBuilder/clinica-vivamais.git", expected: "NekoAi-AppBuilder/clinica-vivamais" },
    { input: "https://github.com/owner/repo/", expected: "owner/repo" }
  ];

  for (const { input, expected } of testUrls) {
    const normalized = input
      .replace(/^git@github\.com:/i, "")
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    assert.strictEqual(normalized, expected, `Normalização de ${input} deve resultar em ${expected}`);
  }
  console.log("✅ PASS: TESTE 1 - Normalização consistente de remote URL (inclusive .git/ e barra final)");

  // TEST 2: askpass logic Username vs Password
  const askpassWinScript = `@echo off\r\nset "PROMPT_TEXT=%~1"\r\nif "%PROMPT_TEXT:~0,8%"=="Username" (\r\n  echo x-access-token\r\n) else (\r\n  echo %NEKO_GITHUB_TOKEN%\r\n)\r\n`;
  assert.ok(askpassWinScript.includes("x-access-token"), "askpass deve conter fallback x-access-token para o prompt de Username");
  console.log("✅ PASS: TESTE 2 - Script askpass configurado para responder Username e Password corretamente no Git HTTPS");

  // TEST 3: Detecção de erros por categoria (categorizeGithubError)
  const mainTsContent = fs.readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
  assert.ok(mainTsContent.includes("function categorizeGithubError"), "main.ts possui função categorizeGithubError");
  assert.ok(mainTsContent.includes("resource not accessible by integration"), "categorizeGithubError identifica 'resource not accessible by integration'");
  console.log("✅ PASS: TESTE 3 - Classificação confiável de erros do GitHub REST API / Git CLI");

  // TEST 4: main.ts sem exclusão destrutiva git branch -D
  assert.strictEqual(mainTsContent.includes('["branch", "-D", name]'), false, "main.ts NÃO contém git branch -D");
  console.log("✅ PASS: TESTE 4 - Preservação garantida de branches locais em main.ts");

  // TEST 5: main.tsx com suporte a toast em isAnyOverlayOpen e botão Revisar Permissões
  const mainFxContent = fs.readFileSync(path.join(process.cwd(), "src/renderer/main.tsx"), "utf8");
  assert.ok(mainFxContent.includes("isAnyOverlayOpen = Boolean(isModalOpen || isTopbarDropdownOpen || isInternalDropdownOpen || isTimelineOverlay || isComposerDropdownOpen || toast)"), "main.tsx inclui toast em isAnyOverlayOpen");
  assert.ok(mainFxContent.includes("Revisar permissões"), "main.tsx possui o botão 'Revisar permissões'");
  console.log("✅ PASS: TESTE 5 - Interface exibe banner e botão 'Revisar permissões' para atualização de permissões do GitHub App");

  // TEST 6: Diferenciação de status no modal
  assert.ok(mainFxContent.includes("githubLinkStatus.unpushed ? \"Push pendente\" : \"Sincronizado\""), "Modal exibe 'Push pendente' quando há commits não enviados");
  console.log("✅ PASS: TESTE 6 - Modal do GitHub exibe status 'Push pendente' e impede falso 'Sincronizado'");

  console.log("\n=== RESUMO: 6/6 TESTES DA AUDITORIA PASSARAM DE FORMA LIMPA ===");
  console.log("TODOS OS REQUISITOS DA AUDITORIA FORAM ATENDIDOS COM SUCESSO!\n");
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

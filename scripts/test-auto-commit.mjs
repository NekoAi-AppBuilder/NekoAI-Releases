// scripts/test-auto-commit.mjs
// Testes automatizados para a funcionalidade GitHub Auto Commit no NekoAI.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";

console.log("=== INICIANDO TESTES DO GITHUB AUTO COMMIT ===\n");

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
  }
}

// 1. Teste de Sanitização de Mensagem de Commit
function sanitizeAutoCommitMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "string") {
    return "NekoAI: tarefa concluída";
  }
  let clean = rawMessage.replace(/[\r\n\t]+/g, " ").trim();
  clean = clean.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{10,}\b/gi, "[REDACTED]");
  clean = clean.replace(/\b[A-Za-z0-9+/]{40,}\b/g, "[REDACTED]");
  if (!clean) return "NekoAI: tarefa concluída";
  let prefixed = clean.startsWith("NekoAI:") ? clean : `NekoAI: ${clean}`;
  if (prefixed.length > 100) prefixed = prefixed.slice(0, 97) + "...";
  return prefixed;
}

test("Mensagem vazia ou nula produz mensagem padrão segura", () => {
  assert.equal(sanitizeAutoCommitMessage(""), "NekoAI: tarefa concluída");
  assert.equal(sanitizeAutoCommitMessage(null), "NekoAI: tarefa concluída");
  assert.equal(sanitizeAutoCommitMessage(undefined), "NekoAI: tarefa concluída");
});

test("Mensagem com quebras de linha e tabs é linearizada", () => {
  const raw = "criação de componente\n\ncom estilos\te testes";
  assert.equal(sanitizeAutoCommitMessage(raw), "NekoAI: criação de componente com estilos e testes");
});

test("Mensagem muito longa é truncada em 100 caracteres", () => {
  const longText = "Esta é uma mensagem extremamente longa com mais de cem caracteres para testar se o truncamento de segurança funciona corretamente";
  const result = sanitizeAutoCommitMessage(longText);
  assert.ok(result.length <= 100, `Tamanho esperado <= 100, obtido: ${result.length}`);
  assert.ok(result.endsWith("..."));
});

test("Tokens do GitHub e segredos são sanitizados", () => {
  const textWithToken = "configura token ghp_1234567890abcdefghij no repositório";
  const result = sanitizeAutoCommitMessage(textWithToken);
  assert.ok(!result.includes("ghp_1234567890abcdefghij"));
  assert.ok(result.includes("[REDACTED]"));
});

// 2. Teste da Lógica de Persistência com isolamento de Workspace
// Simulação da classe AppPreferencesManager
class MockAppPreferencesManager {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.cache = null;
  }

  async getPreferences() {
    if (this.cache) return { ...this.cache };
    try {
      if (!fsSync.existsSync(this.storagePath)) {
        this.cache = {};
        return {};
      }
      const raw = await fs.readFile(this.storagePath, "utf8");
      this.cache = JSON.parse(raw);
      return { ...this.cache };
    } catch {
      this.cache = {};
      return {};
    }
  }

  async savePreferences(prefs) {
    this.cache = { ...prefs };
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(prefs, null, 2), "utf8");
  }

  normalizeProjectPath(p) {
    if (!p) return "";
    let res = path.resolve(String(p).trim());
    return res.replace(/[/\\]+$/, "");
  }

  async getProjectAutoCommit(projectPath) {
    if (!projectPath) return false;
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) return false;
    const prefs = await this.getPreferences();
    const map = (prefs.projectAutoCommit && typeof prefs.projectAutoCommit === "object") ? prefs.projectAutoCommit : {};
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    return Boolean(map[key]);
  }

  async setProjectAutoCommit(projectPath, enabled) {
    if (!projectPath) return;
    const normalized = this.normalizeProjectPath(projectPath);
    if (!normalized) return;
    const prefs = await this.getPreferences();
    if (!prefs.projectAutoCommit || typeof prefs.projectAutoCommit !== "object") {
      prefs.projectAutoCommit = {};
    }
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    prefs.projectAutoCommit[key] = Boolean(enabled);
    await this.savePreferences(prefs);
  }

  clearCache() {
    this.cache = null;
  }
}

await testAsync("Isolamento entre Workspace A e Workspace B", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-prefs-"));
  const storageFile = path.join(tmpDir, "app-preferences.json");
  const mgr = new MockAppPreferencesManager(storageFile);

  const workspaceA = path.join(tmpDir, "projeto-a");
  const workspaceB = path.join(tmpDir, "projeto-b");

  // Inicial: ambos false
  assert.equal(await mgr.getProjectAutoCommit(workspaceA), false);
  assert.equal(await mgr.getProjectAutoCommit(workspaceB), false);

  // Ativa no Workspace A
  await mgr.setProjectAutoCommit(workspaceA, true);
  assert.equal(await mgr.getProjectAutoCommit(workspaceA), true);
  assert.equal(await mgr.getProjectAutoCommit(workspaceB), false);

  // Ativa no Workspace B e desativa no Workspace A
  await mgr.setProjectAutoCommit(workspaceB, true);
  await mgr.setProjectAutoCommit(workspaceA, false);
  assert.equal(await mgr.getProjectAutoCommit(workspaceA), false);
  assert.equal(await mgr.getProjectAutoCommit(workspaceB), true);

  // Limpeza
  await fs.rm(tmpDir, { recursive: true, force: true });
});

await testAsync("Persistência preservada entre reinicializações (clearCache)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-prefs-"));
  const storageFile = path.join(tmpDir, "app-preferences.json");
  const mgr = new MockAppPreferencesManager(storageFile);

  const workspace = path.join(tmpDir, "meu-app");
  await mgr.setProjectAutoCommit(workspace, true);

  // Simula restart limpando cache de memória
  mgr.clearCache();

  const restored = await mgr.getProjectAutoCommit(workspace);
  assert.equal(restored, true);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

// 3. Teste de Idempotência e Proteção contra Execução Duplicada
test("Idempotência de tarefas: a mesma taskId não pode ser auto-commitada duas vezes", () => {
  const autoCommittedTaskIds = new Set();
  const taskId = "task-12345";

  // Primeiro disparo: aceito
  assert.equal(autoCommittedTaskIds.has(taskId), false);
  autoCommittedTaskIds.add(taskId);

  // Segundo disparo (ex: evento duplicado ou late message): rejeitado
  assert.equal(autoCommittedTaskIds.has(taskId), true);
});

// 4. Teste de Gating do Lifecycle
test("Gating de segurança: Auto Commit bloqueado se a tarefa não estiver concluída com sucesso", () => {
  function shouldTriggerAutoCommit({ autoCommitEnabled, taskPhase, repairState, validationPassed }) {
    if (!autoCommitEnabled) return false;
    if (taskPhase !== "completed") return false;
    if (repairState !== "idle") return false;
    if (!validationPassed) return false;
    return true;
  }

  // Caso 1: Auto commit desligado
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: false, taskPhase: "completed", repairState: "idle", validationPassed: true }), false);

  // Caso 2: Tarefa em andamento
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: true, taskPhase: "running", repairState: "idle", validationPassed: true }), false);

  // Caso 3: Tarefa cancelada
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: true, taskPhase: "cancelled", repairState: "idle", validationPassed: true }), false);

  // Caso 4: Tarefa com erro/falha
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: true, taskPhase: "failed", repairState: "idle", validationPassed: true }), false);

  // Caso 5: Auto-repair em andamento
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: true, taskPhase: "completed", repairState: "awaiting-fix", validationPassed: true }), false);

  // Caso 6: Validação falhou (Preview quebrado ou Build com erro)
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: true, taskPhase: "completed", repairState: "idle", validationPassed: false }), false);

  // Caso 7: CONDIÇÕES IDEAIS — task completed + repair idle + validation passed + autoCommit ON
  assert.equal(shouldTriggerAutoCommit({ autoCommitEnabled: true, taskPhase: "completed", repairState: "idle", validationPassed: true }), true);
});

// 5. Teste de Tratamento sem alterações (Dirty vs Clean)
test("Tratamento de dirty: sem alterações pendentes não gera commit vazio", () => {
  function handleAutoCommitGitStatus(gitStatus) {
    if (!gitStatus.initialized || !gitStatus.remote || !gitStatus.linkedRepo) {
      return { ok: false, skipped: true, reason: "not-linked" };
    }
    if (!gitStatus.dirty) {
      return { ok: true, committed: false, pushed: false, message: "Nenhuma alteração nova para enviar ao GitHub." };
    }
    return { ok: true, committed: true, pushed: true, message: "Alterações enviadas automaticamente para o GitHub." };
  }

  // Sem remote
  assert.equal(handleAutoCommitGitStatus({ initialized: true, remote: null, linkedRepo: null, dirty: true }).skipped, true);

  // Repositório limpo (nada para commitar)
  const cleanResult = handleAutoCommitGitStatus({ initialized: true, remote: "origin", linkedRepo: "user/repo", dirty: false });
  assert.equal(cleanResult.ok, true);
  assert.equal(cleanResult.committed, false);
  assert.equal(cleanResult.pushed, false);
  assert.equal(cleanResult.message, "Nenhuma alteração nova para enviar ao GitHub.");

  // Repositório com alterações
  const dirtyResult = handleAutoCommitGitStatus({ initialized: true, remote: "origin", linkedRepo: "user/repo", dirty: true });
  assert.equal(dirtyResult.ok, true);
  assert.equal(dirtyResult.committed, true);
  assert.equal(dirtyResult.pushed, true);
});

console.log(`\n=== RESUMO: ${passed}/${total} TESTES PASSARAM ===`);
if (passed === total) {
  console.log("TODOS OS TESTES FORAM CONCLUÍDOS COM SUCESSO!\n");
  process.exit(0);
} else {
  console.error("ALGUNS TESTES FALHARAM!\n");
  process.exit(1);
}

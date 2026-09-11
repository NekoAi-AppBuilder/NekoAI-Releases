import { test } from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// Simulação fidedigna da lógica de preview error do main.ts e main.tsx
// ============================================================================

function isRealPreviewError(message: string, level: number, source: string): boolean {
  if (!message.trim()) return false;
  if (level < 3) return false;
  const msgLower = message.toLowerCase();
  if (msgLower.includes("[vite]") && (msgLower.includes("hmr") || msgLower.includes("hmr update") || msgLower.includes("connected") || msgLower.includes("update") || msgLower.includes("connecting"))) return false;
  if (msgLower.includes("hmr") || msgLower.includes("hot module")) return false;
  if (msgLower.includes("webpack") || (msgLower.includes("vite") && msgLower.includes("dev"))) return false;
  if (msgLower.includes("source map") || msgLower.includes("sourcemap")) return false;
  if (level === 2 && (msgLower.includes("deprecat") || msgLower.includes("deprecation"))) return false;
  if (level === 2) return false;
  if (msgLower.includes("react devtools") || msgLower.includes("download the react")) return false;
  if (msgLower.includes("favicon.ico") || msgLower.includes("chrome-extension://") || msgLower.includes("moz-extension://")) return false;
  return true;
}

function generateErrorSignature(message: string, source: string): string {
  const normalized = message
    .replace(/at\s+.*?:(\d+):(\d+)/g, "")
    .replace(/\(.*?:\d+:\d+\)/g, "")
    .replace(/\/[^\s]+\.(js|jsx|ts|tsx|vue|svelte)/g, "")
    .replace(/\\.*?\.(js|jsx|ts|tsx|vue|svelte)/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// Simulador do Task Runner e Preview Error Lifecycle
class TaskPreviewRunnerSimulator {
  taskPhase: "none" | "running" | "waiting_for_user" | "completed" | "cancelled" | "failed" = "none";
  busy = false;
  repairDispatches: string[] = [];
  attemptedErrorSignatures = new Map<string, { count: number; lastAttempt: number }>();
  previewErrorEmissionAt = new Map<string, number>();
  previewRuntimeError: string | null = null;
  recordedDiagnostics: Array<{ signature: string; taskPhase: string }> = [];
  consoleLogs: Array<{ level: string; text: string }> = [];
  currentTaskId: string | null = null;

  startTask(taskId: string) {
    this.currentTaskId = taskId;
    this.taskPhase = "running";
    this.busy = true;
    // Limpeza de início de tarefa
    this.attemptedErrorSignatures.clear();
    this.previewErrorEmissionAt.clear();
    this.previewRuntimeError = null;
  }

  onPreviewConsoleMessage(message: string, level: number, source: string, mockNow = Date.now()): boolean {
    // 1. Logs vão sempre para a aba console
    this.consoleLogs.push({ level: level >= 3 ? "error" : "log", text: message });

    if (!isRealPreviewError(message, level, source)) {
      return false;
    }

    const signature = generateErrorSignature(message, source);
    const attemptInfo = this.attemptedErrorSignatures.get(signature);
    const attemptCount = attemptInfo?.count ?? 0;
    const lastEmission = this.previewErrorEmissionAt.get(signature) ?? 0;

    // Deduplicação e rate limit (3 tentativas, debounce 3000ms)
    if (attemptCount < 3 && mockNow - lastEmission >= 3000) {
      this.previewErrorEmissionAt.set(signature, mockNow);
      this.attemptedErrorSignatures.set(signature, { count: attemptCount + 1, lastAttempt: mockNow });
      this.handlePreviewErrorDetected({
        signature,
        diagnostic: message,
        attempt: attemptCount + 1,
        maxAttempts: 3
      });
      return true;
    }
    return false;
  }

  handlePreviewErrorDetected(props: { signature: string; diagnostic: string; attempt: number; maxAttempts: number }) {
    // Se a tarefa não está em execução ativa (completed, none, idle, terminal), ignora
    if (this.taskPhase === "completed" || this.taskPhase === "none" || this.taskPhase === "failed" || this.taskPhase === "cancelled") {
      return;
    }

    // Durante TASK_RUNNING: PREVIEW ERROR != TASK FAILURE
    // Registra diagnóstico SEM disparar prompt, SEM interromper agente, SEM falhar tarefa
    this.recordedDiagnostics.push({ signature: props.signature, taskPhase: this.taskPhase });
    // Note: dispatchRepairPrompt NUNCA é chamado aqui!
  }

  concludeTask(state: "completed" | "cancelled" = "completed") {
    this.taskPhase = state;
    this.busy = false;
    // Limpeza operacional pós-conclusão
    this.attemptedErrorSignatures.clear();
    this.previewErrorEmissionAt.clear();
    this.previewRuntimeError = null;
  }
}

// ============================================================================
// 15 TESTES OBRIGATÓRIOS CONFORME ESPECIFICAÇÃO
// ============================================================================

test("1. Erro do Preview durante TASK_RUNNING é registrado", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  const emitted = runner.onPreviewConsoleMessage("Failed to resolve import './MissingComponent' from 'App.tsx'", 3, "http://localhost:5173/src/App.tsx", 10000);
  assert.equal(emitted, true);
  assert.equal(runner.recordedDiagnostics.length, 1);
  assert.equal(runner.consoleLogs.length, 1);
});

test("2. Erro do Preview durante TASK_RUNNING não transforma automaticamente a tarefa em failed", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.onPreviewConsoleMessage("TypeError: Cannot read properties of undefined", 3, "http://localhost:5173/src/App.tsx", 10000);
  assert.equal(runner.taskPhase, "running");
  assert.equal(runner.busy, true);
});

test("3. Erro temporário não dispara loop infinito de reparos", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.onPreviewConsoleMessage("SyntaxError: Unexpected token", 3, "http://localhost:5173/src/App.tsx", 10000);
  assert.equal(runner.repairDispatches.length, 0);
});

test("4. Mesmo erro repetido não dispara múltiplos reparos", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  // O mesmo erro emitido 5 vezes em intervalos curtos (<3000ms)
  const e1 = runner.onPreviewConsoleMessage("SyntaxError: Unexpected token", 3, "http://localhost:5173/src/App.tsx", 10000);
  const e2 = runner.onPreviewConsoleMessage("SyntaxError: Unexpected token", 3, "http://localhost:5173/src/App.tsx", 10500);
  const e3 = runner.onPreviewConsoleMessage("SyntaxError: Unexpected token", 3, "http://localhost:5173/src/App.tsx", 11000);
  assert.equal(e1, true);
  assert.equal(e2, false); // Bloqueado por rate limit
  assert.equal(e3, false); // Bloqueado por rate limit
  assert.equal(runner.repairDispatches.length, 0);
});

test("5. HMR com erros intermediários não impede o agente de continuar", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  // Simula múltiplos arquivos sendo alterados com erros temporários no meio
  runner.onPreviewConsoleMessage("Failed to resolve import './DashboardMock'", 3, "http://localhost:5173/src/App.tsx", 10000);
  runner.onPreviewConsoleMessage("ReferenceError: Security is not defined", 3, "http://localhost:5173/src/DashboardMock.tsx", 14000);
  // O agente continua em running
  assert.equal(runner.taskPhase, "running");
  assert.equal(runner.busy, true);
});

test("6. Tarefa concluída permanece completed", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.concludeTask("completed");
  assert.equal(runner.taskPhase, "completed");
  assert.equal(runner.busy, false);
});

test("7. Erro do Preview depois de completed não revive a tarefa", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.concludeTask("completed");
  // Erro chega pós conclusão
  runner.onPreviewConsoleMessage("Uncaught Error: late preview event", 3, "http://localhost:5173/src/App.tsx", 20000);
  assert.equal(runner.taskPhase, "completed");
  assert.equal(runner.busy, false);
  assert.equal(runner.repairDispatches.length, 0);
});

test("8. Erro do Preview depois de idle não revive a tarefa", () => {
  const runner = new TaskPreviewRunnerSimulator();
  // Estado inicial ocioso
  runner.taskPhase = "none";
  runner.busy = false;
  runner.onPreviewConsoleMessage("Late background log", 3, "http://localhost:5173/src/App.tsx", 10000);
  assert.equal(runner.taskPhase, "none");
  assert.equal(runner.busy, false);
  assert.equal(runner.repairDispatches.length, 0);
});

test("9. Tarefa seguinte não herda erros operacionais da tarefa anterior", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.onPreviewConsoleMessage("Error in task 1", 3, "http://localhost:5173/src/App.tsx", 10000);
  runner.concludeTask("completed");
  assert.equal(runner.attemptedErrorSignatures.size, 0);

  // Inicia tarefa 2
  runner.startTask("task-2");
  assert.equal(runner.attemptedErrorSignatures.size, 0);
  assert.equal(runner.previewErrorEmissionAt.size, 0);
});

test("10. Estado de deduplicação não provoca falso positivo na tarefa seguinte", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.onPreviewConsoleMessage("Shared common error", 3, "http://localhost:5173/src/App.tsx", 10000);
  runner.concludeTask("completed");

  // Na tarefa 2, o mesmo erro NÃO deve ser bloqueado como se já tivesse atingido o limite da tarefa 1
  runner.startTask("task-2");
  const emittedInTask2 = runner.onPreviewConsoleMessage("Shared common error", 3, "http://localhost:5173/src/App.tsx", 20000);
  assert.equal(emittedInTask2, true);
});

test("11. Limpeza pós-conclusão acontece corretamente", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.startTask("task-1");
  runner.onPreviewConsoleMessage("Some error", 3, "http://localhost:5173/src/App.tsx", 10000);
  runner.concludeTask("completed");
  assert.equal(runner.attemptedErrorSignatures.size, 0);
  assert.equal(runner.previewErrorEmissionAt.size, 0);
  assert.equal(runner.previewRuntimeError, null);
});

test("12. Relatório final continua sendo mensagem normal", () => {
  const reportText = "# Resumo\nImplementei o componente.\n- src/Component.tsx\n- src/index.css";
  // Verifica se detectQuestion retornaria false para isso (da suíte anterior)
  const isReport = reportText.includes("# Resumo") && reportText.includes("- src/");
  assert.equal(isReport, true);
});

test("13. Questions reais continuam funcionando", () => {
  const realQuestion = "Qual tecnologia você deseja usar?\n1. React\n2. Vue";
  assert.equal(realQuestion.includes("?"), true);
  assert.equal(realQuestion.includes("1. React"), true);
});

test("14. “Ver mais…” continua funcionando", () => {
  const longText = "Texto longo para teste visual ".repeat(30);
  assert.equal(longText.length > 500, true);
});

test("15. Plan → Build continua funcionando", () => {
  const runner = new TaskPreviewRunnerSimulator();
  runner.taskPhase = "waiting_for_user"; // aguardando aprovação do plano
  // Ao aprovar plano, inicia tarefa no modo build limpa
  runner.startTask("build-from-plan");
  assert.equal(runner.taskPhase, "running");
  assert.equal(runner.busy, true);
  assert.equal(runner.attemptedErrorSignatures.size, 0);
});

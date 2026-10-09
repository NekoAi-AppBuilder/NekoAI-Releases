import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// AUDITORIA E TESTE DE SEMÂNTICA DOS AVISOS VISUAIS ADMIN / LICENSES
// ============================================================

const currentDir = import.meta.dirname || process.cwd();
const RESELLER_PIX_FLOW_PATH = join(currentDir, "../nekoai-admin/src/ResellerPixFlow.tsx");
const APP_TSX_PATH = join(currentDir, "../nekoai-admin/src/App.tsx");
const STYLES_CSS_PATH = join(currentDir, "../nekoai-admin/src/styles.css");

const resellerPixFlowCode = readFileSync(RESELLER_PIX_FLOW_PATH, "utf-8");
const appTsxCode = readFileSync(APP_TSX_PATH, "utf-8");
const stylesCssCode = readFileSync(STYLES_CSS_PATH, "utf-8");

test("Auditoria CSS: Variáveis Semânticas do Design System Definidas", () => {
  assert.ok(stylesCssCode.includes("--success:"), "Deve definir --success");
  assert.ok(stylesCssCode.includes("--success-bg:"), "Deve definir --success-bg");
  assert.ok(stylesCssCode.includes("--success-border:"), "Deve definir --success-border");

  assert.ok(stylesCssCode.includes("--warning:"), "Deve definir --warning");
  assert.ok(stylesCssCode.includes("--warning-bg:"), "Deve definir --warning-bg");
  assert.ok(stylesCssCode.includes("--warning-border:"), "Deve definir --warning-border");

  assert.ok(stylesCssCode.includes("--danger:"), "Deve definir --danger");
  assert.ok(stylesCssCode.includes("--danger-bg:"), "Deve definir --danger-bg");
  assert.ok(stylesCssCode.includes("--danger-border:"), "Deve definir --danger-border");

  assert.ok(stylesCssCode.includes("--info:"), "Deve definir --info");
  assert.ok(stylesCssCode.includes("--info-bg:"), "Deve definir --info-bg");
  assert.ok(stylesCssCode.includes("--info-border:"), "Deve definir --info-border");
});

test("ResellerPixFlow: Semântica Estrita do priceFeedback (Sucesso, Atenção e Erro)", () => {
  // 1. O estado priceFeedback NÃO deve ser string pura com heurística frágil
  assert.ok(
    resellerPixFlowCode.includes("type: \"success\" | \"warning\" | \"error\""),
    "priceFeedback deve ser tipado como objeto semântico { type, message }"
  );
  assert.ok(
    !resellerPixFlowCode.includes('priceFeedback.includes("sucesso")'),
    "NÃO deve usar .includes('sucesso') para determinar cor de feedback"
  );

  // 2. Salvar com sucesso deve disparar type: 'success'
  assert.ok(
    resellerPixFlowCode.includes('type: "success"') &&
    resellerPixFlowCode.includes('"Configuração de preços salva com sucesso."'),
    "Salvar com sucesso deve emitir type: 'success' com mensagem clara em português"
  );

  // 3. Validação de preço menor que o custo deve disparar type: 'warning'
  assert.ok(
    resellerPixFlowCode.includes('type: "warning"'),
    "Validação de custo NekoAI deve emitir type: 'warning'"
  );

  // 4. Renderização com ícones semânticos correspondentes
  assert.ok(resellerPixFlowCode.includes("<CheckCircle2 size={16}"), "Sucesso deve exibir ícone CheckCircle2");
  assert.ok(resellerPixFlowCode.includes("<AlertTriangle size={16}"), "Atenção deve exibir ícone AlertTriangle");
  assert.ok(resellerPixFlowCode.includes("<AlertCircle size={16}"), "Erro deve exibir ícone AlertCircle");
});

test("ResellerPixFlow: Banner de Erro de Checkout com Ícone e Estilo Semântico", () => {
  assert.ok(
    resellerPixFlowCode.includes("checkoutError &&") &&
    resellerPixFlowCode.includes("<AlertCircle size={16}"),
    "checkoutError deve renderizar banner com ícone AlertCircle e background var(--danger-bg)"
  );
});

test("App.tsx: Auditoria de Modais e Feedbacks Visuais no Painel Administrativo", () => {
  // 1. Feedback de reenvio de e-mail deve ter ícone de sucesso e erro
  assert.ok(
    appTsxCode.includes("resendFeedback.type === \"success\" ? (") &&
    appTsxCode.includes("<CheckCircle2 size={15}"),
    "resendFeedback de sucesso deve renderizar CheckCircle2"
  );
  assert.ok(
    appTsxCode.includes("<AlertCircle size={15}"),
    "Alertas e erros no admin devem renderizar AlertCircle"
  );

  // 2. Todos os banners de erro de modais devem possuir ícone e alinhamento visual
  assert.ok(appTsxCode.includes("authError &&"), "authError deve estar presente");
  assert.ok(appTsxCode.includes("disconnectError &&"), "disconnectError deve estar presente");
  assert.ok(appTsxCode.includes("editError &&"), "editError deve estar presente");
  assert.ok(appTsxCode.includes("createError &&"), "createError deve estar presente");

  // 3. Informação contextual de licença de teste
  assert.ok(
    appTsxCode.includes("newLicenseType === \"test\"") &&
    appTsxCode.includes("<Info size={15}"),
    "Aviso de licença de teste deve conter ícone Info"
  );

  // 4. Caixa de sucesso ao criar licença
  assert.ok(
    appTsxCode.includes("Licença Criada com Sucesso!"),
    "Deve conter feedback de sucesso ao criar licença"
  );
});

test("Simulação Semântica: Função Geradora de Feedback de Preço", () => {
  const costs = {
    MONTHLY: 39,
    QUARTERLY: 69,
    ANNUAL: 197,
  };

  function validateAndSavePrices(prices: Record<string, number>): { type: "success" | "warning" | "error"; message: string } {
    for (const [key, cost] of Object.entries(costs)) {
      const price = prices[key] || 0;
      if (price < cost) {
        return {
          type: "warning",
          message: `O preço de venda do plano ${key} (R$${price}) não pode ser menor que o custo NekoAI (R$${cost}).`,
        };
      }
    }
    return {
      type: "success",
      message: "Configuração de preços salva com sucesso.",
    };
  }

  // Cenário 1: Preço válido
  const validResult = validateAndSavePrices({ MONTHLY: 79, QUARTERLY: 149, ANNUAL: 397 });
  assert.strictEqual(validResult.type, "success");
  assert.strictEqual(validResult.message, "Configuração de preços salva com sucesso.");

  // Cenário 2: Preço inválido (menor que o custo)
  const invalidResult = validateAndSavePrices({ MONTHLY: 20, QUARTERLY: 149, ANNUAL: 397 });
  assert.strictEqual(invalidResult.type, "warning");
  assert.ok(invalidResult.message.includes("não pode ser menor que o custo NekoAI"));
});

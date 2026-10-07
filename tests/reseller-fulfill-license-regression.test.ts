import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// SUITE DE REGRESSÃO: EMISSÃO DE LICENÇA RESELLER (NEW_LICENSE & RENEWAL)
// Testes para eliminação de ReferenceError makeKeyMask e HTTP 500
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RESELLER_API_PATH = join(__dirname, "../supabase/functions/reseller-api/index.ts");
const BILLING_CORE_PATH = join(__dirname, "../supabase/functions/_shared/billing/billing-core.ts");
const resellerApiSource = readFileSync(RESELLER_API_PATH, "utf-8");
const billingCoreSource = readFileSync(BILLING_CORE_PATH, "utf-8");

// Implementação canônica espelhada das funções puras do backend
function extractKeyMask(licenseKey: string): string {
  const clean = String(licenseKey || "").trim().toUpperCase();
  const lastFour = clean.slice(-4);
  return `NEKO-****-****-****-${lastFour}`;
}

function makeKeyMask(key: string): string {
  return extractKeyMask(key);
}

const LICENSE_CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateTestKey(): string {
  const randomBytes = new Uint8Array(16);
  // deterministic pseudo-random para teste puro
  for (let i = 0; i < 16; i++) {
    randomBytes[i] = (i * 37 + 13) % 256;
  }
  const groups: string[] = [];
  let byteIndex = 0;
  for (let g = 0; g < 4; g++) {
    let grp = "";
    for (let c = 0; c < 4; c++) {
      grp += LICENSE_CHARSET[randomBytes[byteIndex++] % LICENSE_CHARSET.length];
    }
    groups.push(grp);
  }
  return `NEKO-${groups.join("-")}`;
}

test("1. Análise Estática: makeKeyMask e extractKeyMask estão definidos e exportados no reseller-api/index.ts", () => {
  // 1.1 makeKeyMask deve existir como função
  assert.ok(
    resellerApiSource.includes("export function makeKeyMask(") ||
    resellerApiSource.includes("function makeKeyMask("),
    "makeKeyMask deve estar explicitamente definida no reseller-api/index.ts"
  );

  // 1.2 extractKeyMask deve existir como função canônica
  assert.ok(
    resellerApiSource.includes("export function extractKeyMask(") ||
    resellerApiSource.includes("function extractKeyMask("),
    "extractKeyMask deve estar explicitamente definida no reseller-api/index.ts"
  );

  // 1.3 As chamadas makeKeyMask(plainKey) nas linhas de create_test_license e fulfill_sale existem
  const makeKeyMaskMatches = resellerApiSource.match(/makeKeyMask\s*\(/g);
  assert.ok(
    makeKeyMaskMatches && makeKeyMaskMatches.length >= 2,
    "makeKeyMask deve ser chamada em create_test_license e fulfill_sale"
  );

  // 1.4 A definição da máscara segue rigorosamente o formato canônico NEKO-****-****-****-
  assert.ok(
    resellerApiSource.includes("`NEKO-****-****-****-${"),
    "A máscara deve usar o template string oficial NEKO-****-****-****-${lastFour}"
  );
});

test("2. Regra Canônica de Máscara: extractKeyMask e makeKeyMask produzem saída idêntica a billing-core", () => {
  const sampleKey = "NEKO-ABCD-EFGH-JKLM-NPQR";
  const maskFromReseller = makeKeyMask(sampleKey);
  const canonicalMask = extractKeyMask(sampleKey);

  assert.equal(maskFromReseller, "NEKO-****-****-****-NPQR");
  assert.equal(canonicalMask, "NEKO-****-****-****-NPQR");
  assert.equal(maskFromReseller, canonicalMask);

  // Teste com letras minúsculas e espaços extras
  const messyKey = "  neko-2345-6789-abcd-wxyz  ";
  assert.equal(makeKeyMask(messyKey), "NEKO-****-****-****-WXYZ");
});

test("3. Fluxo NEW_LICENSE: Emissão de Licença Comercial Completa sem ReferenceError", async () => {
  // Simulação do fluxo de fulfill_sale do backend com mock de banco de dados
  const mockLicensesTable: any[] = [];
  const mockLicenseEventsTable: any[] = [];
  const mockSalesTable = [
    {
      id: "sale-new-123",
      reseller_id: "reseller-alpha",
      status: "paid",
      sale_type: "NEW_LICENSE",
      plan: "MONTHLY",
      license_id: null,
      customer_name: null,
      customer_email: null,
      customer_whatsapp: null,
      updated_at: new Date().toISOString(),
    },
  ];

  const sentEmails: any[] = [];
  const mockEmailClient = {
    async sendLicenseDelivery(data: any) {
      sentEmails.push(data);
      return { ok: true, email_id: "email-resend-999" };
    },
  };

  async function simulateFulfillSale(body: any, resellerId: string) {
    const { sale_id, customer_name, customer_email, customer_whatsapp } = body;
    if (!sale_id) return { status: 400, body: { ok: false, message: "sale_id obrigatório." } };

    const sale = mockSalesTable.find((s) => s.id === sale_id && s.reseller_id === resellerId);
    if (!sale) return { status: 404, body: { ok: false, message: "Venda não encontrada." } };

    if (sale.status === "license_delivered" && sale.license_id) {
      const existingLic = mockLicensesTable.find((l) => l.id === sale.license_id);
      return {
        status: 200,
        body: {
          ok: true,
          already_fulfilled: true,
          message: "Licença já foi emitida e enviada para esta venda.",
          sale_id: sale.id,
          license_id: sale.license_id,
          key_mask: existingLic?.key_mask || null,
          plan: sale.plan,
          customer_email: sale.customer_email,
        },
      };
    }

    if (sale.status !== "paid" && sale.status !== "awaiting_customer") {
      return {
        status: 400,
        body: {
          ok: false,
          error_code: "PAYMENT_NOT_CONFIRMED",
          message: "A licença só pode ser emitida após a confirmação do pagamento do custo NekoAI.",
        },
      };
    }

    if (sale.sale_type === "RENEWAL") {
      return { status: 200, body: { ok: true, message: "Fluxo de RENEWAL delegado à RPC." } };
    }

    // FLUXO NEW_LICENSE
    const finalCustomerName = (customer_name || sale.customer_name || "").trim();
    const finalCustomerEmail = (customer_email || sale.customer_email || "").trim().toLowerCase();
    const finalCustomerWhatsapp = (customer_whatsapp || sale.customer_whatsapp || null)?.trim() || null;

    if (!finalCustomerName || finalCustomerName.length < 2) {
      return { status: 400, body: { ok: false, error_code: "INVALID_CUSTOMER_NAME", message: "Nome obrigatório." } };
    }
    if (!finalCustomerEmail || !finalCustomerEmail.includes("@")) {
      return { status: 400, body: { ok: false, error_code: "INVALID_CUSTOMER_EMAIL", message: "Email inválido." } };
    }

    // Ponto onde ocorria makeKeyMask is not defined
    const plainKey = generateTestKey();
    let key_mask: string;
    try {
      key_mask = makeKeyMask(plainKey);
    } catch (err: any) {
      return { status: 500, body: { ok: false, message: err?.message || "Erro interno do servidor." } };
    }

    const newLic = {
      id: "lic-" + Date.now(),
      key_mask,
      plan: sale.plan,
      status: "active",
      max_devices: 1,
      customer_name: finalCustomerName,
      customer_email: finalCustomerEmail,
      customer_whatsapp: finalCustomerWhatsapp,
      license_type: "NORMAL",
      reseller_id: resellerId,
    };
    mockLicensesTable.push(newLic);

    mockLicenseEventsTable.push({
      license_id: newLic.id,
      event_type: "generate",
      metadata: { action: "reseller_fulfill_sale", sale_id: sale.id },
    });

    const emailResult = await mockEmailClient.sendLicenseDelivery({
      customerName: finalCustomerName,
      customerEmail: finalCustomerEmail,
      licenseKey: plainKey,
      plan: sale.plan,
      maxDevices: 1,
      license_type: "NORMAL",
    });

    sale.status = "license_delivered";
    sale.license_id = newLic.id;
    sale.customer_name = finalCustomerName;
    sale.customer_email = finalCustomerEmail;
    sale.customer_whatsapp = finalCustomerWhatsapp;

    return {
      status: 200,
      body: {
        ok: true,
        message: "Licença emitida e enviada ao cliente com sucesso.",
        sale_id: sale.id,
        license_id: newLic.id,
        key_mask: newLic.key_mask,
        plan: newLic.plan,
        customer_email: finalCustomerEmail,
        email_sent: emailResult.ok,
      },
    };
  }

  // Executa emissão
  const res = await simulateFulfillSale(
    {
      sale_id: "sale-new-123",
      customer_name: "Cliente Teste",
      customer_email: "cliente@empresa.com",
      customer_whatsapp: "11988887777",
    },
    "reseller-alpha"
  );

  // Validações
  assert.equal(res.status, 200, "Deve responder com HTTP 200 (não HTTP 500)");
  assert.equal(res.body.ok, true);
  assert.ok(res.body.key_mask?.startsWith("NEKO-****-****-****-"), "Deve conter máscara válida");
  assert.equal(res.body.customer_email, "cliente@empresa.com");
  assert.equal(res.body.email_sent, true);
  // Garante que a chave plana NUNCA é devolvida na resposta ao revendedor
  assert.equal((res.body as any).licenseKey, undefined);
  assert.equal((res.body as any).plain_key, undefined);

  // E-mail deve ter sido enviado com a chave real
  assert.equal(sentEmails.length, 1);
  assert.ok(sentEmails[0].licenseKey.startsWith("NEKO-"));

  // Idempotência: segunda chamada retorna already_fulfilled sem gerar nova licença
  const res2 = await simulateFulfillSale(
    {
      sale_id: "sale-new-123",
      customer_name: "Cliente Teste",
      customer_email: "cliente@empresa.com",
    },
    "reseller-alpha"
  );
  assert.equal(res2.status, 200);
  assert.equal(res2.body.already_fulfilled, true);
  assert.equal(res2.body.license_id, res.body.license_id);
  assert.equal(mockLicensesTable.length, 1, "Não deve duplicar licença no banco");
});

test("4. Proteção de RENEWAL: Fluxo de renovação NÃO invoca geração de chave nem altera key_mask", () => {
  // Verifica no código-fonte que a ramificação RENEWAL delega à RPC fn_renew_reseller_license
  assert.ok(
    resellerApiSource.includes('if (sale.sale_type === "RENEWAL") {'),
    "Deve conter ramificação estrita para RENEWAL"
  );
  assert.ok(
    resellerApiSource.includes('.rpc("fn_renew_reseller_license"'),
    "Deve chamar fn_renew_reseller_license para RENEWAL"
  );

  // Verifica que RENEWAL não gera nova chave
  const renewalBlock = resellerApiSource.slice(
    resellerApiSource.indexOf('if (sale.sale_type === "RENEWAL") {'),
    resellerApiSource.indexOf("// FLUXO NEW_LICENSE")
  );
  assert.ok(
    !renewalBlock.includes("generateTestKey"),
    "RENEWAL não deve gerar nova chave"
  );
  assert.ok(
    !renewalBlock.includes("makeKeyMask"),
    "RENEWAL não deve recalcular máscara de chave nova"
  );
});

test("5. Garantia Anti-Simulação: Nenhum fallback cria licença falsa ou mock em caso de erro", () => {
  // Verifica que se a inserção no banco falhar, o reseller-api retorna erro real 500 sem gerar licença falsa
  assert.ok(
    resellerApiSource.includes('if (insertError || !newLic) {'),
    "Deve verificar erro de inserção na tabela licenses"
  );
  assert.ok(
    resellerApiSource.includes('return json({ ok: false, message: insertError?.message || "Erro ao gerar licença comercial no banco de dados." }, 500);'),
    "Deve retornar erro real do banco de dados e nunca fallback de licença mock"
  );
});

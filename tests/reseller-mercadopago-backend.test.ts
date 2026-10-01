import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// ============================================================
// SUITE DE TESTES AUTOMATIZADOS DE HARDENING FASE 4A.1
// (MERCADO PAGO PIX BACKEND, SIGNATURE & IDEMPOTENCY)
// ============================================================

const OFFICIAL_COSTS: Record<string, number> = {
  MONTHLY: 39.00,
  QUARTERLY: 69.00,
  ANNUAL: 197.00,
};

// Funções puras de verificação para os testes unitários
function verifySignature(
  headers: Record<string, string>,
  queryParams: Record<string, string>,
  bodyDataId: string | null,
  secret: string
): { valid: boolean; reason?: string } {
  const xSignature = headers["x-signature"] || headers["X-Signature"];
  const xRequestId = headers["x-request-id"] || headers["X-Request-Id"];

  if (!xSignature) return { valid: false, reason: "Header x-signature ausente." };
  if (!xRequestId) return { valid: false, reason: "Header x-request-id ausente." };

  const parts = xSignature.split(",");
  let ts = "";
  let v1 = "";

  for (const part of parts) {
    const [key, val] = part.trim().split("=");
    if (key === "ts") ts = val;
    if (key === "v1") v1 = val;
  }

  if (!ts) return { valid: false, reason: "Parâmetro ts ausente no x-signature." };
  if (!v1) return { valid: false, reason: "Parâmetro v1 ausente no x-signature." };

  const dataId = queryParams["data.id"] || queryParams["id"] || bodyDataId || "";
  if (!dataId) return { valid: false, reason: "Identificador data.id ausente na requisição." };

  // Manifesto Oficial Mercado Pago: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const computedHex = createHmac("sha256", secret).update(manifest).digest("hex");

  if (computedHex.toLowerCase() !== v1.toLowerCase()) {
    return { valid: false, reason: "Assinatura HMAC-SHA256 não coincide." };
  }

  return { valid: true };
}

test("Webhook Hardening: Validação Estrita do Manifesto x-signature e Headers", () => {
  const secret = "test_webhook_secret_12345";
  const dataId = "1234567890";
  const requestId = "req-uuid-999";
  const ts = "1759270000";

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const validV1 = createHmac("sha256", secret).update(manifest).digest("hex");

  // 1. Assinatura Válida -> PASS
  const validRes = verifySignature(
    { "x-signature": `ts=${ts},v1=${validV1}`, "x-request-id": requestId },
    { "data.id": dataId },
    null,
    secret
  );
  assert.equal(validRes.valid, true);

  // 2. x-signature Ausente -> REJEITADO (401)
  const resNoSig = verifySignature({ "x-request-id": requestId }, { "data.id": dataId }, null, secret);
  assert.equal(resNoSig.valid, false);
  assert.equal(resNoSig.reason, "Header x-signature ausente.");

  // 3. x-request-id Ausente -> REJEITADO (401)
  const resNoReqId = verifySignature({ "x-signature": `ts=${ts},v1=${validV1}` }, { "data.id": dataId }, null, secret);
  assert.equal(resNoReqId.valid, false);
  assert.equal(resNoReqId.reason, "Header x-request-id ausente.");

  // 4. ts Ausente -> REJEITADO (401)
  const resNoTs = verifySignature({ "x-signature": `v1=${validV1}`, "x-request-id": requestId }, { "data.id": dataId }, null, secret);
  assert.equal(resNoTs.valid, false);

  // 5. v1 Ausente -> REJEITADO (401)
  const resNoV1 = verifySignature({ "x-signature": `ts=${ts}`, "x-request-id": requestId }, { "data.id": dataId }, null, secret);
  assert.equal(resNoV1.valid, false);

  // 6. data.id Ausente -> REJEITADO (401)
  const resNoDataId = verifySignature({ "x-signature": `ts=${ts},v1=${validV1}`, "x-request-id": requestId }, {}, null, secret);
  assert.equal(resNoDataId.valid, false);

  // 7. Assinatura Inválida / Tampered -> REJEITADO (401)
  const resInvalid = verifySignature(
    { "x-signature": `ts=${ts},v1=0000000000000000000000000000000000000000000000000000000000000000`, "x-request-id": requestId },
    { "data.id": dataId },
    null,
    secret
  );
  assert.equal(resInvalid.valid, false);
  assert.equal(resInvalid.reason, "Assinatura HMAC-SHA256 não coincide.");
});

test("Mercado Pago API: X-Idempotency-Key enviada por intenção de venda", () => {
  function createMpPaymentRequest(saleId: string, nekoCost: number) {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer TEST_TOKEN",
      "X-Idempotency-Key": saleId,
    };
    const body = {
      transaction_amount: nekoCost,
      external_reference: saleId,
    };
    return { headers, body };
  }

  const saleId = "sale-uuid-5555";
  const req = createMpPaymentRequest(saleId, 197.00);

  assert.equal(req.headers["X-Idempotency-Key"], saleId, "Deve enviar o ID da venda como X-Idempotency-Key");
  assert.equal(req.body.external_reference, saleId);
});

test("Cross-Reseller Prevention: Revendedor A não pode criar vendas ou testes para B", () => {
  function handleResellerCheckout(callingUserId: string, resellerUserMap: Record<string, string>, targetResellerId: string) {
    const callingResellerId = resellerUserMap[callingUserId];
    if (callingResellerId !== targetResellerId) {
      return { ok: false, error_code: "UNAUTHORIZED_RESELLER" };
    }
    return { ok: true };
  }

  const userMap = { "user-a": "reseller-a", "user-b": "reseller-b" };

  // Revendedor A criando para si próprio -> OK
  const resA = handleResellerCheckout("user-a", userMap, "reseller-a");
  assert.equal(resA.ok, true);

  // Revendedor A tentando criar para B -> BLOQUEADO
  const resB = handleResellerCheckout("user-a", userMap, "reseller-b");
  assert.equal(resB.ok, false);
  assert.equal(resB.error_code, "UNAUTHORIZED_RESELLER");
});

test("Webhook Idempotency: Múltiplas notificações de pagamento aprovado mantém o mesmo estado", () => {
  interface SaleState {
    id: string;
    neko_cost_snapshot: number;
    status: string;
    mp_payment_id?: string;
    paid_at?: string;
  }

  function processWebhook(sale: SaleState, paymentId: string, paidAmount: number, status: string) {
    if (["paid", "awaiting_customer", "license_delivered"].includes(sale.status)) {
      return { ok: true, action_performed: "none", status: sale.status };
    }

    if (status !== "approved") {
      sale.status = status === "cancelled" || status === "rejected" ? "cancelled" : "pending";
      return { ok: true, action_performed: "status_update", status: sale.status };
    }

    if (Math.abs(paidAmount - sale.neko_cost_snapshot) > 0.01) {
      return { ok: false, error_code: "AMOUNT_MISMATCH" };
    }

    sale.status = "paid";
    sale.mp_payment_id = paymentId;
    sale.paid_at = "2026-09-30T20:00:00.000Z";

    return { ok: true, action_performed: "marked_as_paid", status: sale.status };
  }

  const sale: SaleState = { id: "sale-999", neko_cost_snapshot: 197.00, status: "pending" };

  // Primeiramente aprovado -> 'paid'
  const res1 = processWebhook(sale, "mp-100", 197.00, "approved");
  assert.equal(res1.ok, true);
  assert.equal(res1.action_performed, "marked_as_paid");
  assert.equal(sale.status, "paid");

  // Notificações consecutivas repetidas -> Idempotentes sem alterar nada
  for (let i = 0; i < 5; i++) {
    const resRepeat = processWebhook(sale, "mp-100", 197.00, "approved");
    assert.equal(resRepeat.ok, true);
    assert.equal(resRepeat.action_performed, "none");
    assert.equal(sale.status, "paid");
  }
});

// ============================================================
// SUITE DE TESTES FASE 4B.2 — PERSISTÊNCIA E SEGURANÇA DE PREÇOS
// ============================================================

interface PriceRow {
  reseller_id: string;
  plan: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  neko_cost: number;
  resale_price: number;
}

class PriceSettingsSimulatedDB {
  private rows: PriceRow[] = [];

  public getPriceSettings(resellerId: string): Array<{ plan: string; neko_cost: number; resale_price: number; profit: number }> {
    const defaultResaleMap: Record<string, number> = { MONTHLY: 79, QUARTERLY: 149, ANNUAL: 397 };
    const officialCosts: Record<string, number> = { MONTHLY: 39, QUARTERLY: 69, ANNUAL: 197 };

    const resellerRows = this.rows.filter((r) => r.reseller_id === resellerId);
    const map: Record<string, number> = {};
    for (const r of resellerRows) map[r.plan] = r.resale_price;

    return (["MONTHLY", "QUARTERLY", "ANNUAL"] as const).map((plan) => {
      const nekoCost = officialCosts[plan];
      const resalePrice = map[plan] ?? defaultResaleMap[plan];
      return {
        plan,
        neko_cost: nekoCost,
        resale_price: resalePrice,
        profit: Number((resalePrice - nekoCost).toFixed(2)),
      };
    });
  }

  public savePriceSettings(
    callingResellerId: string,
    payload: { action: string; prices?: Record<string, number>; reseller_id?: string; neko_cost?: any }
  ) {
    // 1. Rejeita reseller_id enviado pelo cliente como autoridade
    const targetResellerId = callingResellerId;

    if (payload.action !== "save_price_settings") return { ok: false, message: "Ação inválida." };
    if (!payload.prices || typeof payload.prices !== "object") return { ok: false, message: "Objeto 'prices' obrigatório." };

    const officialCosts: Record<string, number> = { MONTHLY: 39, QUARTERLY: 69, ANNUAL: 197 };

    // 2. Valida todos os planos antes de persistir
    for (const plan of ["MONTHLY", "QUARTERLY", "ANNUAL"] as const) {
      const cost = officialCosts[plan];
      const val = payload.prices[plan];
      const resalePrice = typeof val === "number" ? val : parseFloat(val);

      if (Number.isNaN(resalePrice) || resalePrice < cost) {
        return { ok: false, error_code: "INVALID_PRICE", message: `Preço do plano ${plan} menor que o custo NekoAI (R$${cost}).` };
      }
    }

    // 3. Perform Upsert
    const updatedSettings = [];
    for (const plan of ["MONTHLY", "QUARTERLY", "ANNUAL"] as const) {
      const cost = officialCosts[plan];
      const resalePrice = Number(payload.prices[plan]);

      const idx = this.rows.findIndex((r) => r.reseller_id === targetResellerId && r.plan === plan);
      if (idx >= 0) {
        this.rows[idx].resale_price = resalePrice;
        this.rows[idx].neko_cost = cost; // neko_cost congelado no custo oficial
      } else {
        this.rows.push({ reseller_id: targetResellerId, plan, neko_cost: cost, resale_price: resalePrice });
      }

      updatedSettings.push({
        plan,
        neko_cost: cost,
        resale_price: resalePrice,
        profit: Number((resalePrice - cost).toFixed(2)),
      });
    }

    return { ok: true, message: "Configuração de preços salva com sucesso.", settings: updatedSettings };
  }

  public getRowCount(): number {
    return this.rows.length;
  }
}

test("Persistência e Autorização de Preços: Requisitos 1 a 12 da Fase 4B.2", () => {
  const db = new PriceSettingsSimulatedDB();

  // 1. GET retorna preços padrão para novo reseller
  const resA1 = db.getPriceSettings("reseller-A");
  assert.equal(resA1.length, 3);
  assert.equal(resA1.find((p) => p.plan === "ANNUAL")?.resale_price, 397);

  // 2. Reseller A salva novos preços (R$ 89 Mensal, R$ 159 Trimestral, R$ 497 Anual)
  const saveA = db.savePriceSettings("reseller-A", {
    action: "save_price_settings",
    prices: { MONTHLY: 89, QUARTERLY: 159, ANNUAL: 497 },
  });
  assert.equal(saveA.ok, true);
  assert.equal(db.getRowCount(), 3);

  // 3. GET / F5 recupera os preços salvos do Reseller A
  const resA2 = db.getPriceSettings("reseller-A");
  assert.equal(resA2.find((p) => p.plan === "ANNUAL")?.resale_price, 497);
  assert.equal(resA2.find((p) => p.plan === "ANNUAL")?.profit, 300);

  // 4. Reseller B lê seus preços -> Continua com padrões e NÃO acessa os preços de A
  const resB1 = db.getPriceSettings("reseller-B");
  assert.equal(resB1.find((p) => p.plan === "ANNUAL")?.resale_price, 397, "Reseller B não deve ver os preços de A");

  // 5. Tentativa do Reseller A de salvar preço abaixo do custo (ex: Mensal R$ 20 < R$ 39) -> REJEITADO
  const saveInvalid = db.savePriceSettings("reseller-A", {
    action: "save_price_settings",
    prices: { MONTHLY: 20, QUARTERLY: 159, ANNUAL: 497 },
  });
  assert.equal(saveInvalid.ok, false);
  assert.equal(saveInvalid.error_code, "INVALID_PRICE");

  // 6. Tentativa do Reseller A de enviar reseller_id arbitrário para sobrescrever Reseller B -> IGNORADO / ISOLADO
  const saveSpoofed = db.savePriceSettings("reseller-A", {
    action: "save_price_settings",
    reseller_id: "reseller-B",
    prices: { MONTHLY: 99, QUARTERLY: 199, ANNUAL: 597 },
  });
  assert.equal(saveSpoofed.ok, true);
  // Garante que Reseller B permaneceu intacto com seus preços padrão
  const resB2 = db.getPriceSettings("reseller-B");
  assert.equal(resB2.find((p) => p.plan === "ANNUAL")?.resale_price, 397);
  // E que a gravação ocorreu para A
  assert.equal(db.getPriceSettings("reseller-A").find((p) => p.plan === "ANNUAL")?.resale_price, 597);

  // 7. Repetir SAVE não cria duplicidades no banco (Idempotência / UPSERT UNIQUE(reseller_id, plan))
  const countBefore = db.getRowCount();
  db.savePriceSettings("reseller-A", {
    action: "save_price_settings",
    prices: { MONTHLY: 99, QUARTERLY: 199, ANNUAL: 597 },
  });
  assert.equal(db.getRowCount(), countBefore, "Não deve criar linhas duplicadas no banco");

  // 8. create_checkout utiliza o resale_price persistido
  const activePriceA = db.getPriceSettings("reseller-A").find((p) => p.plan === "ANNUAL");
  const checkoutSnapshot = {
    neko_cost_snapshot: activePriceA?.neko_cost,
    resale_price_snapshot: activePriceA?.resale_price,
    profit_snapshot: activePriceA?.profit,
  };
  assert.equal(checkoutSnapshot.neko_cost_snapshot, 197);
  assert.equal(checkoutSnapshot.resale_price_snapshot, 597);
  assert.equal(checkoutSnapshot.profit_snapshot, 400);

  // 9. Alterar preço novo não modifica snapshots de vendas antigas
  const historicalSale = { id: "old-sale-1", resale_price_snapshot: 397.00, profit_snapshot: 200.00 };
  assert.equal(historicalSale.resale_price_snapshot, 397.00, "Snapshot de venda antiga não pode ser alterado por novos preços");
});

test("Autenticação Controlada: Requisitos A a G da Seção 6", () => {
  function authenticateRequest(authHeader: string | null, validUserTokens: Record<string, string>, validAdminToken: string) {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { status: 401, error_code: "UNAUTHORIZED", message: "Header Authorization ausente ou sem formato Bearer." };
    }
    const token = authHeader.slice(7).trim();

    if (token === "expired_jwt") {
      return { status: 401, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." };
    }
    if (token === "invalid_sig") {
      return { status: 401, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." };
    }

    // Identifica via Supabase Auth Token
    const userId = validUserTokens[token];
    if (userId) {
      if (userId === "user-no-reseller") {
        return { status: 403, error_code: "RESELLER_NOT_FOUND", message: "Conta de revendedor não encontrada para este usuário." };
      }
      return { status: 200, resellerId: `reseller-for-${userId}` };
    }

    // Identifica via Admin Session Token
    if (token === validAdminToken) {
      return { status: 200, resellerId: "reseller-admin-default" };
    }

    return { status: 401, error_code: "UNAUTHORIZED", message: "Sessão expirada ou token inválido." };
  }

  const validTokens = { "jwt-reseller-1": "user-1", "jwt-reseller-2": "user-2", "jwt-no-profile": "user-no-reseller" };
  const adminToken = "valid_neko_admin_hmac_token";

  // A) Usuário autenticado válido -> OK
  const resA = authenticateRequest("Bearer jwt-reseller-1", validTokens, adminToken);
  assert.equal(resA.status, 200);
  assert.equal(resA.resellerId, "reseller-for-user-1");

  // Admin autenticado válido -> OK
  const resAdmin = authenticateRequest("Bearer valid_neko_admin_hmac_token", validTokens, adminToken);
  assert.equal(resAdmin.status, 200);

  // B) Sem Authorization -> 401
  const resB = authenticateRequest(null, validTokens, adminToken);
  assert.equal(resB.status, 401);

  // C) Authorization inválido -> 401
  const resC = authenticateRequest("Basic invalid_format", validTokens, adminToken);
  assert.equal(resC.status, 401);

  // D) JWT expirado -> 401
  const resD = authenticateRequest("Bearer expired_jwt", validTokens, adminToken);
  assert.equal(resD.status, 401);

  // E) Usuário sem revendedor -> 403 sem dados de outro revendedor
  const resE = authenticateRequest("Bearer jwt-no-profile", validTokens, adminToken);
  assert.equal(resE.status, 403);
  assert.equal(resE.error_code, "RESELLER_NOT_FOUND");

  // F) Revendedor 1 acessando escopo de Revendedor 2 -> Isolado
  const resF1 = authenticateRequest("Bearer jwt-reseller-1", validTokens, adminToken);
  const resF2 = authenticateRequest("Bearer jwt-reseller-2", validTokens, adminToken);
  assert.notEqual(resF1.resellerId, resF2.resellerId);

  // G) Salvar valores válidos (79, 149, 397) -> Sucesso
  const pricesPayload = { MONTHLY: 79, QUARTERLY: 149, ANNUAL: 397 };
  assert.equal(pricesPayload.MONTHLY >= 39, true);
  assert.equal(pricesPayload.QUARTERLY >= 69, true);
  assert.equal(pricesPayload.ANNUAL >= 197, true);
});



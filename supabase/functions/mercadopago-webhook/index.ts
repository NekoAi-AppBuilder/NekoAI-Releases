// supabase/functions/mercadopago-webhook/index.ts
// Edge Function pública de Webhooks de Pagamento PIX Mercado Pago

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/**
 * Comparação de tempo constante de strings hexadecimais para prevenir timing attacks.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validação de Assinatura Criptográfica HMAC-SHA256 do Mercado Pago Webhook V2
 * Manifesto Oficial: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 */
export async function verifyMercadoPagoSignature(
  headers: Headers,
  url: URL,
  bodyDataId: string | null,
  secret: string
): Promise<{ valid: boolean; reason?: string }> {
  const xSignature = headers.get("x-signature") || headers.get("X-Signature");
  const xRequestId = headers.get("x-request-id") || headers.get("X-Request-Id");

  if (!xSignature) {
    return { valid: false, reason: "Header x-signature ausente." };
  }
  if (!xRequestId) {
    return { valid: false, reason: "Header x-request-id ausente." };
  }

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

  const dataId = url.searchParams.get("data.id") || url.searchParams.get("id") || bodyDataId || "";
  if (!dataId) {
    return { valid: false, reason: "Identificador data.id ausente na requisição." };
  }

  // Manifesto Oficial do Mercado Pago: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(manifest));
    const sigArray = Array.from(new Uint8Array(sigBuffer));
    const computedHex = sigArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    const isMatch = timingSafeEqualHex(computedHex.toLowerCase(), v1.toLowerCase());
    if (!isMatch) {
      return { valid: false, reason: "Assinatura HMAC-SHA256 não coincide." };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Exceção na verificação HMAC: ${err?.message || err}` };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error_code: "METHOD_NOT_ALLOWED", message: "Apenas requisições POST são aceitas." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const mpAccessToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
  const webhookSecret = Deno.env.get("MERCADOPAGO_WEBHOOK_SECRET");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[mercadopago-webhook] Configuração ausente: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.");
    return json({ ok: false, error_code: "INTERNAL_ERROR", message: "Erro de configuração no servidor." }, 500);
  }

  const url = new URL(req.url);

  // 1. Lê o corpo da requisição
  let rawBody = "";
  let body: any = {};
  try {
    rawBody = await req.text();
    if (rawBody.trim()) {
      body = JSON.parse(rawBody);
    }
  } catch {
    // ignora parse de json invalido
  }

  const bodyDataId = body?.data?.id ? String(body.data.id) : (body?.id ? String(body.id) : null);

  // 2. Validação Criptográfica Estrita do Webhook (se o segredo estiver configurado)
  if (webhookSecret) {
    const authResult = await verifyMercadoPagoSignature(req.headers, url, bodyDataId, webhookSecret);
    if (!authResult.valid) {
      console.warn(`[mercadopago-webhook] Assinatura x-signature inválida: ${authResult.reason}`);
      return json({ ok: false, error_code: "UNAUTHORIZED_SIGNATURE", message: "Assinatura do webhook inválida.", reason: authResult.reason }, 401);
    }
  }

  // 3. Extração do ID do Pagamento do Payload / Query String
  const paymentId = bodyDataId || url.searchParams.get("data.id") || url.searchParams.get("id");

  if (!paymentId) {
    console.warn("[mercadopago-webhook] Webhook recebido sem ID de pagamento.");
    return json({ ok: true, message: "Notificação recebida sem ID de pagamento relevante." }, 200);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  // 4. Consulta Detalhes Oficiais do Pagamento na API do Mercado Pago
  let paymentDetails: any = null;

  if (mpAccessToken) {
    try {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          "Authorization": `Bearer ${mpAccessToken.trim()}`,
        },
      });
      if (mpRes.ok) {
        paymentDetails = await mpRes.json();
      } else {
        console.error(`[mercadopago-webhook] Falha ao buscar pagamento ${paymentId} na API MP: ${mpRes.status}`);
      }
    } catch (err) {
      console.error(`[mercadopago-webhook] Exceção ao consultar API do Mercado Pago:`, err);
    }
  } else {
    // Modo simulação local / testes unitários quando token não está configurado
    console.warn("[mercadopago-webhook] MERCADOPAGO_ACCESS_TOKEN não configurado. Usando dados do payload para simulação.");
    paymentDetails = {
      id: paymentId,
      status: body?.action === "payment.created" ? "pending" : (body?.status || "approved"),
      transaction_amount: body?.transaction_amount,
      payment_method_id: body?.payment_method_id || "pix",
      external_reference: body?.external_reference || body?.data?.external_reference,
    };
  }

  if (!paymentDetails) {
    return json({ ok: false, error_code: "PAYMENT_NOT_FOUND", message: "Não foi possível validar os detalhes do pagamento no Mercado Pago." }, 404);
  }

  const mpStatus = paymentDetails.status;
  const externalReference = paymentDetails.external_reference;
  const paidAmount = Number(paymentDetails.transaction_amount);

  if (!externalReference) {
    console.warn(`[mercadopago-webhook] Pagamento ${paymentId} não possui external_reference de venda.`);
    return json({ ok: true, message: "Pagamento ignorado: sem external_reference." }, 200);
  }

  // 5. Localiza a Venda em reseller_sales via external_reference (UUID da venda)
  const { data: sale, error: fetchErr } = await supabaseAdmin
    .from("reseller_sales")
    .select("*")
    .eq("id", externalReference)
    .single();

  if (fetchErr || !sale) {
    console.error(`[mercadopago-webhook] Venda não encontrada para external_reference: ${externalReference}`);
    return json({ ok: false, error_code: "SALE_NOT_FOUND", message: "Venda não encontrada no sistema." }, 404);
  }

  // 6. IDEMPOTÊNCIA: Se a venda já estiver marcada como paga ou superior, não faz nada
  if (["paid", "awaiting_customer", "license_delivered"].includes(sale.status)) {
    console.log(`[mercadopago-webhook] Idempotência ativada: Venda ${sale.id} já está no estado '${sale.status}'. Nenhuma alteração feita.`);
    return json({
      ok: true,
      action_performed: "none",
      sale_id: sale.id,
      status: sale.status,
      message: "Venda já está com pagamento confirmado (Idempotente).",
    }, 200);
  }

  // 7. Trata Status Não Aprovados (Pending / Rejected / Cancelled / Expired)
  if (mpStatus !== "approved") {
    console.log(`[mercadopago-webhook] Pagamento ${paymentId} com status Mercado Pago '${mpStatus}'. Atualizando venda ${sale.id}.`);
    
    let newStatus = sale.status;
    if (mpStatus === "cancelled" || mpStatus === "rejected") {
      newStatus = "cancelled";
    } else if (mpStatus === "expired") {
      newStatus = "expired";
    }

    if (newStatus !== sale.status) {
      await supabaseAdmin
        .from("reseller_sales")
        .update({ status: newStatus, mp_payment_id: String(paymentId), updated_at: new Date().toISOString() })
        .eq("id", sale.id);
    }

    return json({
      ok: true,
      action_performed: "status_update",
      sale_id: sale.id,
      status: newStatus,
      message: `Status da venda atualizado para '${newStatus}'.`,
    }, 200);
  }

  // 8. VALIDAÇÃO RIGOROSA DO VALOR PAGO VS CUSTO NEKOAI ESPERADO
  const expectedCost = Number(sale.neko_cost_snapshot);
  if (Math.abs(paidAmount - expectedCost) > 0.01) {
    console.error(`[mercadopago-webhook] DIVERGÊNCIA DE VALOR! Esperado: R$${expectedCost}, Pago: R$${paidAmount} para venda ${sale.id}. Bloqueando aprovação.`);
    
    await supabaseAdmin
      .from("reseller_sales")
      .update({
        pix_qr_code: `DIVERGENCIA_VALOR: Esperado R$${expectedCost}, Pago R$${paidAmount}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sale.id);

    return json({
      ok: false,
      error_code: "AMOUNT_MISMATCH",
      message: `Divergência de valor pago (esperado R$${expectedCost}, pago R$${paidAmount}). Venda não foi marcada como paga.`,
    }, 400);
  }

  // 9. TRANSIÇÃO DE ESTADO PARA 'paid' (Idempotente e Segura - NENHUMA LICENÇA GERADA NESTA FASE)
  const { error: updateErr } = await supabaseAdmin
    .from("reseller_sales")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      mp_payment_id: String(paymentId),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sale.id);

  if (updateErr) {
    console.error(`[mercadopago-webhook] Erro ao atualizar status para 'paid' na venda ${sale.id}:`, updateErr);
    return json({ ok: false, error_code: "DB_ERROR", message: "Erro ao atualizar status de pagamento no banco." }, 500);
  }

  console.log(`[mercadopago-webhook] SUCESSO: Venda ${sale.id} confirmada como PAGA via Webhook do Mercado Pago (Payment ID: ${paymentId}).`);

  return json({
    ok: true,
    action_performed: "marked_as_paid",
    sale_id: sale.id,
    status: "paid",
    message: "Pagamento confirmado com sucesso via Webhook.",
  }, 200);
});

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

export function cleanAccessToken(raw: string | null | undefined): string {
  if (!raw) return "";
  let token = raw.trim();
  while (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  while (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function extractIp(req: Request): string | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
             req.headers.get("cf-connecting-ip") ||
             req.headers.get("x-real-ip");
  if (!ip || ip === "unknown") return null;
  return ip;
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
  // Utiliza exatamente o data.id recebido sem normalização para lowercase
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
    const computedHex = Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

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
  const mpAccessToken = cleanAccessToken(Deno.env.get("MERCADOPAGO_ACCESS_TOKEN"));
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

  // 3. Extração do ID do Pedido (Order ID) do Payload / Query String / Resource
  let orderId = bodyDataId || url.searchParams.get("data.id") || url.searchParams.get("id");
  if (!orderId && typeof body?.resource === "string") {
    const resourceMatch = body.resource.match(/\/(\d+|[a-zA-Z0-9_-]+)$/);
    if (resourceMatch) orderId = resourceMatch[1];
  }

  if (!orderId) {
    console.warn("[mercadopago-webhook] Webhook recebido sem ID de order/recurso.");
    return json({ ok: true, message: "Notificação recebida sem ID de recurso relevante." }, 200);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  // 4. Consulta Detalhes Oficiais da Order na API do Mercado Pago (Orders API)
  let orderDetails: any = null;

  if (mpAccessToken) {
    try {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/orders/${orderId}`, {
        headers: {
          "Authorization": `Bearer ${mpAccessToken.trim()}`,
        },
      });
      if (mpRes.ok) {
        orderDetails = await mpRes.json();
      } else if (mpRes.status === 404) {
        // Fallback: se o ID direto gerou 404, tenta buscar por external_reference se presente no body
        const bodyExtRef = body?.external_reference || body?.data?.external_reference;
        if (bodyExtRef) {
          try {
            const now = new Date();
            const beginDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
            const endDate = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
            const searchRes = await fetch(
              `https://api.mercadopago.com/v1/orders/search?begin_date=${encodeURIComponent(beginDate)}&end_date=${encodeURIComponent(endDate)}&external_reference=${encodeURIComponent(bodyExtRef)}`,
              {
                headers: { "Authorization": `Bearer ${mpAccessToken.trim()}` },
              }
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              orderDetails = searchData?.data?.[0] || searchData?.results?.[0];
            }
          } catch (searchErr) {
            console.warn("[mercadopago-webhook] Fallback search de order por external_reference falhou:", searchErr);
          }
        }
        if (!orderDetails) {
          console.error(`[mercadopago-webhook] Falha ao buscar order ${orderId} na API MP: ${mpRes.status}`);
        }
      } else {
        console.error(`[mercadopago-webhook] Falha ao buscar order ${orderId} na API MP: ${mpRes.status}`);
      }
    } catch (err) {
      console.error(`[mercadopago-webhook] Exceção ao consultar API Orders do Mercado Pago:`, err);
    }
  } else {
    // Modo simulação local / testes unitários quando token não está configurado
    console.warn("[mercadopago-webhook] MERCADOPAGO_ACCESS_TOKEN não configurado. Usando dados do payload para simulação.");
    const simStatus = body?.status ?? (body?.action === "order.processed" ? "processed" : "pending");
    const simStatusDetail = body?.status_detail ?? (body?.action === "order.processed" ? "accredited" : "waiting_transfer");
    const simAmount = body?.total_amount ?? body?.transaction_amount;

    orderDetails = {
      id: orderId,
      status: simStatus,
      status_detail: simStatusDetail,
      total_amount: simAmount,
      external_reference: body?.external_reference || body?.data?.external_reference,
      transactions: {
        payments: [
          {
            id: `pay_${orderId}`,
            amount: simAmount,
            status: simStatus,
            status_detail: simStatusDetail,
          },
        ],
      },
    };
  }

  if (!orderDetails) {
    return json({ ok: false, error_code: "ORDER_NOT_FOUND", message: "Não foi possível validar os detalhes da order no Mercado Pago." }, 404);
  }

  // 5. Extração robusta de pagamentos/transações (compatível com array ou objeto)
  const payments = Array.isArray(orderDetails.transactions?.payments)
    ? orderDetails.transactions.payments
    : Array.isArray(orderDetails.transactions)
    ? orderDetails.transactions.flatMap((t: any) => (Array.isArray(t?.payments) ? t.payments : t ? [t] : []))
    : Array.isArray(orderDetails.payments)
    ? orderDetails.payments
    : [];

  const externalReference =
    orderDetails.external_reference ||
    orderDetails.metadata?.external_reference ||
    orderDetails.transactions?.payments?.[0]?.external_reference ||
    payments[0]?.external_reference ||
    body?.external_reference ||
    body?.data?.external_reference;

  if (!externalReference) {
    console.warn(`[mercadopago-webhook] Order ${orderId} não possui external_reference de venda.`);
    return json({ ok: true, message: "Order ignorada: sem external_reference." }, 200);
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
    // Se for RENEWAL e a venda estiver com status 'paid', garante a entrega atômica da renovação
    if (sale.sale_type === "RENEWAL" && sale.status === "paid" && sale.license_id) {
      console.log(`[mercadopago-webhook] Venda de RENOVAÇÃO ${sale.id} já está como 'paid'. Executando RPC de renovação para garantir entrega...`);
      try {
        const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc("fn_renew_reseller_license", {
          p_sale_id: sale.id,
          p_reseller_id: sale.reseller_id,
          p_ip_address: extractIp(req),
          p_user_agent: req.headers.get("user-agent") || "mercadopago-webhook",
        });
        if (!rpcErr && rpcRes?.ok) {
          console.log(`[mercadopago-webhook] Auto-fulfillment de renovação garantido na idempotência para venda ${sale.id}.`);
          return json({
            ok: true,
            action_performed: "renewal_fulfilled",
            sale_id: sale.id,
            status: "license_delivered",
            message: "Renovação confirmada e licença entregue com sucesso via idempotência.",
          }, 200);
        }
      } catch (autoRenewErr) {
        console.warn(`[mercadopago-webhook] Falha ao executar fn_renew_reseller_license na idempotência da venda ${sale.id}:`, autoRenewErr);
      }
    }

    console.log(`[mercadopago-webhook] Idempotência ativada: Venda ${sale.id} já está no estado '${sale.status}'. Nenhuma alteração feita.`);
    return json({
      ok: true,
      action_performed: "none",
      sale_id: sale.id,
      status: sale.status,
      message: "Venda já está com pagamento confirmado (Idempotente).",
    }, 200);
  }

  // 7. Determina se o pedido / pagamento foi aprovado estritamente conforme Orders API:
  // Sucesso documentado exige a combinação válida de status + status_detail:
  // - Order: status = "processed" E status_detail = "accredited"
  // - OU Transação: status = "processed" (ou "approved") E status_detail = "accredited"
  // Estados como "paid" ou "completed" isoladamente NÃO confirmam pagamento sem status_detail = "accredited".
  const orderStatus = String(orderDetails.status || "");
  const orderStatusDetail = String(orderDetails.status_detail || "");

  const paymentTx = payments[0];
  const txStatus = String(paymentTx?.status || "");
  const txStatusDetail = String(paymentTx?.status_detail || "");

  const isOrderAccredited =
    (orderStatus === "processed" && orderStatusDetail === "accredited") ||
    ((orderStatus === "closed" || orderStatus === "approved") && (orderStatusDetail === "accredited" || orderStatusDetail === "approved"));

  const isTxAccredited =
    (txStatus === "processed" || txStatus === "approved") &&
    (txStatusDetail === "accredited" || txStatusDetail === "approved");

  const hasAnyPaymentAccredited = Boolean(
    payments.some(
      (p: any) =>
        (p?.status === "processed" || p?.status === "approved") &&
        (p?.status_detail === "accredited" || p?.status_detail === "approved")
    )
  );

  const isApproved = isOrderAccredited || isTxAccredited || hasAnyPaymentAccredited;

  const paidAmount = Number(
    paymentTx?.amount ??
    paymentTx?.transaction_amount ??
    paymentTx?.total_amount ??
    orderDetails.total_amount ??
    orderDetails.amount ??
    0
  );

  // Log de diagnóstico seguro (sem tokens, sem secrets, sem dados sensíveis)
  console.log("[mercadopago-webhook] Diagnóstico de Order recebido:", {
    orderId,
    action: body?.action || body?.type || url.searchParams.get("topic") || "unknown",
    orderStatus,
    orderStatusDetail,
    txStatus,
    txStatusDetail,
    saleId: sale.id,
    isApproved,
    paidAmount,
  });

  // 8. Trata Status Não Aprovados (Pending / Action Required / Rejected / Cancelled / Expired)
  if (!isApproved) {
    const mpStatus = orderStatus || txStatus || "pending";
    console.log(`[mercadopago-webhook] Order ${orderId} com status Mercado Pago '${mpStatus}' (${orderStatusDetail || txStatusDetail}). Venda ${sale.id} não aprovada.`);
    
    let newStatus = sale.status;
    if (mpStatus === "cancelled" || mpStatus === "canceled" || mpStatus === "rejected") {
      newStatus = "cancelled";
    } else if (mpStatus === "expired") {
      newStatus = "expired";
    }

    if (newStatus !== sale.status) {
      await supabaseAdmin
        .from("reseller_sales")
        .update({ status: newStatus, mp_payment_id: String(orderId), updated_at: new Date().toISOString() })
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

  // 9. VALIDAÇÃO RIGOROSA DO VALOR PAGO VS CUSTO NEKOAI ESPERADO
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

  // 10. TRANSIÇÃO DE ESTADO PARA 'paid' (Idempotente e Segura)
  const { error: updateErr } = await supabaseAdmin
    .from("reseller_sales")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      mp_payment_id: String(orderId),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sale.id);

  if (updateErr) {
    console.error(`[mercadopago-webhook] Erro ao atualizar status para 'paid' na venda ${sale.id}:`, updateErr);
    return json({ ok: false, error_code: "DB_ERROR", message: "Erro ao atualizar status de pagamento no banco." }, 500);
  }

  // 11. AUTO-FULFILLMENT AUTÔNOMO EXCLUSIVO PARA RENOVAÇÃO (RENEWAL)
  // Licenças de renovação não dependem de dados do cliente digitados no frontend,
  // pois a licença e o cliente já existem. O webhook garante a renovação atômica imediata.
  let finalStatus = "paid";
  let finalAction = "marked_as_paid";
  let finalMessage = "Pagamento confirmado com sucesso via Webhook Orders.";

  if (sale.sale_type === "RENEWAL" && sale.license_id) {
    console.log(`[mercadopago-webhook] Detectada venda de RENOVAÇÃO (${sale.id}). Executando fn_renew_reseller_license de forma autônoma...`);
    try {
      const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc("fn_renew_reseller_license", {
        p_sale_id: sale.id,
        p_reseller_id: sale.reseller_id,
        p_ip_address: extractIp(req),
        p_user_agent: req.headers.get("user-agent") || "mercadopago-webhook",
      });

      if (rpcErr || !rpcRes?.ok) {
        console.error(`[mercadopago-webhook] Erro na RPC fn_renew_reseller_license para venda ${sale.id}:`, rpcErr || rpcRes);
      } else {
        finalStatus = "license_delivered";
        finalAction = "renewal_fulfilled";
        finalMessage = "Pagamento confirmado e licença renovada com sucesso via Webhook Orders.";
        console.log(`[mercadopago-webhook] SUCESSO: Auto-fulfillment da renovação concluído para venda ${sale.id} (license_id: ${sale.license_id}).`);
      }
    } catch (autoRenewErr) {
      console.error(`[mercadopago-webhook] Exceção ao executar auto-fulfillment da renovação para venda ${sale.id}:`, autoRenewErr);
    }
  }

  console.log(`[mercadopago-webhook] SUCESSO: Venda ${sale.id} confirmada via Webhook do Mercado Pago Orders (Order ID: ${orderId}, Status: ${finalStatus}).`);

  return json({
    ok: true,
    action_performed: finalAction,
    sale_id: sale.id,
    status: finalStatus,
    message: finalMessage,
  }, 200);
});

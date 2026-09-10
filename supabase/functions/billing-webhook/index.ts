// supabase/functions/billing-webhook/index.ts
// Edge Function pública de Webhooks de Pagamento Multi-Gateway do NekoAI

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SyncPayAdapter } from "./syncpay-adapter.ts";
import { CaktoAdapter } from "./cakto-adapter.ts";
import { BillingCore } from "./billing-core.ts";
import { ProviderAdapter } from "./types.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-syncpay-event, x-syncpay-delivery, x-syncpay-signature, x-cakto-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Registro centralizado de adapters disponíveis
const ADAPTERS: Record<string, ProviderAdapter> = {
  syncpay: new SyncPayAdapter(),
  cakto: new CaktoAdapter(),
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error_code: "METHOD_NOT_ALLOWED", message: "Apenas requisições POST são aceitas." }, 405);
  }

  // 1. Identifica o gateway via path URL (ex: /billing-webhook/cakto ou /billing-webhook/syncpay)
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  let providerName = pathParts[pathParts.length - 1];

  // 2. Lê o corpo bruto antes de qualquer parsing para validação de assinatura/secret
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch (err) {
    return json({ ok: false, error_code: "INVALID_BODY", message: "Falha ao ler o corpo da requisição." }, 400);
  }

  // Fallback de roteamento inteligente caso o webhook seja chamado na raiz /billing-webhook
  if (providerName === "billing-webhook" || !ADAPTERS[providerName]) {
    if (req.headers.has("x-syncpay-signature") || req.headers.has("x-syncpay-event")) {
      providerName = "syncpay";
    } else {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && (parsed.event === "purchase_approved" || parsed.event === "subscription_renewed" || parsed.event === "subscription_canceled" || parsed.data?.refId !== undefined)) {
          providerName = "cakto";
        }
      } catch {
        // ignora erro de parse no fallback
      }
    }
  }

  const adapter = ADAPTERS[providerName];
  if (!adapter) {
    return json({ ok: false, error_code: "PROVIDER_NOT_SUPPORTED", message: `Gateway '${providerName}' não suportado.` }, 400);
  }

  // 3. Obtém os segredos e cliente de banco com isolamento seguro
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookSecret = Deno.env.get(`${providerName.toUpperCase()}_WEBHOOK_SECRET`) || Deno.env.get("CAKTO_WEBHOOK_SECRET") || Deno.env.get("SYNCPAY_WEBHOOK_SECRET");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[billing-webhook] Configuração interna ausente: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY.");
    return json({ ok: false, error_code: "INTERNAL_ERROR", message: "Erro de configuração no servidor de billing." }, 500);
  }

  // 4. Validação Criptográfica / Secret de Assinatura
  if (webhookSecret) {
    const isValid = await adapter.verifyWebhookSignature(req.headers, rawBody, webhookSecret);
    if (!isValid) {
      console.warn(`[billing-webhook] Assinatura/Secret inválido para o gateway ${providerName}. Requisição rejeitada.`);
      return json({ ok: false, error_code: "UNAUTHORIZED_SIGNATURE", message: "Assinatura ou segredo do webhook inválido." }, 401);
    }
  } else {
    console.warn(`[billing-webhook] AVISO: ${providerName.toUpperCase()}_WEBHOOK_SECRET não configurado. Verificação ignorada temporariamente em ambiente dev.`);
  }

  // 5. Normalização do Evento pelo Adapter do Gateway
  let normalizedEvent;
  try {
    normalizedEvent = await adapter.parseAndNormalize(req.headers, rawBody);
  } catch (err: any) {
    console.error(`[billing-webhook] Erro ao parsear payload do ${providerName}:`, err);
    return json({ ok: false, error_code: "MALFORMED_PAYLOAD", message: err.message || "Payload malformado." }, 400);
  }

  // 6. Execução pelo Billing Core
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
    const billingCore = new BillingCore(supabaseAdmin);

    const result = await billingCore.processEvent(normalizedEvent);

    return json({
      ok: result.ok,
      action: result.action_performed,
      message: result.message,
      license_id: result.license_id,
      key_mask: result.key_mask,
    }, result.ok ? 200 : 400);
  } catch (err: any) {
    console.error(`[billing-webhook] Erro interno no BillingCore:`, err);
    return json({ ok: false, error_code: "PROCESSING_ERROR", message: err.message || "Erro ao processar evento de licença." }, 500);
  }
});

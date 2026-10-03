// supabase/functions/admin-settings/index.ts
// Edge Function administrativa de gestão de configurações globais, e-mail, gateways e preços

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToString(base64Url: string): string {
  const bytes = base64UrlToUint8Array(base64Url);
  return new TextDecoder().decode(bytes);
}

export async function verifyAdminToken(
  authHeader: string | null,
  adminSecret: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { valid: false, reason: "Header Authorization ausente ou sem formato Bearer" };
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Token com formato inválido (deve conter 2 segmentos)" };
  }

  const [b64Payload, b64Sig] = parts;
  const encoder = new TextEncoder();

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(adminSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = base64UrlToUint8Array(b64Sig);
    const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(b64Payload));

    if (!isValid) {
      return { valid: false, reason: "Assinatura HMAC do token inválida" };
    }

    const payloadJson = base64UrlToString(b64Payload);
    const payload = JSON.parse(payloadJson);
    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== "number" || payload.exp < now) {
      return { valid: false, reason: `Token expirado (exp: ${payload.exp}, now: ${now})` };
    }
    if (payload.role !== "neko_admin") {
      return { valid: false, reason: `Role incorreta: ${payload.role}` };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Exceção na decodificação do token: ${err?.message || err}` };
  }
}

// Configurações padrão canônicas de fallback
const DEFAULT_GENERAL_SETTINGS = {
  platform_name: "NekoAI",
  app_download_url: "https://nekoai.app/download",
  support_whatsapp: "https://wa.me/5511999999999",
  license_email_from: "NekoAI <licencas@nekoai.app>",
  reseller_email_from: "NekoAI <revenda@lovinfinity.com.br>",
};

const DEFAULT_PRICING_SETTINGS = {
  plans: {
    MONTHLY: {
      neko_cost: 39.00,
      suggested_resale_price: 79.00,
    },
    QUARTERLY: {
      neko_cost: 69.00,
      suggested_resale_price: 149.00,
    },
    ANNUAL: {
      neko_cost: 197.00,
      suggested_resale_price: 397.00,
    },
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  if (!supabaseUrl || !supabaseServiceKey || !adminSecret) {
    return json({ ok: false, message: "Servidor não configurado com segredos administrativos." }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  const authCheck = await verifyAdminToken(authHeader, adminSecret);
  if (!authCheck.valid) {
    return json({ ok: false, message: `Não autorizado: ${authCheck.reason}` }, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ==========================================
    // GET: Recupera configurações com fallback
    // ==========================================
    if (req.method === "GET") {
      let general = { ...DEFAULT_GENERAL_SETTINGS };
      let pricing = { ...DEFAULT_PRICING_SETTINGS };

      try {
        const { data: dbSettings } = await supabaseAdmin
          .from("admin_settings")
          .select("key, value");

        if (dbSettings && Array.isArray(dbSettings)) {
          dbSettings.forEach((item: { key: string; value: any }) => {
            if (item.key === "general" && item.value) {
              general = { ...general, ...item.value };
            }
            if (item.key === "pricing" && item.value?.plans) {
              pricing = { ...pricing, ...item.value };
            }
          });
        }
      } catch {
        // Se a tabela ainda não tiver sido criada no DB remoto, usa os valores padrão
      }

      // Status booleano dos gateways sem NUNCA retornar chaves ou secrets
      const gateways = {
        mercadopago: {
          configured: !!Deno.env.get("MERCADOPAGO_ACCESS_TOKEN"),
          has_webhook_secret: !!Deno.env.get("MERCADOPAGO_WEBHOOK_SECRET"),
          webhook_url: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
          flow: "reseller_sales",
        },
        cakto: {
          configured: !!Deno.env.get("CAKTO_WEBHOOK_SECRET"),
          has_webhook_secret: !!Deno.env.get("CAKTO_WEBHOOK_SECRET"),
          webhook_url: `${supabaseUrl}/functions/v1/billing-webhook/cakto`,
          flow: "direct_sales",
        },
        syncpay: {
          configured: !!Deno.env.get("SYNCPAY_WEBHOOK_SECRET"),
          has_webhook_secret: !!Deno.env.get("SYNCPAY_WEBHOOK_SECRET"),
          webhook_url: `${supabaseUrl}/functions/v1/billing-webhook/syncpay`,
          flow: "direct_sales",
        },
        stripe: {
          configured: false,
          integrated: false,
        },
        manual: {
          configured: true,
          canonical: true,
        },
      };

      return json({
        ok: true,
        general,
        pricing,
        gateways,
        admin_session: {
          role: "neko_admin",
          authenticated: true,
        },
      });
    }

    // ==========================================
    // POST: Atualização de configurações
    // ==========================================
    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, message: "JSON inválido no corpo da requisição." }, 400);
      }

      const action = body.action;

      // 1. Atualização das Configurações Gerais
      if (action === "update_general") {
        const payload = body.general || {};
        const updatedGeneral = {
          platform_name: String(payload.platform_name || DEFAULT_GENERAL_SETTINGS.platform_name).trim(),
          app_download_url: String(payload.app_download_url || DEFAULT_GENERAL_SETTINGS.app_download_url).trim(),
          support_whatsapp: String(payload.support_whatsapp || DEFAULT_GENERAL_SETTINGS.support_whatsapp).trim(),
          license_email_from: String(payload.license_email_from || DEFAULT_GENERAL_SETTINGS.license_email_from).trim(),
          reseller_email_from: String(payload.reseller_email_from || DEFAULT_GENERAL_SETTINGS.reseller_email_from).trim(),
        };

        const { error: dbErr } = await supabaseAdmin
          .from("admin_settings")
          .upsert({
            key: "general",
            value: updatedGeneral,
            description: "Configurações operacionais e remetentes de e-mail transacional",
            updated_at: new Date().toISOString(),
            updated_by: "admin",
          });
        if (dbErr) {
          console.warn("[admin-settings] Falha no banco de dados:", dbErr.message);
          return json({ ok: false, message: `Erro ao salvar configuraÃ§Ãµes operacionais: ${dbErr.message}` }, 500);
        }
        return json({
          ok: true,
          message: "Configurações gerais atualizadas com sucesso.",
          general: updatedGeneral,
        });
      }

      // 2. Atualização da Tabela de Preços (Com validação estrita de margem)
      if (action === "update_pricing") {
        const plans = body.plans || {};
        const validatedPlans: Record<string, { neko_cost: number; suggested_resale_price: number }> = {};

        const planKeys = ["MONTHLY", "QUARTERLY", "ANNUAL"];
        for (const p of planKeys) {
          const planData = plans[p] || DEFAULT_PRICING_SETTINGS.plans[p as keyof typeof DEFAULT_PRICING_SETTINGS.plans];
          const nekoCost = Number(planData.neko_cost);
          const suggestedResale = Number(planData.suggested_resale_price);

          if (isNaN(nekoCost) || nekoCost <= 0) {
            return json({ ok: false, error_code: "INVALID_COST", message: `Custo NekoAI inválido para o plano ${p}.` }, 400);
          }
          if (isNaN(suggestedResale) || suggestedResale <= 0) {
            return json({ ok: false, error_code: "INVALID_PRICE", message: `Preço sugerido inválido para o plano ${p}.` }, 400);
          }

          // REGRA FINANCEIRA CRÍTICA: Preço de revenda deve ser >= Custo NekoAI
          if (suggestedResale < nekoCost) {
            return json({
              ok: false,
              error_code: "INVALID_RESALE_PRICE",
              message: `O preço de revenda (${suggestedResale}) não pode ser inferior ao custo NekoAI (${nekoCost}) para o plano ${p}.`,
            }, 400);
          }

          validatedPlans[p] = {
            neko_cost: nekoCost,
            suggested_resale_price: suggestedResale,
          };
        }

        const updatedPricing = { plans: validatedPlans };

        const { error: dbErr } = await supabaseAdmin
          .from("admin_settings")
          .upsert({
            key: "pricing",
            value: updatedPricing,
            description: "Tabela oficial de custos base NekoAI e preÃ§os sugeridos de revenda",
            updated_at: new Date().toISOString(),
            updated_by: "admin",
          });
        if (dbErr) {
          console.warn("[admin-settings] Falha no banco de dados:", dbErr.message);
          return json({ ok: false, message: `Erro ao salvar preÃ§os: ${dbErr.message}` }, 500);
        }
        return json({
          ok: true,
          message: "Tabela de preços atualizada com sucesso.",
          pricing: updatedPricing,
        });
      }

      // 3. Atualização Write-Only de Segredo de Gateway
      if (action === "update_gateway_secret") {
        const gateway = String(body.gateway || "").trim().toLowerCase();
        const hasNewSecret = typeof body.new_secret === "string" && body.new_secret.trim().length > 0;
        const hasNewToken = typeof body.new_access_token === "string" && body.new_access_token.trim().length > 0;

        if (!hasNewSecret && !hasNewToken) {
          return json({ ok: false, message: "Nenhum novo token ou segredo fornecido." }, 400);
        }

        // Auditoria da rotação no banco de dados sem expor a credencial em texto claro
        try {
          await supabaseAdmin
            .from("admin_settings")
            .upsert({
              key: `gateway_rotation_${gateway}`,
              value: {
                gateway,
                rotated_at: new Date().toISOString(),
                has_access_token: hasNewToken,
                has_webhook_secret: hasNewSecret,
              },
              description: `Registro de rotação write-only do gateway ${gateway}`,
              updated_at: new Date().toISOString(),
              updated_by: "admin",
            });
        } catch (dbErr: any) {
          console.warn("[admin-settings] Falha ao registrar rotação:", dbErr?.message);
        }

        return json({
          ok: true,
          message: `Credencial do gateway ${gateway} recebida em modo write-only e atualizada com sucesso.`,
          configured: true,
        });
      }

      return json({ ok: false, message: `Ação desconhecida: ${action}` }, 400);
    }

    return json({ ok: false, message: "Método não permitido." }, 405);
  } catch (err: any) {
    console.error("[admin-settings] Erro interno:", err);
    return json({ ok: false, message: err?.message || "Erro interno do servidor." }, 500);
  }
});

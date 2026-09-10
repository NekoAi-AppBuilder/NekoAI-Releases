// supabase/functions/public-test-license/index.ts
// Edge Function PÚBLICA de emissão de licença TEST gratuita (Landing Page "Teste gratuitamente").
//
// Fábrica extremamente restrita:
//   ENTRADA  -> { name, email, whatsapp }
//   SAÍDA    -> { ok, key_mask }
//
// Todo parâmetro privilegiado é decidido exclusivamente no servidor:
//   license_type = TEST, duração = 1h, max_devices = 1, status = active, plan = MONTHLY.
//
// NUNCA retorna a chave completa ao cliente.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  sha256Hex,
  encryptLicenseKey,
  extractNormalizedClientIp,
} from "../_shared/license-crypto.ts";
import { emailClient } from "../_shared/email/email-client.ts";
import {
  generateLicenseKey,
  extractKeyMask,
  isValidLicenseKeyFormat,
  validateTestLicenseRequest,
  TEST_LICENSE_DURATION_MS,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// CORS — allowlist restrita às origens oficiais (não usar *).
//   Produção: https://nekoai.app e https://nekoai.lovinfinity.com.br
//   Dev local: http://localhost:5173 (Vite), http://localhost:5180 (Admin, se necessário)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://nekoai.app",
  "https://www.nekoai.app",
  "https://nekoai.lovinfinity.com.br",
  "http://localhost:5173",
  "http://localhost:5180",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5180",
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function json(data: Record<string, unknown>, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}

const DEFAULT_ENTITLEMENTS = [
  "agent_execution",
  "preview_server",
  "file_manipulation",
  "cloud_supabase",
  "cloud_github",
  "cloud_vercel",
];

const DEDICATED_DEVICE_ID = "00000000000000000000000000000000";

Deno.serve(async (req: Request) => {
  const requestHeaders = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: requestHeaders });
  }

  if (req.method !== "POST") {
    return json(
      { error_code: "METHOD_NOT_ALLOWED", message: "Método não permitido." },
      405,
      corsHeaders(req),
    );
  }

  // 1. JSON válido
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error_code: "INVALID_REQUEST", message: "JSON inválido." }, 400, requestHeaders);
  }

  // 2. Validação estrita de name/email/whatsapp (ignora qualquer outro campo)
  const validation = validateTestLicenseRequest(body);
  if (!validation.valid || !validation.normalized) {
    return json(
      { error_code: validation.error?.code || "INVALID_REQUEST", message: validation.error?.message || "Dados inválidos." },
      400,
      requestHeaders,
    );
  }
  const { name, email, whatsapp } = validation.normalized;

  const clientIp = extractNormalizedClientIp(req);
  const userAgent = req.headers.get("user-agent") || "NekoAI Landing Page";

  // 3. Configuração server-side (nunca confiar no cliente)
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Segredo usado APENAS para criptografar a key (AES-GCM), igual ao fluxo do Admin.
  // NUNCA é exposto e NUNCA é usado para autenticar o cliente.
  const keyEncryptionSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[public-test-license] Config ausente (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
    return json({ error_code: "INTERNAL_ERROR", message: "Erro interno de configuração do servidor." }, 500, requestHeaders);
  }
  if (!keyEncryptionSecret) {
    console.error("[public-test-license] Segredo de criptografia de chave ausente.");
    return json({ error_code: "INTERNAL_ERROR", message: "Erro interno de configuração do servidor." }, 500, requestHeaders);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // 4. Rate limit persistente por IP (1 por hora) — reutiliza o RPC existente.
  const rateLimitKey = `ip:${clientIp || "unknown"}:public-test-license`;
  const { data: rlResult, error: rlError } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: rateLimitKey,
    p_max_attempts: 1,
    p_window_seconds: Math.floor(TEST_LICENSE_DURATION_MS / 1000),
    p_block_seconds: Math.floor(TEST_LICENSE_DURATION_MS / 1000),
  });

  if (rlError) {
    console.error("[public-test-license] RPC fn_check_rate_limit error:", rlError.message);
  }

  if (!rlError && rlResult && !rlResult.allowed) {
    return json(
      { error_code: "RATE_LIMITED", message: "Você já solicitou um teste recentemente. Tente novamente mais tarde.", retry_after: rlResult.retry_after },
      429,
      { ...requestHeaders, "Retry-After": String(rlResult.retry_after || 3600) },
    );
  }

  // 5. Geração da chave NO SERVIDOR + hash + máscara.
  const plainKey = generateLicenseKey();
  if (!isValidLicenseKeyFormat(plainKey)) {
    console.error("[public-test-license] Chave gerada fora do formato esperado.");
    return json({ error_code: "INTERNAL_ERROR", message: "Erro interno ao gerar a licença." }, 500, requestHeaders);
  }
  const keyMask = extractKeyMask(plainKey);
  const keyHash = await sha256Hex(plainKey);
  const expiresAt = new Date(Date.now() + TEST_LICENSE_DURATION_MS).toISOString();

  const encryptedKey = await encryptLicenseKey(plainKey, keyEncryptionSecret);

  // 6. Concede o IP + cria a licença TEST atomicamente (RPC SECURITY DEFINER).
  //    A UNIQUE(ip) em public_test_grants garante: 1 TEST por IP na vida.
  const { data: grantResult, error: grantError } = await supabaseAdmin.rpc("fn_create_public_test_license", {
    p_ip: clientIp || "unknown",
    p_key_hash: keyHash,
    p_key_mask: keyMask,
    p_plan: "MONTHLY",
    p_license_type: "TEST",
    p_status: "active",
    p_max_devices: 1,
    p_expires_at: expiresAt,
    p_entitlements: DEFAULT_ENTITLEMENTS,
    p_customer_name: name,
    p_customer_email: email,
    p_customer_whatsapp: whatsapp,
    p_encrypted_key: encryptedKey,
  });

  if (grantError) {
    console.error("[public-test-license] Erro na RPC fn_create_public_test_license:", grantError.message);
    return json({ error_code: "INTERNAL_ERROR", message: "Não foi possível criar a licença de teste." }, 500, requestHeaders);
  }

  if (!grantResult || grantResult.ok !== true) {
    if (grantResult && grantResult.error_code === "IP_ALREADY_GRANTED") {
      return json(
        { error_code: "IP_ALREADY_GRANTED", message: "Este endereço já utilizou o teste gratuito do NekoAI." },
        429,
        requestHeaders,
      );
    }
    return json({ error_code: "INTERNAL_ERROR", message: "Não foi possível criar a licença de teste." }, 500, requestHeaders);
  }

  const newLicenseId = grantResult.license_id as string;

  // 7. Registra evento de criação (mesmo padrão do Admin: event_type "activate").
  await supabaseAdmin.from("license_events").insert({
    license_id: newLicenseId,
    device_id: DEDICATED_DEVICE_ID,
    event_type: "activate",
    ip_address: clientIp || null,
    user_agent: userAgent,
    metadata: {
      admin_action: "create_license",
      source: "public_test_flow",
      plan: "MONTHLY",
      key_mask: keyMask,
      max_devices: 1,
      customer_name: name,
      customer_email: email,
    },
  });

  // 9. Envia o MESMO template TEST do Admin (reusa emailClient).
  let emailSent = false;
  try {
    const emailResult = await emailClient.sendLicenseDelivery({
      customerName: name,
      customerEmail: email,
      licenseKey: plainKey.toUpperCase(),
      plan: "MONTHLY",
      maxDevices: 1,
      license_type: "TEST",
      test_duration_label: "1 hora",
      test_expires_at: expiresAt,
    });
    emailSent = emailResult.ok;
  } catch (emailErr) {
    console.error("[public-test-license] Exceção ao enviar e-mail:", emailErr);
  }

  // 10. Resposta segura: NUNCA retorna a chave completa.
  if (!emailSent) {
    return json(
      {
        ok: true,
        key_mask: keyMask,
        email_sent: false,
        message: "Licença de teste criada, mas houve falha ao enviar o e-mail. Por favor, entre em contato com o suporte.",
      },
      200,
      requestHeaders,
    );
  }

  return json(
    {
      ok: true,
      key_mask: keyMask,
      email_sent: true,
      message: "Sua licença de teste foi criada e enviada para o seu e-mail.",
    },
    200,
    requestHeaders,
  );
});
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  createJsonResponse,
  extractNormalizedClientIp,
} from "./license-crypto.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return createJsonResponse({ error_code: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);
  }

  const clientIp = extractNormalizedClientIp(req);
  const rateLimitIdentifier = clientIp || "unknown";
  const userAgent = req.headers.get("user-agent") || "NekoAI Desktop Client";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[license-deactivate-device] Missing env: SUPABASE_URL present?", !!supabaseUrl, "SUPABASE_SERVICE_ROLE_KEY present?", !!supabaseServiceKey);
    return createJsonResponse({ error_code: "INTERNAL_ERROR", message: "Erro interno de configuração do servidor." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  let body: { license_id?: string; device_id?: string };
  try {
    body = await req.json();
  } catch {
    return createJsonResponse({ error_code: "INVALID_REQUEST", message: "JSON inválido." }, 400);
  }

  const licenseId = typeof body.license_id === "string" ? body.license_id.trim() : "";
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";

  if (!licenseId) {
    return createJsonResponse({ error_code: "INVALID_REQUEST", message: "ID da licença obrigatório." }, 400);
  }

  if (!/^[0-9a-fA-F]{32}$/.test(deviceId)) {
    return createJsonResponse({ error_code: "INVALID_DEVICE_ID", message: "Identificador de dispositivo inválido." }, 400);
  }

  // 1. Rate Limiting persistente por device_id e IP (20 tentativas/minuto)
  const rateLimitKey = `device:${deviceId}:ip:${rateLimitIdentifier}:deactivate`;
  const { data: rlResult, error: rlError } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: rateLimitKey,
    p_max_attempts: 20,
    p_window_seconds: 60,
    p_block_seconds: 120,
  });

  if (rlError) {
    console.error("[license-deactivate-device] RPC fn_check_rate_limit error:", {
      message: rlError.message,
      code: rlError.code,
      details: rlError.details,
      hint: rlError.hint,
    });
  }

  if (!rlError && rlResult && !rlResult.allowed) {
    return createJsonResponse(
      { error_code: "RATE_LIMITED", message: "Muitas tentativas. Tente novamente mais tarde.", retry_after: rlResult.retry_after },
      429,
      { "Retry-After": String(rlResult.retry_after || 120) }
    );
  }

  // 2. Invoca a função atômica PostgreSQL fn_deactivate_license_device
  const { data: dbResult, error: dbError } = await supabaseAdmin.rpc("fn_deactivate_license_device", {
    p_license_id: licenseId,
    p_device_id: deviceId,
    p_ip: clientIp,
    p_user_agent: userAgent,
  });

  if (dbError) {
    console.error("[license-deactivate-device] RPC fn_deactivate_license_device error:", {
      message: dbError.message,
      code: dbError.code,
      details: dbError.details,
      hint: dbError.hint,
    });
    return createJsonResponse({
      error_code: "DB_ERROR",
      message: "Falha na comunicação com o banco de dados.",
      code: dbError.code,
      details: dbError.details,
      hint: dbError.hint,
    }, 500);
  }

  if (!dbResult || !dbResult.ok) {
    const errorCode = dbResult?.error_code || "INVALID_REQUEST";
    const statusCode = errorCode === "NOT_FOUND" ? 404
      : errorCode === "FORBIDDEN" ? 403
      : 400;

    return createJsonResponse({
      error_code: errorCode,
      message: dbResult?.message || "Não foi possível desativar o dispositivo.",
    }, statusCode);
  }

  return createJsonResponse({
    ok: true,
    deactivated: dbResult.deactivated,
  }, 200);
});

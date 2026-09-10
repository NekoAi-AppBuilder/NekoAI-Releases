import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  createJsonResponse,
  extractNormalizedClientIp,
  sha256Hex,
  signGrant,
  computeSafeGraceUntil,
  GrantPayload,
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
    console.error("[license-activate] Missing env: SUPABASE_URL present?", !!supabaseUrl, "SUPABASE_SERVICE_ROLE_KEY present?", !!supabaseServiceKey);
    return createJsonResponse({ error_code: "INTERNAL_ERROR", message: "Erro interno de configuração do servidor." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // 1. Rate Limiting persistente por IP (5 tentativas/minuto)
  const rateLimitKey = `ip:${rateLimitIdentifier}:activate`;
  const { data: rlResult, error: rlError } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: rateLimitKey,
    p_max_attempts: 5,
    p_window_seconds: 60,
    p_block_seconds: 900,
  });

  if (rlError) {
    console.error("[license-activate] RPC fn_check_rate_limit error:", {
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
      { "Retry-After": String(rlResult.retry_after || 900) }
    );
  }

  // 2. Lê e valida o payload da requisição
  let body: { license_key?: string; device_id?: string; device_name?: string };
  try {
    body = await req.json();
  } catch {
    return createJsonResponse({ error_code: "INVALID_REQUEST", message: "JSON inválido." }, 400);
  }

  const licenseKey = typeof body.license_key === "string" ? body.license_key.trim().toUpperCase() : "";
  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  const deviceName = typeof body.device_name === "string" ? body.device_name.trim().slice(0, 128) : "NekoAI Station";

  if (!licenseKey || licenseKey.length > 64) {
    return createJsonResponse({ error_code: "INVALID_LICENSE_KEY", message: "Chave de licença inválida." }, 400);
  }

  if (!/^[0-9a-fA-F]{32}$/.test(deviceId)) {
    return createJsonResponse({ error_code: "INVALID_DEVICE_ID", message: "Identificador de dispositivo inválido." }, 400);
  }

  // 3. Calcula SHA-256 da chave de licença normalizada
  const keyHash = await sha256Hex(licenseKey);

  // 4. Invoca a função atômica PostgreSQL SECURITY DEFINER
  const { data: dbResult, error: dbError } = await supabaseAdmin.rpc("fn_activate_license_device", {
    p_license_key_hash: keyHash,
    p_device_id: deviceId,
    p_device_name: deviceName,
    p_ip: clientIp,
    p_user_agent: userAgent,
  });

  if (dbError) {
    console.error("[license-activate] RPC fn_activate_license_device error:", {
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
      : errorCode === "WRONG_USER" ? 403
      : errorCode === "DEVICE_LIMIT_REACHED" ? 409
      : 400;

    return createJsonResponse({
      error_code: errorCode,
      message: dbResult?.message || "Não foi possível ativar a licença.",
    }, statusCode);
  }

  // 6. Constrói o Grant Payload com grace_until estritamente <= expires_at
  const now = new Date();
  const expiresAt = new Date(dbResult.expires_at);
  const safeGraceUntil = computeSafeGraceUntil(now, expiresAt, 7);

  const grantPayload: GrantPayload = {
    jti: crypto.randomUUID(),
    iss: "https://nekoai.app/auth",
    aud: "nekoai-desktop-client",
    license_id: dbResult.license_id,
    user_id: dbResult.user_id,
    device_id: deviceId,
    plan: dbResult.plan,
    status: dbResult.status,
    entitlements: dbResult.entitlements,
    issued_at: now.toISOString(),
    expires_at: dbResult.expires_at,
    grace_until: safeGraceUntil,
    version: 1,
    kid: "neko-key-v1",
  };

  // 7. Assina com ECDSA P-256
  let signedGrant: string;
  try {
    signedGrant = await signGrant(grantPayload);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "unknown_signing_error";
    console.error("[license-activate] signGrant exception:", errMsg);
    return createJsonResponse({ error_code: "INTERNAL_ERROR", message: "Erro ao emitir o certificado de licença." }, 500);
  }

  return createJsonResponse({
    ok: true,
    grant: signedGrant,
    expires_at: dbResult.expires_at,
    plan: dbResult.plan,
    key_mask: dbResult.key_mask,
    license_type: dbResult.license_type,
  }, 200);
});

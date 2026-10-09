import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  createJsonResponse,
  extractNormalizedClientIp,
  signGrant,
  verifySignedGrant,
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
    console.error("[license-validate] Missing env: SUPABASE_URL present?", !!supabaseUrl, "SUPABASE_SERVICE_ROLE_KEY present?", !!supabaseServiceKey);
    return createJsonResponse({ error_code: "INTERNAL_ERROR", message: "Erro interno de configuração do servidor." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  let body: { device_id?: string; grant?: string; license_id?: string };
  try {
    body = await req.json();
  } catch {
    return createJsonResponse({ error_code: "INVALID_REQUEST", message: "JSON inválido." }, 400);
  }

  const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!/^[0-9a-fA-F]{32}$/.test(deviceId)) {
    return createJsonResponse({ error_code: "INVALID_DEVICE_ID", message: "Identificador de máquina inválido." }, 400);
  }

  // Extrai license_id explicitamente e/ou decodifica e verifica criptograficamente do grant
  let grantLicenseId: string | null = null;
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  if (typeof body.grant === "string" && body.grant.trim().length > 0) {
    const grantCheck = await verifySignedGrant(body.grant.trim(), deviceId);
    if (!grantCheck.valid || !grantCheck.payload) {
      return createJsonResponse({
        error_code: "INVALID_REQUEST",
        message: "Certificado de licença inválido ou assinatura corrompida.",
      }, 400);
    }
    if (typeof grantCheck.payload.license_id === "string" && uuidRegex.test(grantCheck.payload.license_id.trim())) {
      grantLicenseId = grantCheck.payload.license_id.trim().toLowerCase();
    }
  }

  let bodyLicenseId: string | null = null;
  if (typeof body.license_id === "string" && uuidRegex.test(body.license_id.trim())) {
    bodyLicenseId = body.license_id.trim().toLowerCase();
  }

  // Rejeita tentativas de falsificação ou divergência entre grant e license_id declarado
  if (grantLicenseId && bodyLicenseId && grantLicenseId !== bodyLicenseId) {
    return createJsonResponse({
      error_code: "INVALID_REQUEST",
      message: "Divergência entre o certificado de licença e o identificador fornecido.",
    }, 400);
  }

  const licenseId: string | null = bodyLicenseId || grantLicenseId;

  // 1. Rate Limiting persistente por device_id e IP (60 tentativas/minuto)
  // Utiliza device_id para não colidir entre máquinas na mesma rede/NAT
  const rateLimitKey = `device:${deviceId}:ip:${rateLimitIdentifier}:validate`;
  const { data: rlResult, error: rlError } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: rateLimitKey,
    p_max_attempts: 60,
    p_window_seconds: 60,
    p_block_seconds: 120,
  });

  if (rlError) {
    console.error("[license-validate] RPC fn_check_rate_limit error:", {
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

  // 2. Invoca a função atômica PostgreSQL SECURITY DEFINER (com suporte a p_license_id e fallback controlado)
  let dbResult: any = null;
  let dbError: any = null;

  const rpcRes = await supabaseAdmin.rpc("fn_validate_license_device", {
    p_device_id: deviceId,
    p_license_id: licenseId || null,
    p_ip: clientIp,
    p_user_agent: userAgent,
  });

  dbResult = rpcRes.data;
  dbError = rpcRes.error;

  // Fallback defensivo controlado:
  // Se o banco remoto ainda não tiver aplicado a migração com p_license_id (código PostgREST PGRST202):
  // - Se licenseId foi especificado, NÃO podemos cair no fallback legado (descartaria a identidade da licença).
  //   Retorna erro de configuração 500 para preservar o cofre local sem marcar como EXPIRED.
  // - Se licenseId for nulo (descoberta), o fallback de 3 parâmetros é seguro pois o license_id já era nulo.
  if (dbError && (dbError.code === "PGRST202" || dbError.message?.includes("p_license_id") || dbError.details?.includes("p_license_id"))) {
    if (licenseId) {
      console.error("[license-validate] Banco remoto não possui RPC com p_license_id para validar licença específica. Bloqueando fallback para evitar troca indevida de licença.");
      return createJsonResponse({
        error_code: "DB_CONFIG_ERROR",
        message: "A validação da licença específica requer a atualização da RPC no banco de dados.",
      }, 500);
    } else {
      console.warn("[license-validate] RPC com p_license_id não encontrada durante descoberta sem grant, executando fallback legado...");
      const fallbackRes = await supabaseAdmin.rpc("fn_validate_license_device", {
        p_device_id: deviceId,
        p_ip: clientIp,
        p_user_agent: userAgent,
      });
      dbResult = fallbackRes.data;
      dbError = fallbackRes.error;
    }
  }

  if (dbError) {
    console.error("[license-validate] RPC fn_validate_license_device error:", {
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
      : errorCode === "WRONG_USER" || errorCode === "REVOKED" ? 403
      : 400;

    return createJsonResponse({
      error_code: errorCode,
      message: dbResult?.message || "Não foi possível validar a licença.",
    }, statusCode);
  }

  // 4. Emite novo grant assinado com grace_until estritamente <= expires_at
  const now = new Date();
  const expiresAt = new Date(dbResult.expires_at);
  const safeGraceUntil = computeSafeGraceUntil(now, expiresAt, 7);

  const isTestLicense =
    String(dbResult.license_type || "").toUpperCase() === "TEST" ||
    String(dbResult.plan || "").toUpperCase() === "TEST" ||
    String(dbResult.plan || "").toUpperCase() === "TESTE" ||
    String(dbResult.key_mask || "").toUpperCase().startsWith("NEKO-TEST-");

  const effectivePlan = isTestLicense ? "TEST" : dbResult.plan;
  const effectiveLicenseType = isTestLicense ? "TEST" : (dbResult.license_type || "NORMAL");

  const grantPayload: GrantPayload = {
    jti: crypto.randomUUID(),
    iss: "https://nekoai.app/auth",
    aud: "nekoai-desktop-client",
    license_id: dbResult.license_id,
    user_id: dbResult.user_id,
    device_id: deviceId,
    plan: effectivePlan,
    status: dbResult.status,
    entitlements: dbResult.entitlements,
    issued_at: now.toISOString(),
    expires_at: dbResult.expires_at,
    grace_until: safeGraceUntil,
    version: 1,
    kid: "neko-key-v1",
  };

  let signedGrant: string;
  try {
    signedGrant = await signGrant(grantPayload);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "unknown_signing_error";
    console.error("[license-validate] signGrant exception:", errMsg);
    return createJsonResponse({ error_code: "INTERNAL_ERROR", message: "Erro ao emitir o certificado de licença." }, 500);
  }

  return createJsonResponse({
    ok: true,
    grant: signedGrant,
    expires_at: dbResult.expires_at,
    plan: effectivePlan,
    key_mask: dbResult.key_mask,
    license_type: effectiveLicenseType,
    max_devices: dbResult.max_devices ?? 1,
    active_devices: dbResult.active_devices ?? 1,
  }, 200);
});

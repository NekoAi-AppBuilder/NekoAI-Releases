// supabase/functions/admin-auth/index.ts
// Edge Function administrativa de autenticação com Rate-Limiting, Timing-Safe Equal e Token Seguro

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function extractIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || 
         req.headers.get("cf-connecting-ip") || 
         req.headers.get("x-real-ip") || 
         "unknown";
}

function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function stringToBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return bufferToBase64Url(bytes);
}

/**
 * Comparação de tempo constante via SHA-256 HMAC para prevenir timing attacks.
 */
async function timingSafeCheck(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  const dummyKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigA = await crypto.subtle.sign("HMAC", dummyKey, aBytes);
  const sigB = await crypto.subtle.sign("HMAC", dummyKey, bBytes);

  const arrA = new Uint8Array(sigA);
  const arrB = new Uint8Array(sigB);

  if (arrA.length !== arrB.length) return false;

  let result = 0;
  for (let i = 0; i < arrA.length; i++) {
    result |= arrA[i] ^ arrB[i];
  }

  return result === 0 && a.length === b.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, message: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = Deno.env.get("NEKO_ADMIN_SECRET_KEY") || Deno.env.get("ADMIN_SECRET_KEY");

  // Log seguro: presença de variáveis no ambiente
  console.log("[admin-auth] Environment check -> SUPABASE_URL present?", !!supabaseUrl, "| SUPABASE_SERVICE_ROLE_KEY present?", !!supabaseServiceKey, "| NEKO_ADMIN_SECRET_KEY present?", !!adminSecret);

  if (!supabaseUrl || !supabaseServiceKey || !adminSecret) {
    console.error("[admin-auth] Erro: segredos administrativos não configurados nas variáveis de ambiente.");
    return json({ ok: false, message: "Servidor não configurado com NEKO_ADMIN_SECRET_KEY." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  // Rate Limiting persistente (5 tentativas de login por 15 min)
  const clientIp = extractIp(req);
  const { data: rlResult } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: `ip:${clientIp}:admin_auth`,
    p_max_attempts: 5,
    p_window_seconds: 900,
    p_block_seconds: 1800,
  });

  if (rlResult && !rlResult.allowed) {
    console.warn(`[admin-auth] Rate limit atingido para IP: ${clientIp}`);
    return json({ ok: false, message: "Muitas tentativas. Aguarde antes de tentar novamente.", retry_after: rlResult.retry_after }, 429);
  }

  let body: { secret_key?: string };
  try {
    body = await req.json();
  } catch {
    console.warn("[admin-auth] Requisição com JSON malformado.");
    return json({ ok: false, message: "JSON inválido." }, 400);
  }

  const providedSecret = typeof body.secret_key === "string" ? body.secret_key.trim() : "";
  const secretProvided = providedSecret.length > 0;
  console.log(`[admin-auth] Request recebido de IP ${clientIp} -> Secret fornecida no payload? ${secretProvided} (tamanho: ${providedSecret.length})`);

  const isMatch = await timingSafeCheck(providedSecret, adminSecret.trim());

  if (!isMatch) {
    console.warn(`[admin-auth] Autenticação falhou para IP ${clientIp}: comparação de chave secreta não coincidiu.`);
    return json({ ok: false, message: "Chave secreta de administração incorreta." }, 401);
  }

  console.log(`[admin-auth] Autenticação com sucesso para IP ${clientIp}. Gerando token HMAC de sessão...`);

  // Gera token de sessão assinado HMAC com expiração de 24h
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 86400; // 24 horas

  const sessionPayload = {
    role: "neko_admin",
    iat: now,
    exp: expiresAt,
  };

  const payloadJson = JSON.stringify(sessionPayload);
  const b64Payload = stringToBase64Url(payloadJson);

  // Assinatura HMAC-SHA256 usando o próprio adminSecret
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(adminSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(b64Payload));
  const b64Sig = bufferToBase64Url(sigBuffer);

  const token = `${b64Payload}.${b64Sig}`;
  console.log(`[admin-auth] Token de sessão gerado com sucesso (exp: ${new Date(expiresAt * 1000).toISOString()}).`);

  return json({
    ok: true,
    token,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  }, 200);
});

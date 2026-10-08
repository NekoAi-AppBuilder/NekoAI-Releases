import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-neko-license-grant, x-client-info, apikey, content-type",
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

const SYSTEM_PROMPT = `Você é um especialista em melhorar prompts para agentes de desenvolvimento.
Preserve a intenção original.
Torne o pedido claro, específico e executável.
Não invente requisitos.
Não altere tecnologias, objetivos ou restrições sem necessidade.
Preserve nomes de arquivos, caminhos, funções, APIs, comandos, URLs e código.
Preserve o idioma original do usuário.
Não responda ao usuário como um assistente.
Não adicione formatação markdown desnecessária ou blocos de código se o original não tinha.
Retorne SOMENTE o texto do prompt melhorado. Nada mais.`;

const EXPECTED_AUDIENCE = "nekoai-desktop-client";

// Chave pública oficial para validar offline a assinatura do Grant ECDSA emitido pelo backend
const NEKO_PUBLIC_KEY_JWK = {
  kty: "EC",
  x: "mL9Jq1UNPH7Ld3w1v_W3qVXcZkB9ZMqu1E16uxUDqRA",
  y: "KVV7kEM1u8lSE4SNW6_YDsE8s4fehQWKtX6IiNmpXps",
  crv: "P-256",
} as const;

async function verifyLicenseGrant(grant: string): Promise<any | null> {
  try {
    const parts = grant.split(".");
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    
    // Converte base64url para string
    const canonicalStr = decodeURIComponent(escape(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))));
    
    // Importa chave pública
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      NEKO_PUBLIC_KEY_JWK,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    
    // Verifica assinatura ECDSA P-256 SHA-256
    const signature = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const data = new TextEncoder().encode(canonicalStr);
    
    const isValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      publicKey,
      signature,
      data
    );
    
    if (!isValid) return null;
    
    const payload = JSON.parse(canonicalStr);
    
    // Validar Audience e Status
    if (payload.aud !== EXPECTED_AUDIENCE) return null;
    if (payload.status !== "active") return null;

    // A regra de negócio exige que todos os planos (incluindo TEST) com status "active" 
    // tenham acesso gratuito, logo não filtramos payload.plan.
    
    // Validação de expiração / grace period
    if (payload.expires_at) {
       const expDate = new Date(payload.expires_at);
       const now = new Date();
       if (expDate.getTime() < now.getTime()) {
          if (payload.grace_until) {
             const graceDate = new Date(payload.grace_until);
             if (graceDate.getTime() < now.getTime()) return null;
          } else {
             return null;
          }
       }
    }
    
    return payload;
  } catch (e) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ success: false, error_code: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GEMINI_FREE_API_KEY");

  if (!supabaseUrl || !supabaseServiceKey || !geminiApiKey) {
    console.error("[enhance-prompt] Erro: Segredos não configurados.");
    return json({ success: false, error_code: "INTERNAL_ERROR", message: "Servidor não configurado corretamente." }, 500);
  }

  // Validação Estrita de Identidade via License Grant validado localmente
  const grantToken = req.headers.get("x-neko-license-grant");
  if (!grantToken) {
    return json({ success: false, error_code: "UNAUTHORIZED", message: "Credencial de licenciamento não informada." }, 401);
  }

  const payload = await verifyLicenseGrant(grantToken);
  if (!payload || !payload.device_id) {
    return json({ success: false, error_code: "UNAUTHORIZED", message: "Credencial inválida ou expirada." }, 401);
  }

  // Validar payload HTTP Body
  let body: { prompt?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error_code: "INVALID_REQUEST", message: "Payload inválido." }, 400);
  }

  const originalPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!originalPrompt) {
    return json({ success: false, error_code: "EMPTY_PROMPT", message: "Digite um prompt antes de melhorar." }, 400);
  }

  if (originalPrompt.length > 3000) {
    return json({ success: false, error_code: "PROMPT_TOO_LONG", message: "O prompt excedeu o limite máximo para melhoria." }, 400);
  }

  // Rate Limiting (Estritamente por payload.device_id validado criptograficamente)
  const clientIp = extractIp(req);
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  
  // Utilizando o fn_check_rate_limit: 10 tentativas a cada 1 minuto por device_id independente
  const { data: rlResult } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: `enhance_prompt:${payload.device_id}`,
    p_max_attempts: 10,
    p_window_seconds: 60,
    p_block_seconds: 120,
  });

  if (rlResult && !rlResult.allowed) {
    return json({ success: false, error_code: "RATE_LIMITED", message: "Muitas tentativas. Aguarde um instante e tente novamente." }, 429);
  }

  // Chamada ao Gemini Free Tier (utilizando gemini-3.5-flash-lite)
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${geminiApiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [
          { parts: [{ text: originalPrompt }] }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2000,
        }
      })
    });

    if (!geminiRes.ok) {
      if (geminiRes.status === 429) {
         return json({ success: false, error_code: "PROVIDER_RATE_LIMIT", message: "O serviço de melhoria está temporariamente ocupado. Tente novamente mais tarde." }, 503);
      }
      return json({ success: false, error_code: "PROVIDER_ERROR", message: "O serviço de melhoria não está disponível." }, 502);
    }

    const geminiData = await geminiRes.json();
    const candidate = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!candidate || typeof candidate !== "string" || !candidate.trim()) {
      return json({ success: false, error_code: "INVALID_RESPONSE", message: "Não foi possível melhorar este prompt no momento." }, 502);
    }

    return json({ success: true, improvedPrompt: candidate.trim() }, 200);

  } catch (err) {
    console.error("[enhance-prompt] Falha de comunicação:", err);
    return json({ success: false, error_code: "NETWORK_ERROR", message: "Falha ao comunicar com o serviço auxiliar." }, 500);
  }
});

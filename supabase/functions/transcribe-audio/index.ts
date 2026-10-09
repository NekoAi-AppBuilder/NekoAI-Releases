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

const SYSTEM_AUDIO_PROMPT = `Você é um transcritor de áudio em tempo real especializado em ambiente de desenvolvimento de software em português brasileiro.
Sua função é transcrever exatamente o que o usuário falou, transformando a fala em texto para o campo de prompt.

Regras obrigatórias:
1. Transcreva em português brasileiro correto com pontuação e acentuação naturais.
2. Reconheça e preserve jargões e termos técnicos de tecnologia e programação (por exemplo: React, TypeScript, Tailwind, CSS, HTML, Vite, Next.js, API, endpoint, bug, hook, state, Docker, Supabase, Git, commit, branch, etc.).
3. Não adicione saudações, explicações, comentários, aspas extras ou introduções (não diga "Você disse:", "Aqui está a transcrição:").
4. Se o áudio estiver completamente silencioso, inaudível ou sem palavras identificáveis, responda exatamente com a palavra VAZIO.
5. Retorne SOMENTE o texto transcrito. Nada mais.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ success: false, error_code: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rawApiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GEMINI_FREE_API_KEY");
  const geminiApiKey = rawApiKey ? rawApiKey.trim().replace(/^["']|["']$/g, "").trim() : "";

  if (!supabaseUrl || !supabaseServiceKey || !geminiApiKey) {
    console.error("[transcribe-audio] Erro: Segredos não configurados.");
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
  let body: { audio?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error_code: "INVALID_REQUEST", message: "Payload inválido." }, 400);
  }

  const audioBase64 = typeof body.audio === "string" ? body.audio.trim() : "";
  if (!audioBase64) {
    return json({ success: false, error_code: "EMPTY_AUDIO", message: "Nenhum áudio enviado para transcrição." }, 400);
  }

  // Limite razoável de áudio (aproximadamente 25MB em base64)
  if (audioBase64.length > 35 * 1024 * 1024) {
    return json({ success: false, error_code: "AUDIO_TOO_LARGE", message: "O áudio enviado excede o tamanho limite permitido." }, 400);
  }

  const mimeType = (typeof body.mimeType === "string" && body.mimeType.trim())
    ? body.mimeType.trim().split(";")[0] // pega o mime principal ex: audio/webm
    : "audio/webm";

  // Rate Limiting por device_id
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  
  const { data: rlResult } = await supabaseAdmin.rpc("fn_check_rate_limit", {
    p_key: `transcribe_audio:${payload.device_id}`,
    p_max_attempts: 15,
    p_window_seconds: 60,
    p_block_seconds: 120,
  });

  if (rlResult && !rlResult.allowed) {
    return json({ success: false, error_code: "RATE_LIMITED", message: "Muitas tentativas de gravação. Aguarde um instante e tente novamente." }, 429);
  }

  // Modelos candidatos para failover automático
  const CANDIDATE_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3.7-flash",
    "gemini-3.1-flash-lite",
  ];

  let lastStatus = 0;
  let lastErrorDetail = "";
  let transcribedText: string | null = null;

  for (const model of CANDIDATE_MODELS) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SYSTEM_AUDIO_PROMPT }]
          },
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: audioBase64
                  }
                },
                {
                  text: "Transcreva este áudio com máxima exatidão em português brasileiro, preservando termos de desenvolvimento de software."
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          }
        })
      });

      if (!geminiRes.ok) {
        const errBody = await geminiRes.text();
        lastStatus = geminiRes.status;
        console.warn(`[transcribe-audio] Modelo ${model} retornou ${geminiRes.status}. Tentando próximo modelo...`);
        try {
          const parsed = JSON.parse(errBody);
          lastErrorDetail = parsed?.error?.message || errBody;
        } catch {
          lastErrorDetail = errBody;
        }
        continue;
      }

      const geminiData = await geminiRes.json();
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (typeof rawText === "string") {
        const cleanText = rawText.trim();
        // Se o modelo detectou silêncio/ruído e retornou VAZIO
        if (cleanText === "VAZIO" || cleanText === "VAZIO." || cleanText === "[VAZIO]" || cleanText === "") {
          transcribedText = "";
        } else {
          transcribedText = cleanText;
        }
        break; // Sucesso!
      }
    } catch (err) {
      console.warn(`[transcribe-audio] Falha com modelo ${model}:`, err);
      continue;
    }
  }

  if (transcribedText === null) {
    console.error("[transcribe-audio] Todos os modelos falharam:", lastStatus, lastErrorDetail);
    return json({
      success: false,
      error_code: "PROVIDER_BUSY",
      message: "O serviço de transcrição de voz está temporariamente instável. Tente novamente em instantes."
    }, 503);
  }

  return json({ success: true, text: transcribedText }, 200);
});

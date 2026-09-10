// _shared/license-crypto.ts
// Utilitários de Criptografia ECDSA P-256, CORS e normalização de IP compartilhados para Edge Functions NekoAI

export interface GrantPayload {
  jti: string;
  iss: string;
  aud: string;
  license_id: string;
  user_id: string;
  device_id: string;
  plan: string;
  status: string;
  entitlements: string[];
  issued_at: string;
  expires_at: string;
  grace_until: string;
  version: number;
  kid: string;
}

// CORS: permite requisições da NekoAI Desktop e preflight explícito
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-neko-device",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function createJsonResponse(body: Record<string, unknown>, status = 200, customHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...customHeaders,
    },
  });
}

export function isValidIp(ip: string): boolean {
  const ipv4 = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.){3}(25[0-5]|(2[0-4]|1\d|[1-9]|)\d)$/;
  if (ipv4.test(ip)) return true;

  const ipv6 = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
  return ipv6.test(ip);
}

export function extractNormalizedClientIp(req: Request): string | null {
  const header = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  if (!header) return null;

  const firstEntry = header.split(",")[0].trim();
  if (!firstEntry) return null;

  return isValidIp(firstEntry) ? firstEntry : null;
}

export function serializeCanonicalGrantPayload(payload: GrantPayload): string {
  const canonical = {
    jti: payload.jti,
    iss: payload.iss,
    aud: payload.aud,
    license_id: payload.license_id,
    user_id: payload.user_id,
    device_id: payload.device_id,
    plan: payload.plan,
    status: payload.status,
    entitlements: Array.isArray(payload.entitlements) ? [...payload.entitlements].sort() : [],
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    grace_until: payload.grace_until,
    version: payload.version,
    kid: payload.kid || "neko-key-v1",
  };
  return JSON.stringify(canonical);
}

export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function stringToBase64Url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let cachedPrivateKey: CryptoKey | null = null;

export async function getEcdsaPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;

  const rawJwkSecret = Deno.env.get("ECDSA_PRIVATE_KEY_V1");
  if (!rawJwkSecret) {
    console.error("[getEcdsaPrivateKey] ECDSA_PRIVATE_KEY_V1 secret is not configured.");
    throw new Error("ECDSA_PRIVATE_KEY_V1 secret is not configured.");
  }

  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(rawJwkSecret);
  } catch {
    console.error("[getEcdsaPrivateKey] Invalid ECDSA_PRIVATE_KEY_V1 JWK format.");
    throw new Error("Invalid ECDSA_PRIVATE_KEY_V1 JWK format.");
  }

  cachedPrivateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  return cachedPrivateKey;
}

export async function signGrant(payload: GrantPayload): Promise<string> {
  const privateKey = await getEcdsaPrivateKey();
  const canonicalStr = serializeCanonicalGrantPayload(payload);
  const data = new TextEncoder().encode(canonicalStr);

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    data
  );

  const payloadB64 = stringToBase64Url(canonicalStr);
  const sigB64 = arrayBufferToBase64Url(signature);

  return `${payloadB64}.${sigB64}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function computeSafeGraceUntil(now: Date, expiresAt: Date, graceDays = 7): string {
  const maxGrace = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
  if (maxGrace.getTime() > expiresAt.getTime()) {
    return expiresAt.toISOString();
  }
  return maxGrace.toISOString();
}

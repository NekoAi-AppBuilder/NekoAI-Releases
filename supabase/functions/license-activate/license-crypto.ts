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

export const NEKO_PUBLIC_KEY_JWK = {
  kty: "EC",
  x: "mL9Jq1UNPH7Ld3w1v_W3qVXcZkB9ZMqu1E16uxUDqRA",
  y: "KVV7kEM1u8lSE4SNW6_YDsE8s4fehQWKtX6IiNmpXps",
  crv: "P-256",
} as const;

let cachedPublicKey: CryptoKey | null = null;

export async function getEcdsaPublicKey(): Promise<CryptoKey> {
  if (cachedPublicKey) return cachedPublicKey;
  cachedPublicKey = await crypto.subtle.importKey(
    "jwk",
    NEKO_PUBLIC_KEY_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return cachedPublicKey;
}

export function base64UrlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function verifySignedGrant(grant: string, expectedDeviceId: string): Promise<{ valid: boolean; payload?: GrantPayload; reason?: string }> {
  if (!grant || typeof grant !== "string") {
    return { valid: false, reason: "grant_empty" };
  }
  const parts = grant.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "invalid_format" };
  }

  const [payloadB64, sigB64] = parts;
  let rawJson: string;
  try {
    const bytes = base64UrlToUint8Array(payloadB64);
    rawJson = new TextDecoder().decode(bytes);
  } catch {
    return { valid: false, reason: "b64_decode_error" };
  }

  let payload: GrantPayload;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return { valid: false, reason: "json_parse_error" };
  }

  if (!payload || typeof payload !== "object") {
    return { valid: false, reason: "payload_not_object" };
  }

  if (payload.device_id !== expectedDeviceId) {
    return { valid: false, reason: "device_mismatch" };
  }

  try {
    const publicKey = await getEcdsaPublicKey();
    const canonicalStr = serializeCanonicalGrantPayload(payload);
    const data = new TextEncoder().encode(canonicalStr);
    const sigBytes = base64UrlToUint8Array(sigB64);

    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      publicKey,
      sigBytes as unknown as BufferSource,
      data
    );

    if (!verified) {
      return { valid: false, reason: "signature_invalid" };
    }
  } catch {
    return { valid: false, reason: "crypto_error" };
  }

  return { valid: true, payload };
}

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

/**
 * Deriva chave simétrica AES-GCM a partir do segredo administrativo via SHA-256.
 */
async function getAesGcmKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const rawKey = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Criptografa a chave em texto plano com AES-GCM (12-byte IV + ciphertext em base64).
 */
export async function encryptLicenseKey(plainKey: string, secret: string): Promise<string> {
  const key = await getAesGcmKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainKey.trim().toUpperCase())
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  let binary = "";
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

/**
 * Descriptografa uma chave em base64 AES-GCM usando o segredo administrativo.
 */
export async function decryptLicenseKey(encryptedBase64: string, secret: string): Promise<string | null> {
  try {
    const key = await getAesGcmKey(secret);
    const binary = atob(encryptedBase64);
    const combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);
    if (combined.length < 13) return null;
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.error("[decryptLicenseKey] Falha ao descriptografar chave de licença:", e);
    return null;
  }
}


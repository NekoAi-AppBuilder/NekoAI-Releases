// src/main/license/license-crypto.ts
// Verificador Criptográfico ECDSA P-256 e validação de Grant no Main Process

import crypto from "node:crypto";
import { GrantPayload, LicenseVerificationResult } from "./license-types";

// Chave pública oficial ECDSA P-256 (kid: neko-key-v1) - Estritamente chave pública
export const NEKO_PUBLIC_KEY_JWK = {
  kty: "EC",
  x: "mL9Jq1UNPH7Ld3w1v_W3qVXcZkB9ZMqu1E16uxUDqRA",
  y: "KVV7kEM1u8lSE4SNW6_YDsE8s4fehQWKtX6IiNmpXps",
  crv: "P-256",
} as const;

export const EXPECTED_KID = "neko-key-v1";
export const EXPECTED_ISSUER = "https://nekoai.app/auth";
export const EXPECTED_AUDIENCE = "nekoai-desktop-client";
export const EXPECTED_VERSION = 1;

let cachedPublicKey: crypto.KeyObject | null = null;

function getPublicKey(): crypto.KeyObject {
  if (cachedPublicKey) return cachedPublicKey;
  cachedPublicKey = crypto.createPublicKey({
    key: NEKO_PUBLIC_KEY_JWK,
    format: "jwk",
  });
  return cachedPublicKey;
}

/**
 * Serialização determinística byte-a-byte idêntica ao backend Supabase Edge Function
 */
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
    kid: payload.kid || EXPECTED_KID,
  };
  return JSON.stringify(canonical);
}

/**
 * Verificação offline rigorosa do Grant JWT/ECDSA assinado pelo backend
 */
export function verifySignedGrant(grant: string, expectedDeviceId: string): LicenseVerificationResult {
  if (!grant || typeof grant !== "string") {
    return { valid: false, state: "MISSING", reason: "grant_empty" };
  }

  const parts = grant.split(".");
  if (parts.length !== 2) {
    return { valid: false, state: "INVALID", reason: "invalid_grant_format" };
  }

  const [payloadBase64Url, signatureBase64Url] = parts;
  let rawJson: string;
  try {
    rawJson = Buffer.from(payloadBase64Url, "base64url").toString("utf8");
  } catch {
    return { valid: false, state: "INVALID", reason: "payload_base64_decode_error" };
  }

  let payload: GrantPayload;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return { valid: false, state: "INVALID", reason: "payload_json_parse_error" };
  }

  if (!payload || typeof payload !== "object") {
    return { valid: false, state: "INVALID", reason: "payload_not_object" };
  }

  // 1. Validação de campos obrigatórios e tipos
  if (
    typeof payload.jti !== "string" ||
    typeof payload.iss !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.license_id !== "string" ||
    typeof payload.user_id !== "string" ||
    typeof payload.device_id !== "string" ||
    typeof payload.plan !== "string" ||
    typeof payload.status !== "string" ||
    !Array.isArray(payload.entitlements) ||
    typeof payload.issued_at !== "string" ||
    typeof payload.expires_at !== "string" ||
    typeof payload.grace_until !== "string" ||
    typeof payload.version !== "number"
  ) {
    return { valid: false, state: "INVALID", reason: "missing_or_invalid_fields" };
  }

  // 2. Validação de constantes institucionais
  if (payload.version !== EXPECTED_VERSION) {
    return { valid: false, state: "INVALID", reason: "unsupported_version" };
  }
  if (payload.kid && payload.kid !== EXPECTED_KID) {
    return { valid: false, state: "INVALID", reason: "unsupported_kid" };
  }
  if (payload.iss !== EXPECTED_ISSUER) {
    return { valid: false, state: "INVALID", reason: "invalid_issuer" };
  }
  if (payload.aud !== EXPECTED_AUDIENCE) {
    return { valid: false, state: "INVALID", reason: "invalid_audience" };
  }

  // 3. Validação de Device Binding
  if (payload.device_id !== expectedDeviceId) {
    return { valid: false, state: "INVALID", reason: "device_mismatch" };
  }

  // 4. Validação da assinatura criptográfica ECDSA P-256 (IEEE P1363 / WebCrypto 64-byte raw signature)
  const canonicalString = serializeCanonicalGrantPayload(payload);
  const publicKey = getPublicKey();

  let signatureValid = false;
  try {
    const signatureBuffer = Buffer.from(signatureBase64Url, "base64url");
    const verify = crypto.createVerify("SHA256");
    verify.update(Buffer.from(canonicalString, "utf8"));
    verify.end();

    // dsaEncoding: 'ieee-p1363' é o formato padrão emitido por WebCrypto (64 bytes: r + s)
    signatureValid = verify.verify(
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signatureBuffer
    );
  } catch (err) {
    return { valid: false, state: "INVALID", reason: "crypto_verification_error" };
  }

  if (!signatureValid) {
    return { valid: false, state: "INVALID", reason: "signature_invalid" };
  }

  // 5. Validação de Status Administrativo
  if (payload.status === "revoked") {
    return { valid: false, state: "INVALID", reason: "license_revoked", payload };
  }

  // 6. Validação Temporal (expires_at e grace_until)
  const nowMs = Date.now();
  const expiresAtMs = new Date(payload.expires_at).getTime();
  const graceUntilMs = new Date(payload.grace_until).getTime();

  if (isNaN(expiresAtMs) || isNaN(graceUntilMs)) {
    return { valid: false, state: "INVALID", reason: "invalid_date_format", payload };
  }

  // Regra Inegociável: grace_until NUNCA pode ser posterior a expires_at
  if (graceUntilMs > expiresAtMs) {
    return { valid: false, state: "INVALID", reason: "grace_exceeds_expiration", payload };
  }

  // Se now >= expires_at => EXPIRED
  if (nowMs >= expiresAtMs) {
    return { valid: false, state: "EXPIRED", reason: "license_expired", payload };
  }

  // Se now >= grace_until (mas now < expires_at) => GRACE
  if (nowMs >= graceUntilMs) {
    return { valid: true, state: "GRACE", payload };
  }

  // Tudo válido e dentro do período online regular => VALID
  return { valid: true, state: "VALID", payload };
}

// supabase/functions/public-test-license/helpers.ts
// Funções puras (sem efeitos colaterais) da Edge Function pública de licença TEST.
// Separa a lógica testável da orquestração que depende do Deno/banco/e-mail.

export const LICENSE_CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const TEST_LICENSE_DURATION_MS = 60 * 60 * 1000; // 1 hora
export const EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Gera uma chave criptograficamente aleatória no formato estrito do NekoAI:
 * NEKO-XXXX-XXXX-XXXX-XXXX (mesma regra/alfabeto do gerador do Admin).
 */
export function generateLicenseKey(): string {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);

  const groups: string[] = [];
  let byteIndex = 0;
  for (let g = 0; g < 4; g++) {
    let groupStr = "";
    for (let c = 0; c < 4; c++) {
      const charIndex = randomBytes[byteIndex++] % LICENSE_CHARSET.length;
      groupStr += LICENSE_CHARSET[charIndex];
    }
    groups.push(groupStr);
  }

  return `NEKO-${groups.join("-")}`;
}

/**
 * Deriva a máscara pública oficial: NEKO-****-****-****-XXXX
 * (idêntico ao extractKeyMask do Admin para chaves no novo formato).
 */
export function extractKeyMask(licenseKey: string): string {
  const clean = licenseKey.trim().toUpperCase();
  const lastFour = clean.slice(-4);
  return `NEKO-****-****-****-${lastFour}`;
}

export function isValidLicenseKeyFormat(key: string): boolean {
  return /^NEKO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
}

export function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email);
  if (!e || e.length > 255) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * Normaliza WhatsApp removendo tudo que não for dígito, para comparação/armazenamento
 * consistente. Mantém somente dígitos (com 0 caso necessário), sem espaços/símbolos.
 */
export function normalizeWhatsapp(whatsapp: string): string {
  return String(whatsapp || "").replace(/\D/g, "");
}

export function isValidWhatsapp(whatsapp: string): boolean {
  const digits = normalizeWhatsapp(whatsapp);
  // Aceita entre 8 e 15 dígitos (com ou sem DDI 55).
  return digits.length >= 8 && digits.length <= 15;
}

export interface TestLicenseRequest {
  name: string;
  email: string;
  whatsapp: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: { code: string; message: string };
  normalized?: TestLicenseRequest;
}

/**
 * Valida e normaliza a entrada pública. Rejeita entradas que tentem enviar
 * qualquer parâmetro privilegiado (ignorados por construção: este validador só
 * considera name/email/whatsapp).
 */
export function validateTestLicenseRequest(body: unknown): ValidationResult {
  const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email : "";
  const whatsapp = typeof input.whatsapp === "string" ? input.whatsapp : "";

  if (!name) {
    return { valid: false, error: { code: "INVALID_NAME", message: "O nome é obrigatório." } };
  }
  if (name.length > 128) {
    return { valid: false, error: { code: "INVALID_NAME", message: "O nome é muito longo." } };
  }

  if (!email) {
    return { valid: false, error: { code: "INVALID_EMAIL", message: "O e-mail é obrigatório." } };
  }
  if (!isValidEmail(email)) {
    return { valid: false, error: { code: "INVALID_EMAIL", message: "Endereço de e-mail inválido." } };
  }

  if (!whatsapp) {
    return { valid: false, error: { code: "INVALID_WHATSAPP", message: "O WhatsApp é obrigatório." } };
  }
  if (!isValidWhatsapp(whatsapp)) {
    return { valid: false, error: { code: "INVALID_WHATSAPP", message: "Número de WhatsApp inválido." } };
  }

  return {
    valid: true,
    normalized: {
      name,
      email: normalizeEmail(email),
      whatsapp: normalizeWhatsapp(whatsapp),
    },
  };
}
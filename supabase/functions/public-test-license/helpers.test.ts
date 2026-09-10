// supabase/functions/public-test-license/helpers.test.ts
// Testes da Edge Function pública de licença TEST (somente funções puras).
// Executar: deno test public-test-license/helpers.test.ts

import {
  validateTestLicenseRequest,
  generateLicenseKey,
  extractKeyMask,
  isValidLicenseKeyFormat,
  normalizeEmail,
  normalizeWhatsapp,
  TEST_LICENSE_DURATION_MS,
} from "./helpers.ts";

Deno.test("POST válido é aceito e normalizado", () => {
  const r = validateTestLicenseRequest({
    name: "  André ",
    email: " ANDRE@EMAIL.COM ",
    whatsapp: " (15) 99985-8616 ",
  });
  if (!r.valid || !r.normalized) {
    throw new Error("esperado valido");
  }
  if (r.normalized.name !== "André") throw new Error("nome deve ser trim");
  if (r.normalized.email !== "andre@email.com") throw new Error("email deve ser lowercased");
  if (r.normalized.whatsapp !== normalizeWhatsapp("(15) 99985-8616")) throw new Error("whatsapp deve ser normalizado");
});

Deno.test("nome ausente -> invalido", () => {
  const r = validateTestLicenseRequest({ name: "", email: "a@b.com", whatsapp: "5515998586167" });
  if (r.valid) throw new Error("esperado invalido");
  if (r.error?.code !== "INVALID_NAME") throw new Error("codigo esperado INVALID_NAME");
});

Deno.test("email ausente -> invalido", () => {
  const r = validateTestLicenseRequest({ name: "Ana", email: "", whatsapp: "5515998586167" });
  if (r.valid) throw new Error("esperado invalido");
  if (r.error?.code !== "INVALID_EMAIL") throw new Error("codigo esperado INVALID_EMAIL");
});

Deno.test("email invalido -> invalido", () => {
  const r = validateTestLicenseRequest({ name: "Ana", email: "nao-email", whatsapp: "5515998586167" });
  if (r.valid) throw new Error("esperado invalido");
  if (r.error?.code !== "INVALID_EMAIL") throw new Error("codigo esperado INVALID_EMAIL");
});

Deno.test("whatsapp ausente -> invalido", () => {
  const r = validateTestLicenseRequest({ name: "Ana", email: "ana@b.com", whatsapp: "" });
  if (r.valid) throw new Error("esperado invalido");
  if (r.error?.code !== "INVALID_WHATSAPP") throw new Error("codigo esperado INVALID_WHATSAPP");
});

Deno.test("whatsapp invalido -> invalido", () => {
  const r = validateTestLicenseRequest({ name: "Ana", email: "ana@b.com", whatsapp: "abc" });
  if (r.valid) throw new Error("esperado invalido");
  if (r.error?.code !== "INVALID_WHATSAPP") throw new Error("codigo esperado INVALID_WHATSAPP");
});

Deno.test("campos privilegiados enviados pelo cliente são ignorados", () => {
  const r = validateTestLicenseRequest({
    name: "Ana",
    email: "ana@b.com",
    whatsapp: "5515998586167",
    license_type: "NORMAL",
    plan: "ANNUAL",
    expires_at: "2099-01-01T00:00:00.000Z",
    max_devices: 100,
    status: "revoked",
    key_hash: "x".repeat(64),
  });
  // O validador só considera name/email/whatsapp; os extras não afetam a validação
  // e não são transportados para o normalized.
  if (!r.valid || !r.normalized) throw new Error("esperado valido");
  const extraKeys = Object.keys(r.normalized).filter((k) =>
    !["name", "email", "whatsapp"].includes(k)
  );
  if (extraKeys.length > 0) throw new Error("normalized contem campos privilegiados: " + extraKeys.join(","));
});

Deno.test("geração segue formato NEKO-XXXX-XXXX-XXXX-XXXX", () => {
  for (let i = 0; i < 20; i++) {
    const key = generateLicenseKey();
    if (!isValidLicenseKeyFormat(key)) throw new Error("formato invalido: " + key);
  }
});

Deno.test("máscara é NEKO-****-****-****-XXXX", () => {
  const key = "NEKO-5GCT-VB2W-678G-3MRQ";
  const mask = extractKeyMask(key);
  if (mask !== "NEKO-****-****-****-3MRQ") throw new Error("mascara inesperada: " + mask);
});

Deno.test("duração de teste é 1 hora", () => {
  if (TEST_LICENSE_DURATION_MS !== 60 * 60 * 1000) throw new Error("duração deve ser 1 hora");
});

Deno.test("normalização de e-mail e whatsapp", () => {
  if (normalizeEmail(" Foo@Bar.COM ") !== "foo@bar.com") throw new Error("email");
  if (normalizeWhatsapp("+55 (15) 9 9985-8616") !== "5515999858616") throw new Error("whatsapp");
});
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeErrorMessage } from "../src/shared/error-extractor.ts";

test("Logs and Console Sanitization - Security Audit Scenarios", async (t) => {
  await t.test("1. Bearer Token Sanitization", () => {
    const raw = "Request failed with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const sanitized = sanitizeErrorMessage(raw);
    assert.ok(!sanitized.includes("eyJhbGciOi"));
    assert.ok(sanitized.includes("Bearer [REDACTED]") || sanitized.includes("[JWT_TOKEN]"));
  });

  await t.test("2. GitHub Token Sanitization", () => {
    const raw = "git push error using ghp_99887766554433221100aabbccddeeffgghh";
    const sanitized = sanitizeErrorMessage(raw);
    assert.ok(!sanitized.includes("ghp_99887766554433221100aabbccddeeffgghh"));
    assert.strictEqual(sanitized, "git push error using [TOKEN_GITHUB]");
  });

  await t.test("3. Supabase Token Sanitization", () => {
    const raw = "Supabase connection with sbp_abcdef1234567890abcdef1234567890";
    const sanitized = sanitizeErrorMessage(raw);
    assert.ok(!sanitized.includes("sbp_abcdef1234567890abcdef1234567890"));
    assert.strictEqual(sanitized, "Supabase connection with [TOKEN_SUPABASE]");
  });

  await t.test("4. AI Provider API Keys Sanitization (OpenAI, Anthropic, Groq, Gemini, NVIDIA)", () => {
    const rawOpenAI = "OpenAI key: sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    assert.ok(!sanitizeErrorMessage(rawOpenAI).includes("sk-proj-1234567890"));
    assert.strictEqual(sanitizeErrorMessage(rawOpenAI), "OpenAI key: [API_KEY]");

    const rawGroq = "Groq key: gsk_1234567890abcdefghijklmnopqrstuvwxyz";
    assert.ok(!sanitizeErrorMessage(rawGroq).includes("gsk_1234567890"));
    assert.strictEqual(sanitizeErrorMessage(rawGroq), "Groq key: [API_KEY]");

    const rawGemini = "Gemini key: AIzaSyD1234567890abcdef1234567890abcdef";
    assert.ok(!sanitizeErrorMessage(rawGemini).includes("AIzaSyD1234567890"));
    assert.strictEqual(sanitizeErrorMessage(rawGemini), "Gemini key: [API_KEY]");

    const rawNvidia = "NVIDIA key: nvapi-1234567890abcdef1234567890abcdef";
    assert.ok(!sanitizeErrorMessage(rawNvidia).includes("nvapi-1234567890"));
    assert.strictEqual(sanitizeErrorMessage(rawNvidia), "NVIDIA key: [API_KEY]");
  });

  await t.test("5. URL and Database Credentials Sanitization", () => {
    const rawUrl = "Clone error: https://superdev:supersecretpassword@github.com/myorg/myrepo.git";
    const sanitizedUrl = sanitizeErrorMessage(rawUrl);
    assert.ok(!sanitizedUrl.includes("supersecretpassword"));
    assert.ok(!sanitizedUrl.includes("superdev:"));
    assert.strictEqual(sanitizedUrl, "Clone error: https://github.com/myorg/myrepo.git");

    const rawDb = "DB connection error: postgresql://postgres:mysecretpassword123@db.supabase.co:5432/postgres";
    const sanitizedDb = sanitizeErrorMessage(rawDb);
    assert.ok(!sanitizedDb.includes("mysecretpassword123"));
    assert.ok(!sanitizedDb.includes("postgres:mysecretpassword123@"));
    assert.strictEqual(sanitizedDb, "DB connection error: postgresql://db.supabase.co:5432/postgres");
  });

  await t.test("6. Query Parameters Secrets Sanitization", () => {
    const raw = "API request failed: https://api.example.com/v1/data?apiKey=secret_key_123&token=secret_token_456&access_token=secret_access_789";
    const sanitized = sanitizeErrorMessage(raw);
    assert.ok(!sanitized.includes("secret_key_123"));
    assert.ok(!sanitized.includes("secret_token_456"));
    assert.ok(!sanitized.includes("secret_access_789"));
    assert.strictEqual(sanitized, "API request failed: https://api.example.com/v1/data?apiKey=[REDACTED]&token=[REDACTED]&access_token=[REDACTED]");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { getUserFacingError, cleanElectronIpcEnvelope, sanitizeErrorMessage } from "../src/shared/error-extractor.ts";

test("Error Extractor - Scenarios A through K", async (t) => {
  await t.test("A) Input: Error('Repository already exists') -> 'Repository already exists'", () => {
    const err = new Error("Repository already exists");
    assert.strictEqual(getUserFacingError(err, "Fallback"), "Repository already exists");
  });

  await t.test("B) Input: 'Error: Repository already exists' -> 'Repository already exists'", () => {
    const input = "Error: Repository already exists";
    assert.strictEqual(getUserFacingError(input, "Fallback"), "Repository already exists");
  });

  await t.test("C) Input: 'Error invoking remote method \\'github:publishProject\\': Error: Repository already exists' -> 'Repository already exists'", () => {
    const input = "Error invoking remote method 'github:publishProject': Error: Repository already exists";
    assert.strictEqual(getUserFacingError(input, "Fallback"), "Repository already exists");
  });

  await t.test("D) Input: 'Error invoking remote method \\'vercel:connect\\': Error: Não foi possível abrir o terminal' -> 'Não foi possível abrir o terminal'", () => {
    const input = "Error invoking remote method 'vercel:connect': Error: Não foi possível abrir o terminal";
    assert.strictEqual(getUserFacingError(input, "Fallback"), "Não foi possível abrir o terminal");
  });

  await t.test("E) Input: null -> fallback", () => {
    assert.strictEqual(getUserFacingError(null, "Fallback padrão"), "Fallback padrão");
  });

  await t.test("F) Input: undefined -> fallback", () => {
    assert.strictEqual(getUserFacingError(undefined, "Fallback padrão"), "Fallback padrão");
  });

  await t.test("G) Input: { message: 'HTTP 422: Repository already exists' } -> 'HTTP 422: Repository already exists'", () => {
    const input = { message: "HTTP 422: Repository already exists" };
    assert.strictEqual(getUserFacingError(input, "Fallback"), "HTTP 422: Repository already exists");
  });

  await t.test("H) Input contendo token GitHub: token NÃO pode aparecer", () => {
    const input = "Authorization: Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const result = getUserFacingError(input, "Fallback");
    assert.ok(!result.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"));
    assert.strictEqual(result, "Bearer [REDACTED]");
  });

  await t.test("I) Input contendo token Supabase / API key: credencial NÃO pode aparecer", () => {
    const inputSupabase = "Falha de autenticação com sbp_1234567890abcdefghijklmnopqrstuvwxyz no endpoint";
    const resSupabase = getUserFacingError(inputSupabase, "Fallback");
    assert.ok(!resSupabase.includes("sbp_1234567890abcdefghijklmnopqrstuvwxyz"));
    assert.ok(resSupabase.includes("[TOKEN_SUPABASE]"));

    const inputOpenAI = "OpenAI error: invalid api key sk-proj-1234567890abcdefghijklmnopqrstuvwxyz123";
    const resOpenAI = getUserFacingError(inputOpenAI, "Fallback");
    assert.ok(!resOpenAI.includes("sk-proj-1234567890abcdefghijklmnopqrstuvwxyz123"));
    assert.ok(resOpenAI.includes("[API_KEY]"));
  });

  await t.test("J) Input contendo URL com credencial: https://user:password@example.com/repo.git -> credencial sanitizada", () => {
    const input = "fatal: unable to access 'https://user:password@example.com/repo.git/': The requested URL returned error: 403";
    const result = getUserFacingError(input, "Fallback");
    assert.ok(!result.includes("password"));
    assert.ok(!result.includes("user:password@"));
    assert.ok(result.includes("https://example.com/repo.git/"));
  });

  await t.test("K) Mensagem técnica normal contendo HTTP 401, HTTP 403, HTTP 422, git push rejected -> mensagem preservada", () => {
    const msg401 = "HTTP 401: Unauthorized - credentials required";
    assert.strictEqual(getUserFacingError(msg401, "Fallback"), "HTTP 401: Unauthorized - credentials required");

    const msg403 = "HTTP 403: Forbidden - resource is protected";
    assert.strictEqual(getUserFacingError(msg403, "Fallback"), "HTTP 403: Forbidden - resource is protected");

    const msg422 = "HTTP 422: Repository creation failed (name already exists on this account)";
    assert.strictEqual(getUserFacingError(msg422, "Fallback"), "HTTP 422: Repository creation failed (name already exists on this account)");

    const msgGit = "git push rejected: non-fast-forward update failed";
    assert.strictEqual(getUserFacingError(msgGit, "Fallback"), "git push rejected: non-fast-forward update failed");
  });

  await t.test("L) Input de objeto vazio ou sem mensagem útil -> fallback", () => {
    assert.strictEqual(getUserFacingError({}, "Fallback de erro"), "Fallback de erro");
    assert.strictEqual(getUserFacingError({ other: 123 }, "Fallback de erro"), "Fallback de erro");
    assert.strictEqual(getUserFacingError("", "Fallback de erro"), "Fallback de erro");
    assert.strictEqual(getUserFacingError("   ", "Fallback de erro"), "Fallback de erro");
  });

  await t.test("M) Input de objeto com structuredError ou data -> extrai mensagem", () => {
    const objStructured = { structuredError: { message: "Projeto não encontrado na organização" } };
    assert.strictEqual(getUserFacingError(objStructured, "Fallback"), "Projeto não encontrado na organização");

    const objData = { data: { message: "Rate limit excedido pelo provedor" } };
    assert.strictEqual(getUserFacingError(objData, "Fallback"), "Rate limit excedido pelo provedor");
  });
});

test("Error Extractor - Integration Specific Scenarios", async (t) => {
  await t.test("GitHub Publish: erro técnico de nome existente ou HTTP 422 é preservado", () => {
    const rawIpcError = new Error("Error invoking remote method 'github:publishProject': Error: Não foi possível criar o repositório no GitHub (HTTP 422): Repository creation failed (name already exists on this account).");
    const result = getUserFacingError(rawIpcError, "Erro ao publicar projeto.");
    assert.strictEqual(result, "Não foi possível criar o repositório no GitHub (HTTP 422): Repository creation failed (name already exists on this account).");
  });

  await t.test("GitHub Push: stderr do git push com rejeição é preservado", () => {
    const rawIpcError = new Error("Error invoking remote method 'github:commitPush': Error: Não foi possível publicar os arquivos na branch 'main': ! [rejected] main -> main (fetch first)");
    const result = getUserFacingError(rawIpcError, "Erro ao enviar alterações.");
    assert.strictEqual(result, "Não foi possível publicar os arquivos na branch 'main': ! [rejected] main -> main (fetch first)");
  });

  await t.test("GitHub Clone: erro técnico de destino já existente é preservado", () => {
    const rawIpcError = new Error("Error invoking remote method 'github:cloneProject': Error: destination path 'my-app' already exists and is not an empty directory.");
    const result = getUserFacingError(rawIpcError, "Erro ao clonar repositório.");
    assert.strictEqual(result, "destination path 'my-app' already exists and is not an empty directory.");
  });

  await t.test("Supabase Connect: status HTTP 401 e 500 continuam distinguíveis", () => {
    const err401 = new Error("Error invoking remote method 'supabase:connectWithToken': Error: Falha ao autenticar no Supabase (HTTP 401): Invalid API key");
    const res401 = getUserFacingError(err401, "Token inválido ou conexão falhou.");
    assert.strictEqual(res401, "Falha ao autenticar no Supabase (HTTP 401): Invalid API key");

    const err500 = new Error("Error invoking remote method 'supabase:connectWithToken': Error: Erro de servidor no Supabase (HTTP 500): Internal Server Error");
    const res500 = getUserFacingError(err500, "Token inválido ou conexão falhou.");
    assert.strictEqual(res500, "Erro de servidor no Supabase (HTTP 500): Internal Server Error");
  });

  await t.test("Supabase Select: erro de projeto inexistente ou sem permissão é preservado", () => {
    const errSelect = new Error("Error invoking remote method 'supabase:selectProject': Error: Projeto 'xyz' não foi encontrado ou usuário não possui acesso.");
    const resSelect = getUserFacingError(errSelect, "Erro ao selecionar projeto.");
    assert.strictEqual(resSelect, "Projeto 'xyz' não foi encontrado ou usuário não possui acesso.");
  });

  await t.test("Provider Connect: erro técnico chega sem expor chave informada", () => {
    const errProvider = new Error("Error invoking remote method 'provider:connect': Error: Chave sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz rejeitada pelo endpoint");
    const resProvider = getUserFacingError(errProvider, "Chave de API inválida ou conexão falhou.");
    assert.ok(!resProvider.includes("1234567890abcdefghijklmnopqrstuvwxyz"));
    assert.ok(resProvider.includes("[API_KEY]"));
    assert.ok(resProvider.includes("rejeitada pelo endpoint"));
  });

  await t.test("Vercel Connect: erro de cancelamento ou terminal é preservado", () => {
    const errVercel = new Error("Error invoking remote method 'vercel:connect': Error: Tentativa de login cancelada porque a janela do terminal foi fechada.");
    const resVercel = getUserFacingError(errVercel, "Erro ao conectar com Vercel.");
    assert.strictEqual(resVercel, "Tentativa de login cancelada porque a janela do terminal foi fechada.");
  });
});

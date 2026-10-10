// tests/gemini-byok-suite.test.ts
// Testes unitários e de integração para a migração de chave própria Google Gemini (BYOK)

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { GeminiVault, SafeStorageInterface } from "../src/main/gemini/gemini-vault";
import { GeminiService } from "../src/main/gemini/gemini-service";
import { sanitizeErrorMessage } from "../src/shared/error-extractor";

// Mock de SafeStorage para testes
class MockSafeStorage implements SafeStorageInterface {
  public available: boolean = true;

  public isEncryptionAvailable(): boolean {
    return this.available;
  }

  public encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error("safeStorage not available");
    // Simula criptografia segura invertendo bytes com prefixo seguro
    const simulatedCipher = Buffer.from(`ENC:${Buffer.from(plainText).toString("base64")}`);
    return simulatedCipher;
  }

  public decryptString(encrypted: Buffer): string {
    if (!this.available) throw new Error("safeStorage not available");
    const raw = encrypted.toString();
    if (!raw.startsWith("ENC:")) throw new Error("Invalid cipher payload");
    const b64 = raw.slice(4);
    return Buffer.from(b64, "base64").toString("utf8");
  }
}

describe("GeminiVault — Cofre de Chave Própria Criptografada", () => {
  let tmpDir: string;
  let vaultPath: string;
  let mockSafeStorage: MockSafeStorage;
  let vault: GeminiVault;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-gemini-vault-test-"));
    vaultPath = path.join(tmpDir, "neko-gemini-key.json");
    mockSafeStorage = new MockSafeStorage();
    vault = new GeminiVault(vaultPath, mockSafeStorage);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("1. Inicializa sem chave configurada (hasKey = false, getKeyStatus.configured = false)", async () => {
    expect(await vault.hasKey()).toBe(false);
    const status = await vault.getKeyStatus();
    expect(status.configured).toBe(false);
    expect(status.mask).toBeUndefined();
    expect(await vault.getKey()).toBeNull();
  });

  test("2. Salva e recupera chave com sucesso com mock de safeStorage", async () => {
    const rawKey = "AIzaSyD_TestKey1234567890abcdefghijklm";
    const res = await vault.saveKey(rawKey);
    expect(res.success).toBe(true);

    expect(await vault.hasKey()).toBe(true);
    const retrieved = await vault.getKey();
    expect(retrieved).toBe(rawKey);
  });

  test("3. Consulta status sem revelar a chave completa (apenas máscara)", async () => {
    const rawKey = "AIzaSyABC1234567890defghijklmnopqr";
    await vault.saveKey(rawKey);

    const status = await vault.getKeyStatus();
    expect(status.configured).toBe(true);
    expect(status.mask).toBeDefined();
    // Não pode conter o miolo confidencial da chave
    expect(status.mask).not.toBe(rawKey);
    expect(status.mask).toContain("AIza");
    expect(status.mask).toContain("••••");
    expect(status.mask).toContain("opqr");
  });

  test("4. O arquivo em disco NÃO é salvo em texto puro (está criptografado em repouso)", async () => {
    const rawKey = "AIzaSySecretPlaintextApiKey123456789";
    await vault.saveKey(rawKey);

    expect(fsSync.existsSync(vaultPath)).toBe(true);
    const fileContent = await fs.readFile(vaultPath, "utf8");
    expect(fileContent).not.toContain(rawKey); // Garante que a chave não está em texto puro

    const parsed = JSON.parse(fileContent);
    expect(parsed.version).toBe(1);
    expect(parsed.encrypted).toBeDefined();
    expect(typeof parsed.encrypted).toBe("string");
  });

  test("5. Rejeita salvar chave se o armazenamento seguro estiver indisponível (zero fallback em texto puro)", async () => {
    mockSafeStorage.available = false; // Simula falta de DPAPI / Keyring
    const rawKey = "AIzaSyTestKeyWithoutSafeStorage1234";

    const res = await vault.saveKey(rawKey);
    expect(res.success).toBe(false);
    expect(res.error).toContain("armazenamento criptográfico seguro não está disponível");

    // Garante que nenhum arquivo com chave foi gravado
    expect(fsSync.existsSync(vaultPath)).toBe(false);
    expect(await vault.hasKey()).toBe(false);
  });

  test("6. Rejeita chaves vazias ou com apenas espaços em branco", async () => {
    const res1 = await vault.saveKey("");
    expect(res1.success).toBe(false);

    const res2 = await vault.saveKey("    ");
    expect(res2.success).toBe(false);
    expect(fsSync.existsSync(vaultPath)).toBe(false);
  });

  test("7. Remove chave e limpa arquivos e cache", async () => {
    await vault.saveKey("AIzaSyDeleteMeKey1234567890abcdefg");
    expect(await vault.hasKey()).toBe(true);

    await vault.deleteKey();
    expect(await vault.hasKey()).toBe(false);
    expect(await vault.getKey()).toBeNull();
    expect(fsSync.existsSync(vaultPath)).toBe(false);
  });

  test("8. Trata arquivos corrompidos ou malformados com elegância", async () => {
    // Grava JSON corrompido
    await fs.writeFile(vaultPath, "{ malformed json ...", "utf8");
    vault.clearCache();

    expect(await vault.hasKey()).toBe(false);
    expect(await vault.getKey()).toBeNull();
  });

  test("9. Trata versão de vault incompatível", async () => {
    await fs.writeFile(vaultPath, JSON.stringify({ version: 999, encrypted: "abc" }), "utf8");
    vault.clearCache();

    expect(await vault.hasKey()).toBe(false);
    expect(await vault.getKey()).toBeNull();
  });
});

describe("GeminiService — Chamadas Diretas e Sanitização de Erros", () => {
  let tmpDir: string;
  let vaultPath: string;
  let mockSafeStorage: MockSafeStorage;
  let vault: GeminiVault;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-gemini-service-test-"));
    vaultPath = path.join(tmpDir, "neko-gemini-key.json");
    mockSafeStorage = new MockSafeStorage();
    vault = new GeminiVault(vaultPath, mockSafeStorage);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("10. Teste de chave temporária bem-sucedido (ping generateContent)", async () => {
    let calledUrl = "";
    let calledHeaders: any = {};
    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calledUrl = String(url);
      calledHeaders = init?.headers;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "pong" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.testKey("AIzaSyCandidateKeyToTest123456789");

    expect(res.success).toBe(true);
    expect(res.message).toContain("Chave validada com sucesso");
    expect(calledUrl).toContain("generativelanguage.googleapis.com");
    // A chave DEVE ir no header x-goog-api-key e NÃO exposta no query param da URL
    expect(calledUrl).not.toContain("AIzaSyCandidateKeyToTest123456789");
    expect(calledHeaders["x-goog-api-key"]).toBe("AIzaSyCandidateKeyToTest123456789");
  });

  test("11. Teste de chave com erro de autenticação (401/403) normalizado", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "API_KEY_INVALID" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.testKey("AIzaSyInvalidKey1234567890abcdef");

    expect(res.success).toBe(false);
    expect(res.error).toBe("A chave informada não foi aceita pelo Google. Verifique a chave e tente novamente.");
  });

  test("12. Teste de chave com cota/rate limit atingido (429)", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.testKey("AIzaSyExhaustedKey1234567890abcde");

    expect(res.success).toBe(false);
    expect(res.error).toContain("cota ou o limite de requisições foi atingido");
  });

  test("13. enhancePrompt exige chave configurada e recusa sem chave", async () => {
    const service = new GeminiService(vault, fetch as any);
    const res = await service.enhancePrompt("Criar um botão no React");

    expect(res.success).toBe(false);
    expect(res.error).toBe("Configure sua chave Google Gemini para utilizar este recurso.");
  });

  test("14. enhancePrompt com chave própria executa chamada direta e retorna prompt melhorado", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    let interceptedUrl = "";
    let interceptedHeaderKey = "";
    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      interceptedUrl = String(url);
      interceptedHeaderKey = (init?.headers as any)?.["x-goog-api-key"];
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Crie um botão React acessível e estilizado com Tailwind CSS." }] } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.enhancePrompt("cria um botao react");

    expect(res.success).toBe(true);
    expect(res.improvedPrompt).toBe("Crie um botão React acessível e estilizado com Tailwind CSS.");
    expect(interceptedUrl).toContain("generativelanguage.googleapis.com");
    // NENHUMA chamada para Supabase Edge Functions!
    expect(interceptedUrl).not.toContain("supabase.co");
    expect(interceptedHeaderKey).toBe("AIzaSyValidUserKey1234567890abcdefg");
  });

  test("15. transcribeAudio exige chave configurada e recusa sem chave", async () => {
    const service = new GeminiService(vault, fetch as any);
    const res = await service.transcribeAudio({ audioBase64: "dGVzdGU=", mimeType: "audio/webm" });

    expect(res.success).toBe(false);
    expect(res.error).toBe("Configure sua chave Google Gemini para utilizar este recurso.");
  });

  test("16. transcribeAudio com chave própria executa chamada direta e retorna transcrição", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    let interceptedUrl = "";
    let interceptedBody: any = null;
    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      interceptedUrl = String(url);
      interceptedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Corrigir o erro de importação no arquivo main.tsx" }] } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.transcribeAudio({
      audioBase64: "AAAAFGlmcmFtZSBhdWRpbw==",
      mimeType: "audio/webm;codecs=opus"
    });

    expect(res.success).toBe(true);
    expect(res.text).toBe("Corrigir o erro de importação no arquivo main.tsx");
    expect(interceptedUrl).toContain("generativelanguage.googleapis.com");
    expect(interceptedUrl).not.toContain("supabase.co");
    // Verifica formato multimodal
    expect(interceptedBody.contents[0].parts[0].inline_data.data).toBe("AAAAFGlmcmFtZSBhdWRpbw==");
  });

  test("17. transcribeAudio trata silêncio (VAZIO) e retorna texto vazio", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "VAZIO" }] } }]
      }), { status: 200 });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.transcribeAudio({ audioBase64: "dGVzdGU=", mimeType: "audio/webm" });

    expect(res.success).toBe(true);
    expect(res.text).toBe("");
  });

  test("18. Sanitizador de erros remove qualquer chave AIza... de mensagens de erro", () => {
    const rawError = "Failed to authenticate key AIzaSyD1234567890abcdefghijklmnopqr against endpoint";
    const sanitized = sanitizeErrorMessage(rawError);

    expect(sanitized).not.toContain("AIzaSyD1234567890abcdefghijklmnopqr");
    expect(sanitized).toContain("[API_KEY]");
  });

  test("19. enhancePrompt cancela imediatamente via cancelEnhancePrompt sem vazar erro", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          return reject(err);
        }
        signal?.addEventListener("abort", () => {
          const err = new Error("AbortError");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const opId = "test-cancel-op-123";

    const promise = service.enhancePrompt("Melhorar este prompt...", opId);

    // Dispara cancelamento imediatamente
    const cancelled = service.cancelEnhancePrompt(opId);
    expect(cancelled).toBe(true);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.improvedPrompt).toBeUndefined();
  });

  test("20. Catálogo Google AI Studio ordenado por eficiência e performance para cada tipo de tarefa", async () => {
    const { GEMINI_TEXT_MODELS, GEMINI_AUDIO_MODELS } = await import("../src/main/gemini/gemini-service");

    // Para texto (Melhorar Prompt), modelos Flash-Lite e Flash com prioridade máxima
    expect(GEMINI_TEXT_MODELS[0]).toBe("gemini-3.5-flash-lite");
    expect(GEMINI_TEXT_MODELS).toContain("gemini-3.5-flash");
    expect(GEMINI_TEXT_MODELS).toContain("gemini-3.8-flash");

    // Para áudio (Prompt por Voz), gemini-3.5-flash deve ser a prioridade 1 (comprovado em velocidade e confiabilidade WebM)
    expect(GEMINI_AUDIO_MODELS[0]).toBe("gemini-3.5-flash");
    expect(GEMINI_AUDIO_MODELS).toContain("gemini-3.8-flash");
  });

  test("21. enhancePrompt utiliza thinkingConfig: { thinkingLevel: 'MINIMAL' } em modelos Gemini 3 para eliminar latência de raciocínio", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    let interceptedBody: any = null;
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      interceptedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Prompt otimizado instantaneamente." }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.enhancePrompt("criar teste");

    expect(res.success).toBe(true);
    expect(interceptedBody.generationConfig.thinkingConfig).toBeDefined();
    expect(interceptedBody.generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");
  });

  test("22. Se a API retornar 400 por thinkingConfig, retenta imediatamente sem thinkingConfig", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    let callCount = 0;
    const interceptedBodies: any[] = [];
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      interceptedBodies.push(body);

      if (callCount === 1) {
        // Primeira chamada simula erro 400 de thinkingConfig não suportado
        return new Response(JSON.stringify({
          error: { message: "Invalid JSON payload: Unknown field 'thinkingConfig'" }
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      // Segunda chamada com retry sem thinkingConfig sucede
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Prompt recuperado com sucesso." }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.enhancePrompt("otimizar código");

    expect(res.success).toBe(true);
    expect(res.improvedPrompt).toBe("Prompt recuperado com sucesso.");
    expect(callCount).toBe(2);
    // Na primeira tentativa tinha thinkingConfig
    expect(interceptedBodies[0].generationConfig.thinkingConfig).toBeDefined();
    // Na segunda tentativa foi retirado para compatibilidade
    expect(interceptedBodies[1].generationConfig.thinkingConfig).toBeUndefined();
  });

  test("23. transcribeAudio envia generationConfig com thinkingLevel: 'MINIMAL' para máxima velocidade multimodal", async () => {
    await vault.saveKey("AIzaSyValidUserKey1234567890abcdefg");

    let interceptedBody: any = null;
    let interceptedUrl = "";
    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      interceptedUrl = String(url);
      interceptedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Áudio rápido e preciso." }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const service = new GeminiService(vault, mockFetch as any);
    const res = await service.transcribeAudio({
      audioBase64: "dGVzdGU=",
      mimeType: "audio/webm",
    });

    expect(res.success).toBe(true);
    expect(interceptedUrl).toContain("gemini-3.5-flash");
    expect(interceptedBody.generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");
  });
});



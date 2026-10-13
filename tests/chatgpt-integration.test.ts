// tests/chatgpt-integration.test.ts
// Testes automatizados para a integração com ChatGPT Pessoal no NekoAI Desktop

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
  generatePkce,
  newState,
  getLoginUrl,
  parseJwtClaims,
  extractAccountData,
  needsRefresh,
  parseRateLimitHeaders,
  extractAccountId,
  extractPlanType,
  extractEmail,
  fetchCodexModels,
  ChatGptLoopbackServer,
  fetchAccountUsage,
} from "../src/main/chatgpt/chatgpt-auth";
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_REDIRECT_URI,
  CHATGPT_ORIGINATOR,
  CHATGPT_PROVIDER_ID,
  CHATGPT_PROVIDER_NAME,
  CHATGPT_FALLBACK_MODELS,
  CHATGPT_AUTH_PORT,
  CHATGPT_BRIDGE_PORT,
  ChatGptTokens,
  ChatGptAccountData,
  formatChatGptResetTime,
} from "../src/main/chatgpt/chatgpt-types";
import { ChatGptVault, SafeStorageInterface } from "../src/main/chatgpt/chatgpt-vault";
import { ChatGptBridgeServer, BridgeManagerDelegate } from "../src/main/chatgpt/chatgpt-bridge";
import { ChatGptManager } from "../src/main/chatgpt/chatgpt-manager";

// Mock de SafeStorage para testes unitários
class MockSafeStorage implements SafeStorageInterface {
  public isEncryptionAvailable(): boolean {
    return true;
  }
  public encryptString(plainText: string): Buffer {
    // Criptografia reversível simples para teste
    return Buffer.from("ENC:" + Buffer.from(plainText).toString("base64"));
  }
  public decryptString(encrypted: Buffer): string {
    const str = encrypted.toString();
    if (!str.startsWith("ENC:")) throw new Error("Decryption failed");
    return Buffer.from(str.slice(4), "base64").toString("utf8");
  }
}

describe("ChatGPT Pessoal - Autenticação & PKCE", () => {
  it("deve gerar verifier e challenge PKCE válidos", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toBeDefined();
    expect(verifier.length).toBe(64);
    expect(challenge).toBeDefined();
    expect(challenge.length).toBeGreaterThan(20);
    // Não pode conter caracteres inválidos para base64url
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("deve gerar state CSRF aleatório e único", () => {
    const s1 = newState();
    const s2 = newState();
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1).not.toBe(s2);
    expect(s1).not.toMatch(/[+/=]/);
  });

  it("deve construir a URL de login com todos os parâmetros oficiais do Codex CLI", () => {
    const urlStr = getLoginUrl({ challenge: "test-challenge-123", state: "test-state-abc" });
    const u = new URL(urlStr);
    expect(u.origin).toBe("https://auth.openai.com");
    expect(u.pathname).toBe("/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(CHATGPT_REDIRECT_URI);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge")).toBe("test-challenge-123");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("test-state-abc");
    expect(u.searchParams.get("originator")).toBe(CHATGPT_ORIGINATOR);
    expect(u.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  });

  it("deve extrair claims e dados da conta a partir de tokens JWT", () => {
    // Cria um JWT fictício codificado em base64 com claims
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
    const payloadData = {
      email: "cliente@empresa.com",
      chatgpt_plan_type: "plus",
      chatgpt_account_id: "acc_987654321",
    };
    const payload = Buffer.from(JSON.stringify(payloadData)).toString("base64");
    const fakeJwt = `${header}.${payload}.signature`;

    const claims = parseJwtClaims(fakeJwt);
    expect(claims.email).toBe("cliente@empresa.com");
    expect(claims.chatgpt_plan_type).toBe("plus");
    expect(claims.chatgpt_account_id).toBe("acc_987654321");

    const tokens: ChatGptTokens = {
      access_token: fakeJwt,
      refresh_token: "ref_tok_123",
      expires_in: 3600,
    };

    expect(extractAccountId(tokens)).toBe("acc_987654321");
    expect(extractPlanType(tokens)).toBe("plus");
    expect(extractEmail(tokens)).toBe("cliente@empresa.com");

    const now = 1700000000000;
    const account = extractAccountData(tokens, null, now);
    expect(account.access).toBe(fakeJwt);
    expect(account.refresh).toBe("ref_tok_123");
    expect(account.conta).toBe("acc_987654321");
    expect(account.plano).toBe("plus");
    expect(account.email).toBe("cliente@empresa.com");
    expect(account.expira).toBe(now + 3600 * 1000);
  });

  it("deve detectar necessidade de renovação quando o token expirar ou estiver próximo", () => {
    const now = 1700000000000;
    const freshAccount: ChatGptAccountData = {
      access: "acc",
      refresh: "ref",
      expira: now + 3000 * 1000,
      renovarApos: now + 2000 * 1000,
      conta: "acc_1",
      plano: "pro",
      email: "test@example.com",
    };
    expect(needsRefresh(freshAccount, now)).toBe(false);

    // Faltando menos de 60 segundos
    const expiringSoon: ChatGptAccountData = {
      ...freshAccount,
      expira: now + 30_000,
    };
    expect(needsRefresh(expiringSoon, now)).toBe(true);

    // Sem refresh_token, não pode renovar
    const noRefresh: ChatGptAccountData = {
      ...expiringSoon,
      refresh: null,
    };
    expect(needsRefresh(noRefresh, now)).toBe(false);
  });

  it("deve analisar cabeçalhos de limite de uso x-codex-* corretamente", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "42.5",
      "x-codex-secondary-used-percent": "18.0",
      "x-codex-primary-reset-at": "1700005000",
      "x-codex-secondary-reset-at": "1700500000",
    });

    const usage = parseRateLimitHeaders(headers);
    expect(usage).not.toBeNull();
    expect(usage?.janela5h).toBe(42.5);
    expect(usage?.semanal).toBe(18.0);
    expect(usage?.reset5h).toBe(1700005000 * 1000);
    expect(usage?.resetSemanal).toBe(1700500000 * 1000);
  });

  it("deve converter timestamps em segundos e milissegundos e tratar valores inválidos em parseRateLimitHeaders", () => {
    // Timestamp já em milissegundos (> 100_000_000_000)
    const headersMs = new Headers({
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-reset-at": "1700005000000",
    });
    const usageMs = parseRateLimitHeaders(headersMs);
    expect(usageMs?.reset5h).toBe(1700005000000);

    // Timestamp inválido (zero ou negativo)
    const headersInvalid = new Headers({
      "x-codex-primary-used-percent": "15",
      "x-codex-primary-reset-at": "-100",
    });
    const usageInvalid = parseRateLimitHeaders(headersInvalid);
    expect(usageInvalid?.reset5h).toBeNull();
  });
});

describe("ChatGPT Pessoal - Formatação de Franquia & Horário de Renovação", () => {
  const fakeAccount: ChatGptAccountData = {
    access: "acc_token",
    refresh: "ref_token",
    expira: Date.now() + 3600000,
    renovarApos: Date.now() + 1800000,
    conta: "acc_123",
    plano: "plus",
    email: "teste@nekoai.com",
  };

  it("deve extrair uso de WHAM com suporte a reset_at e fallback para reset_after_seconds", async () => {
    // Teste 1: com reset_at Unix timestamp em segundos
    const mockFetchWithResetAt: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 9, reset_at: 1700005000 },
            secondary_window: { used_percent: 25, reset_at: 1700500000 },
          },
        }),
        { status: 200 }
      );
    };

    const usage1 = await fetchAccountUsage(fakeAccount, mockFetchWithResetAt);
    expect(usage1?.janela5h).toBe(9);
    expect(usage1?.semanal).toBe(25);
    expect(usage1?.reset5h).toBe(1700005000 * 1000);
    expect(usage1?.resetSemanal).toBe(1700500000 * 1000);

    // Teste 2: fallback quando reset_at for nulo, mas reset_after_seconds estiver presente
    const beforeMs = Date.now();
    const mockFetchWithResetAfter: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 50, reset_after_seconds: 3600 },
          },
        }),
        { status: 200 }
      );
    };

    const usage2 = await fetchAccountUsage(fakeAccount, mockFetchWithResetAfter);
    const afterMs = Date.now();
    expect(usage2?.janela5h).toBe(50);
    expect(usage2?.reset5h).toBeGreaterThanOrEqual(beforeMs + 3600 * 1000);
    expect(usage2?.reset5h).toBeLessThanOrEqual(afterMs + 3600 * 1000);
  });

  it("formatChatGptResetTime deve formatar horário previsto para o mesmo dia no formato 'Renovação prevista às 07h24'", () => {
    // Define now às 05:00 e reset às 07:24 do mesmo dia
    const now = new Date(2026, 9, 13, 5, 0, 0);
    const reset = new Date(2026, 9, 13, 7, 24, 0);

    const formatted = formatChatGptResetTime(reset.getTime(), now.getTime());
    expect(formatted).toBe("Renovação prevista às 07h24");
  });

  it("formatChatGptResetTime deve formatar horário previsto para amanhã no formato 'Renovação prevista para amanhã às 07h24'", () => {
    // Define now às 23:30 e reset às 07:24 do dia seguinte
    const now = new Date(2026, 9, 13, 23, 30, 0);
    const reset = new Date(2026, 9, 14, 7, 24, 0);

    const formatted = formatChatGptResetTime(reset.getTime(), now.getTime());
    expect(formatted).toBe("Renovação prevista para amanhã às 07h24");
  });

  it("formatChatGptResetTime deve formatar data e horário para dias posteriores no formato 'Renovação prevista para DD/MM às 07h24'", () => {
    // Define now em 13/10 e reset em 20/10 às 07:24 (ex: limite semanal)
    const now = new Date(2026, 9, 13, 10, 0, 0);
    const reset = new Date(2026, 9, 20, 7, 24, 0);

    const formatted = formatChatGptResetTime(reset.getTime(), now.getTime());
    expect(formatted).toBe("Renovação prevista para 20/10 às 07h24");
  });

  it("formatChatGptResetTime deve retornar 'Franquia renovada' quando a janela já tiver expirado (now >= resetMs)", () => {
    // Reset era às 07:24, mas agora já são 11:20
    const reset = new Date(2026, 9, 13, 7, 24, 0);
    const now = new Date(2026, 9, 13, 11, 20, 0);

    const formatted = formatChatGptResetTime(reset.getTime(), now.getTime());
    expect(formatted).toBe("Franquia renovada");
  });

  it("formatChatGptResetTime deve retornar 'Horário de renovação indisponível' para valores ausentes ou inválidos", () => {
    expect(formatChatGptResetTime(null)).toBe("Horário de renovação indisponível");
    expect(formatChatGptResetTime(undefined)).toBe("Horário de renovação indisponível");
    expect(formatChatGptResetTime(0)).toBe("Horário de renovação indisponível");
    expect(formatChatGptResetTime(-500)).toBe("Horário de renovação indisponível");
    expect(formatChatGptResetTime(NaN)).toBe("Horário de renovação indisponível");
  });

  it("não deve gerar contagens regressivas ambíguas ou valores negativos", () => {
    const now = Date.now();
    const pastReset = now - 10000;
    const formatted = formatChatGptResetTime(pastReset, now);
    expect(formatted).not.toContain("-");
    expect(formatted).not.toContain("em: 07:24");
    expect(formatted).toBe("Franquia renovada");
  });

  it("deve formatar data futura incluindo duração quando options.includeDuration for verdadeiro", () => {
    // now em 13/10/2026 às 12:00, reset em 30 dias (12/11/2026 às 12:00)
    const now = new Date(2026, 9, 13, 12, 0, 0);
    const reset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const formatted = formatChatGptResetTime(reset.getTime(), now.getTime(), { includeDuration: true });
    expect(formatted).toContain("em 30 dias");
    expect(formatted).toContain("Renovação prevista para");
  });
});

describe("ChatGPT Pessoal - Auditoria e Leitura de Limite Mensal da Conta", () => {
  const fakeAccount: ChatGptAccountData = {
    access: "test-acc-token",
    refresh: "test-ref-token",
    expira: Date.now() + 3600000,
    renovarApos: Date.now() + 1800000,
    conta: "acc_test_org",
    plano: "team",
    email: "usuario@empresa.com",
  };

  it("deve extrair limite mensal quando spend_control.individual_limit estiver presente com 100% restante (0% usado)", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          plan_type: "team",
          rate_limit: {
            primary_window: { used_percent: 15, reset_at: 1700005000 },
            secondary_window: { used_percent: 20, reset_at: 1700500000 },
          },
          spend_control: {
            reached: false,
            individual_limit: { used_percent: 0, reset_at: 1785542400 },
          },
        }),
        { status: 200 }
      );
    };

    const usage = await fetchAccountUsage(fakeAccount, mockFetch);
    expect(usage).not.toBeNull();
    expect(usage?.janela5h).toBe(15);
    expect(usage?.semanal).toBe(20);
    expect(usage?.mensalUsado).toBe(0);
    expect(usage?.mensalRestante).toBe(100);
    expect(usage?.resetMensal).toBe(1785542400 * 1000);
    expect(usage?.compartilhadoDescricao).toContain("Codex, Work");
  });

  it("deve extrair limite mensal parcialmente consumido (ex: 38% usado -> 62% restante)", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          plan_type: "team",
          rate_limit: {
            primary_window: { used_percent: 45, reset_at: 1700005000 },
          },
          spend_control: {
            individual_limit: { used_percent: 38, reset_at: 1785542400 },
          },
        }),
        { status: 200 }
      );
    };

    const usage = await fetchAccountUsage(fakeAccount, mockFetch);
    expect(usage).not.toBeNull();
    expect(usage?.mensalUsado).toBe(38);
    expect(usage?.mensalRestante).toBe(62);
  });

  it("deve manter limite mensal como nulo quando spend_control não existir (não inventar dados)", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: 1700005000 },
            secondary_window: { used_percent: 8, reset_at: 1700500000 },
          },
          spend_control: null,
        }),
        { status: 200 }
      );
    };

    const usage = await fetchAccountUsage(fakeAccount, mockFetch);
    expect(usage).not.toBeNull();
    expect(usage?.janela5h).toBe(12);
    expect(usage?.semanal).toBe(8);
    expect(usage?.mensalUsado).toBeNull();
    expect(usage?.mensalRestante).toBeNull();
    expect(usage?.resetMensal).toBeNull();
  });

  it("deve suportar rate_limit.tertiary_window ou monthly_window quando a conta fornecer limite mensal por rate_limit", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 5, reset_at: 1700005000 },
            tertiary_window: { used_percent: 10, reset_at: 1785000000 },
          },
        }),
        { status: 200 }
      );
    };

    const usage = await fetchAccountUsage(fakeAccount, mockFetch);
    expect(usage).not.toBeNull();
    expect(usage?.janela5h).toBe(5);
    expect(usage?.mensalUsado).toBe(10);
    expect(usage?.mensalRestante).toBe(90);
    expect(usage?.resetMensal).toBe(1785000000 * 1000);
  });

  it("deve garantir que os valores das janelas permaneçam estritamente isolados", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 11, reset_at: 1700001000 },
            secondary_window: { used_percent: 22, reset_at: 1700002000 },
          },
          spend_control: {
            individual_limit: { used_percent: 33, reset_at: 1700003000 },
          },
        }),
        { status: 200 }
      );
    };

    const usage = await fetchAccountUsage(fakeAccount, mockFetch);
    expect(usage?.janela5h).toBe(11);
    expect(usage?.semanal).toBe(22);
    expect(usage?.mensalUsado).toBe(33);
    expect(usage?.mensalRestante).toBe(67);
    expect(usage?.reset5h).not.toBe(usage?.resetMensal);
    expect(usage?.resetSemanal).not.toBe(usage?.resetMensal);
  });

  it("deve lidar com erros HTTP 401, 500 e falha de rede retornando null com segurança", async () => {
    const failingFetch401: typeof fetch = async () => new Response("Unauthorized", { status: 401 });
    const failingFetch500: typeof fetch = async () => new Response("Internal Server Error", { status: 500 });
    const networkFailFetch: typeof fetch = async () => {
      throw new Error("Network request failed");
    };

    expect(await fetchAccountUsage(fakeAccount, failingFetch401)).toBeNull();
    expect(await fetchAccountUsage(fakeAccount, failingFetch500)).toBeNull();
    expect(await fetchAccountUsage(fakeAccount, networkFailFetch)).toBeNull();
  });
});

describe("ChatGPT Pessoal - Cofre Criptografado (ChatGptVault)", () => {
  const testDir = path.join(os.tmpdir(), `neko-test-vault-${Date.now()}`);
  const testVaultPath = path.join(testDir, "neko-chatgpt-vault.json");
  const mockStorage = new MockSafeStorage();

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("deve salvar e carregar dados da conta de forma criptografada", async () => {
    const vault = new ChatGptVault(testVaultPath, mockStorage);

    const initial = await vault.loadAccount();
    expect(initial).toBeNull();

    const accountToSave: ChatGptAccountData = {
      access: "access_token_secret_123",
      refresh: "refresh_token_secret_456",
      expira: 1710000000000,
      renovarApos: 1709900000000,
      conta: "acc_custom_1",
      plano: "team",
      email: "colaborador@nekoai.com",
    };

    await vault.saveAccount(accountToSave);

    // Confirma que o arquivo existe e contém payload criptografado
    expect(fsSync.existsSync(testVaultPath)).toBe(true);
    const rawDisk = await fs.readFile(testVaultPath, "utf8");
    const parsed = JSON.parse(rawDisk);
    expect(parsed.version).toBe(1);
    expect(parsed.encrypted).toBeDefined();
    // O conteúdo gravado no disco NÃO pode conter as chaves em texto puro
    expect(rawDisk).not.toContain("access_token_secret_123");

    // Cria nova instância de vault para testar leitura do disco
    const newVault = new ChatGptVault(testVaultPath, mockStorage);
    const loaded = await newVault.loadAccount();

    expect(loaded).not.toBeNull();
    expect(loaded?.access).toBe("access_token_secret_123");
    expect(loaded?.refresh).toBe("refresh_token_secret_456");
    expect(loaded?.plano).toBe("team");
    expect(loaded?.email).toBe("colaborador@nekoai.com");

    // Limpa o cofre
    await newVault.clearAccount();
    expect(fsSync.existsSync(testVaultPath)).toBe(false);
    expect(await newVault.loadAccount()).toBeNull();
  });
});

describe("ChatGPT Pessoal - Descoberta de Modelos & Isolamento", () => {
  it("deve retornar modelos do catálogo e filtrar modelos com visibility diferente de list", async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          models: [
            { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "high"] },
            { slug: "hidden-internal-model", display_name: "Hidden", visibility: "hidden", priority: 2 },
            { slug: "gpt-5-mini", display_name: "GPT-5 Mini", visibility: "list", priority: 0 },
          ],
        }),
        { status: 200 }
      );
    };

    const dummyAccount: ChatGptAccountData = {
      access: "dummy",
      refresh: "dummy",
      expira: 9999999999999,
      renovarApos: 0,
      conta: "acc_1",
      plano: "pro",
      email: "test@test.com",
    };

    const models = await fetchCodexModels(dummyAccount, mockFetch as any);
    expect(models.length).toBe(2);
    // Ordenado por prioridade ascendente (0 antes de 1)
    expect(models[0].slug).toBe("gpt-5-mini");
    expect(models[1].slug).toBe("gpt-5.5");
    expect(models.find((m) => m.slug === "hidden-internal-model")).toBeUndefined();
  });

  it("deve retornar CATALOGO_RESERVA em caso de erro na resposta", async () => {
    const mockFailFetch = async () => new Response("error", { status: 500 });
    const dummyAccount: ChatGptAccountData = {
      access: "dummy",
      refresh: "dummy",
      expira: 9999999999999,
      renovarApos: 0,
      conta: null,
      plano: null,
      email: null,
    };

    const models = await fetchCodexModels(dummyAccount, mockFailFetch as any);
    expect(models).toEqual(CHATGPT_FALLBACK_MODELS);
    expect(models[0].slug).toBe("gpt-5.5");
  });

  it("deve manter isolamento estrito entre Meu ChatGPT e modelos comerciais (GPT Astra / GPT Luna / GPT Sol)", () => {
    // Assegura que identificadores comerciais do NekoAI nunca coincidem com os modelos do ChatGPT Pessoal
    const personalSlugs = ["gpt-5.5", "gpt-5-mini"];
    const commercialAliases = ["GPT ASTRA", "GPT LUNA 6", "GPT 6.1 SOL", "opencode-zen"];

    for (const slug of personalSlugs) {
      expect(commercialAliases).not.toContain(slug);
    }

    expect(CHATGPT_PROVIDER_ID).toBe("chatgpt-personal");
    expect(CHATGPT_PROVIDER_NAME).toBe("Meu ChatGPT");
  });
});

describe("ChatGPT Pessoal - Sincronização do OpenCode (opencode.json)", () => {
  const testProjectDir = path.join(os.tmpdir(), `neko-test-opencode-${Date.now()}`);
  const opencodeDir = path.join(testProjectDir, ".opencode");
  const configPath = path.join(opencodeDir, "opencode.json");

  beforeEach(async () => {
    await fs.mkdir(opencodeDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testProjectDir, { recursive: true, force: true });
    } catch {}
  });

  it("deve injetar provider chatgpt-personal em opencode.json quando conectado e remover ao desconectar", async () => {
    const mockStorage = new MockSafeStorage();
    const mockVaultPath = path.join(testProjectDir, "vault.json");
    const vault = new ChatGptVault(mockVaultPath, mockStorage);

    const manager = new ChatGptManager({
      vault,
      openExternal: async () => {},
    });

    // Salva conta simulada no vault
    await vault.saveAccount({
      access: "test_tok",
      refresh: "ref_tok",
      expira: Date.now() + 3600000,
      renovarApos: Date.now() + 1800000,
      conta: "acc_1",
      plano: "pro",
      email: "dev@neko.com",
    });

    await manager.initialize();
    expect(manager.isConnected()).toBe(true);

    // Sincroniza configuração no projeto
    await manager.syncOpenCodeConfig(testProjectDir);

    expect(fsSync.existsSync(configPath)).toBe(true);
    const content = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(content.provider).toBeDefined();
    expect(content.provider["chatgpt-personal"]).toBeDefined();
    expect(content.provider["chatgpt-personal"].npm).toBe("@ai-sdk/openai");
    expect(content.provider["chatgpt-personal"].name).toBe("Meu ChatGPT");
    expect(content.provider["chatgpt-personal"].options.baseURL).toBe("http://127.0.0.1:1456/v1");
    expect(content.provider["chatgpt-personal"].models["gpt-5.5"]).toBeDefined();

    // Desconecta e sincroniza novamente
    await manager.disconnect();
    expect(manager.isConnected()).toBe(false);

    await manager.syncOpenCodeConfig(testProjectDir);
    const contentAfter = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(contentAfter.provider?.["chatgpt-personal"]).toBeUndefined();
  });
});

describe("ChatGPT Pessoal - Servidor Loopback OAuth & Fluxo de Callback", () => {
  let loopback: ChatGptLoopbackServer;

  beforeEach(() => {
    loopback = new ChatGptLoopbackServer();
  });

  afterEach(async () => {
    loopback.stop();
    await new Promise((r) => setTimeout(r, 30));
  });

  it("deve iniciar servidor loopback na porta 1455 e receber callback com sucesso", async () => {
    const testState = "state-test-12345";
    const testCode = "code-auth-openai-xyz";

    let exchangeCalled = false;
    const callbackPromise = loopback.start(testState, async (code) => {
      expect(code).toBe(testCode);
      exchangeCalled = true;
    });

    // Simula o redirecionamento do navegador
    const res = await fetch(`http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?code=${testCode}&state=${testState}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ChatGPT Conectado!");
    expect(html).toContain("Conexão Bem-sucedida");

    const resolvedCode = await callbackPromise;
    expect(resolvedCode).toBe(testCode);
    expect(exchangeCalled).toBe(true);
  });

  it("deve rejeitar e exibir erro 400 se o state CSRF for divergente", async () => {
    const testState = "correct-state";
    const callbackPromise = loopback.start(testState);

    const [res, err] = await Promise.all([
      fetch(`http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?code=some-code&state=wrong-state`),
      callbackPromise.catch((e) => e),
    ]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Falha na Conexão");
    expect(html).toContain("Falha de validação de segurança");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("validação CSRF");
  });

  it("deve rejeitar e exibir erro se a OpenAI retornar parâmetro error", async () => {
    const testState = "state-denied";
    const callbackPromise = loopback.start(testState);

    const [res, err] = await Promise.all([
      fetch(
        `http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?error=access_denied&error_description=User+cancelled&state=${testState}`
      ),
      callbackPromise.catch((e) => e),
    ]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Falha na Conexão");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Autorização cancelada");
  });

  it("deve exibir erro 400 se o callback não incluir parâmetro code", async () => {
    const testState = "state-no-code";
    const callbackPromise = loopback.start(testState);

    const [res, err] = await Promise.all([
      fetch(`http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?state=${testState}`),
      callbackPromise.catch((e) => e),
    ]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Nenhum código de autorização foi fornecido");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("sem código de autorização");
  });

  it("deve enviar página de erro 400 ao navegador e rejeitar promise se onExchange falhar", async () => {
    const testState = "state-fail-exchange";
    const testCode = "bad-code";

    const callbackPromise = loopback.start(testState, async () => {
      throw new Error("OpenAI token exchange rejected: invalid_grant");
    });

    const [res, err] = await Promise.all([
      fetch(`http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?code=${testCode}&state=${testState}`),
      callbackPromise.catch((e) => e),
    ]);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Falha ao concluir a vinculação da conta");
    expect(html).toContain("invalid_grant");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("invalid_grant");
  });

  it("deve cancelar fluxo e liberar porta imediatamente ao chamar stop()", async () => {
    const testState = "state-cancel-test";
    const callbackPromise = loopback.start(testState);
    const errPromise = callbackPromise.catch((e) => e);

    // Usuário cancela tentativa
    loopback.stop();

    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("cancelada pelo usuário");
  });
});

describe("ChatGPT Pessoal - Fluxo Completo de startLogin no ChatGptManager", () => {
  const testDir = path.join(os.tmpdir(), `neko-test-login-${Date.now()}`);
  const mockVaultPath = path.join(testDir, "vault-login.json");
  const mockStorage = new MockSafeStorage();

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
    await new Promise((r) => setTimeout(r, 30));
  });

  it("deve completar startLogin com sucesso quando o callback for acionado e persistir sessão", async () => {
    const vault = new ChatGptVault(mockVaultPath, mockStorage);

    let openedUrl: string = "";
    const fakeTokenResponse = {
      access_token: "jwt.fake.access",
      refresh_token: "ref.fake.123",
      expires_in: 3600,
    };

    const mockFetch: typeof fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify(fakeTokenResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/codex/models")) {
        return new Response(
          JSON.stringify({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 1 }] }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/wham/usage")) {
        return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 15 } } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };

    const manager = new ChatGptManager({
      vault,
      fetchFn: mockFetch,
      openExternal: async (u) => {
        openedUrl = u;
      },
    });

    let stateReported: string = "";
    manager.onStateChange((s) => {
      stateReported = s.status;
    });

    // Inicia login
    const loginPromise = manager.startLogin();

    // Aguarda o openExternal ser chamado
    while (!openedUrl) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(stateReported).toBe("authorizing");
    expect(openedUrl).toContain("https://auth.openai.com/oauth/authorize");

    // Extrai o state gerado da URL de login
    const parsedUrl = new URL(openedUrl);
    const generatedState = parsedUrl.searchParams.get("state");
    expect(generatedState).toBeDefined();

    // Simula o browser chamando o loopback
    const res = await fetch(
      `http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?code=mock-code-123&state=${generatedState}`
    );
    expect(res.status).toBe(200);

    const loginResult = await loginPromise;
    expect(loginResult.success).toBe(true);
    expect(manager.isConnected()).toBe(true);
    expect(manager.getState().status).toBe("connected");

    // Confirma que os dados foram persistidos no vault
    const saved = await vault.loadAccount();
    expect(saved).not.toBeNull();
    expect(saved?.access).toBe("jwt.fake.access");
    expect(saved?.refresh).toBe("ref.fake.123");

    await manager.disconnect();
  });

  it("deve lidar com cancelamento pelo usuário durante authorizing sem travar", async () => {
    const vault = new ChatGptVault(mockVaultPath, mockStorage);
    let openedUrl = "";
    const manager = new ChatGptManager({
      vault,
      openExternal: async (u) => {
        openedUrl = u;
      },
    });

    const loginPromise = manager.startLogin();

    while (manager.getState().status !== "authorizing" || !openedUrl) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(manager.getState().status).toBe("authorizing");

    // Usuário clica em 'Cancelar tentativa'
    manager.cancelLogin();

    const result = await loginPromise;
    expect(result.success).toBe(false);
    expect(manager.getState().status).toBe("disconnected");
  });

  it("deve refletir erro no aplicativo e página quando a troca de tokens falhar na OpenAI", async () => {
    const vault = new ChatGptVault(mockVaultPath, mockStorage);
    let capturedUrl = "";

    const mockFailingFetch: typeof fetch = async (url: any) => {
      if (String(url).includes("/oauth/token")) {
        return new Response("Invalid authorization code", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    };

    const manager = new ChatGptManager({
      vault,
      fetchFn: mockFailingFetch,
      openExternal: async (u) => {
        capturedUrl = u;
      },
    });

    const loginPromise = manager.startLogin();

    while (!capturedUrl) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const urlObj = new URL(capturedUrl);
    const generatedState = urlObj.searchParams.get("state")!;

    // Browser chama o loopback
    const callbackRes = await fetch(
      `http://127.0.0.1:${CHATGPT_AUTH_PORT}/auth/callback?code=bad-code&state=${generatedState}`
    );
    expect(callbackRes.status).toBe(400);

    const result = await loginPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(manager.getState().status).toBe("error");
    expect(manager.getState().error).toContain("400");
  });
});

describe("ChatGPT Pessoal - Normalização de Modelos & Ponte Local (ChatGptBridgeServer)", () => {
  let bridge: ChatGptBridgeServer;
  const originalFetch = globalThis.fetch;
  let interceptedRequest: { url: string; headers: any; body: any } | null = null;
  let mockCodexSseChunks: string[] = [];

  const mockDelegate: BridgeManagerDelegate = {
    getAccount: async () => ({
      access: "test-access-token-jwt",
      refresh: "test-refresh-token",
      expira: Date.now() + 3600000,
      renovarApos: Date.now() + 1800000,
      conta: "acc_12345",
      plano: "plus",
      email: "teste@nekoai.com",
    }),
    ensureFreshToken: async () => ({
      access: "test-access-token-jwt",
      refresh: "test-refresh-token",
      expira: Date.now() + 3600000,
      renovarApos: Date.now() + 1800000,
      conta: "acc_12345",
      plano: "plus",
      email: "teste@nekoai.com",
    }),
    getModels: () => [
      { slug: "gpt-6-luna", nome: "GPT-6 Luna", niveis: [], nivelPadrao: null, resumo: false },
      { slug: "gpt-5.6-terra", nome: "GPT-5.6 Terra", niveis: [], nivelPadrao: null, resumo: false },
    ],
    onRateLimitUpdate: () => {},
  };

  beforeEach(async () => {
    interceptedRequest = null;
    mockCodexSseChunks = [
      'data: {"type":"response.output_text.delta","delta":"Texto de resposta"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Texto de resposta"}]}}\n\n',
      'data: {"type":"response.completed"}\n\n',
      'data: [DONE]\n\n',
    ];

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("127.0.0.1:1456")) {
        return originalFetch(input, init);
      }
      if (url.includes("/responses")) {
        interceptedRequest = {
          url,
          headers: init?.headers,
          body: init?.body ? JSON.parse(init.body) : null,
        };
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of mockCodexSseChunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-codex-turn-state": "turn-state-abc",
            "x-codex-primary-used-percent": "25.0",
          },
        });
      }
      return originalFetch(input, init);
    }) as any;

    bridge = new ChatGptBridgeServer(mockDelegate);
    await bridge.start();
  });

  afterEach(async () => {
    bridge.stop();
    globalThis.fetch = originalFetch;
    await new Promise((r) => setTimeout(r, 20));
  });

  it("deve normalizar o slug do modelo gpt-6-luna vindo com prefixo chatgpt-personal/", async () => {
    const res = await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-personal/gpt-6-luna",
        messages: [{ role: "user", content: "altere o texto do botão" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(interceptedRequest).not.toBeNull();
    expect(interceptedRequest?.body.model).toBe("gpt-6-luna");
    expect(interceptedRequest?.headers["chatgpt-account-id"]).toBe("acc_12345");
  });

  it("deve normalizar casing maiúsculo e outros prefixos para o slug correto (GPT-6-Luna -> gpt-6-luna)", async () => {
    const testCases = [
      { input: "GPT-6-Luna", expected: "gpt-6-luna" },
      { input: "chatgpt:GPT-6-Luna", expected: "gpt-6-luna" },
      { input: "chatgpt-personal:gpt-5.6-terra", expected: "gpt-5.6-terra" },
      { input: "openai/GPT-5.6-TERRA", expected: "gpt-5.6-terra" },
    ];

    for (const tc of testCases) {
      await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: tc.input,
          messages: [{ role: "user", content: "teste" }],
        }),
      });

      expect(interceptedRequest?.body.model).toBe(tc.expected);
    }
  });

  it("não deve enviar campo tools vazio para o Codex quando tools for []", async () => {
    await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-personal/gpt-6-luna",
        messages: [{ role: "user", content: "teste sem ferramentas" }],
        tools: [],
      }),
    });

    expect(interceptedRequest).not.toBeNull();
    expect(interceptedRequest?.body.tools).toBeUndefined();
    expect(interceptedRequest?.body.tool_choice).toBeUndefined();
  });

  it("deve formatar ferramentas corretamente quando tools possuir definições", async () => {
    await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-personal/gpt-6-luna",
        messages: [{ role: "user", content: "execute a tool" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Lê arquivo",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      }),
    });

    expect(interceptedRequest).not.toBeNull();
    expect(interceptedRequest?.body.tools).toBeDefined();
    expect(interceptedRequest?.body.tools.length).toBe(1);
    expect(interceptedRequest?.body.tools[0].name).toBe("read_file");
    expect(interceptedRequest?.body.tool_choice).toBe("auto");
    expect(interceptedRequest?.body.parallel_tool_calls).toBe(true);
  });

  it("deve deduplicar texto no streaming SSE e não duplicar ao receber output_item.done", async () => {
    const res = await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-personal/gpt-6-luna",
        messages: [{ role: "user", content: "teste streaming" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));

    let accumulatedContent = "";
    for (const line of lines) {
      const data = JSON.parse(line.replace("data: ", ""));
      if (data.choices?.[0]?.delta?.content) {
        accumulatedContent += data.choices[0].delta.content;
      }
    }

    expect(accumulatedContent).toBe("Texto de resposta");
  });

  it("deve atender a requisições POST /v1/responses com streaming SSE nativo e normalização de slug (OpenCode)", async () => {
    const res = await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-personal/gpt-6-luna",
        input: [{ role: "user", content: "Altere o texto do botão da seção Hero para Agende agora." }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(interceptedRequest).not.toBeNull();
    expect(interceptedRequest?.body.model).toBe("gpt-6-luna");
    expect(interceptedRequest?.headers["chatgpt-account-id"]).toBe("acc_12345");

    const text = await res.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(text).toContain("[DONE]");
  });

  it("deve suportar requisições POST /v1/responses no modo não-streaming agregando os eventos do Codex", async () => {
    const res = await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-personal/gpt-6-luna",
        input: [{ role: "user", content: "teste sem streaming" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe("response");
    expect(data.status).toBe("completed");
    expect(data.model).toBe("gpt-6-luna");
    expect(data.output_text).toBe("Texto de resposta");
    expect(data.output).toBeDefined();
    expect(data.output.length).toBeGreaterThan(0);
  });

  it("deve retornar 404 e payload JSON explicativo para endpoint desconhecido no Bridge", async () => {
    const res = await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/endpoint-inexistente`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeDefined();
    expect(json.error.message).toContain("Endpoint /v1/endpoint-inexistente não encontrado no Bridge.");
  });

  it("deve repassar erros upstream na rota /v1/responses com status e corpo JSON", async () => {
    const tempFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("127.0.0.1:1456")) {
        return originalFetch(input, init);
      }
      if (url.includes("/responses")) {
        return new Response(
          JSON.stringify({
            error: {
              message: "The model 'gpt-6-luna' does not exist or you do not have access to it.",
              type: "invalid_request_error",
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      return originalFetch(input, init);
    }) as any;

    try {
      const res = await fetch(`http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-personal/gpt-6-luna",
          input: [{ role: "user", content: "teste erro" }],
        }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.message).toContain("The model 'gpt-6-luna' does not exist");
    } finally {
      globalThis.fetch = tempFetch;
    }
  });
});

describe("ChatGPT Pessoal - Sincronização Resiliente & Pré-Voo", () => {
  const testDir = path.join(os.tmpdir(), `neko-test-resilient-${Date.now()}`);
  const opencodeDir = path.join(testDir, ".opencode");
  const dotOpencodeJson = path.join(opencodeDir, "opencode.json");
  const rootOpencodeJson = path.join(testDir, "opencode.json");

  beforeEach(async () => {
    await fs.mkdir(opencodeDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  });

  it("deve recuperar-se com segurança de opencode.json malformado ou corrompido", async () => {
    await fs.writeFile(dotOpencodeJson, '{\n  "provider": {\n  },\n}', "utf8");

    const mockStorage = new MockSafeStorage();
    const vault = new ChatGptVault(path.join(testDir, "vault.json"), mockStorage);
    const manager = new ChatGptManager({ vault, openExternal: async () => {} });

    await vault.saveAccount({
      access: "token",
      refresh: "refresh",
      expira: Date.now() + 3600000,
      renovarApos: Date.now() + 1800000,
      conta: "acc_1",
      plano: "pro",
      email: "test@test.com",
    });

    await manager.initialize();
    await expect(manager.syncOpenCodeConfig(testDir)).resolves.toBeUndefined();

    const content = JSON.parse(await fs.readFile(dotOpencodeJson, "utf8"));
    expect(content.provider?.["chatgpt-personal"]).toBeDefined();
    await manager.disconnect();
  });

  it("deve sincronizar tanto .opencode/opencode.json quanto opencode.json na raiz se existir", async () => {
    await fs.writeFile(dotOpencodeJson, JSON.stringify({ mcp: {} }), "utf8");
    await fs.writeFile(rootOpencodeJson, JSON.stringify({ mcp: {} }), "utf8");

    const mockStorage = new MockSafeStorage();
    const vault = new ChatGptVault(path.join(testDir, "vault.json"), mockStorage);
    const manager = new ChatGptManager({ vault, openExternal: async () => {} });

    await vault.saveAccount({
      access: "token",
      refresh: "refresh",
      expira: Date.now() + 3600000,
      renovarApos: Date.now() + 1800000,
      conta: "acc_1",
      plano: "pro",
      email: "test@test.com",
    });

    await manager.initialize();
    await manager.syncOpenCodeConfig(testDir);

    const dotConfig = JSON.parse(await fs.readFile(dotOpencodeJson, "utf8"));
    const rootConfig = JSON.parse(await fs.readFile(rootOpencodeJson, "utf8"));

    expect(dotConfig.provider?.["chatgpt-personal"]).toBeDefined();
    expect(rootConfig.provider?.["chatgpt-personal"]).toBeDefined();
    await manager.disconnect();
  });

  it("ensureBridgeRunning deve inicializar o servidor de ponte quando inativo", async () => {
    const mockStorage = new MockSafeStorage();
    const vault = new ChatGptVault(path.join(testDir, "vault.json"), mockStorage);
    const manager = new ChatGptManager({ vault, openExternal: async () => {} });

    await vault.saveAccount({
      access: "token",
      refresh: "refresh",
      expira: Date.now() + 3600000,
      renovarApos: Date.now() + 1800000,
      conta: "acc_1",
      plano: "pro",
      email: "test@test.com",
    });

    await manager.initialize();
    expect(manager.isBridgeRunning()).toBe(true);

    await manager.ensureBridgeRunning();
    expect(manager.isBridgeRunning()).toBe(true);

    await manager.disconnect();
    expect(manager.isBridgeRunning()).toBe(false);
  });
});


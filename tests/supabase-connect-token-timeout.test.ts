import { test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";
import { SupabaseCli, parseSupabaseError, sanitizeLog } from "../src/main/supabase/supabase-cli";

test("TESTE 1: Máquina limpa sem Supabase CLI + PAT válido -> login e listagem de projetos ocorrem em milissegundos via REST API", async () => {
  const mockFetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/organizations")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "org-123", name: "Empresa do Cliente" }],
      } as any;
    }
    if (urlStr.includes("/projects")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "proj-1", ref: "xyzproj", name: "Meu App", region: "sa-east-1", status: "ACTIVE_HEALTHY" },
        ],
      } as any;
    }
    return { ok: false, status: 404 } as any;
  }) as typeof fetch;

  const cli = new SupabaseCli(mockFetch);

  const start = Date.now();
  await cli.login("sbp_valid_client_token_test");
  const projects = await cli.listProjects();
  const orgs = await cli.listOrganizations();
  const duration = Date.now() - start;

  expect(projects.length).toBe(1);
  expect(projects[0].ref).toBe("xyzproj");
  expect(projects[0].name).toBe("Meu App");
  expect(projects[0].status).toBe("ACTIVE_HEALTHY");

  expect(orgs.length).toBe(1);
  expect(orgs[0].id).toBe("org-123");
  expect(orgs[0].name).toBe("Empresa do Cliente");

  // A execução deve ser praticamente instantânea (não aguarda timeout de CLI ou npx)
  expect(duration).toBeLessThan(1000);
});

test("TESTE 2: PAT inválido (HTTP 401) -> erro claro mapeado para AUTH_EXPIRED sem timeout", async () => {
  const mockFetch = (async () => {
    return {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as any;
  }) as typeof fetch;

  const cli = new SupabaseCli(mockFetch);

  let thrownError: any = null;
  try {
    await cli.login("sbp_invalid_token_xyz");
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  expect(thrownError.message).toContain("O token de acesso do Supabase é inválido ou expirou.");
  const parsed = parseSupabaseError(thrownError);
  expect(parsed.code).toBe("AUTH_EXPIRED");
  expect(parsed.title).toBe("Autenticação expirada");
  expect(parsed.message).toBe("O token de acesso do Supabase é inválido ou expirou.");
});

test("TESTE 3: Falha de rede na conexão -> erro claro mapeado para NETWORK_ERROR", async () => {
  const mockFetch = (async () => {
    throw new Error("ENOTFOUND api.supabase.com");
  }) as typeof fetch;

  const cli = new SupabaseCli(mockFetch);

  let thrownError: any = null;
  try {
    await cli.login("sbp_network_fail_token");
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  const parsed = parseSupabaseError(thrownError);
  expect(parsed.code).toBe("NETWORK_ERROR");
  expect(parsed.title).toBe("Erro de conexão");
});

test("TESTE 4: Timeout real de rede -> mapeado para TIMEOUT", async () => {
  const mockFetch = (async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  }) as typeof fetch;

  const cli = new SupabaseCli(mockFetch);

  let thrownError: any = null;
  try {
    await cli.login("sbp_timeout_token");
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  const parsed = parseSupabaseError(thrownError);
  expect(parsed.code).toBe("TIMEOUT");
  expect(parsed.title).toBe("Tempo limite excedido");
  expect(parsed.message).toBe("A operação demorou mais que o esperado.");
});

test("TESTE 5: O token de acesso (PAT) é gravado canonicamente em ~/.supabase/access-token", async () => {
  const testToken = "sbp_canonical_storage_test_123456";
  const mockFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => [],
  })) as any;

  const cli = new SupabaseCli(mockFetch);
  await cli.login(testToken);

  const home = os.homedir();
  const tokenFile = path.join(home, ".supabase", "access-token");
  expect(fsSync.existsSync(tokenFile)).toBe(true);
  const stored = fsSync.readFileSync(tokenFile, "utf8").trim();
  expect(stored).toBe(testToken);

  // readStoredCliToken recupera o token corretamente
  expect(cli.readStoredCliToken()).toBe(testToken);
});

test("TESTE 6: O PAT é completamente protegido e nunca exposto em logs ou erros", () => {
  const secretToken = "sbp_secret_ultra_sensitive_token_999";
  const loggedMessage = `Executing supabase login with token ${secretToken} and header Bearer ${secretToken}`;
  const sanitized = sanitizeLog(loggedMessage);

  expect(sanitized).not.toContain(secretToken);
  expect(sanitized).toContain("[REDACTED_KEY]");
});

test("TESTE 7: fetchApiKeys e createProject funcionam via REST API", async () => {
  const mockFetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/api-keys")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { name: "anon", api_key: "anon-secret-key-xyz" },
          { name: "service_role", api_key: "service-secret-key-xyz" },
        ],
      } as any;
    }
    if (urlStr.includes("/projects") && init?.method === "POST") {
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: "new-proj", ref: "new-proj" }),
      } as any;
    }
    return { ok: false, status: 404 } as any;
  }) as typeof fetch;

  const cli = new SupabaseCli(mockFetch);
  // Simula token em memória
  (cli as any).inMemoryToken = "sbp_test_token";

  const { publishableKey } = await cli.fetchApiKeys("my-ref");
  expect(publishableKey).toBe("anon-secret-key-xyz");

  await cli.createProject({
    name: "New Project",
    orgId: "org-1",
    dbPassword: "StrongPassword123!",
  });
});

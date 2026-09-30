import { test, expect } from "bun:test";
import { SupabaseCli, extractOAuthUrl, parseSupabaseError } from "../src/main/supabase/supabase-cli";
import { resolveNodeRuntime, getEmbeddedRuntimeEnv } from "../src/main/node-runtime";
import { sanitizeErrorMessage } from "../src/shared/error-extractor";

test("OAUTH 1: URL OAuth detectada a partir de stdout", () => {
  const stdout = "Log 1...\nVisit https://mcp.supabase.com/mcp?project_ref=test1234 to authenticate.\nLog 2...";
  const url = extractOAuthUrl(stdout);
  expect(url).toBe("https://mcp.supabase.com/mcp?project_ref=test1234");
});

test("OAUTH 2: URL OAuth detectada a partir de stderr", () => {
  const stderr = "[stderr] https://api.supabase.com/v1/oauth/authorize?client_id=neko_cli&ref=abc\n";
  const url = extractOAuthUrl(stderr);
  expect(url).toBe("https://api.supabase.com/v1/oauth/authorize?client_id=neko_cli&ref=abc");
});

test("OAUTH 3: URL OAuth fragmentada entre chunks de streaming é detectada via buffer acumulado", () => {
  let accumulated = "";
  const chunk1 = "Connecting to OpenCode MCP... URL: https://mcp.";
  const chunk2 = "supabase.com/mcp?project_ref=fragmented_ref_999 to complete login";
  
  accumulated += chunk1;
  let detected = extractOAuthUrl(accumulated);
  expect(detected).toBeNull(); // incompleta no chunk 1

  accumulated += chunk2;
  detected = extractOAuthUrl(accumulated);
  expect(detected).toBe("https://mcp.supabase.com/mcp?project_ref=fragmented_ref_999");
});

test("OAUTH 4: URL detectada -> openExternal é chamado com sucesso e reporta browserOpened=true", async () => {
  const cli = new SupabaseCli();
  let openedUrl: string | null = null;
  let browserOpenedState = false;

  cli.runOpenCodeMcp = async (_args: string[], _cwd: string, optionsOrTimeout?: any) => {
    const opts = typeof optionsOrTimeout === "object" ? optionsOrTimeout : {};
    opts.onUrlDetected?.("https://mcp.supabase.com/mcp?project_ref=proj_ok");
    return { code: 0, stdout: "Auth done", stderr: "", output: "Auth done" };
  };
  cli.checkMcpAuthStatus = async () => true;

  const success = await cli.authenticateOpenCodeSupabase("C:\\test\\dir", "proj_ok", {
    onProgress: (status, _url, opened) => {
      if (status === "authorizing") {
        browserOpenedState = opened ?? false;
      }
    },
    openExternal: async (url) => {
      openedUrl = url;
    },
  });

  expect(success).toBe(true);
  expect(openedUrl).toBe("https://mcp.supabase.com/mcp?project_ref=proj_ok");
  expect(browserOpenedState).toBe(true);
});

test("OAUTH 5: openExternal falha -> browserOpened é false e fluxo não trava", async () => {
  const cli = new SupabaseCli();
  let browserOpenedState: boolean | null = null;

  cli.runOpenCodeMcp = async (_args: string[], _cwd: string, optionsOrTimeout?: any) => {
    const opts = typeof optionsOrTimeout === "object" ? optionsOrTimeout : {};
    opts.onUrlDetected?.("https://mcp.supabase.com/mcp?project_ref=proj_fail_open");
    return { code: 0, stdout: "Auth done", stderr: "", output: "Auth done" };
  };
  cli.checkMcpAuthStatus = async () => true;

  const success = await cli.authenticateOpenCodeSupabase("C:\\test\\dir", "proj_fail_open", {
    onProgress: (status, _url, opened) => {
      if (status === "authorizing") {
        browserOpenedState = opened ?? false;
      }
    },
    openExternal: async () => {
      throw new Error("Falha ao abrir navegador padrão do Windows.");
    },
  });

  expect(success).toBe(true);
  expect(browserOpenedState).toBe(false);
});

test("OAUTH 6 & 7: OpenCode encerra com exit code != 0 antes da URL -> erro imediato", async () => {
  const cli = new SupabaseCli();
  cli.runOpenCodeMcp = async () => {
    return { code: 1, stdout: "", stderr: "Fatal error: failed to resolve MCP config", output: "Fatal error: failed to resolve MCP config" };
  };
  cli.checkMcpAuthStatus = async () => false;

  let thrownError: any = null;
  try {
    await cli.authenticateOpenCodeSupabase("C:\\test\\dir", "proj_crash");
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  expect(thrownError.message).toContain("Fatal error");
});

test("OAUTH 8: OAuth cancelado pelo usuário -> encerra com mensagem de cancelamento", async () => {
  const cli = new SupabaseCli();
  const abort = new AbortController();

  cli.runOpenCodeMcp = async (args: string[], _cwd: string, opts?: any) => {
    if (args.includes("list")) {
      return { code: 0, stdout: "", stderr: "", output: "" };
    }
    return new Promise((_, reject) => {
      const abortHandler = () => {
        reject(new Error("A operação do OpenCode MCP foi cancelada pelo usuário."));
      };
      if (opts?.signal) {
        if (opts.signal.aborted) {
          abortHandler();
          return;
        }
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  };
  cli.checkMcpAuthStatus = async () => false;

  const promise = cli.authenticateOpenCodeSupabase("C:\\test\\dir", "proj_cancel", {
    signal: abort.signal,
  });
  abort.abort();

  let thrownError: any = null;
  try {
    await promise;
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  expect(thrownError.message).toContain("cancelada");
});

test("OAUTH 9: OAuth concluído no OpenCode mas não confirmado pelo MCP -> erro lançado", async () => {
  const cli = new SupabaseCli();
  cli.runOpenCodeMcp = async () => {
    return { code: 0, stdout: "Finished", stderr: "", output: "Finished" };
  };
  cli.checkMcpAuthStatus = async () => false; // Não autenticado

  let thrownError: any = null;
  try {
    await cli.authenticateOpenCodeSupabase("C:\\test\\dir", "proj_unverified");
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  expect(thrownError.message).toContain("não confirmou credenciais");
});

test("RUNTIME 1: Node e Git embutidos são resolvidos e adicionados ao PATH sem alterar process.env global", () => {
  const originalPath = process.env.PATH || "";
  const embeddedEnv = getEmbeddedRuntimeEnv();

  expect(embeddedEnv.PATH).toBeDefined();
  expect(process.env.PATH).toBe(originalPath); // process.env global NÃO sofre mutação

  const runtime = resolveNodeRuntime();
  expect(runtime.isBundled).toBe(true);
  expect(embeddedEnv.PATH?.toLowerCase()).toContain(runtime.binDir.toLowerCase());
});

test("MANAGEMENT API: Diagnóstico correto de status HTTP e erros de rede", async () => {
  // 1. 401 Auth Expired
  const err401 = parseSupabaseError("Supabase API retornou erro HTTP 401");
  expect(err401.code).toBe("AUTH_EXPIRED");

  // 2. 429 Rate Limit
  const err429 = parseSupabaseError("Limite de requisições do Supabase atingido (429)");
  expect(err429.code).toBe("RATE_LIMIT");

  // 3. 500 Server Error
  const err500 = parseSupabaseError("Servidores do Supabase instáveis ou indisponíveis (HTTP 500)");
  expect(err500.code).toBe("SERVER_ERROR");

  // 4. DNS / ENOTFOUND
  const errDns = parseSupabaseError("ENOTFOUND api.supabase.com");
  expect(errDns.code).toBe("NETWORK_ERROR");

  // 5. TLS / Cert
  const errTls = parseSupabaseError("CERT_HAS_EXPIRED: certificate has expired");
  expect(errTls.code).toBe("TLS_ERROR");

  // 6. Timeout
  const errTimeout = parseSupabaseError("A operação do Supabase excedeu o tempo limite");
  expect(errTimeout.code).toBe("TIMEOUT");
});

test("SEGURANÇA: PATs, Bearer tokens e chaves nunca vazam nos erros e logs", () => {
  const dirty = "Error invoking remote method: Authorization: Bearer sbp_abc1234567890xyz and token sbp_secret999999999999";
  const sanitized = sanitizeErrorMessage(dirty);

  expect(sanitized).not.toContain("sbp_abc1234567890xyz");
  expect(sanitized).not.toContain("sbp_secret999999999999");
  expect(sanitized).toContain("Bearer [REDACTED]");
  expect(sanitized).toContain("[TOKEN_SUPABASE]");
});

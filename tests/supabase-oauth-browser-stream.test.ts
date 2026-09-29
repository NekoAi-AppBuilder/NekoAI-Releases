import { test, expect } from "bun:test";
import { SupabaseCli, extractOAuthUrl } from "../src/main/supabase/supabase-cli";

test("TESTE 1: extractOAuthUrl detecta e normaliza URLs HTTP e HTTPS de streams com ou sem ANSI codes", () => {
  const samples = [
    {
      input: "Authorize in your browser:\nhttps://api.supabase.com/v1/oauth/authorize?client_id=opencode&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&response_type=code\nWaiting for authorization...",
      expected: "https://api.supabase.com/v1/oauth/authorize?client_id=opencode&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&response_type=code",
    },
    {
      input: "\x1B[32mAuthorize in your browser:\x1B[0m \x1B[34mhttps://supabase.com/dashboard/account/tokens\x1B[0m",
      expected: "https://supabase.com/dashboard/account/tokens",
    },
    {
      input: "Visit https://mcp.supabase.com/mcp?project_ref=myref123 to authorize.",
      expected: "https://mcp.supabase.com/mcp?project_ref=myref123",
    },
    {
      input: "Apenas logs sem nenhuma URL no meio da saída padrão.",
      expected: null,
    },
  ];

  for (const { input, expected } of samples) {
    const res = extractOAuthUrl(input);
    expect(res).toBe(expected);
  }
});

test("TESTE 2: URL OAuth detectada no streaming -> dispara openExternal automaticamente e atualiza status", async () => {
  const cli = new SupabaseCli();
  let openedUrl: string | null = null;
  let detectedUrlInProgress: string | null = null;
  let openedFlagInProgress = false;

  // Mock de runOpenCodeMcp simulando emissão de URL em tempo real pelo opencode
  cli.runOpenCodeMcp = async (_args: string[], _cwd: string, optionsOrTimeout?: any) => {
    const opts = typeof optionsOrTimeout === "object" ? optionsOrTimeout : {};
    if (opts.onUrlDetected) {
      opts.onUrlDetected("https://api.supabase.com/v1/oauth/authorize?client_id=123&response_type=code");
    }
    return { code: 0, stdout: "Authentication successful!", stderr: "", output: "Authentication successful!" };
  };

  cli.checkMcpAuthStatus = async () => true;

  const success = await cli.authenticateOpenCodeSupabase("C:\\fake\\project", "myref", {
    onProgress: (status, url, opened) => {
      if (status === "authorizing" && url) {
        detectedUrlInProgress = url;
        openedFlagInProgress = opened ?? false;
      }
    },
    openExternal: async (url) => {
      openedUrl = url;
    },
  });

  expect(success).toBe(true);
  expect(openedUrl).toBe("https://api.supabase.com/v1/oauth/authorize?client_id=123&response_type=code");
  expect(detectedUrlInProgress).toBe("https://api.supabase.com/v1/oauth/authorize?client_id=123&response_type=code");
  expect(openedFlagInProgress).toBe(true);
});

test("TESTE 3: URL não detectada -> openExternal não é chamado e openedFlag permanece false", async () => {
  const cli = new SupabaseCli();
  let openExternalCalled = false;
  let detectedUrlInProgress: string | null = null;
  let openedFlagInProgress = false;

  cli.runOpenCodeMcp = async (_args: string[], _cwd: string, _optionsOrTimeout?: any) => {
    return { code: 0, stdout: "Direct authenticated!", stderr: "", output: "Direct authenticated!" };
  };
  cli.checkMcpAuthStatus = async () => true;

  const success = await cli.authenticateOpenCodeSupabase("C:\\fake\\project", "myref", {
    onProgress: (status, url, opened) => {
      if (status === "authorizing") {
        detectedUrlInProgress = url || null;
        openedFlagInProgress = opened ?? false;
      }
    },
    openExternal: async (_url) => {
      openExternalCalled = true;
    },
  });

  expect(success).toBe(true);
  expect(openExternalCalled).toBe(false);
  expect(detectedUrlInProgress).toBeNull();
  expect(openedFlagInProgress).toBe(false);
});

test("TESTE 4: Cancelamento explícito encerra o processo e lança erro amigável de cancelamento", async () => {
  const cli = new SupabaseCli();
  const abortController = new AbortController();
  let processTerminated = false;

  cli.runOpenCodeMcp = async (args: string[], _cwd: string, optionsOrTimeout?: any) => {
    const opts = typeof optionsOrTimeout === "object" ? optionsOrTimeout : {};
    if (args.includes("list")) {
      return { code: 0, stdout: "", stderr: "", output: "" };
    }
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        processTerminated = true;
        reject(new Error("A operação do OpenCode MCP foi cancelada pelo usuário."));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          abortHandler();
          return;
        }
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  };

  cli.checkMcpAuthStatus = async () => false;

  const authPromise = cli.authenticateOpenCodeSupabase("C:\\fake\\project", "myref", {
    signal: abortController.signal,
  });

  // Dispara cancelamento pelo usuário
  abortController.abort();

  let thrownError: any = null;
  try {
    await authPromise;
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  expect(thrownError.message).toContain("cancelada");
  expect(processTerminated).toBe(true);
});

test("TESTE 5: cancelActiveOAuth no SupabaseCli encerra o processo ativo imediatamente", () => {
  const cli = new SupabaseCli();
  let terminateCalled = false;
  const fakeChild: any = { pid: 1234, kill: () => { terminateCalled = true; } };
  (cli as any).activeOAuthChild = fakeChild;
  (cli as any).terminate = (child: any) => {
    if (child === fakeChild) terminateCalled = true;
  };

  cli.cancelActiveOAuth();

  expect(terminateCalled).toBe(true);
  expect((cli as any).activeOAuthChild).toBeNull();
});

test("TESTE 6: Erro retornado pelo OpenCode chega à UI e trata falha", async () => {
  const cli = new SupabaseCli();
  cli.runOpenCodeMcp = async () => {
    return { code: 1, stdout: "", stderr: "Authentication failed: invalid code", output: "Authentication failed: invalid code" };
  };
  cli.checkMcpAuthStatus = async () => false;

  let thrownError: any = null;
  try {
    await cli.authenticateOpenCodeSupabase("C:\\fake\\project", "myref");
  } catch (err) {
    thrownError = err;
  }

  expect(thrownError).not.toBeNull();
  expect(thrownError.message).toContain("Authentication failed: invalid code");
});

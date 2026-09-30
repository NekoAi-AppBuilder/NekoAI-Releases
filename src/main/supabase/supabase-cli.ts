import { spawn, ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SupabaseProject,
  SupabaseOrganization,
  SupabaseCreateProjectPayload,
  SupabaseStructuredError,
} from "./supabase-types";
import { resolveNodeRuntime, getEmbeddedRuntimeEnv } from "../node-runtime";

export function sanitizeLog(text: string): string {
  return text
    .replace(/--token\s+[^\s]+/gi, "--token [REDACTED]")
    .replace(/--db-password\s+[^\s]+/gi, "--db-password [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sbp_[A-Za-z0-9_]+/gi, "[REDACTED_KEY]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "[REDACTED_JWT]");
}

export function extractOAuthUrl(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const clean = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = clean.match(/https?:\/\/[^\s"'<>\`\)]+/gi);
  if (!matches) return null;
  for (let urlStr of matches) {
    urlStr = urlStr.replace(/[.,;:!?]+$/, "");
    try {
      const parsed = new URL(urlStr);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        (parsed.hostname.includes(".") || parsed.hostname === "localhost")
      ) {
        return parsed.toString();
      }
    } catch {}
  }
  return null;
}

export function classifyFetchError(err: any, context: string): Error {
  if (err?.name === "TimeoutError" || /timed out|tempo limite/i.test(err?.message || "")) {
    return new Error(`A operação do Supabase excedeu o tempo limite ao ${context}.`);
  }
  if (/ENOTFOUND|getaddrinfo/i.test(err?.message || "")) {
    return new Error(`Não foi possível resolver o endereço dos servidores do Supabase (erro de DNS). Verifique sua conexão ao ${context}.`);
  }
  if (/ECONNREFUSED/i.test(err?.message || "")) {
    return new Error(`Conexão recusada ao conectar aos servidores do Supabase ao ${context}.`);
  }
  if (/CERT_|certificate|self-signed|tls|ssl/i.test(err?.message || "")) {
    return new Error(`Erro de certificado de segurança (TLS/SSL) ao conectar ao Supabase ao ${context}.`);
  }
  return new Error(`Erro de conexão com o Supabase ao ${context}: ${err?.message || "falha de rede"}`);
}

export function parseSupabaseError(rawError: any): SupabaseStructuredError {
  let text = "";
  if (typeof rawError === "string") {
    text = rawError;
  } else if (rawError && typeof rawError.message === "string") {
    text = rawError.message;
  } else if (rawError) {
    text = String(rawError);
  }

  // Limpa prefixos internos do Electron IPC, ChildProcess e CLI
  text = text
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/^Creating project:\s*/i, "")
    .trim();

  // 1. Limite de projetos gratuitos atingido
  if (
    /maximum limits? for the number of active free projects/i.test(text) ||
    /reached (?:their|the) maximum limit/i.test(text) ||
    /(?:free project limit|project limit)/i.test(text)
  ) {
    const limitMatch = text.match(/\((\d+)\s+project limit\)/i) || text.match(/limit of (\d+)/i);
    const limitCount = limitMatch ? limitMatch[1] : null;
    const limitStr = limitCount
      ? `o limite de ${limitCount} projetos gratuitos ativos`
      : "o limite de projetos gratuitos ativos";

    return {
      code: "FREE_PROJECT_LIMIT",
      title: "Limite de projetos gratuitos atingido",
      message: `Esta organização já atingiu ${limitStr}.`,
      detail:
        "Para criar outro projeto, exclua ou pause um projeto existente ou faça upgrade do plano no painel do Supabase.",
      isLimit: true,
    };
  }

  // 2. Organização inválida ou sem permissão
  if (/organization not found|invalid org[-_]?id|organization does not exist/i.test(text)) {
    return {
      code: "INVALID_ORGANIZATION",
      title: "Organização inválida",
      message:
        "A organização selecionada não foi encontrada ou você não possui permissão de administrador nela.",
      detail: "Selecione outra organização ou crie uma nova no painel do Supabase.",
    };
  }

  // 3. Região indisponível
  if (/invalid region|region not supported|region is not available/i.test(text)) {
    return {
      code: "INVALID_REGION",
      title: "Região indisponível",
      message: "A região selecionada não está disponível para criação de projetos no momento.",
      detail: "Selecione outra região (como sa-east-1 ou us-east-1) e tente novamente.",
    };
  }

  // 4. Nome de projeto inválido
  if (
    /invalid (?:project )?name|project name is too (?:short|long)|project name contains invalid characters/i.test(
      text
    )
  ) {
    return {
      code: "INVALID_PROJECT_NAME",
      title: "Nome de projeto inválido",
      message: "O nome do projeto informado não é válido.",
      detail: "Use apenas letras minúsculas, números e hifens (ex.: meu-novo-projeto).",
    };
  }

  // 5. Senha do banco fraca
  if (/password is too weak|password must contain|weak password|invalid password/i.test(text)) {
    return {
      code: "WEAK_PASSWORD",
      title: "Senha do banco fraca",
      message: "A senha do banco de dados não atende aos requisitos de segurança.",
      detail:
        "A senha deve ter pelo menos 8 caracteres e conter letras maiúsculas, minúsculas, números e símbolos.",
    };
  }

  // 6. Token / PAT inválido ou expirado
  if (/invalid access token|unauthorized|401|403|token expired|invalid token|token.*(?:inválido|invalido|expirou)|autentica(?:ção|cao) expirada/i.test(text)) {
    return {
      code: "AUTH_EXPIRED",
      title: "Autenticação expirada",
      message: "O token de acesso do Supabase é inválido ou expirou.",
      detail: "Reconecte seu Personal Access Token gerado no painel do Supabase.",
    };
  }

  // 7. Rate limit
  if (/rate limit|too many requests|429/i.test(text)) {
    return {
      code: "RATE_LIMIT",
      title: "Muitas requisições",
      message: "Muitas tentativas em pouco tempo.",
      detail: "Aguarde alguns minutos antes de tentar novamente.",
    };
  }

  // 8. Timeout
  if (/tempo limite|timeout|timed out/i.test(text)) {
    return {
      code: "TIMEOUT",
      title: "Tempo limite excedido",
      message: "A operação demorou mais que o esperado.",
      detail: "Verifique sua conexão de internet e tente novamente.",
    };
  }

  // 9. Erro de rede / DNS / Conexão
  if (/ENOTFOUND|ECONNREFUSED|network error|failed to fetch|erro de conexão|erro de dns|getaddrinfo/i.test(text)) {
    return {
      code: "NETWORK_ERROR",
      title: "Erro de conexão",
      message: "Não foi possível conectar aos servidores do Supabase.",
      detail: "Verifique sua conexão com a internet e tente novamente.",
    };
  }

  // 10. Erro de TLS / Certificado
  if (/CERT_|certificate|self-signed|tls|ssl/i.test(text)) {
    return {
      code: "TLS_ERROR",
      title: "Erro de segurança SSL/TLS",
      message: "Falha na validação do certificado de segurança com o Supabase.",
      detail: "Verifique se há antivírus, proxy corporativo ou VPN interceptando a conexão.",
    };
  }

  // 11. Erro de Servidor (5xx)
  if (/HTTP 5\d\d|500|502|503|504|instáveis|indisponíveis|servidores do supabase/i.test(text)) {
    return {
      code: "SERVER_ERROR",
      title: "Servidores do Supabase indisponíveis",
      message: "Os servidores do Supabase retornaram erro ou estão temporariamente instáveis.",
      detail: "Aguarde alguns instantes ou verifique o status do Supabase.",
    };
  }

  // 12. Fallback sanitizado (sem stack traces)
  const cleanMessage = text
    .split(/\r?\n/)[0]
    .replace(/at\s+[\w\W]+$/i, "")
    .trim();

  return {
    code: "GENERIC_ERROR",
    title: "Erro no Supabase",
    message: cleanMessage || "O Supabase retornou um erro durante a operação.",
    detail: "Verifique os dados informados e tente novamente.",
  };
}

export function executableDirectories(): string[] {
  let bundledBinDir: string | null = null;
  try {
    const runtime = resolveNodeRuntime();
    if (runtime?.binDir) {
      bundledBinDir = runtime.binDir;
    }
  } catch {}

  const pathDirectories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const resourcesPath = process.resourcesPath || "";

  const candidates = [
    bundledBinDir || "",
    path.resolve(__dirname, "..", "..", "tools", "node"),
    path.resolve(process.cwd(), "tools", "node"),
    path.join(__dirname, "..", "..", "tools"),
    resourcesPath ? path.join(resourcesPath, "tools", "node") : "",
    resourcesPath ? path.join(resourcesPath, "tools") : "",
    resourcesPath ? path.join(resourcesPath, "tools", "supabase", "node_modules", ".bin") : "",
    localAppData ? path.join(localAppData, "NekoAI", "tools") : "",
    appData ? path.join(appData, "npm") : "",
    userProfile ? path.join(userProfile, ".bun", "bin") : "",
    ...pathDirectories,
    programFiles ? path.join(programFiles, "nodejs") : "",
    programFilesX86 ? path.join(programFilesX86, "nodejs") : "",
    "C:\\nvm4w\\nodejs",
  ];

  return Array.from(new Set(candidates.filter(Boolean)));
}

export async function resolveExecutable(names: string[]): Promise<string | null> {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat"] : [""];
  const dirs = executableDirectories();

  for (const directory of dirs) {
    for (const name of names) {
      const candidates = path.extname(name)
        ? [path.join(directory, name)]
        : extensions.map((ext) => path.join(directory, name + ext));

      for (const candidate of candidates) {
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

export async function resolveSupabaseCli(): Promise<{ command: string; prefix: string[] }> {
  // 1) Standalone supabase executable
  const standalone = await resolveExecutable(["supabase"]);
  if (standalone) {
    return { command: standalone, prefix: [] };
  }

  // 2) npx executable
  const npx = await resolveExecutable(["npx"]);
  if (npx) {
    return { command: npx, prefix: ["supabase"] };
  }

  // 3) Fallback
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    prefix: ["supabase"],
  };
}

export async function resolvePackageManager(
  manager: string = "npm"
): Promise<{ command: string; executable: string }> {
  const norm = (manager || "npm").toLowerCase();
  const names =
    norm === "pnpm"
      ? ["pnpm"]
      : norm === "yarn"
      ? ["yarn"]
      : norm === "bun"
      ? ["bun"]
      : ["npm"];

  const resolved = await resolveExecutable(names);
  if (resolved) {
    return { command: norm, executable: resolved };
  }

  const fallback =
    process.platform === "win32"
      ? norm === "bun"
        ? "bun.exe"
        : `${norm}.cmd`
      : norm;

  return { command: norm, executable: fallback };
}

export function getSpawnInvocation(
  command: string,
  args: string[]
): { command: string; args: string[]; options: { windowsVerbatimArguments?: boolean } } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args, options: {} };
  }

  const commandLine = `"${command}" ${args
    .map((a) => (a.includes(" ") || a.includes('"') ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ")}`;

  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export function normalizeSupabaseArgs(args: string[], prefix: string[]): string[] {
  const cleanArgs = args[0] === "supabase" ? args.slice(1) : args;
  return [...prefix, ...cleanArgs];
}

export function getOpenCodeExecutable(): string {
  const executableName = process.platform === "win32" ? "opencode.exe" : "opencode";

  if (process.env.NEKO_OPENCODE_PATH) {
    const override = path.resolve(process.env.NEKO_OPENCODE_PATH);
    if (fsSync.existsSync(override)) return override;
  }

  const projectTools = path.resolve(__dirname, "..", "..", "tools", executableName);
  if (fsSync.existsSync(projectTools)) return projectTools;

  const packagedTools = path.join(process.resourcesPath || "", "tools", executableName);
  if (fsSync.existsSync(packagedTools)) return packagedTools;

  const bunPath = path.join(os.homedir(), ".bun", "bin", executableName);
  if (fsSync.existsSync(bunPath)) return bunPath;

  return executableName;
}

export function hasAuthenticatedMcp(output: string, mcpName: string): boolean {
  const escaped = mcpName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(?:^|\\s)${escaped}\\s+authenticated(?:\\s|$)`, "im").test(output) ||
    new RegExp(`[•|*]\\s+(?:✓|v|ok|active)?\\s*${escaped}\\s+(?:authenticated|connected)`, "im").test(output) ||
    (output.includes(mcpName) &&
      output.includes("authenticated") &&
      !output.includes("not authenticated") &&
      !output.includes("needs authentication"))
  );
}

export function hasConnectedMcp(output: string, mcpName: string): boolean {
  const escaped = mcpName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(?:^|\\s)${escaped}\\s+connected(?:\\s|$)`, "im").test(output) ||
    new RegExp(`[•|*]\\s+(?:✓|v|ok)?\\s*${escaped}\\s+connected`, "im").test(output) ||
    (output.includes(mcpName) &&
      !output.includes("needs authentication") &&
      !output.includes("error") &&
      !output.includes("failed"))
  );
}

export class SupabaseCli {
  private activeProcesses = new Set<ChildProcess>();
  private activeOAuthChild: ChildProcess | null = null;
  private isShuttingDown = false;
  private cliQueue: Promise<any> = Promise.resolve();
  private detectedVersion: string | null = null;
  private customFetch?: typeof fetch;
  private inMemoryToken: string | null = null;

  constructor(customFetch?: typeof fetch) {
    if (customFetch) {
      this.customFetch = customFetch;
    }
  }

  public cancelActiveOAuth(): void {
    if (this.activeOAuthChild) {
      console.log("[Neko/SupabaseCLI] Cancelando processo ativo de OAuth do OpenCode.");
      this.terminate(this.activeOAuthChild);
      this.activeOAuthChild = null;
    }
  }

  private terminate(child: ChildProcess) {
    if (child.pid && process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).unref();
      } catch {}
    } else {
      try {
        child.kill();
      } catch {}
    }
  }

  public shutdown() {
    this.isShuttingDown = true;
    for (const child of this.activeProcesses) {
      this.terminate(child);
    }
    this.activeProcesses.clear();
  }

  public async ensureCliAvailable(): Promise<void> {
    const standalone = await resolveExecutable(["supabase"]);
    if (!standalone) {
      console.log("[Neko/SupabaseCLI] Standalone CLI não detectado; operando em modo REST API direto.");
      return;
    }
    try {
      const res = await this.runCli(["--version"], 15000);
      this.detectedVersion = res.stdout;
      console.log(`[Neko/SupabaseCLI] version=${this.detectedVersion}`);
    } catch (err: any) {
      console.warn(`[Neko/SupabaseCLI] Aviso ao verificar versão da CLI: ${err?.message || err}`);
    }
  }

  public runCli(
    args: string[],
    timeoutMs: number = 60000
  ): Promise<{ stdout: string; stderr: string }> {
    const task = () => this.executeCli(args, timeoutMs);
    const queued = this.cliQueue.then(task, task);
    this.cliQueue = queued.catch(() => {});
    return queued;
  }

  private async executeCli(
    args: string[],
    timeoutMs: number = 60000
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error("Supabase CLI indisponível no momento."));
    }

    const resolved = await resolveSupabaseCli();
    const fullArgs = normalizeSupabaseArgs(args, resolved.prefix);
    const invocation = getSpawnInvocation(resolved.command, fullArgs);

    const logCmd =
      fullArgs.filter((a) => !a.startsWith("--") && !a.startsWith("sbp_")).join(" ") ||
      fullArgs[0] ||
      "supabase";
    console.log(`[Neko/SupabaseCLI] queue start command=${logCmd} telemetry disabled=true`);

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, invocation.args, {
          ...invocation.options,
          cwd: process.cwd(),
          env: {
            ...getEmbeddedRuntimeEnv(),
            NO_COLOR: "1",
            SUPABASE_TELEMETRY_DISABLED: "1",
            DO_NOT_TRACK: "1",
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (spawnErr: any) {
        const msg = spawnErr?.code
          ? `Erro de execução no Supabase CLI (${spawnErr.code})`
          : "Não foi possível iniciar o Supabase CLI.";
        console.error(`[Neko/SupabaseCLI] Erro no spawn:`, spawnErr);
        return reject(new Error(msg));
      }

      this.activeProcesses.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (error) reject(error);
        else resolve(result || { stdout: "", stderr: "" });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
        finish(new Error("A operação do Supabase excedeu o tempo limite."));
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(-512000);
      });

      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-512000);
      });

      child.once("error", (error: any) => {
        console.error(`[Neko/SupabaseCLI] Child process error:`, error);
        if (error?.code === "ENOENT") {
          finish(new Error("Supabase CLI não encontrado (ENOENT)."));
        } else if (error?.code === "EINVAL") {
          finish(new Error("Erro nos argumentos do Supabase CLI (EINVAL)."));
        } else if (error?.code === "EACCES") {
          finish(new Error("Permissão negada ao executar o Supabase CLI (EACCES)."));
        } else {
          finish(new Error(sanitizeLog(error?.message || "Erro no processo do Supabase CLI.")));
        }
      });

      child.once("close", (code) => {
        const cleanStdout = stdout.trim();
        const cleanStderr = stderr.trim();

        // Identifica se o único erro ou ruído na saída foi a renomeação de telemetry.json
        const isTelemetryOnlyError =
          cleanStderr.includes("telemetry.json") &&
          (cleanStderr.includes("EPERM") ||
            cleanStderr.includes("FileSystem.rename") ||
            cleanStderr.includes("operation not permitted"));

        console.log(`[Neko/SupabaseCLI] queue complete command=${logCmd} exit=${code}`);

        if (timedOut) {
          finish(new Error("A operação do Supabase excedeu o tempo limite."));
        } else if (code === 0 || (isTelemetryOnlyError && cleanStdout.length > 0)) {
          finish(undefined, { stdout: cleanStdout, stderr: isTelemetryOnlyError ? "" : cleanStderr });
        } else {
          const rawErr = cleanStderr || cleanStdout || `Processo terminou com código ${code}.`;
          finish(new Error(sanitizeLog(rawErr)));
        }
      });
    });
  }

  public runOpenCodeMcp(
    args: string[],
    cwd: string,
    optionsOrTimeout:
      | number
      | {
          timeoutMs?: number;
          signal?: AbortSignal;
          onUrlDetected?: (url: string) => void;
          isOAuth?: boolean;
        } = 60000
  ): Promise<{ code: number; stdout: string; stderr: string; output: string }> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error("OpenCode CLI indisponível no momento."));
    }

    const options =
      typeof optionsOrTimeout === "number"
        ? { timeoutMs: optionsOrTimeout }
        : optionsOrTimeout || {};
    const timeoutMs = options.timeoutMs ?? 60000;
    const signal = options.signal;
    const onUrlDetected = options.onUrlDetected;
    const isOAuth = options.isOAuth ?? false;

    if (signal?.aborted) {
      return Promise.reject(new Error("A operação do OpenCode MCP foi cancelada pelo usuário."));
    }

    const executable = getOpenCodeExecutable();
    const invocation = getSpawnInvocation(executable, args);

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, invocation.args, {
          ...invocation.options,
          cwd,
          env: {
            ...getEmbeddedRuntimeEnv(process.env),
            NO_COLOR: "1",
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (spawnErr: any) {
        return reject(
          new Error(`Não foi possível iniciar o OpenCode CLI (${spawnErr?.code || spawnErr?.message || "spawn error"})`)
        );
      }

      this.activeProcesses.add(child);
      if (isOAuth) {
        this.activeOAuthChild = child;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let detectedUrl: string | null = null;

      const finish = (
        error?: Error,
        result?: { code: number; stdout: string; stderr: string; output: string }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        this.activeProcesses.delete(child);
        if (this.activeOAuthChild === child) {
          this.activeOAuthChild = null;
        }
        if (error) reject(error);
        else resolve(result || { code: 0, stdout: "", stderr: "", output: "" });
      };

      const abortHandler = () => {
        this.terminate(child);
        finish(new Error("A operação do OpenCode MCP foi cancelada pelo usuário."));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const timer = setTimeout(() => {
        this.terminate(child);
        finish(new Error("A operação do OpenCode MCP expirou."));
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdout = `${stdout}${text}`.slice(-512000);
        if (onUrlDetected) {
          const url = extractOAuthUrl(stdout) || extractOAuthUrl(text);
          if (url && url !== detectedUrl) {
            detectedUrl = url;
            onUrlDetected(url);
          }
        }
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderr = `${stderr}${text}`.slice(-512000);
        if (onUrlDetected) {
          const url = extractOAuthUrl(stderr) || extractOAuthUrl(text);
          if (url && url !== detectedUrl) {
            detectedUrl = url;
            onUrlDetected(url);
          }
        }
      });

      child.once("error", (error) => finish(error));

      child.once("close", (code) => {
        const cleanStdout = stdout.trim();
        const cleanStderr = stderr.trim();
        const output = `${cleanStdout}\n${cleanStderr}`.trim();
        finish(undefined, {
          code: code ?? 0,
          stdout: cleanStdout,
          stderr: cleanStderr,
          output,
        });
      });
    });
  }

  public async checkMcpAuthStatus(projectPath: string, mcpName: string): Promise<boolean> {
    try {
      const res = await this.runOpenCodeMcp(["mcp", "auth", "list"], projectPath, 30000);
      return res.code === 0 && hasAuthenticatedMcp(res.output, mcpName);
    } catch {
      return false;
    }
  }

  public async checkMcpConnection(projectPath: string, mcpName: string): Promise<boolean> {
    try {
      const res = await this.runOpenCodeMcp(["mcp", "list"], projectPath, 30000);
      return res.code === 0 && hasConnectedMcp(res.output, mcpName);
    } catch {
      return false;
    }
  }

  public async authenticateOpenCodeSupabase(
    projectPath: string,
    projectRef: string,
    optionsOrOnLog?:
      | ((msg: string) => void)
      | {
          onLog?: (msg: string) => void;
          onProgress?: (status: "authorizing" | "verifying", url?: string | null, opened?: boolean) => void;
          openExternal?: (url: string) => Promise<void>;
          signal?: AbortSignal;
        },
    onProgressLegacy?: (status: "authorizing" | "verifying") => void
  ): Promise<boolean> {
    let onLog: ((msg: string) => void) | undefined;
    let onProgress: ((status: "authorizing" | "verifying", url?: string | null, opened?: boolean) => void) | undefined;
    let openExternal: ((url: string) => Promise<void>) | undefined;
    let signal: AbortSignal | undefined;

    if (typeof optionsOrOnLog === "function") {
      onLog = optionsOrOnLog;
      if (onProgressLegacy) {
        onProgress = (s) => onProgressLegacy(s);
      }
    } else if (optionsOrOnLog && typeof optionsOrOnLog === "object") {
      onLog = optionsOrOnLog.onLog;
      onProgress = optionsOrOnLog.onProgress;
      openExternal = optionsOrOnLog.openExternal;
      signal = optionsOrOnLog.signal;
    }

    const mcpName = `neko_supabase_${projectRef}`;

    // 1) Checa se já está autenticado e conectado
    onProgress?.("verifying", null, false);
    const isAuth = await this.checkMcpAuthStatus(projectPath, mcpName);
    if (isAuth) {
      const isConn = await this.checkMcpConnection(projectPath, mcpName);
      if (isConn) {
        onLog?.("O MCP do Supabase já está autorizado e conectado no OpenCode.");
        return true;
      }
      // Se estava com token inválido, faz logout prévio
      await this.logoutOpenCodeSupabase(projectPath, projectRef).catch(() => {});
    }

    onLog?.("Iniciando autorização OAuth do OpenCode no Supabase...");
    onProgress?.("authorizing", null, false);

    let detectedOauthUrl: string | null = null;
    let browserOpened = false;

    const handleUrlDetected = async (url: string) => {
      if (detectedOauthUrl === url) return;
      detectedOauthUrl = url;
      onLog?.("URL de autorização do Supabase detectada.");

      if (openExternal) {
        try {
          await openExternal(url);
          browserOpened = true;
          onLog?.("Navegador aberto com sucesso para autorização.");
        } catch (openErr) {
          console.warn("[Neko/SupabaseCLI] Falha ao abrir navegador automaticamente:", openErr);
          browserOpened = false;
          onLog?.("Aviso: não foi possível abrir o navegador automaticamente. Use os botões abaixo para autorizar.");
        }
      } else {
        browserOpened = false;
      }

      onProgress?.("authorizing", detectedOauthUrl, browserOpened);
    };

    // 2) Executa o comando de auth (streaming stdout/stderr para capturar URL)
    const result = await this.runOpenCodeMcp(["mcp", "auth", mcpName], projectPath, {
      timeoutMs: 300000, // 5 minutos de segurança
      signal,
      onUrlDetected: handleUrlDetected,
      isOAuth: true,
    });

    if (result.code !== 0) {
      if (signal?.aborted) {
        throw new Error("A autorização do Supabase foi cancelada pelo usuário.");
      }
      const cleanErr = result.output.replace(/https?:\/\/\S+/g, "[URL]").trim();
      if (!detectedOauthUrl) {
        throw new Error(cleanErr || `O processo do OpenCode MCP encerrou inesperadamente (código ${result.code}) antes de gerar a URL de autorização.`);
      }
      throw new Error(cleanErr || `A autorização do MCP terminou com código ${result.code}.`);
    }

    // 3) Valida se o OAuth foi registrado com sucesso
    onProgress?.("verifying", null, false);
    const verified = await this.checkMcpAuthStatus(projectPath, mcpName);
    if (!verified) {
      throw new Error("O OpenCode encerrou o fluxo OAuth, mas não confirmou credenciais ativas para o MCP.");
    }

    onLog?.("MCP do Supabase autorizado com sucesso no OpenCode.");
    return true;
  }

  public async logoutOpenCodeSupabase(projectPath: string, projectRef: string): Promise<void> {
    const mcpName = `neko_supabase_${projectRef}`;
    try {
      await this.runOpenCodeMcp(["mcp", "logout", mcpName], projectPath, 30000);
    } catch {}
  }

  private getToken(): string | null {
    if (this.inMemoryToken) return this.inMemoryToken;
    return this.readStoredCliToken();
  }

  public async login(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error("Token de acesso inválido.");
    }

    // 1) Validação rápida contra a REST API oficial do Supabase
    const fetchFn = this.customFetch || globalThis.fetch;
    let response: Response;
    try {
      response = await fetchFn("https://api.supabase.com/v1/organizations", {
        headers: {
          Authorization: `Bearer ${trimmed}`,
          "User-Agent": "NekoAI/0.4.93",
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: any) {
      throw classifyFetchError(err, "validar token de acesso");
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error("O token de acesso do Supabase é inválido ou expirou.");
    }
    if (response.status === 429) {
      throw new Error("Limite de requisições do Supabase atingido (429). Aguarde alguns instantes.");
    }
    if (response.status >= 500) {
      throw new Error(`Servidores do Supabase indisponíveis ou instáveis (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(`Supabase API retornou erro HTTP ${response.status}`);
    }

    // 2) Armazenamento canônico do token no disco em ~/.supabase/access-token
    try {
      const home = os.homedir();
      const supabaseDir = path.join(home, ".supabase");
      if (!fsSync.existsSync(supabaseDir)) {
        fsSync.mkdirSync(supabaseDir, { recursive: true });
      }
      const tokenPath = path.join(supabaseDir, "access-token");
      fsSync.writeFileSync(tokenPath, trimmed, "utf8");
    } catch (writeErr) {
      console.warn("[Neko/SupabaseCLI] Aviso ao persistir access-token em disco:", writeErr);
    }

    this.inMemoryToken = trimmed;

    // 3) Se houver standalone CLI instalada localmente, sincroniza silenciosamente
    const standalone = await resolveExecutable(["supabase"]);
    if (standalone) {
      this.runCli(["login", "--token", trimmed], 15000).catch((err) => {
        console.warn("[Neko/SupabaseCLI] Sincronização CLI opcional:", err?.message || err);
      });
    }
  }

  public async logout(): Promise<void> {
    this.inMemoryToken = null;
    const standalone = await resolveExecutable(["supabase"]);
    if (standalone) {
      try {
        await this.runCli(["logout"], 15000);
      } catch {}
    }
    try {
      const home = os.homedir();
      const tokenPath = path.join(home, ".supabase", "access-token");
      if (fsSync.existsSync(tokenPath)) {
        fsSync.unlinkSync(tokenPath);
      }
    } catch {}
  }

  public readStoredCliToken(): string | null {
    try {
      const home = os.homedir();
      const tokenPath = path.join(home, ".supabase", "access-token");
      if (fsSync.existsSync(tokenPath)) {
        return fsSync.readFileSync(tokenPath, "utf8").trim() || null;
      }
    } catch {}
    return null;
  }

  public async listProjects(): Promise<SupabaseProject[]> {
    const token = this.getToken();
    let lastApiError: Error | null = null;
    if (token) {
      const fetchFn = this.customFetch || globalThis.fetch;
      try {
        const res = await fetchFn("https://api.supabase.com/v1/projects", {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "NekoAI/0.4.93",
          },
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) {
          const data = await res.json();
          const list: any[] = Array.isArray(data) ? data : data.projects || [];
          return list
            .map((p) => ({
              id: p.id || p.ref,
              name: p.name || "Projeto Sem Nome",
              ref: p.ref || p.id,
              region: p.region || "Desconhecida",
              status: p.status || "ACTIVE",
            }))
            .sort((a, b) => b.status.localeCompare(a.status) || a.name.localeCompare(b.name));
        }
        if (res.status === 401 || res.status === 403) {
          lastApiError = new Error("O token de acesso do Supabase é inválido ou expirou.");
        } else if (res.status === 429) {
          lastApiError = new Error("Limite de requisições do Supabase atingido (429). Aguarde um momento.");
        } else if (res.status >= 500) {
          lastApiError = new Error(`Servidores do Supabase instáveis ou indisponíveis (HTTP ${res.status}).`);
        } else {
          lastApiError = new Error(`Supabase API retornou erro HTTP ${res.status} ao listar projetos.`);
        }
      } catch (apiErr: any) {
        console.warn("[Neko/SupabaseCLI] Erro na REST API listProjects:", apiErr);
        lastApiError = classifyFetchError(apiErr, "listar projetos");
      }
    }

    const standalone = await resolveExecutable(["supabase"]);
    if (standalone) {
      try {
        const result = await this.runCli(["projects", "list", "--output-format", "json"]);
        const jsonStart = Math.min(
          ...[result.stdout.indexOf("["), result.stdout.indexOf("{")].filter((i) => i !== -1)
        );
        if (jsonStart === Infinity) throw new Error("Saída de projetos inválida.");
        const parsed = JSON.parse(result.stdout.substring(jsonStart));
        const list: any[] = Array.isArray(parsed) ? parsed : parsed.projects || [];
        return list
          .map((p) => ({
            id: p.id || p.ref,
            name: p.name || "Projeto Sem Nome",
            ref: p.ref || p.id,
            region: p.region || "Desconhecida",
            status: p.status || "ACTIVE",
          }))
          .sort((a, b) => b.status.localeCompare(a.status) || a.name.localeCompare(b.name));
      } catch (cliErr) {
        console.warn("[Neko/SupabaseCLI] Fallback CLI listProjects falhou:", cliErr);
      }
    }

    if (lastApiError) {
      throw lastApiError;
    }
    throw new Error("Não foi possível carregar a lista de projetos do Supabase. Nenhum token configurado.");
  }

  public async listOrganizations(): Promise<SupabaseOrganization[]> {
    const token = this.getToken();
    let lastApiError: Error | null = null;
    if (token) {
      const fetchFn = this.customFetch || globalThis.fetch;
      try {
        const res = await fetchFn("https://api.supabase.com/v1/organizations", {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "NekoAI/0.4.93",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          const list: any[] = Array.isArray(data) ? data : data.organizations || [];
          return list.map((o) => ({
            id: o.id,
            name: o.name || "Organização",
          }));
        }
        if (res.status === 401 || res.status === 403) {
          lastApiError = new Error("O token de acesso do Supabase é inválido ou expirou.");
        } else if (res.status === 429) {
          lastApiError = new Error("Limite de requisições do Supabase atingido (429). Aguarde um momento.");
        } else if (res.status >= 500) {
          lastApiError = new Error(`Servidores do Supabase instáveis ou indisponíveis (HTTP ${res.status}).`);
        } else {
          lastApiError = new Error(`Supabase API retornou erro HTTP ${res.status} ao listar organizações.`);
        }
      } catch (apiErr: any) {
        console.warn("[Neko/SupabaseCLI] Erro na REST API listOrganizations:", apiErr);
        lastApiError = classifyFetchError(apiErr, "listar organizações");
      }
    }

    const standalone = await resolveExecutable(["supabase"]);
    if (standalone) {
      try {
        const result = await this.runCli(["orgs", "list", "--output-format", "json"]);
        const jsonStart = Math.min(
          ...[result.stdout.indexOf("["), result.stdout.indexOf("{")].filter((i) => i !== -1)
        );
        if (jsonStart === Infinity) throw new Error("Saída de organizações inválida.");
        const parsed = JSON.parse(result.stdout.substring(jsonStart));
        const list: any[] = Array.isArray(parsed) ? parsed : parsed.organizations || [];
        return list.map((o) => ({
          id: o.id,
          name: o.name || "Organização",
        }));
      } catch (cliErr) {
        console.warn("[Neko/SupabaseCLI] Fallback CLI listOrganizations falhou:", cliErr);
      }
    }

    if (lastApiError) {
      throw lastApiError;
    }
    throw new Error("Não foi possível carregar a lista de organizações do Supabase. Nenhum token configurado.");
  }

  public async createProject(payload: SupabaseCreateProjectPayload): Promise<void> {
    const token = this.getToken();
    let lastApiError: Error | null = null;
    if (token) {
      const fetchFn = this.customFetch || globalThis.fetch;
      try {
        const res = await fetchFn("https://api.supabase.com/v1/projects", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "NekoAI/0.4.93",
          },
          body: JSON.stringify({
            name: payload.name,
            organization_id: payload.orgId,
            db_pass: payload.dbPassword,
            region: payload.region || "sa-east-1",
            plan: "free",
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (res.ok) {
          return;
        }

        let errBody = "";
        try {
          const json = await res.json();
          errBody = json.message || json.error || JSON.stringify(json);
        } catch {
          errBody = await res.text();
        }
        lastApiError = new Error(errBody || `HTTP ${res.status}`);
      } catch (err: any) {
        lastApiError = classifyFetchError(err, "criar projeto no Supabase");
        console.warn("[Neko/SupabaseCLI] REST API createProject falhou, tentando CLI standalone fallback:", err);
      }
    }

    const standalone = await resolveExecutable(["supabase"]);
    if (standalone) {
      await this.runCli(
        [
          "projects",
          "create",
          payload.name,
          "--org-id",
          payload.orgId,
          "--db-password",
          payload.dbPassword,
          "--region",
          payload.region || "sa-east-1",
        ],
        120000
      );
      return;
    }

    if (lastApiError) {
      throw lastApiError;
    }
    throw new Error("Não foi possível criar o projeto no Supabase. Nenhum token configurado.");
  }

  public async fetchApiKeys(ref: string): Promise<{ publishableKey: string }> {
    const token = this.getToken();
    let lastApiError: Error | null = null;
    if (token) {
      const fetchFn = this.customFetch || globalThis.fetch;
      try {
        const res = await fetchFn(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "NekoAI/0.4.93",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          const keys: any[] = Array.isArray(data) ? data : data.keys || [];
          const keyEntry = keys.find(
            (k) =>
              k.type === "publishable" ||
              k.type === "anon" ||
              k.name === "anon" ||
              k.id === "anon" ||
              k.role === "anon"
          );
          const apiKey = keyEntry?.api_key || keyEntry?.apiKey;
          if (apiKey) {
            return { publishableKey: apiKey };
          }
          lastApiError = new Error("Chave pública (anon/publishable) não encontrada na resposta do projeto.");
        } else if (res.status === 401 || res.status === 403) {
          lastApiError = new Error("O token de acesso do Supabase é inválido ou expirou ao buscar chaves de API.");
        } else if (res.status === 404) {
          lastApiError = new Error(`Projeto Supabase (${ref}) não foi encontrado ou não está acessível.`);
        } else if (res.status >= 500) {
          lastApiError = new Error(`Servidores do Supabase indisponíveis ao buscar chaves de API (HTTP ${res.status}).`);
        } else {
          lastApiError = new Error(`Supabase API retornou erro HTTP ${res.status} ao buscar chaves de API.`);
        }
      } catch (apiErr: any) {
        console.warn("[Neko/SupabaseCLI] Erro na REST API fetchApiKeys:", apiErr);
        lastApiError = classifyFetchError(apiErr, "obter chaves de API do projeto");
      }
    }

    const standalone = await resolveExecutable(["supabase"]);
    if (standalone) {
      try {
        const result = await this.runCli([
          "projects",
          "api-keys",
          "--project-ref",
          ref,
          "--output-format",
          "json",
        ]);

        const jsonStart = result.stdout.indexOf("{");
        if (jsonStart === -1) throw new Error("Saída inválida");
        const parsed = JSON.parse(result.stdout.substring(jsonStart));
        const keys: any[] = parsed.keys || [];
        const keyEntry = keys.find(
          (k) =>
            k.type === "publishable" ||
            k.type === "anon" ||
            k.name === "anon" ||
            k.id === "anon" ||
            k.role === "anon"
        );
        if (!keyEntry?.api_key) {
          throw new Error("Chave pública (anon/publishable) não encontrada para este projeto.");
        }
        return { publishableKey: keyEntry.api_key };
      } catch (cliErr) {
        console.warn("[Neko/SupabaseCLI] Fallback CLI fetchApiKeys falhou:", cliErr);
      }
    }

    if (lastApiError) {
      throw lastApiError;
    }
    throw new Error("Não foi possível obter as chaves públicas do Supabase para este projeto.");
  }
}
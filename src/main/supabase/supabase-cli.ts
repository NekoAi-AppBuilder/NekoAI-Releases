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

export function sanitizeLog(text: string): string {
  return text
    .replace(/--token\s+[^\s]+/gi, "--token [REDACTED]")
    .replace(/--db-password\s+[^\s]+/gi, "--db-password [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sbp_[A-Za-z0-9_]+/gi, "[REDACTED_KEY]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "[REDACTED_JWT]");
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
  if (/invalid access token|unauthorized|401|token expired|invalid token/i.test(text)) {
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
      detail: "Aguarde alguns minutos antes de tentar criar um novo projeto.",
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

  // 9. Erro de rede
  if (/ENOTFOUND|ECONNREFUSED|network error|failed to fetch/i.test(text)) {
    return {
      code: "NETWORK_ERROR",
      title: "Erro de conexão",
      message: "Não foi possível conectar aos servidores do Supabase.",
      detail: "Verifique sua conexão com a internet e tente novamente.",
    };
  }

  // 10. Fallback sanitizado (sem stack traces)
  const cleanMessage = text
    .split(/\r?\n/)[0]
    .replace(/at\s+[\w\W]+$/i, "")
    .trim();

  return {
    code: "GENERIC_ERROR",
    title: "Não foi possível criar o projeto",
    message: cleanMessage || "O Supabase retornou um erro ao tentar criar o projeto.",
    detail: "Verifique os dados informados e tente novamente.",
  };
}

export function executableDirectories(): string[] {
  const pathDirectories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const resourcesPath = process.resourcesPath || "";

  const candidates = [
    path.join(__dirname, "..", "..", "tools"),
    resourcesPath ? path.join(resourcesPath, "tools") : "",
    resourcesPath ? path.join(resourcesPath, "tools", "node") : "",
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
  private isShuttingDown = false;
  private cliQueue: Promise<any> = Promise.resolve();
  private detectedVersion: string | null = null;

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
    try {
      const res = await this.runCli(["--version"], 15000);
      this.detectedVersion = res.stdout;
      console.log(`[Neko/SupabaseCLI] version=${this.detectedVersion}`);
    } catch (err: any) {
      const code = err?.code || (err instanceof Error ? err.message : "");
      throw new Error(`Supabase CLI não pôde ser iniciado no sistema: ${code}`);
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
            ...process.env,
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
    timeoutMs: number = 60000
  ): Promise<{ code: number; stdout: string; stderr: string; output: string }> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error("OpenCode CLI indisponível no momento."));
    }

    const executable = getOpenCodeExecutable();
    const invocation = getSpawnInvocation(executable, args);

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, invocation.args, {
          ...invocation.options,
          cwd,
          env: { ...process.env, NO_COLOR: "1" },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (spawnErr: any) {
        return reject(
          new Error(`Não foi possível iniciar o OpenCode CLI (${spawnErr?.code || spawnErr?.message || "spawn error"})`)
        );
      }

      this.activeProcesses.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (
        error?: Error,
        result?: { code: number; stdout: string; stderr: string; output: string }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (error) reject(error);
        else resolve(result || { code: 0, stdout: "", stderr: "", output: "" });
      };

      const timer = setTimeout(() => {
        this.terminate(child);
        finish(new Error("A operação do OpenCode MCP expirou."));
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(-512000);
      });

      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-512000);
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
    onLog?: (msg: string) => void,
    onProgress?: (status: "authorizing" | "verifying") => void
  ): Promise<boolean> {
    const mcpName = `neko_supabase_${projectRef}`;

    // 1) Checa se já está autenticado e conectado
    onProgress?.("verifying");
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
    onProgress?.("authorizing");

    // 2) Executa o comando de auth (abre o browser para autorização)
    const result = await this.runOpenCodeMcp(
      ["mcp", "auth", mcpName],
      projectPath,
      300000 // 5 minutos para o usuário autorizar no navegador
    );

    if (result.code !== 0) {
      const cleanErr = result.output.replace(/https?:\/\/\S+/g, "[URL]").trim();
      throw new Error(cleanErr || `A autorização do MCP terminou com código ${result.code}.`);
    }

    // 3) Valida se o OAuth foi registrado com sucesso
    onProgress?.("verifying");
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

  public async login(token: string): Promise<void> {
    await this.ensureCliAvailable();
    await this.runCli(["login", "--token", token.trim()], 45000);
  }

  public async listProjects(): Promise<SupabaseProject[]> {
    const result = await this.runCli(["projects", "list", "--output-format", "json"]);
    try {
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
    } catch {
      throw new Error("Não foi possível carregar a lista de projetos do Supabase.");
    }
  }

  public async listOrganizations(): Promise<SupabaseOrganization[]> {
    const result = await this.runCli(["orgs", "list", "--output-format", "json"]);
    try {
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
    } catch {
      throw new Error("Não foi possível carregar a lista de organizações do Supabase.");
    }
  }

  public async createProject(payload: SupabaseCreateProjectPayload): Promise<void> {
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
  }

  public async fetchApiKeys(ref: string): Promise<{ publishableKey: string }> {
    const result = await this.runCli([
      "projects",
      "api-keys",
      "--project-ref",
      ref,
      "--output-format",
      "json",
    ]);

    try {
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
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "Não foi possível obter as chaves públicas do Supabase para este projeto."
      );
    }
  }
}
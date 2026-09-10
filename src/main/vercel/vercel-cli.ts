import { spawn, spawnSync, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { VercelCliCommand } from "./vercel-types";

const VERCEL_CLI_VERSION = "58.5.1";
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const cleanVercelOutput = (value: string): string =>
  value.replace(ANSI_SEQUENCE, "").replace(/\r/g, "").trim();

export const parseVercelDeploymentUrl = (stdout: string): string | null => {
  const candidates = cleanVercelOutput(stdout).split(/\s+/).filter(Boolean);
  for (const candidate of candidates.reverse()) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.hostname.toLowerCase().endsWith(".vercel.app")
      ) {
        return url.toString().replace(/\/$/, "");
      }
    } catch {}
  }
  return null;
};

export const formatVercelErrorMessage = (rawError?: string): string => {
  const clean = cleanVercelOutput(rawError || "");
  if (!clean) return "Falha ao publicar na Vercel.";
  const lower = clean.toLowerCase();

  if (lower.includes("already in use") || lower.includes("already exists")) {
    return "O nome do projeto já está em uso na Vercel. Escolha outro nome.";
  }
  if (lower.includes("invalid project name") || lower.includes("project name is invalid") || lower.includes("400")) {
    return "O nome do projeto não atende às regras da Vercel. Verifique os caracteres e o formato.";
  }
  if (lower.includes("not authenticated") || lower.includes("login required") || lower.includes("unauthorized") || lower.includes("403")) {
    return "Sua sessão da Vercel expirou ou não está autorizada. Conecte sua conta novamente.";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "Limite de requisições da Vercel atingido. Aguarde alguns instantes antes de tentar novamente.";
  }
  if (lower.includes("timeout") || lower.includes("tempo limite")) {
    return "A publicação na Vercel excedeu o tempo limite.";
  }

  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const firstMeaningful = lines.find((l) => !l.startsWith("Vercel CLI") && !l.startsWith("Error!") && !l.startsWith(">")) || lines[0] || "A publicação na Vercel falhou.";
  return firstMeaningful.replace(/^Error:\s*/i, "");
};


const executableDirectories = (): string[] => {
  const pathEnv = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const systemDrive = process.env.SystemDrive || "C:";
  const localAppData = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";
  const defaultDirs =
    process.platform === "win32"
      ? [
          path.join(localAppData, "Microsoft", "WindowsApps"),
          path.join(appData, "npm"),
          path.join(localAppData, "Programs"),
          path.join(process.env.ProgramFiles || "", "nodejs"),
          path.join(systemDrive, "Program Files", "nodejs"),
          path.join(systemDrive, "nvm4w", "nodejs"),
          path.join(appData, "nvm"),
        ]
      : ["/usr/local/bin", "/usr/bin", "/bin"];

  const dirs = pathEnv.split(separator).filter(Boolean);
  return [...dirs, ...defaultDirs].filter(
    (value, index, values) => Boolean(value) && values.indexOf(value) === index
  );
};

export const resolveExecutable = async (names: string[]): Promise<string | null> => {
  if (process.platform === "win32") {
    for (const name of names) {
      try {
        const res = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
        if (res.status === 0) {
          const lines = (res.stdout || "").trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (fsSync.existsSync(line)) return line;
          }
        }
      } catch {}
    }
  }

  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat"] : [""];
  for (const directory of executableDirectories()) {
    for (const name of names) {
      const candidates = path.extname(name)
        ? [path.join(directory, name)]
        : extensions.map((extension) => path.join(directory, name + extension));

      for (const candidate of candidates) {
        try {
          if (fsSync.existsSync(candidate)) return candidate;
        } catch {}
      }
    }
  }
  return null;
};

export class VercelCli {
  private activeProcesses = new Set<ChildProcess>();

  public async resolveCli(): Promise<VercelCliCommand | null> {
    const direct = await resolveExecutable(["vercel.cmd", "vercel.exe", "vercel", "vc.cmd", "vc.exe", "vc"]);
    if (direct) return { command: direct, prefix: [] };
    const npx = await resolveExecutable(["npx.cmd", "npx.exe", "npx"]);
    return npx ? { command: npx, prefix: ["--yes", `vercel@${VERCEL_CLI_VERSION}`] } : null;
  }

  public getCliEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (name.toUpperCase().startsWith("VERCEL_")) delete environment[name];
    }
    environment.NO_COLOR = "1";
    environment.VERCEL_TELEMETRY_DISABLED = "1";
    return environment;
  }

  public async openLoginTerminal(cli: VercelCliCommand): Promise<{ strategy: string; pid?: number }> {
    if (process.platform !== "win32") {
      throw new Error("O login interativo da Vercel está disponível nesta versão para Windows.");
    }

    const cmdShell = process.env.ComSpec || "cmd.exe";
    const terminalArgs = [cli.command, ...cli.prefix, "login"];

    const strategies: Array<{
      name: string;
      execute: () => Promise<{ strategy: string; pid?: number }>;
    }> = [
      {
        name: "wt",
        execute: async () => {
          const wtPath = await resolveExecutable(["wt.exe", "wt"]);
          if (!wtPath) throw new Error("Windows Terminal (wt.exe) não encontrado.");
          return new Promise<{ strategy: string; pid?: number }>((resolve, reject) => {
            const child = spawn(
              wtPath,
              ["-w", "new", "new-tab", "--title", "NekoAI - Vercel Login", cmdShell, "/k", ...terminalArgs],
              {
                detached: true,
                env: this.getCliEnvironment(),
                windowsHide: false,
                stdio: "ignore",
              }
            );
            child.once("error", reject);
            child.once("spawn", () => {
              child.unref();
              resolve({ strategy: "wt", pid: child.pid });
            });
          });
        },
      },
      {
        name: "cmd-start",
        execute: async () => {
          return new Promise<{ strategy: string; pid?: number }>((resolve, reject) => {
            const child = spawn(
              cmdShell,
              ["/c", "start", "NekoAI - Vercel Login", cmdShell, "/k", ...terminalArgs],
              {
                detached: true,
                env: this.getCliEnvironment(),
                windowsHide: false,
                stdio: "ignore",
              }
            );
            child.once("error", reject);
            child.once("spawn", () => {
              child.unref();
              resolve({ strategy: "cmd-start", pid: child.pid });
            });
          });
        },
      },
      {
        name: "powershell",
        execute: async () => {
          const psPath = (await resolveExecutable(["powershell.exe", "powershell"])) || "powershell.exe";
          const psArgs = terminalArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(", ");
          const psScript = `Start-Process -FilePath '${cmdShell}' -ArgumentList '/k', ${psArgs}`;
          return new Promise<{ strategy: string; pid?: number }>((resolve, reject) => {
            const child = spawn(
              psPath,
              ["-NoProfile", "-NonInteractive", "-Command", psScript],
              {
                detached: true,
                env: this.getCliEnvironment(),
                windowsHide: false,
                stdio: "ignore",
              }
            );
            child.once("error", reject);
            child.once("spawn", () => {
              child.unref();
              resolve({ strategy: "powershell", pid: child.pid });
            });
          });
        },
      },
    ];

    let lastError: Error | null = null;
    for (const strategy of strategies) {
      try {
        const res = await strategy.execute();
        return res;
      } catch (err: any) {
        lastError = err;
      }
    }

    throw new Error(
      `Não foi possível abrir o terminal para autenticação da Vercel: ${lastError?.message || "falha ao iniciar processo"}`
    );
  }

  public runCli(
    cli: VercelCliCommand,
    args: string[],
    cwd?: string,
    timeoutMs = 120000,
    onLine?: (line: string) => void
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveCommand, reject) => {
      const fullArgs = [...cli.prefix, ...args];
      const child = spawn(cli.command, fullArgs, {
        cwd,
        env: this.getCliEnvironment(),
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeProcesses.add(child);
      let stdout = "";
      let stderr = "";
      let pending = "";
      let settled = false;
      let timedOut = false;
      let killFallback: NodeJS.Timeout | null = null;

      const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killFallback) clearTimeout(killFallback);
        this.activeProcesses.delete(child);
        if (error) reject(error);
        else resolveCommand(result!);
      };

      const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const value = chunk.toString("utf8");
        if (stream === "stdout") stdout = `${stdout}${value}`.slice(-32768);
        else stderr = `${stderr}${value}`.slice(-32768);
        if (!onLine) return;
        pending += value.replace(/\r/g, "\n");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const clean = cleanVercelOutput(line);
          if (clean) onLine(clean);
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
        killFallback = setTimeout(
          () => finish(new Error("A operação da Vercel excedeu o tempo limite.")),
          5000
        );
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        const cleanPending = cleanVercelOutput(pending);
        if (onLine && cleanPending) onLine(cleanPending);
        const result = { stdout: cleanVercelOutput(stdout), stderr: cleanVercelOutput(stderr) };
        if (timedOut) finish(new Error("A operação da Vercel excedeu o tempo limite."));
        else if (code === 0) finish(undefined, result);
        else
          finish(
            new Error(
              result.stderr || result.stdout || `O Vercel CLI terminou com o código ${code}.`
            )
          );
      });
    });
  }

  public terminate(child: ChildProcess): void {
    if (child.pid && process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
    } else {
      child.kill();
    }
  }

  public shutdown(): void {
    for (const child of this.activeProcesses) {
      this.terminate(child);
    }
    this.activeProcesses.clear();
  }
}

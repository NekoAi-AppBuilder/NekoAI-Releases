import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
  EMPTY_VERCEL_STATE,
  VercelCliCommand,
  VercelState,
  isValidVercelProjectName,
} from "./vercel-types";
import { VercelVaultManager } from "./vercel-vault";
import {
  VercelCli,
  cleanVercelOutput,
  parseVercelDeploymentUrl,
  formatVercelErrorMessage,
} from "./vercel-cli";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const wait = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));

export const getSupabaseEnvironmentNames = (framework?: string): { url: string; publishableKey: string } => {
  const name = framework?.toLowerCase() ?? "";
  if (name.includes("next")) {
    return { url: "NEXT_PUBLIC_SUPABASE_URL", publishableKey: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" };
  }
  if (name.includes("nuxt")) {
    return { url: "NUXT_PUBLIC_SUPABASE_URL", publishableKey: "NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" };
  }
  if (name.includes("vite") || name.includes("remix") || name.includes("qwik")) {
    return { url: "VITE_SUPABASE_URL", publishableKey: "VITE_SUPABASE_PUBLISHABLE_KEY" };
  }
  if (name.includes("astro") || name.includes("sveltekit")) {
    return { url: "PUBLIC_SUPABASE_URL", publishableKey: "PUBLIC_SUPABASE_PUBLISHABLE_KEY" };
  }
  if (name.includes("create react app")) {
    return { url: "REACT_APP_SUPABASE_URL", publishableKey: "REACT_APP_SUPABASE_PUBLISHABLE_KEY" };
  }
  if (name.includes("vue")) {
    return { url: "VUE_APP_SUPABASE_URL", publishableKey: "VUE_APP_SUPABASE_PUBLISHABLE_KEY" };
  }
  return { url: "VITE_SUPABASE_URL", publishableKey: "VITE_SUPABASE_PUBLISHABLE_KEY" };
};

export class VercelManager extends EventEmitter {
  private state: VercelState = { ...EMPTY_VERCEL_STATE };
  private vault = new VercelVaultManager();
  private cliWrapper = new VercelCli();
  private cli: VercelCliCommand | null = null;
  private authTask: Promise<VercelState> | null = null;
  private deploymentTask: Promise<VercelState> | null = null;
  private authAttempt = 0;
  private projectGeneration = 0;
  private shuttingDown = false;
  private deploymentUrls = new Map<string, string>();

  public getState(): VercelState {
    return { ...this.state };
  }

  private setState(patch: Partial<VercelState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.getState());
  }

  public async initialize(): Promise<void> {
    await this.vault.loadVault();
    console.log("[Neko/Vercel] initializing Vercel integration");
    this.cli = await this.cliWrapper.resolveCli();
    if (!this.cli) {
      console.log("[Neko/Vercel] Vercel CLI not available on system");
      this.setState({
        configured: false,
        connection: "error",
        error: "Instale o Node.js com npm para conectar e publicar na Vercel.",
      });
      return;
    }
    console.log(`[Neko/Vercel] CLI resolved executable=${this.cli.command}`);
    this.setState({ configured: true, connection: "checking", error: null });
    console.log("[Neko/Vercel] checking authentication");
    const username = await this.readUsername();
    console.log(`[Neko/Vercel] whoami result=${username || "null"}`);
    if (username) {
      console.log(`[Neko/Vercel] authentication successful user=${username}`);
    }
    this.setState({
      connection: username ? "connected" : "disconnected",
      username,
      error: null,
    });
  }

  public async setProject(projectPath: string | null): Promise<void> {
    const generation = ++this.projectGeneration;
    const cachedUrl = projectPath
      ? this.deploymentUrls.get(projectPath) ?? (await this.vault.getDeploymentUrl(projectPath))
      : null;
    const cachedProjectName = projectPath
      ? await this.vault.getProjectName(projectPath)
      : null;

    this.setState({
      projectPath,
      projectName: cachedProjectName || (projectPath ? path.basename(projectPath) : null),
      linked: false,
      deployment: "idle",
      deploymentUrl: cachedUrl,
      error: null,
    });

    if (!projectPath) return;
    const linked = await this.pathExists(path.join(projectPath, ".vercel", "project.json"));
    if (generation === this.projectGeneration) {
      this.setState({ linked });
    }
  }

  public async disconnect(): Promise<VercelState> {
    console.log("[Neko/Vercel] disconnect requested");
    this.authAttempt += 1;
    await this.authTask?.catch(() => undefined);
    this.authTask = null;
    try {
      if (this.cli) {
        await this.cliWrapper.runCli(this.cli, ["logout"], undefined, 30000).catch(() => undefined);
      }
    } finally {
      this.setState({
        connection: "disconnected",
        username: null,
        deployment: "idle",
        linked: false,
        deploymentUrl: null,
        error: null,
      });
    }
    return this.getState();
  }

  public async connect(): Promise<VercelState> {
    if (this.authTask) return this.authTask;
    const task = this.connectOnce(++this.authAttempt);
    this.authTask = task;
    try {
      return await task;
    } finally {
      if (this.authTask === task) this.authTask = null;
    }
  }

  private async connectOnce(attempt: number): Promise<VercelState> {
    console.log("[Neko/Vercel] connect requested");
    console.log("[Neko/Vercel] resolving CLI");
    if (!this.cli) this.cli = await this.cliWrapper.resolveCli();
    if (!this.cli) {
      console.log("[Neko/Vercel] CLI resolution failed (npm/npx/vercel not found)");
      throw new Error("O Vercel CLI não está disponível porque o npm não foi encontrado.");
    }
    console.log(`[Neko/Vercel] CLI resolved executable=${this.cli.command}`);

    console.log("[Neko/Vercel] checking authentication");
    const existingUser = await this.readUsername();
    console.log(`[Neko/Vercel] whoami result=${existingUser || "null"}`);
    if (existingUser) {
      console.log(`[Neko/Vercel] authentication successful user=${existingUser}`);
      this.setState({ connection: "connected", username: existingUser, error: null });
      return this.getState();
    }

    this.setState({ connection: "authorizing", username: null, error: null });
    try {
      console.log("[Neko/Vercel] opening authentication terminal");
      const termRes = await this.cliWrapper.openLoginTerminal(this.cli);
      console.log(`[Neko/Vercel] terminal strategy=${termRes.strategy}`);
      console.log(`[Neko/Vercel] terminal process spawned pid=${termRes.pid || "unknown"}`);
      console.log("[Neko/Vercel] waiting for authentication");

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (!this.shuttingDown && attempt === this.authAttempt && Date.now() < deadline) {
        await wait(2500);
        console.log("[Neko/Vercel] checking authentication");
        const username = await this.readUsername();
        console.log(`[Neko/Vercel] whoami result=${username || "null"}`);
        if (username) {
          console.log(`[Neko/Vercel] authentication successful user=${username}`);
          this.setState({ connection: "connected", username, error: null });
          return this.getState();
        }
      }
      if (this.shuttingDown || attempt !== this.authAttempt) return this.getState();
      console.log("[Neko/Vercel] authentication failed timeout");
      throw new Error("Não foi possível concluir a autenticação da Vercel (tempo limite esgotado).");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível conectar à Vercel.";
      console.log(`[Neko/Vercel] authentication failed: ${message}`);
      this.setState({ connection: "error", username: null, error: message });
      throw error;
    }
  }

  public async deploy(
    projectPath: string,
    publicEnvironment: Record<string, string> = {},
    customProjectName?: string
  ): Promise<VercelState> {
    if (this.deploymentTask) throw new Error("Já existe uma publicação na Vercel em andamento.");
    const task = this.deployOnce(projectPath, publicEnvironment, customProjectName);
    this.deploymentTask = task;
    try {
      return await task;
    } finally {
      if (this.deploymentTask === task) this.deploymentTask = null;
    }
  }

  private async deployOnce(
    projectPath: string,
    publicEnvironment: Record<string, string>,
    customProjectName?: string
  ): Promise<VercelState> {
    if (!projectPath || this.state.projectPath !== projectPath) {
      throw new Error("O projeto selecionado mudou antes da publicação.");
    }
    const generation = this.projectGeneration;
    if (!this.cli) this.cli = await this.cliWrapper.resolveCli();
    if (!this.cli) {
      throw new Error("O Vercel CLI não está disponível porque o npm não foi encontrado.");
    }

    const username = await this.readUsername();
    if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
      throw new Error("O projeto ativo mudou antes do início da publicação.");
    }
    if (!username) {
      this.setState({ connection: "disconnected", username: null, error: null });
      throw new Error("Conecte sua conta da Vercel antes de publicar.");
    }

    const projectJsonPath = path.join(projectPath, ".vercel", "project.json");
    let isLinked = await this.pathExists(projectJsonPath);

    this.setState({ connection: "connected", username, deployment: "deploying", error: null });

    try {
      await this.ensureVercelIgnored(projectPath);
      if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
        throw new Error("O projeto ativo mudou antes do início da publicação.");
      }

      if (!isLinked) {
        const projectNameToUse = customProjectName?.trim();
        if (!projectNameToUse || !isValidVercelProjectName(projectNameToUse)) {
          throw new Error("Nome do projeto Vercel inválido.");
        }

        this.emit("log", `Configurando projeto "${projectNameToUse}" na Vercel...`);
        try {
          await this.cliWrapper.runCli(
            this.cli,
            ["project", "add", projectNameToUse],
            projectPath,
            60000,
            (line) => this.emit("log", line)
          );
        } catch (addErr: any) {
          const addMsg = String(addErr?.message || "").toLowerCase();
          if (!addMsg.includes("already exists") && !addMsg.includes("already in use")) {
            console.warn("[Neko/Vercel] project add note:", addErr?.message);
          }
        }

        try {
          await this.cliWrapper.runCli(
            this.cli,
            ["link", "--yes", "--project", projectNameToUse],
            projectPath,
            60000,
            (line) => this.emit("log", line)
          );
        } catch (linkErr: any) {
          throw new Error(formatVercelErrorMessage(linkErr?.message));
        }

        isLinked = await this.pathExists(projectJsonPath);
      }

      const args = ["deploy", "--prod", "--yes"];
      for (const [name, value] of Object.entries(publicEnvironment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value) continue;
        args.push("--build-env", `${name}=${value}`, "--env", `${name}=${value}`);
      }

      this.emit("log", `Publicando ${projectPath} na Vercel...`);
      const result = await this.cliWrapper.runCli(
        this.cli,
        args,
        projectPath,
        DEPLOY_TIMEOUT_MS,
        (line) => this.emit("log", line)
      );

      const deploymentUrl = parseVercelDeploymentUrl(result.stdout);
      if (!deploymentUrl) {
        throw new Error("A Vercel concluiu o comando, mas não retornou uma URL de publicação válida.");
      }

      if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
        throw new Error("O projeto ativo mudou durante a publicação.");
      }

      const linked = await this.pathExists(projectJsonPath);
      if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
        throw new Error("O projeto ativo mudou durante a publicação.");
      }

      const effectiveProjectName = customProjectName?.trim() || this.state.projectName || path.basename(projectPath);
      this.deploymentUrls.set(projectPath, deploymentUrl);
      await this.vault.saveDeployment(projectPath, deploymentUrl, effectiveProjectName);

      this.setState({
        deployment: "ready",
        linked,
        deploymentUrl,
        projectName: effectiveProjectName,
        error: null,
      });

      this.emit("log", `Frontend publicado com sucesso em ${deploymentUrl}`);
      return this.getState();
    } catch (error) {
      const message = formatVercelErrorMessage(error instanceof Error ? error.message : String(error));
      if (generation === this.projectGeneration && this.state.projectPath === projectPath) {
        this.setState({ deployment: "error", error: message });
      }
      throw new Error(message);
    }
  }


  public async readUsername(): Promise<string | null> {
    if (!this.cli) return null;
    try {
      const result = await this.cliWrapper.runCli(this.cli, ["whoami"], undefined, 120000);
      const username = cleanVercelOutput(result.stdout).split(/\s+/).at(-1);
      return username && /^[A-Za-z0-9._-]+$/.test(username) ? username : null;
    } catch {
      return null;
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureVercelIgnored(projectPath: string): Promise<void> {
    const gitignorePath = path.join(projectPath, ".gitignore");
    const source = (await this.pathExists(gitignorePath))
      ? await fs.readFile(gitignorePath, "utf8")
      : "";
    if (
      source
        .split(/\r?\n/)
        .some((line) => line.trim() === ".vercel" || line.trim() === ".vercel/")
    ) {
      return;
    }
    const separator = source && !source.endsWith("\n") ? "\n" : "";
    await fs.writeFile(gitignorePath, `${source}${separator}.vercel\n`, "utf8");
  }

  public shutdown(): void {
    this.shuttingDown = true;
    this.authAttempt += 1;
    this.cliWrapper.shutdown();
  }
}

export const vercelManager = new VercelManager();

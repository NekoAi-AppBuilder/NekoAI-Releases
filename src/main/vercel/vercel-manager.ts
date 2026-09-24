import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
  EMPTY_VERCEL_STATE,
  VercelCliCommand,
  VercelState,
  VercelDetectedProject,
  isValidVercelProjectName,
  normalizeGithubRepo,
} from "./vercel-types";
import { VercelVaultManager } from "./vercel-vault";
import { vercelIntentManager, vercelLinkIntentManager } from "./vercel-intent";
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
  private activeLoginProcess: ChildProcess | null = null;
  private authAttempt = 0;
  private projectGeneration = 0;
  private shuttingDown = false;
  private deploymentUrls = new Map<string, string>();

  private gitStatusGetter: ((projectPath: string) => Promise<{ linkedRepo?: string | null; remote?: string | null } | null>) | null = null;
  private detectionTask: Promise<VercelDetectedProject | null> | null = null;

  constructor(vault?: VercelVaultManager, cliWrapper?: VercelCli) {
    super();
    if (vault) this.vault = vault;
    if (cliWrapper) this.cliWrapper = cliWrapper;
  }

  public setGitStatusGetter(getter: (projectPath: string) => Promise<{ linkedRepo?: string | null; remote?: string | null } | null>): void {
    this.gitStatusGetter = getter;
  }

  public getState(): VercelState {
    return { ...this.state };
  }

  private setState(patch: Partial<VercelState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.getState());
  }

  public async detectLinkedProject(gitRepoOverride?: string | null): Promise<VercelDetectedProject | null> {
    if (this.detectionTask) return this.detectionTask;
    const task = this.detectLinkedProjectOnce(gitRepoOverride);
    this.detectionTask = task;
    try {
      return await task;
    } finally {
      if (this.detectionTask === task) this.detectionTask = null;
    }
  }

  private async detectLinkedProjectOnce(gitRepoOverride?: string | null): Promise<VercelDetectedProject | null> {
    const projectPath = this.state.projectPath;
    const generation = this.projectGeneration;

    if (!projectPath || this.state.connection !== "connected" || !this.state.username) {
      if (this.state.detectedProject !== null) {
        this.setState({ detectedProject: null });
      }
      return null;
    }

    let rawRepo = gitRepoOverride;
    if (!rawRepo && this.gitStatusGetter) {
      try {
        const gitInfo = await this.gitStatusGetter(projectPath);
        rawRepo = gitInfo?.linkedRepo || gitInfo?.remote || null;
      } catch (err) {
        console.warn("[Neko/Vercel] error getting git status for detection:", err);
      }
    }

    const normalizedRepo = normalizeGithubRepo(rawRepo);
    if (!normalizedRepo) {
      if (generation === this.projectGeneration && this.state.projectPath === projectPath) {
        if (this.state.detectedProject !== null) {
          this.setState({ detectedProject: null });
        }
      }
      return null;
    }

    if (!this.cli && this.cliWrapper?.resolveCli) {
      this.cli = await this.cliWrapper.resolveCli().catch(() => null);
    }
    if (!this.cli) return null;

    try {
      const projects = await this.cliWrapper.listProjectsJson(this.cli);
      if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
        return null;
      }

      const matches: Array<{ id?: string; name: string; gitRepo: string; updatedAt?: number }> = [];

      for (const p of projects) {
        if (!p || !p.name) continue;
        const link = p.link;
        if (!link) continue;
        const orgRepo = link.org && link.repo ? `${link.org}/${link.repo}` : link.repo || "";
        const pNorm = normalizeGithubRepo(orgRepo);
        if (pNorm && pNorm === normalizedRepo) {
          matches.push({
            id: p.id || p.projectId,
            name: p.name,
            gitRepo: `${link.org || ""}${link.org ? "/" : ""}${link.repo || ""}` || normalizedRepo,
            updatedAt: p.updatedAt || p.createdAt || 0,
          });
        }
      }

      if (matches.length === 0) {
        if (generation === this.projectGeneration && this.state.projectPath === projectPath) {
          if (this.state.detectedProject !== null) {
            this.setState({ detectedProject: null });
          }
        }
        return null;
      }

      // Sort descending by updatedAt
      matches.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const bestMatch = matches[0];

      if (generation === this.projectGeneration && this.state.projectPath === projectPath) {
        const patch: Partial<VercelState> = { detectedProject: bestMatch };
        if (
          !this.state.linked &&
          !this.state.deploymentUrl &&
          (!this.state.projectName || this.state.projectName === path.basename(projectPath))
        ) {
          patch.projectName = bestMatch.name;
        }
        this.setState(patch);
      }
      return bestMatch;
    } catch (err) {
      console.warn("[Neko/Vercel] detectLinkedProject failed:", err);
      return null;
    }
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
      this.setState({
        connection: "connected",
        username,
        error: null,
      });
      if (this.state.projectPath) {
        await this.restoreProjectBinding(this.state.projectPath, username);
      }
      void this.detectLinkedProject();
    } else {
      this.setState({
        connection: "disconnected",
        username: null,
        error: null,
        detectedProject: null,
      });
    }
  }

  public async restoreProjectBinding(projectPath: string | null, username: string | null): Promise<void> {
    if (!projectPath) return;
    const deployment = await this.vault.getDeployment(projectPath);
    const hasProjectJson = await this.pathExists(path.join(projectPath, ".vercel", "project.json"));

    if (deployment) {
      if (!deployment.username || !username || deployment.username === username) {
        // Same account or legacy: restore deployment & linked status
        this.deploymentUrls.set(projectPath, deployment.deploymentUrl);
        this.setState({
          projectName: deployment.projectName || path.basename(projectPath),
          deploymentUrl: deployment.deploymentUrl,
          linked: hasProjectJson || Boolean(deployment.projectName),
          error: null,
        });
      } else {
        // Different account: verify ownership/access before restoring
        let hasAccess = false;
        if (!this.cli && this.cliWrapper?.resolveCli) {
          this.cli = await this.cliWrapper.resolveCli().catch(() => null);
        }
        if (this.cli && deployment.projectName) {
          try {
            const listRes = await this.cliWrapper.runCli(this.cli, ["project", "ls"], undefined, 15000);
            if (cleanVercelOutput(listRes.stdout).toLowerCase().includes(deployment.projectName.toLowerCase())) {
              hasAccess = true;
            }
          } catch {}
        }
        if (hasAccess) {
          await this.vault.saveDeployment(projectPath, deployment.deploymentUrl, deployment.projectName, username);
          this.deploymentUrls.set(projectPath, deployment.deploymentUrl);
          this.setState({
            projectName: deployment.projectName,
            deploymentUrl: deployment.deploymentUrl,
            linked: hasProjectJson || true,
            error: null,
          });
        } else {
          // Account B does not have access to Account A's project
          // Remove stale .vercel/project.json to avoid 403 on subsequent publish
          const vercelDir = path.join(projectPath, ".vercel");
          await fs.rm(vercelDir, { recursive: true, force: true }).catch(() => {});
          this.deploymentUrls.delete(projectPath);
          this.setState({
            projectName: path.basename(projectPath),
            deploymentUrl: null,
            linked: false,
          });
        }
      }
    } else if (hasProjectJson) {
      this.setState({ linked: true });
    }
  }

  public async setProject(projectPath: string | null): Promise<void> {
    const generation = ++this.projectGeneration;
    vercelIntentManager.invalidateAll("project changed");
    vercelLinkIntentManager.invalidateAll("project changed");
    if (!projectPath) {
      this.setState({
        projectPath: null,
        projectName: null,
        linked: false,
        deployment: "idle",
        deploymentUrl: null,
        error: null,
        detectedProject: null,
      });
      return;
    }

    const linked = await this.pathExists(path.join(projectPath, ".vercel", "project.json"));
    const deployment = await this.vault.getDeployment(projectPath);
    const cachedUrl = this.deploymentUrls.get(projectPath) ?? deployment?.deploymentUrl ?? null;
    const effectiveProjectName = deployment?.projectName || path.basename(projectPath);

    if (generation !== this.projectGeneration) return;

    if (this.state.username && deployment?.username && deployment.username !== this.state.username) {
      // Different account connected! Verify access
      let hasAccess = false;
      if (!this.cli && this.cliWrapper?.resolveCli) {
        this.cli = await this.cliWrapper.resolveCli().catch(() => null);
      }
      if (this.cli && deployment.projectName) {
        try {
          const listRes = await this.cliWrapper.runCli(this.cli, ["project", "ls"], undefined, 15000);
          if (cleanVercelOutput(listRes.stdout).toLowerCase().includes(deployment.projectName.toLowerCase())) {
            hasAccess = true;
          }
        } catch {}
      }
      if (hasAccess) {
        this.setState({
          projectPath,
          projectName: effectiveProjectName,
          linked: linked || Boolean(cachedUrl),
          deployment: "idle",
          deploymentUrl: cachedUrl,
          error: null,
        });
        await this.detectLinkedProject();
      } else {
        // Account B does not have access to Account A's project
        // Remove stale .vercel/project.json so future publish links cleanly
        const vercelDir = path.join(projectPath, ".vercel");
        await fs.rm(vercelDir, { recursive: true, force: true }).catch(() => {});
        this.deploymentUrls.delete(projectPath);
        this.setState({
          projectPath,
          projectName: path.basename(projectPath),
          linked: false,
          deployment: "idle",
          deploymentUrl: null,
          error: null,
        });
        await this.detectLinkedProject();
      }
      return;
    }

    this.setState({
      projectPath,
      projectName: effectiveProjectName,
      linked: linked || Boolean(cachedUrl),
      deployment: "idle",
      deploymentUrl: cachedUrl,
      error: null,
    });
    await this.detectLinkedProject();
  }

  public async unlinkProject(projectPath: string): Promise<VercelState> {
    if (!projectPath) return this.getState();
    vercelIntentManager.invalidateByPath(projectPath, "project unlinked");
    vercelLinkIntentManager.invalidateByPath(projectPath, "project unlinked");
    const vercelDir = path.join(projectPath, ".vercel");
    await fs.rm(vercelDir, { recursive: true, force: true }).catch(() => {});
    await this.vault.removeDeployment(projectPath);
    this.deploymentUrls.delete(projectPath);

    if (this.state.projectPath === projectPath) {
      this.setState({
        linked: false,
        deploymentUrl: null,
        projectName: path.basename(projectPath),
        deployment: "idle",
        error: null,
      });
      await this.detectLinkedProject();
    }
    return this.getState();
  }

  public async cancelLogin(): Promise<VercelState> {
    console.log("[Neko/Vercel] cancel login requested");
    this.authAttempt += 1;
    if (this.activeLoginProcess) {
      this.cliWrapper.terminate(this.activeLoginProcess);
      this.activeLoginProcess = null;
    }
    await this.authTask?.catch(() => undefined);
    this.authTask = null;
    this.setState({
      connection: "disconnected",
      username: null,
      error: null,
    });
    return this.getState();
  }

  public async disconnect(): Promise<VercelState> {
    console.log("[Neko/Vercel] disconnect requested");
    vercelIntentManager.invalidateAll("account disconnected");
    vercelLinkIntentManager.invalidateAll("account disconnected");
    this.authAttempt += 1;
    if (this.activeLoginProcess) {
      this.cliWrapper.terminate(this.activeLoginProcess);
      this.activeLoginProcess = null;
    }
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
        error: null,
        detectedProject: null,
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
      await this.restoreProjectBinding(this.state.projectPath, existingUser);
      void this.detectLinkedProject();
      return this.getState();
    }

    this.setState({ connection: "authorizing", username: null, error: null });
    let strategyIndex = 0;
    const maxStrategies = 4;

    try {
      while (!this.shuttingDown && attempt === this.authAttempt && strategyIndex < maxStrategies) {
        console.log("[Neko/Vercel] terminal launch requested");
        let termSession: import("./vercel-cli").VercelLoginTerminalSession;
        try {
          termSession = await this.cliWrapper.openLoginTerminal(this.cli, strategyIndex);
        } catch (err: any) {
          console.log(`[Neko/Vercel] terminal launch failure: ${err?.message || "falha ao iniciar"}`);
          throw err;
        }

        this.activeLoginProcess = termSession.child;
        const startTime = Date.now();
        console.log(`[Neko/Vercel] terminal strategy selected: ${termSession.strategy}`);
        console.log(`[Neko/Vercel] terminal process spawned pid=${termSession.pid || "unknown"}`);
        console.log("[Neko/Vercel] waiting for authentication");

        const closeState: {
          closed: boolean;
          closedAt: number | null;
          code: number | null;
          signal: NodeJS.Signals | null;
        } = {
          closed: false,
          closedAt: null,
          code: null,
          signal: null,
        };
        const closePromise = termSession.waitClose().then((info) => {
          closeState.closed = true;
          closeState.closedAt = Date.now();
          closeState.code = info.code;
          closeState.signal = info.signal;
        });

        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        let earlyExit = false;

        while (!this.shuttingDown && attempt === this.authAttempt && Date.now() < deadline) {
          if (closeState.closed) {
            const duration = (closeState.closedAt ?? Date.now()) - startTime;
            console.log(
              `[Neko/Vercel] terminal process exited (exitCode=${closeState.code ?? "null"}, duration=${duration}ms)`
            );
            console.log("[Neko/Vercel] checking authentication");
            const username = await this.readUsername();
            if (username) {
              console.log(`[Neko/Vercel] login completion detected user=${username}`);
              this.setState({ connection: "connected", username, error: null });
              await this.restoreProjectBinding(this.state.projectPath, username);
              void this.detectLinkedProject();
              return this.getState();
            }

            // Proteção contra falha de inicialização / early exit (< 1000ms sem autenticação)
            if (duration < 1000 && termSession.strategy !== "mock") {
              console.log(
                `[Neko/Vercel] terminal launch failure: process exited prematurely after ${duration}ms without authentication`
              );
              earlyExit = true;
              break;
            }

            console.log("[Neko/Vercel] user cancellation: login terminal closed without completion");
            this.setState({ connection: "disconnected", username: null, error: null });
            return this.getState();
          }

          await Promise.race([wait(1500), closePromise]);
          if (this.shuttingDown || attempt !== this.authAttempt) break;

          if (closeState.closed) continue;

          console.log("[Neko/Vercel] checking authentication");
          const username = await this.readUsername();
          console.log(`[Neko/Vercel] whoami result=${username || "null"}`);
          if (username) {
            console.log(`[Neko/Vercel] login completion detected user=${username}`);
            this.setState({ connection: "connected", username, error: null });
            await this.restoreProjectBinding(this.state.projectPath, username);
            void this.detectLinkedProject();
            return this.getState();
          }
        }

        if (this.activeLoginProcess) {
          this.cliWrapper.terminate(this.activeLoginProcess);
          this.activeLoginProcess = null;
        }

        if (earlyExit) {
          strategyIndex++;
          console.log(`[Neko/Vercel] fallback strategy selected: index ${strategyIndex}`);
          continue;
        }

        if (this.shuttingDown || attempt !== this.authAttempt) {
          this.setState({ connection: "disconnected", username: null, error: null });
          return this.getState();
        }

        console.log("[Neko/Vercel] authentication failed timeout");
        throw new Error("Não foi possível concluir a autenticação da Vercel (tempo limite esgotado).");
      }

      throw new Error("Todas as estratégias de inicialização do terminal de login falharam.");
    } catch (error) {
      if (this.shuttingDown || attempt !== this.authAttempt) {
        this.setState({ connection: "disconnected", username: null, error: null });
        return this.getState();
      }
      const message = error instanceof Error ? error.message : "Não foi possível conectar à Vercel.";
      console.log(`[Neko/Vercel] authentication failed: ${message}`);
      this.setState({ connection: "error", username: null, error: message });
      throw error;
    } finally {
      if (this.activeLoginProcess) {
        this.cliWrapper.terminate(this.activeLoginProcess);
        this.activeLoginProcess = null;
      }
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
        isLinked = await this.ensureLinked(projectPath, projectNameToUse);
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
      await this.vault.saveDeployment(projectPath, deploymentUrl, effectiveProjectName, username);

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

  public async ensureLinked(projectPath: string, projectName: string): Promise<boolean> {
    const projectJsonPath = path.join(projectPath, ".vercel", "project.json");
    if (await this.pathExists(projectJsonPath)) return true;

    const projectNameToUse = projectName?.trim();
    if (!projectNameToUse || !isValidVercelProjectName(projectNameToUse)) {
      throw new Error("Nome do projeto Vercel inválido.");
    }

    if (!this.cli) this.cli = await this.cliWrapper.resolveCli();
    if (!this.cli) {
      throw new Error("O Vercel CLI não está disponível porque o npm não foi encontrado.");
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

    return await this.pathExists(projectJsonPath);
  }

  public async linkDetectedProject(projectPath: string, projectName: string): Promise<VercelState> {
    if (!projectPath || this.state.projectPath !== projectPath) {
      throw new Error("O projeto selecionado mudou antes do vínculo.");
    }
    const generation = this.projectGeneration;
    if (!this.cli) this.cli = await this.cliWrapper.resolveCli();
    if (!this.cli) {
      throw new Error("O Vercel CLI não está disponível porque o npm não foi encontrado.");
    }

    const username = await this.readUsername();
    if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
      throw new Error("O projeto ativo mudou antes do início do vínculo.");
    }
    if (!username) {
      this.setState({ connection: "disconnected", username: null, error: null });
      throw new Error("Conecte sua conta da Vercel antes de vincular.");
    }

    const projectNameToUse = projectName?.trim();
    if (!projectNameToUse || !isValidVercelProjectName(projectNameToUse)) {
      throw new Error("Nome do projeto Vercel inválido.");
    }

    await this.ensureVercelIgnored(projectPath);

    this.emit("log", `Vinculando workspace ao projeto "${projectNameToUse}" na Vercel...`);

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

    const projectJsonPath = path.join(projectPath, ".vercel", "project.json");
    const isLinked = await this.pathExists(projectJsonPath);
    if (!isLinked) {
      throw new Error("Não foi possível criar a configuração local do vínculo (.vercel/project.json).");
    }

    if (generation !== this.projectGeneration || this.state.projectPath !== projectPath) {
      throw new Error("O projeto ativo mudou durante o vínculo.");
    }

    const cachedUrl = this.deploymentUrls.get(projectPath) || null;
    await this.vault.saveDeployment(projectPath, cachedUrl || "", projectNameToUse, username);

    this.setState({
      linked: true,
      projectName: projectNameToUse,
      error: null,
    });

    this.emit("log", `Projeto "${projectNameToUse}" vinculado com sucesso.`);
    return this.getState();
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
    if (this.activeLoginProcess) {
      this.cliWrapper.terminate(this.activeLoginProcess);
      this.activeLoginProcess = null;
    }
    this.cliWrapper.shutdown();
  }
}

export const vercelManager = new VercelManager();

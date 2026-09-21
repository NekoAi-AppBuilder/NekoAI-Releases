import { EventEmitter } from "node:events";
import { SupabaseVaultManager, projectKey } from "./supabase-vault";
import { SupabaseCli, parseSupabaseError } from "./supabase-cli";
import {
  configureSupabaseProject,
  createProjectFileRollback,
  writeSupabaseOpenCodeConfig,
  writeSupabaseVsCodeMcpConfig,
  writeSupabaseAntigravityMcpConfig,
  removeSupabaseOpenCodeConfig,
  removeSupabaseSkill,
  removeSupabaseVsCodeMcpConfig,
  removeSupabaseAntigravityMcpConfig,
} from "./supabase-config";
import {
  EMPTY_SUPABASE_STATE,
  SupabaseConnection,
  SupabaseCreateProjectPayload,
  SupabaseIntegration,
  SupabaseState,
  SupabaseStatus,
} from "./supabase-types";

export class SupabaseManager extends EventEmitter {
  private state: SupabaseState = { ...EMPTY_SUPABASE_STATE };
  private vault = new SupabaseVaultManager();
  public cli = new SupabaseCli();
  private activeProjectPath: string | null = null;
  private isBusy = false;
  private currentAccessToken: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(vault?: SupabaseVaultManager, cli?: SupabaseCli) {
    super();
    if (vault) this.vault = vault;
    if (cli) this.cli = cli;
  }

  public getState(): SupabaseState {
    return {
      ...this.state,
      projects: [...this.state.projects],
      organizations: [...this.state.organizations],
      usedProjectRefs: this.state.usedProjectRefs ? [...this.state.usedProjectRefs] : [],
    };
  }

  private setState(patch: Partial<SupabaseState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.getState());
  }

  public setProgress(status: SupabaseStatus, error: string | null = null) {
    this.setState({ status, error });
  }

  public async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      console.log("[SupabaseInit] start");
      await this.vault.loadVault();
      try {
        const projects = await this.cli.listProjects();
        console.log("[SupabaseInit] projects loaded", { count: projects.length });
        const organizations = await this.cli.listOrganizations();
        console.log("[SupabaseInit] organizations loaded", { count: organizations.length });
        const usedProjectRefs = await this.vault.getAllUsedProjectRefs(this.activeProjectPath || undefined);
        this.setState({
          configured: true,
          projects,
          organizations,
          usedProjectRefs,
        });
        if (this.activeProjectPath) {
          console.log("[SupabaseInit] applying active project", { path: this.activeProjectPath });
          await this.applyProjectState(this.activeProjectPath);
        }
        console.log("[SupabaseInit] complete");
      } catch (err) {
        console.warn("[SupabaseInit] error during init:", err);
        const usedProjectRefs = await this.vault.getAllUsedProjectRefs(this.activeProjectPath || undefined).catch(() => []);
        this.setState({
          configured: true,
          status: "disconnected",
          projects: [],
          organizations: [],
          usedProjectRefs,
        });
        if (this.activeProjectPath) {
          await this.applyProjectState(this.activeProjectPath);
        }
        console.log("[SupabaseInit] complete (with error/offline)");
      }
    })();
    return this.initPromise;
  }

  private async applyProjectState(projectPath: string | null): Promise<void> {
    const currentProjects = this.state.projects || [];
    const currentOrganizations = this.state.organizations || [];
    const usedProjectRefs = await this.vault.getAllUsedProjectRefs(projectPath || undefined);

    if (!projectPath) {
      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        projects: currentProjects,
        organizations: currentOrganizations,
        usedProjectRefs,
      });
      return;
    }

    const integration = await this.vault.getIntegration(projectPath);
    if (integration) {
      const normRef = (integration.projectRef || "").trim().toLowerCase();
      const hasAccess = currentProjects.length > 0
        ? currentProjects.some(p => (p.ref || "").trim().toLowerCase() === normRef || (p.id || "").trim().toLowerCase() === normRef)
        : true; // Se os projetos ainda não foram listados ou CLI não respondeu, mantém o vínculo salvo no vault

      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        status: hasAccess ? "connected" : "disconnected",
        projectRef: integration.projectRef,
        projectName: integration.projectName,
        projectUrl: integration.projectUrl,
        region: integration.region || null,
        pendingRuntimeSetup: integration.pendingRuntimeSetup || false,
        projects: currentProjects,
        organizations: currentOrganizations,
        usedProjectRefs,
      });
    } else {
      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        status: "disconnected",
        projects: currentProjects,
        organizations: currentOrganizations,
        usedProjectRefs,
      });
    }
  }

  public async setProject(projectPath: string | null): Promise<void> {
    this.activeProjectPath = projectPath;
    await this.vault.loadVault();
    if (this.initPromise) {
      console.log("[SupabaseSetProject] waiting initialization");
      await this.initPromise.catch(() => {});
    }
    console.log("[SupabaseSetProject] applying project", { path: projectPath });
    await this.applyProjectState(projectPath);
    console.log("[SupabaseSetProject] complete", { path: projectPath });
  }

  public async connectWithToken(token: string): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Uma operação do Supabase já está em andamento.");
    this.isBusy = true;
    this.setProgress("checking");

    try {
      await this.cli.login(token);
      this.currentAccessToken = token.trim();
      this.setProgress("selecting");
      const projects = await this.cli.listProjects();
      const organizations = await this.cli.listOrganizations();

      let autoConnected = false;
      let connectedRef: string | null = null;
      let connectedName: string | null = null;
      let connectedUrl: string | null = null;
      let connectedRegion: string | null = null;
      let pendingRuntime = false;

      if (this.activeProjectPath) {
        const integration = await this.vault.getIntegration(this.activeProjectPath);
        if (integration) {
          const matchingProject = projects.find(
            (p) => p.ref === integration.projectRef || p.id === integration.projectRef
          );
          if (matchingProject) {
            autoConnected = true;
            connectedRef = integration.projectRef;
            connectedName = matchingProject.name || integration.projectName;
            connectedUrl = integration.projectUrl || `https://${integration.projectRef}.supabase.co`;
            connectedRegion = matchingProject.region || integration.region || null;
            pendingRuntime = integration.pendingRuntimeSetup || false;
          }
        }
      }

      this.setState({
        status: autoConnected ? "connected" : "disconnected",
        projectRef: connectedRef,
        projectName: connectedName,
        projectUrl: connectedUrl,
        region: connectedRegion,
        pendingRuntimeSetup: pendingRuntime,
        projects,
        organizations,
        error: null,
        structuredError: null,
      });
      return this.getState();
    } catch (error) {
      const parsed = parseSupabaseError(error);
      this.setState({
        status: "error",
        error: parsed.message,
        structuredError: parsed,
      });
      const err = new Error(parsed.message);
      (err as any).structured = parsed;
      throw err;
    } finally {
      this.isBusy = false;
    }
  }

  public async refreshProjects(clearNotice = false): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Uma operação do Supabase já está em andamento.");
    this.isBusy = true;
    const previousState = { ...this.state };
    this.setProgress("selecting");

    try {
      const projects = await this.cli.listProjects();
      const organizations = await this.cli.listOrganizations();
      const usedProjectRefs = await this.vault.getAllUsedProjectRefs(this.activeProjectPath || undefined);

      let autoConnected = previousState.status === "connected";
      let connectedRef = previousState.projectRef;
      let connectedName = previousState.projectName;
      let connectedUrl = previousState.projectUrl;
      let connectedRegion = previousState.region;

      if (this.activeProjectPath) {
        const integration = await this.vault.getIntegration(this.activeProjectPath);
        if (integration) {
          const matchingProject = projects.find(
            (p) => p.ref === integration.projectRef || p.id === integration.projectRef
          );
          if (matchingProject) {
            autoConnected = true;
            connectedRef = integration.projectRef;
            connectedName = matchingProject.name || integration.projectName;
            connectedUrl = integration.projectUrl || `https://${integration.projectRef}.supabase.co`;
            connectedRegion = matchingProject.region || integration.region || null;
          } else {
            autoConnected = false;
            connectedRef = null;
            connectedName = null;
            connectedUrl = null;
            connectedRegion = null;
          }
        }
      }

      this.setState({
        ...previousState,
        status: autoConnected ? "connected" : "disconnected",
        projectRef: connectedRef,
        projectName: connectedName,
        projectUrl: connectedUrl,
        region: connectedRegion,
        projects,
        organizations,
        usedProjectRefs,
        recentCreatedNotice: clearNotice ? null : previousState.recentCreatedNotice,
        error: null,
        structuredError: null,
      });
      return this.getState();
    } catch (error) {
      const parsed = parseSupabaseError(error);
      this.setState({
        ...previousState,
        status: previousState.status === "connected" ? "connected" : "error",
        error: parsed.message,
        structuredError: parsed,
      });
      const err = new Error(parsed.message);
      (err as any).structured = parsed;
      throw err;
    } finally {
      this.isBusy = false;
    }
  }

  public async createProject(payload: SupabaseCreateProjectPayload): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Uma operação do Supabase já está em andamento.");
    this.isBusy = true;
    const previousState = { ...this.state };
    this.setProgress("validating");

    try {
      await this.cli.createProject(payload);
      const projects = await this.cli.listProjects().catch(() => previousState.projects);
      const organizations = await this.cli.listOrganizations().catch(() => previousState.organizations);
      const usedProjectRefs = await this.vault.getAllUsedProjectRefs(this.activeProjectPath || undefined);
      this.setState({
        ...previousState,
        status: previousState.status === "connected" ? "connected" : "disconnected",
        projectRef: previousState.projectRef,
        projectName: previousState.projectName,
        projectUrl: previousState.projectUrl,
        projects,
        organizations,
        usedProjectRefs,
        recentCreatedNotice:
          "Projeto criado com sucesso! Ele pode demorar até 2 minutos para aparecer na lista. Use o botão atualizar para verificar.",
        error: null,
        structuredError: null,
      });
      return this.getState();
    } catch (error) {
      const parsed = parseSupabaseError(error);
      this.setState({
        ...previousState,
        error: parsed.message,
        structuredError: parsed,
        recentCreatedNotice: null,
      });
      const err = new Error(parsed.message);
      (err as any).structured = parsed;
      throw err;
    } finally {
      this.isBusy = false;
    }
  }

  public async validateConnection(url: string, publishableKey: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${url}/auth/v1/settings`, {
        headers: { apikey: publishableKey },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Não foi possível conectar ao endpoint do Supabase. Verifique sua conexão.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error("A chave pública não pertence a esse projeto ou não está mais ativa.");
    }
    if (!response.ok) {
      throw new Error(`O projeto Supabase respondeu com HTTP ${response.status}. Verifique se ele está ativo.`);
    }
  }

  public async selectProject(
    projectPath: string,
    ref: string,
    options?: {
      framework?: string | null;
      packageManager?: string | null;
      projectRoot?: string | null;
      log?: (msg: string) => void;
    }
  ): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Uma operação do Supabase já está em andamento.");
    this.isBusy = true;

    // Guard de Backend: impede associar projeto Supabase se já estiver associado a outro workspace local
    const isUsedElsewhere = await this.vault.isProjectUsedElsewhere(projectPath, ref);
    if (isUsedElsewhere) {
      this.isBusy = false;
      throw new Error(`Este projeto Supabase já está associado a outro projeto local no NekoAI.`);
    }

    let rollback: (() => Promise<void>) | null = null;
    const previousIntegration = await this.vault.getIntegration(projectPath);

    try {
      this.setProgress("validating");
      const project = this.state.projects.find((p) => p.ref === ref) || {
        id: ref,
        name: `Projeto ${ref}`,
        ref,
        region: "sa-east-1",
        status: "ACTIVE",
      };

      const { publishableKey } = await this.cli.fetchApiKeys(ref);
      const url = `https://${ref}.supabase.co`;

      await this.validateConnection(url, publishableKey);

      if (this.activeProjectPath !== projectPath) {
        throw new Error("A pasta aberta mudou durante a integração. Selecione o projeto Supabase novamente.");
      }

      // Snapshot prévio para rollback atômico
      rollback = await createProjectFileRollback([projectPath, options?.projectRoot]);

      // 1) Configura MCPs nos editores
      await writeSupabaseOpenCodeConfig(projectPath, ref);
      await writeSupabaseVsCodeMcpConfig(projectPath, ref).catch(() => {});
      await writeSupabaseAntigravityMcpConfig(ref).catch(() => []);

      // 2) Fluxo OAuth nativo do OpenCode
      this.setProgress("authorizing");
      try {
        await this.cli.authenticateOpenCodeSupabase(
          projectPath,
          ref,
          options?.log,
          (status) => this.setProgress(status)
        );
      } catch (oauthErr) {
        options?.log?.(`Aviso OAuth OpenCode: ${oauthErr instanceof Error ? oauthErr.message : String(oauthErr)}`);
        throw oauthErr;
      }

      if (this.activeProjectPath !== projectPath) {
        throw new Error("A pasta aberta mudou durante a autorização do Supabase.");
      }

      // 3) Instalação do SDK, configuração de .env.local e Skill
      this.setProgress("installing");
      const connection: SupabaseConnection = {
        ref,
        name: project.name,
        url,
        publishableKey,
      };

      const setup = await configureSupabaseProject({
        selectedRoot: projectPath,
        projectRoot: options?.projectRoot || projectPath,
        framework: options?.framework,
        packageManager: options?.packageManager,
        connection,
        log: options?.log,
      });

      await this.vault.saveIntegration(projectPath, {
        projectRef: ref,
        projectName: project.name,
        projectUrl: url,
        publishableKey,
        region: project.region,
        mcpName: `neko_supabase_${ref}`,
        openCodeConfigPath: setup.openCodeConfigPath,
        pendingRuntimeSetup: setup.pendingRuntimeSetup,
        connectedAt: Date.now(),
      });

      if (previousIntegration && previousIntegration.projectRef !== ref) {
        try {
          await removeSupabaseOpenCodeConfig(projectPath, previousIntegration.projectRef);
          await removeSupabaseSkill(projectPath, previousIntegration.projectRef);
          const usedElsewhere = await this.vault.isProjectUsedElsewhere(projectPath, previousIntegration.projectRef);
          if (!usedElsewhere) {
            await removeSupabaseAntigravityMcpConfig(previousIntegration.projectRef).catch(() => {});
          }
        } catch {}
      }

      const usedProjectRefs = await this.vault.getAllUsedProjectRefs(projectPath);

      this.setState({
        status: "connected",
        projectRef: ref,
        projectName: project.name,
        projectUrl: url,
        region: project.region || null,
        pendingRuntimeSetup: setup.pendingRuntimeSetup,
        usedProjectRefs,
        recentCreatedNotice: null,
        error: null,
      });

      return this.getState();
    } catch (error) {
      if (rollback) {
        await rollback().catch(() => {});
      }
      if (previousIntegration) {
        await this.setProject(projectPath);
      } else {
        const msg = error instanceof Error ? error.message : "A integração com o Supabase falhou.";
        this.setProgress("error", msg);
      }
      throw error;
    } finally {
      this.isBusy = false;
    }
  }

  public async disconnect(_projectPath?: string): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Aguarde a operação atual do Supabase terminar.");
    this.isBusy = true;

    try {
      await this.cli.logout().catch(() => {});
      this.currentAccessToken = null;
      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        status: "disconnected",
        projects: [],
        organizations: [],
        usedProjectRefs: [],
      });

      return this.getState();
    } finally {
      this.isBusy = false;
    }
  }

  public async unlinkProject(projectPath: string): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Aguarde a operação atual do Supabase terminar.");
    this.isBusy = true;

    try {
      const integration = await this.vault.getIntegration(projectPath);
      if (integration) {
        await removeSupabaseOpenCodeConfig(projectPath, integration.projectRef).catch(() => {});
        await removeSupabaseSkill(projectPath, integration.projectRef).catch(() => {});
        await removeSupabaseVsCodeMcpConfig(projectPath, integration.projectRef).catch(() => {});

        const usedElsewhere = await this.vault.isProjectUsedElsewhere(projectPath, integration.projectRef);
        if (!usedElsewhere) {
          await removeSupabaseAntigravityMcpConfig(integration.projectRef).catch(() => {});
        }

        await this.vault.removeIntegration(projectPath);
      }

      const usedProjectRefs = await this.vault.getAllUsedProjectRefs(projectPath);

      if (this.activeProjectPath === projectPath) {
        this.setState({
          status: "disconnected",
          projectRef: null,
          projectName: null,
          projectUrl: null,
          region: null,
          pendingRuntimeSetup: false,
          usedProjectRefs,
          error: null,
        });
      }

      return this.getState();
    } finally {
      this.isBusy = false;
    }
  }

  public async getIntegration(projectPath: string): Promise<SupabaseIntegration | null> {
    return this.vault.getIntegration(projectPath);
  }

  public async getAccessToken(projectPath?: string): Promise<string | null> {
    if (this.currentAccessToken) {
      return this.currentAccessToken;
    }
    const cliToken = this.cli.readStoredCliToken();
    if (cliToken) {
      this.currentAccessToken = cliToken;
      return cliToken;
    }
    // As a fallback, if we have a project path, we might try to extract token from somewhere else,
    // but typically it's only in the CLI or memory.
    return null;
  }

  public shutdown() {
    this.cli.shutdown();
  }
}

export const supabaseManager = new SupabaseManager();
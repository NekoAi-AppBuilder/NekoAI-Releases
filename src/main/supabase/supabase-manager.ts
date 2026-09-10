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
  private cli = new SupabaseCli();
  private activeProjectPath: string | null = null;
  private isBusy = false;

  public getState(): SupabaseState {
    return { ...this.state, projects: [...this.state.projects], organizations: [...this.state.organizations] };
  }

  private setState(patch: Partial<SupabaseState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.getState());
  }

  public setProgress(status: SupabaseStatus, error: string | null = null) {
    this.setState({ status, error });
  }

  public async initialize(): Promise<void> {
    await this.vault.loadVault();
  }

  public async setProject(projectPath: string | null): Promise<void> {
    this.activeProjectPath = projectPath;
    const currentProjects = this.state.projects || [];
    const currentOrganizations = this.state.organizations || [];

    if (!projectPath) {
      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        projects: currentProjects,
        organizations: currentOrganizations,
      });
      return;
    }

    const integration = await this.vault.getIntegration(projectPath);
    if (integration) {
      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        status: "connected",
        projectRef: integration.projectRef,
        projectName: integration.projectName,
        projectUrl: integration.projectUrl,
        pendingRuntimeSetup: integration.pendingRuntimeSetup || false,
        projects: currentProjects,
        organizations: currentOrganizations,
      });
    } else {
      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        status: "disconnected",
        projects: currentProjects,
        organizations: currentOrganizations,
      });
    }
  }

  public async connectWithToken(token: string): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Uma operação do Supabase já está em andamento.");
    this.isBusy = true;
    this.setProgress("checking");

    try {
      await this.cli.login(token);
      this.setProgress("selecting");
      const projects = await this.cli.listProjects();
      const organizations = await this.cli.listOrganizations();
      this.setState({
        status: "disconnected",
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
      this.setState({
        ...previousState,
        status: previousState.status === "connected" ? "connected" : "disconnected",
        projects,
        organizations,
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
      this.setState({
        ...previousState,
        status: previousState.status === "connected" ? "connected" : "disconnected",
        projectRef: previousState.projectRef,
        projectName: previousState.projectName,
        projectUrl: previousState.projectUrl,
        projects,
        organizations,
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

      this.setState({
        status: "connected",
        projectRef: ref,
        projectName: project.name,
        projectUrl: url,
        pendingRuntimeSetup: setup.pendingRuntimeSetup,
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

  public async disconnect(projectPath: string): Promise<SupabaseState> {
    if (this.isBusy) throw new Error("Aguarde a operação atual do Supabase terminar.");
    this.isBusy = true;

    try {
      const integration = await this.vault.getIntegration(projectPath);
      if (integration) {
        await removeSupabaseOpenCodeConfig(projectPath, integration.projectRef);
        await removeSupabaseSkill(projectPath, integration.projectRef);
        await removeSupabaseVsCodeMcpConfig(projectPath, integration.projectRef).catch(() => {});

        const usedElsewhere = await this.vault.isProjectUsedElsewhere(projectPath, integration.projectRef);
        if (!usedElsewhere) {
          await removeSupabaseAntigravityMcpConfig(integration.projectRef).catch(() => {});
        }

        await this.vault.removeIntegration(projectPath);
      }

      this.setState({
        ...EMPTY_SUPABASE_STATE,
        configured: true,
        status: "disconnected",
      });

      return this.getState();
    } finally {
      this.isBusy = false;
    }
  }

  public async getIntegration(projectPath: string): Promise<SupabaseIntegration | null> {
    return this.vault.getIntegration(projectPath);
  }

  public shutdown() {
    this.cli.shutdown();
  }
}

export const supabaseManager = new SupabaseManager();
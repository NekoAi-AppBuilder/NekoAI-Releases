// src/main/runtime/runtime-manager.ts
// Fachada principal e orquestrador do NekoAI Runtime Manager.

import { RuntimeStore, RuntimeStoreOptions } from "./runtime-store";
import { RuntimeDetector } from "./runtime-detector";
import { getEmbeddedRuntimeEnv } from "../node-runtime";
import {
  RuntimeArchitecture,
  RuntimeDescriptor,
  RuntimeDistribution,
  RuntimePlatform,
  RuntimeProvider,
  TechnologyDetectionResult,
} from "./runtime-types";
import {
  PythonProvider,
  BunProvider,
  DenoProvider,
  PHPProvider,
} from "./providers";
import {
  RuntimeEnvironmentBuilder,
  ResolveEnvironmentOptions,
  ResolvedRuntimeEnvironment,
} from "./runtime-environment";
import {
  RuntimeProvisioningOrchestrator,
  RuntimeProvisionRequest,
  ProvisionAuthorization,
  OrchestratedProvisionResult,
} from "./runtime-provisioning-orchestrator";
import { RuntimeLifecycleManager } from "./runtime-lifecycle";
import {
  RuntimeRequirement,
  RuntimePermissionCardData,
} from "./runtime-types";

export interface RuntimeManagerOptions {
  storeOptions?: RuntimeStoreOptions;
  providers?: RuntimeProvider[];
  orchestrator?: RuntimeProvisioningOrchestrator;
  lifecycleManager?: RuntimeLifecycleManager;
}

export class RuntimeManager {
  private store: RuntimeStore;
  private detector: RuntimeDetector;
  private providers: Map<string, RuntimeProvider> = new Map();
  private orchestrator: RuntimeProvisioningOrchestrator;
  private lifecycleManager: RuntimeLifecycleManager;

  constructor(options: RuntimeManagerOptions = {}) {
    this.store = new RuntimeStore(options.storeOptions);
    this.detector = new RuntimeDetector();

    // Registrar provedores padrão se nenhum for passado explicitamente
    const defaultProviders = options.providers || [
      new PythonProvider(),
      new BunProvider(),
      new DenoProvider(),
      new PHPProvider(),
    ];

    for (const provider of defaultProviders) {
      this.registerProvider(provider);
    }

    this.orchestrator = options.orchestrator || new RuntimeProvisioningOrchestrator({
      store: this.store,
      getProvider: (id: string) => this.getProvider(id),
    });

    this.lifecycleManager = options.lifecycleManager || new RuntimeLifecycleManager({
      runtimeManager: this,
      orchestrator: this.orchestrator,
    });
  }

  public getStore(): RuntimeStore {
    return this.store;
  }

  public getDetector(): RuntimeDetector {
    return this.detector;
  }

  public getOrchestrator(): RuntimeProvisioningOrchestrator {
    return this.orchestrator;
  }

  public getLifecycleManager(): RuntimeLifecycleManager {
    return this.lifecycleManager;
  }

  public async evaluateProjectRequirements(
    projectPath: string,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): Promise<RuntimeRequirement[]> {
    return this.lifecycleManager.evaluateProjectRequirements(projectPath, platform, architecture);
  }

  public async authorizeAndProvision(
    requirement: RuntimeRequirement,
    authorization: ProvisionAuthorization,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): Promise<OrchestratedProvisionResult> {
    return this.lifecycleManager.authorizeAndProvision(requirement, authorization, platform, architecture);
  }

  /**
   * Registra um novo RuntimeProvider no gerenciador.
   */
  public registerProvider(provider: RuntimeProvider): void {
    this.providers.set(provider.id.toLowerCase(), provider);
  }

  /**
   * Obtém um Provider pelo ID único (ex: "python", "bun", "deno", "php").
   */
  public getProvider(id: string): RuntimeProvider | undefined {
    return this.providers.get(id.toLowerCase());
  }

  /**
   * Lista todos os RuntimeProviders registrados.
   */
  public listProviders(): RuntimeProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Consulta uma distribuição específica em um Provider registrado.
   */
  public getDistribution(
    runtimeId: string,
    version: string,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): RuntimeDistribution | undefined {
    const provider = this.getProvider(runtimeId);
    if (!provider) return undefined;
    return provider.getDistribution(version, platform, architecture);
  }

  /**
   * Retorna todos os runtimes registrados no manifesto do Store.
   */
  public async listRuntimes(): Promise<RuntimeDescriptor[]> {
    return this.store.listRuntimes();
  }

  /**
   * Busca um runtime pelo ID único.
   */
  public async getRuntime(id: string): Promise<RuntimeDescriptor | null> {
    return this.store.getRuntime(id);
  }

  /**
   * Busca runtimes pelo nome da linguagem/ferramenta.
   */
  public async findRuntimesByName(name: string): Promise<RuntimeDescriptor[]> {
    return this.store.findRuntimesByName(name);
  }

  /**
   * Registra um novo runtime no Store.
   */
  public async registerRuntime(descriptor: RuntimeDescriptor): Promise<void> {
    return this.store.registerRuntime(descriptor);
  }

  /**
   * Remove o registro de um runtime no Store.
   */
  public async unregisterRuntime(id: string): Promise<boolean> {
    return this.store.unregisterRuntime(id);
  }

  /**
   * Analisa a pasta de um projeto e retorna as tecnologias/runtimes detectados.
   */
  public async detectProjectTechnologies(projectPath: string): Promise<TechnologyDetectionResult[]> {
    return this.detector.detectProjectTechnologies(projectPath);
  }

  public async requestProvisioning(
    request: RuntimeProvisionRequest,
    authorization?: ProvisionAuthorization
  ): Promise<OrchestratedProvisionResult> {
    return this.orchestrator.requestProvisioning(request, authorization);
  }

  /**
   * Resolve o ambiente de execução isolado (PATH, env, executáveis) para um runtime instalado.
   * Se o runtime não estiver registrado ou a instalação física for inconsistente,
   * retorna o estado determinístico correspondente sem disparar download ou instalação.
   */
  public async resolveRuntimeEnvironment(
    runtimeId: string,
    options: ResolveEnvironmentOptions = {}
  ): Promise<ResolvedRuntimeEnvironment> {
    const descriptor = await this.store.getRuntime(runtimeId);
    if (!descriptor) {
      return {
        status: "not-installed",
        error: `NOT_INSTALLED: O runtime '${runtimeId}' não possui registro no RuntimeStore.`,
      };
    }
    return RuntimeEnvironmentBuilder.buildEnvironment(descriptor, options);
  }

  /**
   * Constrói o ambiente de processo isolado do OpenCode para um projeto específico.
   * Preserva precedência estrita:
   * Node.js & Git embutidos -> Runtimes especializados requeridos e instalados/válidos ('ready') -> PATH base.
   * Runtimes ausentes ou inconsistentes são ignorados de forma determinística.
   */
  public async getOpenCodeScopedEnv(
    projectPath: string,
    baseEnv: Record<string, string | undefined> = process.env
  ): Promise<Record<string, string | undefined>> {
    const embeddedEnv = getEmbeddedRuntimeEnv(baseEnv);
    const embeddedPath = embeddedEnv.PATH || embeddedEnv.Path || "";

    const requirements = await this.lifecycleManager.evaluateProjectRequirements(projectPath);

    const readyDescriptors: RuntimeDescriptor[] = requirements
      .filter((req) => req.state === "ready" && req.descriptor)
      .map((req) => req.descriptor!);

    if (readyDescriptors.length === 0) {
      return embeddedEnv;
    }

    const combined = RuntimeEnvironmentBuilder.buildCombinedEnvironment(readyDescriptors, {
      basePath: embeddedPath,
      baseEnv: embeddedEnv,
      validateExecutables: true,
    });

    return combined.env || embeddedEnv;
  }
}

// Instância singleton pronta para uso no Main Process
export const runtimeManager = new RuntimeManager();

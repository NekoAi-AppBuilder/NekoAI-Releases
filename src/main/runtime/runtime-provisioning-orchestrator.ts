// src/main/runtime/runtime-provisioning-orchestrator.ts
// Orquestrador central de provisionamento com contrato de autorização, máquina de estados, idempotência e segurança.

import { RuntimeDownloader } from "./runtime-downloader";
import { RuntimeProvisioner } from "./runtime-provisioner";
import { RuntimeStore } from "./runtime-store";
import {
  RuntimeArchitecture,
  RuntimeDescriptor,
  RuntimeDistribution,
  RuntimePlatform,
  RuntimeProvider,
} from "./runtime-types";

export type RuntimeProvisionStatus =
  | "requested"
  | "resolving"
  | "already-installed"
  | "download-pending"
  | "downloading"
  | "downloaded"
  | "installing"
  | "installed"
  | "failed"
  | "rolled-back"
  | "already-in-progress";

export interface ProvisionAuthorization {
  approved: boolean;
  source: "user" | "system" | "test" | "policy";
  reason?: string;
}

export interface RuntimeProvisionRequest {
  runtimeId: string;
  version: string;
  platform?: RuntimePlatform;
  architecture?: RuntimeArchitecture;
  reason?: string;
  // Campos arbitrários que NÃO devem sobresscrever o Provider (devem ser ignorados/bloqueados se fornecidos)
  url?: string;
  expectedSha256?: string;
}

export interface OrchestratedProvisionResult {
  status: RuntimeProvisionStatus;
  requestId: string;
  runtimeId: string;
  version: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  descriptor?: RuntimeDescriptor;
  error?: string;
  history: RuntimeProvisionStatus[];
}

export interface RuntimeProvisioningOrchestratorOptions {
  store?: RuntimeStore;
  downloader?: RuntimeDownloader;
  provisioner?: RuntimeProvisioner;
  providers?: Map<string, RuntimeProvider> | RuntimeProvider[];
  getProvider?: (id: string) => RuntimeProvider | undefined;
}

export class RuntimeProvisioningOrchestrator {
  private store: RuntimeStore;
  private downloader: RuntimeDownloader;
  private provisioner: RuntimeProvisioner;
  private providerResolver: (id: string) => RuntimeProvider | undefined;
  private activeRequests: Set<string> = new Set();

  // Tabela de transições de estado permitidas
  private static readonly ALLOWED_TRANSITIONS: Record<RuntimeProvisionStatus, Set<RuntimeProvisionStatus>> = {
    requested: new Set(["resolving", "failed"]),
    resolving: new Set(["already-installed", "download-pending", "failed"]),
    "already-installed": new Set(), // Estado terminal
    "download-pending": new Set(["downloading", "failed"]),
    downloading: new Set(["downloaded", "failed"]),
    downloaded: new Set(["installing", "failed"]),
    installing: new Set(["installed", "rolled-back", "failed"]),
    installed: new Set(), // Estado terminal
    failed: new Set(), // Estado terminal
    "rolled-back": new Set(), // Estado terminal
    "already-in-progress": new Set(), // Estado terminal
  };

  constructor(options: RuntimeProvisioningOrchestratorOptions = {}) {
    this.store = options.store || new RuntimeStore();
    this.downloader = options.downloader || new RuntimeDownloader();
    this.provisioner = options.provisioner || new RuntimeProvisioner({ store: this.store, downloader: this.downloader });

    if (options.getProvider) {
      this.providerResolver = options.getProvider;
    } else if (options.providers) {
      const pMap = options.providers instanceof Map
        ? options.providers
        : new Map(options.providers.map((p) => [p.id.toLowerCase(), p]));
      this.providerResolver = (id: string) => pMap.get(id.toLowerCase());
    } else {
      this.providerResolver = () => undefined;
    }
  }

  /**
   * Valida se uma transição entre dois estados é permitida pela máquina de estados.
   */
  public isValidTransition(current: RuntimeProvisionStatus, next: RuntimeProvisionStatus): boolean {
    const allowed = RuntimeProvisioningOrchestrator.ALLOWED_TRANSITIONS[current];
    return allowed ? allowed.has(next) : false;
  }

  /**
   * Fluxo principal e orquestrado de solicitação de provisionamento.
   */
  public async requestProvisioning(
    request: RuntimeProvisionRequest,
    authorization?: ProvisionAuthorization
  ): Promise<OrchestratedProvisionResult> {
    const history: RuntimeProvisionStatus[] = ["requested"];
    let currentStatus: RuntimeProvisionStatus = "requested";

    const transitionTo = (next: RuntimeProvisionStatus): RuntimeProvisionStatus => {
      if (!this.isValidTransition(currentStatus, next)) {
        throw new Error(`INVALID_STATE_TRANSITION: Transição de '${currentStatus}' para '${next}' é proibida.`);
      }
      history.push(next);
      return next;
    };

    const platform = request.platform || (process.platform as RuntimePlatform);
    const architecture = request.architecture || (process.arch as RuntimeArchitecture);
    const runtimeId = (request.runtimeId || "").trim().toLowerCase();
    const version = (request.version || "").trim();
    const requestId = `${runtimeId}-${version}-${platform}-${architecture}`;

    // 1. Validação do parâmetro de versão
    if (!runtimeId) {
      return {
        status: "failed",
        requestId,
        runtimeId: request.runtimeId,
        version: request.version,
        platform,
        architecture,
        error: "INVALID_REQUEST: 'runtimeId' é obrigatório.",
        history: ["requested", "failed"],
      };
    }

    if (!version || version.toLowerCase() === "latest") {
      return {
        status: "failed",
        requestId,
        runtimeId,
        version,
        platform,
        architecture,
        error: "INVALID_VERSION: Versão 'latest' ou vazia não é permitida. Especifique uma versão exata.",
        history: ["requested", "failed"],
      };
    }

    // 2. Proteção contra requisições simultâneas para o mesmo runtime
    if (this.activeRequests.has(requestId)) {
      return {
        status: "already-in-progress",
        requestId,
        runtimeId,
        version,
        platform,
        architecture,
        error: `CONCURRENT_PROVISIONING_BLOCKED: Solicitação de provisionamento para '${requestId}' já está em andamento.`,
        history: ["requested", "already-in-progress"],
      };
    }

    this.activeRequests.add(requestId);

    try {
      // 3. Transição: requested -> resolving
      currentStatus = transitionTo("resolving");

      // 4. Obter Provider e Distribution
      const provider = this.providerResolver(runtimeId);
      if (!provider) {
        currentStatus = transitionTo("failed");
        return {
          status: "failed",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: `PROVIDER_NOT_FOUND: Nenhum RuntimeProvider cadastrado para '${runtimeId}'.`,
          history,
        };
      }

      // GARANTIA DE SEGURANÇA: A autoridade da distribuição pertence unicamente ao Provider
      const distribution = provider.getDistribution(version, platform, architecture);
      if (!distribution) {
        currentStatus = transitionTo("failed");
        return {
          status: "failed",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: `UNSUPPORTED_VERSION: A versão '${version}' do runtime '${runtimeId}' não está disponível para ${platform}/${architecture}.`,
          history,
        };
      }

      if (!provider.isDistributionVerifiable(version, platform, architecture) || distribution.status !== "verified") {
        currentStatus = transitionTo("failed");
        return {
          status: "failed",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: `UNVERIFIABLE_DISTRIBUTION: A distribuição de '${runtimeId}' v${version} não possui checksum verificado.`,
          history,
        };
      }

      // 5. Verificação de Idempotência e Inconsistência no RuntimeStore
      const expectedDescriptorId = `${runtimeId}-${version}`;
      const existingDescriptor = await this.store.getRuntime(expectedDescriptorId);

      if (existingDescriptor) {
        const isPhysicallyPresent = this.store.verifyPhysicalExistence(existingDescriptor);
        if (isPhysicallyPresent) {
          currentStatus = transitionTo("already-installed");
          return {
            status: "already-installed",
            requestId,
            runtimeId,
            version,
            platform,
            architecture,
            descriptor: existingDescriptor,
            history,
          };
        } else {
          // Instalação registrada no Store porém arquivos ausentes fisicamente
          currentStatus = transitionTo("failed");
          return {
            status: "failed",
            requestId,
            runtimeId,
            version,
            platform,
            architecture,
            error: `INCONSISTENT_INSTALLATION: O runtime '${expectedDescriptorId}' possui registro no Store mas o diretório físico está ausente.`,
            history,
          };
        }
      }

      // 6. Fronteira de Autorização (Authorization Boundary)
      if (!authorization || !authorization.approved) {
        currentStatus = transitionTo("failed");
        return {
          status: "failed",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: `AUTHORIZATION_DENIED: O provisionamento do runtime '${runtimeId}' v${version} requer autorização aprovada.`,
          history,
        };
      }

      // 7. Preparação e Execução do Download (Autorizado)
      currentStatus = transitionTo("download-pending");
      currentStatus = transitionTo("downloading");

      // Usar estritamente a URL e SHA-256 fornecidos pelo Provider
      const stagingDir = `${this.store.getBaseDir()}/staging/${requestId}`;
      const archivePath = `${stagingDir}/archive.zip`;

      const downloadResult = await this.downloader.download({
        url: distribution.url,
        destinationPath: archivePath,
        expectedSha256: distribution.expectedSha256,
        expectedSizeBytes: distribution.sizeBytes,
      });

      if (!downloadResult.success) {
        currentStatus = transitionTo("failed");
        return {
          status: "failed",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: downloadResult.error || "DOWNLOAD_FAILED",
          history,
        };
      }

      currentStatus = transitionTo("downloaded");

      // 8. Provisionamento Físico, Extração e Registro
      currentStatus = transitionTo("installing");

      const provisionResult = await this.provisioner.provision({
        id: expectedDescriptorId,
        name: provider.name,
        version: distribution.version,
        downloadUrl: distribution.url,
        expectedSha256: distribution.expectedSha256,
        binDirs: distribution.binDirs,
        executables: distribution.executables,
        environmentVariables: distribution.environmentVariables,
      });

      if (!provisionResult.success || !provisionResult.descriptor) {
        currentStatus = transitionTo("rolled-back");
        return {
          status: "rolled-back",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: provisionResult.error || "PROVISIONING_FAILED",
          history,
        };
      }

      // 9. Conclusão e Validação Final do Estado no Store
      const savedDescriptor = await this.store.getRuntime(expectedDescriptorId);
      if (!savedDescriptor || savedDescriptor.status !== "ready") {
        currentStatus = transitionTo("failed");
        return {
          status: "failed",
          requestId,
          runtimeId,
          version,
          platform,
          architecture,
          error: "FINAL_VALIDATION_FAILED: O descriptor não foi registrado adequadamente no RuntimeStore.",
          history,
        };
      }

      currentStatus = transitionTo("installed");

      return {
        status: "installed",
        requestId,
        runtimeId,
        version,
        platform,
        architecture,
        descriptor: savedDescriptor,
        history,
      };
    } catch (err: any) {
      if ((currentStatus as string) !== "failed" && (currentStatus as string) !== "rolled-back" && (currentStatus as string) !== "installed" && (currentStatus as string) !== "already-installed") {
        try {
          currentStatus = transitionTo("failed");
        } catch {
          currentStatus = "failed";
          history.push("failed");
        }
      }
      return {
        status: (currentStatus as string) === "rolled-back" ? "rolled-back" : "failed",
        requestId,
        runtimeId,
        version,
        platform,
        architecture,
        error: `ORCHESTRATION_ERROR: ${err?.message || String(err)}`,
        history,
      };
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
}

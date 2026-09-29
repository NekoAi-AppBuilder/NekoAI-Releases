// src/main/runtime/runtime-lifecycle.ts
// Gerenciador do Ciclo de Vida de Runtimes: Detecção -> Avaliação de Necessidade -> Card de Autorização -> Provisionamento Orquestrado -> Resolução de Ambiente.

import { RuntimeManager } from "./runtime-manager";
import {
  OrchestratedProvisionResult,
  ProvisionAuthorization,
  RuntimeProvisioningOrchestrator,
} from "./runtime-provisioning-orchestrator";
import {
  RuntimeArchitecture,
  RuntimeDescriptor,
  RuntimeLifecycleEvent,
  RuntimeNeedState,
  RuntimePermissionCardData,
  RuntimePlatform,
  RuntimeRequirement,
  TechnologyDetectionResult,
} from "./runtime-types";

export type RuntimeLifecycleEventListener = (event: RuntimeLifecycleEvent) => void;

export interface RuntimeLifecycleManagerOptions {
  runtimeManager?: RuntimeManager;
  orchestrator?: RuntimeProvisioningOrchestrator;
}

export class RuntimeLifecycleManager {
  private runtimeManager: RuntimeManager;
  private orchestrator: RuntimeProvisioningOrchestrator;
  private eventListeners: Set<RuntimeLifecycleEventListener> = new Set();

  constructor(options: RuntimeLifecycleManagerOptions = {}) {
    this.runtimeManager = options.runtimeManager || new RuntimeManager();
    this.orchestrator = options.orchestrator || this.runtimeManager.getOrchestrator();
  }

  public subscribeEvents(listener: RuntimeLifecycleEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emitEvent(event: RuntimeLifecycleEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[RuntimeLifecycleManager] Erro no event listener:", err);
      }
    }
  }

  /**
   * Avalia a pasta do projeto, detecta tecnologias e determina a matriz de necessidades (RuntimeRequirement[])
   * sem efetuar nenhum download ou instalação automática.
   */
  public async evaluateProjectRequirements(
    projectPath: string,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): Promise<RuntimeRequirement[]> {
    const detections = await this.runtimeManager.detectProjectTechnologies(projectPath);
    const requirements: RuntimeRequirement[] = [];

    for (const detection of detections) {
      this.emitEvent({
        type: "detected",
        runtimeId: detection.possibleRuntime,
        timestamp: new Date().toISOString(),
        details: { technology: detection.technology, evidence: detection.evidence },
      });

      const requirement = await this.evaluateDetectionRequirement(detection, platform, architecture);
      requirements.push(requirement);

      this.emitEvent({
        type: "requirement-evaluated",
        runtimeId: requirement.runtimeId,
        version: requirement.version,
        timestamp: new Date().toISOString(),
        details: { state: requirement.state, reason: requirement.reason },
      });
    }

    return requirements;
  }

  /**
   * Avalia uma detecção individual determinando a versão exata e o estado de necessidade.
   */
  public async evaluateDetectionRequirement(
    detection: TechnologyDetectionResult,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): Promise<RuntimeRequirement> {
    const runtimeId = detection.possibleRuntime.toLowerCase();
    const provider = this.runtimeManager.getProvider(runtimeId);

    // 1. Determinação determinística da versão
    let targetVersion: string | undefined = undefined;

    if (detection.versionRequirement && !detection.versionRequirement.includes("*")) {
      targetVersion = detection.versionRequirement.replace(/[^0-9.]/g, "");
    }

    if (!targetVersion && provider) {
      const supportedSpecs = provider.getSupportedVersions();
      const stableOrLts = supportedSpecs.find((s) => s.isLts || s.isStable) || supportedSpecs[0];
      if (stableOrLts) {
        targetVersion = stableOrLts.version;
      }
    }

    if (!targetVersion) {
      return {
        technology: detection.technology,
        runtimeId,
        reason: `Tecnologia ${detection.technology} detectada via ${detection.evidence}, mas a versão necessária não pôde ser determinada.`,
        confidence: detection.confidence,
        evidence: detection.evidence,
        detectedFrom: detection.evidence,
        state: "version-selection-required",
        issue: "VERSION_NOT_DETERMINED",
      };
    }

    // 2. Verificar se o Provider suporta a versão determinística
    if (!provider) {
      return {
        technology: detection.technology,
        runtimeId,
        version: targetVersion,
        reason: `Provider para '${runtimeId}' não encontrado.`,
        confidence: detection.confidence,
        evidence: detection.evidence,
        detectedFrom: detection.evidence,
        state: "unsupported",
        issue: "PROVIDER_NOT_FOUND",
      };
    }

    const distribution = provider.getDistribution(targetVersion, platform, architecture);
    if (!distribution || !provider.isDistributionVerifiable(targetVersion, platform, architecture)) {
      return {
        technology: detection.technology,
        runtimeId,
        version: targetVersion,
        reason: `A versão '${targetVersion}' de '${runtimeId}' não possui distribuição verificada para ${platform}/${architecture}.`,
        confidence: detection.confidence,
        evidence: detection.evidence,
        detectedFrom: detection.evidence,
        state: "unsupported",
        issue: "UNSUPPORTED_DISTRIBUTION",
      };
    }

    // 3. Consultar o RuntimeStore para checar instalação e consistência
    const expectedDescriptorId = `${runtimeId}-${targetVersion}`;
    const store = this.runtimeManager.getStore();
    const descriptor = await store.getRuntime(expectedDescriptorId);

    if (descriptor) {
      const isPhysicallyPresent = store.verifyPhysicalExistence(descriptor);
      if (isPhysicallyPresent) {
        return {
          technology: detection.technology,
          runtimeId,
          version: targetVersion,
          reason: `O runtime '${detection.technology}' v${targetVersion} já está instalado e verificado no sistema.`,
          confidence: detection.confidence,
          evidence: detection.evidence,
          detectedFrom: detection.evidence,
          state: "ready",
          descriptor,
        };
      } else {
        return {
          technology: detection.technology,
          runtimeId,
          version: targetVersion,
          reason: `O runtime '${detection.technology}' v${targetVersion} está registrado no manifesto mas o diretório físico está ausente.`,
          confidence: detection.confidence,
          evidence: detection.evidence,
          detectedFrom: detection.evidence,
          state: "inconsistent",
          descriptor,
          issue: "PHYSICAL_DIRECTORY_MISSING",
        };
      }
    }

    // 4. Runtime não instalado: requer autorização explícita do usuário
    return {
      technology: detection.technology,
      runtimeId,
      version: targetVersion,
      requestedVersion: targetVersion,
      reason: `Projeto requer ${detection.technology} v${targetVersion} (detectado em ${detection.evidence}).`,
      confidence: detection.confidence,
      evidence: detection.evidence,
      detectedFrom: detection.evidence,
      state: "requires-authorization",
    };
  }

  /**
   * Constrói os dados do Card de Permissão para apresentação na UI ou IPC.
   */
  public buildPermissionCardData(
    requirement: RuntimeRequirement,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): RuntimePermissionCardData | undefined {
    if (!requirement.runtimeId || !requirement.version) return undefined;
    const provider = this.runtimeManager.getProvider(requirement.runtimeId);
    if (!provider) return undefined;

    const distribution = provider.getDistribution(requirement.version, platform, architecture);
    if (!distribution) return undefined;

    let officialOrigin = "Oficial";
    try {
      const parsedUrl = new URL(distribution.url);
      officialOrigin = parsedUrl.hostname;
    } catch {}

    const requestId = `${requirement.runtimeId}-${requirement.version}-${platform}-${architecture}`;

    return {
      requestId,
      runtimeId: requirement.runtimeId,
      technology: requirement.technology,
      version: requirement.version,
      reason: requirement.reason,
      officialOrigin,
      downloadUrl: distribution.url,
      expectedSizeBytes: distribution.sizeBytes,
      expectedSha256: distribution.expectedSha256,
      platform,
      architecture,
    };
  }

  /**
   * Executa a autorização do usuário e encaminha a requisição autorizada para o RuntimeProvisioningOrchestrator.
   */
  public async authorizeAndProvision(
    requirement: RuntimeRequirement,
    authorization: ProvisionAuthorization,
    platform: RuntimePlatform = process.platform as RuntimePlatform,
    architecture: RuntimeArchitecture = process.arch as RuntimeArchitecture
  ): Promise<OrchestratedProvisionResult> {
    const runtimeId = requirement.runtimeId;
    const version = requirement.version || requirement.requestedVersion || "";

    if (!authorization.approved) {
      this.emitEvent({
        type: "permission-denied",
        runtimeId,
        version,
        timestamp: new Date().toISOString(),
        details: { reason: authorization.reason || "Usuário recusou a instalação." },
      });

      return {
        status: "failed",
        requestId: `${runtimeId}-${version}-${platform}-${architecture}`,
        runtimeId,
        version,
        platform,
        architecture,
        error: `AUTHORIZATION_DENIED: O usuário negou a autorização para instalar '${runtimeId}' v${version}.`,
        history: ["requested", "failed"],
      };
    }

    this.emitEvent({
      type: "permission-granted",
      runtimeId,
      version,
      timestamp: new Date().toISOString(),
      details: { source: authorization.source, reason: authorization.reason },
    });

    this.emitEvent({
      type: "downloading",
      runtimeId,
      version,
      timestamp: new Date().toISOString(),
    });

    const result = await this.orchestrator.requestProvisioning(
      {
        runtimeId,
        version,
        platform,
        architecture,
        reason: requirement.reason,
      },
      authorization
    );

    if (result.status === "installed") {
      this.emitEvent({
        type: "installed",
        runtimeId,
        version,
        timestamp: new Date().toISOString(),
        details: { descriptorId: result.descriptor?.id },
      });
    } else if (result.status === "failed" || result.status === "rolled-back") {
      this.emitEvent({
        type: result.status,
        runtimeId,
        version,
        timestamp: new Date().toISOString(),
        error: result.error,
      });
    }

    return result;
  }
}

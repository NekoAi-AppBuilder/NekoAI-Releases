// src/main/runtime/runtime-types.ts
// Tipos e interfaces fundamentais do NekoAI Runtime Manager.

export type RuntimeCategory = "bundled" | "provisioned" | "system";

export type RuntimeStatus = "missing" | "installing" | "ready" | "error" | "corrupted";

export type ExecutableType = "runtime" | "cli" | "helper";

export interface RuntimeExecutable {
  name: string;             // ex: "python", "pip", "bun"
  relativePath: string;     // ex: "python.exe" ou "Scripts/pip.exe"
  type: ExecutableType;
}

export interface RuntimeDescriptor {
  id: string;               // ex: "python-3.12.7", "bun-1.1.30", "php-8.3.12"
  name: string;             // ex: "Python", "Bun", "PHP", "Node.js", "Git"
  version: string;          // ex: "3.12.7"
  category: RuntimeCategory;
  status: RuntimeStatus;
  
  // Diretórios e Executáveis
  installDir: string;       // Caminho absoluto da pasta raiz do runtime
  binDirs: string[];        // Diretórios contendo binários que devem entrar no PATH
  executables: RuntimeExecutable[];

  // Variáveis de ambiente específicas (opcional)
  environmentVariables?: Record<string, string>;

  // Metadados de Origem / Provisionamento (opcional)
  downloadUrl?: string;
  expectedSha256?: string;
  installedSizeBytes?: number;
  installedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeManifest {
  version: string;          // Versão do formato do manifesto (ex: "1.0")
  updatedAt: string;        // Timestamp ISO da última alteração
  runtimes: Record<string, RuntimeDescriptor>; // id -> RuntimeDescriptor
}

export type DetectionConfidence = "high" | "medium" | "low";

export interface TechnologyDetectionResult {
  technology: string;             // ex: "Python", "Node.js", "Bun", "Deno", "PHP"
  confidence: DetectionConfidence;
  evidence: string;               // ex: "pyproject.toml", "package.json", "bun.lockb"
  possibleRuntime: string;        // ex: "python", "node", "bun", "deno", "php"
  versionRequirement?: string;    // ex: ">=3.12" se extraível estaticamente
}

export interface DownloadSpec {
  url: string;
  destinationPath: string;
  expectedSha256: string;
  expectedSizeBytes?: number;
}

export interface DownloadResult {
  success: boolean;
  filePath: string;
  actualSha256: string;
  sizeBytes: number;
  error?: string;
}

export interface ProvisionOptions {
  id: string;
  name: string;
  version: string;
  downloadUrl: string;
  expectedSha256: string;
  binDirs: string[];
  executables: RuntimeExecutable[];
  environmentVariables?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ProvisionResult {
  success: boolean;
  descriptor?: RuntimeDescriptor;
  error?: string;
}

// ============================================================================
// CONTRATOS DA FASE 4A — RUNTIME PROVIDERS & DISTRIBUIÇÕES
// ============================================================================

export type RuntimePlatform = "win32" | "darwin" | "linux";

export type RuntimeArchitecture = "x64" | "arm64" | "x86";

export type DistributionStatus = "verified" | "unverified";

export type ArchiveType = "zip" | "tar.gz" | "executable";

export interface RuntimeVersionSpec {
  version: string;            // ex: "3.11.8", "1.1.0", "8.3.3"
  isLts?: boolean;
  isStable?: boolean;
  notes?: string;
}

export interface RuntimeDistribution {
  runtime: string;            // ex: "python", "bun", "deno", "php"
  version: string;            // ex: "3.11.8"
  platform: RuntimePlatform;  // ex: "win32"
  architecture: RuntimeArchitecture; // ex: "x64", "arm64"
  url: string;                // URL oficial HTTPS
  expectedSha256: string;     // Checksum SHA-256 oficial verificado
  status: DistributionStatus; // "verified" | "unverified"
  sizeBytes?: number;         // Tamanho esperado aproximado se conhecido
  archiveType: ArchiveType;   // "zip"
  binDirs: string[];          // ex: ["."] ou ["bin"]
  executables: RuntimeExecutable[];
  environmentVariables?: Record<string, string>;
  notes?: string;
}

export interface RuntimeProvider {
  id: string;                 // ex: "python", "bun", "deno", "php"
  name: string;               // ex: "Python Runtime Provider"
  supportedVersions: string[];// ex: ["3.11.8", "3.12.2"]

  getSupportedVersions(): RuntimeVersionSpec[];
  
  getDistribution(
    version: string,
    platform: RuntimePlatform,
    architecture: RuntimeArchitecture
  ): RuntimeDistribution | undefined;

  isDistributionVerifiable(
    version: string,
    platform: RuntimePlatform,
    architecture: RuntimeArchitecture
  ): boolean;
}

// ============================================================================
// CONTRATOS DA FASE 4D — RUNTIME LIFECYCLE & PERMISSION BRIDGE
// ============================================================================

export type RuntimeNeedState =
  | "ready"
  | "not-installed"
  | "inconsistent"
  | "unsupported"
  | "version-selection-required"
  | "requires-authorization";

export interface RuntimeRequirement {
  technology: string;
  runtimeId: string;
  version?: string;
  reason: string;
  confidence: DetectionConfidence;
  evidence: string;
  detectedFrom: string;
  state: RuntimeNeedState;
  requestedVersion?: string;
  descriptor?: RuntimeDescriptor;
  issue?: string;
}

export interface RuntimePermissionCardData {
  requestId: string;
  runtimeId: string;
  technology: string;
  version: string;
  reason: string;
  officialOrigin: string;
  downloadUrl: string;
  expectedSizeBytes?: number;
  expectedSha256: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
}

export type RuntimeLifecycleEventType =
  | "detected"
  | "requirement-evaluated"
  | "permission-requested"
  | "permission-granted"
  | "permission-denied"
  | "downloading"
  | "installing"
  | "installed"
  | "failed"
  | "rolled-back";

export interface RuntimeLifecycleEvent {
  type: RuntimeLifecycleEventType;
  runtimeId: string;
  version?: string;
  timestamp: string;
  details?: Record<string, unknown>;
  error?: string;
}


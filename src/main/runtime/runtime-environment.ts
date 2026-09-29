// src/main/runtime/runtime-environment.ts
// Construção e resolução isolada de ambiente de execução (PATH, executáveis, env) para runtimes instalados.

import fsSync from "node:fs";
import path from "node:path";
import {
  RuntimeDescriptor,
} from "./runtime-types";
import {
  resolvePackageManagerExecutablePath,
  getKnownPackageManagerDirectories,
} from "../preview-package-manager";

export type EnvironmentResolutionStatus =
  | "ready"
  | "not-installed"
  | "inconsistent"
  | "executable-missing"
  | "unsupported"
  | "invalid-distribution";

export interface ResolveEnvironmentOptions {
  basePath?: string;
  baseEnv?: Record<string, string | undefined>;
  validateExecutables?: boolean;
}

export interface BuildPreviewEnvironmentOptions {
  packageManager?: string;
  projectPath?: string;
  baseEnv?: Record<string, string | undefined>;
  basePath?: string;
  extraBinDirs?: string[];
  extraDescriptors?: RuntimeDescriptor[];
}

export interface ResolvedRuntimeEnvironment {
  status: EnvironmentResolutionStatus;
  runtimeId?: string;
  version?: string;
  installDir?: string;
  binDirs?: string[];
  pathEntries?: string[];
  effectivePath?: string;
  environmentVariables?: Record<string, string>;
  env?: Record<string, string | undefined>;
  executables?: Record<string, string>;
  error?: string;
}

export class RuntimeEnvironmentBuilder {
  /**
   * Constrói um ambiente de execução isolado a partir de um RuntimeDescriptor registrado.
   * Valida a existência física da instalação e dos executáveis declarados sem sofrer mutação global.
   */
  public static buildEnvironment(
    descriptor: RuntimeDescriptor,
    options: ResolveEnvironmentOptions = {}
  ): ResolvedRuntimeEnvironment {
    if (!descriptor || !descriptor.id || !descriptor.installDir) {
      return {
        status: "invalid-distribution",
        error: "INVALID_DESCRIPTOR: O RuntimeDescriptor fornecido é inválido ou incompleto.",
      };
    }

    const {
      basePath = process.env.PATH || "",
      baseEnv = { ...process.env },
      validateExecutables = true,
    } = options;

    const installDir = path.resolve(descriptor.installDir);

    // 1. Validação física do diretório de instalação no disco
    try {
      if (!fsSync.existsSync(installDir) || !fsSync.statSync(installDir).isDirectory()) {
        return {
          status: "inconsistent",
          runtimeId: descriptor.id,
          version: descriptor.version,
          installDir,
          error: `INSTALL_DIR_MISSING: O diretório de instalação '${installDir}' não existe fisicamente no disco.`,
        };
      }
    } catch (err: any) {
      return {
        status: "inconsistent",
        runtimeId: descriptor.id,
        version: descriptor.version,
        installDir,
        error: `FS_ERROR: Falha ao acessar '${installDir}': ${err?.message || String(err)}`,
      };
    }

    // 2. Resolução e validação de executáveis declarados
    const resolvedExecutables: Record<string, string> = {};
    if (descriptor.executables && Array.isArray(descriptor.executables)) {
      for (const exe of descriptor.executables) {
        const exePath = path.resolve(installDir, exe.relativePath || exe.name);
        if (validateExecutables) {
          try {
            if (!fsSync.existsSync(exePath) || !fsSync.statSync(exePath).isFile()) {
              return {
                status: "executable-missing",
                runtimeId: descriptor.id,
                version: descriptor.version,
                installDir,
                error: `EXECUTABLE_MISSING: O executável declarado '${exe.name}' não foi encontrado em '${exePath}'.`,
              };
            }
          } catch (err: any) {
            return {
              status: "executable-missing",
              runtimeId: descriptor.id,
              version: descriptor.version,
              installDir,
              error: `EXECUTABLE_CHECK_FAILED: Falha ao verificar '${exePath}': ${err?.message || String(err)}`,
            };
          }
        }
        resolvedExecutables[exe.name] = exePath;
      }
    }

    // 3. Composição determinística de PATH (binDirs do runtime no topo + PATH original)
    const rawBinDirs = descriptor.binDirs && descriptor.binDirs.length > 0 ? descriptor.binDirs : ["."];
    const absoluteBinDirs = rawBinDirs.map((rel) => path.resolve(installDir, rel));

    const pathEntries: string[] = [];
    const seenPaths = new Set<string>();

    const addPathEntry = (p: string) => {
      if (!p || typeof p !== "string") return;
      const normalized = path.normalize(p.trim());
      if (!normalized) return;
      // No Windows, comparação case-insensitive de rotas para deduplicação limpa
      const compareKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      if (!seenPaths.has(compareKey)) {
        seenPaths.add(compareKey);
        pathEntries.push(normalized);
      }
    };

    // 3a. Adicionar binDirs do runtime no topo
    for (const bin of absoluteBinDirs) {
      addPathEntry(bin);
    }

    // 3b. Preservar as entradas do PATH original do processo
    const baseEntries = basePath.split(path.delimiter);
    for (const entry of baseEntries) {
      addPathEntry(entry);
    }

    const effectivePath = pathEntries.join(path.delimiter);

    // 4. Injeção isolada de variáveis de ambiente
    const mergedEnv: Record<string, string | undefined> = { ...baseEnv };
    mergedEnv.PATH = effectivePath;
    if (process.platform === "win32") {
      mergedEnv.Path = effectivePath;
    }

    const declaredEnv = descriptor.environmentVariables || {};
    for (const [k, v] of Object.entries(declaredEnv)) {
      mergedEnv[k] = v;
    }

    return {
      status: "ready",
      runtimeId: descriptor.id,
      version: descriptor.version,
      installDir,
      binDirs: absoluteBinDirs,
      pathEntries,
      effectivePath,
      environmentVariables: declaredEnv,
      env: mergedEnv,
      executables: resolvedExecutables,
    };
  }

  /**
   * Constrói um ambiente de execução isolado combinando múltiplos RuntimeDescriptors instalados.
   * Valida cada descriptor e gera um ambiente unificado de PATH e variáveis de ambiente.
   */
  public static buildCombinedEnvironment(
    descriptors: RuntimeDescriptor[],
    options: ResolveEnvironmentOptions = {}
  ): ResolvedRuntimeEnvironment {
    if (!descriptors || descriptors.length === 0) {
      const { basePath = process.env.PATH || "", baseEnv = { ...process.env } } = options;
      const merged: Record<string, string | undefined> = { ...baseEnv, PATH: basePath };
      if (process.platform === "win32") {
        merged.Path = basePath;
      }
      return {
        status: "ready",
        binDirs: [],
        pathEntries: basePath.split(path.delimiter).filter(Boolean),
        effectivePath: basePath,
        environmentVariables: {},
        env: merged,
        executables: {},
      };
    }

    const {
      basePath = process.env.PATH || "",
      baseEnv = { ...process.env },
      validateExecutables = true,
    } = options;

    const allBinDirs: string[] = [];
    const allDeclaredEnv: Record<string, string> = {};
    const allResolvedExecutables: Record<string, string> = {};
    const issues: string[] = [];

    for (const descriptor of descriptors) {
      const res = this.buildEnvironment(descriptor, { basePath, baseEnv, validateExecutables });
      if (res.status === "ready") {
        if (res.binDirs) {
          allBinDirs.push(...res.binDirs);
        }
        if (res.environmentVariables) {
          Object.assign(allDeclaredEnv, res.environmentVariables);
        }
        if (res.executables) {
          Object.assign(allResolvedExecutables, res.executables);
        }
      } else {
        issues.push(`Runtime '${descriptor.id}' ignorado (${res.status}): ${res.error || "inválido"}`);
      }
    }

    const pathEntries: string[] = [];
    const seenPaths = new Set<string>();

    const addPathEntry = (p: string) => {
      if (!p || typeof p !== "string") return;
      const normalized = path.normalize(p.trim());
      if (!normalized) return;
      const compareKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      if (!seenPaths.has(compareKey)) {
        seenPaths.add(compareKey);
        pathEntries.push(normalized);
      }
    };

    // 1. BinDirs de todos os runtimes válidos no topo
    for (const bin of allBinDirs) {
      addPathEntry(bin);
    }

    // 2. PATH original
    const baseEntries = basePath.split(path.delimiter);
    for (const entry of baseEntries) {
      addPathEntry(entry);
    }

    const effectivePath = pathEntries.join(path.delimiter);

    const mergedEnv: Record<string, string | undefined> = { ...baseEnv };
    mergedEnv.PATH = effectivePath;
    if (process.platform === "win32") {
      mergedEnv.Path = effectivePath;
    }

    for (const [k, v] of Object.entries(allDeclaredEnv)) {
      mergedEnv[k] = v;
    }

    return {
      status: issues.length === 0 ? "ready" : "inconsistent",
      binDirs: allBinDirs,
      pathEntries,
      effectivePath,
      environmentVariables: allDeclaredEnv,
      env: mergedEnv,
      executables: allResolvedExecutables,
      error: issues.length > 0 ? issues.join(" | ") : undefined,
    };
  }

  /**
   * Constrói o ambiente isolado de execução para o Preview do NekoAI.
   * Resolve o package manager solicitado (ex: Bun, pnpm, yarn, npm), localiza seus executáveis
   * e monta um dicionário de ambiente isolado com PATH robusto sem mutação global de process.env.
   */
  public static buildPreviewEnvironment(
    options: BuildPreviewEnvironmentOptions = {}
  ): ResolvedRuntimeEnvironment {
    const {
      packageManager = "npm",
      baseEnv = { ...process.env },
      basePath = options.baseEnv?.PATH || options.baseEnv?.Path || process.env.PATH || process.env.Path || "",
      extraBinDirs = [],
      extraDescriptors = [],
    } = options;

    const pmBinDirs: string[] = [];
    const resolvedExecutables: Record<string, string> = {};

    // 1. Resolver o executável específico do package manager (ex: bun, bun.exe)
    const exePath = resolvePackageManagerExecutablePath(packageManager);
    if (exePath && fsSync.existsSync(exePath)) {
      resolvedExecutables[packageManager] = exePath;
      const dir = path.dirname(exePath);
      if (!pmBinDirs.includes(dir)) {
        pmBinDirs.push(dir);
      }
    }

    // 2. Incluir diretórios conhecidos de instalação do package manager
    const knownDirs = getKnownPackageManagerDirectories(packageManager);
    for (const kd of knownDirs) {
      if (!pmBinDirs.includes(kd)) {
        pmBinDirs.push(kd);
      }
    }

    // 3. Incluir extraBinDirs fornecidos
    for (const ed of extraBinDirs) {
      if (ed && fsSync.existsSync(ed) && !pmBinDirs.includes(ed)) {
        pmBinDirs.push(ed);
      }
    }

    // 4. Se houver descriptors gerenciados adicionais (ex: Bun provisionado no RuntimeStore)
    if (extraDescriptors && extraDescriptors.length > 0) {
      for (const desc of extraDescriptors) {
        if (desc.installDir && fsSync.existsSync(desc.installDir)) {
          const raw = desc.binDirs && desc.binDirs.length > 0 ? desc.binDirs : ["."];
          for (const rel of raw) {
            const abs = path.resolve(desc.installDir, rel);
            if (fsSync.existsSync(abs) && !pmBinDirs.includes(abs)) {
              pmBinDirs.push(abs);
            }
          }
        }
      }
    }

    // 5. Compor PATH determinístico e isolado
    const pathEntries: string[] = [];
    const seenPaths = new Set<string>();

    const addPathEntry = (p: string) => {
      if (!p || typeof p !== "string") return;
      const normalized = path.normalize(p.trim());
      if (!normalized) return;
      const compareKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      if (!seenPaths.has(compareKey)) {
        seenPaths.add(compareKey);
        pathEntries.push(normalized);
      }
    };

    // Prepend package manager and runtime bin directories
    for (const bin of pmBinDirs) {
      addPathEntry(bin);
    }

    // Append original base PATH entries
    const baseEntries = basePath.split(path.delimiter);
    for (const entry of baseEntries) {
      addPathEntry(entry);
    }

    const effectivePath = pathEntries.join(path.delimiter);

    const mergedEnv: Record<string, string | undefined> = { ...baseEnv };
    mergedEnv.PATH = effectivePath;
    if (process.platform === "win32") {
      mergedEnv.Path = effectivePath;
    }

    if (packageManager.toLowerCase() === "bun" && exePath) {
      const bunDir = path.dirname(exePath);
      const bunParent = path.dirname(bunDir);
      if (!mergedEnv.BUN_INSTALL && fsSync.existsSync(bunParent)) {
        mergedEnv.BUN_INSTALL = bunParent;
      }
    }

    return {
      status: "ready",
      binDirs: pmBinDirs,
      pathEntries,
      effectivePath,
      environmentVariables: {},
      env: mergedEnv,
      executables: resolvedExecutables,
    };
  }
}

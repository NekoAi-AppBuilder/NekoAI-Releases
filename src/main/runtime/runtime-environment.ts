// src/main/runtime/runtime-environment.ts
// Construção e resolução isolada de ambiente de execução (PATH, executáveis, env) para runtimes instalados.

import fsSync from "node:fs";
import path from "node:path";
import {
  RuntimeDescriptor,
} from "./runtime-types";

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
}

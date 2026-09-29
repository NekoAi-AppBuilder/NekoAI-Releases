// src/main/preview-package-manager.ts
// Resolução e validação de disponibilidade de Package Managers para o Preview do NekoAI.

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface PackageManagerResolution {
  effectiveManager: string;
  isFallback: boolean;
  reason?: string;
}

/**
 * Retorna o nome ou caminho do executável para um determinado gerenciador de pacotes.
 */
export function packageManagerExecutable(packageManager: string): string {
  const pm = String(packageManager || "npm").toLowerCase().trim();
  if (pm === "pnpm") return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (pm === "yarn") return process.platform === "win32" ? "yarn.cmd" : "yarn";
  if (pm === "bun") return process.platform === "win32" ? "bun.exe" : "bun";
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Busca executável no PATH do sistema.
 */
export function findExecutableOnPath(name: string): string | null {
  if (!name) return null;
  if (path.isAbsolute(name) && fs.existsSync(name)) {
    return name;
  }

  if (process.platform === "win32") {
    try {
      const res = spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => Boolean(l) && fs.existsSync(l));
        if (lines.length > 0) return lines[0];
      }
    } catch {
      return null;
    }
  } else {
    try {
      const res = spawnSync("which", [name], { encoding: "utf8" });
      if (res.status === 0 && res.stdout) {
        const trimmed = res.stdout.trim();
        if (trimmed && fs.existsSync(trimmed)) return trimmed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Verifica se o executável do package manager está realmente disponível no sistema / PATH / runtimes embutidos.
 */
export function isPackageManagerAvailable(
  packageManager: string,
  customResolver?: (name: string) => string | null
): boolean {
  if (!packageManager) return false;
  const pm = String(packageManager).toLowerCase().trim();
  const resolver = customResolver || findExecutableOnPath;

  if (pm === "npm" || pm === "npm_install") {
    return Boolean(resolver("npm") || resolver("npm.cmd"));
  }

  const exeName = packageManagerExecutable(pm);
  return Boolean(resolver(pm) || (exeName && resolver(exeName)));
}

/**
 * Resolve o package manager efetivo que deve ser utilizado para instalar e executar o Preview.
 *
 * Regras:
 * 1. Se o gerenciador preferido/detectado estiver disponível -> usa ele diretamente (sem fallback).
 * 2. Se o gerenciador preferido (ex: bun, pnpm, yarn) NÃO estiver disponível, mas o npm estiver disponível -> fallback para npm.
 * 3. Se nenhum estiver disponível -> mantém o preferido (para que o erro de executável ausente seja reportado explicitamente).
 */
export function resolveEffectivePackageManager(
  detectedManager: string,
  availabilityChecker: (pm: string) => boolean = isPackageManagerAvailable
): PackageManagerResolution {
  const preferred = String(detectedManager || "npm").toLowerCase().trim();

  if (availabilityChecker(preferred)) {
    return {
      effectiveManager: preferred,
      isFallback: false
    };
  }

  // Fallback para npm quando bun, pnpm ou yarn não estiverem instalados
  if (preferred !== "npm" && availabilityChecker("npm")) {
    return {
      effectiveManager: "npm",
      isFallback: true,
      reason: `O gerenciador de pacotes '${preferred}' não está instalado no sistema. Utilizando fallback para npm.`
    };
  }

  return {
    effectiveManager: preferred,
    isFallback: false,
    reason: `Nenhum gerenciador de pacotes compatível ('${preferred}', 'npm') foi encontrado no sistema.`
  };
}

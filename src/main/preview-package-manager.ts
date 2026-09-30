// src/main/preview-package-manager.ts
// Resolução e validação robusta de disponibilidade de Package Managers para o Preview do NekoAI no Windows/POSIX.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

export interface PackageManagerResolution {
  effectiveManager: string;
  isFallback: boolean;
  reason?: string;
  executablePath?: string | null;
}

let cachedRegistryPaths: { timestamp: number; paths: string[] } | null = null;
const REGISTRY_CACHE_TTL_MS = 10_000;

/**
 * Lê de forma síncrona e segura as entradas de PATH e variáveis de ferramentas do Registro do Windows (HKCU e HKLM),
 * permitindo que ferramentas recém-instaladas (como Bun via PowerShell) sejam detectadas sem reiniciar o processo pai
 * e SEM modificar process.env globalmente.
 */
export function getWindowsRegistryPathEntries(): string[] {
  if (process.platform !== "win32") return [];

  const now = Date.now();
  if (cachedRegistryPaths && now - cachedRegistryPaths.timestamp < REGISTRY_CACHE_TTL_MS) {
    return cachedRegistryPaths.paths;
  }

  const collectedPaths: string[] = [];
  const expandWinVars = (rawStr: string): string => {
    return rawStr.replace(/%([^%]+)%/g, (_, varName) => {
      const v = process.env[varName] || process.env[varName.toUpperCase()] || process.env[varName.toLowerCase()];
      return v || `%${varName}%`;
    });
  };

  try {
    // 1. Query HKCU\Environment (User PATH & BUN_INSTALL)
    const hkcu = spawnSync("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], {
      windowsHide: true,
      encoding: "utf8"
    });
    if (hkcu.status === 0 && hkcu.stdout) {
      const match = hkcu.stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (match && match[1]) {
        const rawPaths = match[1].trim().split(";").filter(Boolean);
        for (const p of rawPaths) {
          const expanded = expandWinVars(p.trim());
          if (expanded && fs.existsSync(expanded)) collectedPaths.push(path.normalize(expanded));
        }
      }
    }

    const bunInstallQuery = spawnSync("reg.exe", ["query", "HKCU\\Environment", "/v", "BUN_INSTALL"], {
      windowsHide: true,
      encoding: "utf8"
    });
    if (bunInstallQuery.status === 0 && bunInstallQuery.stdout) {
      const match = bunInstallQuery.stdout.match(/BUN_INSTALL\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (match && match[1]) {
        const expanded = expandWinVars(match[1].trim());
        const binDir = path.join(expanded, "bin");
        if (fs.existsSync(binDir)) collectedPaths.push(path.normalize(binDir));
      }
    }
  } catch {}

  try {
    // 2. Query HKLM System PATH
    const hklm = spawnSync("reg.exe", ["query", "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "Path"], {
      windowsHide: true,
      encoding: "utf8"
    });
    if (hklm.status === 0 && hklm.stdout) {
      const match = hklm.stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (match && match[1]) {
        const rawPaths = match[1].trim().split(";").filter(Boolean);
        for (const p of rawPaths) {
          const expanded = expandWinVars(p.trim());
          if (expanded && fs.existsSync(expanded)) collectedPaths.push(path.normalize(expanded));
        }
      }
    }
  } catch {}

  const unique = Array.from(new Set(collectedPaths));
  cachedRegistryPaths = { timestamp: now, paths: unique };
  return unique;
}

/**
 * Retorna uma lista de diretórios conhecidos de instalação para package managers (Bun, pnpm, yarn, npm)
 * no Windows e POSIX.
 */
export function getKnownPackageManagerDirectories(packageManager?: string): string[] {
  const pm = String(packageManager || "").toLowerCase().trim();
  const dirs: string[] = [];
  const isWin = process.platform === "win32";
  const home = os.homedir();
  const userProfile = process.env.USERPROFILE || home;
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];

  // 1. Diretórios específicos do Bun
  if (!pm || pm === "bun") {
    if (isWin) {
      if (process.env.BUN_INSTALL) dirs.push(path.join(process.env.BUN_INSTALL, "bin"));
      if (userProfile) dirs.push(path.join(userProfile, ".bun", "bin"));
      if (localAppData) dirs.push(path.join(localAppData, ".bun", "bin"));
      if (localAppData) dirs.push(path.join(localAppData, "Microsoft", "WinGet", "Links"));
      if (userProfile) dirs.push(path.join(userProfile, "scoop", "shims"));
      dirs.push("C:\\ProgramData\\chocolatey\\bin");
      dirs.push("C:\\ProgramData\\scoop\\shims");
      if (programFiles) dirs.push(path.join(programFiles, "bun"));
      if (programFilesX86) dirs.push(path.join(programFilesX86, "bun"));
      if (appData) dirs.push(path.join(appData, "npm"));
    } else {
      if (home) dirs.push(path.join(home, ".bun", "bin"));
      if (home) dirs.push(path.join(home, ".proto", "bin"));
      if (home) dirs.push(path.join(home, ".local", "bin"));
      dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    }

    // Bun embutido no NekoAI (tools/bun)
    const baseDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    const candidateBases = [
      path.resolve(baseDir, "..", "..", "tools", "bun"),
      path.resolve(baseDir, "..", "tools", "bun"),
      path.resolve(process.cwd(), "tools", "bun"),
    ];
    if (process.resourcesPath) {
      candidateBases.push(path.join(process.resourcesPath, "tools", "bun"));
    }
    for (const b of candidateBases) {
      dirs.push(b);
      dirs.push(path.join(b, "bun-windows-x64"));
    }
  }

  // 2. Diretórios específicos do pnpm / yarn / npm
  if (!pm || pm === "pnpm" || pm === "yarn" || pm === "npm" || pm === "npm_install") {
    if (isWin) {
      if (localAppData) dirs.push(path.join(localAppData, "pnpm"));
      if (localAppData) dirs.push(path.join(localAppData, "Yarn", "bin"));
      if (appData) dirs.push(path.join(appData, "npm"));
      if (programFiles) dirs.push(path.join(programFiles, "nodejs"));
      if (programFilesX86) dirs.push(path.join(programFilesX86, "nodejs"));
      if (userProfile) dirs.push(path.join(userProfile, "AppData", "Local", "pnpm"));
      if (userProfile) dirs.push(path.join(userProfile, "AppData", "Roaming", "npm"));
      if (process.env.NVM_HOME) dirs.push(process.env.NVM_HOME);
      if (process.env.NVM_SYMLINK) dirs.push(process.env.NVM_SYMLINK);
    } else {
      if (home) dirs.push(path.join(home, ".pnpm", "bin"));
      if (home) dirs.push(path.join(home, ".yarn", "bin"));
      if (home) dirs.push(path.join(home, ".nvm", "versions", "node"));
      dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    }
  }

  // 3. Ferramentas embutidas do NekoAI (tools/node, tools/git, tools/bun, tools/python, tools/deno, tools/php)
  const baseDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  dirs.push(
    path.resolve(baseDir, "..", "..", "tools", "node"),
    path.resolve(baseDir, "..", "tools", "node"),
    path.resolve(process.cwd(), "tools", "node")
  );
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, "tools", "node"));
    dirs.push(path.join(process.resourcesPath, "tools"));
  }

  // 4. Entradas do Registro do Windows (se aplicável)
  if (isWin) {
    const regPaths = getWindowsRegistryPathEntries();
    dirs.push(...regPaths);
  }

  return Array.from(new Set(dirs.filter((d) => d && fs.existsSync(d))));
}

/**
 * Retorna o nome padrão do executável para um determinado gerenciador de pacotes.
 */
export function packageManagerExecutable(packageManager: string): string {
  const pm = String(packageManager || "npm").toLowerCase().trim();
  if (pm === "pnpm") return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (pm === "yarn") return process.platform === "win32" ? "yarn.cmd" : "yarn";
  if (pm === "bun") return process.platform === "win32" ? "bun.exe" : "bun";
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Busca executável de forma robusta no PATH do sistema, diretórios conhecidos de runtimes e registro do Windows.
 */
export function findExecutableOnPath(name: string, customDirs: string[] = []): string | null {
  if (!name) return null;
  if (path.isAbsolute(name) && fs.existsSync(name)) {
    return name;
  }

  const isWin = process.platform === "win32";
  const extensions = isWin ? [".exe", ".cmd", ".bat", ""] : [""];

  // Se já contém extensão, busca com prioridade para o nome exato
  const hasExt = isWin && /\.(exe|cmd|bat)$/i.test(name);
  const targetNames = hasExt ? [name] : extensions.map((ext) => (ext ? `${name}${ext}` : name));

  // 1. Procurar nas pastas customizadas + diretórios conhecidos de runtimes
  const knownDirs = getKnownPackageManagerDirectories(name);
  const searchDirs = Array.from(new Set([...customDirs, ...knownDirs]));

  for (const dir of searchDirs) {
    for (const tName of targetNames) {
      const candidate = path.join(dir, tName);
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) return path.normalize(candidate);
        } catch {}
      }
    }
  }

  // 2. Procurar no PATH do processo atual
  const processPathEntries = (process.env.PATH || process.env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const dir of processPathEntries) {
    for (const tName of targetNames) {
      const candidate = path.join(dir, tName);
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) return path.normalize(candidate);
        } catch {}
      }
    }
  }

  // 3. Fallback: spawnSync 'where.exe' ou 'which'
  if (isWin) {
    try {
      const res = spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => Boolean(l) && fs.existsSync(l));
        if (lines.length > 0) return path.normalize(lines[0]);
      }
    } catch {}
  } else {
    try {
      const res = spawnSync("which", [name], { encoding: "utf8" });
      if (res.status === 0 && res.stdout) {
        const trimmed = res.stdout.trim();
        if (trimmed && fs.existsSync(trimmed)) return path.normalize(trimmed);
      }
    } catch {}
  }

  return null;
}

/**
 * Resolve o caminho absoluto do executável para um gerenciador de pacotes específico.
 */
export function resolvePackageManagerExecutablePath(
  packageManager: string,
  customResolver?: (name: string) => string | null
): string | null {
  if (!packageManager) return null;
  const pm = String(packageManager).toLowerCase().trim();
  const resolver = customResolver || ((n: string) => findExecutableOnPath(n));

  if (pm === "npm" || pm === "npm_install") {
    return resolver("npm.cmd") || resolver("npm") || null;
  }

  if (pm === "bun") {
    return resolver("bun.exe") || resolver("bun") || null;
  }

  if (pm === "pnpm") {
    return resolver("pnpm.cmd") || resolver("pnpm") || null;
  }

  if (pm === "yarn") {
    return resolver("yarn.cmd") || resolver("yarn") || null;
  }

  const exeName = packageManagerExecutable(pm);
  return resolver(exeName) || resolver(pm) || null;
}

/**
 * Verifica se o executável do package manager está realmente disponível no sistema / PATH / runtimes embutidos.
 */
export function isPackageManagerAvailable(
  packageManager: string,
  customResolver?: (name: string) => string | null
): boolean {
  if (!packageManager) return false;
  return Boolean(resolvePackageManagerExecutablePath(packageManager, customResolver));
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
    const exePath = resolvePackageManagerExecutablePath(preferred);
    return {
      effectiveManager: preferred,
      isFallback: false,
      executablePath: exePath,
    };
  }

  // Fallback para npm quando bun, pnpm ou yarn não estiverem instalados
  if (preferred !== "npm" && availabilityChecker("npm")) {
    const npmPath = resolvePackageManagerExecutablePath("npm");
    return {
      effectiveManager: "npm",
      isFallback: true,
      reason: `O gerenciador de pacotes '${preferred}' não está instalado no sistema. Utilizando fallback para npm.`,
      executablePath: npmPath,
    };
  }

  return {
    effectiveManager: preferred,
    isFallback: false,
    reason: `Nenhum gerenciador de pacotes compatível ('${preferred}', 'npm') foi encontrado no sistema.`,
    executablePath: null,
  };
}

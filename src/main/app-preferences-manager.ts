// src/main/app-preferences-manager.ts
// Gerenciamento e persistência de preferências gerais do NekoAI.
// Responsável por manter configurações globais da aplicação (como lastProjectDirectory)
// no diretório de dados do usuário (userData/app-preferences.json).

import electron from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath) return "";
  let resolved = path.resolve(String(projectPath).trim());
  if (resolved.length > 3 && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.replace(/[/\\]+$/, "");
  }
  return resolved;
}

export interface AppPreferences {
  lastProjectDirectory?: string;
  [key: string]: any;
}

function getUserDataDir(): string {
  try {
    const appInstance = (electron as any)?.app || (electron as any)?.default?.app;
    if (appInstance && typeof appInstance.getPath === "function") {
      return appInstance.getPath("userData");
    }
  } catch {}
  return process.env.NEKO_USER_DATA || path.join(os.homedir(), ".nekoai");
}

/**
 * Extrai de forma segura o diretório de trabalho pai de um determinado caminho de projeto.
 * Exemplo:
 * - C:\Projetos\site-adv -> C:\Projetos
 * - D:\Desenvolvimento\Projetos\MeuProjeto -> D:\Desenvolvimento\Projetos
 * - C:\ -> C:\
 */
export function extractParentDirectory(projectPath: string): string {
  if (!projectPath || typeof projectPath !== "string") return "";
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return "";
  const parent = path.dirname(normalized);
  return normalizeProjectPath(parent);
}

/**
 * Valida de forma segura e síncrona se um diretório existe no disco e está acessível.
 * Nunca lança exceção caso a pasta tenha sido excluída, movida ou pertença a uma unidade desconectada.
 */
export function isValidDirectory(dirPath: string): boolean {
  try {
    if (!dirPath || typeof dirPath !== "string") return false;
    const resolved = path.resolve(dirPath.trim());
    const stat = fsSync.statSync(resolved);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export class AppPreferencesManager {
  private customStoragePath: string | null = null;
  private cache: AppPreferences | null = null;

  constructor(customStoragePath?: string) {
    if (customStoragePath) {
      this.customStoragePath = customStoragePath;
    }
  }

  public getStorageFilePath(): string {
    if (this.customStoragePath) return this.customStoragePath;
    return path.join(getUserDataDir(), "app-preferences.json");
  }

  public async getPreferences(): Promise<AppPreferences> {
    if (this.cache) {
      return { ...this.cache };
    }

    const filePath = this.getStorageFilePath();
    try {
      if (!fsSync.existsSync(filePath)) {
        this.cache = {};
        return {};
      }
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.cache = parsed;
        return { ...parsed };
      }
      this.cache = {};
      return {};
    } catch {
      this.cache = {};
      return {};
    }
  }

  public async savePreferences(prefs: AppPreferences): Promise<void> {
    this.cache = { ...prefs };
    const filePath = this.getStorageFilePath();
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const payload = JSON.stringify(prefs, null, 2);
      await fs.writeFile(filePath, payload, "utf8");
    } catch (err) {
      console.warn("[Neko/Preferences] Erro ao persistir preferências:", err);
    }
  }

  /**
   * Obtém a última pasta de projetos utilizada.
   * Se validateDisk for true (padrão), só retorna o caminho caso ele ainda exista e seja um diretório no disco.
   * Caso contrário, retorna null para permitir fallback limpo para o comportamento padrão do sistema.
   */
  public async getLastProjectDirectory(validateDisk = true): Promise<string | null> {
    const prefs = await this.getPreferences();
    const dir = typeof prefs.lastProjectDirectory === "string" ? prefs.lastProjectDirectory.trim() : "";
    if (!dir) return null;
    const normalized = normalizeProjectPath(dir);
    if (!normalized) return null;

    if (validateDisk) {
      if (!isValidDirectory(normalized)) {
        return null;
      }
    }
    return normalized;
  }

  /**
   * Salva explicitamente um diretório como lastProjectDirectory.
   */
  public async setLastProjectDirectory(directoryPath: string): Promise<void> {
    if (!directoryPath || typeof directoryPath !== "string") return;
    const normalized = normalizeProjectPath(directoryPath);
    if (!normalized) return;

    const prefs = await this.getPreferences();
    prefs.lastProjectDirectory = normalized;
    await this.savePreferences(prefs);
  }

  /**
   * Extrai a pasta pai a partir do caminho de um projeto aberto/criado com sucesso
   * e a salva como lastProjectDirectory.
   * Exemplo: C:\Projetos\site-adv -> salva C:\Projetos.
   */
  public async saveLastProjectDirectoryFromProjectPath(projectPath: string): Promise<string | null> {
    const parentDir = extractParentDirectory(projectPath);
    if (!parentDir) return null;
    if (!isValidDirectory(parentDir)) return null;

    await this.setLastProjectDirectory(parentDir);
    return parentDir;
  }

  /**
   * Limpa o cache em memória (usado para simular reinicialização do aplicativo em testes).
   */
  public clearCache(): void {
    this.cache = null;
  }
}

export const appPreferencesManager = new AppPreferencesManager();

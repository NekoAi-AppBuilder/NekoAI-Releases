// src/main/runtime/runtime-store.ts
// Armazenamento, persistência e consulta do manifesto de runtimes no NekoAI.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import electron from "electron";
import {
  RuntimeDescriptor,
  RuntimeManifest,
} from "./runtime-types";

export interface RuntimeStoreOptions {
  baseDir?: string; // Permitir injeção de diretório mock para testes unitários
}

export class RuntimeStore {
  private baseDir: string;
  private manifestsDir: string;
  private manifestPath: string;

  constructor(options: RuntimeStoreOptions = {}) {
    if (options.baseDir) {
      this.baseDir = path.resolve(options.baseDir);
    } else {
      this.baseDir = path.join(this.getDefaultUserDataDir(), "runtimes");
    }
    this.manifestsDir = path.join(this.baseDir, "manifests");
    this.manifestPath = path.join(this.manifestsDir, "installed-runtimes.json");
  }

  private getDefaultUserDataDir(): string {
    try {
      const appInstance = (electron as any)?.app || (electron as any)?.default?.app;
      if (appInstance && typeof appInstance.getPath === "function") {
        return appInstance.getPath("userData");
      }
    } catch {}
    return process.env.NEKO_USER_DATA || path.join(os.homedir(), ".nekoai");
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public getManifestPath(): string {
    return this.manifestPath;
  }

  /**
   * Carrega o manifesto de runtimes instalados.
   * Se não existir ou estiver corrompido, inicializa um novo manifesto limpo.
   */
  public async loadManifest(): Promise<RuntimeManifest> {
    try {
      if (!fsSync.existsSync(this.manifestPath)) {
        return this.createEmptyManifest();
      }
      const raw = await fs.readFile(this.manifestPath, "utf8");
      const parsed = JSON.parse(raw) as RuntimeManifest;
      if (!parsed || typeof parsed !== "object" || !parsed.runtimes) {
        console.warn("[RuntimeStore] Manifesto corrompido detectado. Reinicializando.");
        return this.createEmptyManifest();
      }
      return parsed;
    } catch (err) {
      console.warn("[RuntimeStore] Erro ao carregar manifesto:", err);
      return this.createEmptyManifest();
    }
  }

  /**
   * Grava o manifesto de forma atômica utilizando arquivo temporário e rename.
   */
  public async saveManifest(manifest: RuntimeManifest): Promise<void> {
    await fs.mkdir(this.manifestsDir, { recursive: true });

    manifest.updatedAt = new Date().toISOString();
    const tempPath = `${this.manifestPath}.tmp`;
    const jsonContent = JSON.stringify(manifest, null, 2);

    await fs.writeFile(tempPath, jsonContent, "utf8");
    await fs.rename(tempPath, this.manifestPath);
  }

  private createEmptyManifest(): RuntimeManifest {
    return {
      version: "1.0",
      updatedAt: new Date().toISOString(),
      runtimes: {},
    };
  }

  /**
   * Retorna a lista de todos os runtimes registrados no manifesto.
   */
  public async listRuntimes(): Promise<RuntimeDescriptor[]> {
    const manifest = await this.loadManifest();
    return Object.values(manifest.runtimes);
  }

  /**
   * Retorna um runtime registrado pelo seu ID único (ex: "python-3.12.7").
   */
  public async getRuntime(id: string): Promise<RuntimeDescriptor | null> {
    const manifest = await this.loadManifest();
    return manifest.runtimes[id] || null;
  }

  /**
   * Busca runtimes registrados por nome (ex: "Python", "Bun", "PHP").
   */
  public async findRuntimesByName(name: string): Promise<RuntimeDescriptor[]> {
    const list = await this.listRuntimes();
    const searchName = name.toLowerCase().trim();
    return list.filter(
      (r) => r.name.toLowerCase() === searchName || r.id.toLowerCase().startsWith(searchName)
    );
  }

  /**
   * Registra ou atualiza um RuntimeDescriptor no manifesto.
   */
  public async registerRuntime(descriptor: RuntimeDescriptor): Promise<void> {
    if (!descriptor.id) {
      throw new Error("RuntimeDescriptor precisa de um 'id' válido.");
    }
    const manifest = await this.loadManifest();
    manifest.runtimes[descriptor.id] = { ...descriptor };
    await this.saveManifest(manifest);
  }

  /**
   * Remove um runtime do manifesto pelo ID.
   */
  public async unregisterRuntime(id: string): Promise<boolean> {
    const manifest = await this.loadManifest();
    if (!manifest.runtimes[id]) {
      return false;
    }
    delete manifest.runtimes[id];
    await this.saveManifest(manifest);
    return true;
  }

  /**
   * Verifica a existência física do diretório de instalação do runtime no disco.
   */
  public verifyPhysicalExistence(descriptor: RuntimeDescriptor): boolean {
    if (!descriptor || !descriptor.installDir) return false;
    try {
      if (!fsSync.existsSync(descriptor.installDir)) return false;
      const stat = fsSync.statSync(descriptor.installDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Detecta registros no manifesto cujos arquivos físicos não existem mais no disco.
   */
  public async detectInconsistentRegistrations(): Promise<RuntimeDescriptor[]> {
    const list = await this.listRuntimes();
    return list.filter((r) => !this.verifyPhysicalExistence(r));
  }
}

import { app, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import { SupabaseIntegration, SupabaseVault } from "./supabase-types";

export const projectKey = (projectPath: string): string =>
  crypto.createHash("sha256").update(projectPath.toLowerCase()).digest("hex");

export class SupabaseVaultManager {
  private vault: SupabaseVault | null = null;
  private customVaultPath?: string;

  constructor(customVaultPath?: string) {
    this.customVaultPath = customVaultPath;
  }

  private getVaultPath(): string {
    if (this.customVaultPath) return this.customVaultPath;
    try {
      return path.join(app.getPath("userData"), "supabase-vault.json");
    } catch {
      return path.join(process.cwd(), "supabase-vault.json");
    }
  }

  public async loadVault(): Promise<SupabaseVault> {
    if (this.vault) return this.vault;
    const vaultPath = this.getVaultPath();
    try {
      if (!fsSync.existsSync(vaultPath)) {
        this.vault = { version: 2, integrations: {} };
        return this.vault;
      }
      const raw = await fs.readFile(vaultPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.encrypted) {
        if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable()) {
          const decrypted = safeStorage.decryptString(Buffer.from(parsed.encrypted, "base64"));
          const data = JSON.parse(decrypted);
          this.vault = { version: 2, integrations: data.integrations || {} };
          return this.vault;
        } else {
          console.warn("[Neko/Supabase] safeStorage indisponível para descriptografar cofre.");
          this.vault = { version: 2, integrations: {} };
          return this.vault;
        }
      } else if (parsed?.integrations) {
        this.vault = { version: 2, integrations: parsed.integrations || {} };
        return this.vault;
      }
      this.vault = { version: 2, integrations: {} };
      return this.vault;
    } catch (error) {
      console.warn("[Neko/Supabase] Erro ao ler cofre local, recriando:", error);
      this.vault = { version: 2, integrations: {} };
      return this.vault;
    }
  }

  public async saveVault(vault: SupabaseVault): Promise<void> {
    this.vault = vault;
    const vaultPath = this.getVaultPath();
    const dataString = JSON.stringify(vault);
    let toWrite: string;
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = safeStorage.encryptString(dataString).toString("base64");
        toWrite = JSON.stringify({ encrypted }, null, 2);
      } catch {
        toWrite = dataString;
      }
    } else {
      toWrite = dataString;
    }
    const tempPath = `${vaultPath}.tmp`;
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(tempPath, toWrite, "utf8");
    await fs.rename(tempPath, vaultPath);
  }

  public async getIntegration(projectPath: string): Promise<SupabaseIntegration | null> {
    const vault = await this.loadVault();
    const key = projectKey(projectPath);
    return vault.integrations[key] || null;
  }

  public async saveIntegration(projectPath: string, integration: SupabaseIntegration): Promise<void> {
    const vault = await this.loadVault();
    const key = projectKey(projectPath);
    const nextVault: SupabaseVault = {
      version: 2,
      integrations: {
        ...vault.integrations,
        [key]: integration,
      },
    };
    await this.saveVault(nextVault);
  }

  public async removeIntegration(projectPath: string): Promise<void> {
    const vault = await this.loadVault();
    const key = projectKey(projectPath);
    const integrations = { ...vault.integrations };
    delete integrations[key];
    await this.saveVault({ version: 2, integrations });
  }

  public async isProjectUsedElsewhere(projectPath: string, projectRef: string): Promise<boolean> {
    const vault = await this.loadVault();
    const currentKey = projectKey(projectPath);
    return Object.entries(vault.integrations).some(
      ([k, item]) => k !== currentKey && item.projectRef === projectRef
    );
  }
}

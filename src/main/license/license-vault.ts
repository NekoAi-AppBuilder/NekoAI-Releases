// src/main/license/license-vault.ts
// Cofre local criptografado com Electron safeStorage para o Grant de Licença

import { app, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { StoredLicenseVault } from "./license-types";

export class LicenseVault {
  private cachedVault: StoredLicenseVault | null = null;

  private getVaultPath(): string {
    return path.join(app.getPath("userData"), "neko-license.json");
  }

  public async loadVault(): Promise<StoredLicenseVault | null> {
    if (this.cachedVault) return this.cachedVault;

    const vaultPath = this.getVaultPath();
    try {
      if (!fsSync.existsSync(vaultPath)) {
        return null;
      }

      const raw = await fs.readFile(vaultPath, "utf8");
      const parsed = JSON.parse(raw);

      if (parsed?.encrypted) {
        if (safeStorage.isEncryptionAvailable()) {
          const decrypted = safeStorage.decryptString(Buffer.from(parsed.encrypted, "base64"));
          const data: StoredLicenseVault = JSON.parse(decrypted);
          this.cachedVault = data;
          return this.cachedVault;
        } else {
          console.warn("[Neko/License] safeStorage indisponível para descriptografar a licença.");
          return null;
        }
      } else if (parsed?.grant) {
        // Fallback para ambiente sem criptografia nativa
        this.cachedVault = parsed;
        return this.cachedVault;
      }
      return null;
    } catch (err) {
      console.warn("[Neko/License] Erro ao ler neko-license.json:", err);
      return null;
    }
  }

  public async saveGrant(grant: string, keyMask?: string): Promise<void> {
    const vaultPath = this.getVaultPath();
    const existing = await this.loadVault();
    const vaultData: StoredLicenseVault = {
      version: 1,
      grant,
      keyMask: keyMask || existing?.keyMask,
      lastCheckedAt: new Date().toISOString(),
    };

    this.cachedVault = vaultData;
    const dataString = JSON.stringify(vaultData);
    let toWrite: string;

    if (safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = safeStorage.encryptString(dataString).toString("base64");
        toWrite = JSON.stringify({ version: 1, encrypted }, null, 2);
      } catch (encErr) {
        console.warn("[Neko/License] Falha ao criptografar grant com safeStorage, usando JSON plano:", encErr);
        toWrite = dataString;
      }
    } else {
      toWrite = dataString;
    }

    const tmpPath = `${vaultPath}.tmp`;
    await fs.writeFile(tmpPath, toWrite, "utf8");
    await fs.rename(tmpPath, vaultPath);
  }

  public async clearGrant(): Promise<void> {
    this.cachedVault = null;
    const vaultPath = this.getVaultPath();
    const tmpPath = `${vaultPath}.tmp`;

    try {
      if (fsSync.existsSync(tmpPath)) await fs.unlink(tmpPath);
      if (fsSync.existsSync(vaultPath)) await fs.unlink(vaultPath);
    } catch (err) {
      console.warn("[Neko/License] Erro ao remover arquivos da licença:", err);
    }
  }
}

export const licenseVault = new LicenseVault();

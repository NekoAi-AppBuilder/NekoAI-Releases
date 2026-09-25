import { app, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import { LovableProjectLink, LovableVault, LOVABLE_PROJECT_ID_REGEX } from "./lovable-types";

export function normalizeVaultProjectPath(projectPath: string): string {
  if (!projectPath) return "";
  let resolved = path.resolve(String(projectPath).trim());
  if (resolved.length > 3 && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.replace(/[/\\]+$/, "");
  }
  return resolved.toLowerCase();
}

export const projectKey = (projectPath: string): string =>
  crypto.createHash("sha256").update(normalizeVaultProjectPath(projectPath)).digest("hex");

export class LovableVaultManager {
  private vault: LovableVault | null = null;
  private customVaultPath?: string;

  constructor(customVaultPath?: string) {
    this.customVaultPath = customVaultPath;
  }

  private getVaultPath(): string {
    if (this.customVaultPath) return this.customVaultPath;
    try {
      return path.join(app.getPath("userData"), "lovable-vault.json");
    } catch {
      return path.join(process.cwd(), "lovable-vault.json");
    }
  }

  public async loadVault(): Promise<LovableVault> {
    if (this.vault) return this.vault;
    const vaultPath = this.getVaultPath();
    try {
      if (!fsSync.existsSync(vaultPath)) {
        this.vault = { version: 1, links: {} };
        return this.vault;
      }
      const raw = await fs.readFile(vaultPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.encrypted) {
        if (
          safeStorage &&
          typeof safeStorage.isEncryptionAvailable === "function" &&
          safeStorage.isEncryptionAvailable()
        ) {
          const decrypted = safeStorage.decryptString(Buffer.from(parsed.encrypted, "base64"));
          const data = JSON.parse(decrypted);
          this.vault = { version: 1, links: data.links || {} };
          return this.vault;
        } else {
          console.warn("[Neko/Lovable] safeStorage indisponível para descriptografar cofre Lovable.");
          this.vault = { version: 1, links: {} };
          return this.vault;
        }
      } else if (parsed?.links) {
        this.vault = { version: 1, links: parsed.links || {} };
        return this.vault;
      }
      this.vault = { version: 1, links: {} };
      return this.vault;
    } catch (error) {
      console.warn("[Neko/Lovable] Erro ao ler cofre local Lovable, recriando:", error);
      this.vault = { version: 1, links: {} };
      return this.vault;
    }
  }

  public async saveVault(vault: LovableVault): Promise<void> {
    this.vault = vault;
    const vaultPath = this.getVaultPath();
    const dataString = JSON.stringify(vault);
    let toWrite: string;

    if (
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === "function" &&
      safeStorage.isEncryptionAvailable()
    ) {
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

  public async getLink(projectPath: string): Promise<LovableProjectLink | null> {
    const vault = await this.loadVault();
    const key = projectKey(projectPath);
    return vault.links[key] || null;
  }

  public async saveLink(projectPath: string, link: LovableProjectLink): Promise<void> {
    if (!link.projectId || !LOVABLE_PROJECT_ID_REGEX.test(link.projectId)) {
      throw new Error(`ProjectId Lovable inválido: ${link.projectId}`);
    }

    const vault = await this.loadVault();
    const key = projectKey(projectPath);

    // Salvar ESTRITAMENTE campos públicos. NUNCA tokens ou senhas!
    const sanitizedLink: LovableProjectLink = {
      projectId: link.projectId,
      projectPath: link.projectPath || projectPath,
      connectedAt: link.connectedAt || Date.now(),
      hasLovableCloud: link.hasLovableCloud !== undefined ? link.hasLovableCloud : null,
      explicitlyDisconnected: link.explicitlyDisconnected === true ? true : undefined,
    };

    const nextVault: LovableVault = {
      version: 1,
      links: {
        ...vault.links,
        [key]: sanitizedLink,
      },
    };
    await this.saveVault(nextVault);
  }

  public async removeLink(projectPath: string): Promise<void> {
    const vault = await this.loadVault();
    const key = projectKey(projectPath);
    const links = { ...vault.links };
    delete links[key];
    await this.saveVault({ version: 1, links });
  }

  public async getAllLinkedProjects(): Promise<LovableProjectLink[]> {
    const vault = await this.loadVault();
    return Object.values(vault.links);
  }
}

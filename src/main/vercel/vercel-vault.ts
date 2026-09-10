import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import { VercelProjectDeployment } from "./vercel-types";

export const vercelProjectKey = (projectPath: string): string =>
  crypto.createHash("sha256").update(path.resolve(projectPath).toLowerCase()).digest("hex");

interface VercelVaultData {
  version: number;
  deployments: Record<string, VercelProjectDeployment>;
}

export class VercelVaultManager {
  private data: VercelVaultData | null = null;

  private getVaultPath(): string {
    return path.join(app.getPath("userData"), "vercel-deployments.json");
  }

  public async loadVault(): Promise<VercelVaultData> {
    if (this.data) return this.data;
    const filePath = this.getVaultPath();
    try {
      if (!fsSync.existsSync(filePath)) {
        this.data = { version: 1, deployments: {} };
        return this.data;
      }
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.deployments && typeof parsed.deployments === "object") {
        this.data = { version: 1, deployments: parsed.deployments };
        return this.data;
      }
      this.data = { version: 1, deployments: {} };
      return this.data;
    } catch (error) {
      console.warn("[Neko/Vercel] Erro ao ler histórico de deploys da Vercel:", error);
      this.data = { version: 1, deployments: {} };
      return this.data;
    }
  }

  public async saveDeployment(projectPath: string, deploymentUrl: string, projectName?: string): Promise<void> {
    const vault = await this.loadVault();
    const key = vercelProjectKey(projectPath);
    vault.deployments[key] = {
      projectPath,
      projectName: projectName || vault.deployments[key]?.projectName,
      deploymentUrl,
      updatedAt: new Date().toISOString(),
    };
    try {
      const filePath = this.getVaultPath();
      await fs.writeFile(filePath, JSON.stringify(vault, null, 2), "utf8");
    } catch (error) {
      console.warn("[Neko/Vercel] Falha ao persistir histórico de deploy:", error);
    }
  }

  public async getDeploymentUrl(projectPath: string): Promise<string | null> {
    const vault = await this.loadVault();
    const key = vercelProjectKey(projectPath);
    return vault.deployments[key]?.deploymentUrl ?? null;
  }

  public async getProjectName(projectPath: string): Promise<string | null> {
    const vault = await this.loadVault();
    const key = vercelProjectKey(projectPath);
    return vault.deployments[key]?.projectName ?? null;
  }
}

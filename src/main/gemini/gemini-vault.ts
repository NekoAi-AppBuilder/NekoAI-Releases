// src/main/gemini/gemini-vault.ts
// Cofre local criptografado com Electron safeStorage para Chave Própria da API Google Gemini

import { app, safeStorage as electronSafeStorage } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

export interface StoredGeminiVault {
  version: number;
  encrypted: string;
  updatedAt: string;
}

export interface GeminiKeyStatus {
  configured: boolean;
  mask?: string;
  updatedAt?: string;
}

export interface SafeStorageInterface {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class GeminiVault {
  private customVaultPath?: string;
  private safeStorageImpl: SafeStorageInterface;
  private cachedKey: string | null = null;
  private cachedStatus: GeminiKeyStatus | null = null;

  constructor(customVaultPath?: string, customSafeStorage?: SafeStorageInterface) {
    this.customVaultPath = customVaultPath;
    this.safeStorageImpl = customSafeStorage || electronSafeStorage;
  }

  private getVaultPath(): string {
    if (this.customVaultPath) return this.customVaultPath;
    try {
      return path.join(app.getPath("userData"), "neko-gemini-key.json");
    } catch {
      return path.join(process.cwd(), "neko-gemini-key.json");
    }
  }

  private createMask(key: string): string {
    const trimmed = key.trim();
    if (trimmed.length <= 8) {
      return "••••••••";
    }
    const prefix = trimmed.slice(0, 4);
    const suffix = trimmed.slice(-4);
    return `${prefix}••••${suffix}`;
  }

  public async loadVault(): Promise<string | null> {
    if (this.cachedKey !== null) {
      return this.cachedKey;
    }

    const vaultPath = this.getVaultPath();
    try {
      if (!fsSync.existsSync(vaultPath)) {
        this.cachedKey = null;
        this.cachedStatus = { configured: false };
        return null;
      }

      const raw = await fs.readFile(vaultPath, "utf8");
      const parsed = JSON.parse(raw);

      if (!parsed?.encrypted || parsed.version !== 1) {
        console.warn("[Neko/GeminiVault] Formato de arquivo de chave Gemini inválido ou incompatível.");
        this.cachedKey = null;
        this.cachedStatus = { configured: false };
        return null;
      }

      if (!this.safeStorageImpl || typeof this.safeStorageImpl.isEncryptionAvailable !== "function" || !this.safeStorageImpl.isEncryptionAvailable()) {
        console.warn("[Neko/GeminiVault] safeStorage indisponível para descriptografar chave Gemini.");
        this.cachedKey = null;
        this.cachedStatus = { configured: false };
        return null;
      }

      const decrypted = this.safeStorageImpl.decryptString(Buffer.from(parsed.encrypted, "base64")).trim();
      if (!decrypted) {
        this.cachedKey = null;
        this.cachedStatus = { configured: false };
        return null;
      }

      this.cachedKey = decrypted;
      this.cachedStatus = {
        configured: true,
        mask: this.createMask(decrypted),
        updatedAt: parsed.updatedAt,
      };
      return this.cachedKey;
    } catch (err) {
      console.warn("[Neko/GeminiVault] Erro ao ler ou descriptografar neko-gemini-key.json:", err);
      this.cachedKey = null;
      this.cachedStatus = { configured: false };
      return null;
    }
  }

  /**
   * Recupera a chave descriptografada EXCLUSIVAMENTE para consumo interno no Main process.
   * NUNCA expor este retorno ao Renderer.
   */
  public async getKey(): Promise<string | null> {
    return this.loadVault();
  }

  /**
   * Retorna o status de configuração da chave sem revelar a credencial.
   * Seguro para envio via IPC para o Renderer.
   */
  public async getKeyStatus(): Promise<GeminiKeyStatus> {
    const key = await this.getKey();
    if (!key) {
      return { configured: false };
    }
    return (
      this.cachedStatus || {
        configured: true,
        mask: this.createMask(key),
      }
    );
  }

  public async hasKey(): Promise<boolean> {
    const status = await this.getKeyStatus();
    return status.configured;
  }

  /**
   * Salva a chave fornecida pelo usuário.
   * Se safeStorage não estiver disponível, recusa salvar e reporta erro para o usuário.
   * Jamais salva em texto plano.
   */
  public async saveKey(rawKey: string): Promise<{ success: boolean; error?: string }> {
    const trimmed = (rawKey || "").trim();
    if (!trimmed) {
      return { success: false, error: "A chave da API do Google Gemini não pode estar vazia." };
    }

    if (!this.safeStorageImpl || typeof this.safeStorageImpl.isEncryptionAvailable !== "function" || !this.safeStorageImpl.isEncryptionAvailable()) {
      return {
        success: false,
        error: "O armazenamento criptográfico seguro não está disponível neste dispositivo. A chave não pode ser salva em texto puro.",
      };
    }

    const vaultPath = this.getVaultPath();
    const updatedAt = new Date().toISOString();

    try {
      const encrypted = this.safeStorageImpl.encryptString(trimmed).toString("base64");
      const vaultData: StoredGeminiVault = {
        version: 1,
        encrypted,
        updatedAt,
      };

      const dataString = JSON.stringify(vaultData, null, 2);
      const tmpPath = `${vaultPath}.tmp`;

      await fs.mkdir(path.dirname(vaultPath), { recursive: true });
      await fs.writeFile(tmpPath, dataString, "utf8");
      await fs.rename(tmpPath, vaultPath);

      this.cachedKey = trimmed;
      this.cachedStatus = {
        configured: true,
        mask: this.createMask(trimmed),
        updatedAt,
      };

      return { success: true };
    } catch (err: any) {
      console.error("[Neko/GeminiVault] Falha ao criptografar ou gravar chave Gemini:", err);
      return {
        success: false,
        error: "Não foi possível armazenar a chave com segurança neste dispositivo.",
      };
    }
  }

  /**
   * Remove completamente o arquivo da chave e limpa o cache em memória.
   */
  public async deleteKey(): Promise<void> {
    this.cachedKey = null;
    this.cachedStatus = { configured: false };

    const vaultPath = this.getVaultPath();
    const tmpPath = `${vaultPath}.tmp`;

    try {
      if (fsSync.existsSync(tmpPath)) await fs.unlink(tmpPath);
      if (fsSync.existsSync(vaultPath)) await fs.unlink(vaultPath);
    } catch (err) {
      console.warn("[Neko/GeminiVault] Erro ao excluir arquivos de chave Gemini:", err);
    }
  }

  public clearCache(): void {
    this.cachedKey = null;
    this.cachedStatus = null;
  }
}

export const geminiVault = new GeminiVault();

// src/main/chatgpt/chatgpt-vault.ts
// Cofre local criptografado com Electron safeStorage para tokens da conta pessoal ChatGPT

import { app, safeStorage as electronSafeStorage } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { ChatGptAccountData, StoredChatGptVault } from "./chatgpt-types";

export interface SafeStorageInterface {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class ChatGptVault {
  private customVaultPath?: string;
  private safeStorageImpl: SafeStorageInterface;
  private cachedAccount: ChatGptAccountData | null = null;

  constructor(customVaultPath?: string, customSafeStorage?: SafeStorageInterface) {
    this.customVaultPath = customVaultPath;
    this.safeStorageImpl = customSafeStorage || electronSafeStorage;
  }

  private getVaultPath(): string {
    if (this.customVaultPath) return this.customVaultPath;
    try {
      return path.join(app.getPath("userData"), "neko-chatgpt-vault.json");
    } catch {
      return path.join(process.cwd(), "neko-chatgpt-vault.json");
    }
  }

  /**
   * Carrega os dados da conta salvos de forma criptografada.
   */
  public async loadAccount(): Promise<ChatGptAccountData | null> {
    if (this.cachedAccount !== null) {
      return this.cachedAccount;
    }

    const vaultPath = this.getVaultPath();
    try {
      if (!fsSync.existsSync(vaultPath)) {
        this.cachedAccount = null;
        return null;
      }

      const raw = await fs.readFile(vaultPath, "utf8");
      const parsed: StoredChatGptVault = JSON.parse(raw);

      if (!parsed?.encrypted || parsed.version !== 1) {
        console.warn("[Neko/ChatGptVault] Formato de arquivo do cofre ChatGPT inválido.");
        this.cachedAccount = null;
        return null;
      }

      if (
        !this.safeStorageImpl ||
        typeof this.safeStorageImpl.isEncryptionAvailable !== "function" ||
        !this.safeStorageImpl.isEncryptionAvailable()
      ) {
        console.warn("[Neko/ChatGptVault] safeStorage indisponível para descriptografar cofre ChatGPT.");
        this.cachedAccount = null;
        return null;
      }

      const decrypted = this.safeStorageImpl
        .decryptString(Buffer.from(parsed.encrypted, "base64"))
        .trim();

      if (!decrypted) {
        this.cachedAccount = null;
        return null;
      }

      const accountData: ChatGptAccountData = JSON.parse(decrypted);
      this.cachedAccount = accountData;
      return this.cachedAccount;
    } catch (err: any) {
      console.error("[Neko/ChatGptVault] Erro ao carregar cofre ChatGPT:", err?.message || err);
      this.cachedAccount = null;
      return null;
    }
  }

  /**
   * Salva os dados da conta com criptografia segura no disco.
   */
  public async saveAccount(account: ChatGptAccountData): Promise<void> {
    const vaultPath = this.getVaultPath();
    try {
      if (
        !this.safeStorageImpl ||
        typeof this.safeStorageImpl.isEncryptionAvailable !== "function" ||
        !this.safeStorageImpl.isEncryptionAvailable()
      ) {
        throw new Error("safeStorage não está disponível neste sistema.");
      }

      const serialized = JSON.stringify(account);
      const encryptedBuffer = this.safeStorageImpl.encryptString(serialized);
      const payload: StoredChatGptVault = {
        version: 1,
        encrypted: encryptedBuffer.toString("base64"),
        updatedAt: new Date().toISOString(),
      };

      const dir = path.dirname(vaultPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(vaultPath, JSON.stringify(payload, null, 2), "utf8");

      this.cachedAccount = account;
      console.log("[Neko/ChatGptVault] Conta do ChatGPT salva com sucesso.");
    } catch (err: any) {
      console.error("[Neko/ChatGptVault] Erro ao salvar cofre ChatGPT:", err?.message || err);
      throw err;
    }
  }

  /**
   * Remove o cofre e limpa os dados em memória.
   */
  public async clearAccount(): Promise<void> {
    this.cachedAccount = null;
    const vaultPath = this.getVaultPath();
    try {
      if (fsSync.existsSync(vaultPath)) {
        await fs.unlink(vaultPath);
        console.log("[Neko/ChatGptVault] Cofre do ChatGPT removido.");
      }
    } catch (err: any) {
      console.warn("[Neko/ChatGptVault] Falha ao excluir arquivo do cofre:", err?.message || err);
    }
  }

  public getCachedAccount(): ChatGptAccountData | null {
    return this.cachedAccount;
  }
}

export const chatGptVault = new ChatGptVault();

import fs from "node:fs";
import path from "node:path";
let electronApp: any = undefined;
let electronSafeStorage: any = undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require("electron");
  if (typeof electron === "object" && electron !== null) {
    electronApp = electron.app;
    electronSafeStorage = electron.safeStorage;
  }
} catch {
  // Ambiente de teste headless
}

export type GithubAccountRecord = {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  token: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  addedAt: number;
};

export type GithubAccountSummary = {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
};

export class GithubAccountManager {
  private accountsFile: string;
  private associationsFile: string;
  private legacyAuthFile: string;

  constructor(customUserDataPath?: string) {
    const userData = customUserDataPath || (electronApp?.getPath ? electronApp.getPath("userData") : process.cwd());
    this.accountsFile = path.join(userData, "github-accounts.json");
    this.associationsFile = path.join(userData, "project-github-associations.json");
    this.legacyAuthFile = path.join(userData, "github-auth.json");
  }

  private encrypt(data: any): string {
    const jsonStr = JSON.stringify(data);
    if (electronSafeStorage && typeof electronSafeStorage.isEncryptionAvailable === "function" && electronSafeStorage.isEncryptionAvailable()) {
      return electronSafeStorage.encryptString(jsonStr).toString("base64");
    }
    return Buffer.from(jsonStr, "utf8").toString("base64");
  }

  private decrypt<T>(encryptedStr: string): T | null {
    try {
      if (electronSafeStorage && typeof electronSafeStorage.isEncryptionAvailable === "function" && electronSafeStorage.isEncryptionAvailable()) {
        const decryptedStr = electronSafeStorage.decryptString(Buffer.from(encryptedStr, "base64"));
        return JSON.parse(decryptedStr);
      }
      const raw = Buffer.from(encryptedStr, "base64").toString("utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private isMigrating = false;
  public ensureMigrated(): void {
    if (this.isMigrating) return;
    if (fs.existsSync(this.accountsFile)) return;
    if (!fs.existsSync(this.legacyAuthFile)) return;

    this.isMigrating = true;
    try {
      const raw = fs.readFileSync(this.legacyAuthFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed?.encrypted) return;
      const legacyRecord = this.decrypt<{ token: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number }>(parsed.encrypted);
      if (legacyRecord?.token) {
        const legacyAccount: GithubAccountRecord = {
          id: "legacy_account",
          login: "pending_fetch",
          name: "Conta GitHub",
          avatarUrl: null,
          email: null,
          token: legacyRecord.token,
          expiresAt: legacyRecord.expiresAt,
          refreshToken: legacyRecord.refreshToken,
          refreshExpiresAt: legacyRecord.refreshExpiresAt,
          addedAt: Date.now()
        };
        this.saveAccountRecord(legacyAccount);
      }
    } catch (e) {
      console.warn("[GithubAccountManager] Erro na migração legada:", e);
    } finally {
      this.isMigrating = false;
    }
  }

  public getAccountRecords(): GithubAccountRecord[] {
    this.ensureMigrated();
    try {
      if (!fs.existsSync(this.accountsFile)) return [];
      const raw = fs.readFileSync(this.accountsFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed?.encrypted) return [];
      const records = this.decrypt<GithubAccountRecord[]>(parsed.encrypted);
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  public getAccountById(id: string): GithubAccountRecord | null {
    if (!id) return null;
    const records = this.getAccountRecords();
    return records.find(r => r.id === id || r.login.toLowerCase() === id.toLowerCase()) || null;
  }

  public saveAccountRecord(record: GithubAccountRecord): void {
    const records = this.getAccountRecords();
    const index = records.findIndex(r =>
      r.id === record.id ||
      (r.login && record.login && r.login !== "pending_fetch" && r.login.toLowerCase() === record.login.toLowerCase()) ||
      (r.token && record.token && r.token === record.token)
    );
    if (index >= 0) {
      records[index] = { ...records[index], ...record };
    } else {
      records.push(record);
    }
    const encrypted = this.encrypt(records);
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    fs.writeFileSync(this.accountsFile, JSON.stringify({ encrypted }, null, 2), "utf8");
  }

  public removeAccountRecord(accountId: string): void {
    if (!accountId) return;
    const records = this.getAccountRecords().filter(r => r.id !== accountId && r.login.toLowerCase() !== accountId.toLowerCase());
    const encrypted = this.encrypt(records);
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    fs.writeFileSync(this.accountsFile, JSON.stringify({ encrypted }, null, 2), "utf8");
    if (records.length === 0) {
      try { fs.rmSync(this.legacyAuthFile, { force: true }); } catch {}
    }
  }

  public getAccountsSummary(): GithubAccountSummary[] {
    return this.getAccountRecords().map(r => ({
      id: r.id,
      login: r.login,
      name: r.name,
      avatarUrl: r.avatarUrl,
      email: r.email
    }));
  }

  private getAssociationsMap(): Record<string, string> {
    try {
      if (!fs.existsSync(this.associationsFile)) return {};
      const raw = fs.readFileSync(this.associationsFile, "utf8");
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  public setProjectAssociation(projectKey: string, accountId: string): void {
    if (!projectKey) return;
    const map = this.getAssociationsMap();
    map[projectKey.toLowerCase()] = accountId;
    fs.mkdirSync(path.dirname(this.associationsFile), { recursive: true });
    fs.writeFileSync(this.associationsFile, JSON.stringify(map, null, 2), "utf8");
  }

  public getProjectAssociation(projectKey: string): string | null {
    if (!projectKey) return null;
    const map = this.getAssociationsMap();
    return map[projectKey.toLowerCase()] || null;
  }
}

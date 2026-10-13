// src/main/chatgpt/chatgpt-manager.ts
// Gerenciador central do ciclo de vida da integração com o ChatGPT Pessoal no NekoAI Desktop

import { shell } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
  CHATGPT_PROVIDER_ID,
  CHATGPT_PROVIDER_NAME,
  CHATGPT_BRIDGE_PORT,
  CHATGPT_FALLBACK_MODELS,
  ChatGptAccountData,
  ChatGptModelInfo,
  ChatGptState,
  ChatGptUsageInfo,
  ChatGptError,
} from "./chatgpt-types";
import { ChatGptVault, chatGptVault as defaultVault } from "./chatgpt-vault";
import {
  generatePkce,
  newState,
  getLoginUrl,
  exchangeCodeForTokens,
  extractAccountData,
  refreshAccountTokens,
  needsRefresh,
  fetchCodexModels,
  fetchAccountUsage,
  ChatGptLoopbackServer,
} from "./chatgpt-auth";
import { ChatGptBridgeServer, BridgeManagerDelegate } from "./chatgpt-bridge";

export type StateChangeListener = (state: ChatGptState) => void;

export class ChatGptManager implements BridgeManagerDelegate {
  private vault: ChatGptVault;
  private loopbackServer: ChatGptLoopbackServer;
  private bridgeServer: ChatGptBridgeServer;
  private openExternalFn: (url: string) => Promise<void>;
  private fetchFn: typeof fetch;

  private account: ChatGptAccountData | null = null;
  private models: ChatGptModelInfo[] = [...CHATGPT_FALLBACK_MODELS];
  private usage: ChatGptUsageInfo | null = null;
  private status: ChatGptState["status"] = "disconnected";
  private lastError: string | null = null;
  private updatedAt: string | null = null;

  private listeners = new Set<StateChangeListener>();
  private activeLoginVerifier: string | null = null;
  private refreshPromise: Promise<ChatGptAccountData> | null = null;
  private currentProjectPath: string | null = null;

  constructor(options?: {
    vault?: ChatGptVault;
    loopbackServer?: ChatGptLoopbackServer;
    openExternal?: (url: string) => Promise<void>;
    fetchFn?: typeof fetch;
  }) {
    this.vault = options?.vault || defaultVault;
    this.loopbackServer = options?.loopbackServer || new ChatGptLoopbackServer();
    this.openExternalFn = options?.openExternal || ((u) => shell.openExternal(u));
    this.fetchFn = options?.fetchFn || globalThis.fetch;
    this.bridgeServer = new ChatGptBridgeServer(this);
  }

  public setProject(projectPath: string | null): void {
    this.currentProjectPath = projectPath;
    if (projectPath && this.isConnected()) {
      void this.syncOpenCodeConfig(projectPath).catch(() => {});
    }
  }

  public getCurrentProject(): string | null {
    return this.currentProjectPath;
  }

  public async ensureBridgeRunning(): Promise<void> {
    if (this.isConnected() && !this.bridgeServer.getRunning()) {
      try {
        await this.bridgeServer.start();
      } catch (err: any) {
        console.warn("[Neko/ChatGptManager] Erro ao assegurar bridge rodando:", err?.message || err);
      }
    }
  }

  public isBridgeRunning(): boolean {
    return this.bridgeServer.getRunning();
  }

  /**
   * Inicializa o gerenciador ao iniciar o aplicativo:
   * Carrega tokens do vault, verifica validade e inicia o bridge se conectado.
   */
  public async initialize(): Promise<void> {
    try {
      const stored = await this.vault.loadAccount();
      if (stored && stored.access) {
        this.account = stored;
        this.status = "connected";
        this.updatedAt = new Date().toISOString();

        // Inicia o bridge local
        try {
          await this.bridgeServer.start();
        } catch (err: any) {
          console.warn("[Neko/ChatGptManager] Aviso ao iniciar bridge local:", err?.message || err);
        }

        // Atualiza modelos e limites em segundo plano
        void this.refreshModels().catch(() => {});
        void this.refreshUsage().catch(() => {});
        void this.syncOpenCodeConfig(this.currentProjectPath || undefined).catch(() => {});
      } else {
        this.status = "disconnected";
      }
    } catch (err: any) {
      console.error("[Neko/ChatGptManager] Erro na inicialização:", err?.message || err);
      this.status = "error";
      this.lastError = err?.message || "Falha ao carregar cofre do ChatGPT";
    } finally {
      this.notifyListeners();
    }
  }

  public getState(): ChatGptState {
    return {
      status: this.status,
      email: this.account?.email || null,
      account: this.account?.conta || null,
      plan: this.account?.plano || null,
      models: this.models,
      usage: this.usage,
      error: this.lastError,
      updatedAt: this.updatedAt,
      bridgeRunning: this.bridgeServer.getRunning(),
    };
  }

  public isConnected(): boolean {
    return this.status === "connected" && Boolean(this.account?.access);
  }

  public onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const s = this.getState();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch (err) {
        console.error("[Neko/ChatGptManager] Erro no listener de estado:", err);
      }
    }
  }

  // --- Implementação do delegado para o Bridge ---

  public async getAccount(): Promise<ChatGptAccountData | null> {
    return this.account;
  }

  public getModels(): ChatGptModelInfo[] {
    return this.models.length > 0 ? this.models : CHATGPT_FALLBACK_MODELS;
  }

  public onRateLimitUpdate(usage: ChatGptUsageInfo): void {
    this.usage = { ...(this.usage || {}), ...usage };
    this.notifyListeners();
  }

  /**
   * Garante que o token de acesso esteja válido, renovando se necessário.
   */
  public async ensureFreshToken(): Promise<ChatGptAccountData> {
    if (!this.account) {
      throw new ChatGptError("Nenhuma conta ChatGPT conectada.", { codigo: "acesso" });
    }

    if (!needsRefresh(this.account)) {
      return this.account;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        console.log("[Neko/ChatGptManager] Renovando token de acesso do ChatGPT...");
        const refreshed = await refreshAccountTokens(this.account!, this.fetchFn);
        this.account = refreshed;
        await this.vault.saveAccount(refreshed);
        this.updatedAt = new Date().toISOString();
        this.notifyListeners();
        return refreshed;
      } catch (err: any) {
        console.error("[Neko/ChatGptManager] Falha ao renovar token:", err?.message || err);
        if (err?.codigo === "acesso") {
          this.status = "error";
          this.lastError = "Sessão expirada. Conecte sua conta do ChatGPT novamente.";
          this.notifyListeners();
        }
        throw err;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  // --- Ações de Autenticação e Conexão ---

  /**
   * Inicia o fluxo de autorização OAuth PKCE:
   * 1. Gera PKCE e state
   * 2. Inicia servidor loopback em 127.0.0.1:1455
   * 3. Abre navegador padrão na página oficial da OpenAI
   * 4. No callback: troca código por tokens e persiste no vault ANTES de confirmar ao navegador
   * 5. Inicia o bridge local e atualiza catálogo/limites
   */
  public async startLogin(): Promise<{ success: boolean; error?: string }> {
    if (this.status === "authorizing") {
      return { success: false, error: "Um processo de autorização já está em andamento." };
    }

    this.status = "authorizing";
    this.lastError = null;
    this.notifyListeners();

    try {
      const { verifier, challenge } = await generatePkce();
      const state = newState();
      this.activeLoginVerifier = verifier;

      const loginUrl = getLoginUrl({ challenge, state });

      // Inicia a escuta com callback de troca antes de abrir o navegador
      const callbackPromise = this.loopbackServer.start(state, async (code) => {
        console.log("[Neko/ChatGptManager] Código recebido no callback. Trocando por tokens...");
        const tokens = await exchangeCodeForTokens(code, verifier, this.fetchFn);
        const accountData = extractAccountData(tokens);

        this.account = accountData;
        await this.vault.saveAccount(accountData);

        // Inicia o bridge local
        try {
          await this.bridgeServer.start();
        } catch (bridgeErr: any) {
          console.warn("[Neko/ChatGptManager] Aviso ao iniciar bridge local:", bridgeErr?.message || bridgeErr);
        }
      });

      // Abre o navegador padrão do sistema
      await this.openExternalFn(loginUrl);

      // Aguarda a autorização e o processamento completo dos tokens
      await callbackPromise;

      // Consulta modelos e limites em paralelo (não bloqueante para a conclusão da conexão)
      if (this.account) {
        try {
          const [modelsRes, usageRes] = await Promise.allSettled([
            fetchCodexModels(this.account, this.fetchFn),
            fetchAccountUsage(this.account, this.fetchFn),
          ]);
          if (modelsRes.status === "fulfilled") {
            this.models = modelsRes.value;
          }
          if (usageRes.status === "fulfilled") {
            this.usage = usageRes.value;
          }
        } catch (fetchErr: any) {
          console.warn("[Neko/ChatGptManager] Erro ao carregar modelos/uso iniciais:", fetchErr?.message || fetchErr);
        }
      }

      this.status = "connected";
      this.lastError = null;
      this.updatedAt = new Date().toISOString();
      this.notifyListeners();

      console.log(
        `[Neko/ChatGptManager] ChatGPT conectado com sucesso! Conta: ${
          this.account?.email || this.account?.conta || "identificada"
        }`
      );
      return { success: true };
    } catch (err: any) {
      console.error("[Neko/ChatGptManager] Falha no login do ChatGPT:", err?.message || err);
      const isCancelled = err?.codigo === "cancelado";
      this.status = isCancelled ? "disconnected" : "error";
      this.lastError = isCancelled ? null : err?.message || "Falha na autorização";
      this.notifyListeners();
      return { success: false, error: this.lastError || undefined };
    } finally {
      this.activeLoginVerifier = null;
      this.loopbackServer.stop();
    }
  }

  /**
   * Cancela o fluxo de autorização atual
   */
  public cancelLogin(): void {
    if (this.status === "authorizing") {
      this.loopbackServer.stop();
      this.status = "disconnected";
      this.lastError = null;
      this.notifyListeners();
      console.log("[Neko/ChatGptManager] Autorização cancelada pelo usuário.");
    }
  }

  /**
   * Desconecta a conta, remove o cofre e encerra o bridge
   */
  public async disconnect(): Promise<void> {
    try {
      this.loopbackServer.stop();
      this.bridgeServer.stop();
      await this.vault.clearAccount();
      this.account = null;
      this.models = [...CHATGPT_FALLBACK_MODELS];
      this.usage = null;
      this.status = "disconnected";
      this.lastError = null;
      this.updatedAt = new Date().toISOString();
      console.log("[Neko/ChatGptManager] Conta ChatGPT desconectada.");
    } catch (err: any) {
      console.warn("[Neko/ChatGptManager] Erro ao desconectar:", err?.message || err);
      this.status = "disconnected";
    } finally {
      this.notifyListeners();
    }
  }

  /**
   * Atualiza o catálogo de modelos disponíveis para a conta
   */
  public async refreshModels(): Promise<ChatGptModelInfo[]> {
    if (!this.account) return CHATGPT_FALLBACK_MODELS;
    try {
      const freshAccount = await this.ensureFreshToken();
      const models = await fetchCodexModels(freshAccount, this.fetchFn);
      this.models = models;
      this.notifyListeners();
      // Atualiza imediatamente a configuração do OpenCode com o catálogo atualizado
      void this.syncOpenCodeConfig(this.currentProjectPath || undefined).catch(() => {});
      return models;
    } catch (err: any) {
      console.warn("[Neko/ChatGptManager] Não foi possível atualizar catálogo:", err?.message || err);
      return this.models;
    }
  }

  /**
   * Atualiza as informações de cota e limites de uso
   */
  public async refreshUsage(): Promise<ChatGptUsageInfo | null> {
    if (!this.account) return null;
    try {
      const freshAccount = await this.ensureFreshToken();
      const usage = await fetchAccountUsage(freshAccount, this.fetchFn);
      if (usage) {
        this.usage = usage;
        this.notifyListeners();
      }
      return usage;
    } catch (err: any) {
      console.warn("[Neko/ChatGptManager] Não foi possível atualizar limites:", err?.message || err);
      return this.usage;
    }
  }

  /**
   * Injeta ou remove a configuração do provedor chatgpt-personal no arquivo opencode.json.
   * Aplica tanto no projeto local quanto na configuração global do usuário.
   */
  public async syncOpenCodeConfig(projectPath?: string): Promise<void> {
    const isConn = this.isConnected();
    const targets: string[] = [];

    // Alvo global: ~/.config/opencode/opencode.json
    try {
      const globalConfigDir = path.join(os.homedir(), ".config", "opencode");
      targets.push(path.join(globalConfigDir, "opencode.json"));
    } catch {}

    // Alvo do projeto se especificado
    if (projectPath) {
      try {
        const projDir = path.resolve(projectPath);
        targets.push(path.join(projDir, ".opencode", "opencode.json"));
        // Se já existir opencode.json na raiz do projeto, sincroniza nele também para garantir prioridade
        const rootCfg = path.join(projDir, "opencode.json");
        if (fsSync.existsSync(rootCfg)) {
          targets.push(rootCfg);
        }
      } catch {}
    }

    for (const cfgPath of targets) {
      try {
        let config: Record<string, any> = {};
        if (fsSync.existsSync(cfgPath)) {
          try {
            const raw = await fs.readFile(cfgPath, "utf8");
            const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
            config = JSON.parse(cleaned);
          } catch (parseErr: any) {
            console.warn(`[Neko/ChatGptManager] Arquivo ${cfgPath} possuía formato inválido; reconstruindo com configuração válida.`);
            config = {};
          }
        }

        if (!config.provider || typeof config.provider !== "object") {
          config.provider = {};
        }

        if (isConn) {
          // Constrói mapa de modelos suportados
          const modelsMap: Record<string, any> = {};
          for (const m of this.models) {
            const cleanSlug = m.slug.toLowerCase().trim();
            modelsMap[cleanSlug] = {
              name: m.nome,
              attachment: true,
              reasoning: m.niveis.length > 0,
              tool_call: true,
            };
            if (m.slug !== cleanSlug) {
              modelsMap[m.slug] = {
                name: m.nome,
                attachment: true,
                reasoning: m.niveis.length > 0,
                tool_call: true,
              };
            }
          }

          // Se por algum motivo models estiver vazio, garante o fallback gpt-5.5
          if (Object.keys(modelsMap).length === 0) {
            modelsMap["gpt-5.5"] = {
              name: "GPT-5.5",
              attachment: true,
              reasoning: true,
              tool_call: true,
            };
          }

          config.provider[CHATGPT_PROVIDER_ID] = {
            npm: "@ai-sdk/openai",
            name: CHATGPT_PROVIDER_NAME,
            options: {
              baseURL: `http://127.0.0.1:${CHATGPT_BRIDGE_PORT}/v1`,
              apiKey: "chatgpt-local-bridge",
            },
            models: modelsMap,
          };
        } else {
          // Remove o provedor caso desconectado
          delete config.provider[CHATGPT_PROVIDER_ID];
          if (Object.keys(config.provider).length === 0) {
            delete config.provider;
          }
        }

        const dir = path.dirname(cfgPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(cfgPath, JSON.stringify(config, null, 2), "utf8");
        console.log(`[Neko/ChatGptManager] Sincronizado opencode.json (${isConn ? "adicionado" : "removido"}) em: ${cfgPath}`);
      } catch (err: any) {
        console.warn(`[Neko/ChatGptManager] Aviso ao sincronizar ${cfgPath}:`, err?.message || err);
      }
    }
  }
}

export const chatGptManager = new ChatGptManager();

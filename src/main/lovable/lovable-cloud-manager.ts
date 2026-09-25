import { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import {
  EMPTY_LOVABLE_STATE,
  LovableProjectLink,
  LovableSession,
  LovableState,
  LovableStatus,
  LovableCloudStatus,
  LOVABLE_PROJECT_ID_REGEX,
  LOVABLE_URL_PROJECT_ID_REGEX,
} from "./lovable-types";
import { LovableVaultManager, normalizeVaultProjectPath } from "./lovable-vault";
import { detectLovableProject } from "./lovable-detector";
import { sanitizeErrorMessage, getUserFacingError } from "../../shared/error-extractor";
import { isReadOnlySql } from "../security/sql-guard";
import { summarizeSchema } from "../supabase/db-schema-formatter";

export class LovableCloudManager extends EventEmitter {
  private state: LovableState = { ...EMPTY_LOVABLE_STATE };
  private vault = new LovableVaultManager();
  private activeProjectPath: string | null = null;
  private projectGeneration = 0;
  private loginWindow: BrowserWindow | null = null;
  private currentSession: LovableSession | null = null;
  private sessionProbeInterval: NodeJS.Timeout | null = null;

  public static readonly PARTITION = "persist:neko-lovable-cloud";
  public static readonly DASHBOARD_URL = "https://lovable.dev/dashboard";

  constructor(vault?: LovableVaultManager) {
    super();
    if (vault) this.vault = vault;
  }

  public getState(): LovableState {
    const isExplicitlyDisc = this.state.explicitlyDisconnected === true;
    return {
      status: this.state.status,
      cloudStatus: this.state.cloudStatus || "unknown",
      isLovableProject: this.state.isLovableProject,
      detectionReason: this.state.detectionReason,
      detectedProjectId: this.state.detectedProjectId,
      projectId: this.state.projectId,
      lovableProjectId: this.state.lovableProjectId || this.state.projectId || this.state.detectedProjectId || null,
      hasLovableCloud: this.state.hasLovableCloud,
      lovableCloudConnected: !isExplicitlyDisc && this.state.status === "connected",
      lovableSessionValid: this.state.lovableSessionValid,
      userEmail: this.state.userEmail,
      connectedAt: this.state.connectedAt,
      error: this.state.error,
      explicitlyDisconnected: isExplicitlyDisc,
    };
  }

  private setState(patch: Partial<LovableState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.getState());
  }

  public setProgress(status: LovableStatus, error: string | null = null) {
    this.setState({
      status,
      lovableCloudConnected: status === "connected",
      error: error ? sanitizeErrorMessage(error) : null,
    });
  }

  public async setProject(projectPath: string | null): Promise<LovableState> {
    const currentGen = ++this.projectGeneration;
    this.activeProjectPath = projectPath;

    if (!projectPath) {
      this.currentSession = null;
      this.setState({
        ...EMPTY_LOVABLE_STATE,
      });
      return this.getState();
    }

    this.setState({
      status: "detecting",
      cloudStatus: "unknown",
      error: null,
    });

    try {
      // 1. Detectar marcadores locais no projeto
      const detection = await detectLovableProject(projectPath);

      if (currentGen !== this.projectGeneration) {
        return this.getState();
      }

      // 2. Verificar se o projeto já possui vínculo salvo no cofre
      let savedLink = await this.vault.getLink(projectPath);

      if (currentGen !== this.projectGeneration) {
        return this.getState();
      }

      const detectedId = detection.projectId || null;

      // 3. Se for projeto Lovable com projectId detectado mas sem vínculo prévio:
      // Associa o workspace ao projeto Lovable persistindo o vínculo no mecanismo existente (Vault)
      if (!savedLink && detection.isLovable && detectedId) {
        const initialLink: LovableProjectLink = {
          projectId: detectedId,
          projectPath,
          connectedAt: Date.now(),
          hasLovableCloud: null,
        };
        await this.vault.saveLink(projectPath, initialLink).catch(() => {});
        savedLink = await this.vault.getLink(projectPath).catch(() => initialLink);
      }

      const effectiveProjectId = savedLink?.projectId || detectedId;
      let knownCloudConfirmed = savedLink?.hasLovableCloud === true;
      const isExplicitlyDisconnected = savedLink?.explicitlyDisconnected === true;

      if (effectiveProjectId) {
        // Tentar reusar sessão existente / verificar se sessão está viva
        let session = this.currentSession;
        if (!session || !session.accessToken) {
          session = await this.extractSessionFromPartition();
        }

        const userEmail = session?.email || this.currentSession?.email || null;
        const isTokenLocallyExpired = Boolean(session?.expirationTime && Date.now() >= Number(session.expirationTime));
        let isSessionValid = Boolean(session?.accessToken && !isTokenLocallyExpired);
        let validationStatus: LovableCloudStatus = "unknown";
        let validationError: string | null = null;

        // Se o usuário desconectou explicitamente o Cloud neste projeto, NÃO reconectar automaticamente!
        if (isExplicitlyDisconnected) {
          validationStatus = "auth_required";
        } else if (session && session.accessToken && !isTokenLocallyExpired) {
          const testRes = await this.validateConnection(effectiveProjectId, session.accessToken);
          validationStatus = testRes.cloudStatus || (testRes.success ? "connected" : "error");
          if (testRes.success) {
            isSessionValid = true;
            knownCloudConfirmed = true;
            await this.vault.saveLink(projectPath, {
              projectId: effectiveProjectId,
              projectPath,
              connectedAt: savedLink?.connectedAt || Date.now(),
              hasLovableCloud: true,
              explicitlyDisconnected: false,
            }).catch(() => {});
          } else {
            validationError = testRes.error || null;
            if (testRes.statusCode === 401) {
              isSessionValid = false;
            } else {
              // Token aceito na camada auth da Lovable, mas rejeitado por permissão (403), rota (404), etc.
              isSessionValid = true;
            }
          }
        } else if (session && isTokenLocallyExpired) {
          validationStatus = "session_expired";
          isSessionValid = false;
        } else {
          validationStatus = "auth_required";
          isSessionValid = false;
        }

        if (validationStatus === "connected") {
          this.setState({
            status: "connected",
            cloudStatus: "connected",
            isLovableProject: detection.isLovable,
            detectionReason: detection.reason,
            detectedProjectId: detectedId,
            projectId: effectiveProjectId,
            lovableProjectId: effectiveProjectId,
            hasLovableCloud: true,
            lovableCloudConnected: true,
            lovableSessionValid: isSessionValid,
            userEmail,
            connectedAt: savedLink?.connectedAt || Date.now(),
            error: null,
            explicitlyDisconnected: false,
          });
        } else {
          // Sessão expirada, não autenticada ou não validada: PRESERVAR vínculo e projectId!
          const status = validationStatus === "session_expired" ? "error" : "disconnected";
          const errText = validationStatus === "session_expired"
            ? "Sessão expirada ou não encontrada no Lovable Cloud. Abra o Lovable para reautenticar."
            : validationError;

          this.setState({
            status,
            cloudStatus: validationStatus,
            isLovableProject: detection.isLovable,
            detectionReason: detection.reason,
            detectedProjectId: detectedId,
            projectId: effectiveProjectId,
            lovableProjectId: effectiveProjectId,
            hasLovableCloud: knownCloudConfirmed ? true : null,
            lovableCloudConnected: false,
            lovableSessionValid: isSessionValid,
            userEmail,
            connectedAt: savedLink?.connectedAt || null,
            error: errText,
            explicitlyDisconnected: isExplicitlyDisconnected,
          });
        }

        console.log(
          `[Lovable Rehydrate Debug] source=setProject projectId=${effectiveProjectId} sessionValid=${isSessionValid} explicitlyDisconnected=${isExplicitlyDisconnected} decision=${validationStatus === "connected" ? "AUTO_VALIDATED_CONNECTED" : "DISCONNECTED_PRESERVED"}`
        );

        console.log("[Lovable Cloud Manager] setProject resolved:", {
          projectPath,
          isLovable: detection.isLovable,
          detectedProjectId: detectedId,
          effectiveProjectId,
          cloudStatus: validationStatus,
          hasLovableCloud: validationStatus === "connected" ? true : (knownCloudConfirmed ? true : null),
          lovableSessionValid: isSessionValid,
          lovableCloudConnected: validationStatus === "connected",
          explicitlyDisconnected: isExplicitlyDisconnected,
        });
      } else {
        const isTokenLocallyExpired = Boolean(this.currentSession?.expirationTime && Date.now() >= Number(this.currentSession.expirationTime));
        const hasValidSession = Boolean(this.currentSession?.accessToken && !isTokenLocallyExpired);
        this.setState({
          status: "disconnected",
          cloudStatus: "unknown",
          isLovableProject: detection.isLovable,
          detectionReason: detection.reason,
          detectedProjectId: null,
          projectId: null,
          lovableProjectId: null,
          hasLovableCloud: null,
          lovableCloudConnected: false,
          lovableSessionValid: hasValidSession,
          userEmail: this.currentSession?.email || null,
          connectedAt: null,
          error: null,
        });
        console.log("[Lovable Cloud Manager] setProject (non-Lovable or no projectId):", {
          projectPath,
          isLovable: detection.isLovable,
          detectionReason: detection.reason,
        });
      }

      return this.getState();
    } catch (err: any) {
      if (currentGen !== this.projectGeneration) {
        return this.getState();
      }

      const safeErr = sanitizeErrorMessage(getUserFacingError(err, "Falha ao verificar integração com Lovable Cloud."));
      this.setState({
        status: "error",
        cloudStatus: "error",
        error: safeErr,
      });
      return this.getState();
    }
  }

  public async openLoginWindow(): Promise<void> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return;
    }

    const win = new BrowserWindow({
      width: 980,
      height: 720,
      title: "NekoAI — Conectar Lovable Cloud",
      webPreferences: {
        partition: LovableCloudManager.PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.loginWindow = win;

    const handleNavigation = (_event: any, url: string) => {
      this.checkUrlForProjectId(url);
      void this.probeSessionFromWindow();
    };

    win.webContents.on("did-navigate", handleNavigation);
    win.webContents.on("did-navigate-in-page", handleNavigation);

    win.on("closed", () => {
      this.loginWindow = null;
      if (this.sessionProbeInterval) {
        clearInterval(this.sessionProbeInterval);
        this.sessionProbeInterval = null;
      }
    });

    const targetUrl =
      this.state.detectedProjectId
        ? `https://lovable.dev/projects/${this.state.detectedProjectId}`
        : LovableCloudManager.DASHBOARD_URL;

    await win.loadURL(targetUrl);

    // Sondagem periódica suave enquanto a janela estiver aberta
    if (this.sessionProbeInterval) {
      clearInterval(this.sessionProbeInterval);
    }
    this.sessionProbeInterval = setInterval(() => {
      if (this.loginWindow && !this.loginWindow.isDestroyed()) {
        void this.probeSessionFromWindow();
      }
    }, 4000);
  }

  private checkUrlForProjectId(url: string) {
    if (!url) return;
    const match = url.match(LOVABLE_URL_PROJECT_ID_REGEX);
    if (match && match[1]) {
      const extractedId = match[1];
      if (this.state.detectedProjectId !== extractedId) {
        console.log("[Neko/Lovable] Project ID detectado pela URL de navegação:", extractedId);
        this.setState({
          detectedProjectId: extractedId,
        });
      }
    }
  }

  public async extractSessionFromPartition(): Promise<LovableSession | null> {
    if (this.currentSession && this.currentSession.accessToken) {
      return this.currentSession;
    }
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      return this.extractSessionFromWindow();
    }

    try {
      const probeWin = new BrowserWindow({
        width: 100,
        height: 100,
        show: false,
        webPreferences: {
          partition: LovableCloudManager.PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await probeWin.loadURL(LovableCloudManager.DASHBOARD_URL);

      const script = `
        (async () => {
          return new Promise((resolve) => {
            try {
              const req = indexedDB.open('firebaseLocalStorageDb');
              req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                  return resolve(null);
                }
                const tx = db.transaction('firebaseLocalStorage', 'readonly');
                const store = tx.objectStore('firebaseLocalStorage');
                const cursorReq = store.openCursor();
                cursorReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    if (typeof cursor.key === 'string' && cursor.key.startsWith('firebase:authUser:')) {
                      const val = cursor.value?.value || cursor.value;
                      resolve({
                        email: val?.email,
                        uid: val?.uid,
                        accessToken: val?.stsTokenManager?.accessToken,
                        expirationTime: val?.stsTokenManager?.expirationTime,
                      });
                      return;
                    }
                    cursor.continue();
                  } else {
                    resolve(null);
                  }
                };
                cursorReq.onerror = () => resolve(null);
              };
              req.onerror = () => resolve(null);
            } catch {
              resolve(null);
            }
          });
        })()
      `;

      const session = await probeWin.webContents.executeJavaScript(script, true).catch(() => null);
      if (!probeWin.isDestroyed()) {
        probeWin.destroy();
      }

      if (session && session.accessToken) {
        this.currentSession = session;
        if (session.email && session.email !== this.state.userEmail) {
          this.setState({ userEmail: session.email });
        }
        return session;
      }
      return null;
    } catch {
      return null;
    }
  }

  public async extractSessionFromWindow(): Promise<LovableSession | null> {
    if (!this.loginWindow || this.loginWindow.isDestroyed()) {
      return this.extractSessionFromPartition();
    }

    try {
      const script = `
        (async () => {
          return new Promise((resolve) => {
            try {
              const req = indexedDB.open('firebaseLocalStorageDb');
              req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                  return resolve(null);
                }
                const tx = db.transaction('firebaseLocalStorage', 'readonly');
                const store = tx.objectStore('firebaseLocalStorage');
                const cursorReq = store.openCursor();
                cursorReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    if (typeof cursor.key === 'string' && cursor.key.startsWith('firebase:authUser:')) {
                      const val = cursor.value?.value || cursor.value;
                      resolve({
                        email: val?.email,
                        uid: val?.uid,
                        accessToken: val?.stsTokenManager?.accessToken,
                        expirationTime: val?.stsTokenManager?.expirationTime,
                      });
                      return;
                    }
                    cursor.continue();
                  } else {
                    resolve(null);
                  }
                };
                cursorReq.onerror = () => resolve(null);
              };
              req.onerror = () => resolve(null);
            } catch {
              resolve(null);
            }
          });
        })()
      `;

      const session = await this.loginWindow.webContents.executeJavaScript(script, true);
      if (session && session.accessToken) {
        this.currentSession = session;
        if (session.email && session.email !== this.state.userEmail) {
          this.setState({ userEmail: session.email });
        }
        return session;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async probeSessionFromWindow(): Promise<void> {
    const session = await this.extractSessionFromWindow();
    if (session && session.accessToken) {
      const isTokenLocallyExpired = Boolean(session.expirationTime && Date.now() >= Number(session.expirationTime));
      const sessionValid = !isTokenLocallyExpired;

      if (this.state.userEmail !== session.email || this.state.lovableSessionValid !== sessionValid) {
        this.setState({
          userEmail: session.email || null,
          lovableSessionValid: sessionValid,
        });
      }

      // Se o usuário desconectou explicitamente o Cloud neste projeto, NUNCA auto-reconectar via probe!
      const isExplicitlyDisconnected =
        this.state.explicitlyDisconnected === true ||
        (this.activeProjectPath ? (await this.vault.getLink(this.activeProjectPath).catch(() => null))?.explicitlyDisconnected === true : false);

      const activeProjectId = this.state.projectId || this.state.detectedProjectId;

      console.log(
        `[Lovable Rehydrate Debug] source=probeSessionFromWindow projectId=${activeProjectId} sessionValid=${sessionValid} explicitlyDisconnected=${isExplicitlyDisconnected} decision=${isExplicitlyDisconnected ? "STAY_DISCONNECTED" : "AUTO_VALIDATE"}`
      );

      if (isExplicitlyDisconnected) {
        return;
      }

      // Se o projeto já estava vinculado (preservado) e aguardava reautenticação
      if (activeProjectId && (this.state.status === "error" || this.state.status === "authorizing" || this.state.status === "disconnected")) {
        const valRes = await this.validateConnection(activeProjectId, session.accessToken);
        if (valRes.success) {
          if (this.activeProjectPath) {
            await this.vault.saveLink(this.activeProjectPath, {
              projectId: activeProjectId,
              projectPath: this.activeProjectPath,
              connectedAt: this.state.connectedAt || Date.now(),
              hasLovableCloud: true,
              explicitlyDisconnected: false,
            }).catch(() => {});
          }
          this.setState({
            status: "connected",
            cloudStatus: "connected",
            hasLovableCloud: true,
            lovableCloudConnected: true,
            lovableSessionValid: true,
            projectId: activeProjectId,
            lovableProjectId: activeProjectId,
            error: null,
            explicitlyDisconnected: false,
          });
        } else if (valRes.statusCode === 401) {
          this.setState({
            lovableSessionValid: false,
            cloudStatus: "session_expired",
          });
        }
      }
    }
  }

  public async validateConnection(
    projectId: string,
    token: string
  ): Promise<{ success: boolean; error?: string; data?: any; statusCode?: number; cloudStatus?: LovableCloudStatus }> {
    if (!projectId || !LOVABLE_PROJECT_ID_REGEX.test(projectId)) {
      return { success: false, error: "ID de projeto do Lovable inválido.", cloudStatus: "unknown" };
    }
    if (!token) {
      return { success: false, error: "Sessão não autenticada no Lovable.", cloudStatus: "auth_required" };
    }

    try {
      const url = `https://api.lovable.dev/projects/${encodeURIComponent(projectId)}/cloud/query?env=prod`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "select 1 as conectado;",
          source: "sql-editor",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        let cloudStatus: LovableCloudStatus = "error";
        if (response.status === 401) {
          cloudStatus = "session_expired";
        } else if (response.status === 403) {
          cloudStatus = "forbidden";
        } else {
          // Conforme regra Prompt 4A: NÃO assumir 404 = sem Cloud como regra absoluta.
          // Se não for possível determinar com segurança "sem Cloud", o estado deve ser NOT_CONFIRMED / UNKNOWN.
          cloudStatus = "not_confirmed";
        }

        const safeMsg = sanitizeErrorMessage(
          `Lovable Cloud respondeu com status ${response.status}: ${errorText || response.statusText}`
        );
        return { success: false, error: safeMsg, statusCode: response.status, cloudStatus };
      }

      const data = await response.json().catch(() => null);
      return { success: true, data, statusCode: response.status, cloudStatus: "connected" };
    } catch (err: any) {
      const safeMsg = sanitizeErrorMessage(getUserFacingError(err, "Falha de rede ao conectar à API do Lovable Cloud."));
      return { success: false, error: safeMsg, cloudStatus: "error" };
    }
  }

  public async linkProject(projectIdInput?: string): Promise<LovableState> {
    if (!this.activeProjectPath) {
      throw new Error("Nenhum projeto aberto no NekoAI.");
    }

    const targetProjectId = (projectIdInput || this.state.detectedProjectId || "").trim();
    if (!targetProjectId || !LOVABLE_PROJECT_ID_REGEX.test(targetProjectId)) {
      throw new Error("ID do projeto Lovable é obrigatório e deve estar no formato UUID.");
    }

    // Obter sessão atual
    let session = this.currentSession;
    if (!session || !session.accessToken) {
      session = await this.extractSessionFromWindow();
    }

    if (!session || !session.accessToken) {
      await this.openLoginWindow();
      this.setState({
        status: "authorizing",
        cloudStatus: "auth_required",
        error: "Faça login no Lovable Cloud na janela aberta para vincular o projeto.",
      });
      return this.getState();
    }

    this.setState({
      status: "validating",
      cloudStatus: "unknown",
      error: null,
    });

    const validation = await this.validateConnection(targetProjectId, session.accessToken);
    if (!validation.success) {
      this.setState({
        status: "error",
        cloudStatus: validation.cloudStatus || "error",
        error: validation.error || "Não foi possível validar a conexão com o banco Lovable Cloud.",
      });
      return this.getState();
    }

    // Salvar link no cofre seguro
    const link: LovableProjectLink = {
      projectId: targetProjectId,
      projectPath: this.activeProjectPath,
      connectedAt: Date.now(),
      hasLovableCloud: true,
      explicitlyDisconnected: false,
    };
    await this.vault.saveLink(this.activeProjectPath, link);

    this.setState({
      status: "connected",
      cloudStatus: "connected",
      projectId: targetProjectId,
      lovableProjectId: targetProjectId,
      hasLovableCloud: true,
      lovableCloudConnected: true,
      lovableSessionValid: true,
      connectedAt: link.connectedAt,
      userEmail: session.email || null,
      error: null,
      explicitlyDisconnected: false,
    });

    return this.getState();
  }

  public async unlinkProject(): Promise<LovableState> {
    if (!this.activeProjectPath) {
      return this.getState();
    }

    const connectedBefore = this.state.lovableCloudConnected;
    const effectiveProjectId = this.state.projectId || this.state.lovableProjectId || this.state.detectedProjectId;

    // 1. Interromper qualquer sondagem da janela de login anterior
    if (this.sessionProbeInterval) {
      clearInterval(this.sessionProbeInterval);
      this.sessionProbeInterval = null;
    }
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      try {
        this.loginWindow.close();
      } catch {}
      this.loginWindow = null;
    }

    // 2. Persistir desconexão explícita no cofre
    if (effectiveProjectId && this.activeProjectPath) {
      await this.vault.saveLink(this.activeProjectPath, {
        projectId: effectiveProjectId,
        projectPath: this.activeProjectPath,
        connectedAt: Date.now(),
        hasLovableCloud: this.state.hasLovableCloud,
        explicitlyDisconnected: true,
      }).catch(() => {});
    }

    const session = this.currentSession;
    const isTokenLocallyExpired = Boolean(session?.expirationTime && Date.now() >= Number(session.expirationTime));
    const sessionValid = Boolean(session?.accessToken && !isTokenLocallyExpired);

    this.setState({
      status: "disconnected",
      cloudStatus: "auth_required",
      projectId: effectiveProjectId,
      lovableProjectId: effectiveProjectId,
      hasLovableCloud: this.state.hasLovableCloud,
      lovableCloudConnected: false,
      lovableSessionValid: sessionValid,
      connectedAt: null,
      error: null,
      explicitlyDisconnected: true,
    });

    console.log(
      `[Lovable Disconnect Debug] action=disconnect projectId=${effectiveProjectId} connectedBefore=${connectedBefore} connectedAfter=false explicitlyDisconnected=true`
    );

    return this.getState();
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    const projectId = this.state.projectId || this.state.detectedProjectId;
    if (!projectId) {
      return { success: false, error: "Nenhum projeto vinculado para teste." };
    }

    let session = this.currentSession;
    if (!session || !session.accessToken) {
      session = await this.extractSessionFromWindow();
    }

    if (!session || !session.accessToken) {
      return { success: false, error: "Sessão expirada ou não encontrada. Abra o Lovable para reautenticar." };
    }

    this.setState({ status: "validating", cloudStatus: "unknown" });
    const result = await this.validateConnection(projectId, session.accessToken);

    if (result.success) {
      if (this.activeProjectPath) {
        await this.vault.saveLink(this.activeProjectPath, {
          projectId,
          projectPath: this.activeProjectPath,
          connectedAt: this.state.connectedAt || Date.now(),
          hasLovableCloud: true,
          explicitlyDisconnected: false,
        }).catch(() => {});
      }
      this.setState({
        status: "connected",
        cloudStatus: "connected",
        hasLovableCloud: true,
        lovableCloudConnected: true,
        lovableSessionValid: true,
        error: null,
        explicitlyDisconnected: false,
      });
      return { success: true };
    } else {
      const isSessionExpired = result.statusCode === 401;
      this.setState({
        status: "error",
        cloudStatus: result.cloudStatus || "error",
        lovableCloudConnected: false,
        lovableSessionValid: !isSessionExpired,
        error: result.error || "Falha na query de validação.",
      });
      return { success: false, error: result.error };
    }
  }

  public getActiveProjectPath(): string | null {
    return this.activeProjectPath;
  }

  public getProjectGeneration(): number {
    return this.projectGeneration;
  }

  public async executeQuery(
    sql: string,
    options?: { skipReadOnlyCheck?: boolean; projectPath?: string; generation?: number }
  ): Promise<{ rows: any[]; fields?: any[]; rowCount: number }> {
    // 1. Validar workspace ativo e geração
    if (
      options?.projectPath &&
      this.activeProjectPath &&
      normalizeVaultProjectPath(options.projectPath) !== normalizeVaultProjectPath(this.activeProjectPath)
    ) {
      throw new Error("Acesso negado: o MCP tentou operar em um workspace diferente do ativo.");
    }

    if (options?.generation !== undefined && options.generation !== this.projectGeneration) {
      throw new Error("Troca de workspace detectada. Operação interrompida por mudança de contexto.");
    }

    const projectId = this.state.projectId;
    if (!projectId || !this.activeProjectPath) {
      throw new Error("Este projeto não possui um Lovable Cloud conectado.");
    }

    // 2. Validação READ-ONLY de SQL via sql-guard
    if (!options?.skipReadOnlyCheck) {
      if (!isReadOnlySql(sql)) {
        throw new Error("Consulta SQL rejeitada: apenas instruções SELECT de leitura única são permitidas.");
      }
    }

    // 3. Autenticação e token
    let session = this.currentSession;
    if (!session || !session.accessToken) {
      session = await this.extractSessionFromWindow();
    }

    if (!session || !session.accessToken) {
      throw new Error("Sessão não autenticada no Lovable Cloud. Abra a janela do Lovable para reautenticar.");
    }

    console.log(`[Neko/Lovable] Executando query no Lovable Cloud projectId=${projectId} queryLen=${sql.length} classified=READ_ONLY`);

    const url = `https://api.lovable.dev/projects/${encodeURIComponent(projectId)}/cloud/query?env=prod`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: sql,
        source: "sql-editor",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const safeMsg = sanitizeErrorMessage(
        `API do Lovable Cloud respondeu com status ${response.status}: ${errorText || response.statusText}`
      );
      throw new Error(safeMsg);
    }

    const data = await response.json().catch(() => null);
    let rows: any[] = [];
    if (Array.isArray(data?.rows)) {
      rows = data.rows;
    } else if (Array.isArray(data?.result)) {
      rows = data.result;
    } else if (Array.isArray(data)) {
      rows = data;
    }

    return {
      rows,
      fields: data?.fields || [],
      rowCount: rows.length,
    };
  }

  public async getDatabaseSchema(options?: { projectPath?: string; generation?: number }): Promise<string> {
    const columnsSql = `
      SELECT 
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.table_schema, kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk ON c.table_schema = pk.table_schema 
          AND c.table_name = pk.table_name 
          AND c.column_name = pk.column_name
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position;
    `;

    const foreignKeysSql = `
      SELECT
        kcu.table_schema,
        kcu.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND kcu.table_schema NOT IN ('pg_catalog', 'information_schema');
    `;

    const tablesSql = `
      SELECT
        n.nspname AS table_schema,
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.reltuples::bigint AS approx_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema');
    `;

    const policiesSql = `
      SELECT
        schemaname AS table_schema,
        tablename AS table_name,
        policyname AS name,
        cmd AS command,
        roles,
        qual AS using_expr,
        with_check
      FROM pg_policies
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema');
    `;

    const enumsSql = `
      SELECT
        n.nspname AS enum_schema,
        t.typname AS enum_name,
        e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, t.typname, e.enumsortorder;
    `;

    const [columnsRes, fkRes, tablesRes, policiesRes, enumsRes] = await Promise.all([
      this.executeQuery(columnsSql, { ...options, skipReadOnlyCheck: true }).catch(() => ({ rows: [] })),
      this.executeQuery(foreignKeysSql, { ...options, skipReadOnlyCheck: true }).catch(() => ({ rows: [] })),
      this.executeQuery(tablesSql, { ...options, skipReadOnlyCheck: true }).catch(() => ({ rows: [] })),
      this.executeQuery(policiesSql, { ...options, skipReadOnlyCheck: true }).catch(() => ({ rows: [] })),
      this.executeQuery(enumsSql, { ...options, skipReadOnlyCheck: true }).catch(() => ({ rows: [] })),
    ]);

    const tablesMap: Record<string, any> = {};

    for (const row of tablesRes.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      tablesMap[key] = {
        name: row.table_name,
        schema: row.table_schema,
        columns: [],
        foreignKeys: [],
        rlsEnabled: Boolean(row.rls_enabled),
        policies: [],
        approxRows: Number(row.approx_rows) || 0,
      };
    }

    for (const col of columnsRes.rows) {
      const key = `${col.table_schema}.${col.table_name}`;
      if (!tablesMap[key]) {
        tablesMap[key] = {
          name: col.table_name,
          schema: col.table_schema,
          columns: [],
          foreignKeys: [],
          rlsEnabled: false,
          policies: [],
          approxRows: 0,
        };
      }
      tablesMap[key].columns.push({
        name: col.column_name,
        type: col.data_type === "USER-DEFINED" ? col.udt_name : col.data_type,
        nullable: col.is_nullable === "YES" || col.is_nullable === true,
        default: col.column_default || null,
        isPrimaryKey: Boolean(col.is_primary_key),
      });
    }

    for (const fk of fkRes.rows) {
      const key = `${fk.table_schema}.${fk.table_name}`;
      if (tablesMap[key]) {
        tablesMap[key].foreignKeys.push({
          column: fk.column_name,
          foreignTable: fk.foreign_table,
          foreignColumn: fk.foreign_column,
          constraintName: fk.constraint_name,
        });
      }
    }

    for (const pol of policiesRes.rows) {
      const key = `${pol.table_schema}.${pol.table_name}`;
      if (tablesMap[key]) {
        tablesMap[key].policies.push({
          name: pol.name,
          command: pol.command,
          roles: Array.isArray(pol.roles) ? pol.roles : undefined,
          using: pol.using_expr,
          withCheck: pol.with_check,
        });
      }
    }

    const enumsMap: Record<string, string[]> = {};
    for (const e of enumsRes.rows) {
      const key = `${e.enum_schema}.${e.enum_name}`;
      if (!enumsMap[key]) enumsMap[key] = [];
      enumsMap[key].push(e.enum_value);
    }

    const structuredSchema = {
      tables: tablesMap,
      enums: Object.entries(enumsMap).map(([name, values]) => ({ name, values })),
    };

    return summarizeSchema(structuredSchema);
  }
}

export const lovableCloudManager = new LovableCloudManager();

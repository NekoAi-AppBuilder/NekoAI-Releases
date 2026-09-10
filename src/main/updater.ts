import { autoUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import { app, BrowserWindow } from "electron";

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: string | null;
  lastCheckedAt: number | null;
}

class NekoUpdaterManager {
  private window: BrowserWindow | null = null;
  private state: UpdaterState = {
    status: "idle",
    currentVersion: app.getVersion(),
    updateInfo: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  };

  public initialize(window: BrowserWindow | null) {
    this.window = window;
    this.state.currentVersion = app.getVersion();

    // Configurações do autoUpdater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;

    this.registerEvents();
  }

  public setWindow(window: BrowserWindow | null) {
    this.window = window;
  }

  public getState(): UpdaterState {
    return { ...this.state };
  }

  private setState(partial: Partial<UpdaterState>) {
    this.state = { ...this.state, ...partial };
    this.emitState();
  }

  private emitState() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("updater:state-changed", this.getState());
    }
  }

  private registerEvents() {
    autoUpdater.on("checking-for-update", () => {
      console.log("[Neko/Updater] Verificando atualizações...");
      this.setState({
        status: "checking",
        error: null,
      });
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      console.log(`[Neko/Updater] Nova versão encontrada: ${info.version}`);
      this.setState({
        status: "available",
        updateInfo: info,
        error: null,
        lastCheckedAt: Date.now(),
      });
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      console.log(`[Neko/Updater] Aplicativo já está na versão mais recente (${info.version}).`);
      this.setState({
        status: "not-available",
        updateInfo: info,
        error: null,
        lastCheckedAt: Date.now(),
      });
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      console.log(`[Neko/Updater] Progresso do download: ${Math.round(progress.percent)}% (${Math.round(progress.transferred / 1024 / 1024)}MB / ${Math.round(progress.total / 1024 / 1024)}MB)`);
      this.setState({
        status: "downloading",
        progress,
        error: null,
      });
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      console.log(`[Neko/Updater] Atualização baixada com sucesso: ${info.version}`);
      this.setState({
        status: "downloaded",
        updateInfo: info,
        error: null,
      });
    });

    autoUpdater.on("error", (err: Error) => {
      console.warn("[Neko/Updater] Erro no updater:", err.message);
      // Mensagem amigável sem quebrar o app
      let friendlyMessage = err.message || "Erro desconhecido ao verificar atualizações.";
      if (friendlyMessage.includes("404") || friendlyMessage.includes("Cannot find")) {
        friendlyMessage = "Nenhuma versão publicada encontrada no repositório de lançamentos.";
      } else if (friendlyMessage.includes("net::ERR") || friendlyMessage.includes("ENOTFOUND")) {
        friendlyMessage = "Não foi possível conectar ao servidor de atualizações. Verifique sua conexão com a internet.";
      }
      this.setState({
        status: "error",
        error: friendlyMessage,
        lastCheckedAt: Date.now(),
      });
    });
  }

  public async checkForUpdates(): Promise<{ ok: boolean; status: string; version?: string; error?: string }> {
    try {
      this.setState({ status: "checking", error: null });
      const checkResult = await autoUpdater.checkForUpdates();
      const version = checkResult?.updateInfo?.version;
      return {
        ok: true,
        status: this.state.status,
        version,
      };
    } catch (err: any) {
      console.warn("[Neko/Updater] Falha ao checar atualizações:", err?.message || err);
      let msg = String(err?.message || err);
      if (msg.includes("dev-app-update.yml")) {
        msg = "Ambiente de desenvolvimento detectado (atualizações automáticas são validadas na versão empacotada).";
      }
      this.setState({ status: "error", error: msg, lastCheckedAt: Date.now() });
      return {
        ok: false,
        status: "error",
        error: msg,
      };
    }
  }

  public async downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.setState({ status: "downloading", error: null });
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err: any) {
      console.warn("[Neko/Updater] Falha no download da atualização:", err?.message || err);
      const msg = String(err?.message || err);
      this.setState({ status: "error", error: msg });
      return { ok: false, error: msg };
    }
  }

  public quitAndInstall(): void {
    console.log("[Neko/Updater] Reiniciando e instalando nova versão...");
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  }
}

export const updaterManager = new NekoUpdaterManager();

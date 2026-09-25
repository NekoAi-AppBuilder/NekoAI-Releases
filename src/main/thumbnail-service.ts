// src/main/thumbnail-service.ts
// Serviço universal de captura e cache de miniaturas de projetos no NekoAI.
// Responsabilidade: Capturar o Preview funcional de qualquer tecnologia,
// persistir em .neko/thumbnail.png e atualizar o cache do RecentProjectsManager.

import electron, { BrowserWindow, type WebContentsView } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { recentProjectsManager, normalizeProjectPath } from "./recent-projects-manager";

export interface ThumbnailCaptureOptions {
  force?: boolean;
  debounceMs?: number;
}

export class ThumbnailService {
  private inFlightCaptures = new Set<string>();
  private lastCaptureTime = new Map<string, number>();
  private activeTimers = new Map<string, NodeJS.Timeout>();
  private internalViewGetter: (() => WebContentsView | null) | null = null;
  private mainWindowGetter: (() => electron.BrowserWindow | null) | null = null;
  private isInsideAppRootChecker: ((p: string) => boolean) | null = null;

  private readonly DEFAULT_DEBOUNCE_MS = 15_000; // 15s throttle entre capturas automáticas

  public setInternalPreviewViewGetter(getter: () => WebContentsView | null): void {
    this.internalViewGetter = getter;
  }

  public setMainWindowGetter(getter: () => electron.BrowserWindow | null): void {
    this.mainWindowGetter = getter;
  }

  public setIsInsideAppRootChecker(checker: (p: string) => boolean): void {
    this.isInsideAppRootChecker = checker;
  }

  /**
   * Enfileira uma captura do Preview em segundo plano com debounce.
   * Não bloqueia a execução do chamador.
   */
  public queueCapture(projectPath: string, previewUrl: string, options?: ThumbnailCaptureOptions): void {
    const normPath = normalizeProjectPath(projectPath);
    const url = String(previewUrl || "").trim();
    if (!normPath || !url || !/^https?:\/\//i.test(url)) return;

    if (this.isInsideAppRootChecker && this.isInsideAppRootChecker(normPath)) {
      return;
    }

    const key = process.platform === "win32" ? normPath.toLowerCase() : normPath;
    const force = Boolean(options?.force);
    const debounceMs = options?.debounceMs ?? this.DEFAULT_DEBOUNCE_MS;
    const now = Date.now();
    const lastTime = this.lastCaptureTime.get(key) || 0;

    // Se uma captura já está em andamento para este projeto, ignora nova solicitação
    if (this.inFlightCaptures.has(key)) {
      return;
    }

    // Se já capturou recentemente e não é forçado, debounced
    if (!force && now - lastTime < debounceMs) {
      const existingTimer = this.activeTimers.get(key);
      if (!existingTimer) {
        const delay = debounceMs - (now - lastTime) + 500;
        const timer = setTimeout(() => {
          this.activeTimers.delete(key);
          void this.executeCapture(normPath, url);
        }, delay);
        this.activeTimers.set(key, timer);
      }
      return;
    }

    // Cancela timer pendente se houver e executa imediatamente
    const existingTimer = this.activeTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.activeTimers.delete(key);
    }

    void this.executeCapture(normPath, url);
  }

  /**
   * Executa a captura e persistência da miniatura de forma segura.
   */
  public async executeCapture(
    projectPath: string,
    previewUrl: string
  ): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
    const normPath = normalizeProjectPath(projectPath);
    const url = String(previewUrl || "").trim();
    if (!normPath || !url) return { ok: false, error: "Caminho ou URL inválidos" };

    const key = process.platform === "win32" ? normPath.toLowerCase() : normPath;
    if (this.inFlightCaptures.has(key)) {
      return { ok: false, error: "Captura já em andamento" };
    }

    this.inFlightCaptures.add(key);
    this.lastCaptureTime.set(key, Date.now());

    try {
      // 1. PRIORIDADE 1: Tenta capturar do WebContentsView interno ativo.
      // Se estiver inicializando ou estabilizando o carregamento (ex: cold start Vite),
      // aguarda a estabilização em vez de criar precipitadamente uma janela OSR.
      let capturedImage = await this.captureFromInternalView(url);

      // 2. PRIORIDADE 2: Fallback offscreen somente quando realmente necessário
      // (ex: view interno ausente ou indisponível após espera de estabilização)
      if (!capturedImage || capturedImage.isEmpty()) {
        capturedImage = await this.captureOffscreen(url);
      }

      if (!capturedImage || capturedImage.isEmpty()) {
        return { ok: false, error: "Captura de página vazia ou falhou" };
      }

      // 3. Redimensiona para proporção consistente (640px de largura com alta qualidade)
      const resized = capturedImage.resize({ width: 640, quality: "good" });
      const pngBuffer = resized.toPNG();
      const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

      // 4. Salva no disco do projeto em .neko/thumbnail.png
      const nekoDir = path.join(normPath, ".neko");
      await fs.mkdir(nekoDir, { recursive: true });
      const thumbPath = path.join(nekoDir, "thumbnail.png");
      await fs.writeFile(thumbPath, pngBuffer);

      const capturedAt = Date.now();

      // 5. Atualiza o RecentProjectsManager
      await recentProjectsManager.updateProjectThumbnail(normPath, {
        thumbnail: dataUrl,
        thumbnailPath: thumbPath,
        thumbnailUpdatedAt: capturedAt,
        previewUrl: url
      });

      // 6. Notifica o Renderer via evento IPC
      this.notifyRenderer();

      console.log(`[ThumbnailService] Miniatura real capturada com sucesso para: ${normPath}`);
      return { ok: true, dataUrl };
    } catch (err: any) {
      console.warn(`[ThumbnailService] Erro ao capturar miniatura de ${normPath}:`, err?.message || err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      this.inFlightCaptures.delete(key);
    }
  }

  /**
   * PRIORIDADE 1: Captura diretamente do WebContentsView interno ativo quando disponível.
   * Aguarda o preview estabilizar (did-finish-load / did-stop-loading) antes de capturar,
   * evitando a criação de BrowserWindow offscreen desnecessária.
   */
  private async captureFromInternalView(url: string): Promise<electron.NativeImage | null> {
    if (!this.internalViewGetter) return null;

    // Se o view interno ainda não foi anexado (corrida imediata pós preview.ready),
    // aguarda brevemente (até 2500ms) para que o Renderer envie o preview:attach.
    let internalView = this.internalViewGetter();
    if (!internalView) {
      const waitStart = Date.now();
      while (!internalView && Date.now() - waitStart < 2500) {
        await new Promise(r => setTimeout(r, 100));
        internalView = this.internalViewGetter();
      }
    }

    if (!internalView || internalView.webContents.isDestroyed()) {
      return null;
    }

    try {
      const currentUrl = internalView.webContents.getURL();
      const urlMatches = Boolean(currentUrl && this.urlsMatch(currentUrl, url));
      const isLoading = internalView.webContents.isLoading();

      // Se o view ainda está carregando ou a URL de destino ainda não estabilizou,
      // aguarda did-finish-load / did-stop-loading
      if (isLoading || !urlMatches) {
        const settled = await this.waitForViewStable(internalView, url, 7000);
        if (!settled && (!internalView.webContents.isDestroyed() && !this.urlsMatch(internalView.webContents.getURL(), url))) {
          return null;
        }
      }

      if (internalView.webContents.isDestroyed()) return null;

      // Breve pausa para estabilização de renderização (layout, fontes, DOM)
      await new Promise(r => setTimeout(r, 600));

      if (internalView.webContents.isDestroyed()) return null;

      const settledUrl = internalView.webContents.getURL();
      if (settledUrl && this.urlsMatch(settledUrl, url)) {
        const pageImage = await internalView.webContents.capturePage();
        if (!pageImage.isEmpty()) {
          console.log(`[ThumbnailService] Miniatura capturada prioritariamente do internalPreviewView.`);
          return pageImage;
        }
      }
    } catch (err: any) {
      console.warn(`[ThumbnailService] Falha ao capturar do internalPreviewView:`, err?.message || err);
    }

    return null;
  }

  /**
   * Aguarda a estabilização de carregamento do WebContentsView (did-finish-load ou did-stop-loading).
   */
  private async waitForViewStable(
    view: WebContentsView,
    expectedUrl: string,
    timeoutMs = 7000
  ): Promise<boolean> {
    if (view.webContents.isDestroyed()) return false;

    if (!view.webContents.isLoading() && this.urlsMatch(view.webContents.getURL(), expectedUrl)) {
      return true;
    }

    return new Promise<boolean>(resolve => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (!view.webContents.isDestroyed()) {
          view.webContents.removeListener("did-finish-load", onFinish);
          view.webContents.removeListener("did-stop-loading", onStop);
          view.webContents.removeListener("did-fail-load", onFail);
        }
      };

      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onFinish = () => {
        if (!view.webContents.isDestroyed() && this.urlsMatch(view.webContents.getURL(), expectedUrl)) {
          finish(true);
        }
      };

      const onStop = () => {
        if (!view.webContents.isDestroyed() && this.urlsMatch(view.webContents.getURL(), expectedUrl)) {
          finish(true);
        }
      };

      const onFail = (_event: any, code: number) => {
        // ERR_ABORTED (-3): reload do servidor/HMR, não falha imediatamente
        if (code === -3) return;
        finish(false);
      };

      timer = setTimeout(() => {
        if (!view.webContents.isDestroyed() && this.urlsMatch(view.webContents.getURL(), expectedUrl)) {
          finish(true);
        } else {
          finish(false);
        }
      }, timeoutMs);

      view.webContents.once("did-finish-load", onFinish);
      view.webContents.once("did-stop-loading", onStop);
      view.webContents.on("did-fail-load", onFail);
    });
  }

  /**
   * PRIORIDADE 2 & 3: Fallback offscreen isolado quando o view interno não estiver disponível.
   * Blindado contra ERR_ABORTED (-3) e contra destruição concorrente com o pipeline de composição.
   */
  private async captureOffscreen(url: string): Promise<electron.NativeImage | null> {
    let win: BrowserWindow | null = null;
    let isAborted = false;

    // PRIORIDADE 3: Limpeza assíncrona segura.
    // NUNCA destrói a janela síncronamente na mesma callstack de navegação/aborto do Chromium.
    const safeCleanupWindow = (targetWin: BrowserWindow | null) => {
      if (!targetWin || targetWin.isDestroyed()) return;
      try {
        if (!targetWin.webContents.isDestroyed()) {
          targetWin.webContents.stop();
        }
      } catch {}
      setImmediate(() => {
        try {
          if (!targetWin.isDestroyed()) {
            targetWin.destroy();
          }
        } catch {}
      });
    };

    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });

      // Intercepta did-fail-load para ERR_ABORTED (-3)
      win.webContents.on("did-fail-load", (_event, errorCode) => {
        if (errorCode === -3) {
          isAborted = true;
          console.log("[ThumbnailService] Navegação offscreen abortada pelo servidor/reload (ERR_ABORTED -3).");
        }
      });

      // Timeout de segurança de 10s para não prender recursos
      const loadPromise = win.loadURL(url).catch((err: any) => {
        const msg = String(err?.message || err);
        if (msg.includes("ERR_ABORTED") || err?.errno === -3) {
          isAborted = true;
          return;
        }
        throw err;
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout ao carregar preview para miniatura")), 10_000)
      );

      await Promise.race([loadPromise, timeoutPromise]);

      if (isAborted) {
        safeCleanupWindow(win);
        win = null;
        return null;
      }

      // Espera um tempo breve (1500ms) para renderização de fontes, estilos e DOM
      await new Promise(r => setTimeout(r, 1500));

      if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && !isAborted) {
        const image = await win.webContents.capturePage();
        return image.isEmpty() ? null : image;
      }
      return null;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes("ERR_ABORTED") || isAborted) {
        console.log(`[ThumbnailService] Captura offscreen ignorada devido a cancelamento/reload (${msg}).`);
      } else {
        console.warn("[ThumbnailService] Captura offscreen falhou:", msg);
      }
      return null;
    } finally {
      if (win) {
        safeCleanupWindow(win);
        win = null;
      }
    }
  }

  private urlsMatch(a: string, b: string): boolean {
    try {
      const uA = new URL(a);
      const uB = new URL(b);
      return uA.origin === uB.origin;
    } catch {
      return a === b;
    }
  }

  private notifyRenderer(): void {
    try {
      const mainWindow = this.mainWindowGetter ? this.mainWindowGetter() : null;
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        void recentProjectsManager.getRecentProjectsWithStatus().then(projects => {
          mainWindow.webContents.send("recent-projects:updated", projects);
        }).catch(() => {});
      }
    } catch {}
  }
}

export const thumbnailService = new ThumbnailService();

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
      // 1. Tenta capturar do WebContentsView interno ativo caso esteja carregado na mesma URL
      let capturedImage: electron.NativeImage | null = null;
      const internalView = this.internalViewGetter ? this.internalViewGetter() : null;

      if (internalView && !internalView.webContents.isDestroyed()) {
        try {
          const currentViewUrl = internalView.webContents.getURL();
          if (currentViewUrl && this.urlsMatch(currentViewUrl, url)) {
            const pageImage = await internalView.webContents.capturePage();
            if (!pageImage.isEmpty()) {
              capturedImage = pageImage;
            }
          }
        } catch {}
      }

      // 2. Se não foi possível capturar do view ativo, usa uma janela offscreen isolada
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

  private async captureOffscreen(url: string): Promise<electron.NativeImage | null> {
    let win: BrowserWindow | null = null;
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

      // Timeout de segurança de 10s para não prender recursos caso a página trave
      const loadPromise = win.loadURL(url);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout ao carregar preview para miniatura")), 10_000)
      );

      await Promise.race([loadPromise, timeoutPromise]);

      // Espera um tempo breve (1500ms) para renderização de fontes, estilos e DOM
      await new Promise(r => setTimeout(r, 1500));

      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        const image = await win.webContents.capturePage();
        return image.isEmpty() ? null : image;
      }
      return null;
    } catch (err) {
      console.warn("[ThumbnailService] Captura offscreen falhou:", err);
      return null;
    } finally {
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch {}
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

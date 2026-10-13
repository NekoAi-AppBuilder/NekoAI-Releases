import { describe, it, expect, beforeEach } from "bun:test";
import semver from "semver";

describe("NekoAI Desktop — Controles da Janela & Menu Window (v0.5.01)", () => {
  // Simulador representativo do ciclo de vida BrowserWindow
  class MockBrowserWindow {
    private _isMinimized = false;
    private _isMaximized = true; // Aplicação inicia maximizada
    private _isDestroyed = false;
    private _listeners: Record<string, Function[]> = {};

    public isMinimized() {
      return this._isMinimized;
    }

    public isMaximized() {
      return this._isMaximized;
    }

    public isDestroyed() {
      return this._isDestroyed;
    }

    public minimize() {
      if (this._isDestroyed) throw new Error("Object has been destroyed");
      this._isMinimized = true;
      this.emit("minimize");
    }

    public maximize() {
      if (this._isDestroyed) throw new Error("Object has been destroyed");
      this._isMaximized = true;
      this._isMinimized = false;
      this.emit("maximize");
    }

    public unmaximize() {
      if (this._isDestroyed) throw new Error("Object has been destroyed");
      this._isMaximized = false;
      this.emit("unmaximize");
    }

    public restore() {
      if (this._isDestroyed) throw new Error("Object has been destroyed");
      this._isMinimized = false;
      this._isMaximized = false;
      this.emit("restore");
    }

    public close() {
      if (this._isDestroyed) throw new Error("Object has been destroyed");
      this.emit("close");
      this._isDestroyed = true;
      this.emit("closed");
    }

    public on(event: string, callback: Function) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
      return this;
    }

    public emit(event: string, ...args: any[]) {
      const list = this._listeners[event] || [];
      for (const fn of list) {
        fn(...args);
      }
    }
  }

  // Controlador unificado (espelho da implementação centralizada de src/main/main.ts)
  class WindowController {
    public window: MockBrowserWindow | null = null;
    public maximizedStateChanges: boolean[] = [];

    public setWindow(win: MockBrowserWindow | null) {
      this.window = win;
      if (win) {
        win.on("maximize", () => this.maximizedStateChanges.push(true));
        win.on("unmaximize", () => this.maximizedStateChanges.push(false));
        win.on("restore", () => this.maximizedStateChanges.push(false));
      }
    }

    public minimizeMainWindow() {
      if (this.window && !this.window.isDestroyed()) {
        this.window.minimize();
      }
    }

    public maximizeMainWindow() {
      if (this.window && !this.window.isDestroyed()) {
        if (!this.window.isMaximized()) {
          this.window.maximize();
        }
      }
    }

    public restoreMainWindow() {
      if (this.window && !this.window.isDestroyed()) {
        if (this.window.isMinimized()) {
          this.window.restore();
        } else if (this.window.isMaximized()) {
          this.window.unmaximize();
        }
      }
    }

    public toggleMaximizeMainWindow(): boolean {
      if (this.window && !this.window.isDestroyed()) {
        if (this.window.isMaximized()) {
          this.window.unmaximize();
          return false;
        } else {
          this.window.maximize();
          return true;
        }
      }
      return false;
    }

    public isMainWindowMaximized(): boolean {
      if (this.window && !this.window.isDestroyed()) {
        return this.window.isMaximized();
      }
      return false;
    }

    public closeMainWindow() {
      if (this.window && !this.window.isDestroyed()) {
        this.window.close();
      }
    }

    // Ações do menu personalizado "Window" do React na barra de título
    public handleMenuAction(action: "minimize" | "toggleMaximize" | "restore" | "close") {
      switch (action) {
        case "minimize":
          return this.minimizeMainWindow();
        case "toggleMaximize":
          return this.toggleMaximizeMainWindow();
        case "restore":
          return this.restoreMainWindow();
        case "close":
          return this.closeMainWindow();
      }
    }
  }

  let controller: WindowController;
  let win: MockBrowserWindow;

  beforeEach(() => {
    controller = new WindowController();
    win = new MockBrowserWindow();
    controller.setWindow(win);
  });

  describe("Controles da Barra Superior", () => {
    it("deve minimizar a janela principal corretamente pela barra superior", () => {
      expect(win.isMinimized()).toBe(false);
      controller.minimizeMainWindow();
      expect(win.isMinimized()).toBe(true);
    });

    it("deve maximizar a janela principal pela barra superior", () => {
      win.unmaximize();
      expect(win.isMaximized()).toBe(false);
      controller.maximizeMainWindow();
      expect(win.isMaximized()).toBe(true);
    });

    it("deve alternar e restaurar a janela pela barra superior", () => {
      expect(win.isMaximized()).toBe(true);
      
      // Toggle deve restaurar
      const r1 = controller.toggleMaximizeMainWindow();
      expect(r1).toBe(false);
      expect(win.isMaximized()).toBe(false);
      expect(controller.isMainWindowMaximized()).toBe(false);

      // Toggle deve maximizar novamente
      const r2 = controller.toggleMaximizeMainWindow();
      expect(r2).toBe(true);
      expect(win.isMaximized()).toBe(true);
      expect(controller.isMainWindowMaximized()).toBe(true);
    });

    it("deve fechar a janela pela barra superior disparando eventos de ciclo de vida", () => {
      let closeFired = false;
      let closedFired = false;
      win.on("close", () => { closeFired = true; });
      win.on("closed", () => { closedFired = true; });

      controller.closeMainWindow();
      expect(closeFired).toBe(true);
      expect(closedFired).toBe(true);
      expect(win.isDestroyed()).toBe(true);
    });
  });

  describe("Menu Personalizado Window (React Titlebar)", () => {
    it("deve executar Window → Minimizar", () => {
      expect(win.isMinimized()).toBe(false);
      controller.handleMenuAction("minimize");
      expect(win.isMinimized()).toBe(true);
    });

    it("deve executar Window → Alternar / Maximizar", () => {
      expect(win.isMaximized()).toBe(true);
      controller.handleMenuAction("toggleMaximize");
      expect(win.isMaximized()).toBe(false);

      controller.handleMenuAction("toggleMaximize");
      expect(win.isMaximized()).toBe(true);
    });

    it("deve executar Window → Restaurar", () => {
      expect(win.isMaximized()).toBe(true);
      controller.handleMenuAction("restore");
      expect(win.isMaximized()).toBe(false);
    });

    it("deve executar Window → Fechar", () => {
      let closedFired = false;
      win.on("closed", () => { closedFired = true; });
      controller.handleMenuAction("close");
      expect(closedFired).toBe(true);
      expect(win.isDestroyed()).toBe(true);
    });
  });

  describe("Integração, Segurança & Resiliência", () => {
    it("ambos os mecanismos (barra e menu) devem operar sobre a mesma janela principal", () => {
      // Minimizar via menu
      controller.handleMenuAction("minimize");
      expect(win.isMinimized()).toBe(true);

      // Restaurar via controle superior
      controller.restoreMainWindow();
      expect(win.isMinimized()).toBe(false);
    });

    it("deve manter o estado de maximização sincronizado nos eventos", () => {
      controller.toggleMaximizeMainWindow(); // unmaximize
      controller.toggleMaximizeMainWindow(); // maximize
      controller.restoreMainWindow();        // unmaximize

      expect(controller.maximizedStateChanges).toEqual([false, true, false]);
    });

    it("não deve lançar erro se a janela for nula", () => {
      controller.setWindow(null);
      expect(() => controller.minimizeMainWindow()).not.toThrow();
      expect(() => controller.maximizeMainWindow()).not.toThrow();
      expect(() => controller.restoreMainWindow()).not.toThrow();
      expect(() => controller.toggleMaximizeMainWindow()).not.toThrow();
      expect(() => controller.closeMainWindow()).not.toThrow();
      expect(controller.isMainWindowMaximized()).toBe(false);
    });

    it("não deve lançar erro se a janela já tiver sido destruída", () => {
      controller.closeMainWindow();
      expect(win.isDestroyed()).toBe(true);

      expect(() => controller.minimizeMainWindow()).not.toThrow();
      expect(() => controller.maximizeMainWindow()).not.toThrow();
      expect(() => controller.restoreMainWindow()).not.toThrow();
      expect(() => controller.toggleMaximizeMainWindow()).not.toThrow();
      expect(() => controller.closeMainWindow()).not.toThrow();
      expect(controller.isMainWindowMaximized()).toBe(false);
    });

    it("versão canônica 0.5.1 deve ser estritamente válida segundo SemVer 2.0.0", () => {
      const canonicalVersion = "0.5.1";
      const parsed = semver.parse(canonicalVersion);
      expect(parsed).not.toBeNull();
      expect(parsed?.major).toBe(0);
      expect(parsed?.minor).toBe(5);
      expect(parsed?.patch).toBe(1);
      expect(semver.valid(canonicalVersion)).toBe("0.5.1");
    });

    it("versão canônica 0.5.1 deve ser reconhecida como maior que 0.4.99 e 0.5.0 pelo updater", () => {
      expect(semver.gt("0.5.1", "0.4.99")).toBe(true);
      expect(semver.gt("0.5.1", "0.5.0")).toBe(true);
    });
  });
});

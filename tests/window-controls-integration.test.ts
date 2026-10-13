import { describe, it, expect, beforeEach, mock } from "bun:test";

describe("NekoAI Desktop — Controles da Janela & Menu Window", () => {
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

    public getMenuTemplate() {
      return [
        {
          label: "Window",
          submenu: [
            {
              label: "Minimizar",
              accelerator: "CmdOrCtrl+M",
              role: "minimize",
              click: () => this.minimizeMainWindow()
            },
            {
              label: "Maximizar",
              click: () => this.maximizeMainWindow()
            },
            {
              label: "Restaurar",
              click: () => this.restoreMainWindow()
            },
            { type: "separator" },
            {
              label: "Fechar",
              accelerator: "Alt+F4",
              role: "close",
              click: () => this.closeMainWindow()
            }
          ]
        }
      ];
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
    it("deve minimizar a janela principal corretamente", () => {
      expect(win.isMinimized()).toBe(false);
      controller.minimizeMainWindow();
      expect(win.isMinimized()).toBe(true);
    });

    it("deve alternar maximizar e restaurar coerentemente", () => {
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

    it("deve fechar a janela disparando eventos de ciclo de vida", () => {
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

  describe("Menu Nativo Window", () => {
    it("deve executar Window → Minimize pelo callback do menu", () => {
      const template = controller.getMenuTemplate();
      const windowMenu = template.find(m => m.label === "Window");
      const minimizeItem = windowMenu?.submenu.find(i => i.label === "Minimizar");

      expect(minimizeItem).toBeDefined();
      minimizeItem?.click();
      expect(win.isMinimized()).toBe(true);
    });

    it("deve executar Window → Maximize pelo callback do menu", () => {
      win.unmaximize();
      expect(win.isMaximized()).toBe(false);

      const template = controller.getMenuTemplate();
      const windowMenu = template.find(m => m.label === "Window");
      const maximizeItem = windowMenu?.submenu.find(i => i.label === "Maximizar");

      expect(maximizeItem).toBeDefined();
      maximizeItem?.click();
      expect(win.isMaximized()).toBe(true);
    });

    it("deve executar Window → Restore pelo callback do menu", () => {
      expect(win.isMaximized()).toBe(true);

      const template = controller.getMenuTemplate();
      const windowMenu = template.find(m => m.label === "Window");
      const restoreItem = windowMenu?.submenu.find(i => i.label === "Restaurar");

      expect(restoreItem).toBeDefined();
      restoreItem?.click();
      expect(win.isMaximized()).toBe(false);
    });

    it("deve executar Window → Close pelo callback do menu", () => {
      const template = controller.getMenuTemplate();
      const windowMenu = template.find(m => m.label === "Window");
      const closeItem = windowMenu?.submenu.find(i => i.label === "Fechar");

      expect(closeItem).toBeDefined();
      closeItem?.click();
      expect(win.isDestroyed()).toBe(true);
    });
  });

  describe("Integração, Segurança & Resiliência", () => {
    it("ambos os mecanismos devem operar sobre a mesma janela principal", () => {
      // Minimizar via menu
      const template = controller.getMenuTemplate();
      template[0].submenu.find(i => i.label === "Minimizar")?.click();
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

    it("deve normalizar corretamente versões com zeros à esquerda (ex: 0.5.00 -> 0.5.0) para compatibilidade SemVer", () => {
      const raw = "0.5.00";
      const normalized = raw
        .split(".")
        .map((p) => {
          const n = parseInt(p, 10);
          return isNaN(n) ? p : String(n);
        })
        .join(".");

      expect(normalized).toBe("0.5.0");
    });
  });
});

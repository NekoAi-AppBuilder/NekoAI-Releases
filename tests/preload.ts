import { test, mock } from "bun:test";

mock.module("electron", () => {
  const electronMock = {
    app: {
      getPath: () => "/tmp",
      setPath: () => {},
      getVersion: () => "1.0.0",
      requestSingleInstanceLock: () => true,
      quit: () => {},
      on: () => {},
      whenReady: async () => {},
    },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: class BrowserWindow {},
    Menu: { buildFromTemplate: () => {}, setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => {} },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: any) => Buffer.from(s),
      decryptString: (b: any) => Buffer.from(b).toString("utf8"),
    },
    shell: { openExternal: async () => {} },
    dialog: { showOpenDialog: async () => {} },
    WebContentsView: class {},
    webFrameMain: class {},
  };
  return {
    ...electronMock,
    default: electronMock,
  };
});

if (typeof (globalThis as any).Deno === "undefined") {
  (globalThis as any).Deno = {
    env: {
      get: (k: string) => process.env[k] || "",
    },
    test: (nameOrFn: any, maybeFn?: any) => {
      const name = typeof nameOrFn === "string" ? nameOrFn : (nameOrFn?.name || "deno test");
      const fn = typeof nameOrFn === "function" ? nameOrFn : maybeFn;
      if (typeof fn === "function") {
        test(name, fn);
      }
    },
  };
}

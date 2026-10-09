import { test, expect, mock, beforeEach, afterEach } from "bun:test";

let lockResult = true;
let quitCalled = false;
let exitCalled = false;
let secondInstanceCallback: any = null;
let restoreCalled = false;
let focusCalled = false;

const originalExit = process.exit;

mock.module("electron", () => {
  return {
    app: {
      getPath: () => "/tmp",
      setPath: () => {},
      getVersion: () => "1.0.0",
      requestSingleInstanceLock: () => lockResult,
      quit: () => { quitCalled = true; },
      on: (event: string, cb: any) => {
        if (event === "second-instance") {
          secondInstanceCallback = cb;
        }
      },
      whenReady: () => Promise.resolve(),
    },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: class {
      isMinimized = () => true;
      restore = () => { restoreCalled = true; };
      focus = () => { focusCalled = true; };
      on = () => {};
      once = () => {};
      loadFile = async () => {};
      loadURL = async () => {};
      webContents = { send: () => {}, openDevTools: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
      maximize = () => {};
      unmaximize = () => {};
      close = () => {};
      isDestroyed = () => false;
      show = () => {};
      setMenu = () => {};
      setProgressBar = () => {};
    },
    Menu: { buildFromTemplate: () => {}, setApplicationMenu: () => {} },
    nativeImage: { createFromPath: () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
    WebContentsView: class {},
    webFrameMain: class {},
    dialog: { showOpenDialog: async () => {} },
    default: {
      app: {
        getPath: () => "/tmp",
        setPath: () => {},
        getVersion: () => "1.0.0",
        requestSingleInstanceLock: () => lockResult,
        quit: () => { quitCalled = true; },
        on: (event: string, cb: any) => {
          if (event === "second-instance") {
            secondInstanceCallback = cb;
          }
        },
        whenReady: () => Promise.resolve(),
      },
      BrowserWindow: class {
        isMinimized = () => true;
        restore = () => { restoreCalled = true; };
        focus = () => { focusCalled = true; };
        on = () => {};
        once = () => {};
        loadFile = async () => {};
        loadURL = async () => {};
        webContents = { send: () => {}, openDevTools: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
        maximize = () => {};
        unmaximize = () => {};
        close = () => {};
        isDestroyed = () => false;
        show = () => {};
        setMenu = () => {};
        setProgressBar = () => {};
      },
    }
  };
});

mock.module("../src/main/license/license-manager", () => {
  return {
    licenseManager: {
      initialize: async () => {},
      setOnStateChange: () => {},
      getState: () => ({}),
      activate: async () => ({}),
      resetDevice: async () => ({}),
      validate: async () => ({}),
      deactivate: async () => ({}),
      shutdown: () => {},
      assertAccess: () => {}
    }
  };
});

mock.module("../src/main/supabase/supabase-manager", () => ({ supabaseManager: { initialize: async () => {}, shutdown: () => {}, on: () => {} } }));
mock.module("../src/main/supabase/migration-manager", () => ({ migrationManager: { initialize: async () => {}, shutdown: () => {}, on: () => {} } }));
mock.module("../src/main/vercel/vercel-manager", () => ({ 
  vercelManager: { initialize: async () => {}, setGitStatusGetter: () => {}, shutdown: () => {}, on: () => {} },
  getSupabaseEnvironmentNames: () => []
}));

mock.module("../src/main/lovable/lovable-cloud-manager", () => ({ 
  lovableCloudManager: { initialize: async () => {}, on: () => {} } 
}));

mock.module("../src/main/app-preferences-manager", () => ({
  appPreferencesManager: {
    getPreferences: () => ({}),
    updatePreferences: () => {},
    on: () => {},
    shutdown: () => {}
  },
  isValidDirectory: () => true
}));

beforeEach(() => {
  lockResult = true;
  quitCalled = false;
  exitCalled = false;
  secondInstanceCallback = null;
  restoreCalled = false;
  focusCalled = false;
  process.exit = ((code: number) => { exitCalled = true; }) as any;
});

afterEach(() => {
  process.exit = originalExit;
});

test("1. primeira instância adquire lock", async () => {
  lockResult = true;
  await import(`../src/main/main.ts?run1=${Date.now()}`);
  expect(quitCalled).toBe(false);
  expect(exitCalled).toBe(false);
  expect(secondInstanceCallback).toBeDefined();
});

test("2. segunda instância detecta lock existente e 3. encerra", async () => {
  lockResult = false;
  await import(`../src/main/main.ts?run2=${Date.now()}`);
  expect(quitCalled).toBe(true);
  expect(exitCalled).toBe(true);
});

test("8. second-instance foca/restaura a janela existente", async () => {
  lockResult = true;
  await import(`../src/main/main.ts?run3=${Date.now()}`);
  expect(secondInstanceCallback).toBeDefined();
  secondInstanceCallback({}, [], "/");
  expect(restoreCalled).toBe(true);
});

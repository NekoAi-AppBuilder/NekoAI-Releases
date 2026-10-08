import { mock } from "bun:test";
mock.module("electron", () => ({
  app: { getPath: () => "/tmp", on: () => {}, whenReady: async () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class BrowserWindow {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
}));

mock.module("../src/main/license/license-device", () => ({
  getStableDeviceId: async () => "mock-device-id"
}));

const saveGrantMock = mock(async () => {});
const clearGrantMock = mock(async () => {});
const loadVaultMock = mock(async () => ({}));
mock.module("../src/main/license/license-vault", () => ({
  licenseVault: {
    saveGrant: saveGrantMock,
    clearGrant: clearGrantMock,
    loadVault: loadVaultMock
  }
}));

const validateMock = mock(async () => ({ ok: true, grant: "valid-grant", key_mask: "abc" }));
mock.module("../src/main/license/license-client", () => ({
  licenseClient: { validate: validateMock }
}));

const verifySignedGrantMock = mock(() => ({ valid: true, state: "VALID", payload: { plan: "TEST", expires_at: new Date(Date.now() + 100000).toISOString() } }));
mock.module("../src/main/license/license-crypto", () => ({
  verifySignedGrant: verifySignedGrantMock
}));

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { LicenseManager } from "../src/main/license/license-manager";

describe("License Lifecycle & Race Conditions", () => {
  let manager: LicenseManager;

  beforeEach(() => {
    manager = new LicenseManager();
    saveGrantMock.mockReset();
    clearGrantMock.mockReset();
    loadVaultMock.mockReset();
    validateMock.mockReset();
    verifySignedGrantMock.mockReset();

    saveGrantMock.mockImplementation(async () => {});
    clearGrantMock.mockImplementation(async () => {});
    loadVaultMock.mockImplementation(async () => ({}));
    validateMock.mockImplementation(async () => ({ ok: true, grant: "valid-grant", key_mask: "abc" }));
    verifySignedGrantMock.mockImplementation(() => ({ valid: true, state: "VALID", payload: { plan: "TEST", expires_at: new Date(Date.now() + 100000).toISOString() } }));
  });

  afterEach(() => {
    manager.shutdown();
  });

  const waitForCondition = async (cond: () => boolean, timeout = 1000) => {
    const start = Date.now();
    while(!cond() && Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 5));
    }
  };

  test("Teste 1 - saveGrant yield: Validation A receives VALID but is interrupted by Validation B setting EXPIRED", async () => {
    let saveGrantResolver: any;
    saveGrantMock.mockImplementation(() => new Promise(resolve => {
      saveGrantResolver = resolve;
    }));

    validateMock.mockImplementationOnce(async () => ({ ok: true, grant: "valid-grant-A" }));

    // Start Validation A
    const valAPromise = manager.validate();
    
    // Wait for it to reach saveGrant
    await waitForCondition(() => !!saveGrantResolver);

    // Force clear the pending promise to simulate another independent validation call or event
    // @ts-ignore
    manager.pendingValidationPromise = null;

    // Start Validation B which sets EXPIRED
    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    const valBPromise = manager.validate();
    
    await valBPromise;

    expect(manager.getState().state).toBe("EXPIRED");

    // Now let saveGrant from Validation A finish
    saveGrantResolver();
    await valAPromise;

    // Result should STILL be EXPIRED, not VALID
    expect(manager.getState().state).toBe("EXPIRED");
  });

  test("Teste 2 - initialize yield: initialize loadVault is interrupted by validate setting EXPIRED", async () => {
    let loadVaultResolver: any;
    loadVaultMock.mockImplementationOnce(() => new Promise(resolve => {
      loadVaultResolver = resolve;
    }));

    // Start initialize
    const initPromise = manager.initialize();
    
    await waitForCondition(() => !!loadVaultResolver);

    // While initialize is waiting for vault, validate runs and sets EXPIRED
    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    await manager.validate();

    expect(manager.getState().state).toBe("EXPIRED");

    // Now let loadVault finish and return a VALID grant
    loadVaultResolver({ grant: "old-valid-grant", keyMask: "abc" });
    await initPromise;

    // Result should STILL be EXPIRED
    expect(manager.getState().state).toBe("EXPIRED");
  });

  test("Teste 3 - heartbeat antigo: heartbeat A is delayed, validation B sets EXPIRED, heartbeat A returns VALID", async () => {
    // Force state to VALID so heartbeat can run logically
    // @ts-ignore
    manager.updateStateDirectly({ state: "VALID", isLicensed: true, entitlements: [], deviceId: "dev1" });
    
    let validateResolver: any;
    validateMock.mockImplementationOnce(() => new Promise(resolve => {
      validateResolver = resolve;
    }));

    // Start Heartbeat Validation A
    const hbPromise = manager.validate();
    
    await waitForCondition(() => !!validateResolver);

    // @ts-ignore
    manager.pendingValidationPromise = null;

    // Validation B
    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    await manager.validate();

    expect(manager.getState().state).toBe("EXPIRED");

    // Heartbeat returns VALID
    validateResolver({ ok: true, grant: "hb-grant" });
    await hbPromise;

    expect(manager.getState().state).toBe("EXPIRED");
  });

  test("Teste 4 - múltiplas validações", async () => {
    let resA: any, resB: any, resC: any;
    validateMock
      .mockImplementationOnce(() => new Promise(r => resA = r))
      .mockImplementationOnce(() => new Promise(r => resB = r))
      .mockImplementationOnce(() => new Promise(r => resC = r));

    const pA = manager.validate();
    await waitForCondition(() => !!resA);

    // @ts-ignore
    manager.pendingValidationPromise = null;
    const pB = manager.validate();
    await waitForCondition(() => !!resB);

    // @ts-ignore
    manager.pendingValidationPromise = null;
    const pC = manager.validate();
    await waitForCondition(() => !!resC);

    // Resolve C with EXPIRED
    resC({ ok: false, error_code: "EXPIRED" });
    await pC;
    expect(manager.getState().state).toBe("EXPIRED");

    // Resolve A with VALID
    resA({ ok: true, grant: "grantA" });
    await pA;
    expect(manager.getState().state).toBe("EXPIRED"); // A is obsolete

    // Resolve B with VALID
    resB({ ok: true, grant: "grantB" });
    await pB;
    expect(manager.getState().state).toBe("EXPIRED"); // B is obsolete
  });

  test("Teste 5 - NORMAL válida", async () => {
    validateMock.mockImplementationOnce(async () => ({ ok: true, grant: "valid" }));
    await manager.validate();
    expect(manager.getState().state).toBe("VALID");
  });

  test("Teste 6 - NORMAL expirada", async () => {
    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    await manager.validate();
    expect(manager.getState().state).toBe("EXPIRED");
  });

  test("Teste 7 - TEST válida", async () => {
    verifySignedGrantMock.mockReturnValueOnce({ valid: true, state: "VALID", payload: { plan: "TEST", expires_at: new Date(Date.now() + 100000).toISOString() } });
    validateMock.mockImplementationOnce(async () => ({ ok: true, grant: "test-valid" }));
    await manager.validate();
    expect(manager.getState().state).toBe("VALID");
  });

  test("Teste 8 - TEST expirada", async () => {
    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    await manager.validate();
    expect(manager.getState().state).toBe("EXPIRED");
  });

  test("Teste 9 - renovação", async () => {
    // 1. Expired
    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    await manager.validate();
    expect(manager.getState().state).toBe("EXPIRED");

    // 2. Renewal legitimate validation
    // @ts-ignore
    manager.pendingValidationPromise = null;
    validateMock.mockImplementationOnce(async () => ({ ok: true, grant: "new-valid-grant" }));
    await manager.validate();
    expect(manager.getState().state).toBe("VALID");
  });

  test("Teste 10 - grant antigo após renovação", async () => {
    let resOld: any;
    validateMock.mockImplementationOnce(() => new Promise(r => resOld = r));
    const pOld = manager.validate();

    await waitForCondition(() => !!resOld);

    // @ts-ignore
    manager.pendingValidationPromise = null;
    
    // New validation
    validateMock.mockImplementationOnce(async () => ({ ok: true, grant: "new-valid" }));
    await manager.validate();
    expect(manager.getState().state).toBe("VALID");

    // Old validation returns EXPIRED
    resOld({ ok: false, error_code: "EXPIRED" });
    await pOld;

    // Should still be VALID because the old EXPIRED is obsolete
    expect(manager.getState().state).toBe("VALID");
  });

  test("Teste 11 - clearGrant race", async () => {
    let clearGrantResolver: any;
    clearGrantMock.mockImplementation(() => new Promise(resolve => {
      clearGrantResolver = resolve;
    }));

    validateMock.mockImplementationOnce(async () => ({ ok: false, error_code: "EXPIRED" }));
    const valPromise = manager.validate();

    await waitForCondition(() => !!clearGrantResolver);

    // Force a new validation that sets VALID
    // @ts-ignore
    manager.pendingValidationPromise = null;
    validateMock.mockImplementationOnce(async () => ({ ok: true, grant: "valid" }));
    await manager.validate();

    expect(manager.getState().state).toBe("VALID");

    // Old validation finishes clearGrant
    clearGrantResolver();
    await valPromise;

    // Should STILL be VALID because the old clearGrant shouldn't set EXPIRED after being obsoleted
    expect(manager.getState().state).toBe("VALID");
  });

});

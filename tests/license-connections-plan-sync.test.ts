import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { StoredLicenseVault } from "../src/main/license/license-types";

describe("NekoAI — Plan Localization & Multi-Device Connections Synchronization", () => {
  // Teste unitário da função de tradução de planos (espelho da lógica do renderer)
  const formatLicensePlan = (plan?: string, licenseType?: string, keyMask?: string): string => {
    if (
      String(licenseType || "").toUpperCase() === "TEST" ||
      String(keyMask || "").toUpperCase().startsWith("NEKO-TEST-") ||
      String(plan || "").toUpperCase() === "TEST" ||
      String(plan || "").toUpperCase() === "TESTE"
    ) {
      return "Teste";
    }
    if (!plan) return "Anual";
    const p = plan.toUpperCase().trim();
    if (p === "MONTHLY" || p === "MENSAL") return "Mensal";
    if (p === "QUARTERLY" || p === "TRIMESTRAL") return "Trimestral";
    if (p === "ANNUAL" || p === "YEARLY" || p === "ANUAL") return "Anual";
    return plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
  };

  test("Tradução do Plano exibe Português do Brasil para todos os planos suportados", () => {
    expect(formatLicensePlan("MONTHLY")).toBe("Mensal");
    expect(formatLicensePlan("monthly")).toBe("Mensal");
    expect(formatLicensePlan("MENSAL")).toBe("Mensal");

    expect(formatLicensePlan("QUARTERLY")).toBe("Trimestral");
    expect(formatLicensePlan("quarterly")).toBe("Trimestral");
    expect(formatLicensePlan("TRIMESTRAL")).toBe("Trimestral");

    expect(formatLicensePlan("ANNUAL")).toBe("Anual");
    expect(formatLicensePlan("yearly")).toBe("Anual");
    expect(formatLicensePlan("ANUAL")).toBe("Anual");
    expect(formatLicensePlan("")).toBe("Anual");
    expect(formatLicensePlan(undefined)).toBe("Anual");

    expect(formatLicensePlan("TEST")).toBe("Teste");
    expect(formatLicensePlan("test")).toBe("Teste");
    expect(formatLicensePlan("TESTE")).toBe("Teste");
    expect(formatLicensePlan("teste")).toBe("Teste");

    // Casos em que o plano vem como MONTHLY no banco mas license_type é TEST (ou variações)
    expect(formatLicensePlan("MONTHLY", "TEST")).toBe("Teste");
    expect(formatLicensePlan("MONTHLY", "test")).toBe("Teste");
    expect(formatLicensePlan("MONTHLY", undefined, "NEKO-TEST-1234-5678-9012")).toBe("Teste");
    expect(formatLicensePlan("MONTHLY", "NORMAL", "NEKO-TEST-1234-5678-9012")).toBe("Teste");
    expect(formatLicensePlan("MONTHLY", "NORMAL")).toBe("Mensal");
  });

  const mockDeviceId = "fceed880a2dba2bdd8307e98af6b541a";
  let mockVaultStore: StoredLicenseVault | null = null;

  const saveGrantMock = mock(async (grant: string, keyMask?: string, maxDevices?: number, activeDevices?: number) => {
    mockVaultStore = {
      grant,
      keyMask,
      savedAt: new Date().toISOString(),
      version: 1,
      maxDevices,
      activeDevices,
    };
  });

  const clearGrantMock = mock(async () => {
    mockVaultStore = null;
  });

  const loadVaultMock = mock(async () => mockVaultStore);

  mock.module("../src/main/license/license-vault", () => ({
    licenseVault: {
      saveGrant: saveGrantMock,
      clearGrant: clearGrantMock,
      loadVault: loadVaultMock,
      getVaultPath: () => "/mock/path/neko-license.json",
    },
  }));

  mock.module("../src/main/license/license-device", () => ({
    getStableDeviceId: async () => mockDeviceId,
  }));

  const activateHttpMock = mock(async (key: string, deviceId: string) => ({
    ok: true,
    grant: "mock-valid-grant",
    expires_at: "2027-08-31T00:00:00+00:00",
    plan: "MONTHLY",
    key_mask: "NEKO-****-SYNC",
    max_devices: 4,
    active_devices: 1,
  }));

  const validateHttpMock = mock(async (deviceId: string, grant?: string, licenseId?: string) => ({
    ok: true,
    grant: "mock-valid-grant",
    expires_at: "2027-08-31T00:00:00+00:00",
    plan: "MONTHLY",
    key_mask: "NEKO-****-SYNC",
    max_devices: 4,
    active_devices: 2,
  }));

  mock.module("../src/main/license/license-client", () => ({
    licenseClient: {
      activate: activateHttpMock,
      validate: validateHttpMock,
      resetDevice: mock(async () => ({ ok: true })),
      deactivate: mock(async () => ({ ok: true })),
    },
  }));

  const actualCrypto = require("../src/main/license/license-crypto");
  mock.module("../src/main/license/license-crypto", () => ({
    ...actualCrypto,
    verifySignedGrant: (grant: string, expectedDeviceId: string) => {
      if (grant === "mock-valid-grant") {
        return {
          valid: true,
          state: "VALID",
          payload: {
            jti: "test-jti-sync",
            iss: "https://nekoai.app/auth",
            aud: "nekoai-desktop-client",
            license_id: "sync-license-1234",
            user_id: "00000000-0000-0000-0000-000000000000",
            device_id: expectedDeviceId,
            plan: "MONTHLY",
            status: "active",
            entitlements: ["ai-full"],
            issued_at: new Date().toISOString(),
            expires_at: "2027-08-31T00:00:00+00:00",
            grace_until: "2027-08-31T00:00:00+00:00",
            version: 1,
            kid: "neko-key-v1",
          },
        };
      }
      return actualCrypto.verifySignedGrant(grant, expectedDeviceId);
    },
    serializeCanonicalGrantPayload: actualCrypto.serializeCanonicalGrantPayload,
  }));

  test("LicenseManager propaga maxDevices e activeDevices no activate() e persiste no vault", async () => {
    mockVaultStore = null;
    const { LicenseManager } = await import("../src/main/license/license-manager");
    const manager = new LicenseManager();
    await manager.initialize();
    if ((manager as any).pendingValidationPromise) {
      await (manager as any).pendingValidationPromise;
    }

    const activateRes = await manager.activate("NEKO-1234-5678-9012-3456");
    expect(activateRes.ok).toBe(true);
    expect(activateRes.max_devices).toBe(4);
    expect(activateRes.active_devices).toBe(1);

    const state = manager.getState();
    expect(state.state).toBe("VALID");
    expect(state.maxDevices).toBe(4);
    expect(state.activeDevices).toBe(1);

    expect(mockVaultStore?.maxDevices).toBe(4);
    expect(mockVaultStore?.activeDevices).toBe(1);
    manager.stopHeartbeat();
  });

  test("LicenseManager restaura maxDevices e activeDevices do cofre na inicialização", async () => {
    mockVaultStore = {
      grant: "mock-valid-grant",
      keyMask: "NEKO-****-SYNC",
      savedAt: new Date().toISOString(),
      version: 1,
      maxDevices: 4,
      activeDevices: 2,
    };

    const { LicenseManager } = await import("../src/main/license/license-manager");
    const manager = new LicenseManager();
    const initState = await manager.initialize();

    expect(initState.state).toBe("VALID");
    expect(initState.maxDevices).toBe(4);
    expect(initState.activeDevices).toBe(2);
    manager.stopHeartbeat();
  });

  test("LicenseManager atualiza activeDevices dinamicamente durante validate()", async () => {
    mockVaultStore = {
      grant: "mock-valid-grant",
      keyMask: "NEKO-****-SYNC",
      savedAt: new Date().toISOString(),
      version: 1,
      maxDevices: 4,
      activeDevices: 1,
    };

    validateHttpMock.mockImplementationOnce(async () => ({
      ok: true,
      grant: "mock-valid-grant",
      max_devices: 4,
      active_devices: 3,
    }));

    const { LicenseManager } = await import("../src/main/license/license-manager");
    const manager = new LicenseManager();
    await manager.initialize();

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(true);

    const state = manager.getState();
    expect(state.maxDevices).toBe(4);
    expect(state.activeDevices).toBe(3);
    expect(mockVaultStore?.activeDevices).toBe(3);
    manager.stopHeartbeat();
  });

  test("Licença de teste (license_type=TEST e plan=MONTHLY no banco) resolve para plan='TEST' e exibe 'Teste'", async () => {
    mockVaultStore = null;
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: true,
      grant: "mock-valid-grant",
      plan: "MONTHLY",
      license_type: "TEST",
      max_devices: 1,
      active_devices: 1,
    }));

    const { LicenseManager } = await import("../src/main/license/license-manager");
    const manager = new LicenseManager();
    await manager.initialize();
    if ((manager as any).pendingValidationPromise) {
      await (manager as any).pendingValidationPromise;
    }

    const state = manager.getState();
    expect(state.plan).toBe("TEST");
    expect(state.licenseType).toBe("TEST");
    expect(formatLicensePlan(state.plan, state.licenseType, state.keyMask)).toBe("Teste");
    manager.stopHeartbeat();
  });

  test("Licença de teste gerada no padrão aleatório oficial (ex: NEKO-63YH-YCQM-HPBW-HLDH) resolve e exibe 'Teste'", async () => {
    mockVaultStore = null;
    activateHttpMock.mockImplementationOnce(async () => ({
      ok: true,
      grant: "mock-valid-grant",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      plan: "TEST",
      license_type: "TEST",
      key_mask: "NEKO-****-****-****-HLDH",
      max_devices: 1,
      active_devices: 1,
    }));

    const { LicenseManager } = await import("../src/main/license/license-manager");
    const manager = new LicenseManager();
    await manager.initialize();
    if ((manager as any).pendingValidationPromise) {
      await (manager as any).pendingValidationPromise;
    }

    const activateRes = await manager.activate("NEKO-63YH-YCQM-HPBW-HLDH");
    expect(activateRes.ok).toBe(true);

    const state = manager.getState();
    expect(state.plan).toBe("TEST");
    expect(state.licenseType).toBe("TEST");
    expect(state.keyMask).toBe("NEKO-****-****-****-HLDH");
    expect(formatLicensePlan(state.plan, state.licenseType, state.keyMask)).toBe("Teste");
    manager.stopHeartbeat();
  });
});

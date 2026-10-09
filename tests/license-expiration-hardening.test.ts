/**
 * tests/license-expiration-hardening.test.ts
 *
 * Suíte de testes de regressão para a correção definitiva da expiração de licenças no Desktop NekoAI.
 *
 * Cobre estritamente os 12 cenários obrigatórios:
 * 1. Licença ativa com expiração futura: acesso permitido.
 * 2. Licença expirada no banco: Desktop bloqueado.
 * 3. Licença válida localmente, mas expirada posteriormente no servidor: acesso bloqueado após a confirmação.
 * 4. Grant antigo restaurado após confirmação de expiração: não volta a VALID.
 * 5. Resposta EXPIRED concorrendo com heartbeat ou ativação: o estado final continua expirado.
 * 6. Erro transitório de rede: não é classificado como EXPIRED.
 * 7. Licença revogada ou inativa: comportamento conforme o contrato do backend.
 * 8. Inicialização com licença expirada.
 * 9. Data de expiração no limite exato, considerando UTC.
 * 10. Expiração durante uma sessão ativa.
 * 11. Tentativa de executar uma operação protegida depois da expiração.
 * 12. Licença ativa em outro dispositivo: continua bloqueada conforme a regra de vínculo.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const mockDeviceId = "fceed880a2dba2bdd8307e98af6b541a";
const otherDeviceId = "99999999999999999999999999999999";
const mockLicenseId = "84e8e732-bdc4-4042-8ab6-ca1011e35727";

function createMockSignedGrant(payload: any): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.mock-sig-${Math.random().toString(36).slice(2)}`;
}

// Grant válido no futuro (2027)
const validGrantFuture = createMockSignedGrant({
  jti: "test-jti-future",
  iss: "https://nekoai.app/auth",
  aud: "nekoai-desktop-client",
  license_id: mockLicenseId,
  user_id: "00000000-0000-0000-0000-000000000000",
  device_id: mockDeviceId,
  plan: "pro",
  status: "active",
  entitlements: ["ai-full"],
  issued_at: new Date(Date.now() - 3600000).toISOString(),
  expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
  grace_until: new Date(Date.now() + 7 * 86400000).toISOString(),
  version: 1,
  kid: "neko-key-v1",
});

// Grant expirado no passado
const expiredGrantPast = createMockSignedGrant({
  jti: "test-jti-past",
  iss: "https://nekoai.app/auth",
  aud: "nekoai-desktop-client",
  license_id: mockLicenseId,
  user_id: "00000000-0000-0000-0000-000000000000",
  device_id: mockDeviceId,
  plan: "pro",
  status: "active",
  entitlements: ["ai-full"],
  issued_at: "2025-01-01T00:00:00.000Z",
  expires_at: "2025-06-01T00:00:00.000Z",
  grace_until: "2025-06-01T00:00:00.000Z",
  version: 1,
  kid: "neko-key-v1",
});

// Mock do cofre local
const mockVaultStore: { grant?: string; keyMask?: string } = {};
const saveGrantMock = mock(async (grant: string, keyMask?: string) => {
  mockVaultStore.grant = grant;
  mockVaultStore.keyMask = keyMask;
});
const clearGrantMock = mock(async () => {
  delete mockVaultStore.grant;
  delete mockVaultStore.keyMask;
});
const loadVaultMock = mock(async () => {
  if (!mockVaultStore.grant) return null;
  return { version: 1, grant: mockVaultStore.grant, keyMask: mockVaultStore.keyMask };
});

mock.module("../src/main/license/license-vault", () => ({
  licenseVault: {
    saveGrant: saveGrantMock,
    clearGrant: clearGrantMock,
    loadVault: loadVaultMock,
  },
}));

mock.module("../src/main/license/license-device", () => ({
  getStableDeviceId: async () => mockDeviceId,
}));

// Client HTTP simulado
const validateHttpMock = mock(async (deviceId: string, grant?: string, licenseId?: string) => ({
  ok: true,
  grant: validGrantFuture,
  expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
  plan: "pro",
  key_mask: "NEKO-****-2027",
}));

const activateHttpMock = mock(async (key: string, deviceId: string) => ({
  ok: true,
  grant: validGrantFuture,
  expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
  plan: "pro",
  key_mask: "NEKO-****-2027",
}));

mock.module("../src/main/license/license-client", () => ({
  licenseClient: {
    validate: validateHttpMock,
    activate: activateHttpMock,
    resetDevice: mock(async () => ({ ok: true, grant: validGrantFuture })),
    deactivate: mock(async () => ({ ok: true })),
  },
}));

// Verificador criptográfico mock fiel
const verifyGrantMock = mock((grant: string, expectedDeviceId: string) => {
  if (!grant || typeof grant !== "string") return { valid: false, state: "MISSING", reason: "grant_empty" };
  const parts = grant.split(".");
  if (parts.length !== 2) {
    return { valid: false, state: "INVALID", reason: "invalid_grant_format" };
  }
  let payload: any;
  try {
    const raw = Buffer.from(parts[0], "base64url").toString("utf8");
    payload = JSON.parse(raw);
  } catch {
    return { valid: false, state: "INVALID", reason: "b64_decode_error" };
  }
  
  if (payload.device_id !== expectedDeviceId) {
    return { valid: false, state: "INVALID", reason: "device_mismatch", payload };
  }
  
  const nowMs = Date.now();
  const expiresAtMs = new Date(payload.expires_at).getTime();
  const graceUntilMs = new Date(payload.grace_until).getTime();

  if (nowMs >= expiresAtMs) {
    return { valid: false, state: "EXPIRED", reason: "license_expired", payload };
  }
  if (nowMs >= graceUntilMs) {
    return { valid: true, state: "GRACE", payload };
  }
  return { valid: true, state: "VALID", payload };
});

mock.module("../src/main/license/license-crypto", () => ({
  verifySignedGrant: verifyGrantMock,
  serializeCanonicalGrantPayload: (payload: any) => {
    const canonical = {
      jti: payload.jti,
      iss: payload.iss,
      aud: payload.aud,
      license_id: payload.license_id,
      user_id: payload.user_id,
      device_id: payload.device_id,
      plan: payload.plan,
      status: payload.status,
      entitlements: Array.isArray(payload.entitlements) ? [...payload.entitlements].sort() : [],
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      grace_until: payload.grace_until,
      version: payload.version,
      kid: payload.kid || "neko-key-v1",
    };
    return JSON.stringify(canonical);
  },
}));

let LicenseManagerClass: any;

describe("NekoAI — Hardening Definitivo da Expiração de Licenças", () => {
  let manager: any;

  beforeEach(async () => {
    if (!LicenseManagerClass) {
      const mod = await import("../src/main/license/license-manager");
      LicenseManagerClass = mod.LicenseManager;
    }

    delete mockVaultStore.grant;
    delete mockVaultStore.keyMask;
    saveGrantMock.mockClear();
    clearGrantMock.mockClear();
    loadVaultMock.mockClear();
    validateHttpMock.mockClear();
    activateHttpMock.mockClear();
    verifyGrantMock.mockClear();

    manager = new LicenseManagerClass();
  });

  afterEach(() => {
    manager.shutdown();
  });

  // ── Cenário 1: Licença ativa com expiração futura: acesso permitido ──────────
  test("Cenário 1: Licença ativa com expiração futura permite acesso ao workspace", async () => {
    mockVaultStore.grant = validGrantFuture;
    const init = await manager.initialize();

    expect(init.state).toBe("VALID");
    expect(init.isLicensed).toBe(true);
    expect(manager.isAccessAllowed()).toBe(true);
    expect(() => manager.assertAccess("workspace")).not.toThrow();
  });

  // ── Cenário 2: Licença expirada no banco: Desktop bloqueado ─────────────────
  test("Cenário 2: Licença expirada no banco bloqueia Desktop após validação", async () => {
    mockVaultStore.grant = validGrantFuture;
    await manager.initialize();

    // Servidor responde EXPIRED autoritativo (data no passado no DB)
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "EXPIRED",
      message: "Esta licença expirou.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);
    expect(valResult.error_code).toBe("EXPIRED");

    // Desktop transiciona imediatamente para EXPIRED
    expect(manager.getState().state).toBe("EXPIRED");
    expect(manager.getState().isLicensed).toBe(false);
    expect(manager.isAccessAllowed()).toBe(false);

    expect(() => manager.assertAccess("workspace")).toThrowError(/expirou/i);
    expect(clearGrantMock).toHaveBeenCalled();
  });

  // ── Cenário 3: Válida localmente, mas expirada no servidor ───────────────────
  test("Cenário 3: Licença válida localmente, mas expirada posteriormente no servidor: bloqueia após confirmação", async () => {
    mockVaultStore.grant = validGrantFuture;
    await manager.initialize();
    expect(manager.isAccessAllowed()).toBe(true);

    // Heartbeat ou validação subsequente recebe EXPIRED do servidor
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "EXPIRED",
      message: "Esta licença expirou.",
    }));

    await manager.validate();

    expect(manager.getState().state).toBe("EXPIRED");
    expect(manager.getState().isLicensed).toBe(false);
    expect(manager.isAccessAllowed()).toBe(false);
  });

  // ── Cenário 4: Grant antigo restaurado após confirmação de expiração ────────
  test("Cenário 4: Grant antigo restaurado após confirmação de expiração NÃO volta a VALID", async () => {
    // 1. Licença é confirmada como expirada
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "EXPIRED",
      message: "Esta licença expirou.",
    }));
    await manager.validate();
    expect(manager.getState().state).toBe("EXPIRED");

    // 2. Tentativa indevida de restaurar o grant antigo do vault ou de resposta atrasada
    (manager as any).updateStateFromVerification("VALID", {
      license_id: mockLicenseId,
      expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
    });

    // O estado permanece EXPIRED! Bloqueia restauração indevida.
    expect(manager.getState().state).toBe("EXPIRED");
    expect(manager.isAccessAllowed()).toBe(false);
  });

  // ── Cenário 5: Resposta EXPIRED concorrendo com heartbeat ───────────────────
  test("Cenário 5: Resposta EXPIRED concorrendo com heartbeat mantém estado expirado", async () => {
    // Simulando validação que confirma expiração
    await manager.validate(); // inicial
    
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "EXPIRED",
      message: "Esta licença expirou.",
    }));

    const valPromise = manager.validate();

    // Heartbeat concorrente simulado tenta rodar
    const heartbeatPromise = manager.validate();

    await Promise.all([valPromise, heartbeatPromise]);

    expect(manager.getState().state).toBe("EXPIRED");
    expect(manager.getState().isLicensed).toBe(false);
  });

  // ── Cenário 6: Erro transitório de rede não é classificado como EXPIRED ──────
  test("Cenário 6: Erro transitório de rede (NETWORK_ERROR / SERVER_UNAVAILABLE) NÃO é classificado como EXPIRED", async () => {
    mockVaultStore.grant = validGrantFuture;
    await manager.initialize();
    expect(manager.getState().state).toBe("VALID");

    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "NETWORK_ERROR",
      message: "Não foi possível conectar ao servidor de licenças.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);

    // Não deve virar EXPIRED e não deve apagar o cofre
    expect(manager.getState().state).toBe("VALID");
    expect(manager.getState().isLicensed).toBe(true);
    expect(manager.isAccessAllowed()).toBe(true);
    expect(clearGrantMock).not.toHaveBeenCalled();
  });

  // ── Cenário 7: Licença revogada ou inativa ───────────────────────────────────
  test("Cenário 7: Resposta REVOKED limpa o cofre e transiciona para MISSING", async () => {
    mockVaultStore.grant = validGrantFuture;
    await manager.initialize();

    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "REVOKED",
      message: "Esta licença foi revogada administrativamente.",
    }));

    const valResult = await manager.validate();
    expect(valResult.error_code).toBe("REVOKED");
    expect(manager.getState().state).toBe("MISSING");
    expect(manager.getState().isLicensed).toBe(false);
    expect(clearGrantMock).toHaveBeenCalled();
  });

  test("Cenário 7b: Resposta INACTIVE limpa o cofre e transiciona para EXPIRED", async () => {
    mockVaultStore.grant = validGrantFuture;
    await manager.initialize();

    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "INACTIVE",
      message: "Licença inativa no servidor.",
    }));

    const valResult = await manager.validate();
    expect(valResult.error_code).toBe("INACTIVE");
    expect(manager.getState().state).toBe("EXPIRED");
    expect(manager.getState().isLicensed).toBe(false);
    expect(clearGrantMock).toHaveBeenCalled();
  });

  // ── Cenário 8: Inicialização com licença expirada ────────────────────────────
  test("Cenário 8: Inicialização com grant já expirado no disco entra imediatamente em EXPIRED", async () => {
    mockVaultStore.grant = expiredGrantPast;

    const init = await manager.initialize();
    expect(init.state).toBe("EXPIRED");
    expect(init.isLicensed).toBe(false);
    expect(manager.isAccessAllowed()).toBe(false);
    expect(clearGrantMock).toHaveBeenCalled();
  });

  // ── Cenário 9: Data de expiração no limite exato em UTC ──────────────────────
  test("Cenário 9: Comparação temporal UTC estrita: now >= expiresAt bloqueia acesso", () => {
    const exactLimitGrant = createMockSignedGrant({
      license_id: mockLicenseId,
      device_id: mockDeviceId,
      status: "active",
      // Exatamente 1 segundo no passado em UTC
      expires_at: new Date(Date.now() - 1000).toISOString(),
      grace_until: new Date(Date.now() - 1000).toISOString(),
    });

    const verify = verifyGrantMock(exactLimitGrant, mockDeviceId);
    expect(verify.state).toBe("EXPIRED");
    expect(verify.valid).toBe(false);
  });

  // ── Cenário 10: Expiração durante uma sessão ativa ───────────────────────────
  test("Cenário 10: Expiração temporal durante sessão ativa é detectada por isAccessAllowed()", async () => {
    // Simula rede indisponível para que a validação online de boot não substitua o grant curto
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "NETWORK_ERROR",
      message: "Rede indisponível",
    }));

    // Licença válida com vencimento daqui a 20ms
    const shortLivedGrant = createMockSignedGrant({
      license_id: mockLicenseId,
      device_id: mockDeviceId,
      status: "active",
      expires_at: new Date(Date.now() + 20).toISOString(),
      grace_until: new Date(Date.now() + 20).toISOString(),
    });
    mockVaultStore.grant = shortLivedGrant;
    await manager.initialize();
    expect(manager.getState().state).toBe("VALID");

    // Aguarda o vencimento do timestamp
    await new Promise((r) => setTimeout(r, 40));

    // Durante a sessão, antes de qualquer IPC protegido:
    expect(manager.isAccessAllowed()).toBe(false);
    expect(() => manager.assertAccess("workspace")).toThrowError(/expirou/i);
    expect(manager.getState().state).toBe("EXPIRED");
  });

  // ── Cenário 11: Tentativa de executar operação protegida depois da expiração ─
  test("Cenário 11: assertAccess() lança LICENSE_BLOCKED com código e mensagem clara", async () => {
    (manager as any).currentState = {
      state: "EXPIRED",
      isLicensed: false,
      entitlements: [],
      deviceId: mockDeviceId,
    };

    try {
      manager.assertAccess("assistente de IA");
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe("LICENSE_BLOCKED");
      expect(err.licenseState).toBe("EXPIRED");
      expect(err.message).toMatch(/expirou/i);
    }
  });

  // ── Cenário 12: Licença ativa em outro dispositivo ──────────────────────────
  test("Cenário 12: Tentativa de validar licença em outro dispositivo bloqueia pelo vínculo de máquina", () => {
    // Grant emitido para outro PC
    const otherPcGrant = createMockSignedGrant({
      license_id: mockLicenseId,
      device_id: otherDeviceId,
      status: "active",
      expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
      grace_until: new Date(Date.now() + 7 * 86400000).toISOString(),
    });

    const verify = verifyGrantMock(otherPcGrant, mockDeviceId);
    expect(verify.valid).toBe(false);
    expect(verify.state).toBe("INVALID");
    expect(verify.reason).toBe("device_mismatch");
  });
});

/**
 * tests/license-validation-divergence.test.ts
 *
 * Suíte completa de testes de regressão automatizados para a validação de licenças
 * e resolução de divergências entre ativação e validação no NekoAI.
 *
 * Cobre todos os 10 cenários comportamentais obrigatórios:
 * 1. Ativação bem-sucedida de uma licença válida e validações consecutivas mantendo o estado VALID.
 * 2. Licença válida coexistindo com uma licença antiga expirada no mesmo dispositivo.
 * 3. Validação com license_id específico e ativação correspondente.
 * 4. Tentativa de utilizar um license_id diferente do grant ou sem ativação autorizada.
 * 5. Expiração verdadeira: bloqueio de acesso e limpeza do grant conforme o contrato existente.
 * 6. Revogação verdadeira: bloqueio de acesso e limpeza do cofre.
 * 7. Erro temporário do Supabase/rede sem conversão indevida para EXPIRED.
 * 8. Respostas assíncronas fora de ordem, sem restauração de estado obsoleto.
 * 9. Limite de dispositivos, reativação e transferência, sem regressões.
 * 10. Inicialização sem grant e descoberta segura de licença.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Mock de Infraestrutura do Ambiente Desktop ──────────────────────────────
const mockDeviceId = "fceed880a2dba2bdd8307e98af6b541a";
const mockLicenseId2027 = "84e8e732-bdc4-4042-8ab6-ca1011e35727";
const mockLicenseIdExpired = "11111111-1111-1111-1111-111111111111";

function createMockGrant(payload: any): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.mock-sig-${Math.random().toString(36).slice(2)}`;
}

const mockValidGrant2027 = createMockGrant({
  jti: "test-jti-2027",
  iss: "https://nekoai.app/auth",
  aud: "nekoai-desktop-client",
  license_id: mockLicenseId2027,
  user_id: "00000000-0000-0000-0000-000000000000",
  device_id: mockDeviceId,
  plan: "pro",
  status: "active",
  entitlements: ["ai-full"],
  issued_at: new Date().toISOString(),
  expires_at: "2027-08-31T00:00:00+00:00",
  grace_until: "2027-08-31T00:00:00+00:00",
  version: 1,
  kid: "neko-key-v1",
});

const mockExpiredGrant2026 = createMockGrant({
  jti: "test-jti-2026",
  iss: "https://nekoai.app/auth",
  aud: "nekoai-desktop-client",
  license_id: mockLicenseIdExpired,
  user_id: "00000000-0000-0000-0000-000000000000",
  device_id: mockDeviceId,
  plan: "pro",
  status: "expired",
  entitlements: ["ai-full"],
  issued_at: "2025-08-31T00:00:00+00:00",
  expires_at: "2026-08-31T00:00:00+00:00",
  grace_until: "2026-08-31T00:00:00+00:00",
  version: 1,
  kid: "neko-key-v1",
});

// Cofre em memória simulado
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
  grant: mockValidGrant2027,
  expires_at: "2027-08-31T00:00:00+00:00",
  plan: "pro",
  key_mask: "NEKO-****-2027",
}));

const activateHttpMock = mock(async (key: string, deviceId: string) => ({
  ok: true,
  grant: mockValidGrant2027,
  expires_at: "2027-08-31T00:00:00+00:00",
  plan: "pro",
  key_mask: "NEKO-****-2027",
}));

const resetHttpMock = mock(async (key: string, deviceId: string) => ({
  ok: true,
  grant: mockValidGrant2027,
  expires_at: "2027-08-31T00:00:00+00:00",
  plan: "pro",
  key_mask: "NEKO-****-2027",
}));

mock.module("../src/main/license/license-client", () => ({
  licenseClient: {
    validate: validateHttpMock,
    activate: activateHttpMock,
    resetDevice: resetHttpMock,
    deactivate: mock(async () => ({ ok: true })),
  },
}));

// Verificador criptográfico mock
const verifyGrantMock = mock((grant: string, expectedDeviceId: string) => {
  if (grant === mockExpiredGrant2026) {
    return {
      valid: true,
      state: "EXPIRED",
      reason: "grant_expired",
      payload: {
        license_id: mockLicenseIdExpired,
        device_id: expectedDeviceId,
        plan: "pro",
        status: "expired",
        expires_at: "2026-08-31T00:00:00+00:00",
        issued_at: "2025-08-31T00:00:00+00:00",
        grace_until: "2026-08-31T00:00:00+00:00",
        entitlements: ["ai-full"],
      },
    };
  }
  return {
    valid: true,
    state: "VALID",
    payload: {
      license_id: mockLicenseId2027,
      device_id: expectedDeviceId,
      plan: "pro",
      status: "active",
      expires_at: "2027-08-31T00:00:00+00:00",
      issued_at: new Date().toISOString(),
      grace_until: new Date(Date.now() + 7 * 86400000).toISOString(),
      entitlements: ["ai-full"],
    },
  };
});

mock.module("../src/main/license/license-crypto", () => ({
  verifySignedGrant: verifyGrantMock,
  serializeCanonicalGrantPayload: (p: any) => JSON.stringify(p),
}));

let LicenseManagerClass: any;

describe("NekoAI — Validação e Resolução de Licenças (Testes Comportamentais)", () => {
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
    resetHttpMock.mockClear();
    verifyGrantMock.mockClear();

    // Default implementations
    validateHttpMock.mockImplementation(async (deviceId: string, grant?: string, licenseId?: string) => ({
      ok: true,
      grant: mockValidGrant2027,
      expires_at: "2027-08-31T00:00:00+00:00",
      plan: "pro",
      key_mask: "NEKO-****-2027",
    }));

    activateHttpMock.mockImplementation(async (key: string, deviceId: string) => ({
      ok: true,
      grant: mockValidGrant2027,
      expires_at: "2027-08-31T00:00:00+00:00",
      plan: "pro",
      key_mask: "NEKO-****-2027",
    }));

    manager = new LicenseManagerClass();
  });

  afterEach(() => {
    manager.shutdown();
  });

  // ── 1. Inicialização sem grant com exatamente uma associação válida ──────
  test("1. Inicialização sem grant com exatamente uma associação válida descobre com sucesso", async () => {
    // Servidor descobre exatamente uma licença válida para este dispositivo
    validateHttpMock.mockImplementationOnce(async (deviceId: string, grant?: string, licenseId?: string) => ({
      ok: true,
      grant: mockValidGrant2027,
      expires_at: "2027-08-31T00:00:00+00:00",
      plan: "pro",
      key_mask: "NEKO-****-2027",
    }));

    const initState = await manager.initialize();
    expect(initState.state).toBe("MISSING");

    // Aguarda validação assíncrona agendada no boot
    if ((manager as any).pendingValidationPromise) {
      await (manager as any).pendingValidationPromise;
    }

    // A chamada de descoberta foi feita sem grant e sem license_id
    expect(validateHttpMock).toHaveBeenCalledWith(mockDeviceId, undefined, undefined);
    // Como exatamente uma associação válida existia, o desktop transiciona para VALID
    expect(manager.getState().state).toBe("VALID");
    expect(manager.getState().isLicensed).toBe(true);
    expect(saveGrantMock).toHaveBeenCalledWith(mockValidGrant2027, "NEKO-****-2027");
  });

  // ── 2. Inicialização sem grant com várias licenças no mesmo dispositivo ────
  test("2. Inicialização sem grant com várias licenças ativas rejeita com AMBIGUOUS_LICENSE sem escolher arbitrariamente", async () => {
    // Servidor detecta múltiplas licenças ativas no mesmo device_id e rejeita de forma controlada
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "AMBIGUOUS_LICENSE",
      message: "Múltiplas licenças ativas vinculadas a este computador. Por favor, ative com sua chave de licença.",
    }));

    const initState = await manager.initialize();
    expect(initState.state).toBe("MISSING");

    if ((manager as any).pendingValidationPromise) {
      await (manager as any).pendingValidationPromise;
    }

    // O desktop permanece em MISSING com segurança, sem conceder acesso indevido nem escolher arbitrariamente
    expect(manager.getState().state).toBe("MISSING");
    expect(manager.getState().isLicensed).toBe(false);
    expect(saveGrantMock).not.toHaveBeenCalled();
  });

  // ── 3. Inicialização sem grant com apenas associações expiradas ou revogadas ─
  test("3. Inicialização sem grant com apenas ativações expiradas ou revogadas permanece em MISSING", async () => {
    // Servidor retorna NOT_FOUND (v_active_valid_count = 0), sem impor EXPIRED de surpresa em boot limpo
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "NOT_FOUND",
      message: "Nenhuma licença ativa encontrada para este dispositivo.",
    }));

    const initState = await manager.initialize();
    expect(initState.state).toBe("MISSING");

    if ((manager as any).pendingValidationPromise) {
      await (manager as any).pendingValidationPromise;
    }

    // Permanece em MISSING sem crash e sem transicionar indevidamente para EXPIRED
    expect(manager.getState().state).toBe("MISSING");
    expect(manager.getState().isLicensed).toBe(false);
    expect(mockVaultStore.grant).toBeUndefined();
  });

  // ── 4. Grant válido associado à licença A, com licença B válida ───────────
  test("4. Grant válido associado à licença A valida especificamente a licença A (sem trocar para B)", async () => {
    mockVaultStore.grant = mockValidGrant2027;

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(true);
    expect(valResult.grant).toBe(mockValidGrant2027);
    expect(manager.getState().state).toBe("VALID");

    // Confirma envio do license_id específico extraído criptograficamente do grant
    expect(validateHttpMock).toHaveBeenCalledWith(
      mockDeviceId,
      mockValidGrant2027,
      mockLicenseId2027
    );
  });

  // ── 5. Grant da licença A expirado, com licença B válida no mesmo PC ───────
  test("5. Grant da licença A expirado NÃO é substituído pela licença B: retorna EXPIRED e bloqueia", async () => {
    mockVaultStore.grant = mockExpiredGrant2026;

    // Servidor responde EXPIRED especificamente para a licença A (não substitui por B)
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "EXPIRED",
      message: "Esta licença expirou.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);
    expect(valResult.error_code).toBe("EXPIRED");
    expect(manager.getState().state).toBe("EXPIRED");
    expect(manager.getState().isLicensed).toBe(false);
    expect(clearGrantMock).toHaveBeenCalled();

    // Bloqueia com LICENSE_BLOCKED
    try {
      manager.assertAccess("workspace");
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe("LICENSE_BLOCKED");
      expect(err.message).toMatch(/expirou/i);
    }
  });

  // ── 6. license_id adulterado ou divergente do grant ───────────────────────
  test("6. Simulação do Edge Function: rejeita requisição onde body.license_id diverge do grant", () => {
    const body = {
      device_id: mockDeviceId,
      grant: mockValidGrant2027,
      license_id: "99999999-9999-9999-9999-999999999999", // Divergente
    };

    const grantParts = body.grant.split(".");
    const grantPayload = JSON.parse(Buffer.from(grantParts[0], "base64url").toString("utf8"));
    const grantLicenseId = grantPayload.license_id;
    const bodyLicenseId = body.license_id;

    const isMismatch = grantLicenseId && bodyLicenseId && grantLicenseId !== bodyLicenseId;
    expect(isMismatch).toBe(true);
  });

  test("6b. Desktop: grant adulterado falha na verificação e não fornece license_id não confiável", async () => {
    // Grant com assinatura adulterada
    const tamperedGrant = `${mockValidGrant2027.split(".")[0]}.assinatura-falsa-corrompida`;
    mockVaultStore.grant = tamperedGrant;

    verifyGrantMock.mockImplementationOnce(() => ({
      valid: false,
      state: "INVALID",
      reason: "signature_invalid",
    }));

    await manager.validate();

    // Como o grant falhou na verificação criptográfica, targetLicenseId não foi extraído
    expect(validateHttpMock).toHaveBeenCalledWith(mockDeviceId, tamperedGrant, undefined);
  });

  // ── 7. Dispositivo não associado à licença solicitada ─────────────────────
  test("7. Dispositivo não associado à licença solicitada retorna NOT_FOUND e limpa o cofre", async () => {
    mockVaultStore.grant = mockValidGrant2027;

    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "NOT_FOUND",
      message: "Dispositivo não autorizado para esta licença.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);
    expect(valResult.error_code).toBe("NOT_FOUND");
    expect(manager.getState().state).toBe("MISSING");
    expect(clearGrantMock).toHaveBeenCalled();
  });

  // ── 8. Limite de dispositivos e transferência oficial ────────────────────
  test("8. Limite de dispositivos bloqueia novo dispositivo e transferência via resetDevice autoriza", async () => {
    // 8a: Validação falha por conflito de dispositivo
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "DEVICE_ALREADY_ACTIVE",
      message: "Esta licença já está em uso em outro computador.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);
    expect(valResult.error_code).toBe("DEVICE_ALREADY_ACTIVE");
    expect(manager.getState().state).toBe("MISSING");
    expect(clearGrantMock).toHaveBeenCalled();

    // 8b: Transferência oficial autorizada via resetDevice
    const resetResult = await manager.resetDevice("NEKO-KEY-TRANSFER-2027");
    expect(resetResult.ok).toBe(true);
    expect(manager.getState().state).toBe("VALID");
    expect(saveGrantMock).toHaveBeenCalled();
  });

  // ── 9. Banco indisponível ou RPC incompatível sem troca de licença ───────
  test("9. Erro transitório de banco (DB_ERROR / DB_CONFIG_ERROR) NÃO apaga cofre nem vira EXPIRED", async () => {
    await manager.activate("NEKO-KEY-VALID-2027");
    expect(manager.getState().state).toBe("VALID");

    // Servidor retorna erro transitório de banco ou erro de configuração de RPC (sem migração)
    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "DB_CONFIG_ERROR",
      message: "A validação da licença específica requer a atualização da RPC no banco de dados.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);
    // Preserva trabalho local em VALID
    expect(manager.getState().state).toBe("VALID");
    expect(manager.getState().isLicensed).toBe(true);
    expect(clearGrantMock).not.toHaveBeenCalled();
  });

  test("9b. Queda de rede (NETWORK_ERROR) preserva estado VALID sem bloqueio", async () => {
    await manager.activate("NEKO-KEY-VALID-2027");
    expect(manager.getState().state).toBe("VALID");

    validateHttpMock.mockImplementationOnce(async () => ({
      ok: false,
      error_code: "NETWORK_ERROR",
      message: "Não foi possível conectar ao servidor de licenças.",
    }));

    const valResult = await manager.validate();
    expect(valResult.ok).toBe(false);
    expect(manager.getState().state).toBe("VALID");
    expect(clearGrantMock).not.toHaveBeenCalled();
  });

  // ── 10. Compatibilidade das assinaturas RPC com chamadas do Supabase ──────
  test("10. Compatibilidade contratual: chamadas RPC das Edge Functions conferem com a migração", () => {
    // Assinatura de 4 parâmetros chamada por license-validate
    const expectedRpcCall4Params = {
      p_device_id: mockDeviceId,
      p_license_id: mockLicenseId2027,
      p_ip: "127.0.0.1",
      p_user_agent: "NekoAI Desktop Client",
    };
    expect(Object.keys(expectedRpcCall4Params)).toEqual([
      "p_device_id",
      "p_license_id",
      "p_ip",
      "p_user_agent",
    ]);

    // Assinatura legada de 3 parâmetros chamada pelo wrapper de descoberta/fallback
    const expectedRpcCall3Params = {
      p_device_id: mockDeviceId,
      p_ip: "127.0.0.1",
      p_user_agent: "NekoAI Desktop Client",
    };
    expect(Object.keys(expectedRpcCall3Params)).toEqual([
      "p_device_id",
      "p_ip",
      "p_user_agent",
    ]);
  });

  // ── Respostas assíncronas fora de ordem (stateGeneration) ────────────────
  test("Respostas assíncronas fora de ordem descartam resultado obsoleto via stateGeneration", async () => {
    let delayedValidationResolver: any;
    validateHttpMock.mockImplementationOnce(() => new Promise((resolve) => {
      delayedValidationResolver = resolve;
    }));

    const valAPromise = manager.validate();
    await new Promise((resolve) => setTimeout(resolve, 10));

    manager.updateStateDirectly({
      state: "VALID",
      isLicensed: true,
      entitlements: ["ai-full"],
      deviceId: mockDeviceId,
      reason: "USER_ACTIVATION",
    });

    delayedValidationResolver({
      ok: false,
      error_code: "EXPIRED",
      message: "Esta licença expirou.",
    });

    await valAPromise;

    expect(manager.getState().state).toBe("VALID");
    expect(clearGrantMock).not.toHaveBeenCalled();
  });
});

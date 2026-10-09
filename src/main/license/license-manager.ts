// src/main/license/license-manager.ts
// Gerenciador Singleton de Licenciamento da NekoAI no Main Process

import { getStableDeviceId } from "./license-device";
import { verifySignedGrant } from "./license-crypto";
import { licenseVault } from "./license-vault";
import { licenseClient, LicenseActivateResponse, LicenseDeactivateResponse, LicenseValidateResponse, LicenseResetResponse } from "./license-client";
import { LicenseStateInfo, LocalLicenseState } from "./license-types";

export class LicenseManager {
  private currentDeviceId: string = "";
  private currentState: LicenseStateInfo = {
    state: "MISSING",
    isLicensed: false,
    entitlements: [],
    deviceId: "",
  };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private onStateChangeCallback: ((state: LicenseStateInfo, previousState: LicenseStateInfo) => void) | null = null;
  private isInitialized = false;
  private stateGeneration: number = 0;
  private isAuthoritativelyExpired: boolean = false;
  private authoritativeExpiredLicenseId: string | null = null;
  private currentGrant: string | null = null;

  public setOnStateChange(callback: (state: LicenseStateInfo, previousState: LicenseStateInfo) => void): void {
    this.onStateChangeCallback = callback;
  }

  public async initialize(): Promise<LicenseStateInfo> {
    if (this.isInitialized) return this.currentState;

    const genAtStart = this.stateGeneration;
    this.currentDeviceId = await getStableDeviceId();
    this.currentState.deviceId = this.currentDeviceId;

    // Carrega o grant armazenado localmente
    const vaultData = await licenseVault.loadVault();
    if (this.stateGeneration !== genAtStart) {
      console.warn("[Neko/License] Estado alterado durante initialize (loadVault). Descartando vault local.");
    } else if (vaultData?.grant) {
      this.currentGrant = vaultData.grant;
      const verification = verifySignedGrant(vaultData.grant, this.currentDeviceId);
      if (verification.state === "EXPIRED") {
        await licenseVault.clearGrant();
        this.isAuthoritativelyExpired = true;
        this.authoritativeExpiredLicenseId = verification.payload?.license_id || null;
        this.updateStateDirectly({
          state: "EXPIRED",
          isLicensed: false,
          entitlements: [],
          deviceId: this.currentDeviceId,
          licenseId: verification.payload?.license_id,
          expiresAt: verification.payload?.expires_at,
          maxDevices: vaultData.maxDevices,
          activeDevices: vaultData.activeDevices,
          reason: "STORED_GRANT_EXPIRED",
        });
      } else {
        this.updateStateFromVerification(
          verification.state,
          verification.payload,
          vaultData.keyMask,
          vaultData.maxDevices,
          vaultData.activeDevices,
          vaultData.licenseType
        );
      }
    } else {
      this.currentState = {
        state: "MISSING",
        isLicensed: false,
        entitlements: [],
        deviceId: this.currentDeviceId,
      };
    }

    this.isInitialized = true;
    console.log(`[Neko/License] Inicializado. Estado: ${this.currentState.state}, Dispositivo: ${this.currentDeviceId}`);

    // Inicia o heartbeat periódico de validação online (10 segundos)
    this.startHeartbeat();

    // Dispara validação online imediata sem bloquear a inicialização da UI.
    // Se a licença expirou no backend, será detectada em segundos (não em 10s do heartbeat).
    void this.validate().catch(err => {
      console.warn("[Neko/License] Falha na validação online inicial (boot):", err);
    });

    return this.currentState;
  }

  public startHeartbeat(intervalMs = 10000): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.heartbeatTimer = setInterval(async () => {
      // Executa validação somente se houver uma licença ativa ou em grace localmente
      if (this.currentState.state === "VALID" || this.currentState.state === "GRACE") {
        try {
          await this.validate();
        } catch (err) {
          console.warn("[Neko/License] Erro não tratado durante heartbeat de licença:", err);
        }
      }
    }, intervalMs);

    if (this.heartbeatTimer && typeof (this.heartbeatTimer as any).unref === "function") {
      (this.heartbeatTimer as any).unref();
    }
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public shutdown(): void {
    this.stopHeartbeat();
  }

  public getState(): LicenseStateInfo {
    this.isLocallyOrServerExpired();
    return { ...this.currentState };
  }

  public isAccessAllowed(): boolean {
    return (this.currentState.state === "VALID" || this.currentState.state === "GRACE") && !this.isLocallyOrServerExpired();
  }

  private isLocallyOrServerExpired(): boolean {
    if (this.isAuthoritativelyExpired) {
      return true;
    }
    if (this.currentState.expiresAt) {
      const nowMs = Date.now();
      const expiresAtMs = new Date(this.currentState.expiresAt).getTime();
      if (!Number.isNaN(expiresAtMs) && nowMs >= expiresAtMs) {
        if (this.currentState.state !== "EXPIRED") {
          void this.expireLocally("LOCAL_EXPIRED");
        }
        return true;
      }
    }
    return false;
  }

  public async expireLocally(reason = "LOCAL_EXPIRED"): Promise<void> {
    this.isAuthoritativelyExpired = true;
    this.currentGrant = null;
    this.updateStateDirectly({
      state: "EXPIRED",
      isLicensed: false,
      entitlements: [],
      deviceId: this.currentDeviceId,
      licenseId: this.currentState.licenseId,
      expiresAt: this.currentState.expiresAt,
      reason,
    });
    await licenseVault.clearGrant();
  }

  public assertAccess(feature = "o workspace"): void {
    if (!this.isAccessAllowed()) {
      const state = this.currentState.state;
      const message = state === "EXPIRED" || this.isAuthoritativelyExpired
        ? "Sua licença expirou. Renove sua assinatura para continuar."
        : state === "INVALID"
        ? "Certificado de licença inválido. Ative uma licença válida."
        : "Ativação de licença necessária para acessar " + feature + ".";
      const error: any = new Error(message);
      error.code = "LICENSE_BLOCKED";
      error.licenseState = state === "EXPIRED" || this.isAuthoritativelyExpired ? "EXPIRED" : state;
      throw error;
    }
  }

  public async activate(licenseKey: string): Promise<LicenseActivateResponse> {
    const cleanKey = String(licenseKey || "").trim().toUpperCase();
    if (!cleanKey) {
      return { ok: false, error_code: "INVALID_LICENSE_KEY", message: "Chave de licença inválida." };
    }

    const deviceId = await getStableDeviceId();
    const genAtStart = this.stateGeneration;
    const result = await licenseClient.activate(cleanKey, deviceId);

    if (result.ok && result.grant) {
      this.currentGrant = result.grant;
      const isTestFromKey = cleanKey.startsWith("NEKO-TEST-") || result.license_type === "TEST" || result.plan === "TEST";
      const effectiveLicenseType = isTestFromKey ? "TEST" : result.license_type;
      // Verifica o grant recebido antes de salvar
      const verification = verifySignedGrant(result.grant, deviceId);
      if (verification.valid && (verification.state === "VALID" || verification.state === "GRACE")) {
        this.isAuthoritativelyExpired = false;
        this.authoritativeExpiredLicenseId = null;
        if (result.max_devices !== undefined || result.active_devices !== undefined || effectiveLicenseType !== undefined) {
          await licenseVault.saveGrant(result.grant, result.key_mask, result.max_devices, result.active_devices, effectiveLicenseType);
        } else {
          await licenseVault.saveGrant(result.grant, result.key_mask);
        }
        if (this.stateGeneration !== genAtStart) {
          console.warn("[Neko/License] Estado alterado durante ativação online (após saveGrant). Descartando resultado obsoleto.");
          return result;
        }
        this.updateStateFromVerification(verification.state, verification.payload, result.key_mask, result.max_devices, result.active_devices, effectiveLicenseType);
      } else {
        this.updateStateFromVerification(verification.state, verification.payload, result.key_mask, result.max_devices, result.active_devices, effectiveLicenseType);
      }
    }

    return result;
  }

  public async resetDevice(licenseKey: string): Promise<LicenseResetResponse> {
    const cleanKey = String(licenseKey || "").trim().toUpperCase();
    if (!cleanKey) {
      return { ok: false, error_code: "INVALID_LICENSE_KEY", message: "Chave de licença inválida." };
    }

    const deviceId = await getStableDeviceId();
    const genAtStart = this.stateGeneration;
    const result = await licenseClient.resetDevice(cleanKey, deviceId);

    if (result.ok && result.grant) {
      this.currentGrant = result.grant;
      const isTestFromKey = cleanKey.startsWith("NEKO-TEST-") || result.license_type === "TEST" || result.plan === "TEST";
      const effectiveLicenseType = isTestFromKey ? "TEST" : result.license_type;
      const verification = verifySignedGrant(result.grant, deviceId);
      if (verification.valid && (verification.state === "VALID" || verification.state === "GRACE")) {
        this.isAuthoritativelyExpired = false;
        this.authoritativeExpiredLicenseId = null;
        if (result.max_devices !== undefined || result.active_devices !== undefined || effectiveLicenseType !== undefined) {
          await licenseVault.saveGrant(result.grant, result.key_mask, result.max_devices, result.active_devices, effectiveLicenseType);
        } else {
          await licenseVault.saveGrant(result.grant, result.key_mask);
        }
        if (this.stateGeneration !== genAtStart) {
          console.warn("[Neko/License] Estado alterado durante validação/reset online (após saveGrant). Descartando resultado obsoleto.");
          return result;
        }
        this.updateStateFromVerification(verification.state, verification.payload, result.key_mask, result.max_devices, result.active_devices, effectiveLicenseType);
      } else {
        return { ok: false, error_code: "INVALID_GRANT", message: "O certificado emitido pelo servidor falhou na verificação de integridade local." };
      }
    }

    return result;
  }

  private pendingValidationPromise: Promise<LicenseValidateResponse> | null = null;

  public async validate(): Promise<LicenseValidateResponse> {
    if (this.pendingValidationPromise) {
      return this.pendingValidationPromise;
    }

    this.pendingValidationPromise = (async () => {
      try {
        const deviceId = await getStableDeviceId();
        const genAtStart = this.stateGeneration;
        const vaultData = await licenseVault.loadVault();
        let targetLicenseId: string | undefined = undefined;
        if (vaultData?.grant) {
          const verification = verifySignedGrant(vaultData.grant, deviceId);
          // O grant deve ter assinatura criptográfica íntegra e estar vinculado a este dispositivo
          // (mesmo que expirado ou em grace no tempo, o payload verificado é autêntico)
          if (verification.payload?.license_id) {
            targetLicenseId = verification.payload.license_id;
          }
        } else if (this.currentState.licenseId) {
          targetLicenseId = this.currentState.licenseId;
        }

        // Se esta licença já foi confirmada autoritativamente como expirada, não revalida com grant antigo
        if (this.isAuthoritativelyExpired && targetLicenseId && targetLicenseId === this.authoritativeExpiredLicenseId) {
          return { ok: false, error_code: "EXPIRED", message: "Esta licença expirou." };
        }

        const result = await licenseClient.validate(deviceId, vaultData?.grant, targetLicenseId);

        // Proteção contra race condition: se o estado mudou durante a validação
        // (ex: activate() ou outra validate() concluiu), não sobrescrever o estado mais recente
        if (this.stateGeneration !== genAtStart) {
          console.warn("[Neko/License] Estado alterado durante validação online. Descartando resultado obsoleto.");
          return result;
        }

        if (result.ok && result.grant) {
          this.currentGrant = result.grant;
          const verification = verifySignedGrant(result.grant, deviceId);
          if (verification.valid && (verification.state === "VALID" || verification.state === "GRACE")) {
            if (result.max_devices !== undefined || result.active_devices !== undefined || result.license_type !== undefined) {
              await licenseVault.saveGrant(result.grant, result.key_mask, result.max_devices, result.active_devices, result.license_type);
            } else {
              await licenseVault.saveGrant(result.grant, result.key_mask);
            }
            if (this.stateGeneration !== genAtStart) {
              console.warn("[Neko/License] Estado alterado durante validação/reset online (após saveGrant). Descartando resultado obsoleto.");
              return result;
            }
            this.isAuthoritativelyExpired = false;
            this.authoritativeExpiredLicenseId = null;
            this.updateStateFromVerification(verification.state, verification.payload, result.key_mask, result.max_devices, result.active_devices, result.license_type);
          } else {
            this.updateStateFromVerification(verification.state, verification.payload, result.key_mask, result.max_devices, result.active_devices, result.license_type);
          }
        } else if (
          result.error_code === "NOT_FOUND" ||
          result.error_code === "REVOKED" ||
          result.error_code === "DEVICE_ALREADY_ACTIVE"
        ) {
          console.warn(`[Neko/License] Licença revogada ou transferida no servidor (${result.error_code}). Limpando cofre local imediatamente.`);
          this.currentGrant = null;
          await licenseVault.clearGrant();
          if (typeof genAtStart !== "undefined" && this.stateGeneration !== genAtStart) {
            console.warn("[Neko/License] Estado alterado durante validação/operação online (após clearGrant). Descartando resultado obsoleto.");
            return result;
          }
          this.updateStateDirectly({
            state: "MISSING",
            isLicensed: false,
            entitlements: [],
            deviceId,
            reason: "REMOTE_TRANSFER",
          });
        } else if (result.error_code === "EXPIRED") {
          // CORREÇÃO CRÍTICA: O backend declarou a licença como expirada.
          // O Electron DEVE bloquear imediatamente — o grace period NÃO se aplica
          // quando o servidor responde explicitamente EXPIRED.
          console.warn("[Neko/License] Licença expirada no servidor. Limpando cofre local e bloqueando acesso.");
          this.currentGrant = null;
          await licenseVault.clearGrant();
          if (typeof genAtStart !== "undefined" && this.stateGeneration !== genAtStart) {
            console.warn("[Neko/License] Estado alterado durante validação/operação online (após clearGrant). Descartando resultado obsoleto.");
            return result;
          }
          this.isAuthoritativelyExpired = true;
          this.authoritativeExpiredLicenseId = targetLicenseId || this.currentState.licenseId || null;
          this.updateStateDirectly({
            state: "EXPIRED",
            isLicensed: false,
            entitlements: [],
            deviceId,
            licenseId: this.authoritativeExpiredLicenseId || undefined,
            reason: "REMOTE_EXPIRED",
          });
        } else if (result.error_code === "INACTIVE") {
          console.warn("[Neko/License] Licença inativa no servidor. Limpando cofre local e bloqueando acesso.");
          this.currentGrant = null;
          await licenseVault.clearGrant();
          if (typeof genAtStart !== "undefined" && this.stateGeneration !== genAtStart) {
            return result;
          }
          this.isAuthoritativelyExpired = true;
          this.authoritativeExpiredLicenseId = targetLicenseId || this.currentState.licenseId || null;
          this.updateStateDirectly({
            state: "EXPIRED",
            isLicensed: false,
            entitlements: [],
            deviceId,
            licenseId: this.authoritativeExpiredLicenseId || undefined,
            reason: "REMOTE_INACTIVE",
          });
        }

        return result;
      } finally {
        this.pendingValidationPromise = null;
      }
    })();

    return this.pendingValidationPromise;
  }

  public async deactivate(licenseId?: string): Promise<LicenseDeactivateResponse> {
    const targetLicenseId = licenseId || this.currentState.licenseId;
    if (!targetLicenseId) {
      return { ok: false, error_code: "NOT_FOUND", message: "Nenhuma licença ativa encontrada para desativação." };
    }

    const deviceId = await getStableDeviceId();
    const genAtStart = this.stateGeneration;
    const result = await licenseClient.deactivate(targetLicenseId, deviceId);

    if (result.ok) {
      this.currentGrant = null;
      await licenseVault.clearGrant();
      if (typeof genAtStart !== "undefined" && this.stateGeneration !== genAtStart) {
        console.warn("[Neko/License] Estado alterado durante validação/operação online (após clearGrant). Descartando resultado obsoleto.");
        return result;
      }
      this.updateStateDirectly({
        state: "MISSING",
        isLicensed: false,
        entitlements: [],
        deviceId,
        reason: "LOCAL_DEACTIVATION",
      });
    }

    return result;
  }

  public async getGrant(): Promise<string | null> {
    if (this.currentGrant) return this.currentGrant;
    const vault = await licenseVault.loadVault();
    if (vault?.grant) {
      this.currentGrant = vault.grant;
      return this.currentGrant;
    }
    return null;
  }

  private updateStateDirectly(newState: LicenseStateInfo): void {
    const prev = { ...this.currentState };
    this.currentState = newState;
    this.stateGeneration++;
    if (prev.state !== newState.state || prev.isLicensed !== newState.isLicensed) {
      try {
        this.onStateChangeCallback?.(this.currentState, prev);
      } catch (cbErr) {
        console.warn("[Neko/License] Erro no callback onStateChange:", cbErr);
      }
    }
  }

  private updateStateFromVerification(
    state: LocalLicenseState,
    payload?: any,
    keyMask?: string,
    maxDevices?: number,
    activeDevices?: number,
    licenseType?: string
  ): void {
    if (this.isAuthoritativelyExpired && (state === "VALID" || state === "GRACE")) {
      console.warn("[Neko/License] Bloqueando restauração de licença confirmada como expirada.");
      return;
    }
    const isLicensed = state === "VALID" || state === "GRACE";
    const mask = keyMask || this.currentState.keyMask;
    const isTest = 
      String(licenseType || "").toUpperCase() === "TEST" ||
      String(payload?.license_type || "").toUpperCase() === "TEST" ||
      String(payload?.plan || "").toUpperCase() === "TEST" ||
      String(payload?.plan || "").toUpperCase() === "TESTE" ||
      String(mask || "").toUpperCase().startsWith("NEKO-TEST-");

    const effectiveLicenseType = isTest ? "TEST" : (licenseType || payload?.license_type || this.currentState.licenseType || "NORMAL");
    const effectivePlan = isTest ? "TEST" : (payload?.plan || this.currentState.plan);
    const newState: LicenseStateInfo = {
      state,
      isLicensed,
      plan: effectivePlan,
      status: payload?.status,
      expiresAt: payload?.expires_at,
      graceUntil: payload?.grace_until,
      entitlements: payload?.entitlements || [],
      keyMask: mask,
      deviceId: this.currentDeviceId,
      licenseId: payload?.license_id,
      userId: payload?.user_id,
      maxDevices: typeof maxDevices === "number" ? maxDevices : this.currentState.maxDevices,
      activeDevices: typeof activeDevices === "number" ? activeDevices : this.currentState.activeDevices,
      licenseType: effectiveLicenseType,
      grant: this.currentGrant || undefined,
    };
    this.updateStateDirectly(newState);
  }
}

export const licenseManager = new LicenseManager();

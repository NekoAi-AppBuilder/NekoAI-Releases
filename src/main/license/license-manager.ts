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

  public setOnStateChange(callback: (state: LicenseStateInfo, previousState: LicenseStateInfo) => void): void {
    this.onStateChangeCallback = callback;
  }

  public async initialize(): Promise<LicenseStateInfo> {
    if (this.isInitialized) return this.currentState;

    this.currentDeviceId = await getStableDeviceId();
    this.currentState.deviceId = this.currentDeviceId;

    // Carrega o grant armazenado localmente
    const vaultData = await licenseVault.loadVault();
    if (vaultData?.grant) {
      const verification = verifySignedGrant(vaultData.grant, this.currentDeviceId);
      this.updateStateFromVerification(verification.state, verification.payload, vaultData.keyMask);
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

    // Inicia o heartbeat periódico de validação online (60 segundos)
    this.startHeartbeat();

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
    return { ...this.currentState };
  }

  public isAccessAllowed(): boolean {
    return this.currentState.state === "VALID" || this.currentState.state === "GRACE";
  }

  public assertAccess(feature = "o workspace"): void {
    if (!this.isAccessAllowed()) {
      const state = this.currentState.state;
      const message = state === "EXPIRED"
        ? "Sua licença expirou. Renove sua assinatura para continuar."
        : state === "INVALID"
        ? "Certificado de licença inválido. Ative uma licença válida."
        : "Ativação de licença necessária para acessar " + feature + ".";
      const error: any = new Error(message);
      error.code = "LICENSE_BLOCKED";
      error.licenseState = state;
      throw error;
    }
  }

  public async activate(licenseKey: string): Promise<LicenseActivateResponse> {
    const cleanKey = String(licenseKey || "").trim().toUpperCase();
    if (!cleanKey) {
      return { ok: false, error_code: "INVALID_LICENSE_KEY", message: "Chave de licença inválida." };
    }

    const deviceId = await getStableDeviceId();
    const result = await licenseClient.activate(cleanKey, deviceId);

    if (result.ok && result.grant) {
      // Verifica o grant recebido antes de salvar
      const verification = verifySignedGrant(result.grant, deviceId);
      if (verification.valid && (verification.state === "VALID" || verification.state === "GRACE")) {
await licenseVault.saveGrant(result.grant, result.key_mask);
            this.updateStateFromVerification(verification.state, verification.payload, result.key_mask);
          } else {
            this.updateStateFromVerification(verification.state, verification.payload, result.key_mask);
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
    const result = await licenseClient.resetDevice(cleanKey, deviceId);

    if (result.ok && result.grant) {
      const verification = verifySignedGrant(result.grant, deviceId);
      if (verification.valid && (verification.state === "VALID" || verification.state === "GRACE")) {
        await licenseVault.saveGrant(result.grant, result.key_mask);
        this.updateStateFromVerification(verification.state, verification.payload, result.key_mask);
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
        const vaultData = await licenseVault.loadVault();
        const result = await licenseClient.validate(deviceId, vaultData?.grant);

        if (result.ok && result.grant) {
          const verification = verifySignedGrant(result.grant, deviceId);
if (verification.valid && (verification.state === "VALID" || verification.state === "GRACE")) {
            await licenseVault.saveGrant(result.grant, result.key_mask);
            this.updateStateFromVerification(verification.state, verification.payload, result.key_mask);
          } else {
            this.updateStateFromVerification(verification.state, verification.payload, result.key_mask);
          }
        } else if (
          result.error_code === "NOT_FOUND" ||
          result.error_code === "REVOKED" ||
          result.error_code === "DEVICE_ALREADY_ACTIVE"
        ) {
          console.warn(`[Neko/License] Licença revogada ou transferida no servidor (${result.error_code}). Limpando cofre local imediatamente.`);
          await licenseVault.clearGrant();
          this.updateStateDirectly({
            state: "MISSING",
            isLicensed: false,
            entitlements: [],
            deviceId,
            reason: "REMOTE_TRANSFER",
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
    const result = await licenseClient.deactivate(targetLicenseId, deviceId);

    if (result.ok) {
      await licenseVault.clearGrant();
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

  private updateStateDirectly(newState: LicenseStateInfo): void {
    const prev = { ...this.currentState };
    this.currentState = newState;
    if (prev.state !== newState.state || prev.isLicensed !== newState.isLicensed) {
      try {
        this.onStateChangeCallback?.(this.currentState, prev);
      } catch (cbErr) {
        console.warn("[Neko/License] Erro no callback onStateChange:", cbErr);
      }
    }
  }

  private updateStateFromVerification(state: LocalLicenseState, payload?: any, keyMask?: string): void {
    const isLicensed = state === "VALID" || state === "GRACE";
    const newState: LicenseStateInfo = {
      state,
      isLicensed,
      plan: payload?.plan,
      status: payload?.status,
      expiresAt: payload?.expires_at,
      graceUntil: payload?.grace_until,
      entitlements: payload?.entitlements || [],
      keyMask: keyMask,
      deviceId: this.currentDeviceId,
      licenseId: payload?.license_id,
      userId: payload?.user_id,
    };
    this.updateStateDirectly(newState);
  }
}

export const licenseManager = new LicenseManager();

// src/main/license/license-client.ts
// Cliente HTTP seguro para as Edge Functions Supabase PROD (igadprvhgmfnyvyqavhy)

export const LICENSE_API_BASE_URL = "https://igadprvhgmfnyvyqavhy.supabase.co/functions/v1";

export interface LicenseActivateResponse {
  ok: boolean;
  grant?: string;
  expires_at?: string;
  plan?: string;
  key_mask?: string;
  max_devices?: number;
  active_devices?: number;
  license_type?: string;
  error_code?: string;
  message?: string;
}

export interface LicenseValidateResponse {
  ok: boolean;
  grant?: string;
  expires_at?: string;
  plan?: string;
  key_mask?: string;
  max_devices?: number;
  active_devices?: number;
  license_type?: string;
  error_code?: string;
  message?: string;
  retry_after?: number;
}

export interface LicenseDeactivateResponse {
  ok: boolean;
  deactivated?: boolean;
  error_code?: string;
  message?: string;
}

export interface LicenseResetResponse {
  ok: boolean;
  grant?: string;
  expires_at?: string;
  plan?: string;
  key_mask?: string;
  max_devices?: number;
  active_devices?: number;
  license_type?: string;
  error_code?: string;
  message?: string;
  retry_after?: number;
}

export class LicenseClient {
  private baseUrl: string;

  constructor(baseUrl = LICENSE_API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  public async activate(
    licenseKey: string,
    deviceId: string,
    deviceName = "NekoAI Station"
  ): Promise<LicenseActivateResponse> {
    const url = `${this.baseUrl}/license-activate`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          license_key: licenseKey,
          device_id: deviceId,
          device_name: deviceName,
        }),
      });

      const data = await res.json();
      return data;
    } catch (err) {
      console.error("[Neko/LicenseClient] Falha de rede ao ativar licença:", err);
      return { ok: false, error_code: "NETWORK_ERROR", message: "Não foi possível conectar ao servidor de licenças." };
    }
  }

  public async resetDevice(
    licenseKey: string,
    deviceId: string,
    deviceName = "NekoAI Station"
  ): Promise<LicenseResetResponse> {
    const url = `${this.baseUrl}/license-reset-device`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          license_key: licenseKey,
          device_id: deviceId,
          device_name: deviceName,
        }),
      });

      const data = await res.json();
      return data;
    } catch (err) {
      console.error("[Neko/LicenseClient] Falha de rede ao transferir licença:", err);
      return { ok: false, error_code: "NETWORK_ERROR", message: "Não foi possível conectar ao servidor de licenças." };
    }
  }

  public async validate(deviceId: string, grant?: string, licenseId?: string): Promise<LicenseValidateResponse> {
    const url = `${this.baseUrl}/license-validate`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: deviceId,
          grant: grant || "",
          license_id: licenseId || undefined,
        }),
      });

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }

      if (!res.ok) {
        if (res.status >= 500) {
          return { ok: false, error_code: "SERVER_UNAVAILABLE", message: "Servidor de licenças temporariamente indisponível." };
        }
        if (res.status === 429) {
          return { ok: false, error_code: "RATE_LIMITED", message: data?.message || "Muitas tentativas.", retry_after: data?.retry_after };
        }
        return {
          ok: false,
          error_code: data?.error_code || "INVALID_REQUEST",
          message: data?.message || "Não foi possível validar a licença.",
        };
      }

      return { ok: true, ...data };
    } catch (err) {
      console.error("[Neko/LicenseClient] Falha de rede ao validar licença:", err);
      return { ok: false, error_code: "NETWORK_ERROR", message: "Não foi possível conectar ao servidor de licenças." };
    }
  }

  public async deactivate(
    licenseId: string,
    deviceId: string
  ): Promise<LicenseDeactivateResponse> {
    const url = `${this.baseUrl}/license-deactivate-device`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          license_id: licenseId,
          device_id: deviceId,
        }),
      });

      const data = await res.json();
      return data;
    } catch (err) {
      console.error("[Neko/LicenseClient] Falha de rede ao desativar dispositivo:", err);
      return { ok: false, error_code: "NETWORK_ERROR", message: "Não foi possível conectar ao servidor de licenças." };
    }
  }
}

export const licenseClient = new LicenseClient();


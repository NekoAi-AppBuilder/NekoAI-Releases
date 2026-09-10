// src/main/license/license-types.ts
// Tipagem formal do sistema de licenciamento da NekoAI no Main Process

export type LicensePlan = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type LicenseCommercialStatus = 'active' | 'past_due' | 'cancelled' | 'expired' | 'revoked';
export type LocalLicenseState = 'MISSING' | 'INVALID' | 'VALID' | 'GRACE' | 'EXPIRED';

export interface GrantPayload {
  jti: string;
  iss: string;
  aud: string;
  license_id: string;
  user_id: string;
  device_id: string;
  plan: string;
  status: string;
  entitlements: string[];
  issued_at: string;
  expires_at: string;
  grace_until: string;
  version: number;
  kid: string;
}

export interface LicenseVerificationResult {
  valid: boolean;
  state: LocalLicenseState;
  reason?: string;
  payload?: GrantPayload;
}

export interface LicenseStateInfo {
  state: LocalLicenseState;
  isLicensed: boolean;
  plan?: string;
  status?: string;
  expiresAt?: string;
  graceUntil?: string;
  entitlements: string[];
  keyMask?: string;
  deviceId: string;
  licenseId?: string;
  userId?: string;
  reason?: "LOCAL_DEACTIVATION" | "REMOTE_TRANSFER" | "INITIAL_CHECK" | "VERIFIED" | string;
}

export interface StoredLicenseVault {
  version: number;
  grant: string;
  keyMask?: string;
  lastCheckedAt?: string;
}


export type LovableStatus =
  | "disconnected"
  | "detecting"
  | "authorizing"
  | "validating"
  | "connected"
  | "error";

export type LovableCloudStatus =
  | "connected"
  | "auth_required"
  | "session_expired"
  | "forbidden"
  | "not_confirmed"
  | "no_cloud"
  | "error"
  | "unknown";

export interface LovableDetectionResult {
  isLovable: boolean;
  reason?: string;
  projectId?: string;
  hasLocalConfig?: boolean;
  hasAgentsMarker?: boolean;
  hasSupabaseConfig?: boolean;
}

export interface LovableProjectLink {
  projectId: string;
  projectPath: string;
  connectedAt: number;
  hasLovableCloud?: boolean | null;
  explicitlyDisconnected?: boolean;
}

export interface LovableVault {
  version: number;
  links: Record<string, LovableProjectLink>;
}

export interface LovableSession {
  email?: string;
  uid?: string;
  accessToken?: string;
  expirationTime?: number;
}

export interface LovableState {
  status: LovableStatus;
  cloudStatus: LovableCloudStatus;
  isLovableProject: boolean;
  detectionReason?: string;
  detectedProjectId: string | null;
  projectId: string | null;
  lovableProjectId: string | null;
  hasLovableCloud: boolean | null;
  lovableCloudConnected: boolean;
  lovableSessionValid: boolean;
  userEmail: string | null;
  connectedAt: number | null;
  error: string | null;
  explicitlyDisconnected?: boolean;
}

export const EMPTY_LOVABLE_STATE: LovableState = {
  status: "disconnected",
  cloudStatus: "unknown",
  isLovableProject: false,
  detectionReason: undefined,
  detectedProjectId: null,
  projectId: null,
  lovableProjectId: null,
  hasLovableCloud: null,
  lovableCloudConnected: false,
  lovableSessionValid: false,
  userEmail: null,
  connectedAt: null,
  error: null,
  explicitlyDisconnected: false,
};

export const LOVABLE_PROJECT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LOVABLE_URL_PROJECT_ID_REGEX = /^https:\/\/(?:www\.)?lovable\.dev\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;


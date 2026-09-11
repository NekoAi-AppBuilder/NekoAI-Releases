export type SupabaseStatus =
  | "disconnected"
  | "checking"
  | "authorizing"
  | "selecting"
  | "validating"
  | "verifying"
  | "installing"
  | "connected"
  | "error";

export interface SupabaseProject {
  id: string;
  name: string;
  ref: string;
  region: string;
  status: string;
}

export interface SupabaseOrganization {
  id: string;
  name: string;
}

export interface SupabaseIntegration {
  projectRef: string;
  projectName: string;
  projectUrl: string;
  publishableKey: string;
  region?: string;
  orgId?: string;
  mcpName?: string;
  connectedAt?: number;
  openCodeConfigPath?: string | null;
  pendingRuntimeSetup?: boolean;
}

export interface SupabaseVault {
  version: number;
  integrations: Record<string, SupabaseIntegration>;
}

export interface SupabaseStructuredError {
  code: string;
  title: string;
  message: string;
  detail?: string;
  isLimit?: boolean;
}

export interface SupabaseState {
  status: SupabaseStatus;
  configured: boolean;
  projects: SupabaseProject[];
  organizations: SupabaseOrganization[];
  projectRef: string | null;
  projectName: string | null;
  projectUrl: string | null;
  region?: string | null;
  pendingRuntimeSetup?: boolean;
  recentCreatedNotice?: string | null;
  error: string | null;
  structuredError?: SupabaseStructuredError | null;
}

export interface SupabaseCreateProjectPayload {
  name: string;
  orgId: string;
  dbPassword: string;
  region: string;
}

export interface SupabaseConnection {
  ref: string;
  name: string;
  url: string;
  publishableKey: string;
}

export interface SupabaseConfigureOptions {
  selectedRoot: string;
  projectRoot?: string | null;
  framework?: string | null;
  packageManager?: string | null;
  connection: SupabaseConnection;
  log?: (msg: string) => void;
}

export interface SupabaseEnvironmentNames {
  url: string;
  publishableKey: string;
}

export const EMPTY_SUPABASE_STATE: SupabaseState = {
  status: "disconnected",
  configured: true,
  projects: [],
  organizations: [],
  projectRef: null,
  projectName: null,
  projectUrl: null,
  region: null,
  pendingRuntimeSetup: false,
  error: null,
};

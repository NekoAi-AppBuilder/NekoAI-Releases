const fs = require('fs');
const path = require('path');

const typesContent = export type SupabaseStatus =
  |  disconnected
  | checking
  | selecting
  | validating
  | installing
  | connected
  | error;

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
  mcpName?: string;
  connectedAt?: number;
}

export interface SupabaseVault {
  version: number;
  integrations: Record<string, SupabaseIntegration>;
}

export interface SupabaseState {
  status: SupabaseStatus;
  configured: boolean;
  projects: SupabaseProject[];
  organizations: SupabaseOrganization[];
  projectRef: string | null;
  projectName: string | null;
  projectUrl: string | null;
  error: string | null;
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
  status: disconnected,
  configured: true,
  projects: [],
  organizations: [],
  projectRef: null,
  projectName: null,
  projectUrl: null,
  error: null,
};
;

fs.writeFileSync('src/main/supabase/supabase-types.ts', typesContent, 'utf8');
console.log('supabase-types.ts created successfully');

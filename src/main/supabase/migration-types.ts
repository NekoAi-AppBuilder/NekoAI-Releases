/**
 * Tipos e Definições para o Ciclo de Vida de Migrations Supabase no NekoAI
 */

export type SqlRiskLevel = "READ" | "SAFE_WRITE" | "DESTRUCTIVE";

export type MigrationProposalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "EXECUTING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED";

export interface MigrationProposal {
  id: string;
  sessionId: string;
  permissionId?: string;
  callId?: string;
  messageId?: string;
  projectRef: string;
  name: string;
  originalSql: string;
  normalizedSql: string;
  hash: string;
  risk: SqlRiskLevel;
  affectedTables: string[];
  status: MigrationProposalStatus;
  createdAt: number;
  expiresAt: number;
  provider?: "supabase" | "lovable";
  lovableProjectId?: string;
  projectGeneration?: number;
  summary?: string;
  error?: string;
  appliedFilename?: string;
  schemaVerificationStatus?: "VERIFIED" | "UNVERIFIED" | "FAILED";
  jitRequestId?: string;
}

export interface MigrationProposalRequest {
  sessionId: string;
  permissionId?: string;
  jitRequestId?: string;
  callId?: string;
  messageId?: string;
  projectRef: string;
  name: string;
  sql: string;
  provider?: "supabase" | "lovable";
  lovableProjectId?: string;
  projectGeneration?: number;
  summary?: string;
  projectRoot?: string;
}

export interface MigrationExecutionResult {
  success: boolean;
  proposalId: string;
  status: MigrationProposalStatus;
  appliedFilename?: string;
  error?: string;
  schemaVerificationStatus?: "VERIFIED" | "UNVERIFIED" | "FAILED";
  affectedTables?: string[];
  executionTimeMs?: number;
}

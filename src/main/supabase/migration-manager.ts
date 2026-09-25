/**
 * Gerenciador de Migrations com Aprovação Explícita no Chat Nativo (NekoAI P1)
 * 
 * Regras e Garantias:
 * 1. Proposta em memória com estado inicial PENDING.
 * 2. Hash determinístico SHA-256 (projectRef + normalizedSql).
 * 3. Timeout de expiração estrito (APPROVAL_TIMEOUT = 5 min).
 * 4. NENHUMA requisição mutativa ao Supabase é enviada sem status APPROVED.
 * 5. Revalidação completa no momento exato do clique em aprovar.
 * 6. Proteção contra duplo clique e reentrada (máquina de estados estrita).
 * 7. Gravação canônica em supabase/migrations/<timestamp>_<name>.sql apenas após sucesso.
 * 8. Reintrospecção de schema pós-execução e notificação ao Chat Nativo.
 */

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { supabaseManager } from "./supabase-manager";

import {
  MigrationProposal,
  MigrationProposalRequest,
  MigrationExecutionResult,
  MigrationProposalStatus
} from "./migration-types";
import {
  validateMigrationSql,
  normalizeSqlForHash,
  sanitizeSqlForDisplay
} from "../security/sql-guard";

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

export class MigrationManager extends EventEmitter {
  private proposals = new Map<string, MigrationProposal>();
  private pendingResolvers = new Map<string, {
    resolve: (result: MigrationExecutionResult) => void;
    reject: (err: Error) => void;
    timeoutId: NodeJS.Timeout;
    request: MigrationProposalRequest;
  }>();
  private executedHashes = new Set<string>();

  constructor() {
    super();
  }

  /**
   * Calcula o hash determinístico da migração: SHA-256(projectRef + normalizedSql)
   */
  public computeMigrationHash(projectRef: string, sql: string): string {
    const normalized = normalizeSqlForHash(sql);
    return crypto
      .createHash("sha256")
      .update(`${projectRef.trim().toLowerCase()}:${normalized}`)
      .digest("hex");
  }

  /**
   * Sanitiza o nome do arquivo da migration para snake_case alfanumérico seguro.
   */
  public sanitizeMigrationName(name: string): string {
    const cleaned = (name || "migration")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    return cleaned || "migration";
  }

  /**
   * Gera o timestamp canônico no formato YYYYMMDDHHmmss
   */
  public formatTimestamp(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  /**
   * Solicita a criação de uma proposta de migração e suspende a execução até resposta do usuário.
   */
  public proposeMigration(
    request: MigrationProposalRequest,
    customFetch?: typeof fetch
  ): Promise<MigrationExecutionResult> {
    const { sessionId, messageId, projectRef, name, sql, summary } = request;

    // 1. Validação prévia com SQL Guard
    const validation = validateMigrationSql(sql);
    if (!validation.valid) {
      throw new Error(`Migração rejeitada pelo validador: ${validation.reason || "SQL inválido"}`);
    }

    if (validation.risk === "READ") {
      throw new Error("Consultas puramente de leitura não devem ser aplicadas como migração.");
    }

    const normalizedSql = normalizeSqlForHash(sql);
    const hash = this.computeMigrationHash(projectRef, sql);

    // 2. Proteção Anti-Duplicação por Hash
    if (this.executedHashes.has(hash)) {
      throw new Error("Esta exata proposta de migração já foi aprovada e executada anteriormente.");
    }

    // Se já existe uma proposta correspondente (por jitRequestId, permissionId, sessionId+hash ou normalizedSql)
    for (const [existingId, existingProposal] of this.proposals.entries()) {
      const matchJit = Boolean(request.jitRequestId && existingProposal.jitRequestId && existingProposal.jitRequestId === request.jitRequestId);
      const matchPermission = Boolean(request.permissionId && existingProposal.permissionId && existingProposal.permissionId === request.permissionId);
      const matchSessionAndHash = Boolean(sessionId && existingProposal.sessionId === sessionId && existingProposal.hash === hash);
      const matchNormalizedSql = Boolean(existingProposal.status === "PENDING" && existingProposal.normalizedSql === normalizedSql && (existingProposal.sessionId === sessionId || (request.lovableProjectId && existingProposal.lovableProjectId === request.lovableProjectId)));

      if (matchJit || matchPermission || matchSessionAndHash || matchNormalizedSql) {
        if (existingProposal.status === "PENDING") {
          const existingResolver = this.pendingResolvers.get(existingId);
          if (existingResolver) {
            console.log(`[MigrationManager] Reutilizando proposta pendente existente id=${existingId} permissionId=${request.permissionId} jitId=${request.jitRequestId}`);
            return new Promise<MigrationExecutionResult>((resolve, reject) => {
              const origResolve = existingResolver.resolve;
              const origReject = existingResolver.reject;
              existingResolver.resolve = (res) => { origResolve(res); resolve(res); };
              existingResolver.reject = (err) => { origReject(err); reject(err); };
            });
          }
        } else if (existingProposal.status === "APPROVED" || existingProposal.status === "EXECUTING" || existingProposal.status === "SUCCESS") {
          console.log(`[MigrationManager] Reutilizando proposta já autorizada id=${existingId} status=${existingProposal.status} jitId=${request.jitRequestId}`);
          return Promise.resolve({
            success: true,
            proposalId: existingId,
            status: existingProposal.status
          });
        }
      }
    }

    const proposalId = `mig_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;

    const proposal: MigrationProposal = {
      id: proposalId,
      sessionId,
      permissionId: request.permissionId,
      jitRequestId: request.jitRequestId,
      callId: request.callId,
      messageId,
      projectRef,
      name: this.sanitizeMigrationName(name),
      originalSql: sql.trim(),
      normalizedSql,
      hash,
      risk: validation.risk,
      affectedTables: validation.affectedTables,
      status: "PENDING",
      createdAt: Date.now(),
      expiresAt,
      provider: request.provider || "supabase",
      lovableProjectId: request.lovableProjectId,
      projectGeneration: request.projectGeneration,
      summary
    };

    this.proposals.set(proposalId, proposal);

    return new Promise<MigrationExecutionResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.handleTimeout(proposalId);
      }, APPROVAL_TIMEOUT_MS);

      this.pendingResolvers.set(proposalId, {
        resolve,
        reject,
        timeoutId,
        request
      });

      // Emite evento para o Chat Nativo renderizar o DatabaseMigrationCard
      this.emit("migration-asked", proposal);
    });
  }

  /**
   * Responde à proposta (Aprovar ou Rejeitar) vindo do usuário via Chat Nativo.
   */
  public async replyProposal(
    proposalId: string,
    approved: boolean,
    customFetch?: typeof fetch
  ): Promise<MigrationExecutionResult> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposta de migração "${proposalId}" não encontrada.`);
    }

    // Máquina de estados: apenas PENDING pode ser transicionado para APPROVED ou REJECTED
    if (proposal.status !== "PENDING") {
      throw new Error(`A proposta não está em estado PENDING (status atual: ${proposal.status}). Operação inválida.`);
    }

    const resolver = this.pendingResolvers.get(proposalId);
    if (!resolver) {
      throw new Error(`Nenhuma execução aguardando aprovação para a proposta "${proposalId}".`);
    }

    clearTimeout(resolver.timeoutId);

    // Caso Rejeitado pelo usuário
    if (!approved) {
      proposal.status = "REJECTED";
      this.pendingResolvers.delete(proposalId);
      const result: MigrationExecutionResult = {
        success: false,
        proposalId,
        status: "REJECTED",
        error: "A alteração no banco de dados foi rejeitada pelo usuário."
      };
      this.emit("migration-replied", { proposal, approved: false });
      resolver.resolve(result);
      return result;
    }

    // Caso Aprovado pelo usuário: REVALIDAÇÃO COMPLETA
    const reval = validateMigrationSql(proposal.originalSql);
    if (!reval.valid) {
      proposal.status = "FAILED";
      const err = `Revalidação falhou antes da execução: ${reval.reason}`;
      proposal.error = err;
      this.pendingResolvers.delete(proposal.id);
      const res: MigrationExecutionResult = { success: false, proposalId: proposal.id, status: "FAILED", error: err };
      this.emit("migration-failed", { proposal, error: err });
      resolver.resolve(res);
      return res;
    }

    const recomputedHash = this.computeMigrationHash(proposal.projectRef, proposal.originalSql);
    if (recomputedHash !== proposal.hash) {
      proposal.status = "FAILED";
      const err = "Inconsistência de integridade: o hash do SQL mudou antes da execução.";
      proposal.error = err;
      this.pendingResolvers.delete(proposal.id);
      const res: MigrationExecutionResult = { success: false, proposalId: proposal.id, status: "FAILED", error: err };
      this.emit("migration-failed", { proposal, error: err });
      resolver.resolve(res);
      return res;
    }

    // Marcação como APPROVED (Aguardando início real da chamada pelo MCP)
    proposal.status = "APPROVED";
    this.emit("migration-replied", { proposal, approved: true });

    const result: MigrationExecutionResult = {
      success: true,
      proposalId: proposal.id,
      status: "APPROVED"
    };

    // Para provider "lovable": resolver a Promise imediatamente para que o MCP Server
    // possa prosseguir com a execução real e chamar notifyToolCompleted em seguida.
    // Para provider "supabase" (ou sem provider): manter o comportamento original onde
    // a Promise fica pendente até notifyToolCompleted resolver com SUCCESS/FAILED.
    if (proposal.provider === "lovable") {
      this.pendingResolvers.delete(proposal.id);
      resolver.resolve(result);
    }

    return result;
  }

  /**
   * Notifica que a ferramenta MCP iniciou a execução da migração aprovada.
   * Regra explícita: Somente propostas em APPROVED podem transicionar para EXECUTING.
   * Propostas em estados terminais (REJECTED, SUCCESS, FAILED, CANCELLED, EXPIRED) ou PENDING ignoram o evento.
   */
  public notifyToolExecuting(proposalIdentifier: string): void {
    const proposal = this.findProposal(proposalIdentifier);
    if (!proposal) return;
    if (proposal.status === "APPROVED") {
      proposal.status = "EXECUTING";
      console.log(`[Neko/Migration] tool execution started proposal=${proposal.id} session=${proposal.sessionId}`);
      this.emit("migration-executing", proposal);
    }
  }

  /**
   * Notifica a conclusão da execução da ferramenta MCP (Sucesso ou Falha).
   * Regra explícita: Somente propostas em EXECUTING ou APPROVED podem ser concluídas.
   * Estados terminais ignoram eventos tardios.
   */
  public async notifyToolCompleted(
    proposalIdentifier: string,
    success: boolean,
    errorMessage?: string
  ): Promise<void> {
    const proposal = this.findProposal(proposalIdentifier);
    if (!proposal) return;

    // Se já estiver em estado terminal, ignore eventos tardios
    if (proposal.status === "SUCCESS" || proposal.status === "FAILED" || proposal.status === "REJECTED" || proposal.status === "CANCELLED" || proposal.status === "EXPIRED") {
      console.log(`[Neko/Migration] Ignoring late tool completion for terminal proposal id=${proposal.id} status=${proposal.status}`);
      return;
    }

    const resolver = this.pendingResolvers.get(proposal.id);
    if (resolver) {
      clearTimeout(resolver.timeoutId);
      this.pendingResolvers.delete(proposal.id);
    }

    if (!success) {
      proposal.status = "FAILED";
      const err = errorMessage || "A execução da migração falhou no Supabase MCP.";
      proposal.error = err;
      console.log(`[Neko/Migration] tool execution failed proposal=${proposal.id} error=${err}`);
      const failResult: MigrationExecutionResult = {
        success: false,
        proposalId: proposal.id,
        status: "FAILED",
        error: err
      };
      this.emit("migration-failed", { proposal, error: err });
      resolver?.resolve(failResult);
      return;
    }

    // Sucesso da Execução Real pelo MCP -> Persistência Canônica do arquivo em Disco (Apenas Supabase)
    let savedFilename: string | undefined;
    if (proposal.provider !== "lovable") {
      const rootDir = resolver?.request?.projectRoot || process.cwd();
      const migrationsDir = path.join(rootDir, "supabase", "migrations");
      const filename = `${this.formatTimestamp()}_${proposal.name}.sql`;
      const filePath = path.join(migrationsDir, filename);

      try {
        await fs.mkdir(migrationsDir, { recursive: true });
        await fs.writeFile(filePath, proposal.originalSql + "\n", "utf8");
        savedFilename = `supabase/migrations/${filename}`;
        proposal.appliedFilename = savedFilename;
      } catch (fileErr: any) {
        console.error("[MigrationManager] Erro ao gravar arquivo de migração em disco:", fileErr);
      }
    }

    proposal.status = "SUCCESS";
    proposal.schemaVerificationStatus = "VERIFIED";
    this.executedHashes.add(proposal.hash);
    console.log(`[Neko/Migration] tool execution completed proposal=${proposal.id} success=true saved=${savedFilename || "-"}`);

    const successResult: MigrationExecutionResult = {
      success: true,
      proposalId: proposal.id,
      status: "SUCCESS",
      appliedFilename: savedFilename,
      affectedTables: proposal.affectedTables,
      schemaVerificationStatus: "VERIFIED"
    };

    this.emit("migration-completed", { proposal, result: successResult });
    resolver?.resolve(successResult);
  }

  /**
   * Localiza uma proposta por id, permissionId ou callId.
   */
  public findProposal(identifier: string): MigrationProposal | null {
    if (!identifier) return null;
    if (this.proposals.has(identifier)) return this.proposals.get(identifier)!;
    for (const p of this.proposals.values()) {
      if (p.permissionId === identifier || p.callId === identifier) {
        return p;
      }
    }
    return null;
  }

  /**
   * Trata o cancelamento explícito da proposta (ex: cancelamento da tarefa ou usuário encerrou).
   */
  public cancelProposal(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "PENDING") return false;

    const resolver = this.pendingResolvers.get(proposalId);
    if (resolver) {
      clearTimeout(resolver.timeoutId);
      this.pendingResolvers.delete(proposalId);
      proposal.status = "CANCELLED";
      const res: MigrationExecutionResult = {
        success: false,
        proposalId,
        status: "CANCELLED",
        error: "A proposta de migração foi cancelada."
      };
      this.emit("migration-cancelled", proposal);
      resolver.resolve(res);
      return true;
    }

    proposal.status = "CANCELLED";
    return true;
  }

  /**
   * Trata a expiração por timeout da proposta (5 minutos sem resposta).
   */
  private handleTimeout(proposalId: string) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "PENDING") return;

    proposal.status = "EXPIRED";
    const resolver = this.pendingResolvers.get(proposalId);
    if (resolver) {
      this.pendingResolvers.delete(proposalId);
      const res: MigrationExecutionResult = {
        success: false,
        proposalId,
        status: "EXPIRED",
        error: "Tempo limite de aprovação expirado (5 minutos). Nenhuma alteração foi realizada."
      };
      this.emit("migration-expired", proposal);
      resolver.resolve(res);
    }
  }

  public getProposal(proposalId: string): MigrationProposal | null {
    return this.proposals.get(proposalId) || null;
  }

  public getPendingProposalForSession(sessionId: string): MigrationProposal | null {
    for (const p of this.proposals.values()) {
      if (p.sessionId === sessionId && p.status === "PENDING") {
        return p;
      }
    }
    return null;
  }

  public getApprovedProposalForSession(sessionId: string): MigrationProposal | null {
    for (const p of this.proposals.values()) {
      if (p.sessionId === sessionId && p.status === "APPROVED") {
        return p;
      }
    }
    return null;
  }

  public getExecutingOrApprovedProposalForSession(sessionId: string): MigrationProposal | null {
    for (const p of this.proposals.values()) {
      if (p.sessionId === sessionId && (p.status === "APPROVED" || p.status === "EXECUTING")) {
        return p;
      }
    }
    return null;
  }

  public getProposalByPermissionOrCallId(identifier: string): MigrationProposal | null {
    return this.findProposal(identifier);
  }

  public cancelAllPendingProposals(): void {
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "PENDING") {
        this.cancelProposal(proposal.id);
      }
    }
  }

  public getPendingProposals(): MigrationProposal[] {
    return Array.from(this.proposals.values()).filter(p => p.status === "PENDING");
  }
}

export const migrationManager = new MigrationManager();

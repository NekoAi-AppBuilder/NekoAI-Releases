import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { lovableCloudManager } from "./lovable-cloud-manager";
import { migrationManager } from "../supabase/migration-manager";
import { sanitizeErrorMessage, getUserFacingError } from "../../shared/error-extractor";

export function findOpenCodeConfigPath(root: string): string {
  const dir = path.resolve(root);
  const candidates = [
    path.join(dir, ".opencode", "opencode.json"),
    path.join(dir, ".opencode", "config.json"),
    path.join(dir, "opencode.json"),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  return path.join(dir, ".opencode", "opencode.json");
}

export async function writeLovableOpenCodeConfig(
  root: string,
  serverUrl: string,
  secretToken: string
): Promise<string> {
  const configPath = findOpenCodeConfigPath(root);
  let config: Record<string, any> = {};
  if (fsSync.existsSync(configPath)) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
      config = JSON.parse(cleaned);
    } catch {
      config = {};
    }
  }

  const mcpName = "neko_lovable_cloud";

  if (!config.mcp || typeof config.mcp !== "object") {
    config.mcp = {};
  }
  config.mcp[mcpName] = {
    type: "remote",
    url: serverUrl,
    headers: {
      "x-neko-mcp-secret": secretToken,
    },
    enabled: true,
    timeout: 300000,
  };

  if (!config.permission || typeof config.permission !== "object") {
    config.permission = {};
  }
  config.permission[`${mcpName}_*`] = "allow";
  config.permission[`${mcpName}_ver_estrutura_do_banco`] = "allow";
  config.permission[`${mcpName}_consultar_dados`] = "allow";
  config.permission[`${mcpName}_alterar_banco`] = "allow";

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

export async function removeLovableOpenCodeConfig(root: string): Promise<void> {
  const configPath = findOpenCodeConfigPath(root);
  if (!fsSync.existsSync(configPath)) return;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
    const config = JSON.parse(cleaned);
    const mcpName = "neko_lovable_cloud";
    if (config.mcp && config.mcp[mcpName]) {
      delete config.mcp[mcpName];
    }
    if (config.permission) {
      for (const key of Object.keys(config.permission)) {
        if (key.startsWith(`${mcpName}_`)) {
          delete config.permission[key];
        }
      }
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch {
    // Ignora erros de limpeza não-críticos
  }
}

export class LovableMcpServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private secretToken: string = "";
  private manager = lovableCloudManager;
  private pendingJitRequests = new Map<string, {
    id: string;
    sessionId: string;
    toolName: string;
    projectId: string;
    resolve: (res: { success: boolean; cancelled?: boolean; reason?: string; jitId?: string }) => void;
    reject: (err: any) => void;
    timeoutId: NodeJS.Timeout;
  }>();
  private onJitRequiredHandler: ((info: { sessionId: string; toolName: string; projectId: string; jitId?: string }) => void) | null = null;
  private activeSessionGetter: (() => string) | null = null;

  constructor(manager?: typeof lovableCloudManager) {
    if (manager) this.manager = manager;
    this.secretToken = crypto.randomBytes(32).toString("hex");

    if (this.manager && typeof (this.manager as any).on === "function") {
      (this.manager as any).on("state-changed", (state: any) => {
        if (state && (state.lovableCloudConnected || state.status === "connected")) {
          this.resolveAllPendingJit();
        }
      });
    }
  }

  public setActiveSessionGetter(getter: () => string): void {
    this.activeSessionGetter = getter;
  }

  public getActiveSessionId(): string {
    if (this.activeSessionGetter) {
      try {
        const s = this.activeSessionGetter();
        if (s) return s;
      } catch {
        // ignore
      }
    }
    return "default_session";
  }

  public setOnJitRequired(handler: (info: { sessionId: string; toolName: string; projectId: string; jitId?: string }) => void): void {
    this.onJitRequiredHandler = handler;
  }

  public getPendingJitCount(): number {
    return this.pendingJitRequests.size;
  }

  public isCloudConnected(state?: any): boolean {
    const s = state || this.manager.getState();
    if (!s) return false;
    return s.lovableCloudConnected === true;
  }

  public waitForLovableCloudConnection(sessionId: string, toolName: string): Promise<{ success: boolean; cancelled?: boolean; reason?: string; jitId?: string }> {
    const currentState = this.manager.getState();
    if (this.isCloudConnected(currentState)) {
      return Promise.resolve({ success: true });
    }

    const jitId = `jit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const projectId = currentState.projectId || currentState.detectedProjectId || "";

    return new Promise<{ success: boolean; cancelled?: boolean; reason?: string; jitId?: string }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingJitRequests.delete(jitId);
        resolve({
          success: false,
          cancelled: false,
          reason: "Tempo limite esgotado (5 minutos) aguardando conexão com o Lovable Cloud.",
          jitId
        });
      }, 5 * 60 * 1000);

      this.pendingJitRequests.set(jitId, {
        id: jitId,
        sessionId,
        toolName,
        projectId,
        resolve,
        reject,
        timeoutId
      });

      console.log(`[Lovable Guard] MCP tool=${toolName} suspended waiting_for_lovable_cloud (jitId=${jitId} session=${sessionId})`);

      if (this.onJitRequiredHandler) {
        try {
          this.onJitRequiredHandler({ sessionId, toolName, projectId, jitId });
        } catch (err) {
          console.warn("[LovableMCP] Erro no onJitRequiredHandler:", err);
        }
      }
    });
  }

  public resolveAllPendingJit(): void {
    if (this.pendingJitRequests.size === 0) return;
    const entries = Array.from(this.pendingJitRequests.entries());
    this.pendingJitRequests.clear();
    console.log(`[LovableMCP] Lovable Cloud conectado. Retomando ${entries.length} chamada(s) de ferramentas MCP suspensas.`);
    for (const [id, req] of entries) {
      try {
        clearTimeout(req.timeoutId);
        req.resolve({ success: true, jitId: id });
      } catch (err) {
        console.warn(`[LovableMCP] Erro ao resolver pendência JIT id=${id}:`, err);
      }
    }
  }

  public cancelAllPendingJit(reason = "Operação cancelada pelo usuário."): void {
    if (this.pendingJitRequests.size === 0) return;
    const entries = Array.from(this.pendingJitRequests.entries());
    this.pendingJitRequests.clear();
    console.log(`[LovableMCP] Cancelando ${entries.length} chamada(s) de ferramentas MCP suspensas. Motivo: ${reason}`);
    for (const [id, req] of entries) {
      try {
        clearTimeout(req.timeoutId);
        req.resolve({ success: false, cancelled: true, reason, jitId: id });
      } catch (err) {
        console.warn(`[LovableMCP] Erro ao cancelar pendência JIT id=${id}:`, err);
      }
    }
  }

  public getSecretToken(): string {
    return this.secretToken;
  }

  public getPort(): number {
    return this.port;
  }

  public getUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  public async start(preferredPort: number = 0): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          console.error("[Neko/LovableMCP] Erro não tratado na requisição HTTP:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "Erro interno no servidor MCP Lovable." }));
          }
        });
      });

      // Escutar SOMENTE em loopback 127.0.0.1 por segurança
      server.listen(preferredPort, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.server = server;
          console.log(`[Neko/LovableMCP] server started port=${this.port} loopback=127.0.0.1`);
          resolve(this.port);
        } else {
          reject(new Error("Falha ao obter endereço do servidor MCP Lovable."));
        }
      });

      server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public async stop(): Promise<void> {
    this.cancelAllPendingJit("Servidor MCP Lovable finalizado.");
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server?.close(() => {
        console.log("[Neko/LovableMCP] server stopped");
        this.server = null;
        resolve();
      });
    });
  }

  private authenticateRequest(req: http.IncomingMessage): boolean {
    const headerSecret = req.headers["x-neko-mcp-secret"];
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const querySecret = reqUrl.searchParams.get("secret");

    const provided = headerSecret || querySecret;
    if (!provided || typeof provided !== "string") return false;

    // Comparação de tempo constante contra ataques de temporização
    const bufA = Buffer.from(provided);
    const bufB = Buffer.from(this.secretToken);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = reqUrl.pathname;

    // Permite SSE ou JSON-RPC endpoint
    if (req.method === "GET" && pathname === "/sse") {
      if (!this.authenticateRequest(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autorizado." }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`event: endpoint\ndata: /mcp?secret=${this.secretToken}\n\n`);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-neko-mcp-secret",
      });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Método não permitido." }));
      return;
    }

    if (!this.authenticateRequest(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Autenticação MCP inválida." }));
      return;
    }

    let bodyRaw = "";
    for await (const chunk of req) {
      bodyRaw += chunk;
    }

    let jsonRpcReq: any = null;
    try {
      jsonRpcReq = JSON.parse(bodyRaw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }));
      return;
    }

    const responsePayload = await this.handleJsonRpcMessage(jsonRpcReq);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(responsePayload));
  }

  public async handleJsonRpcMessage(jsonRpcReq: any): Promise<any> {
    if (!jsonRpcReq || typeof jsonRpcReq !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Requisição inválida" } };
    }

    const { id, method, params } = jsonRpcReq;

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "neko-lovable-cloud-mcp",
            version: "1.0.0",
          },
        },
      };
    }

    if (method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "ver_estrutura_do_banco",
              description:
                "Introspecção completa e somente leitura da estrutura do banco de dados PostgreSQL no Lovable Cloud do workspace ativo (tabelas, colunas, tipos, PK, FK, RLS, políticas e enums). Esta ferramenta é estritamente de LEITURA.",
              inputSchema: {
                type: "object",
                properties: {},
                required: [],
              },
            },
            {
              name: "consultar_dados",
              description:
                "Executa uma consulta SQL SOMENTE DE LEITURA (SELECT) no banco de dados Lovable Cloud vinculado ao workspace atual. Operações de mutação (INSERT, UPDATE, DELETE, ALTER, DROP, TRUNCATE, etc.) são estritamente proibidas e rejeitadas.",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Instrução SQL SELECT a ser executada (somente leitura).",
                  },
                },
                required: ["query"],
              },
            },
            {
              name: "alterar_banco",
              description:
                "Executa alterações de estrutura (DDL) ou mutações de dados (DML) no banco PostgreSQL Lovable Cloud vinculado ao workspace. Toda alteração exige aprovação prévia do usuário via Migration Card.",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Instrução SQL a ser executada (ex: CREATE TABLE, ALTER TABLE, INSERT, UPDATE, DELETE, etc).",
                  },
                  summary: {
                    type: "string",
                    description: "Breve resumo explicativo da alteração em português.",
                  },
                },
                required: ["query"],
              },
            },
          ],
        },
      };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      const currentWorkspace = this.manager.getActiveProjectPath();
      const currentGen = this.manager.getProjectGeneration();
      const currentState = this.manager.getState();

      if (!currentWorkspace) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Este projeto não possui um Lovable Cloud conectado.",
              },
            ],
            isError: true,
          },
        };
      }

      const effectiveProjectId =
        currentState.projectId ||
        currentState.lovableProjectId ||
        currentState.detectedProjectId ||
        null;

      const isLovable = Boolean(currentState.isLovableProject || effectiveProjectId);

      console.log(
        `[Lovable JIT Debug] isLovableProject=${currentState.isLovableProject} projectId=${currentState.projectId} lovableProjectId=${currentState.lovableProjectId} detectedProjectId=${currentState.detectedProjectId} effectiveProjectId=${effectiveProjectId} hasLovableCloud=${currentState.hasLovableCloud} lovableCloudConnected=${currentState.lovableCloudConnected} lovableSessionValid=${currentState.lovableSessionValid} status=${currentState.status} tool=${toolName} decision=${!this.isCloudConnected(currentState) ? "JIT_SUSPEND" : "EXECUTE"}`
      );

      if (!isLovable) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Este projeto não possui um Lovable Cloud conectado.",
              },
            ],
            isError: true,
          },
        };
      }

      // Se for Lovable mas não possui ID de projeto identificado, não pode acionar JIT
      if (isLovable && !effectiveProjectId) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Projeto Lovable detectado, mas nenhum ID de projeto foi identificado para conexão com o Lovable Cloud.",
              },
            ],
            isError: true,
          },
        };
      }

      let activeJitId: string | undefined = undefined;

      // Layer 2 JIT Guard: Se o Lovable Cloud não estiver ativamente conectado,
      // suspende a execução da ferramenta MCP e solicita conexão JIT na interface.
      if (!this.isCloudConnected(currentState)) {
        console.log(`[Lovable Guard] MCP tool=${toolName} triggered without Lovable Cloud connected. Initiating JIT connection suspension.`);

        const meta = params?._meta || params?.metadata || {};
        const callSessionId = meta.sessionId || meta.session_id || params?.sessionId || params?.session_id || toolArgs.sessionId || this.getActiveSessionId() || "default_session";

        const jitResult = await this.waitForLovableCloudConnection(callSessionId, toolName);
        activeJitId = jitResult.jitId;
        if (!jitResult.success) {
          const cancelMsg = jitResult.reason || "Operação cancelada pelo usuário. A ferramenta de banco de dados não foi executada pois a conexão com o Lovable Cloud foi recusada.";
          console.log(`[Lovable Guard] MCP tool=${toolName} JIT cancelled or timed out: ${cancelMsg}`);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: cancelMsg,
                },
              ],
              isError: true,
            },
          };
        }

        console.log(`[Lovable Guard] MCP tool=${toolName} JIT resumed with successful connection! Proceeding with execution.`);
      }

      // Reobtém referências atualizadas pós-conexão JIT
      const activeWorkspace = this.manager.getActiveProjectPath() || currentWorkspace;
      const activeGen = this.manager.getProjectGeneration();
      const activeState = this.manager.getState();

      if (!this.isCloudConnected(activeState)) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Não foi possível validar a conexão com o Lovable Cloud após a autenticação.",
              },
            ],
            isError: true,
          },
        };
      }

      console.log(
        `[Neko/LovableMCP] tool=${toolName} workspace=${activeWorkspace} projectId=${activeState.projectId}`
      );

      if (toolName === "ver_estrutura_do_banco") {
        try {
          const schemaText = await this.manager.getDatabaseSchema({
            projectPath: activeWorkspace,
            generation: activeGen,
          });
          console.log(`[Neko/LovableMCP] tool=ver_estrutura_do_banco completed success=true`);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: schemaText,
                },
              ],
              isError: false,
            },
          };
        } catch (err: any) {
          const safeErr = sanitizeErrorMessage(getUserFacingError(err, "Falha ao ler estrutura do banco Lovable Cloud."));
          console.log(`[Neko/LovableMCP] tool=ver_estrutura_do_banco failed err=${safeErr}`);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Erro: ${safeErr}`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      if (toolName === "consultar_dados") {
        const query = typeof toolArgs.query === "string" ? toolArgs.query.trim() : "";
        if (!query) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: "Erro: o parâmetro 'query' SQL é obrigatório.",
                },
              ],
              isError: true,
            },
          };
        }

        console.log(`[Neko/LovableMCP] query classified=READ_ONLY queryLen=${query.length}`);

        try {
          const res = await this.manager.executeQuery(query, {
            projectPath: activeWorkspace,
            generation: activeGen,
          });

          console.log(`[Neko/LovableMCP] query completed success=true rowsCount=${res.rowCount}`);

          const formattedText = this.formatQueryResultForAgent(res.rows, res.rowCount);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: formattedText,
                },
              ],
              isError: false,
            },
          };
        } catch (err: any) {
          const safeErr = sanitizeErrorMessage(getUserFacingError(err, "Falha ao executar consulta SQL no Lovable Cloud."));
          console.log(`[Neko/LovableMCP] query completed success=false error=${safeErr}`);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Erro: ${safeErr}`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      if (toolName === "alterar_banco") {
        const query = typeof toolArgs.query === "string" ? toolArgs.query.trim() : "";
        const summary = typeof toolArgs.summary === "string" ? toolArgs.summary.trim() : undefined;

        if (!query) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: "Erro: o parâmetro 'query' SQL é obrigatório.",
                },
              ],
              isError: true,
            },
          };
        }

        const meta = params?._meta || params?.metadata || {};
        const sessionId = meta.sessionId || meta.session_id || params?.sessionId || params?.session_id || toolArgs.sessionId || this.getActiveSessionId() || "default_session";
        const permissionId = meta.permissionId || toolArgs.permissionId || (activeJitId ? `perm_${activeJitId}` : `perm_${Date.now()}`);
        const callId = meta.callId || toolArgs.callId || (typeof id === "string" ? id : String(id || Date.now()));

        try {
          console.log(`[Neko/LovableMCP] Propondo alteração de banco no MigrationManager queryLen=${query.length} jitId=${activeJitId}`);
          const proposalResult = await migrationManager.proposeMigration({
            sessionId,
            permissionId,
            jitRequestId: activeJitId,
            callId,
            projectRef: activeState.projectId || "",
            name: "lovable_mutation",
            sql: query,
            summary: summary || "Alteração de dados/estrutura no Lovable Cloud",
            provider: "lovable",
            lovableProjectId: activeState.projectId || undefined,
            projectGeneration: activeGen,
            projectRoot: activeWorkspace
          });

          if (!proposalResult.success || proposalResult.status !== "APPROVED") {
            const errReason = proposalResult.error || "Operação SQL rejeitada pelo usuário.";
            console.log(`[Neko/LovableMCP] Proposta não aprovada status=${proposalResult.status} reason=${errReason}`);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: errReason,
                  },
                ],
                isError: true,
              },
            };
          }

          // Notifica início de execução autorizada
          migrationManager.notifyToolExecuting(proposalResult.proposalId);

          // Execução Real no Lovable Cloud
          try {
            const execRes = await this.manager.executeQuery(query, {
              projectPath: activeWorkspace,
              generation: activeGen,
              skipReadOnlyCheck: true
            });

            await migrationManager.notifyToolCompleted(proposalResult.proposalId, true);
            console.log(`[Neko/LovableMCP] Execução de alteração concluída com sucesso rowsCount=${execRes.rowCount}`);

            let returnMsg = `Alteração executada no Lovable Cloud com sucesso. ${execRes.rowCount} linha(s) afetada(s).`;
            if (execRes.rows && execRes.rows.length > 0) {
              returnMsg += "\n\n" + this.formatQueryResultForAgent(execRes.rows, execRes.rowCount);
            }

            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: returnMsg,
                  },
                ],
                isError: false,
              },
            };
          } catch (execErr: any) {
            const safeErr = sanitizeErrorMessage(getUserFacingError(execErr, "Falha ao executar alteração no Lovable Cloud."));
            await migrationManager.notifyToolCompleted(proposalResult.proposalId, false, safeErr);
            console.log(`[Neko/LovableMCP] Erro na execução real no Lovable Cloud: ${safeErr}`);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Erro: ${safeErr}`,
                  },
                ],
                isError: true,
              },
            };
          }
        } catch (propErr: any) {
          const safeErr = sanitizeErrorMessage(getUserFacingError(propErr, "Falha na proposta de migração."));
          console.log(`[Neko/LovableMCP] Erro na submissão de proposta: ${safeErr}`);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Erro: ${safeErr}`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Erro: Ferramenta '${toolName}' desconhecida ou não permitida.`,
            },
          ],
          isError: true,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Método '${method}' não suportado pelo servidor MCP Lovable.`,
      },
    };
  }

  private formatQueryResultForAgent(rows: any[], count: number): string {
    if (!rows || rows.length === 0) {
      return "Consulta realizada com sucesso. Nenhum registro encontrado (0 linhas).";
    }

    // Limitar exibição a 50 linhas para não sobrecarregar o contexto do Agent
    const maxDisplay = 50;
    const slice = rows.slice(0, maxDisplay);

    let output = `Consulta realizada com sucesso. ${count} linha(s) encontrada(s):\n\n`;
    output += "```json\n" + JSON.stringify(slice, null, 2) + "\n```";

    if (count > maxDisplay) {
      output += `\n\n*(Exibindo ${maxDisplay} de ${count} registros)*`;
    }

    return output;
  }
}

export const lovableMcpServer = new LovableMcpServer();

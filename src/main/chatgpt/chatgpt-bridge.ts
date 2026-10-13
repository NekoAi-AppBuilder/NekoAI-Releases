// src/main/chatgpt/chatgpt-bridge.ts
// Servidor bridge local HTTP (127.0.0.1:1456)
// Traduz requisições padrão OpenAI (/v1/chat/completions) do OpenCode para a API Codex do ChatGPT Pessoal.

import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import {
  CHATGPT_API,
  CHATGPT_BRIDGE_PORT,
  CHATGPT_ORIGINATOR,
  ChatGptAccountData,
  ChatGptModelInfo,
  ChatGptUsageInfo,
  ChatGptError,
} from "./chatgpt-types";
import { parseRateLimitHeaders } from "./chatgpt-auth";

export interface BridgeManagerDelegate {
  getAccount(): Promise<ChatGptAccountData | null>;
  ensureFreshToken(): Promise<ChatGptAccountData>;
  getModels(): ChatGptModelInfo[];
  onRateLimitUpdate(usage: ChatGptUsageInfo): void;
}

export class ChatGptBridgeServer {
  private server: http.Server | null = null;
  private delegate: BridgeManagerDelegate;
  private turnStates = new Map<string, string>(); // sessionId -> x-codex-turn-state
  private isRunning: boolean = false;

  constructor(delegate: BridgeManagerDelegate) {
    this.delegate = delegate;
  }

  public async start(): Promise<void> {
    if (this.isRunning && this.server) return;

    return new Promise<void>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      srv.on("error", (err: any) => {
        console.error("[Neko/ChatGptBridge] Erro no servidor bridge:", err);
        if (!this.isRunning) reject(err);
      });

      srv.listen(CHATGPT_BRIDGE_PORT, "127.0.0.1", () => {
        this.server = srv;
        this.isRunning = true;
        console.log(`[Neko/ChatGptBridge] Bridge ativo em http://127.0.0.1:${CHATGPT_BRIDGE_PORT}`);
        resolve();
      });
    });
  }

  public stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
    this.isRunning = false;
    this.turnStates.clear();
    console.log("[Neko/ChatGptBridge] Bridge finalizado.");
  }

  public getRunning(): boolean {
    return this.isRunning;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${CHATGPT_BRIDGE_PORT}`);
    const pathname = reqUrl.pathname;

    try {
      if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", bridge: "chatgpt-personal", port: CHATGPT_BRIDGE_PORT }));
        return;
      }

      if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
        await this.handleListModels(res);
        return;
      }

      if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
        await this.handleResponses(req, res);
        return;
      }

      if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
        await this.handleChatCompletions(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Endpoint ${pathname} não encontrado no Bridge.`, type: "invalid_request_error" } }));
    } catch (err: any) {
      console.error("[Neko/ChatGptBridge] Erro não tratado:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err?.message || "Erro interno no Bridge ChatGPT", type: "api_error" } }));
      }
    }
  }

  private async handleListModels(res: http.ServerResponse): Promise<void> {
    const models = this.delegate.getModels();
    const now = Math.floor(Date.now() / 1000);
    const data = models.map((m) => ({
      id: m.slug,
      object: "model",
      created: now,
      owned_by: "chatgpt-personal",
      permission: [],
      root: m.slug,
      parent: null,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", (err) => reject(err));
    });
  }

  /**
   * Endpoint /v1/responses (OpenAI Responses API utilizada pelo OpenCode para modelos com reasoning)
   */
  private async handleResponses(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let account = await this.delegate.getAccount();
    if (!account || !account.access) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Conta do ChatGPT pessoal não conectada.", type: "authentication_error" } }));
      return;
    }

    try {
      account = await this.delegate.ensureFreshToken();
    } catch (err: any) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Sessão expirada: ${err?.message || "Falha na renovação"}`, type: "authentication_error" } }));
      return;
    }

    const rawBody = await this.readBody(req);
    let openAiReq: any;
    try {
      openAiReq = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Corpo JSON inválido.", type: "invalid_request_error" } }));
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      await this.executeResponsesRequest(account, openAiReq, res, abortController.signal);
    } catch (err: any) {
      if (abortController.signal.aborted) {
        console.log("[Neko/ChatGptBridge] Requisição /responses cancelada pelo cliente.");
        return;
      }
      console.error("[Neko/ChatGptBridge] Erro na execução /responses:", err?.message || err);
      if (!res.headersSent) {
        res.writeHead(err?.status || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err?.message || "Falha na chamada ao ChatGPT", type: "api_error" } }));
      }
    }
  }

  /**
   * Endpoint /v1/chat/completions (OpenAI Chat Completions API padrão)
   */
  private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let account = await this.delegate.getAccount();
    if (!account || !account.access) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Conta do ChatGPT pessoal não conectada.", type: "authentication_error" } }));
      return;
    }

    try {
      account = await this.delegate.ensureFreshToken();
    } catch (err: any) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Sessão expirada: ${err?.message || "Falha na renovação"}`, type: "authentication_error" } }));
      return;
    }

    const rawBody = await this.readBody(req);
    let openAiReq: any;
    try {
      openAiReq = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Corpo JSON inválido.", type: "invalid_request_error" } }));
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      await this.executeChatCompletionsRequest(account, openAiReq, res, abortController.signal);
    } catch (err: any) {
      if (abortController.signal.aborted) {
        console.log("[Neko/ChatGptBridge] Requisição /chat/completions cancelada pelo cliente.");
        return;
      }
      console.error("[Neko/ChatGptBridge] Erro na execução /chat/completions:", err?.message || err);
      if (!res.headersSent) {
        res.writeHead(err?.status || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err?.message || "Falha na chamada ao ChatGPT", type: "api_error" } }));
      }
    }
  }

  private normalizeResponsesInput(rawInput: any[]): any[] {
    const output: any[] = [];
    for (const item of rawInput) {
      if (!item || typeof item !== "object") continue;
      const t = item.type;
      if (t === "message") {
        const content: any[] = [];
        if (typeof item.content === "string") {
          content.push({ type: "input_text", text: item.content });
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part?.type === "input_text" || part?.type === "text") {
              content.push({ type: "input_text", text: part.text || "" });
            } else if (part?.type === "input_image" || part?.type === "image_url") {
              const url = part.image_url?.url || part.image_url || part.url;
              content.push({ type: "input_image", image_url: url });
            } else if (part?.type === "image" && part.image) {
              content.push({ type: "input_image", image_url: part.image });
            } else if (typeof part === "string") {
              content.push({ type: "input_text", text: part });
            }
          }
        }
        output.push({
          type: "message",
          role: item.role || "user",
          content: content.length > 0 ? content : [{ type: "input_text", text: "" }],
        });
      } else if (t === "function_call") {
        output.push({
          type: "function_call",
          call_id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        });
      } else if (t === "function_call_output") {
        output.push({
          type: "function_call_output",
          call_id: item.call_id || item.id || "call_unknown",
          output: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
        });
      } else {
        output.push(item);
      }
    }
    return output;
  }

  private convertMessagesToCodex(messages: any[]): { input: any[]; instructions: string } {
    let instructions = "You are an expert AI software engineer assisting in software development.";
    const instructionsParts: string[] = [];
    const input: any[] = [];

    for (const msg of messages) {
      const role = String(msg.role || "").toLowerCase();
      if (role === "system") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (text.trim()) instructionsParts.push(text.trim());
      } else if (role === "user") {
        const content: any[] = [];
        if (typeof msg.content === "string") {
          content.push({ type: "input_text", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === "text" && part.text) {
              content.push({ type: "input_text", text: part.text });
            } else if (part?.type === "image_url") {
              const url = part.image_url?.url || part.image_url;
              content.push({ type: "input_image", image_url: url });
            } else if (part?.type === "image" && part.image) {
              content.push({ type: "input_image", image_url: part.image });
            }
          }
        }
        if (content.length > 0) {
          input.push({ type: "message", role: "user", content });
        }
      } else if (role === "assistant") {
        if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: "function_call",
              call_id: tc.id || `call_${crypto.randomUUID()}`,
              name: tc.function?.name,
              arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
            });
          }
        }
        if (msg.content) {
          const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          if (text.trim()) {
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
          }
        }
      } else if (role === "tool") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || msg.id || msg.call_id || "call_unknown",
          output: text,
        });
      }
    }

    if (instructionsParts.length > 0) {
      instructions = instructionsParts.join("\n\n");
    }

    return { input, instructions };
  }

  /**
   * Executa requisição no formato OpenAI Responses API (/v1/responses)
   */
  private async executeResponsesRequest(
    account: ChatGptAccountData,
    openAiReq: any,
    res: http.ServerResponse,
    signal: AbortSignal
  ): Promise<void> {
    const rawModel = String(openAiReq.model || "gpt-5.5").trim();
    const cleanModelSlug = rawModel.replace(/^(chatgpt::?|chatgpt-personal[\/:]|openai[\/:])?/i, "").trim().toLowerCase();

    let instructions = typeof openAiReq.instructions === "string" && openAiReq.instructions.trim()
      ? openAiReq.instructions.trim()
      : "You are an expert AI software engineer assisting in software development.";

    let input: any[] = [];
    if (Array.isArray(openAiReq.input) && openAiReq.input.length > 0) {
      input = this.normalizeResponsesInput(openAiReq.input);
    } else if (typeof openAiReq.input === "string" && openAiReq.input.trim()) {
      input = [{ type: "message", role: "user", content: [{ type: "input_text", text: openAiReq.input.trim() }] }];
    } else if (Array.isArray(openAiReq.messages) && openAiReq.messages.length > 0) {
      const converted = this.convertMessagesToCodex(openAiReq.messages);
      input = converted.input;
      if (converted.instructions && instructions === "You are an expert AI software engineer assisting in software development.") {
        instructions = converted.instructions;
      }
    }

    if (input.length === 0) {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "Prosseguir com a execução da tarefa." }] });
    }

    const openAiTools: any[] = Array.isArray(openAiReq.tools) ? openAiReq.tools : [];
    const codexTools = openAiTools
      .map((t: any) => ({
        type: "function",
        name: t.name || t.function?.name,
        description: t.description || t.function?.description || "",
        parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} },
        strict: false,
      }))
      .filter((t: any) => Boolean(t.name));

    const sessionId = crypto.randomUUID();
    const lastTurnState = this.turnStates.get(sessionId);

    const codexBody: any = {
      model: cleanModelSlug,
      instructions,
      input,
      store: false,
      stream: true,
      include: Array.isArray(openAiReq.include) && openAiReq.include.length > 0
        ? openAiReq.include
        : ["reasoning.encrypted_content"],
      prompt_cache_key: sessionId,
    };

    if (codexTools.length > 0) {
      codexBody.tools = codexTools;
      codexBody.tool_choice = openAiReq.tool_choice || "auto";
      codexBody.parallel_tool_calls = openAiReq.parallel_tool_calls !== false;
    }

    const reasoningEffort = openAiReq.reasoning?.effort || openAiReq.reasoning_effort || openAiReq.effort;
    if (reasoningEffort) {
      codexBody.reasoning = { effort: reasoningEffort, summary: "auto" };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${account.access}`,
      originator: CHATGPT_ORIGINATOR,
      session_id: sessionId,
    };

    if (account.conta) headers["chatgpt-account-id"] = account.conta;
    if (lastTurnState) headers["x-codex-turn-state"] = lastTurnState;

    console.log(`[Neko/ChatGptBridge] Enviando requisição /responses Codex model=${cleanModelSlug} tools=${codexTools.length} inputLen=${input.length}`);

    let codexRes: Response;
    try {
      codexRes = await fetch(`${CHATGPT_API}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(codexBody),
        signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError" || signal.aborted) {
        return;
      }
      throw new ChatGptError("Sem conexão com o ChatGPT pessoal.", { codigo: "falhou" });
    }

    const limitInfo = parseRateLimitHeaders(codexRes.headers);
    if (limitInfo) {
      this.delegate.onRateLimitUpdate(limitInfo);
    }

    const newTurnState = codexRes.headers.get("x-codex-turn-state");
    if (newTurnState) {
      this.turnStates.set(sessionId, newTurnState);
    }

    if (!codexRes.ok) {
      const errBody = await codexRes.text().catch(() => "");
      console.error(`[Neko/ChatGptBridge] Codex retornou status=${codexRes.status}: ${errBody}`);
      let errMsg = "";
      let errType = "api_error";
      let errCode: string | number = codexRes.status;
      try {
        const j = JSON.parse(errBody);
        errMsg = j.error?.message || j.message || "";
        errType = j.error?.type || j.type || errType;
        if (j.error?.code) errCode = j.error.code;
      } catch {}
      const msg = errMsg || errBody.slice(0, 300) || "Erro de inferência no ChatGPT pessoal";
      if (!res.headersSent) {
        res.writeHead(codexRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: msg, type: errType, code: errCode } }));
      }
      return;
    }

    const isClientStream = openAiReq.stream !== false;
    if (isClientStream) {
      await this.pipeCodexResponsesStream(codexRes, res, signal);
    } else {
      await this.aggregateCodexResponses(codexRes, cleanModelSlug, res);
    }
  }

  /**
   * Executa requisição no formato OpenAI Chat Completions (/v1/chat/completions)
   */
  private async executeChatCompletionsRequest(
    account: ChatGptAccountData,
    openAiReq: any,
    res: http.ServerResponse,
    signal: AbortSignal
  ): Promise<void> {
    const rawModel = String(openAiReq.model || "gpt-5.5").trim();
    const cleanModelSlug = rawModel.replace(/^(chatgpt::?|chatgpt-personal[\/:]|openai[\/:])?/i, "").trim().toLowerCase();

    const messages: any[] = Array.isArray(openAiReq.messages) ? openAiReq.messages : [];
    const converted = this.convertMessagesToCodex(messages);
    const instructions = converted.instructions;
    const input = converted.input.length > 0
      ? converted.input
      : [{ type: "message", role: "user", content: [{ type: "input_text", text: "Prosseguir com a execução da tarefa." }] }];

    const openAiTools: any[] = Array.isArray(openAiReq.tools) ? openAiReq.tools : [];
    const codexTools = openAiTools
      .map((t: any) => ({
        type: "function",
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || "",
        parameters: t.function?.parameters || t.parameters || { type: "object", properties: {} },
        strict: false,
      }))
      .filter((t: any) => Boolean(t.name));

    const sessionId = crypto.randomUUID();
    const lastTurnState = this.turnStates.get(sessionId);

    const codexBody: any = {
      model: cleanModelSlug,
      instructions,
      input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: sessionId,
    };

    if (codexTools.length > 0) {
      codexBody.tools = codexTools;
      codexBody.tool_choice = "auto";
      codexBody.parallel_tool_calls = true;
    }

    const reasoningEffort = openAiReq.reasoning_effort || openAiReq.effort;
    if (reasoningEffort) {
      codexBody.reasoning = { effort: reasoningEffort, summary: "auto" };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${account.access}`,
      originator: CHATGPT_ORIGINATOR,
      session_id: sessionId,
    };

    if (account.conta) headers["chatgpt-account-id"] = account.conta;
    if (lastTurnState) headers["x-codex-turn-state"] = lastTurnState;

    console.log(`[Neko/ChatGptBridge] Enviando requisição /chat/completions Codex model=${cleanModelSlug} tools=${codexTools.length} inputLen=${input.length}`);

    let codexRes: Response;
    try {
      codexRes = await fetch(`${CHATGPT_API}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(codexBody),
        signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError" || signal.aborted) {
        return;
      }
      throw new ChatGptError("Sem conexão com o ChatGPT pessoal.", { codigo: "falhou" });
    }

    const limitInfo = parseRateLimitHeaders(codexRes.headers);
    if (limitInfo) {
      this.delegate.onRateLimitUpdate(limitInfo);
    }

    const newTurnState = codexRes.headers.get("x-codex-turn-state");
    if (newTurnState) {
      this.turnStates.set(sessionId, newTurnState);
    }

    if (!codexRes.ok) {
      const errBody = await codexRes.text().catch(() => "");
      console.error(`[Neko/ChatGptBridge] Codex retornou status=${codexRes.status}: ${errBody}`);
      let errMsg = "";
      let errType = "api_error";
      let errCode: string | number = codexRes.status;
      try {
        const j = JSON.parse(errBody);
        errMsg = j.error?.message || j.message || "";
        errType = j.error?.type || j.type || errType;
        if (j.error?.code) errCode = j.error.code;
      } catch {}
      const msg = errMsg || errBody.slice(0, 300) || "Erro de inferência no ChatGPT pessoal";
      if (!res.headersSent) {
        res.writeHead(codexRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: msg, type: errType, code: errCode } }));
      }
      return;
    }

    const isClientStream = openAiReq.stream !== false;
    if (isClientStream) {
      await this.streamCodexToOpenAI(codexRes, cleanModelSlug, res, signal);
    } else {
      await this.aggregateCodexToOpenAI(codexRes, cleanModelSlug, res);
    }
  }

  /**
   * Repassa o stream nativo do endpoint /responses diretamente para o cliente com integridade SSE
   */
  private async pipeCodexResponsesStream(
    codexRes: Response,
    res: http.ServerResponse,
    signal: AbortSignal
  ): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (!codexRes.body) {
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const reader = codexRes.body.getReader();
    const decoder = new TextDecoder();
    let hasDone = false;

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          if (text.includes("[DONE]")) hasDone = true;
          res.write(value);
        }
      }
      if (!hasDone && !signal.aborted) {
        res.write("data: [DONE]\n\n");
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  /**
   * Agrega eventos SSE em objeto JSON padrão Responses API
   */
  private async aggregateCodexResponses(
    codexRes: Response,
    modelSlug: string,
    res: http.ServerResponse
  ): Promise<void> {
    const rawText = await codexRes.text();
    const blocks = rawText.split("\n\n");
    let completedResponse: any = null;
    let accumulatedText = "";

    for (const block of blocks) {
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!dataLines || dataLines === "[DONE]") continue;

      try {
        const ev = JSON.parse(dataLines);
        if (ev.type === "response.completed" && ev.response) {
          completedResponse = ev.response;
          break;
        }
        if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
          accumulatedText += ev.delta;
        }
      } catch {}
    }

    const finalObj = completedResponse || {
      id: `resp_${crypto.randomUUID()}`,
      object: "response",
      created: Math.floor(Date.now() / 1000),
      model: modelSlug,
      status: "completed",
      output: [
        {
          id: `item_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: accumulatedText }],
        },
      ],
    };

    if (!finalObj.output_text) {
      finalObj.output_text = accumulatedText;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(finalObj));
  }

  /**
   * Traduz o SSE nativo do Codex para o SSE padrão do OpenAI Chat Completions chunk a chunk
   */
  private async streamCodexToOpenAI(
    codexRes: Response,
    modelSlug: string,
    res: http.ServerResponse,
    signal: AbortSignal
  ): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Envia o chunk inicial com role="assistant"
    const sendChunk = (delta: any, finishReason: string | null = null) => {
      const payload = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelSlug,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendChunk({ role: "assistant" });

    if (!codexRes.body) {
      sendChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const reader = codexRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let toolCallIndex = 0;
    const activeToolCalls = new Map<string, number>();
    let hasStreamedText = false;

    const processBlock = (block: string) => {
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");

      if (!dataLines || dataLines === "[DONE]") return;

      let event: any;
      try {
        event = JSON.parse(dataLines);
      } catch {
        return;
      }

      // Tratamento de falhas emitidas pelo Codex no meio do stream
      if (event.type === "response.failed" || event.type === "error") {
        const errMsg = event.response?.error?.message || event.error?.message || "O ChatGPT pessoal encerrou a resposta prematuramente.";
        console.error("[Neko/ChatGptBridge] Erro recebido no stream Codex:", errMsg);
        return;
      }

      // Eventos delta de texto em tempo real
      if (
        (event.type === "response.output_text.delta" || event.type === "response.content_part.delta") &&
        typeof event.delta === "string"
      ) {
        hasStreamedText = true;
        sendChunk({ content: event.delta });
        return;
      }

      // Eventos delta de argumentos de tool calls em tempo real
      if (
        event.type === "response.function_call_arguments.delta" &&
        event.call_id &&
        typeof event.delta === "string"
      ) {
        let callIdx = activeToolCalls.get(event.call_id);
        if (callIdx === undefined) {
          callIdx = toolCallIndex++;
          activeToolCalls.set(event.call_id, callIdx);
        }
        sendChunk({
          tool_calls: [
            {
              index: callIdx,
              id: event.call_id,
              type: "function",
              function: {
                arguments: event.delta,
              },
            },
          ],
        });
        return;
      }

      // Evento de item concluído
      if (event.type === "response.output_item.done" && event.item) {
        const item = event.item;
        if (item.type === "message" && Array.isArray(item.content)) {
          // Só emite se não tiver transmitido os deltas de texto token a token para não duplicar na UI
          if (!hasStreamedText) {
            for (const c of item.content) {
              if (c.type === "output_text" && c.text) {
                sendChunk({ content: c.text });
              }
            }
          }
        } else if (item.type === "function_call") {
          let callIdx = activeToolCalls.get(item.call_id);
          if (callIdx === undefined) {
            callIdx = toolCallIndex++;
            activeToolCalls.set(item.call_id, callIdx);
          }
          sendChunk({
            tool_calls: [
              {
                index: callIdx,
                id: item.call_id,
                type: "function",
                function: {
                  name: item.name,
                  arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
                },
              },
            ],
          });
        }
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        const finishReason = activeToolCalls.size > 0 ? "tool_calls" : "stop";
        sendChunk({}, finishReason);
      }
    };

    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          processBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }

      if (buffer.trim()) {
        processBlock(buffer);
      }
    } finally {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }

  /**
   * Agrega o stream em caso de requisição síncrona (stream: false)
   */
  private async aggregateCodexToOpenAI(
    codexRes: Response,
    modelSlug: string,
    res: http.ServerResponse
  ): Promise<void> {
    const reader = codexRes.body?.getReader();
    if (!reader) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Corpo de resposta ausente" } }));
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let hasDeltaText = false;
    const toolCalls: any[] = [];

    const processBlock = (block: string) => {
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");

      if (!dataLines || dataLines === "[DONE]") return;

      let event: any;
      try {
        event = JSON.parse(dataLines);
      } catch {
        return;
      }

      if (
        (event.type === "response.output_text.delta" || event.type === "response.content_part.delta") &&
        typeof event.delta === "string"
      ) {
        hasDeltaText = true;
        fullText += event.delta;
        return;
      }

      if (event.type === "response.output_item.done" && event.item) {
        const item = event.item;
        if (item.type === "message" && Array.isArray(item.content)) {
          if (!hasDeltaText) {
            for (const c of item.content) {
              if (c.type === "output_text" && c.text) fullText += c.text;
            }
          }
        } else if (item.type === "function_call") {
          toolCalls.push({
            id: item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
            },
          });
        }
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        processBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    if (buffer.trim()) processBlock(buffer);

    const message: any = {
      role: "assistant",
      content: fullText || null,
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const completion = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelSlug,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(completion));
  }
}

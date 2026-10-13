// src/main/chatgpt/chatgpt-auth.ts
// Módulo de Autenticação OAuth PKCE, tokens, catálogo e limites para ChatGPT pessoal

import crypto from "node:crypto";
import http from "node:http";
import { URL, URLSearchParams } from "node:url";
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_ISSUER,
  CHATGPT_REDIRECT_URI,
  CHATGPT_ORIGINATOR,
  CHATGPT_API,
  CHATGPT_VERSION,
  CHATGPT_SCOPE,
  CHATGPT_AUTH_PORT,
  CHATGPT_FALLBACK_MODELS,
  ChatGptAccountData,
  ChatGptTokens,
  ChatGptModelInfo,
  ChatGptUsageInfo,
  ChatGptError,
} from "./chatgpt-types";

const AUTH_CLAIM_KEY = "https://api.openai.com/auth";
const ONE_DAY_MS = 86_400_000;

/**
 * Converte Buffer/bytes para string base64url segura
 */
export function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Gera par de chaves PKCE (verifier e challenge SHA-256)
 */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const verifierBytes = crypto.randomBytes(64);
  let verifier = "";
  for (let i = 0; i < verifierBytes.length; i++) {
    verifier += chars[verifierBytes[i] % chars.length];
  }

  const hash = crypto.createHash("sha256").update(verifier).digest();
  const challenge = base64Url(hash);
  return { verifier, challenge };
}

/**
 * Gera state aleatório para proteção CSRF
 */
export function newState(): string {
  return base64Url(crypto.randomBytes(32));
}

/**
 * Constrói a URL oficial de login OAuth PKCE
 */
export function getLoginUrl({ challenge, state }: { challenge: string; state: string }): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: CHATGPT_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CHATGPT_ORIGINATOR,
  });
  return `${CHATGPT_ISSUER}/oauth/authorize?${p.toString()}`;
}

/**
 * Decodifica o payload JSON de um JWT sem verificação de assinatura
 */
export function parseJwtClaims(jwt: string | undefined): Record<string, any> {
  if (!jwt) return {};
  try {
    const parts = String(jwt).split(".");
    if (parts.length < 2) return {};
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(jsonStr);
  } catch {
    return {};
  }
}

export function extractAccountId(tokens: ChatGptTokens): string | null {
  for (const jwt of [tokens.id_token, tokens.access_token]) {
    const c = parseJwtClaims(jwt);
    const id = c.chatgpt_account_id || c[AUTH_CLAIM_KEY]?.chatgpt_account_id || c.organizations?.[0]?.id;
    if (id) return id;
  }
  return null;
}

export function extractPlanType(tokens: ChatGptTokens): string | null {
  for (const jwt of [tokens.id_token, tokens.access_token]) {
    const c = parseJwtClaims(jwt);
    const p = c[AUTH_CLAIM_KEY]?.chatgpt_plan_type || c.chatgpt_plan_type;
    if (p) return p;
  }
  return null;
}

export function extractEmail(tokens: ChatGptTokens): string | null {
  for (const jwt of [tokens.id_token, tokens.access_token]) {
    const c = parseJwtClaims(jwt);
    if (c.email) return c.email;
  }
  return null;
}

function parseTimestamp(v: any): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "") return parseTimestamp(n);
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

/**
 * Constrói o objeto ChatGptAccountData a partir dos tokens recebidos
 */
export function extractAccountData(
  tokens: ChatGptTokens,
  previous: ChatGptAccountData | null = null,
  now: number = Date.now()
): ChatGptAccountData {
  return {
    ...(previous || {}),
    access: tokens.access_token,
    refresh: tokens.refresh_token || previous?.refresh || null,
    expira: now + (tokens.expires_in ?? 3600) * 1000,
    renovarApos: parseTimestamp(tokens.earliest_refresh_at),
    conta: extractAccountId(tokens) || previous?.conta || null,
    plano: extractPlanType(tokens) || previous?.plano || null,
    email: extractEmail(tokens) || previous?.email || null,
  };
}

/**
 * Realiza a troca do authorization code por tokens de acesso
 */
export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  customFetch: typeof fetch = globalThis.fetch
): Promise<ChatGptTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CHATGPT_REDIRECT_URI,
    client_id: CHATGPT_CLIENT_ID,
    code_verifier: verifier,
  });

  let res: Response;
  try {
    res = await customFetch(`${CHATGPT_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err: any) {
    throw new ChatGptError("Sem conexão com a OpenAI no momento. Tente novamente.", {
      codigo: "login",
    });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new ChatGptError(
      `A OpenAI não autorizou o login (${res.status}): ${errText || "tentativa recusada"}.`,
      { codigo: "login", status: res.status }
    );
  }

  return (await res.json()) as ChatGptTokens;
}

/**
 * Renova os tokens utilizando o refresh_token
 */
export async function refreshAccountTokens(
  account: ChatGptAccountData,
  customFetch: typeof fetch = globalThis.fetch,
  now: () => number = () => Date.now()
): Promise<ChatGptAccountData> {
  if (!account.refresh) {
    throw new ChatGptError("Não há token de renovação disponível. Faça login novamente.", {
      codigo: "acesso",
    });
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refresh,
    client_id: CHATGPT_CLIENT_ID,
  });

  let res: Response;
  try {
    res = await customFetch(`${CHATGPT_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err: any) {
    throw new ChatGptError("Sem conexão com a OpenAI para renovar sessão. Tente novamente.", {
      codigo: "acesso",
    });
  }

  if (!res.ok) {
    throw new ChatGptError("Sua sessão do ChatGPT expirou ou foi revogada. Conecte novamente.", {
      codigo: "acesso",
      status: res.status,
    });
  }

  const tokens = (await res.json()) as ChatGptTokens;
  return extractAccountData(tokens, account, now());
}

/**
 * Verifica se os tokens precisam de renovação
 */
export function needsRefresh(account: ChatGptAccountData | null, now: number = Date.now()): boolean {
  if (!account || !account.refresh) return false;
  // Se faltar menos de 1 minuto para expirar
  if (now >= (account.expira || 0) - 60_000) return true;
  // Se expirar em menos de 24h e já passou do earliest_refresh_at
  return (account.expira || 0) - now < ONE_DAY_MS && now >= (account.renovarApos || 0);
}

/**
 * Constrói os cabeçalhos padrão para chamadas à API Codex
 */
export function createCodexHeaders(account: ChatGptAccountData): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${account.access}`,
    originator: CHATGPT_ORIGINATOR,
  };
  if (account.conta) {
    h["chatgpt-account-id"] = account.conta;
  }
  return h;
}

/**
 * Consulta a lista oficial de modelos disponíveis para a conta autenticada
 */
export async function fetchCodexModels(
  account: ChatGptAccountData,
  customFetch: typeof fetch = globalThis.fetch
): Promise<ChatGptModelInfo[]> {
  try {
    const res = await customFetch(`${CHATGPT_API}/models?client_version=${CHATGPT_VERSION}`, {
      headers: createCodexHeaders(account),
    });

    if (res.status === 401 || res.status === 403) {
      throw new ChatGptError("Sua conta do ChatGPT desconectou. Conecte de novo.", {
        codigo: "acesso",
        status: res.status,
        retomavel: true,
      });
    }

    if (!res.ok) {
      return CHATGPT_FALLBACK_MODELS;
    }

    const json: any = await res.json().catch(() => null);
    const lista = Array.isArray(json?.models) ? json.models : [];
    const models: ChatGptModelInfo[] = lista
      .filter((m: any) => m && typeof m.slug === "string" && String(m.visibility ?? "list").toLowerCase() === "list")
      .sort((a: any, b: any) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m: any) => ({
        slug: m.slug,
        nome: m.display_name || m.slug,
        niveis: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
          .map((n: any) =>
            typeof n === "string"
              ? { effort: n, descricao: "" }
              : { effort: String(n?.effort ?? ""), descricao: String(n?.description ?? "") }
          )
          .filter((n: any) => n.effort),
        nivelPadrao: m.default_reasoning_level || null,
        resumo: m.supports_reasoning_summary_parameter !== false,
      }));

    return models.length > 0 ? models : CHATGPT_FALLBACK_MODELS;
  } catch (err: any) {
    if (err instanceof ChatGptError) throw err;
    return CHATGPT_FALLBACK_MODELS;
  }
}

/**
 * Extrai limites de uso a partir dos cabeçalhos de resposta HTTP
 */
export function parseRateLimitHeaders(headers: any): ChatGptUsageInfo | null {
  const getHeader = (k: string) => {
    if (typeof headers?.get === "function") return headers.get(k);
    if (headers && typeof headers === "object") return headers[k.toLowerCase()] || headers[k];
    return null;
  };

  const num = (k: string) => {
    const v = getHeader(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const janela5h = num("x-codex-primary-used-percent");
  const semanal = num("x-codex-secondary-used-percent");
  const mensalUsado = num("x-codex-monthly-used-percent") ?? num("x-codex-tertiary-used-percent");
  const mensalRestante = mensalUsado != null ? Math.max(0, Math.min(100, 100 - mensalUsado)) : null;

  if (janela5h == null && semanal == null && mensalUsado == null) return null;

  const toMs = (k: string) => {
    const n = num(k);
    if (n == null || !Number.isFinite(n) || n <= 0) return null;
    return n < 100_000_000_000 ? n * 1000 : n;
  };

  return {
    janela5h,
    semanal,
    reset5h: toMs("x-codex-primary-reset-at"),
    resetSemanal: toMs("x-codex-secondary-reset-at"),
    mensalUsado,
    mensalRestante,
    resetMensal: toMs("x-codex-monthly-reset-at") ?? toMs("x-codex-tertiary-reset-at"),
  };
}

/**
 * Consulta o endpoint WHAM de limites de uso da conta
 */
export async function fetchAccountUsage(
  account: ChatGptAccountData,
  customFetch: typeof fetch = globalThis.fetch
): Promise<ChatGptUsageInfo | null> {
  try {
    const res = await customFetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: createCodexHeaders(account),
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const rl = json?.rate_limit;
    const spend = json?.spend_control;
    const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

    const toMs = (w: any) => {
      const resetAt = num(w?.reset_at);
      if (resetAt != null && resetAt > 0) {
        return resetAt < 100_000_000_000 ? resetAt * 1000 : resetAt;
      }
      const resetAfter = num(w?.reset_after_seconds);
      if (resetAfter != null && resetAfter > 0) {
        return Date.now() + resetAfter * 1000;
      }
      return null;
    };

    let janela5h = num(rl?.primary_window?.used_percent);
    let semanal = num(rl?.secondary_window?.used_percent);

    let mensalUsado: number | null = null;
    let resetMensal: number | null = null;
    let compartilhadoDescricao: string | null = null;

    // 1. Prioridade oficial: spend_control.individual_limit (utilizado pela OpenAI no controle mensal compartilhado entre Codex, Work, Workspace Agents e Excel)
    if (spend?.individual_limit) {
      mensalUsado = num(spend.individual_limit.used_percent);
      resetMensal = toMs(spend.individual_limit);
      compartilhadoDescricao = "Limites compartilhados entre Codex, Work, Workspace Agents e Excel";
    }

    // 2. Verificação em rate_limit (tertiary_window ou monthly_window, caso presente no plano)
    const tertiary = rl?.tertiary_window ?? rl?.monthly_window;
    if (mensalUsado == null && tertiary) {
      mensalUsado = num(tertiary.used_percent);
      resetMensal = toMs(tertiary);
    }

    // 3. Verificação de janelas com duração mensal expressa em limit_window_seconds (>= 2_000_000s, ~30 dias)
    if (mensalUsado == null) {
      const pSecs = num(rl?.primary_window?.limit_window_seconds);
      const sSecs = num(rl?.secondary_window?.limit_window_seconds);
      if (pSecs != null && pSecs >= 2_000_000) {
        mensalUsado = janela5h;
        resetMensal = toMs(rl?.primary_window);
        janela5h = null; // evita duplicar janela mensal como se fosse 5h
      } else if (sSecs != null && sSecs >= 2_000_000) {
        mensalUsado = semanal;
        resetMensal = toMs(rl?.secondary_window);
        semanal = null; // evita duplicar janela mensal como se fosse semanal
      }
    }

    // Calcular percentual restante de forma precisa (0 a 100) somente se mensalUsado existir
    const mensalRestante =
      mensalUsado != null ? Math.max(0, Math.min(100, 100 - mensalUsado)) : null;

    if (janela5h == null && semanal == null && mensalUsado == null) return null;

    return {
      janela5h,
      semanal,
      reset5h: toMs(rl?.primary_window),
      resetSemanal: toMs(rl?.secondary_window),
      mensalUsado,
      mensalRestante,
      resetMensal,
      compartilhadoDescricao,
    };
  } catch {
    return null;
  }
}

export type ChatGptExchangeCallback = (code: string) => Promise<void>;

/**
 * Servidor Loopback local na porta 1455 para receber o redirecionamento OAuth do navegador.
 */
export class ChatGptLoopbackServer {
  private server: http.Server | null = null;
  private expectedState: string | null = null;
  private resolveAuth: ((code: string) => void) | null = null;
  private rejectAuth: ((error: Error) => void) | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;

  public async start(
    state: string,
    onExchange?: ChatGptExchangeCallback,
    timeoutMs: number = 300_000
  ): Promise<string> {
    this.stop(); // Garante liberação de portas anteriores se houver
    this.expectedState = state;

    return new Promise<string>((resolve, reject) => {
      this.resolveAuth = resolve;
      this.rejectAuth = reject;

      this.timeoutTimer = setTimeout(() => {
        const rej = this.rejectAuth;
        this.cleanup();
        if (rej) {
          rej(new ChatGptError("Tempo esgotado aguardando autorização no navegador.", { codigo: "login" }));
        }
      }, timeoutMs);

      const srv = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${CHATGPT_AUTH_PORT}`);
          if (reqUrl.pathname !== "/auth/callback") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }

          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
          }

          const errorParam = reqUrl.searchParams.get("error");
          const errorDesc = reqUrl.searchParams.get("error_description");
          const codeParam = reqUrl.searchParams.get("code");
          const stateParam = reqUrl.searchParams.get("state");

          if (errorParam) {
            const authErr = new ChatGptError(`Autorização cancelada: ${errorDesc || errorParam}`, { codigo: "login" });
            this.sendHtmlResponse(res, false, "Autorização recusada pela OpenAI ou cancelada pelo usuário.");
            const rej = this.rejectAuth;
            this.cleanup();
            if (rej) rej(authErr);
            return;
          }

          if (stateParam !== this.expectedState) {
            const csrfErr = new ChatGptError("Falha na validação CSRF do callback OAuth.", { codigo: "login" });
            this.sendHtmlResponse(res, false, "Falha de validação de segurança (estado CSRF divergente).");
            const rej = this.rejectAuth;
            this.cleanup();
            if (rej) rej(csrfErr);
            return;
          }

          if (!codeParam) {
            const noCodeErr = new ChatGptError("Callback recebido sem código de autorização.", { codigo: "login" });
            this.sendHtmlResponse(res, false, "Nenhum código de autorização foi fornecido.");
            const rej = this.rejectAuth;
            this.cleanup();
            if (rej) rej(noCodeErr);
            return;
          }

          // Se fornecido callback de troca (onExchange), processamos os tokens ANTES de confirmar o sucesso na página
          if (onExchange) {
            try {
              await onExchange(codeParam);
              this.sendHtmlResponse(
                res,
                true,
                "Conta conectada com sucesso ao NekoAI Desktop! Você já pode fechar esta aba e retornar ao aplicativo."
              );
              const resv = this.resolveAuth;
              this.cleanup();
              if (resv) resv(codeParam);
            } catch (exchangeErr: any) {
              const msg = exchangeErr?.message || "Erro ao trocar código por tokens de acesso.";
              this.sendHtmlResponse(
                res,
                false,
                `Falha ao concluir a vinculação da conta: ${msg}`
              );
              const rej = this.rejectAuth;
              this.cleanup();
              if (rej) rej(exchangeErr instanceof Error ? exchangeErr : new ChatGptError(msg, { codigo: "login" }));
            }
          } else {
            // Modo sem exchange prévio (compatibilidade)
            this.sendHtmlResponse(
              res,
              true,
              "Conta conectada com sucesso ao NekoAI Desktop! Você já pode fechar esta aba e retornar ao aplicativo."
            );
            const resv = this.resolveAuth;
            this.cleanup();
            if (resv) resv(codeParam);
          }
        } catch (err: any) {
          try {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal Server Error");
          } catch {}
          const rej = this.rejectAuth;
          this.cleanup();
          if (rej) rej(new ChatGptError(err?.message || "Erro no callback", { codigo: "login" }));
        }
      });

      this.server = srv;

      srv.on("error", (err: any) => {
        const rej = this.rejectAuth;
        this.cleanup();
        if (rej) {
          rej(
            new ChatGptError(`Falha ao iniciar listener local na porta ${CHATGPT_AUTH_PORT}: ${err.message}`, {
              codigo: "login",
            })
          );
        }
      });

      srv.listen(CHATGPT_AUTH_PORT, "127.0.0.1", () => {
        console.log(`[Neko/ChatGptAuth] Servidor loopback ouvindo em http://127.0.0.1:${CHATGPT_AUTH_PORT}`);
      });
    });
  }

  public stop(): void {
    const rej = this.rejectAuth;
    this.cleanup();
    if (rej) {
      rej(new ChatGptError("Autorização cancelada pelo usuário.", { codigo: "cancelado" }));
    }
  }

  private cleanup(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.server) {
      const s = this.server;
      this.server = null;
      try {
        (s as any).closeAllConnections?.();
      } catch {}
      try {
        s.close();
      } catch {}
    }
    this.resolveAuth = null;
    this.rejectAuth = null;
    this.expectedState = null;
  }

  private sendHtmlResponse(res: http.ServerResponse, success: boolean, message: string): void {
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NekoAI — Conexão ChatGPT</title>
  <style>
    body {
      background: #090a0f;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #12131a;
      border: 1px solid ${success ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"};
      border-radius: 12px;
      padding: 36px 40px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    }
    .badge {
      display: inline-block;
      padding: 6px 14px;
      background: ${success ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)"};
      color: ${success ? "#4ade80" : "#f87171"};
      border: 1px solid ${success ? "rgba(34, 197, 94, 0.25)" : "rgba(239, 68, 68, 0.25)"};
      border-radius: 20px;
      font-size: 12px;
      margin-bottom: 16px;
      font-weight: 600;
    }
    h1 {
      font-size: 20px;
      margin-top: 0;
      margin-bottom: 12px;
      color: ${success ? "#4ade80" : "#f87171"};
      font-weight: 700;
    }
    p {
      font-size: 13.5px;
      color: #a1a1aa;
      line-height: 1.55;
      margin: 0 0 16px;
    }
    .hint {
      font-size: 11.5px;
      color: #71717a;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 14px;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${success ? "Conexão Bem-sucedida" : "Atenção"}</div>
    <h1>${success ? "ChatGPT Conectado!" : "Falha na Conexão"}</h1>
    <p>${message}</p>
    <div class="hint">
      ${
        success
          ? "Seu aplicativo NekoAI Desktop já foi atualizado e está pronto para uso. Esta aba pode ser fechada."
          : "Retorne ao aplicativo NekoAI Desktop para verificar o erro e tentar novamente."
      }
    </div>
  </div>
  <script>
    if (${success}) {
      try {
        setTimeout(function() { window.close(); }, 2500);
      } catch (e) {}
    }
  </script>
</body>
</html>`;
    res.writeHead(success ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  }
}

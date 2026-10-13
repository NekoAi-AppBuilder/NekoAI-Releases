// src/main/chatgpt/chatgpt-types.ts
// Tipos, interfaces e constantes para a integração experimental com o ChatGPT Pessoal no NekoAI Desktop.
//
// NOTA TÉCNICA:
// Esta integração utiliza o fluxo OAuth PKCE do Codex CLI oficial da OpenAI para permitir
// que o usuário utilize sua própria conta pessoal do ChatGPT (Plus, Pro, Team, Free).
// Endpoints utilizados:
// - Autenticação OAuth: https://auth.openai.com (oficial / OAuth PKCE)
// - Catálogo de modelos: https://chatgpt.com/backend-api/codex/models (endpoint do Codex CLI)
// - Consulta de limites: https://chatgpt.com/backend-api/wham/usage (endpoint de uso)
// - Inferência: https://chatgpt.com/backend-api/codex/responses (endpoint de inferência Codex)
// Código isolado neste módulo para manutenção e substituição simplificadas.

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CHATGPT_ORIGINATOR = "nekoai";
export const CHATGPT_API = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_VERSION = "1.0.0";
export const CHATGPT_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CHATGPT_BRIDGE_PORT = 1456;
export const CHATGPT_AUTH_PORT = 1455;
export const CHATGPT_PROVIDER_ID = "chatgpt-personal";
export const CHATGPT_PROVIDER_NAME = "Meu ChatGPT";

export interface ChatGptTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  earliest_refresh_at?: string | number;
  token_type?: string;
}

export interface ChatGptAccountData {
  access: string;
  refresh: string | null;
  expira: number; // timestamp ms
  renovarApos: number; // timestamp ms
  conta: string | null; // chatgpt_account_id
  plano: string | null; // chatgpt_plan_type (e.g. plus, pro, team, free)
  email: string | null;
}

export interface ChatGptReasoningLevel {
  effort: string;
  descricao: string;
}

export interface ChatGptModelInfo {
  slug: string;
  nome: string;
  niveis: ChatGptReasoningLevel[];
  nivelPadrao: string | null;
  resumo: boolean;
}

export interface ChatGptUsageInfo {
  janela5h: number | null; // % usado na janela de 5 horas
  semanal: number | null; // % usado no limite semanal
  reset5h: number | null; // timestamp ms de renovação da janela de 5h
  resetSemanal: number | null; // timestamp ms de renovação semanal
  mensalUsado: number | null; // % usado no limite mensal (null quando não reportado pela API)
  mensalRestante: number | null; // % restante no limite mensal (null quando não reportado pela API)
  resetMensal: number | null; // timestamp ms de renovação mensal (null quando não reportado pela API)
  compartilhadoDescricao?: string | null; // aviso sobre limites de cota compartilhada, quando presente
}

export type ChatGptConnectionStatus = "disconnected" | "authorizing" | "connected" | "error";

export interface ChatGptState {
  status: ChatGptConnectionStatus;
  email: string | null;
  account: string | null;
  plan: string | null;
  models: ChatGptModelInfo[];
  usage: ChatGptUsageInfo | null;
  error: string | null;
  updatedAt: string | null;
  bridgeRunning: boolean;
}

export interface StoredChatGptVault {
  version: 1;
  encrypted: string;
  updatedAt: string;
}

export const CHATGPT_FALLBACK_MODELS: ChatGptModelInfo[] = [
  {
    slug: "gpt-5.5",
    nome: "GPT-5.5",
    niveis: [
      { effort: "low", descricao: "" },
      { effort: "medium", descricao: "" },
      { effort: "high", descricao: "" },
    ],
    nivelPadrao: "medium",
    resumo: true,
  },
];

export class ChatGptError extends Error {
  public codigo: string;
  public status: number | null;
  public retomavel: boolean;
  public limite: ChatGptUsageInfo | null;

  constructor(
    message: string,
    options: {
      codigo?: string;
      status?: number | null;
      retomavel?: boolean;
      limite?: ChatGptUsageInfo | null;
    } = {}
  ) {
    super(message);
    this.name = "ChatGptError";
    this.codigo = options.codigo || "falhou";
    this.status = options.status || null;
    this.retomavel = options.retomavel || false;
    this.limite = options.limite || null;
  }
}

/**
 * Formata a data/horário de renovação de franquia do ChatGPT de forma inequívoca e humana.
 * Retorna textos como:
 * - "Renovação prevista às 07h24" (mesmo dia)
 * - "Renovação prevista para amanhã às 07h24" (dia seguinte)
 * - "Renovação prevista para 18/10 às 07h24" (outros dias)
 * - "Franquia renovada" (se a janela já tiver expirado/vencido)
 * - "Horário de renovação indisponível" (se ausente ou inválido)
 */
export function formatChatGptResetTime(
  resetMs: number | null | undefined,
  nowMs: number = Date.now(),
  options: { includeDuration?: boolean } = {}
): string {
  if (resetMs == null || typeof resetMs !== "number" || !Number.isFinite(resetMs) || resetMs <= 0) {
    return "Horário de renovação indisponível";
  }

  // Se o timestamp já expirou (está no passado), a franquia já foi renovada
  if (nowMs >= resetMs) {
    return "Franquia renovada";
  }

  const date = new Date(resetMs);
  if (isNaN(date.getTime())) {
    return "Horário de renovação indisponível";
  }

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const timeStr = `${hh}h${mm}`;

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
  const startOfDayAfterTomorrow = startOfTomorrow + 24 * 60 * 60 * 1000;

  const resetTime = date.getTime();

  if (resetTime >= startOfToday && resetTime < startOfTomorrow) {
    return `Renovação prevista às ${timeStr}`;
  } else if (resetTime >= startOfTomorrow && resetTime < startOfDayAfterTomorrow) {
    return `Renovação prevista para amanhã às ${timeStr}`;
  } else {
    const dd = String(date.getDate()).padStart(2, "0");
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    let base = `Renovação prevista para ${dd}/${mo} às ${timeStr}`;

    if (options.includeDuration) {
      const diffMs = resetTime - nowMs;
      const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      const diffHours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      if (diffDays >= 1) {
        const dur = diffDays === 1 ? "em 1 dia" : `em ${diffDays} dias${diffHours > 0 ? ` e ${diffHours}h` : ""}`;
        base += ` (${dur})`;
      } else if (diffHours > 0) {
        base += ` (em ${diffHours}h)`;
      }
    }

    return base;
  }
}


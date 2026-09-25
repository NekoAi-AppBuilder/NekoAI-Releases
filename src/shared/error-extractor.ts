/**
 * Utilitário centralizado para extrair, desempacotar e sanitizar mensagens de erro
 * técnicas vindas de IPC do Electron, APIs externas ou comandos CLI/Git, transformando-as
 * em mensagens seguras, legíveis e informativas para a interface do usuário.
 */

// Padrões de credenciais e tokens conhecidos para sanitização
const BEARER_AUTH_REGEX = /\b(?:Authorization:\s*Bearer\s+|Authorization:\s*|Bearer\s+)[a-zA-Z0-9._~+/-]+=*/gi;
const GITHUB_TOKEN_REGEX = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{10,}\b/gi;
const SUPABASE_TOKEN_REGEX = /\bsbp_[a-zA-Z0-9_]{10,}\b/gi;
const OPENAI_KEY_REGEX = /\bsk-[a-zA-Z0-9_-]{15,}\b/gi;
const JWT_REGEX = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;
const URL_CREDENTIALS_REGEX = /(https?:\/\/)(?:[^:\s\/]+):(?:[^@\s\/]+)@/gi;
const DB_CREDENTIALS_REGEX = /((?:postgres|postgresql|mysql|mongodb):\/\/)(?:[^:\s\/]+):(?:[^@\s\/]+)@/gi;

/**
 * Sanitiza texto removendo tokens, API keys, credenciais embutidas em URLs e headers de autorização.
 */
export function sanitizeErrorMessage(text: string): string {
  if (!text) return "";

  return text
    // 1. URLs e URIs com usuário e senha embutidos (ex: https://user:pass@host.com -> https://host.com)
    .replace(URL_CREDENTIALS_REGEX, "$1")
    .replace(DB_CREDENTIALS_REGEX, "$1")
    // 2. Headers Authorization / Bearer tokens (processado antes para não colidir com prefixos)
    .replace(BEARER_AUTH_REGEX, "Bearer [REDACTED]")
    // 3. Tokens específicos de plataformas
    .replace(GITHUB_TOKEN_REGEX, "[TOKEN_GITHUB]")
    .replace(SUPABASE_TOKEN_REGEX, "[TOKEN_SUPABASE]")
    .replace(OPENAI_KEY_REGEX, "[API_KEY]")
    .replace(JWT_REGEX, "[JWT_TOKEN]")
    // 4. Parâmetros de query sensíveis (token=..., password=..., secret=..., apiKey=...)
    .replace(/([?&](?:token|password|secret|apiKey|api_key|access_token|key)=)[^&\s]+/gi, "$1[REDACTED]")
    // 5. Linhas repetidas ou espaços excessivos
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Remove o invólucro técnico de IPC do Electron e prefixos repetidos de "Error: ".
 */
export function cleanElectronIpcEnvelope(raw: string): string {
  if (!raw) return "";

  let cleaned = String(raw).trim();

  // Remove "Error invoking remote method '...': " ou variações do Electron IPC
  cleaned = cleaned.replace(/^Error invoking remote method '[^']+'(?::\s*Error:\s*|:\s*)/i, "");

  // Remove repetidos prefixos de "Error: "
  while (/^Error:\s*/i.test(cleaned)) {
    cleaned = cleaned.replace(/^Error:\s*/i, "").trim();
  }

  return cleaned;
}

/**
 * Extrai a mensagem de erro técnica original, limpa o envelope IPC e
 * aplica a sanitização de segurança. Caso não haja mensagem útil, retorna o fallback.
 */
export function getUserFacingError(error: unknown, fallback: string): string {
  if (error === null || error === undefined) return fallback;

  let rawMessage = "";

  if (typeof error === "string") {
    rawMessage = error;
  } else if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === "object") {
    const obj = error as Record<string, any>;
    if (typeof obj.message === "string" && obj.message.trim()) {
      rawMessage = obj.message;
    } else if (typeof obj.error === "string" && obj.error.trim()) {
      rawMessage = obj.error;
    } else if (obj.structuredError && typeof obj.structuredError.message === "string") {
      rawMessage = obj.structuredError.message;
    } else if (obj.data && typeof obj.data.message === "string") {
      rawMessage = obj.data.message;
    } else {
      const stringified = String(error);
      rawMessage = (stringified === "[object Object]") ? "" : stringified;
    }
  } else {
    rawMessage = String(error);
  }

  const cleaned = cleanElectronIpcEnvelope(rawMessage);
  const sanitized = sanitizeErrorMessage(cleaned);

  if (!sanitized || sanitized === "[object Object]" || sanitized === "Error") {
    return fallback;
  }

  return sanitized;
}

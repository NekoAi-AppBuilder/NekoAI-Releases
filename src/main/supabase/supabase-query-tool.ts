/**
 * Supabase Query Tool — Fundação Desktop para Execução Segura de Leituras SQL
 * 
 * Responsabilidades:
 * - Validação estrita e prévia com sql-guard (apenas consultas READ são permitidas).
 * - Execução HTTP segura contra Supabase Management API (/database/query).
 * - Limitação conservadora: MAX_ROWS = 100, corte seguro de tamanho (MAX_CHARS).
 * - Mascaramento rigoroso de campos sensíveis (password, token, secret, api_key, etc.).
 * - Tratamento defensivo de erros de autenticação, timeout e cancelamento.
 * - NUNCA registrar tokens ou credenciais em logs.
 */

import { isReadOnlySql, classifySqlRisk } from "../security/sql-guard";

export const MAX_QUERY_ROWS = 100;
export const MAX_RESPONSE_CHARS = 100000; // ~25k tokens max para não estourar contexto

export interface QueryDataOptions {
  projectRef: string;
  accessToken: string;
  sql: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface QueryDataResult {
  success: boolean;
  rows?: any[];
  rowCount?: number;
  truncated?: boolean;
  truncationReason?: string;
  error?: string;
  errorCode?: string;
  executionTimeMs?: number;
}

/**
 * Padrões de campos sensíveis para mascaramento obrigatório em queries de dados.
 */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api_?key/i,
  /access_?token/i,
  /refresh_?token/i,
  /private_?key/i,
  /authorization/i,
  /credential/i,
  /service_?role/i,
  /hash/i,
  /salt/i
];

/**
 * Mascara campos sensíveis em uma linha de resultado.
 */
export function maskSensitiveRowData(row: Record<string, any>): Record<string, any> {
  if (!row || typeof row !== "object") return row;

  const masked: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive) {
      masked[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      masked[key] = maskSensitiveRowData(value);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Executa a ferramenta supabase_query_data no processo Desktop.
 */
export async function executeQueryData(
  options: QueryDataOptions,
  customFetch?: typeof fetch
): Promise<QueryDataResult> {
  const startTime = Date.now();
  const { projectRef, accessToken, sql, signal, timeoutMs = 30000 } = options;

  // 1. Validação de Parâmetros Básicos
  if (!projectRef || typeof projectRef !== "string" || !projectRef.trim()) {
    return {
      success: false,
      error: "O parâmetro 'projectRef' é obrigatório.",
      errorCode: "INVALID_PROJECT_REF"
    };
  }

  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return {
      success: false,
      error: "Credencial de acesso do Supabase não fornecida.",
      errorCode: "AUTH_REQUIRED"
    };
  }

  if (!sql || typeof sql !== "string" || !sql.trim()) {
    return {
      success: false,
      error: "Instrução SQL não informada ou vazia.",
      errorCode: "EMPTY_SQL"
    };
  }

  // 2. Barreira Estrita de Segurança SQL
  const risk = classifySqlRisk(sql);
  const isReadOnly = isReadOnlySql(sql);

  if (!isReadOnly || risk !== "READ") {
    return {
      success: false,
      error: "Operação não permitida. Apenas consultas SELECT estritamente de leitura são autorizadas.",
      errorCode: "MUTATION_NOT_ALLOWED"
    };
  }

  // 3. Preparação da Requisição com Timeout / AbortSignal
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const effectiveSignal = signal
    ? (typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal)
    : controller.signal;

  try {
    const fetchImpl = customFetch || globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("Mecanismo de fetch HTTP não disponível no ambiente.");
    }

    const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef.trim())}/database/query`;

    const response = await fetchImpl(endpoint, {
      method: "POST",
      signal: effectiveSignal,
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: sql.trim() })
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMsg = `Erro na API do Supabase (HTTP ${response.status})`;
      let errorCode = `HTTP_${response.status}`;
      try {
        const errorBody = await response.json();
        if (errorBody?.message) errorMsg = errorBody.message;
        if (errorBody?.error) errorMsg = errorBody.error;
      } catch {}

      if (response.status === 401) {
        return {
          success: false,
          error: "Token do Supabase inválido, revogado ou expirado. Verifique o login no NekoAI.",
          errorCode: "UNAUTHORIZED"
        };
      }
      if (response.status === 403) {
        return {
          success: false,
          error: "Sem permissão de acesso ao projeto Supabase informado.",
          errorCode: "FORBIDDEN"
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: `Projeto Supabase "${projectRef}" não foi encontrado.`,
          errorCode: "NOT_FOUND"
        };
      }

      return {
        success: false,
        error: errorMsg,
        errorCode
      };
    }

    // 4. Tratamento do Retorno da Query
    const payload = await response.json().catch(() => null);
    let rawRows: any[] = [];

    if (Array.isArray(payload)) {
      rawRows = payload;
    } else if (payload && Array.isArray(payload.rows)) {
      rawRows = payload.rows;
    } else if (payload && Array.isArray(payload.data)) {
      rawRows = payload.data;
    }

    const totalFound = rawRows.length;
    let truncated = false;
    let truncationReason: string | undefined;

    // Aplicação do Limite de MAX_ROWS (100)
    let processedRows = rawRows;
    if (processedRows.length > MAX_QUERY_ROWS) {
      processedRows = processedRows.slice(0, MAX_QUERY_ROWS);
      truncated = true;
      truncationReason = `Resultado truncado em ${MAX_QUERY_ROWS} linhas (total retornado pelo banco: ${totalFound}).`;
    }

    // Aplicação do Mascaramento de Segurança
    processedRows = processedRows.map((row) =>
      typeof row === "object" && row !== null ? maskSensitiveRowData(row) : row
    );

    // Verificação do Tamanho Total em Caracteres
    const jsonString = JSON.stringify(processedRows);
    if (jsonString.length > MAX_RESPONSE_CHARS) {
      // Reduz progressivamente até caber no limite
      while (processedRows.length > 5 && JSON.stringify(processedRows).length > MAX_RESPONSE_CHARS) {
        processedRows = processedRows.slice(0, Math.floor(processedRows.length * 0.7));
      }
      truncated = true;
      truncationReason = `Resultado truncado por limite de tamanho de caracteres para preservar contexto (${processedRows.length} linhas mantidas).`;
    }

    return {
      success: true,
      rows: processedRows,
      rowCount: processedRows.length,
      truncated,
      truncationReason,
      executionTimeMs: Date.now() - startTime
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === "AbortError") {
      return {
        success: false,
        error: "A consulta SQL foi cancelada ou excedeu o tempo limite.",
        errorCode: "ABORTED_OR_TIMEOUT"
      };
    }
    return {
      success: false,
      error: err?.message || "Erro inesperado ao executar consulta no Supabase.",
      errorCode: "QUERY_EXECUTION_ERROR"
    };
  }
}

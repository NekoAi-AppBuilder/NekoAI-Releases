// src/main/opencode-diagnostics.ts
// Utilitários de observabilidade e diagnóstico estruturado para o ciclo de vida do OpenCode.

export interface FetchErrorDiagnostics {
  name: string;
  message: string;
  causeCode?: string;
  causeMessage?: string;
  causeErrno?: number | string;
  causeSyscall?: string;
  causeAddress?: string;
  causePort?: number;
  formatted: string;
}

export interface ProcessExitDiagnosticOptions {
  code: number | null;
  signal: string | null;
  executable?: string;
  stdoutLogs?: string[];
  stderrLogs?: string[];
}

export interface StartupTimeoutDiagnosticOptions {
  opencodeUrl: string;
  pid?: number | null;
  isAlive: boolean;
  elapsedMs: number;
  lastConnectionError?: string;
  stdoutLogs?: string[];
  stderrLogs?: string[];
}

/**
 * Extrai e preserva com segurança os metadados de baixo nível de um erro de conexão do fetch (Undici / Node HTTP),
 * garantindo que `error.cause` (code, errno, syscall, address, port) não seja descartado.
 */
export function extractFetchErrorDetails(error: any): FetchErrorDiagnostics {
  const name = String(error?.name || "Error");
  const message = String(error?.message || error || "Unknown error");
  const cause = error?.cause;

  let causeCode = (cause?.code || error?.code) ? String(cause?.code || error?.code) : undefined;
  let causeErrno = (cause?.errno !== undefined || error?.errno !== undefined)
    ? (typeof (cause?.errno ?? error?.errno) === "number" || typeof (cause?.errno ?? error?.errno) === "string" ? (cause?.errno ?? error?.errno) : String(cause?.errno ?? error?.errno))
    : undefined;
  let causeSyscall = (cause?.syscall || error?.syscall) ? String(cause?.syscall || error?.syscall) : undefined;
  let causeAddress = (cause?.address || error?.address) ? String(cause?.address || error?.address) : undefined;
  let causePort = typeof cause?.port === "number" ? cause.port : (typeof error?.port === "number" ? error.port : undefined);
  const causeMessage = (cause?.message || error?.message) ? String(cause?.message || error?.message) : undefined;

  // Normaliza códigos entre Node.js (ECONNREFUSED) e Bun (ConnectionRefused)
  if (causeCode === "ConnectionRefused") {
    causeCode = "ECONNREFUSED";
  }

  // Extrai de mensagens estruturadas quando cause não está presente (ex: Bun / Node TLS)
  if (!causeCode && (message.includes("ECONNREFUSED") || message.includes("ConnectionRefused"))) {
    causeCode = "ECONNREFUSED";
  }
  if (!causeAddress || !causePort) {
    const match = message.match(/(?:connect\s+[A-Z_]+\s+)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost):(\d+)/i);
    if (match) {
      if (!causeAddress) causeAddress = match[1];
      if (!causePort) causePort = parseInt(match[2], 10);
    }
  }

  const parts: string[] = [];

  if (causeCode) {
    parts.push(causeCode);
  }

  if (causeAddress && causePort) {
    parts.push(`${causeAddress}:${causePort}`);
  } else if (causeAddress) {
    parts.push(causeAddress);
  }

  if (causeSyscall) {
    parts.push(`(${causeSyscall})`);
  }

  if (causeErrno !== undefined) {
    parts.push(`[errno ${causeErrno}]`);
  }

  let formatted = "";
  if (parts.length > 0) {
    formatted = parts.join(" ");
  } else if (causeMessage) {
    formatted = causeMessage;
  } else if (message === "fetch failed" && cause) {
    formatted = `fetch failed (${String(cause)})`;
  } else {
    formatted = message;
  }

  return {
    name,
    message,
    causeCode,
    causeMessage,
    causeErrno,
    causeSyscall,
    causeAddress,
    causePort,
    formatted
  };
}

/**
 * Formata um erro detalhado quando o processo do OpenCode morre antes do término do health check.
 */
export function formatProcessExitDiagnostic(options: ProcessExitDiagnosticOptions): string {
  const { code, signal, executable, stdoutLogs = [], stderrLogs = [] } = options;
  const lastStderr = stderrLogs.filter(Boolean).slice(-3).join(" | ");
  const lastStdout = stdoutLogs.filter(Boolean).slice(-2).join(" | ");

  const parts: string[] = [
    `OpenCode encerrou antes de iniciar (código ${code ?? "nulo"}, sinal: ${signal ?? "sem sinal"})`
  ];

  if (executable) {
    parts.push(`Executável: ${executable}`);
  }

  if (lastStderr) {
    parts.push(`stderr: ${lastStderr}`);
  } else if (lastStdout) {
    parts.push(`stdout: ${lastStdout}`);
  }

  return parts.join(". ");
}

/**
 * Formata o erro lançado quando o polling de inicialização do OpenCode atinge o timeout.
 * Preserva uma mensagem clara para o usuário ao mesmo tempo em que anexa os diagnósticos técnicos.
 */
export function formatStartupTimeoutDiagnostic(options: StartupTimeoutDiagnosticOptions): string {
  const {
    opencodeUrl,
    pid,
    isAlive,
    elapsedMs,
    lastConnectionError,
    stdoutLogs = [],
    stderrLogs = []
  } = options;

  const lastStderr = stderrLogs.filter(Boolean).slice(-3).join(" | ");
  const lastStdout = stdoutLogs.filter(Boolean).slice(-2).join(" | ");

  const techDetails: string[] = [
    `Conexão: ${lastConnectionError || "sem resposta"}`,
    `PID: ${pid ?? "desconhecido"} (${isAlive ? "processo ativo" : "processo inativo"})`,
    `Decorrido: ${elapsedMs}ms`
  ];

  if (lastStderr) {
    techDetails.push(`stderr: ${lastStderr}`);
  }
  if (lastStdout) {
    techDetails.push(`stdout: ${lastStdout}`);
  }

  return `OpenCode não iniciou em ${opencodeUrl}. Detalhes: ${techDetails.join("; ")}`;
}

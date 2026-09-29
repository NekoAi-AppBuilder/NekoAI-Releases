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

  const causeCode = cause?.code ? String(cause.code) : undefined;
  const causeErrno = cause?.errno !== undefined ? (typeof cause.errno === "number" || typeof cause.errno === "string" ? cause.errno : String(cause.errno)) : undefined;
  const causeSyscall = cause?.syscall ? String(cause.syscall) : undefined;
  const causeAddress = cause?.address ? String(cause.address) : undefined;
  const causePort = typeof cause?.port === "number" ? cause.port : undefined;
  const causeMessage = cause?.message ? String(cause.message) : undefined;

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

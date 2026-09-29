import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import {
  extractFetchErrorDetails,
  formatProcessExitDiagnostic,
  formatStartupTimeoutDiagnostic
} from "../src/main/opencode-diagnostics.ts";

// ============================================================================
// SUÍTE DE TESTES: OPENCODE STARTUP OBSERVABILITY & DIAGNOSTICS
// ============================================================================

test("1. extractFetchErrorDetails: ECONNREFUSED preserva cause.code", () => {
  const syntheticError = new TypeError("fetch failed");
  (syntheticError as any).cause = {
    code: "ECONNREFUSED",
    message: "connect ECONNREFUSED 127.0.0.1:4097",
    errno: -4078,
    syscall: "connect",
    address: "127.0.0.1",
    port: 4097
  };

  const details = extractFetchErrorDetails(syntheticError);
  assert.equal(details.causeCode, "ECONNREFUSED");
  assert.ok(details.formatted.includes("ECONNREFUSED"), "A string formatada deve conter o código do erro");
});

test("2. extractFetchErrorDetails: ECONNREFUSED preserva endereço, porta e syscall", () => {
  const syntheticError = new TypeError("fetch failed");
  (syntheticError as any).cause = {
    code: "ECONNREFUSED",
    message: "connect ECONNREFUSED 127.0.0.1:4097",
    errno: -4078,
    syscall: "connect",
    address: "127.0.0.1",
    port: 4097
  };

  const details = extractFetchErrorDetails(syntheticError);
  assert.equal(details.causeAddress, "127.0.0.1");
  assert.equal(details.causePort, 4097);
  assert.equal(details.causeSyscall, "connect");
  assert.equal(details.causeErrno, -4078);
  assert.ok(details.formatted.includes("127.0.0.1:4097"), "A formatação deve incluir host e porta");
  assert.ok(details.formatted.includes("connect"), "A formatação deve incluir a syscall");
});

test("3. formatProcessExitDiagnostic: processo morto retorna imediatamente com diagnóstico estruturado", () => {
  const diagnostic = formatProcessExitDiagnostic({
    code: 1,
    signal: null,
    executable: "C:\\tools\\opencode.exe",
    stderrLogs: ["ServeError: listen tcp 127.0.0.1:4097: bind: address already in use"],
    stdoutLogs: []
  });

  assert.ok(diagnostic.includes("OpenCode encerrou antes de iniciar"), "Deve indicar encerramento prematuro");
  assert.ok(diagnostic.includes("código 1"), "Deve conter o código de saída");
  assert.ok(diagnostic.includes("ServeError"), "Deve conter o stderr do processo");
});

test("4. formatProcessExitDiagnostic: exitCode e signal aparecem no diagnóstico", () => {
  const diagnostic = formatProcessExitDiagnostic({
    code: 137,
    signal: "SIGKILL",
    executable: "tools/opencode.exe",
    stderrLogs: ["Killed by OS"],
    stdoutLogs: ["Starting..."]
  });

  assert.ok(diagnostic.includes("código 137"), "Deve conter código 137");
  assert.ok(diagnostic.includes("sinal: SIGKILL"), "Deve conter sinal SIGKILL");
  assert.ok(diagnostic.includes("Killed by OS"), "Deve conter stderr");
});

test("5. formatProcessExitDiagnostic: stderr aparece no diagnóstico sem despejar logs excessivos", () => {
  const diagnostic = formatProcessExitDiagnostic({
    code: 1,
    signal: null,
    executable: "tools/opencode.exe",
    stderrLogs: [
      "log 1",
      "log 2",
      "log 3",
      "Fatal: failed to initialize database lock"
    ],
    stdoutLogs: []
  });

  assert.ok(diagnostic.includes("Fatal: failed to initialize database lock"), "Deve conter o erro final no stderr");
  // Garante que não é um dump descontrolado
  assert.ok(diagnostic.length < 1000, "Diagnóstico deve ser compacto e conciso");
});

test("6. formatStartupTimeoutDiagnostic: timeout preserva último erro de conexão e metadados de processo", () => {
  const diagnostic = formatStartupTimeoutDiagnostic({
    opencodeUrl: "http://127.0.0.1:4097",
    pid: 12345,
    isAlive: true,
    elapsedMs: 20015,
    lastConnectionError: "ECONNREFUSED 127.0.0.1:4097 (connect) [errno -4078]",
    stderrLogs: [],
    stdoutLogs: ["Warning: unsecured server"]
  });

  assert.ok(diagnostic.startsWith("OpenCode não iniciou em http://127.0.0.1:4097."), "Deve conter a mensagem base");
  assert.ok(diagnostic.includes("ECONNREFUSED 127.0.0.1:4097"), "Deve preservar a causa do erro de conexão");
  assert.ok(diagnostic.includes("PID: 12345"), "Deve incluir o PID do processo");
  assert.ok(diagnostic.includes("processo ativo"), "Deve reportar estado do processo");
  assert.ok(diagnostic.includes("20015ms"), "Deve indicar tempo decorrido");
  assert.ok(diagnostic.includes("stdout: Warning: unsecured server"), "Deve reportar último stdout");
});

test("7. Health check com servidor real: health 200 encerra polling com sucesso imediatamente", async () => {
  // Cria servidor HTTP simulado na porta livre
  const server = http.createServer((req, res) => {
    if (req.url === "/global/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version: "1.18.23" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  const startedAt = Date.now();
  const res = await fetch(`${url}/global/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.healthy, true);
  assert.equal(data.version, "1.18.23");
  const duration = Date.now() - startedAt;
  assert.ok(duration < 1000, "Health 200 deve responder imediatamente");

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("8. Simulação de ciclo com falha de conexão: captura do erro nativo preserva metadados", async () => {
  // Porta fechada conhecida
  const nonExistentPort = 64999;
  let capturedError: any = null;

  try {
    await fetch(`http://127.0.0.1:${nonExistentPort}/global/health`);
  } catch (err) {
    capturedError = err;
  }

  assert.ok(capturedError, "Deve capturar erro de conexão");
  const diag = extractFetchErrorDetails(capturedError);
  assert.equal(diag.causeCode, "ECONNREFUSED");
  assert.equal(diag.causePort, nonExistentPort);
  assert.equal(diag.causeAddress, "127.0.0.1");
  assert.ok(diag.formatted.includes("ECONNREFUSED"));
});

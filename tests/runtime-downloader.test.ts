import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import https from "node:https";

import { RuntimeDownloader } from "../src/main/runtime/runtime-downloader.ts";

async function createTempDir(): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, "neko-downloader-test-"));
  return dir;
}

// Helper para gerar certificado autoassinado em memória e subir servidor HTTPS mock local
function setupMockHttpsServer(content: Buffer): Promise<{ server: https.Server; url: string; port: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    // Calcular SHA-256 do conteúdo mockado
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");

    // Usar um servidor HTTPS local de teste com chaves autoassinadas ou interceptadas
    // Para simplificar o teste offline sem expor chaves externas, usamos um servidor HTTPS configurável
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDccqo5bVMV0Xu6",
      "tKEnakx3kxv6VhUVn3i5vUJbc1o6ycIWjOydl4V/qR1nyJoljibPEMgdJ9g4lc4j",
      "pW2WxvkO8c9hgtgb0gojYlXGPn3w1Tyq0+i4pDbps0Pf04IjgfYghD5T5undk9NP",
      "7//fliHJUVHsin+AKEw26JUtETs1g917JwknTmQA4S7ftNttVBT+rPr7V7vagsNz",
      "gkGl/76A/yFcP1jO5ruP7KmPJMRDzW4MAzEZgV0FWMEp+E19fOfVTEH3pPiclDnR",
      "PbP1VEDczQi9UZwByxTMdRyVvJ8kmk5gmomr/gxCy6uLTv5RgC+f3v7Z1PqcRDke",
      "MRkwNzAvAgMBAAECggEABWrR8RBVMtuPgVKQBUJw951HWjsEUKA3HMVgXJP0my47",
      "FUfIRsUi9DSpMtQ0qYiZPoxohoLkpttTkf+uNj7UfwAFOx22htR+CEmR1wnRGXp7",
      "/6yuct8iNFMB732onIvEix8E0xYBGD9aOYQp0wpC8UoMy9XJdVJIMS88/zsFq/Zy",
      "bI5wVpFL+psUq+6WJrlYgnWAWUBBY4nSkU/6RvZbzVBlq4fGqOIFg064zRmuFj1f",
      "HWiAFVjoLj54DNwf5+khss34dHvmtUgHFHNtmhaoNoPnHoypwVMms+99BVIrnju+",
      "VKOmpYrVT5UHbJHnWQPokJ7LFYSKIobnC4EccFe2FQKBgQDzTTnCNmw6VuEK1evk",
      "r/LM/bDzW3wlJsb2uZpbiBOZvTrS5ftLpw1y1iRVOylvgOuD/mm/5I841+XEXTrj",
      "F27tszKByVY4bSnQfYTxKWRn+xdGYE+iNOB7vwfgjO3LqXkMR005x52u0oXDKkMX",
      "SqhjRD9DGOXAC97qP0J++KuWIwKBgQDn9BafZkBqsWHvQzT2NqogN1iSwES3ZobF",
      "UDE+RJtZ/OFRkrpI+kdg1bi7/wW2iFBA4OoI4DkwymUw4qXtX5xik/df8JNjuQjp",
      "2NjIRyqxWn+xSHUXcqTPuEZgYufzclRuoBmvZPnIHK/uUwGVVfZ21aVYCcvqhMkz",
      "dzAaBpAQhQKBgA3wr82D5sGU9sHzLdfliOjb5EadSEispxu92K1D57OYVwV8beCQ",
      "ysF4qY5EnIQqA9SFQDPheZ9NJ3oPyW73icCO0ucCzTDgeFPczUAwGfOnPFco74cg",
      "tngAowfnqzxPEoN0lmUoHc3FfCqJglyUR3+gimtiws81HumXBE1YHCS3AoGBAL1s",
      "CE2EI3b+BQxvxgCMA8Lrb9noSjW79LOOGajQPk3uxdLoEFkoisH5xzM/wFqgV2mk",
      "Q3ucIRhHMPwLG5YOTpfyXkJrJPJ7WVwfSmnENIlBbqZIldbgONeplU+BdgrJg0oU",
      "VOV3gMR7KPFnuBNMcEn7j1umJHEQn374BsA6O8xBAoGBAKAYdLc3OP8zqao6DEvN",
      "NVXak6AHlS1DZ+kMsn3F9Tsoo8yhCnxtPPZfIySSJcWFKumUuC6JuZWjf/feZtGo",
      "t9ullpXrW27ExgNVDXx3rszRl6JhABEd4vICqdVHMLu0MedTYRkj72xUYjHAYXb/",
      "9yWzTiwVNlAKNPMN6IzIiu7L",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const certPem = [
      "-----BEGIN CERTIFICATE-----",
      "MIIDCTCCAfGgAwIBAgIUSEgthAe2MaZgBL4wLwbX4I1HaZowDQYJKoZIhvcNAQEL",
      "BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDkyNjE3MTI1N1oXDTM2MDky",
      "MzE3MTI1N1owFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF",
      "AAOCAQ8AMIIBCgKCAQEA3HKqOW1TFdF7urShJ2pMd5Mb+lYVFZ94ub1CW3NaOsnC",
      "FozsnZeFf6kdZ8iaJY4mzxDIHSfYOJXOI6Vtlsb5DvHPYYLYG9IKI2JVxj598NU8",
      "qtPouKQ26bND39OCI4H2IIQ+U+bp3ZPTT+//35YhyVFR7Ip/gChMNuiVLRE7NYPd",
      "eycJJ05kAOEu37TbbVQU/qz6+1e72oLDc4JBpf++gP8hXD9Yzua7j+ypjyTEQ81u",
      "DAMxGYFdBVjBKfhNfXzn1UxB96T4nJQ50T2z9VRA3M0IvVGcAcsUzHUclbyfJJpO",
      "YJqJq/4MQsuri07+UYAvn97+2dT6nEQ5HjEZMDcwLwIDAQABo1MwUTAdBgNVHQ4E",
      "FgQUyd/DwhbofjOI+lF6OvztEVsUb60wHwYDVR0jBBgwFoAUyd/DwhbofjOI+lF6",
      "OvztEVsUb60wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAorzy",
      "yJ1PdgGSKY51yS3S7ATB98Tj3vK899TdMHzcjanyoLVNJAloUqYKyOkFmHAIXeyO",
      "EKYtsi4NZtw9iFPID4hfNuC9eDtg1jK6AIieCL0u94gBnpieRx4hwqrccbi2hw8j",
      "jYKxvmuPSFg497LikFOjTCSUki/YTGDWwVV4IW8UwrTv3mbAgzIv9WX2S77FOpLR",
      "CiFd5T04KaJDXPhGuT3Gj3jV2ywn3DyNNGNBbsoZCW+itwJm/fup4utKvQ24Bw5l",
      "T8eHgdjQYETzheS1+m6+1eF2CENmupRC2IVhNCuZ+UyXyJBoL7XxmztyVy8ecnUb",
      "P/S9P0OKcqv7NGjXsw==",
      "-----END CERTIFICATE-----",
    ].join("\n");

    const server = https.createServer({ key: privateKey, cert: certPem }, (req, res) => {
      if (req.url === "/404") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      if (req.url === "/redirect-to-http") {
        res.writeHead(302, { Location: "http://127.0.0.1:9999/insecure.zip" });
        res.end();
        return;
      }
      if (req.url === "/redirect-to-https") {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        res.writeHead(302, { Location: `https://127.0.0.1:${port}/mock-file.zip` });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      });
      res.end(content);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        const url = `https://127.0.0.1:${port}/mock-file.zip`;
        resolve({ server, url, port, sha256 });
      } else {
        reject(new Error("Falha ao obter porta do servidor HTTPS mock."));
      }
    });

    server.on("error", (err) => reject(err));
  });
}

// ============================================================================
// SUÍTE DE TESTES: RUNTIME DOWNLOADER (HTTPS, SHA-256 E ATOMICIDADE)
// ============================================================================

test("1. RuntimeDownloader: rejeita protocolo inseguro HTTP", async () => {
  const tempDir = await createTempDir();
  try {
    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "test.zip");

    const res = await downloader.download({
      url: "http://example.com/file.zip",
      destinationPath: destFile,
      expectedSha256: "abc12345",
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("INSECURE_PROTOCOL"));
    assert.equal(fsSync.existsSync(destFile), false);
    assert.equal(fsSync.existsSync(`${destFile}.tmp`), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. RuntimeDownloader: rejeita URLs com protocolo file:// ou caminhos locais", async () => {
  const tempDir = await createTempDir();
  try {
    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "test.zip");

    const res = await downloader.download({
      url: "file:///C:/local/file.zip",
      destinationPath: destFile,
      expectedSha256: "abc12345",
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("INSECURE_PROTOCOL"));
    assert.equal(fsSync.existsSync(destFile), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. RuntimeDownloader: rejeita download se SHA-256 não corresponder (CHECKSUM_MISMATCH)", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("NekoAI Runtime Test Mock Data");
  const actualSha256 = crypto.createHash("sha256").update(mockContent).digest("hex");
  const wrongSha256 = "0000000000000000000000000000000000000000000000000000000000000000";

  // Permitir conexões com certificados autoassinados locais nos testes
  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "test.zip");

    const res = await downloader.download({
      url: mock.url,
      destinationPath: destFile,
      expectedSha256: wrongSha256,
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("CHECKSUM_MISMATCH"), `Erro (${res.error}) deve conter CHECKSUM_MISMATCH`);
    assert.equal(res.actualSha256, actualSha256);
    assert.equal(fsSync.existsSync(destFile), false, "O arquivo final NÃO pode existir no disco");
    assert.equal(fsSync.existsSync(`${destFile}.tmp`), false, "O arquivo temporário .tmp DEVE ser removido");
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. RuntimeDownloader: download HTTPS válido com validação atômica e SHA-256 correto", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("NekoAI Runtime Valid Download Data Package 2026");

  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "valid-runtime.zip");

    const res = await downloader.download({
      url: mock.url,
      destinationPath: destFile,
      expectedSha256: mock.sha256,
      expectedSizeBytes: mockContent.length,
    });

    assert.equal(res.success, true, `Download deve suceder. Erro: ${res.error}`);
    assert.equal(res.actualSha256, mock.sha256);
    assert.equal(res.sizeBytes, mockContent.length);

    assert.equal(fsSync.existsSync(destFile), true, "O arquivo final DEVE existir no disco após o rename atômico");
    assert.equal(fsSync.existsSync(`${destFile}.tmp`), false, "O arquivo temporário .tmp DEVE ter sido renomeado");

    const savedContent = await fs.readFile(destFile);
    assert.deepEqual(savedContent, mockContent);
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. RuntimeDownloader: trata HTTP 404 e limpa arquivos temporários", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("dummy");

  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "not-found.zip");
    const notFoundUrl = `https://127.0.0.1:${mock.port}/404`;

    const res = await downloader.download({
      url: notFoundUrl,
      destinationPath: destFile,
      expectedSha256: "abc12345",
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("HTTP_404"));
    assert.equal(fsSync.existsSync(destFile), false);
    assert.equal(fsSync.existsSync(`${destFile}.tmp`), false);
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. RuntimeDownloader: rejeita download com tamanho incorreto (SIZE_MISMATCH) e limpa arquivo temporário .tmp", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("12345678901234567890"); // 20 bytes

  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "size-mismatch.zip");

    const res = await downloader.download({
      url: mock.url,
      destinationPath: destFile,
      expectedSha256: mock.sha256,
      expectedSizeBytes: 99999, // Tamanho incorreto intencional
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes("SIZE_MISMATCH"), `Erro (${res.error}) deve conter SIZE_MISMATCH`);
    assert.equal(res.sizeBytes, 20);
    assert.equal(fsSync.existsSync(destFile), false, "O arquivo final NÃO pode existir");
    assert.equal(fsSync.existsSync(`${destFile}.tmp`), false, "O arquivo temporário .tmp DEVE ser removido após SIZE_MISMATCH");
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. RuntimeDownloader: aceita download quando expectedSizeBytes corresponde exatamente ao tamanho real", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("Exact Size Matching Payload");

  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "exact-size.zip");

    const res = await downloader.download({
      url: mock.url,
      destinationPath: destFile,
      expectedSha256: mock.sha256,
      expectedSizeBytes: mockContent.length,
    });

    assert.equal(res.success, true);
    assert.equal(res.sizeBytes, mockContent.length);
    assert.equal(fsSync.existsSync(destFile), true);
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("8. RuntimeDownloader: rejeita redirecionamento inseguro HTTPS -> HTTP (INSECURE_PROTOCOL)", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("Redirect test payload");

  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "redirect-http.zip");
    const redirectUrl = `https://127.0.0.1:${mock.port}/redirect-to-http`;

    const res = await downloader.download({
      url: redirectUrl,
      destinationPath: destFile,
      expectedSha256: mock.sha256,
    });

    assert.equal(res.success, false);
    assert.ok(
      res.error?.includes("INSECURE_PROTOCOL"),
      `Erro (${res.error}) deve indicar rejeição de protocolo inseguro em redirect`
    );
    assert.equal(fsSync.existsSync(destFile), false);
    assert.equal(fsSync.existsSync(`${destFile}.tmp`), false);
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("9. RuntimeDownloader: segue redirecionamento seguro HTTPS -> HTTPS com sucesso", async () => {
  const tempDir = await createTempDir();
  const mockContent = Buffer.from("Secure HTTPS redirect content");

  const origRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let mockServer: https.Server | null = null;
  try {
    const mock = await setupMockHttpsServer(mockContent);
    mockServer = mock.server;

    const downloader = new RuntimeDownloader();
    const destFile = path.join(tempDir, "redirect-https.zip");
    const redirectUrl = `https://127.0.0.1:${mock.port}/redirect-to-https`;

    const res = await downloader.download({
      url: redirectUrl,
      destinationPath: destFile,
      expectedSha256: mock.sha256,
    });

    assert.equal(res.success, true, `Download via redirect HTTPS deve ter sucesso. Erro: ${res.error}`);
    assert.equal(fsSync.existsSync(destFile), true);
  } finally {
    if (mockServer) mockServer.close();
    if (origRejectUnauthorized !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = origRejectUnauthorized;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

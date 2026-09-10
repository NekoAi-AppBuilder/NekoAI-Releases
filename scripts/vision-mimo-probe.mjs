// scripts/vision-mimo-probe.mjs
// Diagnóstico isolado do Vision Fallback: MiMo V2.5 Free + imagem.
// Replica o fluxo do src/main/vision-fallback.ts contra um engine OpenCode
// real (tools/opencode.exe) e imprime o estado observado em cada passo.
// Uso: node scripts/vision-mimo-probe.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OPencode = path.join(ROOT, "tools", "opencode.exe");
const IMAGE = path.join(ROOT, "screenshot-home.png");
const TIMEOUT_MS = 75_000;

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    return { status: 0, ok: false, body: null, networkError: String(err?.cause?.code ?? err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const main = async () => {
  if (!fs.existsSync(IMAGE)) {
    log("imagem de teste não encontrada:", IMAGE);
    process.exit(2);
  }
  if (!fs.existsSync(OPencode)) {
    log("opencode.exe não encontrado em", OPencode);
    process.exit(2);
  }

  const projectDir = process.env.NEKO_PROBE_PROJECT
    ? path.resolve(process.env.NEKO_PROBE_PROJECT)
    : fs.mkdtempSync(path.join(os.tmpdir(), "neko-vision-probe-"));
  if (!process.env.NEKO_PROBE_PROJECT) {
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "vision-probe", private: true }), "utf8");
  }
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { "x-opencode-directory": encodeURIComponent(projectDir) };

  // O ambiente do shell pode conter OPENCODE_SERVER_PASSWORD/USERNAME, o que
  // ativa Basic auth no servidor. O app não passa essas variáveis; o probe
  // replica o ambiente do app removendo-as.
  const env = { ...process.env };
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;

  log("spawn engine", OPencode, "port", port, "project", projectDir);
  const child = spawn(OPencode, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  child.stdout.on("data", d => log("[engine:out]", String(d).trim().slice(0, 300)));
  child.stderr.on("data", d => log("[engine:err]", String(d).trim().slice(0, 300)));
  child.on("error", err => log("[engine] spawn error:", String(err)));
  child.on("exit", (code, signal) => log("[engine] exit code:", code, "signal:", signal));

  // health (igual ao NekoAI: sem headers)
  let healthy = false;
  let lastHealth = "";
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 500));
    const h = await fetchJson(`${baseUrl}/global/health`, {}, 2000);
    lastHealth = `status=${h.status}${h.networkError ? ` err=${h.networkError}` : ""}`;
    if (h.ok) { healthy = true; break; }
    if (i % 10 === 0) log("health tentativa", i, lastHealth);
  }
  if (!healthy) { log("engine não ficou saudável"); cleanup(); return; }
  log("engine saudável");

  // providers snapshot (somente para diagnóstico — não faz parte do app)
  const providers = await fetchJson(`${baseUrl}/provider`, { headers }, 15000);
  if (providers.ok) {
    log("provider raw keys:", JSON.stringify(Object.keys(providers.body ?? {})));
    const data = providers.body?.data ?? providers.body ?? {};
    log("provider data keys:", JSON.stringify(Object.keys(data ?? {})));
    const all = Array.isArray(data?.all) ? data.all : [];
    log("provider all count:", all.length);
    const mimoHits = [];
    for (const p of all) {
      const pid = p?.id ?? p?.providerID ?? "?";
      for (const [mid, m] of Object.entries(p?.models ?? {})) {
        if (String(mid).toLowerCase().includes("mimo")) mimoHits.push({ provider: pid, model: mid, name: m?.name, attachment: m?.attachment });
      }
    }
    log("modelos mimo encontrados:", JSON.stringify(mimoHits));
    const zen = all.find(p => (p.id ?? p.providerID) === "opencode-zen");
    const connected = Array.isArray(data?.connected) ? data.connected : [];
    log("provider opencode-zen presente:", Boolean(zen), "conectado:", connected.includes("opencode-zen"));
    log("connected providers:", JSON.stringify(connected));
  } else {
    log("GET /provider falhou:", providers.status);
  }

  // 1. cria sessão auxiliar (idêntico ao vision-fallback.ts)
  const created = await fetchJson(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ title: "NekoAI Vision Fallback" })
  }, 15000);
  log("session create status:", created.status, "ok:", created.ok);
  const sessionId = String(created.body?.id ?? created.body?.data?.id ?? "");
  log("fallback sessionId:", sessionId || "(vazio)");
  if (!sessionId) { cleanup(); return; }

  // 2. prompt_async (idêntico ao vision-fallback.ts)
  const imageStat = fs.statSync(IMAGE);
  const parts = [
    { type: "text", text: "O que está escrito nesta imagem? Responda em português do Brasil, apenas texto, sem usar ferramentas." },
    { type: "file", url: pathToFileURL(IMAGE).toString(), filename: path.basename(IMAGE), mime: "image/png" }
  ];
  log("imagem de teste:", IMAGE, imageStat.size, "bytes");
  const promptSent = await fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      agent: "build",
      model: { providerID: process.env.NEKO_PROBE_PROVIDER || "opencode", modelID: process.env.NEKO_PROBE_MODEL || "mimo-v2.5-free" },
      system: "Você é um interpretador visual auxiliar. NÃO use ferramentas. Responda apenas com texto.",
      parts
    })
  }, 30000);
  log("prompt_async status:", promptSent.status, "ok:", promptSent.ok, "body:", JSON.stringify(promptSent.body ?? null).slice(0, 300));

  // 3. polling de diagnóstico
  const deadline = Date.now() + TIMEOUT_MS;
  let lastText = "";
  let sawAssistant = false;
  let iteration = 0;
  let stableAt = 0;
  const handledPermissions = new Set();
  while (Date.now() < deadline) {
    iteration += 1;
    await new Promise(r => setTimeout(r, 1000));

    // Auto-reject (mesmo comportamento do vision-fallback.ts corrigido):
    // destrava a sessão auxiliar quando o modelo tenta usar tools.
    const permRes = await fetchJson(`${baseUrl}/permission`, { headers }, 6000);
    if (permRes.ok) {
      const perms = Array.isArray(permRes.body) ? permRes.body : (permRes.body?.data ?? permRes.body?.permissions ?? []);
      if (Array.isArray(perms) && perms.length) {
        log("PERMISSIONS PENDENTES:", JSON.stringify(perms.map(p => ({ id: String(p?.id ?? "").slice(0, 8), sessionID: String(p?.sessionID ?? "").slice(0, 8), type: p?.type }))));
        for (const p of perms) {
          if (String(p?.sessionID ?? "") !== sessionId || handledPermissions.has(String(p?.id ?? ""))) continue;
          handledPermissions.add(String(p?.id));
          const rej = await fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(String(p?.id))}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ response: "reject" })
          }, 6000);
          log("permission reject:", rej.status);
        }
      }
    }

    const statusRes = await fetchJson(`${baseUrl}/session/status`, { headers }, 6000);
    let engineStatus = "n/a";
    if (statusRes.ok) {
      const statuses = statusRes.body?.data ?? statusRes.body ?? {};
      const keys = Object.keys(statuses ?? {});
      if (iteration === 1) log("status raw keys (amostra):", JSON.stringify(keys.slice(0, 8)), "total:", keys.length);
      const our = statuses?.[sessionId];
      engineStatus = JSON.stringify(our ?? null).slice(0, 200);
    }
    if (iteration === 1 || iteration % 5 === 0) log("status:", engineStatus);

    const msgRes = await fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, { headers }, 6000);
    if (msgRes.ok) {
      const entries = Array.isArray(msgRes.body) ? msgRes.body : (msgRes.body?.data ?? []);
      if (iteration === 1 || iteration % 10 === 0) log("messages:", entries.length, "tipos:", JSON.stringify(entries.map(e => ({ role: e?.info?.role ?? e?.role, id: String(e?.info?.id ?? e?.id ?? "").slice(0, 8), parts: (e?.parts ?? []).map(p => p?.type ?? "?") }))));
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if ((e?.info?.role ?? e?.role) !== "assistant") continue;
        const text = (e?.parts ?? []).filter(p => p?.type === "text" && typeof p?.text === "string").map(p => p.text.trim()).filter(Boolean).join("\n\n").trim();
        if (text) {
          sawAssistant = true;
          if (text !== lastText) {
            lastText = text;
            stableAt = Date.now();
            log("assistant text (length):", text.length, "| preview:", JSON.stringify(text.slice(0, 160)));
          }
        }
      }
    }

    const permRes2 = await fetchJson(`${baseUrl}/permission`, { headers }, 6000);
    void permRes2;

    const statusType = String((() => { try { const s = JSON.parse("{}"); return ""; } catch { return ""; } })());
    void statusType;

    // critério de sucesso igual ao vision-fallback.ts corrigido:
    // status "idle"/"completed"/"done" OU sessão ausente do mapa ("" = terminou)
    // + texto assistant estável >= 1200ms
    const idle = engineStatus === "n/a" ? false : /"type":"(idle|completed|done)"/.test(engineStatus) || engineStatus.startsWith("null");
    if (sawAssistant && lastText && idle && stableAt > 0 && Date.now() - stableAt >= 1200) {
      log("=== FALLBACK TERIA SUCESSO AQUI ===");
      log("resposta completa gravada em", path.join(projectDir, "mimo-response.txt"));
      fs.writeFileSync(path.join(projectDir, "mimo-response.txt"), lastText, "utf8");
      cleanup();
      return;
    }
  }

  log("=== TIMEOUT DE DIAGNÓSTICO ATINGIDO ===", sawAssistant ? "resposta parcial observada" : "NENHUMA resposta assistant observada");

  function cleanup() {
    void fetchJson(`${baseUrl}/session/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers }, 5000).then(r => log("session delete:", r.status));
    setTimeout(() => { try { child.kill(); } catch {} }, 1500);
    setTimeout(() => process.exit(0), 3000);
  }
  cleanup();
};

main().catch(err => { console.error(err); process.exit(1); });

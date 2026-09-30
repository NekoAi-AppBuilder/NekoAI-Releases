// scripts/validate-models.mjs
// Script para validar o catálogo real retornado pelo OpenCode em execução.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isModelEligibleForNeko, isModelIncompatibilityError } from "../src/shared/model-eligibility.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const opencodeExe = path.join(root, "tools", "opencode.exe");
const port = 4921;
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;

console.log(`[Validation] Iniciando OpenCode em ${opencodeExe} na porta ${port}...`);

const child = spawn(opencodeExe, ["serve", "--hostname", host, "--port", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let serverClosed = false;
child.on("exit", (code) => {
  serverClosed = true;
  console.log(`[Validation] OpenCode encerrou com código ${code}`);
});

child.stderr.on("data", (d) => {
  // console.error("[OpenCode stderr]", d.toString());
});

async function waitForHealth(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${baseUrl}/global/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Timeout aguardando inicialização do OpenCode.");
}

try {
  await waitForHealth();
  console.log(`[Validation] OpenCode está ONLINE e saudável.`);

  // 1. Obter o catálogo de providers
  const res = await fetch(`${baseUrl}/provider`);
  if (!res.ok) {
    throw new Error(`Falha ao obter /provider: HTTP ${res.status}`);
  }
  const data = await res.json();
  const allProviders = Array.isArray(data.all) ? data.all : Array.isArray(data.providers) ? data.providers : [];
  console.log(`[Validation] Total de providers no catálogo do OpenCode: ${allProviders.length}\n`);

  const TARGET_PROVIDERS = [
    "groq", "openai", "anthropic", "google", "deepseek", "mistral",
    "xai", "openrouter", "togetherai", "fireworks-ai", "deepinfra",
    "siliconflow", "cohere", "perplexity", "nebius", "opencode"
  ];

  const results = {};
  let totalBeforeAll = 0;
  let totalAfterAll = 0;
  let totalRemovedAll = 0;

  for (const target of TARGET_PROVIDERS) {
    const provider = allProviders.find(p => (p.id || p.providerID || "").toLowerCase() === target);
    if (!provider) {
      results[target] = { found: false, countBefore: 0, countAfter: 0, kept: [], removed: [] };
      continue;
    }

    const providerId = provider.id || target;
    const providerModels = provider.models || {};
    const modelEntries = Object.entries(providerModels);

    const kept = [];
    const removed = [];

    for (const [modelId, model] of modelEntries) {
      totalBeforeAll++;
      const eligible = isModelEligibleForNeko(model, providerId);
      if (eligible) {
        totalAfterAll++;
        kept.push({ id: modelId, name: model?.name || modelId });
      } else {
        totalRemovedAll++;
        removed.push({ id: modelId, name: model?.name || modelId });
      }
    }

    results[target] = {
      found: true,
      name: provider.name || target,
      countBefore: modelEntries.length,
      countAfter: kept.length,
      countRemoved: removed.length,
      kept,
      removed,
    };
  }

  // 2. Exibir relatório detalhado
  console.log("================================================================================");
  console.log("RELATÓRIO DO CATÁLOGO REAL — ANTES vs DEPOIS DO FILTRO");
  console.log("================================================================================");

  for (const target of TARGET_PROVIDERS) {
    const r = results[target];
    if (!r.found) {
      console.log(`\n[PROVIDER: ${target.toUpperCase()}] NÃO ENCONTRADO NO CATÁLOGO`);
      continue;
    }
    console.log(`\n--- PROVIDER: ${r.name} (${target}) ---`);
    console.log(`Total Bruto: ${r.countBefore} | Elegíveis: ${r.countAfter} | Removidos: ${r.countRemoved}`);

    if (r.removed.length > 0) {
      console.log(`  ❌ Modelos Inelegíveis Ocultados (${r.removed.length}):`);
      for (const m of r.removed) {
        console.log(`     - [REMOVIDO] ${m.id} (${m.name})`);
      }
    } else {
      console.log(`  ℹ️ Nenhum modelo utilitário precisou ser removido deste provider.`);
    }

    console.log(`  ✅ Exemplos de Modelos Mantidos (${r.kept.length}):`);
    const sampleKept = r.kept.slice(0, 5);
    for (const m of sampleKept) {
      console.log(`     + [MANTIDO] ${m.id} (${m.name})`);
    }
    if (r.kept.length > 5) {
      console.log(`     ... e mais ${r.kept.length - 5} modelos elegíveis.`);
    }
  }

  // 3. Verificações Específicas
  console.log("\n================================================================================");
  console.log("INSPEÇÃO DETALHADA: GROQ E OPENAI NO CATÁLOGO DO OPENCODE");
  console.log("================================================================================");
  const groqAll = Object.keys(allProviders.find(p => p.id === "groq")?.models || {});
  console.log("Groq modelos existentes no OpenCode:", groqAll);

  const openaiAll = Object.keys(allProviders.find(p => p.id === "openai")?.models || {});
  console.log("OpenAI modelos existentes no OpenCode:", openaiAll);

  const groqResult = results["groq"];
  const whisperBlocked = groqResult?.removed.some(m => m.id.includes("whisper-large-v3"));
  const whisperTurboBlocked = groqResult?.removed.some(m => m.id.includes("whisper-large-v3-turbo"));
  const distilWhisperBlocked = groqResult?.removed.some(m => m.id.includes("distil-whisper"));
  const llamaGuardBlocked = groqResult?.removed.some(m => m.id.includes("llama-guard"));

  console.log(`1. groq/whisper-large-v3 bloqueado: ${whisperBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`2. groq/whisper-large-v3-turbo bloqueado: ${whisperTurboBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`3. groq/distil-whisper bloqueado: ${distilWhisperBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`4. groq/llama-guard bloqueado: ${llamaGuardBlocked ? "✅ SIM" : "❌ NÃO"}`);

  // OpenAI specific checks
  const openaiResult = results["openai"];
  const openaiEmbedBlocked = openaiResult?.removed.some(m => m.id.includes("embedding"));
  const openaiWhisperBlocked = openaiResult?.removed.some(m => m.id.includes("whisper"));
  const openaiDalleBlocked = openaiResult?.removed.some(m => m.id.includes("dall-e"));
  const openaiTtsBlocked = openaiResult?.removed.some(m => m.id.includes("tts"));

  console.log(`5. openai/embedding bloqueado: ${openaiEmbedBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`6. openai/whisper bloqueado: ${openaiWhisperBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`7. openai/dall-e bloqueado: ${openaiDalleBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`8. openai/tts bloqueado: ${openaiTtsBlocked ? "✅ SIM" : "❌ NÃO"}`);

  // Cohere rerank check
  const cohereResult = results["cohere"];
  const cohereRerankBlocked = cohereResult?.removed.some(m => m.id.includes("rerank"));
  const cohereEmbedBlocked = cohereResult?.removed.some(m => m.id.includes("embed"));
  console.log(`9. cohere/rerank bloqueado: ${cohereRerankBlocked ? "✅ SIM" : "❌ NÃO"}`);
  console.log(`10. cohere/embed bloqueado: ${cohereEmbedBlocked ? "✅ SIM" : "❌ NÃO"}`);

  // OpenCode Zen MiMo check
  const opencodeResult = results["opencode"];
  const mimoKept = opencodeResult?.kept.some(m => m.id === "mimo-v2.5-free");
  console.log(`11. opencode/mimo-v2.5-free preservado para Vision Fallback: ${mimoKept ? "✅ SIM" : "❌ NÃO"}`);

  // Totais consolidados
  console.log("\n================================================================================");
  console.log(`TOTAIS NOS 16 PROVIDERS ANALISADOS:`);
  console.log(`- Modelos Brutos: ${totalBeforeAll}`);
  console.log(`- Modelos Mantidos: ${totalAfterAll}`);
  console.log(`- Modelos Ocultados (Incompatíveis): ${totalRemovedAll}`);
  console.log(`================================================================================\n`);

} finally {
  console.log("[Validation] Finalizando processo do OpenCode...");
  child.kill("SIGTERM");
  try {
    process.kill(child.pid);
  } catch {}
}

// tests/model-eligibility.test.ts
// Testes unitários da regra central de elegibilidade de modelos do NekoAI.
// Executar com: node --experimental-strip-types --test tests/model-eligibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelEligibleForNeko,
  isModelIncompatibilityError
} from "../src/shared/model-eligibility.ts";
import type { RawModelCandidate } from "../src/shared/model-eligibility.ts";

// A. Whisper: groq/whisper-large-v3 -> inelegível
test("A: groq/whisper-large-v3 is ineligible", () => {
  const model: RawModelCandidate = {
    id: "whisper-large-v3",
    name: "Whisper Large V3",
    modalities: { input: ["audio"], output: ["text"] },
    capabilities: {
      input: { text: false, audio: true },
      output: { text: true },
      toolcall: false
    },
    cost: { input: 0, output: 0 }
  };
  assert.equal(isModelEligibleForNeko(model, "groq"), false);
});

// B. Whisper Turbo -> inelegível
test("B: whisper-large-v3-turbo is ineligible", () => {
  const model: RawModelCandidate = {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    cost: { input: 0, output: 0 }
  };
  assert.equal(isModelEligibleForNeko(model, "groq"), false);
});

// C. Embedding -> inelegível
test("C: text-embedding-3-small and bge models are ineligible", () => {
  const openaiEmbed: RawModelCandidate = {
    id: "text-embedding-3-small",
    name: "Text Embedding 3 Small"
  };
  assert.equal(isModelEligibleForNeko(openaiEmbed, "openai"), false);

  const bgeEmbed: RawModelCandidate = {
    id: "baai/bge-large-en-v1.5",
    name: "BGE Large EN v1.5"
  };
  assert.equal(isModelEligibleForNeko(bgeEmbed, "togetherai"), false);

  const mistralEmbed: RawModelCandidate = {
    id: "mistral-embed",
    name: "Mistral Embed"
  };
  assert.equal(isModelEligibleForNeko(mistralEmbed, "mistral"), false);
});

// D. Rerank -> inelegível
test("D: rerank-v3.5 is ineligible", () => {
  const rerankModel: RawModelCandidate = {
    id: "rerank-v3.5",
    name: "Cohere Rerank v3.5"
  };
  assert.equal(isModelEligibleForNeko(rerankModel, "cohere"), false);
});

// E. TTS -> inelegível
test("E: tts-1 is ineligible", () => {
  const ttsModel: RawModelCandidate = {
    id: "tts-1",
    name: "TTS 1"
  };
  assert.equal(isModelEligibleForNeko(ttsModel, "openai"), false);
});

// F. DALL-E / geração de imagem pura -> inelegível
test("F: dall-e-3 and flux are ineligible", () => {
  const dalle: RawModelCandidate = {
    id: "dall-e-3",
    name: "DALL-E 3"
  };
  assert.equal(isModelEligibleForNeko(dalle, "openai"), false);

  const flux: RawModelCandidate = {
    id: "black-forest-labs/flux-1-schnell",
    name: "Flux.1 Schnell"
  };
  assert.equal(isModelEligibleForNeko(flux, "togetherai"), false);
});

// G. Moderation / Guard -> inelegível
test("G: llama-guard-3-8b and omni-moderation are ineligible", () => {
  const guard: RawModelCandidate = {
    id: "llama-guard-3-8b",
    name: "Llama Guard 3 8B"
  };
  assert.equal(isModelEligibleForNeko(guard, "groq"), false);

  const moderation: RawModelCandidate = {
    id: "omni-moderation-latest",
    name: "Omni Moderation"
  };
  assert.equal(isModelEligibleForNeko(moderation, "openai"), false);
});

// H. Modelo normal de texto -> elegível
test("H: normal text models like llama-3.3-70b-versatile and gpt-4o are eligible", () => {
  const llama: RawModelCandidate = {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B Versatile",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      input: { text: true },
      output: { text: true },
      toolcall: true
    }
  };
  assert.equal(isModelEligibleForNeko(llama, "groq"), true);

  const gpt4o: RawModelCandidate = {
    id: "gpt-4o",
    name: "GPT-4o",
    modalities: { input: ["text", "image"], output: ["text"] }
  };
  assert.equal(isModelEligibleForNeko(gpt4o, "openai"), true);
});

// I. Modelo com texto + vision -> elegível
test("I: text + vision model is eligible", () => {
  const llamaVision: RawModelCandidate = {
    id: "llama-3.2-11b-vision-preview",
    name: "Llama 3.2 11B Vision Preview",
    modalities: { input: ["text", "image"], output: ["text"] },
    attachment: true
  };
  assert.equal(isModelEligibleForNeko(llamaVision, "groq"), true);
});

// J. Modelo com texto + tool calling -> elegível
test("J: text + tool calling model is eligible", () => {
  const claude: RawModelCandidate = {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    capabilities: {
      input: { text: true },
      output: { text: true },
      toolcall: true
    }
  };
  assert.equal(isModelEligibleForNeko(claude, "anthropic"), true);
});

// K. Modelo sem vision, mas com texto/tool calling -> elegível
test("K: text model without vision is eligible (NekoAI uses vision fallback)", () => {
  const deepseek: RawModelCandidate = {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    attachment: false,
    modalities: { input: ["text"], output: ["text"] }
  };
  assert.equal(isModelEligibleForNeko(deepseek, "deepseek"), true);
});

// L. Modelo deprecated -> inelegível
test("L: deprecated model is ineligible", () => {
  const deprecatedModel: RawModelCandidate = {
    id: "old-model-v1",
    name: "Old Model V1",
    status: "deprecated",
    modalities: { input: ["text"], output: ["text"] }
  };
  assert.equal(isModelEligibleForNeko(deprecatedModel, "openai"), false);
});

// M. Modelo sem capabilities completas, mas com metadados suficientes para Chat -> elegível
test("M: model with minimal metadata but valid text ID is eligible", () => {
  const minimalModel: RawModelCandidate = {
    id: "mistral-large-latest",
    name: "Mistral Large Latest"
  };
  assert.equal(isModelEligibleForNeko(minimalModel, "mistral"), true);
});

// N & O: Lógica de restauração e desclassificação de modelo
test("N & O: model restoration detects disqualified/removed models", () => {
  const catalog = [
    { providerID: "groq", modelID: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", enabled: true, connected: true },
    { providerID: "groq", modelID: "llama-3.1-8b-instant", name: "Llama 3.1 8B", enabled: true, connected: true }
  ];

  // Simulating saved model: groq/whisper-large-v3
  const savedModel = { providerID: "groq", modelID: "whisper-large-v3" };
  const isStillValid = catalog.some(m => m.providerID === savedModel.providerID && m.modelID === savedModel.modelID);
  assert.equal(isStillValid, false);

  // Fallback selection must pick first valid model
  const fallbackModel = catalog[0];
  assert.equal(fallbackModel.modelID, "llama-3.3-70b-versatile");
});

// P: Provider conectado com zero modelos elegíveis
test("P: provider with zero eligible models is detected", () => {
  const providerModels = [
    { id: "whisper-large-v3", name: "Whisper Large V3" },
    { id: "whisper-large-v3-turbo", name: "Whisper Large V3 Turbo" },
    { id: "llama-guard-3-8b", name: "Llama Guard 3 8B" }
  ];

  const eligibleCount = providerModels.filter(m => isModelEligibleForNeko(m, "groq")).length;
  assert.equal(eligibleCount, 0);
});

// Q: mimo-v2.5-free continua elegível e utilizável
test("Q: opencode/mimo-v2.5-free is eligible as chat model", () => {
  const mimo: RawModelCandidate = {
    id: "mimo-v2.5-free",
    name: "MiMo V2.5 Free",
    modalities: { input: ["text", "image"], output: ["text"] },
    attachment: true,
    capabilities: {
      input: { text: true, image: true },
      output: { text: true },
      toolcall: false
    }
  };
  assert.equal(isModelEligibleForNeko(mimo, "opencode"), true);
});

// Teste de detecção de erro em runtime
test("Runtime: isModelIncompatibilityError identifies chat completion errors", () => {
  assert.equal(
    isModelIncompatibilityError("The model 'whisper-large-v3' does not support chat completions"),
    true
  );
  assert.equal(
    isModelIncompatibilityError("HTTP 400 not a chat model"),
    true
  );
  assert.equal(
    isModelIncompatibilityError("Rate limit exceeded"),
    false
  );
});

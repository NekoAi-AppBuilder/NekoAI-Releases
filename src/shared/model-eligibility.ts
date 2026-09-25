// ============================================================
// MODEL ELIGIBILITY FILTER (shared between main and renderer)
// ------------------------------------------------------------
// Central source of truth for "is this model eligible for NekoAI
// Chat / Agent / Plan / Build?".
//
// Filters out models that do not support chat completions, such as:
// - Speech-to-text / Audio transcription (e.g. Whisper)
// - Text-to-speech (TTS)
// - Embeddings / Vectorization
// - Reranking
// - Pure image / video generation (e.g. DALL-E, Flux, Imagen)
// - Pure moderation / guardrail classifiers (e.g. Llama Guard)
// - Explicitly deprecated models
//
// Models that support text input/output and chat completions are
// eligible, regardless of whether they have native vision or cost.
// ============================================================

export type RawModelModalities = {
  input?: string[];
  output?: string[];
};

export type RawModelCapabilities = {
  temperature?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  toolcall?: boolean;
  tool_call?: boolean;
  input?: {
    text?: boolean;
    audio?: boolean;
    image?: boolean;
    video?: boolean;
    pdf?: boolean;
  };
  output?: {
    text?: boolean;
    audio?: boolean;
    image?: boolean;
    video?: boolean;
    pdf?: boolean;
  };
};

export type RawModelCandidate = {
  id?: string;
  modelID?: string;
  name?: string;
  status?: string;
  modalities?: RawModelModalities;
  capabilities?: RawModelCapabilities;
  attachment?: boolean;
  tool_call?: boolean;
  cost?: {
    input?: number;
    output?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

// Defensive pattern matchers for known non-chat utility models
const NON_CHAT_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  // Speech-to-Text / Audio transcription
  { regex: /(^|[-_/.])whisper([-_/.]|$)/i, reason: "audio-transcription" },
  { regex: /(^|[-_/.])distil-whisper([-_/.]|$)/i, reason: "audio-transcription" },

  // Text-to-Speech (TTS)
  { regex: /(^|[-_/.])tts([-_/.]|$)/i, reason: "text-to-speech" },
  { regex: /(^|[-_/.])bark([-_/.]|$)/i, reason: "text-to-speech" },

  // Embeddings / Vectorization
  { regex: /(^|[-_/.])embeddings?([-_/.]|$)/i, reason: "embeddings" },
  { regex: /[-_/.]embed([-_/.]|$)/i, reason: "embeddings" },
  { regex: /(^|[-_/.])bge-([a-z0-9_-]+)/i, reason: "embeddings" },

  // Reranking
  { regex: /(^|[-_/.])rerank(er)?([-_/.]|$)/i, reason: "rerank" },

  // Pure image / video generation
  { regex: /(^|[-_/.])dall-?e([-_/.]|$)/i, reason: "image-generation" },
  { regex: /(^|[-_/.])flux([-_/.]|$)/i, reason: "image-generation" },
  { regex: /(^|[-_/.])stable-?diffusion([-_/.]|$)/i, reason: "image-generation" },
  { regex: /(^|[-_/.])sdxl([-_/.]|$)/i, reason: "image-generation" },
  { regex: /(^|[-_/.])imagen([-_/.]|$)/i, reason: "image-generation" },
  { regex: /(^|[-_/.])midjourney([-_/.]|$)/i, reason: "image-generation" },

  // Moderation / Guardrail classifiers (not conversational software builders)
  { regex: /(^|[-_/.])guard([-_/.]|$)/i, reason: "moderation" },
  { regex: /(^|[-_/.])moderation([-_/.]|$)/i, reason: "moderation" },
];

/**
 * Checks whether a candidate model is eligible for NekoAI's Chat and Agent workflows.
 *
 * @param model Candidate model object containing capabilities, modalities, status, and/or IDs.
 * @param providerID Optional provider ID for context.
 * @returns boolean True if the model is eligible for conversational chat/agent usage.
 */
export function isModelEligibleForNeko(
  model: RawModelCandidate | undefined | null,
  providerID?: string
): boolean {
  if (!model || typeof model !== "object") return false;

  const modelId = String(model.modelID ?? model.id ?? "").trim();
  const name = String(model.name ?? modelId).trim();
  const rawStatus = String(model.status ?? "").trim().toLowerCase();

  // 1. Explicitly deprecated models are ineligible
  if (rawStatus === "deprecated") {
    return false;
  }

  // 2. Modalities check (real OpenCode metadata)
  const modalities = model.modalities;
  if (modalities && typeof modalities === "object") {
    const inputs = Array.isArray(modalities.input) ? modalities.input.map(s => String(s).toLowerCase()) : [];
    const outputs = Array.isArray(modalities.output) ? modalities.output.map(s => String(s).toLowerCase()) : [];

    // If input modalities are explicitly defined and do NOT include text, it cannot accept text prompts
    if (inputs.length > 0 && !inputs.includes("text")) {
      return false;
    }

    // If output modalities are explicitly defined and do NOT include text, it cannot respond with text/code
    if (outputs.length > 0 && !outputs.includes("text")) {
      return false;
    }
  }

  // 3. Capabilities check (real OpenCode capabilities object)
  const capabilities = model.capabilities;
  if (capabilities && typeof capabilities === "object") {
    // Explicit text input disabled
    if (capabilities.input && capabilities.input.text === false) {
      return false;
    }

    // Explicit text output disabled
    if (capabilities.output && capabilities.output.text === false) {
      return false;
    }
  }

  // 4. Defensive pattern check against known utility / non-chat models
  const targetId = modelId.toLowerCase();
  const targetName = name.toLowerCase();

  for (const { regex } of NON_CHAT_PATTERNS) {
    if (regex.test(targetId) || regex.test(targetName)) {
      return false;
    }
  }

  // If passed all negative checks, model is eligible for Chat/Agent
  return true;
}

/**
 * Checks whether a runtime error message indicates that a model is incompatible
 * with chat completions (e.g. HTTP 400 from Groq/OpenAI for audio/embedding models).
 */
export function isModelIncompatibilityError(message: string | undefined | null): boolean {
  if (!message) return false;
  const lower = String(message).toLowerCase();
  return (
    lower.includes("does not support chat completions") ||
    lower.includes("not a chat model") ||
    lower.includes("is not supported for this endpoint") ||
    lower.includes("only supports audio") ||
    lower.includes("only supports embeddings") ||
    lower.includes("not compatible with chat") ||
    lower.includes("model does not support the requested operation")
  );
}

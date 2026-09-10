// ============================================================
// CHAT MODE (shared)
// ------------------------------------------------------------
// Explicit, single source of truth for the composer mode. The engine already
// supports native planning (OpenCode "plan" agent): Plan is read-only and
// presents a plan (approval card) instead of writing files; Build is the
// normal agent execution. This module only centralizes the mode value so it
// is never scattered as loose strings across the UI.
// ============================================================

export type ChatMode = "build" | "plan";

export const CHAT_MODES: ChatMode[] = ["build", "plan"];

export function nextChatMode(mode: ChatMode): ChatMode {
  return mode === "plan" ? "build" : "plan";
}

export function chatModeLabel(mode: ChatMode): string {
  return mode === "plan" ? "Plan" : "Build";
}

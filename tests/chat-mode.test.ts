// tests/chat-mode.test.ts
// Modo Build/Plan do composer — lógica pura (estado, alternância via Tab).
// Executar: node --experimental-strip-types --test tests/chat-mode.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextChatMode, chatModeLabel, CHAT_MODES, type ChatMode } from "../src/shared/chat-mode.ts";

test("default ordering starts with build (padrão)", () => {
  assert.deepEqual(CHAT_MODES, ["build", "plan"]);
  assert.equal(chatModeLabel("build"), "Build");
  assert.equal(chatModeLabel("plan"), "Plan");
});

test("Tab alternates build -> plan -> build", () => {
  let mode: ChatMode = "build";
  mode = nextChatMode(mode);
  assert.equal(mode, "plan");
  mode = nextChatMode(mode);
  assert.equal(mode, "build");
});

test("alternância repetida é estável (volta ao original)", () => {
  let mode: ChatMode = "build";
  for (let i = 0; i < 10; i++) mode = nextChatMode(mode);
  assert.equal(mode, "build");
});

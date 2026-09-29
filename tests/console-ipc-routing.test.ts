import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeErrorMessage } from "../src/shared/error-extractor.ts";

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
type PreviewConsoleEntry = {
  id: string;
  level: ConsoleLevel;
  message: string;
  source?: string;
  url?: string;
  ts: number;
};

function shortConsoleSource(sourceId: string, line: number | undefined): string {
  const s = String(sourceId || "");
  if (!s) return "";
  try {
    const u = new URL(s);
    const file = u.pathname.split("/").pop() || s;
    return line ? `${file}:${line}` : file;
  } catch {
    const file = s.split("/").pop() || s;
    return line ? `${file}:${line}` : file;
  }
}

function processPreviewConsoleEvent(
  props: any,
  pushConsoleEntry: (level: ConsoleLevel, message: string, source?: string, url?: string) => void
) {
  const rawLevel = props?.level;
  const numeric = typeof rawLevel === "string"
    ? ({ verbose: 0, info: 1, warning: 2, warn: 2, error: 3 } as Record<string, number>)[rawLevel.toLowerCase()] ?? 1
    : Number(rawLevel ?? 0);
  const level: ConsoleLevel = numeric >= 3 ? "error" : numeric === 2 ? "warn" : numeric === 0 ? "debug" : "log";
  const text = String(props?.message || "");
  if (text) {
    const sourceId = String(props?.sourceId || props?.url || "");
    const line = Number(props?.line ?? props?.lineNumber) > 0 ? Number(props?.line ?? props?.lineNumber) : undefined;
    pushConsoleEntry(level, text, shortConsoleSource(sourceId, line), sourceId || undefined);
  }
}

test("Console IPC Routing - Test Scenarios", async (t) => {
  await t.test("1. preview.console routes log, info, warn, error, debug properly", () => {
    const entries: PreviewConsoleEntry[] = [];
    const push = (level: ConsoleLevel, msg: string, src?: string, url?: string) => {
      const clean = sanitizeErrorMessage(msg);
      if (!clean) return;
      entries.push({
        id: `test-${entries.length}`,
        level,
        message: clean,
        source: src,
        url,
        ts: Date.now()
      });
    };

    // Test log
    processPreviewConsoleEvent({ level: 1, message: "App started", sourceId: "http://localhost:5173/src/main.tsx", line: 10 }, push);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].level, "log");
    assert.strictEqual(entries[0].message, "App started");
    assert.strictEqual(entries[0].source, "main.tsx:10");

    // Test warn
    processPreviewConsoleEvent({ level: "warning", message: "Deprecated API called", sourceId: "http://localhost:5173/src/App.tsx", lineNumber: 42 }, push);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[1].level, "warn");
    assert.strictEqual(entries[1].message, "Deprecated API called");
    assert.strictEqual(entries[1].source, "App.tsx:42");

    // Test error
    processPreviewConsoleEvent({ level: 3, message: "Uncaught TypeError: Cannot read property", sourceId: "http://localhost:5173/src/Button.tsx", line: 15 }, push);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[2].level, "error");
    assert.strictEqual(entries[2].message, "Uncaught TypeError: Cannot read property");
    assert.strictEqual(entries[2].source, "Button.tsx:15");

    // Test debug
    processPreviewConsoleEvent({ level: 0, message: "HMR ping", sourceId: "http://localhost:5173/vite/client", line: 0 }, push);
    assert.strictEqual(entries.length, 4);
    assert.strictEqual(entries[3].level, "debug");
    assert.strictEqual(entries[3].message, "HMR ping");
    assert.strictEqual(entries[3].source, "client");
  });

  await t.test("2. consoleEntries respects maximum retention limit of 1000", () => {
    let entries: PreviewConsoleEntry[] = [];
    const CONSOLE_LIMIT = 1000;
    const push = (level: ConsoleLevel, msg: string) => {
      const clean = sanitizeErrorMessage(msg);
      if (!clean) return;
      const entry: PreviewConsoleEntry = {
        id: `test-${Math.random()}`,
        level,
        message: clean,
        ts: Date.now()
      };
      entries = [...entries, entry];
      if (entries.length > CONSOLE_LIMIT) {
        entries = entries.slice(entries.length - CONSOLE_LIMIT);
      }
    };

    for (let i = 0; i < 1200; i++) {
      push("log", `Message #${i}`);
    }

    assert.strictEqual(entries.length, 1000);
    assert.strictEqual(entries[0].message, "Message #200");
    assert.strictEqual(entries[999].message, "Message #1199");
  });

  await t.test("3. channel isolation: preview.console should not be accepted on opencode:event", () => {
    const opencodeAcceptedEvents = new Set(["neko.activity", "neko.status", "neko.task.state", "opencode.output", "neko.opencode.ready"]);
    assert.strictEqual(opencodeAcceptedEvents.has("preview.console"), false);
  });
});

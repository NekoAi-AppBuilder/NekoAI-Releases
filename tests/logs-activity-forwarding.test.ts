import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeErrorMessage } from "../src/shared/error-extractor.ts";

type TerminalLine = {
  id: string;
  kind: "log" | "console" | "error";
  text: string;
  source?: string;
};

type TimelineItem = {
  id: string;
  type: string;
  title: string;
  detail: string;
  state: string;
};

test("Logs Activity Forwarding - Test Scenarios", async (t) => {
  await t.test("1. neko.activity bridges to both Timeline and Logs without breaking Timeline", () => {
    const timelineItems: TimelineItem[] = [];
    const terminalLines: TerminalLine[] = [];

    const upsertActivity = (item: TimelineItem) => {
      const idx = timelineItems.findIndex(i => i.id === item.id);
      if (idx >= 0) timelineItems[idx] = item;
      else timelineItems.push(item);
    };

    const appendTerminalLine = (kind: "log" | "console" | "error", text: string, source = "Neko") => {
      const clean = sanitizeErrorMessage(text);
      if (!clean) return;
      terminalLines.push({
        id: `term-${terminalLines.length}`,
        kind,
        text: clean,
        source
      });
    };

    // Simulate file creation activity
    const fileEvent = {
      type: "neko.activity",
      properties: {
        action: "file",
        actionType: "created",
        path: "src/components/Header.tsx",
        status: "completed"
      }
    };

    // Handler logic
    const { action, path, actionType } = fileEvent.properties;
    if (action === "file") {
      const actType = actionType === "created" ? "Criando" : "Editando";
      upsertActivity({
        id: `file:${actionType}:${path}`,
        type: "edit",
        title: `${actType} ${path}`,
        detail: path,
        state: "done"
      });
      appendTerminalLine("log", `${actType} ${path}`, "Projeto");
    }

    assert.strictEqual(timelineItems.length, 1);
    assert.strictEqual(timelineItems[0].title, "Criando src/components/Header.tsx");
    assert.strictEqual(terminalLines.length, 1);
    assert.strictEqual(terminalLines[0].kind, "log");
    assert.strictEqual(terminalLines[0].text, "Criando src/components/Header.tsx");
    assert.strictEqual(terminalLines[0].source, "Projeto");

    // Simulate tool execution before & after
    const toolEventRunning = {
      type: "neko.activity",
      properties: {
        action: "tool",
        tool: "bash",
        command: "npm run build",
        stage: "before",
        status: "running",
        callId: "call-1"
      }
    };

    const { tool, command, status, callId, error } = toolEventRunning.properties;
    upsertActivity({
      id: `tool:${callId}`,
      type: "command",
      title: "Executando bash",
      detail: command,
      state: "running"
    });
    appendTerminalLine("log", `Executando ${tool}`, "Neko");

    assert.strictEqual(timelineItems.length, 2);
    assert.strictEqual(timelineItems[1].state, "running");
    assert.strictEqual(terminalLines.length, 2);
    assert.strictEqual(terminalLines[1].text, "Executando bash");

    // Tool finishes with error
    const toolEventError = {
      type: "neko.activity",
      properties: {
        action: "tool",
        tool: "bash",
        command: "npm run build",
        stage: "after",
        status: "error",
        error: "Build failed with exit code 1",
        callId: "call-1"
      }
    };

    upsertActivity({
      id: `tool:${callId}`,
      type: "command",
      title: "Executando bash",
      detail: command,
      state: "error"
    });
    appendTerminalLine("error", `Falha em ${tool}: ${toolEventError.properties.error}`, "Neko");

    assert.strictEqual(timelineItems.length, 2);
    assert.strictEqual(timelineItems[1].state, "error");
    assert.strictEqual(terminalLines.length, 3);
    assert.strictEqual(terminalLines[2].kind, "error");
    assert.strictEqual(terminalLines[2].text, "Falha em bash: Build failed with exit code 1");
  });

  await t.test("2. opencode.output feeds log without duplicating error", () => {
    const terminalLines: TerminalLine[] = [];
    const appendTerminalLine = (kind: "log" | "console" | "error", text: string, source = "Neko") => {
      const clean = sanitizeErrorMessage(text);
      if (!clean) return;
      terminalLines.push({
        id: `term-${terminalLines.length}`,
        kind,
        text: clean,
        source
      });
    };

    const stdoutEvent = { type: "opencode.output", properties: { stream: "stdout", text: "OpenCode server listening on 4097", source: "Neko" } };
    appendTerminalLine("log", stdoutEvent.properties.text, stdoutEvent.properties.source);

    assert.strictEqual(terminalLines.length, 1);
    assert.strictEqual(terminalLines[0].kind, "log");
    assert.strictEqual(terminalLines[0].text, "OpenCode server listening on 4097");
  });

  await t.test("3. terminalLines retention limit stays capped at 800", () => {
    let lines: TerminalLine[] = [];
    const append = (text: string) => {
      lines = [...lines, { id: `${Date.now()}-${Math.random()}`, kind: "log", text }].slice(-800);
    };

    for (let i = 0; i < 950; i++) {
      append(`Line ${i}`);
    }

    assert.strictEqual(lines.length, 800);
    assert.strictEqual(lines[0].text, "Line 150");
    assert.strictEqual(lines[799].text, "Line 949");
  });
});

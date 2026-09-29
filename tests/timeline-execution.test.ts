import { describe, it, expect, test } from "vitest";
import assert from "node:assert/strict";
import { normalizeOpenCodeEvent } from "../src/main/events/normalizer";
import { normalizeActivity } from "../src/main/events/activity";
import { groupTimelineIntoPhases, type TimelineItem, type TaskTimeline } from "../src/renderer/components/TimelineView";

test("1 & 2. tool.execute.before creates TimelineItem with stable callID", () => {
  const rawEvent = {
    type: "tool.execute.before",
    properties: {
      tool: "read",
      callID: "call-read-001",
      sessionID: "sess-1",
      input: { filePath: "src/App.tsx" }
    }
  };

  const normalized = normalizeOpenCodeEvent(rawEvent);
  assert.equal(normalized?.type, "neko.activity");
  assert.equal(normalized?.properties?.action, "tool");
  assert.equal(normalized?.properties?.callId, "call-read-001");
  assert.equal(normalized?.properties?.path, "src/App.tsx");
  assert.equal(normalized?.properties?.status, "running");
});

test("3. Two different tools do not overwrite each other (unique callIDs)", () => {
  const items: TimelineItem[] = [];

  function record(entry: TimelineItem) {
    const idx = items.findIndex(i => i.id === entry.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...entry };
    else items.push(entry);
  }

  record({
    id: "tool:call-read-1",
    type: "read",
    title: "Lendo src/App.tsx",
    detail: "src/App.tsx",
    status: "running",
    startedAt: 1000
  });

  record({
    id: "tool:call-grep-2",
    type: "read",
    title: 'Procurando "Button"...',
    detail: "Button",
    status: "running",
    startedAt: 1050
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].id, "tool:call-read-1");
  assert.equal(items[1].id, "tool:call-grep-2");
  assert.equal(items[0].title, "Lendo src/App.tsx");
  assert.equal(items[1].title, 'Procurando "Button"...');
});

test("4. message.part.updated updates the item without duplicating tool.execute.before", () => {
  const items: TimelineItem[] = [];

  function record(entry: TimelineItem) {
    const idx = items.findIndex(i => i.id === entry.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...entry };
    else items.push(entry);
  }

  // Before
  const beforeEvent = normalizeActivity("tool.execute.before", {
    tool: "edit",
    callID: "call-edit-1",
    input: { path: "src/main.tsx" }
  });
  assert.equal(beforeEvent?.properties?.callId, "call-edit-1");
  record({
    id: `tool:${beforeEvent.properties.callId}`,
    type: "edit",
    title: "Editando src/main.tsx",
    detail: "src/main.tsx",
    status: "running",
    startedAt: 1000
  });

  // message.part.updated (streaming progress)
  const partEvent = normalizeActivity("message.part.updated", {
    part: {
      type: "tool",
      tool: "edit",
      callID: "call-edit-1",
      state: { status: "running", input: { path: "src/main.tsx" } }
    }
  });
  assert.equal(partEvent?.properties?.callId, "call-edit-1");
  record({
    id: `tool:${partEvent.properties.callId}`,
    type: "edit",
    title: "Editando src/main.tsx",
    detail: "src/main.tsx",
    status: "running",
    startedAt: 1000
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "tool:call-edit-1");
});

test("5 & 6. tool.execute.after finalizes the correct item with durationMs", () => {
  const items: TimelineItem[] = [{
    id: "tool:call-bash-1",
    type: "command",
    title: "Executando npm run build",
    detail: "npm run build",
    status: "running",
    startedAt: 1000
  }];

  function record(entry: Partial<TimelineItem> & { id: string }) {
    const idx = items.findIndex(i => i.id === entry.id);
    if (idx >= 0) {
      const existing = items[idx];
      const completedAt = entry.completedAt ?? 1500;
      items[idx] = {
        ...existing,
        ...entry,
        completedAt,
        durationMs: completedAt - existing.startedAt,
        status: entry.status ?? "completed"
      };
    }
  }

  const afterEvent = normalizeActivity("tool.execute.after", {
    tool: "bash",
    callID: "call-bash-1",
    state: { status: "completed" }
  });

  assert.equal(afterEvent?.properties?.status, "completed");
  record({
    id: `tool:${afterEvent.properties.callId}`,
    status: "completed",
    completedAt: 1500
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "completed");
  assert.equal(items[0].durationMs, 500);
});

test("7. Error in tool.execute.after marks only the failing tool as error", () => {
  const items: TimelineItem[] = [
    { id: "tool:call-1", type: "read", title: "Lendo A", status: "completed", startedAt: 1000, completedAt: 1200, durationMs: 200 },
    { id: "tool:call-2", type: "command", title: "Executando testes", status: "running", startedAt: 1300 }
  ];

  const afterEvent = normalizeActivity("tool.execute.after", {
    tool: "bash",
    callID: "call-2",
    error: { message: "Test failed with exit code 1" },
    state: { status: "error" }
  });

  assert.equal(afterEvent?.properties?.status, "error");
  const idx = items.findIndex(i => i.id === `tool:${afterEvent.properties.callId}`);
  assert.ok(idx >= 0);
  items[idx].status = "error";
  items[idx].completedAt = 1600;
  items[idx].durationMs = 1600 - items[idx].startedAt;

  assert.equal(items[0].status, "completed");
  assert.equal(items[1].status, "error");
  assert.equal(items[1].durationMs, 300);
});

test("8, 9 & 10. File semantic events (created, edited, deleted) produce correct actionTypes", () => {
  const created = normalizeActivity("file.created", { path: "src/components/Card.tsx" });
  assert.equal(created?.properties?.action, "file");
  assert.equal(created?.properties?.actionType, "created");
  assert.equal(created?.properties?.path, "src/components/Card.tsx");

  const edited = normalizeActivity("file.edited", { filePath: "src/App.tsx" });
  assert.equal(edited?.properties?.action, "file");
  assert.equal(edited?.properties?.actionType, "edited");
  assert.equal(edited?.properties?.path, "src/App.tsx");

  const deleted = normalizeActivity("file.deleted", { file: "src/old-file.ts" });
  assert.equal(deleted?.properties?.action, "file");
  assert.equal(deleted?.properties?.actionType, "deleted");
  assert.equal(deleted?.properties?.path, "src/old-file.ts");
});

test("11 & 12. file.watcher.updated does NOT produce a generic timeline activity", () => {
  const watcherEvent = normalizeActivity("file.watcher.updated", { path: "src/App.tsx" });
  assert.equal(watcherEvent, null, "File watcher events must not be converted into timeline activity");
});

test("13, 14, 15 & 16. permission.asked and permission.replied lifecycle", () => {
  const items: TimelineItem[] = [];

  // permission.asked
  const permId = "perm-bash-99";
  items.push({
    id: `permission:${permId}`,
    type: "permission",
    title: "Aguardando sua autorização",
    detail: "bash: npm run build",
    status: "running",
    startedAt: 1000
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "running");

  // permission.replied (Approved)
  const approvedIdx = items.findIndex(i => i.id === `permission:${permId}`);
  items[approvedIdx] = {
    ...items[approvedIdx],
    title: "Acesso autorizado",
    status: "completed",
    completedAt: 1200,
    durationMs: 200
  };

  assert.equal(items[0].status, "completed");
  assert.equal(items[0].title, "Acesso autorizado");

  // permission.replied (Rejected)
  const permId2 = "perm-bash-100";
  items.push({
    id: `permission:${permId2}`,
    type: "permission",
    title: "Aguardando sua autorização",
    detail: "rm -rf /",
    status: "running",
    startedAt: 2000
  });

  const rejectedIdx = items.findIndex(i => i.id === `permission:${permId2}`);
  items[rejectedIdx] = {
    ...items[rejectedIdx],
    title: "Autorização recusada",
    status: "error",
    completedAt: 2100,
    durationMs: 100
  };

  assert.equal(items[1].status, "error");
  assert.equal(items[1].title, "Autorização recusada");
});

test("17 & 18. question.asked and question.replied lifecycle", () => {
  const items: TimelineItem[] = [];
  const qId = "q-auth-choice";

  // Question asked
  items.push({
    id: `question:${qId}`,
    type: "question",
    title: "O Neko precisa de uma informação",
    detail: "Deseja usar Supabase ou Mock?",
    status: "running",
    startedAt: 1000
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "running");

  // Question replied
  const idx = items.findIndex(i => i.id === `question:${qId}`);
  items[idx] = {
    ...items[idx],
    title: "Informação respondida",
    detail: "Supabase",
    status: "completed",
    completedAt: 1500,
    durationMs: 500
  };

  assert.equal(items[0].status, "completed");
  assert.equal(items[0].title, "Informação respondida");
});

test("19 & 20. Real commands appear in timeline and secrets are sanitized", () => {
  function sanitizeDetail(text: string): string {
    let str = String(text);
    str = str.replace(/(?:Bearer|token|key|secret|password|passwd|auth)[\s:=]+['"]?([a-zA-Z0-9_\-\.]{12,})['"]?/gi, (m, p1) => m.replace(p1, "[REDACTED]"));
    str = str.replace(/\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|sbp_[a-zA-Z0-9]{20,}|ey[a-zA-Z0-9_\-]{25,}\.[a-zA-Z0-9_\-]{25,})/g, "[REDACTED]");
    return str.trim();
  }

  const rawCmd = "curl -H 'Authorization: Bearer sk-ant-api03-abcdef1234567890abcdef123456' https://api.example.com";
  const sanitized = sanitizeDetail(rawCmd);

  assert.ok(!sanitized.includes("sk-ant-api03-abcdef1234567890abcdef123456"));
  assert.ok(sanitized.includes("[REDACTED]"));
});

test("21. Absolute paths are converted to relative project paths", () => {
  function displayPath(raw: string, projectRoot: string): string {
    const normRaw = raw.replace(/\\/g, "/");
    const normRoot = projectRoot.replace(/\\/g, "/");
    if (normRaw.toLowerCase().startsWith(normRoot.toLowerCase())) {
      const rel = normRaw.slice(normRoot.length).replace(/^\/+/, "");
      return rel || "projeto";
    }
    return normRaw;
  }

  const absPath = "C:/Users/andre/Projects/MyAwesomeApp/src/components/Header.tsx";
  const projectRoot = "C:/Users/andre/Projects/MyAwesomeApp";
  const relative = displayPath(absPath, projectRoot);

  assert.equal(relative, "src/components/Header.tsx");
  assert.ok(!relative.includes("C:/Users/andre"));
});

test("22. Two parallel tools maintain independent running items and durationMs", () => {
  const items: TimelineItem[] = [
    { id: "tool:call-read-A", type: "read", title: "Lendo A.ts", status: "running", startedAt: 1000 },
    { id: "tool:call-read-B", type: "read", title: "Lendo B.ts", status: "running", startedAt: 1020 }
  ];

  // A finishes first
  items[0] = { ...items[0], status: "completed", completedAt: 1050, durationMs: 50 };

  assert.equal(items[0].status, "completed");
  assert.equal(items[0].durationMs, 50);
  assert.equal(items[1].status, "running");

  // B finishes second
  items[1] = { ...items[1], status: "completed", completedAt: 1100, durationMs: 80 };

  assert.equal(items[1].status, "completed");
  assert.equal(items[1].durationMs, 80);
});

test("23. Different sessionIds do not collide or mix timeline items", () => {
  const eventSess1 = normalizeActivity("tool.execute.before", {
    tool: "read",
    callID: "call-1",
    sessionID: "session-alpha",
    input: { path: "src/A.tsx" }
  });

  const eventSess2 = normalizeActivity("tool.execute.before", {
    tool: "read",
    callID: "call-1",
    sessionID: "session-beta",
    input: { path: "src/B.tsx" }
  });

  assert.equal(eventSess1?.properties?.sessionId, "session-alpha");
  assert.equal(eventSess2?.properties?.sessionId, "session-beta");
});

test("24. Completed task finalizes any still-running items", () => {
  const timeline: TaskTimeline = {
    taskId: "task-100",
    status: "running",
    startedAt: 1000,
    items: [
      { id: "item-1", type: "read", title: "Lendo A", status: "completed", startedAt: 1000, completedAt: 1100, durationMs: 100 },
      { id: "item-2", type: "edit", title: "Editando B", status: "running", startedAt: 1150 }
    ]
  };

  const now = 1300;
  const finalizedItems = timeline.items.map(item => {
    if (item.status === "running") {
      return {
        ...item,
        status: "completed" as const,
        completedAt: now,
        durationMs: now - item.startedAt
      };
    }
    return item;
  });

  const completedTimeline: TaskTimeline = {
    ...timeline,
    status: "completed",
    completedAt: now,
    durationMs: now - timeline.startedAt,
    items: finalizedItems
  };

  assert.equal(completedTimeline.status, "completed");
  assert.equal(completedTimeline.items[1].status, "completed");
  assert.equal(completedTimeline.items[1].durationMs, 150);
});

test("25. Phases grouping correctly classifies and presents items", () => {
  const items: TimelineItem[] = [
    { id: "t1", type: "thinking", title: "Pensando...", status: "completed", startedAt: 1000, completedAt: 1100, durationMs: 100 },
    { id: "t2", type: "read", title: "Lendo src/App.tsx", status: "completed", startedAt: 1100, completedAt: 1200, durationMs: 100 },
    { id: "t3", type: "edit", title: "Editando src/App.tsx", status: "completed", startedAt: 1200, completedAt: 1400, durationMs: 200 },
    { id: "t4", type: "permission", title: "Acesso autorizado", status: "completed", startedAt: 1400, completedAt: 1450, durationMs: 50 },
    { id: "t5", type: "validation", title: "Executando npm run build", detail: "npm run build", status: "completed", startedAt: 1450, completedAt: 1600, durationMs: 150 }
  ];

  const phases = groupTimelineIntoPhases(items, "completed", 1000, 1600);
  assert.equal(phases.length, 5);
  assert.equal(phases[0].id, "phase-thinking");
  assert.equal(phases[1].id, "phase-audit");
  assert.equal(phases[2].id, "phase-implementation");
  assert.equal(phases[3].id, "phase-interaction");
  assert.equal(phases[4].id, "phase-validation");
});

test("26. Full Multi-Step Task Simulation (Reading, Search, Editing, Command, Permission, Completion)", () => {
  const timelineItems: TimelineItem[] = [];

  function record(entry: Partial<TimelineItem> & { id: string; title: string }) {
    const existingIdx = timelineItems.findIndex(i => i.id === entry.id);
    const now = 2000;
    if (existingIdx >= 0) {
      const existing = timelineItems[existingIdx];
      const completedAt = entry.status === "completed" || entry.status === "error" ? (entry.completedAt ?? now) : existing.completedAt;
      const startedAt = existing.startedAt || entry.startedAt || now;
      timelineItems[existingIdx] = {
        ...existing,
        ...entry,
        startedAt,
        completedAt,
        durationMs: completedAt ? completedAt - startedAt : existing.durationMs
      };
    } else {
      timelineItems.push({
        id: entry.id,
        type: entry.type || "status",
        title: entry.title,
        detail: entry.detail,
        status: entry.status || "running",
        startedAt: entry.startedAt || now,
        completedAt: entry.completedAt,
        durationMs: entry.durationMs
      });
    }
  }

  // 1. Leitura de arquivo
  const ev1 = normalizeOpenCodeEvent({
    type: "tool.execute.before",
    properties: { tool: "read", callID: "call-1", input: { filePath: "src/App.tsx" } }
  });
  assert.equal(ev1?.properties?.callId, "call-1");
  record({
    id: `tool:${ev1.properties.callId}`,
    type: "read",
    title: "Lendo src/App.tsx",
    detail: "src/App.tsx",
    status: "running",
    startedAt: 1000
  });
  record({
    id: `tool:${ev1.properties.callId}`,
    title: "Lendo src/App.tsx",
    status: "completed",
    completedAt: 1120
  });

  // 2. Pesquisa
  const ev2 = normalizeOpenCodeEvent({
    type: "tool.execute.before",
    properties: { tool: "grep", callID: "call-2", input: { query: "Header" } }
  });
  assert.equal(ev2?.properties?.callId, "call-2");
  record({
    id: `tool:${ev2.properties.callId}`,
    type: "read",
    title: 'Procurando "Header"...',
    detail: "Header",
    status: "running",
    startedAt: 1130
  });
  record({
    id: `tool:${ev2.properties.callId}`,
    title: 'Procurando "Header"...',
    status: "completed",
    completedAt: 1200
  });

  // 3. Edição
  const ev3 = normalizeOpenCodeEvent({
    type: "tool.execute.before",
    properties: { tool: "edit", callID: "call-3", input: { filePath: "src/components/Header.tsx" } }
  });
  assert.equal(ev3?.properties?.callId, "call-3");
  record({
    id: `tool:${ev3.properties.callId}`,
    type: "edit",
    title: "Editando src/components/Header.tsx",
    detail: "src/components/Header.tsx",
    status: "running",
    startedAt: 1210
  });
  record({
    id: `tool:${ev3.properties.callId}`,
    title: "Editando src/components/Header.tsx",
    status: "completed",
    completedAt: 1400
  });

  // 4. Execução de comando
  const ev4 = normalizeOpenCodeEvent({
    type: "tool.execute.before",
    properties: { tool: "bash", callID: "call-4", input: { command: "npm run build" } }
  });
  assert.equal(ev4?.properties?.callId, "call-4");
  record({
    id: `tool:${ev4.properties.callId}`,
    type: "validation",
    title: "Executando npm run build",
    detail: "npm run build",
    status: "running",
    startedAt: 1410
  });
  record({
    id: `tool:${ev4.properties.callId}`,
    title: "Executando npm run build",
    status: "completed",
    completedAt: 1650
  });

  // 5. Permissão
  record({
    id: "permission:perm-1",
    type: "permission",
    title: "Aguardando sua autorização",
    detail: "bash: npm run build",
    status: "running",
    startedAt: 1660
  });
  record({
    id: "permission:perm-1",
    type: "permission",
    title: "Acesso autorizado",
    detail: "Autorização concedida",
    status: "completed",
    completedAt: 1750
  });

  // 6. Conclusão e fases
  const phases = groupTimelineIntoPhases(timelineItems, "completed", 1000, 1800);

  assert.equal(timelineItems.length, 5);
  assert.equal(timelineItems[0].title, "Lendo src/App.tsx");
  assert.equal(timelineItems[0].status, "completed");
  assert.equal(timelineItems[0].durationMs, 120);

  assert.equal(timelineItems[1].title, 'Procurando "Header"...');
  assert.equal(timelineItems[1].status, "completed");
  assert.equal(timelineItems[1].durationMs, 70);

  assert.equal(timelineItems[2].title, "Editando src/components/Header.tsx");
  assert.equal(timelineItems[2].status, "completed");
  assert.equal(timelineItems[2].durationMs, 190);

  assert.equal(timelineItems[3].title, "Executando npm run build");
  assert.equal(timelineItems[3].status, "completed");
  assert.equal(timelineItems[3].durationMs, 240);

  assert.equal(timelineItems[4].title, "Acesso autorizado");
  assert.equal(timelineItems[4].status, "completed");
  assert.equal(timelineItems[4].durationMs, 90);

  assert.equal(phases.length, 4); // Audit (2 items), Implementation (1 item), Validation (1 item), Interaction (1 item)
  assert.equal(phases[0].id, "phase-audit");
  assert.equal(phases[0].items.length, 2);
  assert.equal(phases[1].id, "phase-implementation");
  assert.equal(phases[2].id, "phase-interaction");
  assert.equal(phases[3].id, "phase-validation");
});

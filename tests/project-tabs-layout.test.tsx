import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectTabs } from "../src/renderer/components/ProjectTabs";
const snapshot = { selected: "A", tabs: [
  { id: "home", label: "Início", projectPath: null, busy: false, closing: false },
  { id: "A", label: "Projeto A", projectPath: "C:/A", busy: true, closing: false },
  { id: "B", label: "Projeto B", projectPath: "C:/B", busy: false, closing: false }
] };
const actions = { onSelect() {}, onClose() {}, onOpen() {} };
test("Home never renders project tabs even when projects remain open", () => {
  expect(renderToStaticMarkup(<ProjectTabs projectOpen={false} snapshot={snapshot} fallbackLabel="Preview" {...actions} />)).toBe("");
});
test("Preview strip lists project tabs, omits Home and includes open-existing action", () => {
  const html = renderToStaticMarkup(<ProjectTabs projectOpen snapshot={snapshot} fallbackLabel="Preview" {...actions} />);
  expect(html).toContain('class="preview-tabs-strip"');
  expect(html).toContain("Projeto A"); expect(html).toContain("Projeto B");
  expect(html).not.toContain("Início");
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('aria-label="Fechar Projeto B"');
  expect(html).toContain('aria-label="Abrir projeto existente"');
  expect(html).toContain('aria-label="Tarefa em andamento"');
});

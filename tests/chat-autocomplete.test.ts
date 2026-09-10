import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_COMMANDS,
  CHAT_CONTEXTS,
  filterCommands,
  filterContexts,
  getCommand,
  getContext
} from "../src/renderer/autocomplete/registry.ts";

import {
  detectAutocompleteTrigger,
  applyAutocompleteSelection
} from "../src/renderer/autocomplete/trigger.ts";

import {
  resolveChatMessage,
  type ResolverContextState
} from "../src/renderer/autocomplete/resolver.ts";

import {
  extractProjectItems,
  filterProjectItems
} from "../src/renderer/autocomplete/project-items.ts";

test("1. Comandos '/' - Contém exatamente os 6 comandos exigidos", () => {
  const expectedCommands = ["/analyze", "/fix", "/explain", "/refactor", "/debug", "/git"];
  assert.equal(CHAT_COMMANDS.length, 6);
  assert.deepEqual(
    CHAT_COMMANDS.map(c => c.command),
    expectedCommands
  );
});

test("2. Comandos '/' - Filtro case-insensitive de comandos", () => {
  // / -> mostra todos
  assert.equal(filterCommands("/").length, 6);
  assert.equal(filterCommands("").length, 6);

  // /a, /an, /ana -> /analyze
  const aResults = filterCommands("/a");
  assert.ok(aResults.some(c => c.command === "/analyze"));

  const anResults = filterCommands("/an");
  assert.equal(anResults.length, 1);
  assert.equal(anResults[0].command, "/analyze");

  const anaResults = filterCommands("/ana");
  assert.equal(anaResults.length, 1);
  assert.equal(anaResults[0].command, "/analyze");

  // /fix
  const fixResults = filterCommands("/fix");
  assert.equal(fixResults.length, 1);
  assert.equal(fixResults[0].command, "/fix");

  // /debug
  const debResults = filterCommands("/deb");
  assert.equal(debResults.length, 1);
  assert.equal(debResults[0].command, "/debug");

  // /explain
  const expResults = filterCommands("/explain");
  assert.equal(expResults.length, 1);
  assert.equal(expResults[0].command, "/explain");

  // /refactor
  const refResults = filterCommands("/ref");
  assert.equal(refResults.length, 1);
  assert.equal(refResults[0].command, "/refactor");

  // /git
  const gitResults = filterCommands("/git");
  assert.equal(gitResults.length, 1);
  assert.equal(gitResults[0].command, "/git");
});

test("3. Contextos '@' - Contém exatamente os 10 contextos exigidos e nenhum comando '/'", () => {
  const expectedContexts = [
    "@project",
    "@preview",
    "@file",
    "@folder",
    "@runtime",
    "@architecture",
    "@git",
    "@errors",
    "@logs",
    "@terminal"
  ];
  assert.equal(CHAT_CONTEXTS.length, 10);
  assert.deepEqual(
    CHAT_CONTEXTS.map(c => c.context),
    expectedContexts
  );

  // Nenhum contexto deve conter '/'
  for (const ctx of CHAT_CONTEXTS) {
    assert.ok(ctx.context.startsWith("@"));
    assert.ok(!ctx.context.includes("/"));
  }
});

test("4. Contextos '@' - Filtro case-insensitive de contextos", () => {
  // @ -> mostra todos os 10
  assert.equal(filterContexts("@").length, 10);
  assert.equal(filterContexts("").length, 10);

  // @p, @pr -> @project e @preview
  const pResults = filterContexts("@p");
  assert.ok(pResults.some(c => c.context === "@project"));
  assert.ok(pResults.some(c => c.context === "@preview"));

  // @pre -> @preview
  const preResults = filterContexts("@pre");
  assert.equal(preResults.length, 1);
  assert.equal(preResults[0].context, "@preview");

  // @fil -> @file
  const filResults = filterContexts("@fil");
  assert.equal(filResults.length, 1);
  assert.equal(filResults[0].context, "@file");

  // @fol -> @folder
  const folResults = filterContexts("@fol");
  assert.equal(folResults.length, 1);
  assert.equal(folResults[0].context, "@folder");

  // @run -> @runtime
  const runResults = filterContexts("@run");
  assert.equal(runResults.length, 1);
  assert.equal(runResults[0].context, "@runtime");

  // @arch -> @architecture
  const archResults = filterContexts("@arch");
  assert.equal(archResults.length, 1);
  assert.equal(archResults[0].context, "@architecture");

  // @git -> @git
  const gitResults = filterContexts("@git");
  assert.equal(gitResults.length, 1);
  assert.equal(gitResults[0].context, "@git");

  // @err -> @errors
  const errResults = filterContexts("@err");
  assert.equal(errResults.length, 1);
  assert.equal(errResults[0].context, "@errors");

  // @log -> @logs
  const logResults = filterContexts("@log");
  assert.equal(logResults.length, 1);
  assert.equal(logResults[0].context, "@logs");

  // @term -> @terminal
  const termResults = filterContexts("@term");
  assert.equal(termResults.length, 1);
  assert.equal(termResults[0].context, "@terminal");
});

test("5. Gatilhos - Detecção no início e meio da frase", () => {
  // Início da mensagem com /
  const t1 = detectAutocompleteTrigger("/an", 3);
  assert.ok(t1);
  assert.equal(t1.mode, "commands");
  assert.equal(t1.query, "an");
  assert.equal(t1.triggerIndex, 0);

  // Início da mensagem com @
  const t2 = detectAutocompleteTrigger("@pre", 4);
  assert.ok(t2);
  assert.equal(t2.mode, "contexts");
  assert.equal(t2.query, "pre");
  assert.equal(t2.triggerIndex, 0);

  // No meio da mensagem precedido por espaço
  const textMid = "Por favor /fix @src/App.tsx";
  // Cursor logo após /fix (índice 14)
  const t3 = detectAutocompleteTrigger(textMid, 14);
  assert.ok(t3);
  assert.equal(t3.mode, "commands");
  assert.equal(t3.query, "fix");
  assert.equal(t3.triggerIndex, 10);

  // Cursor logo após @src/App.tsx (índice 27)
  const t4 = detectAutocompleteTrigger(textMid, 27);
  assert.ok(t4);
  assert.equal(t4.mode, "contexts");
  assert.equal(t4.query, "src/App.tsx");
  assert.equal(t4.triggerIndex, 15);
});

test("6. Gatilhos - Não disparar em e-mails ou caminhos de texto normal", () => {
  // email@example.com -> cursor no final
  const email = "contato@empresa.com";
  const tEmail = detectAutocompleteTrigger(email, email.length);
  assert.equal(tEmail, null, "Não deve disparar em e-mails");

  // URL com barra -> http://localhost/test
  const url = "http://localhost/test";
  const tUrl = detectAutocompleteTrigger(url, url.length);
  assert.equal(tUrl, null, "Não deve disparar em URLs normais");

  // Caminho de arquivo sem gatilho de espaço -> pasta/subpasta/arquivo.txt
  const filePath = "src/components/Header.tsx";
  const tFile = detectAutocompleteTrigger(filePath, filePath.length);
  assert.equal(tFile, null, "Não deve disparar em caminhos separados por barra sem espaço");
});

test("7. Aplicação de seleção - Preserva texto anterior e posterior com espaço final", () => {
  // Caso A: Já existe espaço após o token
  const textA = "Preciso que você /an agora mesmo.";
  const triggerA = detectAutocompleteTrigger(textA, 20); // cursor após /an
  assert.ok(triggerA);

  const resA = applyAutocompleteSelection(textA, triggerA, "/analyze");
  assert.equal(resA.newText, "Preciso que você /analyze agora mesmo.");
  assert.equal(resA.newCursor, "Preciso que você /analyze".length);

  // Caso B: No final do texto (adiciona espaço para continuar digitando)
  const textB = "Preciso que você /an";
  const triggerB = detectAutocompleteTrigger(textB, textB.length);
  assert.ok(triggerB);

  const resB = applyAutocompleteSelection(textB, triggerB, "/analyze");
  assert.equal(resB.newText, "Preciso que você /analyze ");
  assert.equal(resB.newCursor, "Preciso que você /analyze ".length);
});

test("8. Resolução - Combinações / e @ (ex: /fix @src/App.tsx @preview)", () => {
  const state: ResolverContextState = {
    projectRoot: "C:/Projects/NekoApp",
    projectName: "NekoApp",
    previewUrl: "http://localhost:5173",
    previewStatus: "ready",
    previewFramework: "Vite + React",
    tree: [
      { name: "src", path: "src", type: "directory" },
      { name: "package.json", path: "package.json", type: "file" }
    ],
    gitStatus: {
      initialized: true,
      branch: "main",
      remote: "origin",
      summary: { modified: 1, untracked: 0, deleted: 0, staged: 0, total: 1 },
      changedFiles: [{ path: "src/App.tsx", status: "M" }]
    },
    terminalLines: [
      { id: "1", kind: "error", text: "TypeError: Cannot read property 'map' of undefined" }
    ],
    consoleEntries: []
  };

  const raw = "/fix @src/App.tsx @preview @errors";
  const resolved = resolveChatMessage(raw, state);

  assert.equal(resolved.userDisplayText, raw);
  assert.ok(resolved.command);
  assert.equal(resolved.command.command, "/fix");
  assert.ok(resolved.commandInstruction?.includes("CORRIGIR"));
  assert.deepEqual(resolved.filePaths, ["src/App.tsx"]);
  assert.deepEqual(resolved.semanticContexts, ["preview", "errors"]);
  assert.ok(resolved.resolvedContextPrompt?.includes("http://localhost:5173"));
  assert.ok(resolved.resolvedContextPrompt?.includes("TypeError"));
  assert.ok(resolved.agentPromptText.includes("AÇÃO DO AGENTE: CORRIGIR"));
  assert.ok(resolved.agentPromptText.includes("/fix @src/App.tsx @preview @errors"));
});

test("9. Resolução - @preview indisponível não quebra o chat", () => {
  const state: ResolverContextState = {
    previewUrl: null,
    previewStatus: "error",
    previewMessage: "Falha ao iniciar porta 5173"
  };

  const resolved = resolveChatMessage("Investigue o problema usando @preview", state);

  assert.ok(resolved.semanticContexts.includes("preview"));
  assert.ok(resolved.resolvedContextPrompt?.includes("Indisponível no momento"));
  assert.ok(resolved.resolvedContextPrompt?.includes("Falha ao iniciar porta 5173"));
});

test("10. Extração de arquivos e pastas do projeto para @file e @folder", () => {
  const tree = [
    {
      name: "src",
      path: "src",
      type: "directory" as const,
      children: [
        { name: "App.tsx", path: "src/App.tsx", type: "file" as const },
        { name: "components", path: "src/components", type: "directory" as const, children: [
          { name: "Header.tsx", path: "src/components/Header.tsx", type: "file" as const }
        ]}
      ]
    },
    { name: "package.json", path: "package.json", type: "file" as const }
  ];

  const { files, folders } = extractProjectItems(tree);
  assert.equal(files.length, 3);
  assert.equal(folders.length, 2);

  assert.ok(files.some(f => f.path === "src/App.tsx"));
  assert.ok(files.some(f => f.path === "package.json"));
  assert.ok(folders.some(f => f.path === "src"));
  assert.ok(folders.some(f => f.path === "src/components"));

  const filtered = filterProjectItems(files, "App");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].path, "src/App.tsx");
});

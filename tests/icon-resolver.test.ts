// tests/icon-resolver.test.ts
// Validação do Icon Resolver do Explorer do NekoAI
// Executar: node --experimental-strip-types --test tests/icon-resolver.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveFileIconDef,
  resolveFolderIconDef
} from "../src/renderer/components/code/iconResolver.ts";

test("Arquivos obrigatórios solicitados na especificação", () => {
  const cases: Array<{ file: string; expectedId: string; expectedColor: string }> = [
    { file: "index.html", expectedId: "html", expectedColor: "#fb923c" },
    { file: "styles.css", expectedId: "css", expectedColor: "#38bdf8" },
    { file: "main.js", expectedId: "js", expectedColor: "#fde047" },
    { file: "App.jsx", expectedId: "react", expectedColor: "#38bdf8" },
    { file: "App.tsx", expectedId: "react", expectedColor: "#38bdf8" },
    { file: "package.json", expectedId: "package", expectedColor: "#ef4444" },
    { file: "package-lock.json", expectedId: "lock", expectedColor: "#f59e0b" },
    { file: "tsconfig.json", expectedId: "ts-config", expectedColor: "#3b82f6" },
    { file: "vite.config.ts", expectedId: "vite", expectedColor: "#a855f7" },
    { file: "next.config.js", expectedId: "next", expectedColor: "#e2e8f0" },
    { file: "README.md", expectedId: "readme", expectedColor: "#60a5fa" },
    { file: ".gitignore", expectedId: "git", expectedColor: "#f97316" },
    { file: "Dockerfile", expectedId: "docker", expectedColor: "#0284c7" },
    { file: ".env", expectedId: "env", expectedColor: "#eab308" },
    { file: "unknown.xyz", expectedId: "file-default", expectedColor: "#a89eb4" }
  ];

  for (const { file, expectedId, expectedColor } of cases) {
    const res = resolveFileIconDef(file);
    assert.ok(res.icon, `O arquivo ${file} deve retornar um componente de ícone válido`);
    assert.equal(
      res.id,
      expectedId,
      `O arquivo ${file} deve resolver para o ID '${expectedId}', recebido '${res.id}'`
    );
    assert.equal(
      res.color,
      expectedColor,
      `O arquivo ${file} deve ter a cor '${expectedColor}', recebida '${res.color}'`
    );
    assert.ok(
      res.className.length > 0,
      `O arquivo ${file} deve fornecer uma classe CSS`
    );
  }
});

test("Cobertura expandida de linguagens e frameworks", () => {
  const extraCases: Array<{ file: string; expectedId: string }> = [
    // Frameworks
    { file: "App.vue", expectedId: "vue" },
    { file: "Button.svelte", expectedId: "svelte" },
    { file: "index.astro", expectedId: "astro" },

    // Backend
    { file: "script.py", expectedId: "py" },
    { file: "index.php", expectedId: "php" },
    { file: "App.java", expectedId: "java" },
    { file: "Main.kt", expectedId: "kt" },
    { file: "main.go", expectedId: "go" },
    { file: "main.rs", expectedId: "rust" },
    { file: "Program.cs", expectedId: "cs" },
    { file: "main.c", expectedId: "c" },
    { file: "main.cpp", expectedId: "cpp" },
    { file: "header.h", expectedId: "c" },
    { file: "app.rb", expectedId: "ruby" },
    { file: "schema.sql", expectedId: "sql" },

    // Dados e configs especiais
    { file: "data.json", expectedId: "json" },
    { file: "config.yaml", expectedId: "yaml" },
    { file: "meta.xml", expectedId: "xml" },
    { file: "export.csv", expectedId: "csv" },
    { file: "settings.toml", expectedId: "toml" },
    { file: ".editorconfig", expectedId: "config" },
    { file: "tailwind.config.js", expectedId: "tailwind" },
    { file: "eslint.config.mjs", expectedId: "eslint" },
    { file: "prettier.config.js", expectedId: "prettier" },
    { file: "docker-compose.yml", expectedId: "docker" },
    { file: ".env.local", expectedId: "env" },
    { file: ".env.production", expectedId: "env" },

    // Shell
    { file: "deploy.sh", expectedId: "sh" },
    { file: "setup.ps1", expectedId: "terminal" },
    { file: "run.bat", expectedId: "terminal" },

    // Assets e mídia
    { file: "logo.svg", expectedId: "img" },
    { file: "photo.jpg", expectedId: "img" },
    { file: "backup.zip", expectedId: "archive" },
    { file: "manual.pdf", expectedId: "pdf" },
    { file: "font.woff2", expectedId: "font" }
  ];

  for (const { file, expectedId } of extraCases) {
    const res = resolveFileIconDef(file);
    assert.equal(
      res.id,
      expectedId,
      `O arquivo ${file} deve resolver para '${expectedId}', recebido '${res.id}'`
    );
  }
});

test("Pastas obrigatórias solicitadas na especificação (estados fechado e aberto)", () => {
  const folders: Array<{ folder: string; expectedId: string }> = [
    { folder: "src", expectedId: "src" },
    { folder: "assets", expectedId: "assets" },
    { folder: "public", expectedId: "public" },
    { folder: "components", expectedId: "components" },
    { folder: "node_modules", expectedId: "node_modules" },
    { folder: ".github", expectedId: "git" },
    { folder: "unknown-folder", expectedId: "default" }
  ];

  for (const { folder, expectedId } of folders) {
    // Estado fechado
    const closed = resolveFolderIconDef(folder, false);
    assert.ok(closed.icon, `Pasta ${folder} fechada deve ter ícone`);
    assert.equal(
      closed.id,
      expectedId,
      `Pasta ${folder} fechada deve ter ID '${expectedId}', recebido '${closed.id}'`
    );

    // Estado aberto
    const open = resolveFolderIconDef(folder, true);
    assert.ok(open.icon, `Pasta ${folder} aberta deve ter ícone`);
    assert.equal(
      open.id,
      expectedId,
      `Pasta ${folder} aberta deve ter ID '${expectedId}', recebido '${open.id}'`
    );
  }
});

test("Pasta raiz do projeto", () => {
  const rootClosed = resolveFolderIconDef("site-adv", false, true);
  assert.equal(rootClosed.id, "root");
  assert.equal(rootClosed.color, "#9333ea");

  const rootOpen = resolveFolderIconDef("site-adv", true, true);
  assert.equal(rootOpen.id, "root");
  assert.equal(rootOpen.color, "#a855f7");
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalizeRepoRelativePath } from "../src/main/git-path-normalizer";
import { parseGitStatusPorcelain } from "../src/main/git-sync";

describe("Selective Commit Path Normalization & Git Porcelain Parsing", () => {
  describe("1. normalizeRepoRelativePath - Casos Obrigatórios e Regressões", () => {
    it("1.1. Preserva 'index.html' exatamente e nunca remove o primeiro caractere", () => {
      assert.equal(normalizeRepoRelativePath("index.html"), "index.html");
      assert.notEqual(normalizeRepoRelativePath("index.html"), "ndex.html");
    });

    it("1.2. Normaliza './index.html' para 'index.html'", () => {
      assert.equal(normalizeRepoRelativePath("./index.html"), "index.html");
    });

    it("1.3. Normaliza './src/App.tsx' para 'src/App.tsx'", () => {
      assert.equal(normalizeRepoRelativePath("./src/App.tsx"), "src/App.tsx");
    });

    it("1.4. Preserva 'src/App.tsx' exatamente", () => {
      assert.equal(normalizeRepoRelativePath("src/App.tsx"), "src/App.tsx");
    });

    it("1.5. Preserva 'public/neko-pages.json' exatamente", () => {
      assert.equal(normalizeRepoRelativePath("public/neko-pages.json"), "public/neko-pages.json");
    });

    it("1.6. Preserva 'src/neko-pages.ts' exatamente", () => {
      assert.equal(normalizeRepoRelativePath("src/neko-pages.ts"), "src/neko-pages.ts");
    });

    it("1.7. Converte caminho absoluto Windows dentro do repo para relativo", () => {
      const repoRoot = "C:\\Projetos\\MeuApp";
      const absPath = "C:\\Projetos\\MeuApp\\index.html";
      assert.equal(normalizeRepoRelativePath(absPath, repoRoot), "index.html");
    });

    it("1.8. Converte caminho absoluto aninhado Windows para relativo com barras POSIX", () => {
      const repoRoot = "C:\\Projetos\\MeuApp";
      const absPath = "C:\\Projetos\\MeuApp\\src\\components\\Header.tsx";
      assert.equal(normalizeRepoRelativePath(absPath, repoRoot), "src/components/Header.tsx");
    });

    it("1.9. Preserva espaços, acentos, hífens e underscores em nomes de arquivos", () => {
      assert.equal(
        normalizeRepoRelativePath("documento com espacos.pdf"),
        "documento com espacos.pdf"
      );
      assert.equal(
        normalizeRepoRelativePath("./relatório-final_2026.docx"),
        "relatório-final_2026.docx"
      );
      assert.equal(
        normalizeRepoRelativePath("src/páginas/Início.tsx"),
        "src/páginas/Início.tsx"
      );
    });

    it("1.10. Rejeita caminhos que escapam da raiz (Directory Traversal)", () => {
      assert.throws(() => normalizeRepoRelativePath("../fora.txt"), /escapar/i);
      assert.throws(() => normalizeRepoRelativePath("../../segredo.env"), /escapar/i);
      assert.throws(() => normalizeRepoRelativePath("pasta/../../fora.txt"), /escapar/i);
    });

    it("1.11. Rejeita caminho absoluto fora do repoRoot fornecido", () => {
      const repoRoot = "C:\\Projetos\\MeuApp";
      const outsidePath = "C:\\OutroLugar\\arquivo.txt";
      assert.throws(() => normalizeRepoRelativePath(outsidePath, repoRoot), /fora do repositório/i);
    });

    it("1.12. Remove aspas envolventes se presentes", () => {
      assert.equal(normalizeRepoRelativePath('"index.html"'), "index.html");
      assert.equal(normalizeRepoRelativePath('"src/App.tsx"'), "src/App.tsx");
    });
  });

  describe("2. parseGitStatusPorcelain - Imunidade a Stripping de Espaço Inicial", () => {
    it("2.1. Extrai 'index.html' intacto de linha original com espaço inicial (' M index.html')", () => {
      const output = " M index.html\n";
      const parsed = parseGitStatusPorcelain(output);
      assert.equal(parsed.files.length, 1);
      assert.equal(parsed.files[0].path, "index.html");
      assert.notEqual(parsed.files[0].path, "ndex.html");
      assert.equal(parsed.files[0].status, "modified");
      assert.equal(parsed.files[0].staged, false);
    });

    it("2.2. Extrai 'index.html' intacto MESMO se o espaço inicial foi removido por trim ('M index.html')", () => {
      // Este foi o gatilho exato do bug original: stdout.trim() removeu o espaço inicial de ' M index.html'
      const output = "M index.html\n";
      const parsed = parseGitStatusPorcelain(output);
      assert.equal(parsed.files.length, 1);
      assert.equal(parsed.files[0].path, "index.html");
      assert.notEqual(parsed.files[0].path, "ndex.html");
      assert.equal(parsed.files[0].status, "modified");
      assert.equal(parsed.files[0].staged, false);
    });

    it("2.3. Extrai arquivos untracked intactos ('?? index.html')", () => {
      const output = "?? index.html\n";
      const parsed = parseGitStatusPorcelain(output);
      assert.equal(parsed.files.length, 1);
      assert.equal(parsed.files[0].path, "index.html");
      assert.equal(parsed.files[0].status, "untracked");
    });

    it("2.4. Extrai arquivos staged intactos ('M  index.html')", () => {
      const output = "M  index.html\n";
      const parsed = parseGitStatusPorcelain(output);
      assert.equal(parsed.files.length, 1);
      assert.equal(parsed.files[0].path, "index.html");
      assert.equal(parsed.files[0].status, "modified");
      assert.equal(parsed.files[0].staged, true);
    });

    it("2.5. Trata múltiplos arquivos sem corromper o primeiro nem os subsequentes", () => {
      // Simula stdout após trim(): primeiro arquivo perde espaço, segundo mantém
      const output = "M index.html\n?? src/App.tsx\n M public/neko-pages.json\n";
      const parsed = parseGitStatusPorcelain(output);
      assert.equal(parsed.files.length, 3);
      assert.equal(parsed.files[0].path, "index.html");
      assert.equal(parsed.files[1].path, "src/App.tsx");
      assert.equal(parsed.files[2].path, "public/neko-pages.json");
    });
  });

  describe("3. Fluxo de Git Add -- <files> com Commit Seletivo", () => {
    it("3.1. Garante que os argumentos do comando git add contenham 'index.html' e não 'ndex.html'", () => {
      const selectedFiles = ["index.html", "./src/App.tsx", "public/neko-pages.json"];
      const normalizedArgs = selectedFiles.map(f => normalizeRepoRelativePath(f));

      const gitArgs = ["add", "--", ...normalizedArgs];

      assert.deepEqual(gitArgs, [
        "add",
        "--",
        "index.html",
        "src/App.tsx",
        "public/neko-pages.json"
      ]);

      assert.ok(!gitArgs.includes("ndex.html"));
    });
  });
});

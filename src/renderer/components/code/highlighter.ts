import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import themeDarkPlus from "@shikijs/themes/dark-plus";
import langHtml from "@shikijs/langs/html";
import langCss from "@shikijs/langs/css";
import langJs from "@shikijs/langs/javascript";
import langJsx from "@shikijs/langs/jsx";
import langTs from "@shikijs/langs/typescript";
import langTsx from "@shikijs/langs/tsx";
import langJson from "@shikijs/langs/json";
import langMd from "@shikijs/langs/markdown";
import langXml from "@shikijs/langs/xml";
import langPhp from "@shikijs/langs/php";
import langPython from "@shikijs/langs/python";
import langSql from "@shikijs/langs/sql";
import langYaml from "@shikijs/langs/yaml";

import type { CodeLineTokens } from "./types";

const EXTENSION_MAP: Record<string, string> = {
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  svg: "xml",
  php: "php",
  py: "python",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml"
};

export function getLanguageForFile(filePath: string): string | null {
  const parts = filePath.split(/[/\\]/);
  const fileName = parts[parts.length - 1] || "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [themeDarkPlus],
      langs: [
        langHtml,
        langCss,
        langJs,
        langJsx,
        langTs,
        langTsx,
        langJson,
        langMd,
        langXml,
        langPhp,
        langPython,
        langSql,
        langYaml
      ],
      engine: createJavaScriptRegexEngine()
    }).catch((err) => {
      console.warn("[Neko/Highlighter] Falha ao inicializar Shiki:", err);
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

// Inicia o singleton do highlighter de imediato em background
void getHighlighter().catch(() => {});

export function tokenizePlainFallback(code: string): CodeLineTokens[] {
  const rawLines = code.split(/\r?\n/);
  return rawLines.map((line) => [{ content: line || " ", color: "#d4d4d4" }]);
}

const tokenCache = new Map<string, { content: string; lines: CodeLineTokens[] }>();

export async function tokenizeCode(filePath: string, code: string): Promise<CodeLineTokens[]> {
  const cached = tokenCache.get(filePath);
  if (cached && cached.content === code) {
    return cached.lines;
  }

  const lang = getLanguageForFile(filePath);
  if (!lang) {
    const plainLines = tokenizePlainFallback(code);
    tokenCache.set(filePath, { content: code, lines: plainLines });
    return plainLines;
  }

  try {
    const highlighter = await getHighlighter();
    const result = highlighter.codeToTokens(code, {
      lang,
      theme: "dark-plus"
    });

    const lines: CodeLineTokens[] = result.tokens.map((tokenLine) => {
      if (tokenLine.length === 0) {
        return [{ content: " ", color: "#d4d4d4" }];
      }
      return tokenLine.map((tok) => ({
        content: tok.content,
        color: tok.color || "#d4d4d4",
        fontStyle: tok.fontStyle
      }));
    });

    tokenCache.set(filePath, { content: code, lines });
    return lines;
  } catch (err) {
    console.warn("[Neko/Highlighter] Erro de tokenização em", filePath, err);
    const plain = tokenizePlainFallback(code);
    tokenCache.set(filePath, { content: code, lines: plain });
    return plain;
  }
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

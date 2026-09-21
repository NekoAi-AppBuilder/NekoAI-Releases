import { normalizeReleaseNotes, sanitizeAndConvertReleaseNotes, sanitizeUrl } from "../src/renderer/components/releaseNotesUtils.ts";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log("\n=======================================================");
console.log("TESTES OBRIGATÓRIOS: RELEASE NOTES NORMALIZER & SANITIZER");
console.log("=======================================================\n");

// -------------------------------------------------------------------
// CASO 1 — HTML PURO
// -------------------------------------------------------------------
console.log("▶ CASO 1 — HTML PURO");
const inputHtml = `<h2>Novidades</h2>
<ul>
<li>Correção de bug</li>
<li>Nova funcionalidade</li>
</ul>`;
const outHtml = sanitizeAndConvertReleaseNotes(normalizeReleaseNotes(inputHtml));
assert(outHtml.includes("## Novidades"), "Converteu <h2> em ## Novidades");
assert(outHtml.includes("- Correção de bug"), "Converteu <li> em bullet - Correção de bug");
assert(outHtml.includes("- Nova funcionalidade"), "Converteu <li> em bullet - Nova funcionalidade");
assert(!outHtml.includes("<h2>") && !outHtml.includes("<ul>") && !outHtml.includes("<li>"), "Nenhuma tag HTML residual no resultado");

// -------------------------------------------------------------------
// CASO 2 — MARKDOWN PURO
// -------------------------------------------------------------------
console.log("\n▶ CASO 2 — MARKDOWN PURO");
const inputMd = `## Melhorias

- Suporte a modelos adicionais
- Correção de **estabilidade**
- Uso de \`hot-reload\``;
const outMd = sanitizeAndConvertReleaseNotes(normalizeReleaseNotes(inputMd));
assert(outMd.includes("## Melhorias"), "Preservou título Markdown");
assert(outMd.includes("- Suporte a modelos adicionais"), "Preservou lista com bullets");
assert(outMd.includes("**estabilidade**"), "Preservou texto em negrito **estabilidade**");
assert(outMd.includes("`hot-reload`"), "Preservou código inline `hot-reload`");

// -------------------------------------------------------------------
// CASO 3 — HÍBRIDO (MARKDOWN + HTML)
// -------------------------------------------------------------------
console.log("\n▶ CASO 3 — HÍBRIDO");
const inputHybrid = `## Versão 0.4.86

<p>Principais alterações:</p>
<ul>
<li>Uso de <strong>tags</strong> embutidas</li>
<li>Melhoria no <code>Preview</code></li>
</ul>`;
const outHybrid = sanitizeAndConvertReleaseNotes(normalizeReleaseNotes(inputHybrid));
assert(outHybrid.includes("## Versão 0.4.86"), "Preservou cabeçalho Markdown");
assert(outHybrid.includes("Principais alterações:"), "Renderizou parágrafo sem tag <p>");
assert(outHybrid.includes("- Uso de **tags** embutidas"), "Converteu <strong> e <li> harmoniosamente");
assert(outHybrid.includes("- Melhoria no `Preview`"), "Converteu <code> e <li> harmoniosamente");
assert(!outHybrid.includes("<p>") && !outHybrid.includes("<strong>") && !outHybrid.includes("<code>"), "Nenhuma tag HTML residual no resultado híbrido");

// -------------------------------------------------------------------
// CASO 4 — ARRAY / MÚLTIPLAS VERSÕES
// -------------------------------------------------------------------
console.log("\n▶ CASO 4 — ARRAY / MÚLTIPLAS VERSÕES");
const inputMulti = [
  { version: "0.4.85", note: "Nota 1: Correção de layout" },
  { version: "0.4.86", note: "Nota 2: Suporte a release notes" }
];
const outMultiNorm = normalizeReleaseNotes(inputMulti);
const outMulti = sanitizeAndConvertReleaseNotes(outMultiNorm);
assert(outMulti.includes("### Versão 0.4.85"), "Incluiu seção da versão 0.4.85");
assert(outMulti.includes("Nota 1: Correção de layout"), "Preservou nota 1");
assert(outMulti.includes("### Versão 0.4.86"), "Incluiu seção da versão 0.4.86");
assert(outMulti.includes("Nota 2: Suporte a release notes"), "Preservou nota 2");
assert(outMulti.includes("---"), "Separador visual entre versões incluído");

// -------------------------------------------------------------------
// CASO 5 — VAZIO
// -------------------------------------------------------------------
console.log("\n▶ CASO 5 — VAZIO (null, undefined, '')");
assert(normalizeReleaseNotes(null) === "", "Tratou null retornando string vazia");
assert(normalizeReleaseNotes(undefined) === "", "Tratou undefined retornando string vazia");
assert(normalizeReleaseNotes("") === "", "Tratou string vazia retornando string vazia");
assert(normalizeReleaseNotes([]) === "", "Tratou array vazio retornando string vazia");
assert(sanitizeAndConvertReleaseNotes("") === "", "Sanitizador tratou string vazia sem erros");

// -------------------------------------------------------------------
// CASO 6 — SEGURANÇA / XSS
// -------------------------------------------------------------------
console.log("\n▶ CASO 6 — SEGURANÇA / XSS");
const inputXss = `<script>alert(1)</script>
<img src="x" onerror="alert(2)"/>
<a href="javascript:alert(3)">Clique aqui</a>
<iframe src="https://malicious.com"></iframe>
<object data="malicious.swf"></object>
<embed src="malicious.swf">
<form action="/steal"><input type="text"/></form>
<style>body { display: none; }</style>
<svg onload="alert(4)"></svg>`;

const outXss = sanitizeAndConvertReleaseNotes(inputXss);
assert(!outXss.includes("<script>") && !outXss.includes("alert(1)"), "<script> e seu corpo foram removidos");
assert(!outXss.includes("onerror") && !outXss.includes("alert(2)"), "onerror foi removido e imagem bloqueada");
assert(!outXss.includes("javascript:") && !outXss.includes("alert(3)"), "javascript: no href foi neutralizado");
assert(!outXss.includes("<iframe>") && !outXss.includes("malicious.com"), "<iframe> foi removido");
assert(!outXss.includes("<object>") && !outXss.includes("<embed>"), "<object> e <embed> foram removidos");
assert(!outXss.includes("<form>") && !outXss.includes("<input"), "<form> foi removido");
assert(!outXss.includes("<style>") && !outXss.includes("display: none"), "<style> foi removido");
assert(!outXss.includes("<svg>") && !outXss.includes("alert(4)"), "<svg> foi removido");

// -------------------------------------------------------------------
// CASO 7 — LINK EXTERNO SEGURO
// -------------------------------------------------------------------
console.log("\n▶ CASO 7 — LINK EXTERNO SEGURO");
const inputLink = `[Ver no GitHub](https://github.com/NekoAi-AppBuilder/NekoAI-Releases)
<a href="https://github.com/NekoAi-AppBuilder/NekoAI-Releases">Link HTML GitHub</a>
[Link Inseguro](javascript:alert(99))`;

const outLink = sanitizeAndConvertReleaseNotes(inputLink);
assert(outLink.includes("[Ver no GitHub](https://github.com/NekoAi-AppBuilder/NekoAI-Releases)"), "Link Markdown HTTPS preservado");
assert(outLink.includes("[Link HTML GitHub](https://github.com/NekoAi-AppBuilder/NekoAI-Releases)"), "Link HTML HTTPS convertido para link seguro");
assert(!outLink.includes("javascript:alert(99)"), "Link Markdown com javascript: neutralizado");

console.log("\n=======================================================");
console.log(`RESULTADO: ${passed} passaram, ${failed} falharam.`);
console.log("=======================================================\n");

if (failed > 0) {
  process.exit(1);
}

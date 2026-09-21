/**
 * Utilitários para normalização, conversão e sanitização segura de Release Notes do NekoAI.
 */

export interface ReleaseNoteItem {
  version?: string;
  note?: string | null;
  [key: string]: any;
}

/**
 * Normaliza o payload de releaseNotes (string, array de versões ou vazio)
 * em uma representação de texto consolidada sem perda de versões intermediárias.
 */
export function normalizeReleaseNotes(
  raw: string | ReleaseNoteItem[] | null | undefined
): string {
  if (raw === null || raw === undefined) return "";

  if (typeof raw === "string") {
    return raw.trim();
  }

  if (Array.isArray(raw)) {
    const validItems = raw.filter((item) => item && typeof item === "object");
    if (validItems.length === 0) return "";

    const sections: string[] = [];
    for (const item of validItems) {
      const ver = item.version ? String(item.version).trim() : "";
      const note = item.note ? String(item.note).trim() : "";
      if (ver && note) {
        sections.push(`### Versão ${ver}\n\n${note}`);
      } else if (ver) {
        sections.push(`### Versão ${ver}`);
      } else if (note) {
        sections.push(note);
      }
    }

    return sections.join("\n\n---\n\n");
  }

  return String(raw).trim();
}

/**
 * Sanitiza URL para links: aceita apenas https: e http:, bloqueando javascript:, data:, file:, etc.
 */
export function sanitizeUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^(https?:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Sanitiza e converte HTML semântico / Markdown híbrido em Markdown limpo e seguro.
 * Remove rigorosamente tags e atributos executáveis (script, iframe, onerror, onload, onclick, javascript:).
 */
export function sanitizeAndConvertReleaseNotes(input: string): string {
  if (!input) return "";

  let content = input;

  // 1. Remover blocos de tags perigosas e seu conteúdo interno
  const dangerousTags = [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "svg",
    "canvas",
    "noscript",
    "meta",
    "link",
  ];

  for (const tag of dangerousTags) {
    const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    content = content.replace(regex, "");
    // Caso tag auto-fechada ou sem fechamento
    const selfClosingRegex = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    content = content.replace(selfClosingRegex, "");
  }

  // 2. Remover atributos de evento inline (onclick, onload, onerror, onmouseover, etc.)
  content = content.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 3. Tratar e sanitizar tags <a>
  content = content.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs, linkText) => {
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawHref = hrefMatch ? hrefMatch[1] || hrefMatch[2] || hrefMatch[3] : "";
    const safeHref = sanitizeUrl(rawHref);
    if (safeHref) {
      return `[${linkText}](${safeHref})`;
    }
    // Link com protocolo não seguro: preservar apenas o texto sem link executável
    return linkText;
  });

  // 4. Converter tags de lista: <ul>, <ol>, <li>
  content = content.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_match, listBody) => {
    const items = listBody.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, itemText: string) => {
      return `\n- ${itemText.trim()}`;
    });
    return `\n\n${items}\n\n`;
  });

  content = content.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_match, listBody) => {
    let index = 1;
    const items = listBody.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, itemText: string) => {
      const res = `\n${index}. ${itemText.trim()}`;
      index++;
      return res;
    });
    return `\n\n${items}\n\n`;
  });

  // Qualquer <li> solto remanescente
  content = content.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1\n");

  // 5. Converter blocos de código: <pre><code>...</code></pre> e <pre>...</pre>
  content = content.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n");
  content = content.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n\n```\n$1\n```\n\n");
  content = content.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // 6. Converter cabeçalhos: <h1> até <h6>
  content = content.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  content = content.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  content = content.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  content = content.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");
  content = content.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n\n##### $1\n\n");
  content = content.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n\n###### $1\n\n");

  // 7. Converter formatação de texto: <strong>, <b>, <em>, <i>
  content = content.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  content = content.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // 8. Converter blockquotes, hr, br, p, span
  content = content.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n\n> $1\n\n");
  content = content.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
  content = content.replace(/<br\b[^>]*\/?>/gi, "\n");
  content = content.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  content = content.replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1");

  // 9. Remover quaisquer outras tags HTML não permitidas (ex: <div>, <img>, etc.)
  content = content.replace(/<\/?([a-zA-Z0-9_-]+)\b[^>]*>/g, "");

  // 10. Sanitizar links Markdown para impedir protocolos perigosos [text](javascript:...)
  content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, linkUrl) => {
    const clean = sanitizeUrl(linkUrl);
    if (clean) {
      return `[${text}](${clean})`;
    }
    return text;
  });

  // 11. Normalizar quebras de linha excessivas (mais de 2 seguidas)
  content = content.replace(/\n{3,}/g, "\n\n");

  return content.trim();
}

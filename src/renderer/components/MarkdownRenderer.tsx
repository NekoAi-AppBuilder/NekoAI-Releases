/**
 * MarkdownRenderer — Ponto único de renderização de Markdown no renderer do NekoAI.
 *
 * Segurança:
 *  - Usa react-markdown, que NÃO usa dangerouslySetInnerHTML internamente.
 *  - HTML arbitrário vindo do modelo é bloqueado (disallowedElements lista tags perigosas;
 *    rehype-raw NÃO está incluído, então HTML bruto no Markdown vira texto literal).
 *  - Links externos são abertos via window.neko.openExternal (IPC seguro).
 *
 * Code blocks:
 *  - Reutiliza o singleton de highlighter.ts existente (codeToTokens / tokenizePlainFallback).
 *  - Discriminação inline vs bloco: o componente `pre` é substituído; quando ele recebe
 *    um filho `code`, sabemos que é um bloco fenced. Inline code não tem `pre` pai.
 *  - Tokens renderizados como spans React coloridos — sem innerHTML.
 *
 * Uso:
 *  <MarkdownRenderer content={text} />
 */

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokenizeCode, tokenizePlainFallback } from "./code/highlighter";
import type { CodeLineTokens } from "./code/types";

// ---------------------------------------------------------------------------
// Code block com syntax highlighting via highlighter.ts existente
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  language: string | null;
  code: string;
}

function CodeBlock({ language, code }: CodeBlockProps) {
  // Fallback síncrono imediato para zero atraso visual
  const [lines, setLines] = React.useState<CodeLineTokens[]>(() =>
    tokenizePlainFallback(code)
  );

  React.useEffect(() => {
    let alive = true;
    setLines(tokenizePlainFallback(code));

    if (language) {
      const fakePath = `snippet.${language}`;
      tokenizeCode(fakePath, code)
        .then((tokenized) => { if (alive) setLines(tokenized); })
        .catch(() => { /* mantém fallback */ });
    }

    return () => { alive = false; };
  }, [code, language]);

  return (
    <div className="md-code-block">
      {language && (
        <div className="md-code-lang" aria-hidden="true">{language}</div>
      )}
      <div className="md-code-scroller">
        <pre
          className="md-code-pre"
          tabIndex={0}
          aria-label={language ? `Bloco de código ${language}` : "Bloco de código"}
        >
          {lines.map((lineTokens, lineIdx) => (
            <div key={lineIdx} className="md-code-line">
              {lineTokens.map((token, tokIdx) => (
                <span
                  key={tokIdx}
                  style={{
                    color: token.color || "#d4d4d4",
                    fontStyle: token.fontStyle === 1 ? "italic" : undefined,
                  }}
                >
                  {token.content}
                </span>
              ))}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Link seguro — abre externamente via IPC, nunca navega no renderer
// ---------------------------------------------------------------------------

function SafeLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!href) return;
    if (typeof window !== "undefined" && (window as any).neko?.openExternal) {
      void (window as any).neko.openExternal(href);
    }
  };

  return (
    <a href={href} onClick={handleClick} className="md-link" rel="noopener noreferrer" title={href}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// Tags HTML que serão removidas completamente quando aparecerem no Markdown.
// rehype-raw NÃO está incluído, então HTML bruto em geral já vira texto;
// esta lista é defesa em profundidade contra extensões de parser futuras.
const BLOCKED_ELEMENTS = [
  "script", "iframe", "object", "embed",
  "style", "link", "meta", "base", "noscript",
];

export function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  return (
    <div className={`md-root${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={BLOCKED_ELEMENTS}
        unwrapDisallowed={false}
        components={{
          // ------------------------------------------------------------------
          // PRE: envolve blocos de código fenced. Interceptamos aqui para
          // detectar a linguagem e delegar ao CodeBlock com syntax highlight.
          // ------------------------------------------------------------------
          pre({ children }) {
            // Extrai o elemento <code> filho (padrão react-markdown)
            const child = React.Children.only(children) as React.ReactElement<{
              className?: string;
              children?: React.ReactNode;
            }> | null;

            if (!child || !React.isValidElement(child)) {
              // Fallback: pre genérico para casos inesperados
              return (
                <div className="md-code-block">
                  <div className="md-code-scroller">
                    <pre className="md-code-pre">{children}</pre>
                  </div>
                </div>
              );
            }

            const cls = child.props.className ?? "";
            const match = /language-(\w+)/.exec(cls);
            const language = match ? match[1] : null;
            const rawCode = String(child.props.children ?? "").replace(/\n$/, "");

            return <CodeBlock language={language} code={rawCode} />;
          },

          // ------------------------------------------------------------------
          // CODE: apenas código inline chega aqui (blocos são tratados por pre).
          // ------------------------------------------------------------------
          code({ children }) {
            return <code className="md-inline-code">{children}</code>;
          },

          // Links externos seguros
          a({ href, children }) {
            return <SafeLink href={href}>{children}</SafeLink>;
          },

          // Headings
          h1({ children }) { return <h1 className="md-h1">{children}</h1>; },
          h2({ children }) { return <h2 className="md-h2">{children}</h2>; },
          h3({ children }) { return <h3 className="md-h3">{children}</h3>; },
          h4({ children }) { return <h4 className="md-h4">{children}</h4>; },
          h5({ children }) { return <h5 className="md-h5">{children}</h5>; },
          h6({ children }) { return <h6 className="md-h6">{children}</h6>; },

          // Parágrafos e texto
          p({ children }) { return <p className="md-p">{children}</p>; },
          strong({ children }) { return <strong className="md-strong">{children}</strong>; },
          em({ children }) { return <em className="md-em">{children}</em>; },

          // Listas
          ul({ children }) { return <ul className="md-ul">{children}</ul>; },
          ol({ children }) { return <ol className="md-ol">{children}</ol>; },
          li({ children }) { return <li className="md-li">{children}</li>; },

          // Tabelas GFM
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table className="md-table">{children}</table>
              </div>
            );
          },
          thead({ children }) { return <thead className="md-thead">{children}</thead>; },
          tbody({ children }) { return <tbody>{children}</tbody>; },
          tr({ children }) { return <tr className="md-tr">{children}</tr>; },
          th({ children }) { return <th className="md-th">{children}</th>; },
          td({ children }) { return <td className="md-td">{children}</td>; },

          // Blockquote
          blockquote({ children }) {
            return <blockquote className="md-blockquote">{children}</blockquote>;
          },

          // Separador
          hr() { return <hr className="md-hr" />; },

          // Imagens bloqueadas: modelos não devem carregar recursos externos
          img({ alt }) {
            return (
              <span className="md-img-blocked" title="Imagem bloqueada por segurança">
                [imagem: {alt || "sem descrição"}]
              </span>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

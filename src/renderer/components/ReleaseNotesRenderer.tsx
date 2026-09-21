/**
 * ReleaseNotesRenderer — Renderizador seguro e especializado para Release Notes no NekoAI.
 *
 * Características:
 *  - Suporta Markdown, HTML semântico e formato híbrido (Markdown + HTML).
 *  - Suporta arrays de múltiplas versões sem perda de notas intermediárias.
 *  - Sanitização estrita contra XSS, bloqueando scripts, iframes, atributos inline on* e protocolos perigosos.
 *  - Links externos delegados com segurança ao navegador padrão via window.neko.openExternal (IPC).
 *  - Completamente isolado de MarkdownRenderer.tsx para garantir zero regressão no Chat ou Timeline.
 */

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  normalizeReleaseNotes,
  sanitizeAndConvertReleaseNotes,
  ReleaseNoteItem,
} from "./releaseNotesUtils";

interface SafeReleaseNotesLinkProps {
  href?: string;
  children?: React.ReactNode;
}

function SafeReleaseNotesLink({ href, children }: SafeReleaseNotesLinkProps) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!href) return;
    if (typeof window !== "undefined" && (window as any).neko?.openExternal) {
      void (window as any).neko.openExternal(href);
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className="updater-rn-link"
      rel="noopener noreferrer"
      title={href}
    >
      {children}
    </a>
  );
}

export interface ReleaseNotesRendererProps {
  notes?: string | ReleaseNoteItem[] | null;
  className?: string;
}

export function ReleaseNotesRenderer({
  notes,
  className = "",
}: ReleaseNotesRendererProps) {
  const normalized = React.useMemo(() => normalizeReleaseNotes(notes), [notes]);
  const processed = React.useMemo(
    () => sanitizeAndConvertReleaseNotes(normalized),
    [normalized]
  );

  if (!processed) {
    return (
      <div className={`updater-rn-empty ${className}`}>
        <p>Melhorias de estabilidade e novas funcionalidades.</p>
      </div>
    );
  }

  return (
    <div className={`updater-rn-container ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={[
          "script",
          "iframe",
          "object",
          "embed",
          "style",
          "form",
          "svg",
        ]}
        unwrapDisallowed={false}
        components={{
          h1({ children }) {
            return <h1 className="updater-rn-h1">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="updater-rn-h2">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="updater-rn-h3">{children}</h3>;
          },
          h4({ children }) {
            return <h4 className="updater-rn-h4">{children}</h4>;
          },
          h5({ children }) {
            return <h5 className="updater-rn-h5">{children}</h5>;
          },
          h6({ children }) {
            return <h6 className="updater-rn-h6">{children}</h6>;
          },
          p({ children }) {
            return <p className="updater-rn-p">{children}</p>;
          },
          ul({ children }) {
            return <ul className="updater-rn-ul">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="updater-rn-ol">{children}</ol>;
          },
          li({ children }) {
            return <li className="updater-rn-li">{children}</li>;
          },
          strong({ children }) {
            return <strong className="updater-rn-strong">{children}</strong>;
          },
          em({ children }) {
            return <em className="updater-rn-em">{children}</em>;
          },
          code({ children, className: codeClass }) {
            const isBlock = codeClass && codeClass.includes("language-");
            return (
              <code
                className={
                  isBlock ? "updater-rn-code-block" : "updater-rn-code-inline"
                }
              >
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <pre className="updater-rn-pre">{children}</pre>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="updater-rn-blockquote">
                {children}
              </blockquote>
            );
          },
          hr() {
            return <hr className="updater-rn-hr" />;
          },
          a({ href, children }) {
            return (
              <SafeReleaseNotesLink href={href}>
                {children}
              </SafeReleaseNotesLink>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

export default ReleaseNotesRenderer;

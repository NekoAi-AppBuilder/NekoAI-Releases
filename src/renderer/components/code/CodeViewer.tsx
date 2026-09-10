import React, { useState, useEffect } from "react";
import { Code2 } from "lucide-react";
import { tokenizeCode, tokenizePlainFallback } from "./highlighter";
import type { CodeLineTokens } from "./types";

interface CodeViewerProps {
  filePath: string | null;
  content: string | null;
}

export const CodeViewer: React.FC<CodeViewerProps> = ({ filePath, content }) => {
  const [lines, setLines] = useState<CodeLineTokens[]>(() => {
    if (!content) return [];
    return tokenizePlainFallback(content);
  });

  useEffect(() => {
    if (!filePath || content === null) {
      setLines([]);
      return;
    }

    let isCurrent = true;

    // Imediatamente define fallback em texto para zero atraso visual
    setLines(tokenizePlainFallback(content));

    // Tokeniza com Shiki em background e aplica os tokens com syntax highlighting
    tokenizeCode(filePath, content).then((tokenizedLines) => {
      if (isCurrent) {
        setLines(tokenizedLines);
      }
    }).catch(() => {
      if (isCurrent) {
        setLines(tokenizePlainFallback(content));
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [filePath, content]);

  // Previne atalhos de edição acidentais (ex.: Ctrl+S do navegador)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
    }
  };

  if (!filePath || content === null) {
    return (
      <div className="code-viewer-empty">
        <div className="code-viewer-empty-icon">
          <Code2 size={32} />
        </div>
        <p>Selecione um arquivo para visualizar o código.</p>
        <span>O código é exibido no modo somente leitura.</span>
      </div>
    );
  }

  return (
    <div
      className="code-viewer-container"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="region"
      aria-label={`Visualizador de código: ${filePath}`}
    >
      <div className="code-viewer-scroller">
        <div className="code-viewer-content">
          {lines.map((lineTokens, lineIdx) => {
            const lineNum = lineIdx + 1;
            return (
              <div key={lineNum} className="code-line">
                <span className="code-line-number" aria-hidden="true">
                  {lineNum}
                </span>
                <span className="code-line-code">
                  {lineTokens.map((token, tokIdx) => (
                    <span
                      key={tokIdx}
                      style={{
                        color: token.color || "#d4d4d4",
                        fontStyle: token.fontStyle === 1 ? "italic" : "normal"
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

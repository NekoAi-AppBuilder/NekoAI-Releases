import React, { useRef, useEffect } from "react";
import { X } from "lucide-react";
import { FileIcon } from "./FileIcon";
import type { CodeTab } from "./types";

interface CodeTabsProps {
  tabs: CodeTab[];
  activeTabPath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}

export const CodeTabs: React.FC<CodeTabsProps> = ({
  tabs,
  activeTabPath,
  onSelectTab,
  onCloseTab
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Scroll horizontal com a roda do mouse/trackpad
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    if (e.deltaY !== 0 && !e.shiftKey) {
      containerRef.current.scrollLeft += e.deltaY;
    }
  };

  // Garante que a aba ativa esteja sempre visível no viewport das abas
  useEffect(() => {
    if (!activeTabPath) return;
    const activeEl = tabRefs.current.get(activeTabPath);
    if (activeEl) {
      activeEl.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest"
      });
    }
  }, [activeTabPath]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="code-tabs-container"
      onWheel={handleWheel}
      role="tablist"
      aria-label="Arquivos abertos"
    >
      {tabs.map((tab) => {
        const isActive = tab.path === activeTabPath;
        return (
          <button
            key={tab.path}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.path, el);
              else tabRefs.current.delete(tab.path);
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`code-tab ${isActive ? "active" : ""}`}
            onClick={() => onSelectTab(tab.path)}
            title={tab.path}
          >
            <span className="code-tab-icon">
              <FileIcon fileName={tab.name} size={14} />
            </span>
            <span className="code-tab-name">{tab.name}</span>
            <span
              className="code-tab-close"
              role="button"
              aria-label={`Fechar ${tab.name}`}
              title="Fechar"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.path);
              }}
            >
              <X size={13} />
            </span>
          </button>
        );
      })}
    </div>
  );
};

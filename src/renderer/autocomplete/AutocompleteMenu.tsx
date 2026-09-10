import React from "react";
import {
  Settings2,
  Wrench,
  HelpCircle,
  RefreshCw,
  Bug,
  GitBranch,
  Folder,
  Eye,
  FileText,
  FolderOpen,
  Cpu,
  Layers,
  AlertTriangle,
  List,
  SquareTerminal,
  ArrowLeft
} from "lucide-react";
import type { ChatCommand, ChatContext, ProjectItem, AutocompleteMode } from "./types.ts";

interface AutocompleteMenuProps {
  mode: AutocompleteMode;
  items: Array<ChatCommand | ChatContext | ProjectItem>;
  selectedIndex: number;
  onSelect: (item: ChatCommand | ChatContext | ProjectItem) => void;
  onHoverIndex?: (index: number) => void;
  onBack?: () => void;
}

function renderItemIcon(iconName?: string, type?: string) {
  const size = 14;
  switch (iconName) {
    case "Settings2": return <Settings2 size={size} />;
    case "Wrench": return <Wrench size={size} />;
    case "HelpCircle": return <HelpCircle size={size} />;
    case "RefreshCw": return <RefreshCw size={size} />;
    case "Bug": return <Bug size={size} />;
    case "GitBranch": return <GitBranch size={size} />;
    case "Folder": return <Folder size={size} />;
    case "FolderOpen": return <FolderOpen size={size} />;
    case "Eye": return <Eye size={size} />;
    case "FileText": return <FileText size={size} />;
    case "Cpu": return <Cpu size={size} />;
    case "Layers": return <Layers size={size} />;
    case "AlertTriangle": return <AlertTriangle size={size} />;
    case "List": return <List size={size} />;
    case "SquareTerminal": return <SquareTerminal size={size} />;
    default:
      if (type === "directory") return <FolderOpen size={size} />;
      return <FileText size={size} />;
  }
}

export const AutocompleteMenu: React.FC<AutocompleteMenuProps> = ({
  mode,
  items,
  selectedIndex,
  onSelect,
  onHoverIndex,
  onBack
}) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!listRef.current) return;
    const selectedElement = listRef.current.querySelector<HTMLElement>(".autocomplete-item.selected");
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div className="autocomplete-popover">
        <div className="autocomplete-header">
          {onBack && (
            <button
              type="button"
              className="autocomplete-back-btn"
              onMouseDown={e => e.preventDefault()}
              onClick={onBack}
              title="Voltar aos contextos"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <span className="autocomplete-title">
            {mode === "commands" && "Comandos"}
            {mode === "contexts" && "Contextos"}
            {mode === "files" && "Arquivos do projeto"}
            {mode === "folders" && "Pastas do projeto"}
          </span>
        </div>
        <div className="autocomplete-empty">
          Nenhum resultado correspondente.
        </div>
      </div>
    );
  }

  return (
    <div className="autocomplete-popover" role="listbox" aria-label="Sugestões do chat">
      <div className="autocomplete-header">
        {onBack && (
          <button
            type="button"
            className="autocomplete-back-btn"
            onMouseDown={e => e.preventDefault()}
            onClick={onBack}
            title="Voltar aos contextos"
          >
            <ArrowLeft size={13} />
          </button>
        )}
        <span className="autocomplete-title">
          {mode === "commands" && "Comandos"}
          {mode === "contexts" && "Contextos"}
          {mode === "files" && "Arquivos do projeto"}
          {mode === "folders" && "Pastas do projeto"}
        </span>
        <span className="autocomplete-shortcuts-hint">
          <span>↑↓ navegar</span>
          <span>↵ selecionar</span>
          <span>esc fechar</span>
        </span>
      </div>

      <div className="autocomplete-list" ref={listRef}>
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;

          // Item de comando
          if ("command" in item) {
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`autocomplete-item ${isSelected ? "selected" : ""}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHoverIndex?.(index)}
              >
                <div className="autocomplete-icon-wrap">
                  {renderItemIcon(item.iconName)}
                </div>
                <div className="autocomplete-item-details">
                  <div className="autocomplete-item-main">
                    <span className="autocomplete-token">{item.command}</span>
                    <span className="autocomplete-badge">{item.name}</span>
                  </div>
                  <small className="autocomplete-desc">{item.description}</small>
                </div>
              </button>
            );
          }

          // Item de contexto estático
          if ("context" in item) {
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`autocomplete-item ${isSelected ? "selected" : ""}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHoverIndex?.(index)}
              >
                <div className="autocomplete-icon-wrap">
                  {renderItemIcon(item.iconName)}
                </div>
                <div className="autocomplete-item-details">
                  <div className="autocomplete-item-main">
                    <span className="autocomplete-token">{item.context}</span>
                    <span className="autocomplete-badge">{item.name}</span>
                    {item.isPicker && (
                      <span className="autocomplete-picker-tag">selecionar</span>
                    )}
                  </div>
                  <small className="autocomplete-desc">{item.description}</small>
                </div>
              </button>
            );
          }

          // Item de arquivo ou pasta do projeto
          return (
            <button
              key={item.path}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={`autocomplete-item project-item ${isSelected ? "selected" : ""}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHoverIndex?.(index)}
            >
              <div className="autocomplete-icon-wrap">
                {renderItemIcon(undefined, item.type)}
              </div>
              <div className="autocomplete-item-details">
                <div className="autocomplete-item-main">
                  <span className="autocomplete-token">@{item.path}</span>
                  <span className="autocomplete-badge">
                    {item.type === "directory" ? "Pasta" : "Arquivo"}
                  </span>
                </div>
                <small className="autocomplete-desc">{item.name}</small>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

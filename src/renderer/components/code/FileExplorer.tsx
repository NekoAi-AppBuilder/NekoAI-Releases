import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderRoot,
  Search,
  ListCollapse
} from "lucide-react";
import { FileIcon, FolderIcon } from "./FileIcon";
import type { FileNode } from "./types";

interface FileExplorerProps {
  projectRoot: string | null;
  tree: FileNode[];
  activeFilePath: string | null;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onCollapseAll: () => void;
  onSelectFile: (path: string, name: string) => void;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const walk = (items: FileNode[]): FileNode[] =>
    items.flatMap((node) => {
      const selfMatch =
        node.name.toLowerCase().includes(q) ||
        node.path.toLowerCase().includes(q);
      if (node.type !== "directory") return selfMatch ? [node] : [];

      const children = walk(node.children || []);
      if (selfMatch || children.length) {
        return [
          {
            ...node,
            children: children.length ? children : node.children || []
          }
        ];
      }
      return [];
    });

  return walk(nodes);
}

function getProjectFolderName(rootPath: string | null): string {
  if (!rootPath) return "Projeto";
  const normalized = rootPath.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || "Projeto";
}

export const FileExplorer: React.FC<FileExplorerProps> = ({
  projectRoot,
  tree,
  activeFilePath,
  expandedFolders,
  onToggleFolder,
  onCollapseAll,
  onSelectFile
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const projectName = getProjectFolderName(projectRoot);
  const filteredTree = filterTree(tree, searchQuery);
  const isRootExpanded = expandedFolders.has("__root__");

  const renderNode = (node: FileNode, depth: number = 1) => {
    const isDir = node.type === "directory";
    // Quando há busca ativa, expande automaticamente as pastas correspondentes
    const isOpen = searchQuery.trim() ? true : expandedFolders.has(node.path);
    const isActive = !isDir && node.path === activeFilePath;

    return (
      <div key={node.path} className="tree-node">
        <button
          type="button"
          className={`tree-row ${isActive ? "active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          onClick={() => {
            if (isDir) {
              onToggleFolder(node.path);
            } else {
              onSelectFile(node.path, node.name);
            }
          }}
          title={node.path}
        >
          <span className="tree-caret">
            {isDir ? (
              isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />
            ) : (
              <span className="tree-caret-spacer" />
            )}
          </span>
          <span className="tree-icon">
            {isDir ? (
              <FolderIcon folderName={node.name} isOpen={isOpen} size={14} />
            ) : (
              <FileIcon fileName={node.name} size={14} />
            )}
          </span>
          <span className="tree-name">{node.name}</span>
        </button>

        {isDir && isOpen && node.children && node.children.length > 0 && (
          <div className="tree-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="code-explorer" aria-label="Explorador de arquivos">
      <div className="code-explorer-head">
        <div className="code-explorer-title">
          <FolderRoot size={14} />
          <span>EXPLORADOR</span>
        </div>
        <button
          type="button"
          className="code-explorer-action"
          onClick={onCollapseAll}
          title="Recolher tudo"
          aria-label="Recolher tudo"
        >
          <ListCollapse size={14} />
        </button>
      </div>

      <div className="code-search">
        <Search size={13} />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar arquivos"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>

      <div className="code-tree-scroller">
        {/* Pasta Raiz do Projeto */}
        <div className="tree-root-item">
          <button
            type="button"
            className="tree-row tree-root-row"
            onClick={() => onToggleFolder("__root__")}
            title={`Pasta raiz: ${projectRoot || projectName}`}
          >
            <span className="tree-caret">
              {isRootExpanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </span>
            <span className="tree-icon">
              <FolderIcon folderName={projectName} isOpen={isRootExpanded} size={15} isRoot={true} />
            </span>
            <span className="tree-name tree-root-name">{projectName}</span>
          </button>
        </div>

        {/* Filhos da Pasta Raiz */}
        {isRootExpanded && (
          <div className="tree-root-children">
            {filteredTree.map((node) => renderNode(node, 1))}
            {searchQuery.trim() && filteredTree.length === 0 && (
              <div className="code-search-empty">Nenhum arquivo encontrado.</div>
            )}
            {!searchQuery.trim() && tree.length === 0 && (
              <div className="code-search-empty">Nenhum arquivo no projeto.</div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

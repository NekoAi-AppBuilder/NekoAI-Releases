import React, { useState, useEffect, useCallback, useRef } from "react";
import { FileExplorer } from "./FileExplorer";
import { CodeTabs } from "./CodeTabs";
import { CodeViewer } from "./CodeViewer";
import type { FileNode, CodeTab } from "./types";

interface CodeWorkspaceProps {
  projectRoot: string | null;
  tree: FileNode[];
  lastChangedFile?: string | null;
}

export const CodeWorkspace: React.FC<CodeWorkspaceProps> = ({
  projectRoot,
  tree,
  lastChangedFile
}) => {
  const [tabs, setTabs] = useState<CodeTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Map<string, string>>(new Map());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(["__root__", "src"]));
  const projectRootRef = useRef(projectRoot);

  // Limpa todo o estado do explorador e abas ao trocar ou fechar projeto
  useEffect(() => {
    if (projectRootRef.current !== projectRoot) {
      projectRootRef.current = projectRoot;
      setTabs([]);
      setActiveTabPath(null);
      setFileContents(new Map());
      setExpandedFolders(new Set(["__root__", "src"]));
    }
  }, [projectRoot]);

  // Carrega conteúdo de arquivo do projeto via IPC
  const loadFileContent = useCallback(async (filePath: string) => {
    try {
      const res = await window.neko.readFile(filePath);
      if (res && typeof res.content === "string") {
        setFileContents((prev) => {
          const next = new Map(prev);
          next.set(filePath, res.content);
          return next;
        });
      }
    } catch (err) {
      console.warn("[Neko/Code] Falha ao ler arquivo:", filePath, err);
    }
  }, []);

  // Abre ou ativa um arquivo no editor
  const handleSelectFile = useCallback((filePath: string, fileName: string) => {
    setTabs((prevTabs) => {
      const existing = prevTabs.find((t) => t.path === filePath);
      if (existing) {
        return prevTabs;
      }
      return [...prevTabs, { path: filePath, name: fileName }];
    });

    setActiveTabPath(filePath);

    // Carrega o conteúdo se ainda não estiver em cache
    setFileContents((currentMap) => {
      if (!currentMap.has(filePath)) {
        void loadFileContent(filePath);
      }
      return currentMap;
    });
  }, [loadFileContent]);

  // Fecha uma aba com seleção inteligente da aba anterior ou próxima
  const handleCloseTab = useCallback((filePathToClose: string) => {
    setTabs((prevTabs) => {
      const index = prevTabs.findIndex((t) => t.path === filePathToClose);
      if (index === -1) return prevTabs;

      const nextTabs = prevTabs.filter((t) => t.path !== filePathToClose);

      // Se a aba fechada for a ativa, seleciona a anterior ou próxima
      setActiveTabPath((currentActive) => {
        if (currentActive !== filePathToClose) {
          return currentActive;
        }
        if (nextTabs.length === 0) {
          return null;
        }
        // Prefere a aba anterior se existir, senão a próxima (que agora está na posição index)
        const newIndex = index > 0 ? index - 1 : 0;
        const targetTab = nextTabs[newIndex];
        if (targetTab) {
          // Garante carregamento do conteúdo se necessário
          void loadFileContent(targetTab.path);
          return targetTab.path;
        }
        return null;
      });

      return nextTabs;
    });
  }, [loadFileContent]);

  // Alterna expansão de uma pasta individual
  const handleToggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  // Recolhe todas as pastas abertas de uma só vez (mantém raiz visível)
  const handleCollapseAll = useCallback(() => {
    setExpandedFolders(new Set(["__root__"]));
  }, []);

  // Sincroniza com alterações externas do watcher
  useEffect(() => {
    if (!lastChangedFile) return;

    // Se o arquivo modificado estiver aberto em qualquer aba, recarrega o conteúdo
    const isFileOpen = tabs.some((t) => t.path === lastChangedFile);
    if (isFileOpen) {
      void loadFileContent(lastChangedFile);
    }
  }, [lastChangedFile, tabs, loadFileContent]);

  const activeContent = activeTabPath ? fileContents.get(activeTabPath) ?? null : null;

  return (
    <div className="code-workspace">
      <FileExplorer
        projectRoot={projectRoot}
        tree={tree}
        activeFilePath={activeTabPath}
        expandedFolders={expandedFolders}
        onToggleFolder={handleToggleFolder}
        onCollapseAll={handleCollapseAll}
        onSelectFile={handleSelectFile}
      />

      <section className="code-main-panel">
        <CodeTabs
          tabs={tabs}
          activeTabPath={activeTabPath}
          onSelectTab={(path) => {
            setActiveTabPath(path);
            if (!fileContents.has(path)) {
              void loadFileContent(path);
            }
          }}
          onCloseTab={handleCloseTab}
        />

        <div className="code-viewer-wrapper">
          <CodeViewer
            filePath={activeTabPath}
            content={activeContent}
          />
        </div>
      </section>
    </div>
  );
};

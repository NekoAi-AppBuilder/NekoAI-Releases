import React from "react";
import { FileText, Plus, X } from "lucide-react";
import type { WorkspaceTabsSnapshot } from "../../shared/workspace-tabs";

interface ProjectTabsProps {
  projectOpen: boolean;
  snapshot: WorkspaceTabsSnapshot | null;
  fallbackLabel: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
}

/** Project navigation belongs to the workspace above Preview, never to Home. */
export function ProjectTabs({ projectOpen, snapshot, fallbackLabel, onSelect, onClose, onOpen }: ProjectTabsProps) {
  if (!projectOpen) return null;
  const tabs = snapshot?.tabs.filter(tab => tab.projectPath !== null) ?? [];
  return (
    <div className="preview-tabs-strip">
      <div className="preview-project-tabs" role="tablist" aria-label="Projetos abertos">
        {tabs.length ? tabs.map(tab => (
          <div key={tab.id} className={`preview-project-tab${snapshot?.selected === tab.id ? " active" : ""}`}>
            <button type="button" role="tab" aria-selected={snapshot?.selected === tab.id}
              className="preview-project-tab-select" title={tab.projectPath || tab.label}
              disabled={tab.closing} onClick={() => onSelect(tab.id)}>
              {tab.busy ? <span className="preview-project-tab-busy" aria-label="Tarefa em andamento" /> : <FileText size={12} aria-hidden="true" />}
              <span className="preview-single-tab-title">{tab.label}</span>
            </button>
            <button type="button" className="preview-project-tab-close" aria-label={`Fechar ${tab.label}`}
              disabled={tab.closing} onClick={() => onClose(tab.id)}><X size={11} aria-hidden="true" /></button>
          </div>
        )) : <div className="preview-single-tab"><FileText size={12} aria-hidden="true" /><span className="preview-single-tab-title">{fallbackLabel}</span></div>}
      </div>
      <button type="button" className="preview-project-tab-add" title="Abrir projeto existente"
        aria-label="Abrir projeto existente" onClick={onOpen}><Plus size={14} aria-hidden="true" /></button>
    </div>
  );
}

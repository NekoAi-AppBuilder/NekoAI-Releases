export interface WorkspaceTabSummary {
  id: string;
  label: string;
  busy: boolean;
  closing: boolean;
  projectPath: string | null;
}
export interface WorkspaceTabsSnapshot {
  selected: string | null;
  tabs: WorkspaceTabSummary[];
}

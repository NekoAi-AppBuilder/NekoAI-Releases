export type ChatCommand = {
  id: string;
  command: string;
  name: string;
  description: string;
  iconName: "Settings2" | "Wrench" | "HelpCircle" | "RefreshCw" | "Bug" | "GitBranch";
};

export type ChatContext = {
  id: string;
  context: string;
  name: string;
  description: string;
  iconName: "Folder" | "Eye" | "FileText" | "FolderOpen" | "Cpu" | "Layers" | "GitBranch" | "AlertTriangle" | "List" | "SquareTerminal";
  isPicker?: boolean;
  pickerType?: "file" | "folder";
};

export type AutocompleteMode = "commands" | "contexts" | "files" | "folders";

export type TriggerMatch = {
  mode: AutocompleteMode;
  query: string;
  triggerIndex: number;
  cursorIndex: number;
};

export type ProjectItem = {
  name: string;
  path: string;
  type: "file" | "directory";
};

export type AutocompleteSelection = {
  type: "command" | "context" | "file" | "folder";
  value: string;
  item?: ChatCommand | ChatContext | ProjectItem;
};

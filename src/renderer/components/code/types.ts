export type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
};

export type CodeTab = {
  path: string;
  name: string;
};

export type CodeToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

export type CodeLineTokens = CodeToken[];

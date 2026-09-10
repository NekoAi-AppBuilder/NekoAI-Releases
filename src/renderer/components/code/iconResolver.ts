import React from "react";
import {
  File,
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  FileTerminal,
  FileSpreadsheet,
  FileArchive,
  FileKey,
  FileLock,
  FileType2,
  FileBadge,
  FileCog,
  Database,
  Package,
  Container,
  GitBranch,
  Zap,
  Flame,
  Atom,
  Coffee,
  Gem,
  Palette,
  Folder,
  FolderOpen,
  FolderGit2,
  FolderCode,
  FolderArchive,
  FolderCog,
  FolderCheck,
  FolderKanban
} from "lucide-react";

export type IconComponent = React.ComponentType<{
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}>;

export interface FileIconDef {
  icon: IconComponent;
  color: string;
  className: string;
  id: string;
}

export interface FolderIconDef {
  icon: IconComponent;
  color: string;
  className: string;
  id: string;
}

/**
 * Ícone SVG nativo para Vue no mesmo padrão visual e de stroke do Lucide.
 */
export const VueIcon: React.FC<{
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}> = ({ size = 14, className = "", style }) =>
  React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className,
      style
    },
    React.createElement("path", { d: "M2 3h4.5L12 13.5 17.5 3H22L12 21 2 3z" }),
    React.createElement("path", { d: "M6.5 3L12 12.5 17.5 3" })
  );

// --- 1. NOMES ESPECIAIS (Correspondência exata em minúsculas) ---
const SPECIAL_FILES: Record<string, Omit<FileIconDef, "className"> & { className?: string }> = {
  // NPM / Node
  "package.json": { icon: Package, color: "#ef4444", id: "package" },
  "package-lock.json": { icon: FileLock, color: "#f59e0b", id: "lock" },
  "pnpm-lock.yaml": { icon: FileLock, color: "#f59e0b", id: "lock" },
  "pnpm-workspace.yaml": { icon: FileCog, color: "#f59e0b", id: "config" },
  "yarn.lock": { icon: FileLock, color: "#3b82f6", id: "lock" },
  "bun.lock": { icon: FileLock, color: "#f59e0b", id: "lock" },
  "bun.lockb": { icon: FileLock, color: "#f59e0b", id: "lock" },

  // TypeScript / JavaScript Config
  "tsconfig.json": { icon: FileCode2, color: "#3b82f6", id: "ts-config" },
  "jsconfig.json": { icon: FileCode2, color: "#fde047", id: "js-config" },

  // Docker
  "dockerfile": { icon: Container, color: "#0284c7", id: "docker" },
  "docker-compose.yml": { icon: Container, color: "#0284c7", id: "docker" },
  "docker-compose.yaml": { icon: Container, color: "#0284c7", id: "docker" },

  // Git
  ".gitignore": { icon: GitBranch, color: "#f97316", id: "git" },
  ".gitattributes": { icon: GitBranch, color: "#f97316", id: "git" },
  ".gitmodules": { icon: GitBranch, color: "#f97316", id: "git" },

  // Configurações Gerais
  ".editorconfig": { icon: FileCog, color: "#94a3b8", id: "config" },
  ".env": { icon: FileKey, color: "#eab308", id: "env" },

  // Documentação Especial
  "readme": { icon: FileText, color: "#60a5fa", id: "readme" },
  "readme.md": { icon: FileText, color: "#60a5fa", id: "readme" },
  "readme.txt": { icon: FileText, color: "#60a5fa", id: "readme" },
  "license": { icon: FileBadge, color: "#facc15", id: "license" },
  "license.md": { icon: FileBadge, color: "#facc15", id: "license" },
  "license.txt": { icon: FileBadge, color: "#facc15", id: "license" },
  "changelog": { icon: FileText, color: "#34d399", id: "changelog" },
  "changelog.md": { icon: FileText, color: "#34d399", id: "changelog" },
  "changelog.txt": { icon: FileText, color: "#34d399", id: "changelog" }
};

// --- 2. PADRÕES ESPECIAIS (Prefixos, sufixos e expressões regulares) ---
interface SpecialPattern {
  test: (name: string) => boolean;
  def: Omit<FileIconDef, "className"> & { className?: string };
}

const SPECIAL_PATTERNS: SpecialPattern[] = [
  // TypeScript Config variants (tsconfig.app.json, tsconfig.node.json)
  {
    test: (n) => n.startsWith("tsconfig.") && n.endsWith(".json"),
    def: { icon: FileCode2, color: "#3b82f6", id: "ts-config" }
  },
  // Vite Config
  {
    test: (n) => n.startsWith("vite.config."),
    def: { icon: Zap, color: "#a855f7", id: "vite" }
  },
  // Next Config
  {
    test: (n) => n.startsWith("next.config."),
    def: { icon: FileCog, color: "#e2e8f0", id: "next" }
  },
  // Nuxt Config
  {
    test: (n) => n.startsWith("nuxt.config."),
    def: { icon: FileCog, color: "#10b981", id: "nuxt" }
  },
  // Astro Config
  {
    test: (n) => n.startsWith("astro.config."),
    def: { icon: Flame, color: "#ff5d01", id: "astro" }
  },
  // Tailwind Config
  {
    test: (n) => n.startsWith("tailwind.config."),
    def: { icon: Palette, color: "#38bdf8", id: "tailwind" }
  },
  // Webpack Config
  {
    test: (n) => n.startsWith("webpack.config."),
    def: { icon: FileCog, color: "#3b82f6", id: "webpack" }
  },
  // Rollup Config
  {
    test: (n) => n.startsWith("rollup.config."),
    def: { icon: FileCog, color: "#ef4444", id: "rollup" }
  },
  // Babel Config
  {
    test: (n) => n.startsWith("babel.config.") || n.startsWith(".babelrc"),
    def: { icon: FileCog, color: "#facc15", id: "babel" }
  },
  // ESLint Config
  {
    test: (n) => n.startsWith("eslint.config.") || n.startsWith(".eslintrc"),
    def: { icon: FileCog, color: "#818cf8", id: "eslint" }
  },
  // Prettier Config
  {
    test: (n) => n.startsWith("prettier.config.") || n.startsWith(".prettierrc"),
    def: { icon: FileCog, color: "#f472b6", id: "prettier" }
  },
  // Docker Compose variants
  {
    test: (n) => n.startsWith("docker-compose."),
    def: { icon: Container, color: "#0284c7", id: "docker" }
  },
  // Env variants (.env.local, .env.development, .env.production, etc.)
  {
    test: (n) => n.startsWith(".env.") || n === ".env",
    def: { icon: FileKey, color: "#eab308", id: "env" }
  },
  // Readme variants
  {
    test: (n) => n.startsWith("readme."),
    def: { icon: FileText, color: "#60a5fa", id: "readme" }
  },
  // License variants
  {
    test: (n) => n.startsWith("license."),
    def: { icon: FileBadge, color: "#facc15", id: "license" }
  },
  // Changelog variants
  {
    test: (n) => n.startsWith("changelog."),
    def: { icon: FileText, color: "#34d399", id: "changelog" }
  }
];

// --- 3. EXTENSÕES (Correspondência direta) ---
const EXTENSIONS: Record<string, Omit<FileIconDef, "className"> & { className?: string }> = {
  // Web Standard
  html: { icon: FileCode2, color: "#fb923c", id: "html" },
  htm: { icon: FileCode2, color: "#fb923c", id: "html" },
  css: { icon: FileCode2, color: "#38bdf8", id: "css" },
  scss: { icon: FileCode2, color: "#ec4899", id: "scss" },
  sass: { icon: FileCode2, color: "#ec4899", id: "sass" },
  less: { icon: FileCode2, color: "#60a5fa", id: "less" },
  js: { icon: FileCode2, color: "#fde047", id: "js" },
  mjs: { icon: FileCode2, color: "#fde047", id: "js" },
  cjs: { icon: FileCode2, color: "#fde047", id: "js" },
  ts: { icon: FileCode2, color: "#60a5fa", id: "ts" },
  mts: { icon: FileCode2, color: "#60a5fa", id: "ts" },
  cts: { icon: FileCode2, color: "#60a5fa", id: "ts" },

  // Frameworks
  jsx: { icon: Atom, color: "#38bdf8", id: "react" },
  tsx: { icon: Atom, color: "#38bdf8", id: "react" },
  vue: { icon: VueIcon, color: "#42b883", id: "vue" },
  svelte: { icon: Flame, color: "#ff3e00", id: "svelte" },
  astro: { icon: Flame, color: "#ff5d01", id: "astro" },

  // Backend / Linguagens
  py: { icon: FileCode2, color: "#4ade80", id: "py" },
  php: { icon: FileCode2, color: "#818cf8", id: "php" },
  java: { icon: Coffee, color: "#fb923c", id: "java" },
  kt: { icon: FileCode2, color: "#c084fc", id: "kt" },
  kts: { icon: FileCode2, color: "#c084fc", id: "kt" },
  go: { icon: FileCode2, color: "#00add8", id: "go" },
  rs: { icon: FileCode2, color: "#ea580c", id: "rust" },
  cs: { icon: FileCode2, color: "#a855f7", id: "cs" },
  c: { icon: FileCode2, color: "#3b82f6", id: "c" },
  cpp: { icon: FileCode2, color: "#3b82f6", id: "cpp" },
  cc: { icon: FileCode2, color: "#3b82f6", id: "cpp" },
  cxx: { icon: FileCode2, color: "#3b82f6", id: "cpp" },
  h: { icon: FileCode2, color: "#60a5fa", id: "c" },
  hpp: { icon: FileCode2, color: "#60a5fa", id: "cpp" },
  hxx: { icon: FileCode2, color: "#60a5fa", id: "cpp" },
  rb: { icon: Gem, color: "#f43f5e", id: "ruby" },
  sql: { icon: Database, color: "#a78bfa", id: "sql" },

  // Dados / Configuração
  json: { icon: FileJson, color: "#f59e0b", id: "json" },
  jsonc: { icon: FileJson, color: "#f59e0b", id: "json" },
  yaml: { icon: FileCode2, color: "#f472b6", id: "yaml" },
  yml: { icon: FileCode2, color: "#f472b6", id: "yaml" },
  xml: { icon: FileCode2, color: "#fb7185", id: "xml" },
  csv: { icon: FileSpreadsheet, color: "#10b981", id: "csv" },
  tsv: { icon: FileSpreadsheet, color: "#10b981", id: "csv" },
  toml: { icon: FileCog, color: "#9ca3af", id: "toml" },
  ini: { icon: FileCog, color: "#9ca3af", id: "ini" },

  // Documentação
  md: { icon: FileText, color: "#93c5fd", id: "md" },
  mdx: { icon: FileText, color: "#93c5fd", id: "mdx" },
  txt: { icon: FileText, color: "#9ca3af", id: "txt" },
  pdf: { icon: FileText, color: "#ef4444", id: "pdf" },

  // Shell
  sh: { icon: FileTerminal, color: "#34d399", id: "sh" },
  bash: { icon: FileTerminal, color: "#34d399", id: "sh" },
  zsh: { icon: FileTerminal, color: "#34d399", id: "sh" },
  ps1: { icon: FileTerminal, color: "#38bdf8", id: "terminal" },
  cmd: { icon: FileTerminal, color: "#38bdf8", id: "terminal" },
  bat: { icon: FileTerminal, color: "#38bdf8", id: "terminal" },

  // Mídia / Assets
  svg: { icon: FileImage, color: "#c084fc", id: "img" },
  png: { icon: FileImage, color: "#c084fc", id: "img" },
  jpg: { icon: FileImage, color: "#c084fc", id: "img" },
  jpeg: { icon: FileImage, color: "#c084fc", id: "img" },
  gif: { icon: FileImage, color: "#c084fc", id: "img" },
  ico: { icon: FileImage, color: "#c084fc", id: "img" },
  webp: { icon: FileImage, color: "#c084fc", id: "img" },
  bmp: { icon: FileImage, color: "#c084fc", id: "img" },
  mp3: { icon: FileCode2, color: "#06b6d4", id: "audio" },
  wav: { icon: FileCode2, color: "#06b6d4", id: "audio" },
  mp4: { icon: FileCode2, color: "#f43f5e", id: "video" },
  webm: { icon: FileCode2, color: "#f43f5e", id: "video" },

  // Compactados
  zip: { icon: FileArchive, color: "#f59e0b", id: "archive" },
  tar: { icon: FileArchive, color: "#f59e0b", id: "archive" },
  gz: { icon: FileArchive, color: "#f59e0b", id: "archive" },
  rar: { icon: FileArchive, color: "#f59e0b", id: "archive" },
  "7z": { icon: FileArchive, color: "#f59e0b", id: "archive" },

  // Fontes
  woff: { icon: FileType2, color: "#a78bfa", id: "font" },
  woff2: { icon: FileType2, color: "#a78bfa", id: "font" },
  ttf: { icon: FileType2, color: "#a78bfa", id: "font" },
  otf: { icon: FileType2, color: "#a78bfa", id: "font" },
  eot: { icon: FileType2, color: "#a78bfa", id: "font" }
};

// Fallback genérico para arquivos desconhecidos
const FALLBACK_FILE: FileIconDef = {
  icon: File,
  color: "#a89eb4",
  className: "file-icon-default",
  id: "file-default"
};

/**
 * Resolve o ícone de arquivo com base na ordem de prioridade estrita:
 * 1. Nome especial exato
 * 2. Padrão especial
 * 3. Extensão
 * 4. Fallback genérico
 */
export function resolveFileIconDef(fileName: string): FileIconDef {
  const cleanName = (fileName || "").trim().toLowerCase();
  if (!cleanName) return FALLBACK_FILE;

  // 1. Nome Especial
  const specialMatch = SPECIAL_FILES[cleanName];
  if (specialMatch) {
    return {
      icon: specialMatch.icon,
      color: specialMatch.color,
      className: `file-icon-${specialMatch.id}`,
      id: specialMatch.id
    };
  }

  // 2. Padrão Especial
  for (const pattern of SPECIAL_PATTERNS) {
    if (pattern.test(cleanName)) {
      return {
        icon: pattern.def.icon,
        color: pattern.def.color,
        className: `file-icon-${pattern.def.id}`,
        id: pattern.def.id
      };
    }
  }

  // 3. Extensão
  if (cleanName.includes(".")) {
    const ext = cleanName.split(".").pop() || "";
    const extMatch = EXTENSIONS[ext];
    if (extMatch) {
      return {
        icon: extMatch.icon,
        color: extMatch.color,
        className: `file-icon-${extMatch.id}`,
        id: extMatch.id
      };
    }
  }

  // 4. Fallback
  return FALLBACK_FILE;
}

// --- CONFIGURAÇÃO DE PASTAS ESPECIAIS ---
interface FolderRule {
  closedIcon: IconComponent;
  openIcon: IconComponent;
  closedColor: string;
  openColor: string;
  id: string;
}

const SPECIAL_FOLDERS: Record<string, FolderRule> = {
  // Código fonte / lib
  src: { closedIcon: FolderCode, openIcon: FolderOpen, closedColor: "#a855f7", openColor: "#c084fc", id: "src" },
  source: { closedIcon: FolderCode, openIcon: FolderOpen, closedColor: "#a855f7", openColor: "#c084fc", id: "src" },
  lib: { closedIcon: FolderCode, openIcon: FolderOpen, closedColor: "#a855f7", openColor: "#c084fc", id: "lib" },

  // Componentes e UI
  components: { closedIcon: FolderKanban, openIcon: FolderOpen, closedColor: "#38bdf8", openColor: "#38bdf8", id: "components" },
  pages: { closedIcon: FolderKanban, openIcon: FolderOpen, closedColor: "#f59e0b", openColor: "#f59e0b", id: "pages" },
  routes: { closedIcon: FolderKanban, openIcon: FolderOpen, closedColor: "#f59e0b", openColor: "#f59e0b", id: "routes" },
  views: { closedIcon: FolderKanban, openIcon: FolderOpen, closedColor: "#f59e0b", openColor: "#f59e0b", id: "views" },

  // Utilitários / Lógica
  hooks: { closedIcon: FolderCog, openIcon: FolderOpen, closedColor: "#fbbf24", openColor: "#fbbf24", id: "hooks" },
  utils: { closedIcon: FolderCog, openIcon: FolderOpen, closedColor: "#fbbf24", openColor: "#fbbf24", id: "utils" },
  services: { closedIcon: FolderCog, openIcon: FolderOpen, closedColor: "#fbbf24", openColor: "#fbbf24", id: "services" },
  api: { closedIcon: FolderCog, openIcon: FolderOpen, closedColor: "#fbbf24", openColor: "#fbbf24", id: "api" },
  config: { closedIcon: FolderCog, openIcon: FolderOpen, closedColor: "#818cf8", openColor: "#818cf8", id: "config" },
  styles: { closedIcon: FolderCog, openIcon: FolderOpen, closedColor: "#818cf8", openColor: "#818cf8", id: "styles" },
  css: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "css" },
  js: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "js" },

  // Assets e Públicos
  assets: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "assets" },
  public: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "public" },
  static: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "static" },
  images: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "images" },
  icons: { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "icons" },

  // Testes
  test: { closedIcon: FolderCheck, openIcon: FolderOpen, closedColor: "#10b981", openColor: "#10b981", id: "tests" },
  tests: { closedIcon: FolderCheck, openIcon: FolderOpen, closedColor: "#10b981", openColor: "#10b981", id: "tests" },
  __tests__: { closedIcon: FolderCheck, openIcon: FolderOpen, closedColor: "#10b981", openColor: "#10b981", id: "tests" },

  // Dependências e Builds
  node_modules: { closedIcon: FolderArchive, openIcon: FolderOpen, closedColor: "#6b7280", openColor: "#6b7280", id: "node_modules" },
  dist: { closedIcon: FolderArchive, openIcon: FolderOpen, closedColor: "#9ca3af", openColor: "#9ca3af", id: "dist" },
  build: { closedIcon: FolderArchive, openIcon: FolderOpen, closedColor: "#9ca3af", openColor: "#9ca3af", id: "build" },
  coverage: { closedIcon: FolderArchive, openIcon: FolderOpen, closedColor: "#9ca3af", openColor: "#9ca3af", id: "coverage" },

  // Controle de versão e IDE
  ".github": { closedIcon: FolderGit2, openIcon: FolderOpen, closedColor: "#f97316", openColor: "#f97316", id: "git" },
  ".git": { closedIcon: FolderGit2, openIcon: FolderOpen, closedColor: "#f97316", openColor: "#f97316", id: "git" },
  ".vscode": { closedIcon: FolderCode, openIcon: FolderOpen, closedColor: "#3b82f6", openColor: "#3b82f6", id: "vscode" },
  ".neko": { closedIcon: Folder, openIcon: FolderOpen, closedColor: "#c084fc", openColor: "#d8b4fe", id: "neko" }
};

/**
 * Resolve o ícone de pasta preservando o estado aberta/fechada e
 * aplicando identificação visual para pastas conhecidas.
 */
export function resolveFolderIconDef(
  folderName: string,
  isOpen: boolean,
  isRoot: boolean = false
): FolderIconDef {
  // Pasta Raiz do Projeto tem visual destacado próprio
  if (isRoot) {
    return {
      icon: isOpen ? FolderOpen : Folder,
      color: isOpen ? "#a855f7" : "#9333ea",
      className: "tree-folder-root",
      id: "root"
    };
  }

  const cleanName = (folderName || "").trim().toLowerCase();
  const match = SPECIAL_FOLDERS[cleanName];

  if (match) {
    return {
      icon: isOpen ? match.openIcon : match.closedIcon,
      color: isOpen ? match.openColor : match.closedColor,
      className: `tree-folder-${match.id}`,
      id: match.id
    };
  }

  // Fallback para pasta genérica (preserva exatamente a cor e comportamento atuais)
  return {
    icon: isOpen ? FolderOpen : Folder,
    color: isOpen ? "#d8b4fe" : "#c084fc",
    className: "tree-folder-default",
    id: "default"
  };
}

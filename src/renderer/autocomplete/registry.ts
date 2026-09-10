import type { ChatCommand, ChatContext } from "./types.ts";

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    id: "analyze",
    command: "/analyze",
    name: "Analisar",
    description: "Analisa o código ou projeto sem fazer alterações.",
    iconName: "Settings2"
  },
  {
    id: "fix",
    command: "/fix",
    name: "Corrigir",
    description: "Identifica um problema e aplica uma correção.",
    iconName: "Wrench"
  },
  {
    id: "explain",
    command: "/explain",
    name: "Explicar",
    description: "Explica código, arquivos ou partes do projeto.",
    iconName: "HelpCircle"
  },
  {
    id: "refactor",
    command: "/refactor",
    name: "Refatorar",
    description: "Melhora a estrutura do código sem alterar seu comportamento.",
    iconName: "RefreshCw"
  },
  {
    id: "debug",
    command: "/debug",
    name: "Depurar",
    description: "Investiga erros e procura a causa do problema.",
    iconName: "Bug"
  },
  {
    id: "git",
    command: "/git",
    name: "Git",
    description: "Analisa o estado, alterações e histórico do Git.",
    iconName: "GitBranch"
  }
];

export const CHAT_CONTEXTS: ChatContext[] = [
  {
    id: "project",
    context: "@project",
    name: "Projeto",
    description: "Usa o projeto atual como contexto.",
    iconName: "Folder"
  },
  {
    id: "preview",
    context: "@preview",
    name: "Preview",
    description: "Usa o Preview atual como contexto.",
    iconName: "Eye"
  },
  {
    id: "file",
    context: "@file",
    name: "Arquivo",
    description: "Adiciona um arquivo específico ao contexto.",
    iconName: "FileText",
    isPicker: true,
    pickerType: "file"
  },
  {
    id: "folder",
    context: "@folder",
    name: "Pasta",
    description: "Adiciona uma pasta específica ao contexto.",
    iconName: "FolderOpen",
    isPicker: true,
    pickerType: "folder"
  },
  {
    id: "runtime",
    context: "@runtime",
    name: "Runtime",
    description: "Considera o ambiente e runtime atual do projeto.",
    iconName: "Cpu"
  },
  {
    id: "architecture",
    context: "@architecture",
    name: "Arquitetura",
    description: "Considera a arquitetura do projeto.",
    iconName: "Layers"
  },
  {
    id: "git",
    context: "@git",
    name: "Git",
    description: "Considera informações do repositório Git.",
    iconName: "GitBranch"
  },
  {
    id: "errors",
    context: "@errors",
    name: "Erros",
    description: "Usa erros e mensagens de erro como contexto.",
    iconName: "AlertTriangle"
  },
  {
    id: "logs",
    context: "@logs",
    name: "Logs",
    description: "Usa logs relevantes da aplicação.",
    iconName: "List"
  },
  {
    id: "terminal",
    context: "@terminal",
    name: "Terminal",
    description: "Usa informações do terminal e comandos executados.",
    iconName: "SquareTerminal"
  }
];

export function filterCommands(query: string): ChatCommand[] {
  const clean = query.trim().toLowerCase();
  const normalized = clean.startsWith("/") ? clean.slice(1) : clean;
  if (!normalized) return [...CHAT_COMMANDS];

  return CHAT_COMMANDS.filter(cmd => {
    const cmdNormalized = cmd.command.slice(1).toLowerCase();
    const nameNormalized = cmd.name.toLowerCase();
    return (
      cmdNormalized.includes(normalized) ||
      nameNormalized.includes(normalized)
    );
  });
}

export function filterContexts(query: string): ChatContext[] {
  const clean = query.trim().toLowerCase();
  const normalized = clean.startsWith("@") ? clean.slice(1) : clean;
  if (!normalized) return [...CHAT_CONTEXTS];

  return CHAT_CONTEXTS.filter(ctx => {
    const ctxNormalized = ctx.context.slice(1).toLowerCase();
    const nameNormalized = ctx.name.toLowerCase();
    return (
      ctxNormalized.includes(normalized) ||
      nameNormalized.includes(normalized)
    );
  });
}

export function getCommand(text: string): ChatCommand | undefined {
  const clean = text.trim().toLowerCase();
  const withSlash = clean.startsWith("/") ? clean : `/${clean}`;
  return CHAT_COMMANDS.find(c => c.command.toLowerCase() === withSlash || c.id === clean);
}

export function getContext(text: string): ChatContext | undefined {
  const clean = text.trim().toLowerCase();
  const withAt = clean.startsWith("@") ? clean : `@${clean}`;
  return CHAT_CONTEXTS.find(c => c.context.toLowerCase() === withAt || c.id === clean);
}

import type { ChatCommand } from "./types.ts";
import { getCommand, CHAT_CONTEXTS } from "./registry.ts";

export type ResolverContextState = {
  projectRoot?: string | null;
  projectName?: string | null;
  previewUrl?: string | null;
  previewStatus?: string | null;
  previewFramework?: string | null;
  previewMessage?: string | null;
  tree?: Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }>;
  gitStatus?: {
    initialized?: boolean;
    branch?: string | null;
    remote?: string | null;
    dirty?: boolean;
    changedFiles?: Array<{ path: string; status: string }>;
    summary?: { modified: number; untracked: number; deleted: number; staged: number; total: number };
  } | null;
  terminalLines?: Array<{ id?: string; kind: string; text: string; source?: string }>;
  consoleEntries?: Array<{ id?: string; level: string; message: string; source?: string; url?: string; ts?: number }>;
};

export type ResolvedChatMessage = {
  userDisplayText: string;
  command: ChatCommand | null;
  commandInstruction?: string;
  filePaths: string[];
  semanticContexts: string[];
  resolvedContextPrompt?: string;
  agentPromptText: string;
};

const SEMANTIC_CONTEXT_IDS = new Set([
  "project",
  "preview",
  "runtime",
  "architecture",
  "git",
  "errors",
  "logs",
  "terminal",
  // 'file' e 'folder' são disparadores de seleção, mas se sobrarem no texto sem caminho, são tratados graciosamente
  "file",
  "folder"
]);

/**
 * Resolve os comandos '/' e os contextos '@' presentes na mensagem do usuário.
 */
export function resolveChatMessage(rawText: string, state: ResolverContextState): ResolvedChatMessage {
  const text = rawText.trim();
  const filePaths: string[] = [];
  const semanticContexts: string[] = [];

  // 1. Extração de comando '/'
  // Procura por /analyze, /fix, /explain, /refactor, /debug, /git
  let command: ChatCommand | null = null;
  const commandMatch = text.match(/(?:^|\s)\/([a-zA-Z0-9_-]+)/);
  if (commandMatch) {
    const candidate = getCommand(commandMatch[1]);
    if (candidate) {
      command = candidate;
    }
  }

  // 2. Extração de contextos '@'
  const contextRegex = /(?:^|\s)@([^\s@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = contextRegex.exec(text)) !== null) {
    const token = match[1];
    const lowerToken = token.toLowerCase();

    if (SEMANTIC_CONTEXT_IDS.has(lowerToken)) {
      if (!semanticContexts.includes(lowerToken)) {
        semanticContexts.push(lowerToken);
      }
    } else {
      // Caminho de arquivo ou pasta do projeto (ex: src/App.tsx ou src/components)
      if (!filePaths.includes(token)) {
        filePaths.push(token);
      }
    }
  }

  // 3. Montagem da instrução de ação para o comando
  let commandInstruction: string | undefined;
  if (command) {
    switch (command.id) {
      case "analyze":
        commandInstruction = "[AÇÃO DO AGENTE: ANALISAR]\nAnalise o código ou projeto detalhadamente sem fazer alterações em arquivos.";
        break;
      case "fix":
        commandInstruction = "[AÇÃO DO AGENTE: CORRIGIR]\nIdentifique o problema e aplique uma correção direta e funcional nos arquivos necessários.";
        break;
      case "explain":
        commandInstruction = "[AÇÃO DO AGENTE: EXPLICAR]\nExplique o funcionamento, código ou arquitetura do projeto de forma clara e didática.";
        break;
      case "refactor":
        commandInstruction = "[AÇÃO DO AGENTE: REFATORAR]\nMelhore a estrutura, legibilidade e qualidade do código sem alterar seu comportamento externo.";
        break;
      case "debug":
        commandInstruction = "[AÇÃO DO AGENTE: DEPURAR]\nInvestigue os erros, logs e mensagens de falha para rastrear a causa raiz do problema.";
        break;
      case "git":
        commandInstruction = "[AÇÃO DO AGENTE: GIT]\nAnalise o estado do repositório Git, histórico, alterações e branch atual.";
        break;
    }
  }

  // 4. Resolução dos contextos semânticos reais
  const contextBlocks: string[] = [];

  for (const ctx of semanticContexts) {
    switch (ctx) {
      case "project": {
        const pName = state.projectName || (state.projectRoot ? state.projectRoot.split(/[/\\]/).pop() : "Projeto NekoAI");
        contextBlocks.push(
          `[Contexto do Projeto]\nNome: ${pName}\nCaminho: ${state.projectRoot || "Espaço de trabalho ativo"}`
        );
        break;
      }
      case "preview": {
        // Se houver preview disponível
        if (state.previewUrl && state.previewStatus === "ready") {
          contextBlocks.push(
            `[Contexto do Preview]\nStatus: Pronto (ready)\nURL: ${state.previewUrl}\nFramework: ${state.previewFramework || "Detectado automaticamente"}`
          );
        } else {
          // Se o preview não estiver pronto, fornece indicação clara sem quebrar o chat
          contextBlocks.push(
            `[Contexto do Preview]\nStatus: Indisponível no momento (${state.previewStatus || "não iniciado"})\nURL: nenhuma\nMensagem: ${state.previewMessage || "Servidor de preview ainda não está ativo ou apresentou falha."}`
          );
        }
        break;
      }
      case "runtime": {
        contextBlocks.push(
          `[Contexto do Runtime]\nAmbiente: ${process.platform === "win32" ? "Windows" : "Unix"}\nFramework: ${state.previewFramework || "Node.js / Web"}\nStatus do servidor: ${state.previewStatus || "desconhecido"}`
        );
        break;
      }
      case "architecture": {
        let archDetails = "Estrutura do projeto não disponível.";
        if (state.tree && state.tree.length > 0) {
          const topLevel = state.tree.map(n => `${n.type === "directory" ? "[dir]" : "[file]"} ${n.name}`).join(", ");
          archDetails = `Itens raiz: ${topLevel}`;
        }
        contextBlocks.push(`[Contexto da Arquitetura]\n${archDetails}`);
        break;
      }
      case "git": {
        if (state.gitStatus && state.gitStatus.initialized) {
          const changed = state.gitStatus.changedFiles || [];
          const filesSummary = changed.length > 0
            ? changed.slice(0, 10).map(f => `${f.status} ${f.path}`).join(", ")
            : "Nenhum arquivo modificado";
          contextBlocks.push(
            `[Contexto do Git]\nBranch: ${state.gitStatus.branch || "main"}\nRemote: ${state.gitStatus.remote || "nenhum"}\nModificados: ${state.gitStatus.summary?.modified ?? 0}, Não rastreados: ${state.gitStatus.summary?.untracked ?? 0}\nAlterações recentes: ${filesSummary}`
          );
        } else {
          contextBlocks.push(`[Contexto do Git]\nRepositório Git não inicializado ou sem status disponível.`);
        }
        break;
      }
      case "errors": {
        const errConsole = (state.consoleEntries || [])
          .filter(e => e.level === "error")
          .slice(-5)
          .map(e => `[Console] ${e.message}`);
        const errTerminal = (state.terminalLines || [])
          .filter(t => t.kind === "error")
          .slice(-5)
          .map(t => `[Terminal] ${t.text}`);
        const allErrors = [...errConsole, ...errTerminal];
        if (allErrors.length > 0) {
          contextBlocks.push(`[Contexto de Erros Recentes]\n${allErrors.join("\n")}`);
        } else {
          contextBlocks.push(`[Contexto de Erros]\nNenhum erro recente registrado no console ou terminal.`);
        }
        break;
      }
      case "logs": {
        const logs = (state.terminalLines || [])
          .filter(t => t.kind === "log")
          .slice(-8)
          .map(t => `[${t.source || "Neko"}] ${t.text}`);
        if (logs.length > 0) {
          contextBlocks.push(`[Contexto de Logs Recentes]\n${logs.join("\n")}`);
        } else {
          contextBlocks.push(`[Contexto de Logs]\nNenhum log recente registrado.`);
        }
        break;
      }
      case "terminal": {
        const termLines = (state.terminalLines || [])
          .slice(-10)
          .map(t => `[${t.kind.toUpperCase()}] ${t.text}`);
        if (termLines.length > 0) {
          contextBlocks.push(`[Contexto do Terminal]\n${termLines.join("\n")}`);
        } else {
          contextBlocks.push(`[Contexto do Terminal]\nNenhuma atividade recente no terminal.`);
        }
        break;
      }
    }
  }

  const resolvedContextPrompt = contextBlocks.length > 0 ? contextBlocks.join("\n\n") : undefined;

  // 5. Montagem do prompt final enviado ao agente
  const parts: string[] = [];
  if (commandInstruction) {
    parts.push(commandInstruction);
  }
  parts.push(text);
  if (resolvedContextPrompt) {
    parts.push(`--- INFORMAÇÕES DE CONTEXTO SOLICITADAS PELO USUÁRIO ---\n${resolvedContextPrompt}`);
  }

  const agentPromptText = parts.join("\n\n");

  return {
    userDisplayText: text,
    command,
    commandInstruction,
    filePaths,
    semanticContexts,
    resolvedContextPrompt,
    agentPromptText
  };
}

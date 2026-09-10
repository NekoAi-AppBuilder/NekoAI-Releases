import React from "react";
import nekoLogo from "./assets/nekoai-logo.png";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronUp, ChevronRight, CircleAlert, Code2, Download,
  ExternalLink, Eye, FileCode2, Folder, FolderOpen, Globe2, Loader2, Maximize2,
  Menu, Monitor, MoreHorizontal, MoreVertical, PanelLeft, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, Send,
  Settings2, Smartphone, Sparkles, SquareTerminal, Tablet, X, Zap, Paperclip, Image as ImageIcon, FileText, AtSign, Square, ShieldAlert, Copy, Undo2, Pencil, ExternalLink as ExternalLinkIcon, Unplug, Unlink, Link2, GitBranch, AlertTriangle, FolderPlus, Lock, Star, LogOut, Home as HomeIcon, Trash2, CloudUpload, CheckCircle2, Play, Volume2,
  Key, ShieldCheck, Laptop, Calendar, BadgeCheck
} from "lucide-react";
import providerSprite from "./assets/opencode-provider-sprite.svg?raw";
import { getModelCapabilities } from "../shared/vision";
import { nextChatMode, chatModeLabel, CHAT_MODES, type ChatMode } from "../shared/chat-mode";
import { getNekoTutorials, type NekoTutorial } from "./tutorials";
import { notifyOnce, playNotify, soundEnabled, setSoundEnabled, unlockAudio } from "./sounds";
import { buildAgentCaptureContext, htmlToText } from "../main/site-capture";
import { CodeWorkspace } from "./components/code";
import {
  AutocompleteMenu,
  detectAutocompleteTrigger,
  applyAutocompleteSelection,
  filterCommands,
  filterContexts,
  resolveChatMessage,
  extractProjectItems,
  filterProjectItems,
  type AutocompleteMode,
  type TriggerMatch,
  type ChatCommand,
  type ChatContext,
  type ProjectItem,
  type ResolverContextState
} from "./autocomplete";

// Catálogo oficial do OpenCode. A lista é mantida pelo pacote @opencode-ai/ui.
// Quando o ID do provider não possui um ícone oficial, a Neko usa o Sparkles
// como fallback, sem fabricar uma marca que não existe no catálogo.
const OFFICIAL_PROVIDER_ICON_NAMES = new Set([
  "zhipuai", "zhipuai-coding-plan", "zenmux", "zai", "zai-coding-plan", "xiaomi", "xai", "wandb",
  "vultr", "vivgrid", "vercel", "venice", "v0", "upstage", "togetherai", "synthetic", "submodel",
  "stepfun", "stackit", "siliconflow", "siliconflow-cn", "scaleway", "sap-ai-core", "requesty",
  "qiniu-ai", "qihang-ai", "privatemode-ai", "poe", "perplexity", "ovhcloud", "openrouter", "llmgateway",
  "opencode", "opencode-go", "openai", "ollama-cloud", "nvidia", "novita-ai", "nova", "nebius", "nano-gpt",
  "morph", "moonshotai", "moonshotai-cn", "modelscope", "moark", "mistral", "minimax", "minimax-coding-plan",
  "minimax-cn", "minimax-cn-coding-plan", "meganova", "lucidquery", "lmstudio", "llama", "kuae-cloud-coding-plan",
  "kimi-for-coding", "kilo", "jiekou", "io-net", "inference", "inception", "iflowcn", "huggingface", "helicone",
  "groq", "google", "google-vertex", "google-vertex-anthropic", "gitlab", "github-models", "github-copilot", "friendli",
  "firmware", "fireworks-ai", "fastrouter", "evroc", "digitalocean", "deepseek", "deepinfra", "cortecs", "cohere",
  "cloudflare-workers-ai", "cloudflare-ai-gateway", "cloudferro-sherlock", "chutes", "cerebras", "berget", "baseten",
  "bailing", "azure", "azure-cognitive-services", "anthropic", "amazon-bedrock", "alibaba", "alibaba-cn", "aihubmix",
  "abacus", "302ai"
]);

const providerIconAliases: Record<string, string> = {
  "google-vertex": "google-vertex",
  "google-vertex-anthropic": "google-vertex-anthropic",
  "github-copilot": "github-copilot",
  "copilot": "github-copilot",
  "github-models": "github-models",
  "github": "github-models",
  "amazon-bedrock": "amazon-bedrock",
  "bedrock": "amazon-bedrock",
  "aws": "amazon-bedrock",
  "azure-cognitive-services": "azure-cognitive-services",
  "azure": "azure",
  "azure-openai": "azure-cognitive-services",
  "opencode-zen": "opencode",
  "opencode-go": "opencode-go",
  "opencode": "opencode",
  "zenmux": "zenmux",
  "zen": "opencode",
  "agentrouter": "openrouter",
  "agent-router": "openrouter",
  "agent_router": "openrouter",
  "vercel-ai-gateway": "vercel",
  "vercel": "vercel",
  "ollama": "ollama-cloud",
  "ollama-cloud": "ollama-cloud",
  "cloudflare": "cloudflare-workers-ai",
  "cloudflare-workers-ai": "cloudflare-workers-ai",
  "cloudflare-ai": "cloudflare-ai-gateway",
  "cloudflare-ai-gateway": "cloudflare-ai-gateway",
  "claude": "anthropic",
  "chatgpt": "openai",
  "open-ai": "openai",
  "gemini": "google",
  "google-ai": "google",
  "googleai": "google",
  "mistralai": "mistral",
  "grok": "xai",
  "together": "togetherai",
  "fireworks": "fireworks-ai",
  "novita": "novita-ai",
  "qwen": "alibaba",
  "dashscope": "alibaba",
  "kimi": "moonshotai",
  "deep-seek": "deepseek",
  "deepseek-ai": "deepseek",
  "hf": "huggingface",
};

function normalizeProviderIconId(id: string): string {
  if (!id) return "";
  const raw = String(id).toLowerCase().trim();
  if (providerIconAliases[raw]) return providerIconAliases[raw];
  if (OFFICIAL_PROVIDER_ICON_NAMES.has(raw)) return raw;

  const clean = raw.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (providerIconAliases[clean]) return providerIconAliases[clean];
  if (OFFICIAL_PROVIDER_ICON_NAMES.has(clean)) return clean;

  if (raw.includes("opencode") && raw.includes("go")) return "opencode-go";
  if (raw.includes("opencode") || raw.includes("zenmux") || raw.includes("zen")) return "opencode";
  if (raw.includes("agentrouter") || raw.includes("agent-router") || raw.includes("agent_router")) return "openrouter";
  if (raw.includes("alibaba") && (raw.includes("china") || raw.endsWith("-cn"))) return "alibaba-cn";
  if (raw.includes("alibaba") || raw.includes("qwen") || raw.includes("dashscope")) return "alibaba";
  if (raw.includes("github") && raw.includes("copilot")) return "github-copilot";
  if (raw.includes("github")) return "github-models";
  if (raw.includes("vertex") && raw.includes("anthropic")) return "google-vertex-anthropic";
  if (raw.includes("vertex")) return "google-vertex";
  if (raw.includes("bedrock") || raw.includes("amazon") || raw.startsWith("aws")) return "amazon-bedrock";
  if (raw.includes("azure")) return "azure-cognitive-services";
  if (raw.includes("openrouter")) return "openrouter";
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic";
  if (raw.includes("openai") || raw.includes("chatgpt")) return "openai";
  if (raw.includes("deepseek")) return "deepseek";
  if (raw.includes("google") || raw.includes("gemini")) return "google";
  if (raw.includes("mistral")) return "mistral";
  if (raw.includes("groq")) return "groq";
  if (raw === "xai" || raw.includes("xai") || raw.includes("grok")) return "xai";
  if (raw.includes("vercel")) return "vercel";
  if (raw.includes("nvidia")) return "nvidia";
  if (raw.includes("perplexity")) return "perplexity";
  if (raw.includes("cohere")) return "cohere";
  if (raw.includes("fireworks")) return "fireworks-ai";
  if (raw.includes("huggingface")) return "huggingface";
  if (raw.includes("moonshot") || raw.includes("kimi")) return raw.includes("china") || raw.includes("-cn") ? "moonshotai-cn" : "moonshotai";
  if (raw.includes("minimax")) return raw.includes("china") || raw.includes("-cn") ? "minimax-cn" : "minimax";
  if (raw.includes("zhipu") || raw === "zai" || raw.includes("zai")) return raw.includes("coding") ? "zai-coding-plan" : "zai";
  if (raw.includes("together")) return "togetherai";
  if (raw.includes("cerebras")) return "cerebras";
  if (raw.includes("deepinfra")) return "deepinfra";
  if (raw.includes("novita")) return "novita-ai";
  if (raw.includes("siliconflow")) return raw.includes("cn") ? "siliconflow-cn" : "siliconflow";
  if (raw.includes("ollama")) return "ollama-cloud";
  if (raw.includes("cloudflare")) return raw.includes("gateway") ? "cloudflare-ai-gateway" : "cloudflare-workers-ai";
  return "";
}

function formatAgentError(raw: any) {
  const error = raw?.error ?? raw?.properties?.error ?? raw;
  const data = error?.data ?? {};
  const responseBody = data?.responseBody ?? error?.responseBody ?? "";

  let body: any = {};
  if (typeof responseBody === "string" && responseBody.trim()) {
    try { body = JSON.parse(responseBody); } catch {}
  } else if (responseBody && typeof responseBody === "object") {
    body = responseBody;
  }

  const nested = body?.error ?? data?.error ?? {};
  const code = String(nested?.code ?? data?.code ?? error?.code ?? "").trim();
  const message = String(nested?.message ?? data?.message ?? error?.message ?? raw?.message ?? "").trim();
  const statusCode = Number(data?.statusCode ?? error?.statusCode ?? raw?.statusCode ?? 0) || 0;
  const requestId = String(data?.metadata?.requestId ?? data?.requestId ?? data?.responseHeaders?.["request-id"] ?? "").trim();
  const providerType = String(nested?.type ?? data?.type ?? error?.type ?? "").trim();
  const retryable = typeof data?.isRetryable === "boolean" ? data.isRetryable : undefined;

  const lower = `${code} ${message} ${providerType}`.toLowerCase();
  let friendly = "O provedor não conseguiu executar esta solicitação.";
  if (lower.includes("content-blocked") || lower.includes("content blocked")) {
    friendly = "O provedor recusou esta solicitação por política de conteúdo.";
  } else if (statusCode === 401 || lower.includes("unauthorized") || lower.includes("authentication")) {
    friendly = "A autenticação do provedor não é válida ou expirou.";
  } else if (statusCode === 403 || lower.includes("forbidden")) {
    friendly = "O provedor não autorizou esta operação.";
  } else if (statusCode === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    friendly = "O provedor atingiu o limite de requisições.";
  } else if (statusCode >= 500 || lower.includes("timeout") || lower.includes("temporar")) {
    friendly = "O provedor apresentou uma falha temporária.";
  } else if (message) {
    friendly = sanitizeDiagnosticMessage(message);
  }

  const details = [
    code ? `Código: ${code}` : "",
    statusCode ? `HTTP: ${statusCode}` : "",
    providerType ? `Tipo: ${providerType}` : "",
    retryable !== undefined ? `Repetição automática: ${retryable ? "permitida" : "não permitida"}` : "",
    requestId ? `ID da solicitação: ${requestId}` : ""
  ].filter(Boolean);

  return { friendly, details: details.join("\n"), code, statusCode, retryable, requestId, rawMessage: message };
}

function sanitizeDiagnosticMessage(value: string) {
  return value
    .replace(/https?:\/\/[^\s]+/gi, "o serviço do provedor")
    .replace(/\bOpenCode\b/gi, "Neko")
    .replace(/\bAgentRouter\b/gi, "provedor")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 500);
}

function slugifyGithubRepoName(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

function isValidGithubRepoName(name: string): boolean {
  const trimmed = String(name || "").trim();
  return trimmed.length >= 1 && trimmed.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(trimmed);
}

function slugifyVercelProjectName(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

function isValidVercelProjectName(name: string): boolean {
  const trimmed = String(name || "").trim();
  if (trimmed.length < 1 || trimmed.length > 100) return false;
  if (trimmed.includes("---")) return false;
  return /^[a-z0-9_.-]+$/.test(trimmed);
}

function getVercelNameValidationError(name: string): string | null {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return "Informe o nome do projeto na Vercel.";
  }
  if (trimmed.length > 100) {
    return "O nome deve ter no máximo 100 caracteres.";
  }
  if (trimmed.includes("---")) {
    return "O nome não pode conter a sequência '---'.";
  }
  if (/[A-Z]/.test(trimmed)) {
    return "O nome deve estar em letras minúsculas.";
  }
  if (!/^[a-z0-9_.-]+$/.test(trimmed)) {
    return "O nome só pode conter letras minúsculas, números, ponto, underscore e hífen.";
  }
  return null;
}


function ProviderIcon({ id, size = 17 }: { id?: string; size?: number }) {
  const iconId = normalizeProviderIconId(id || "");
  if (!iconId) {
    return <span className="provider-glyph fallback" style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Sparkles size={Math.max(10, size - 2)}/></span>;
  }
  return (
    <svg className="provider-glyph" width={size} height={size} aria-hidden="true" focusable="false" style={{ width: size, height: size, display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <use href={`#${iconId}`} xlinkHref={`#${iconId}`}/>
    </svg>
  );
}

function ProviderIconSprite() {
  return <div style={{ display: "none" }} dangerouslySetInnerHTML={{ __html: providerSprite }} />;
}

import "./styles.css";

type Model = { providerID: string; providerName: string; modelID: string; name: string; variants?: string[]; enabled: boolean; connected: boolean; attachment?: boolean };
type Provider = { id: string; name: string; connected: boolean; enabled: boolean; methods: { type: string; label?: string }[]; models: Model[] };

// Single vision-capability decision point in the renderer. Mirrors the
// shared detection used by the main process (catalog capability + local
// overrides + safe default). Never performs any request.
function modelSupportsVision(model: Model | undefined): boolean {
  if (!model) return false;
  return getModelCapabilities(model.providerID, model.modelID, { attachment: model.attachment }).imageInput;
}
function VercelIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2L24 22H0L12 2Z" />
    </svg>
  );
}

function GitHubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.25c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.72.08-.72 1.2.08 1.84 1.23 1.84 1.23 1.07 1.84 2.8 1.31 3.49 1 .11-.77.42-1.31.76-1.61-2.67-.3-5.48-1.34-5.48-5.96 0-1.32.47-2.4 1.24-3.25-.12-.3-.54-1.54.12-3.2 0 0 1.01-.32 3.3 1.24a11.5 11.5 0 0 1 6 0c2.29-1.56 3.3-1.24 3.3-1.24.66 1.66.24 2.9.12 3.2.77.85 1.24 1.93 1.24 3.25 0 4.63-2.82 5.66-5.5 5.96.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.58A12 12 0 0 0 12 .5Z"/>
    </svg>
  );
}

function SupabaseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13.397 22.478a1.847 1.847 0 0 1-2.966-1.425V13.5h8.32a1.847 1.847 0 0 1 1.388 3.071l-6.742 5.907Z"/>
      <path d="M10.603 1.522a1.847 1.847 0 0 1 2.966 1.425V10.5H5.25a1.847 1.847 0 0 1-1.388-3.071l6.741-5.907Z" opacity=".7"/>
    </svg>
  );
}


// Formatação dinâmica de tempo em português para lastOpenedAt / lastEdited
function formatTimeAgo(timestamp: number, prefix: "Editado" | "Aberto" = "Editado"): string {
  if (!timestamp || isNaN(timestamp)) return `${prefix} recentemente`;
  const now = Date.now();
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSec < 60) return `${prefix} agora`;
  if (diffMin === 1) return `${prefix} há 1 minuto`;
  if (diffMin < 60) return `${prefix} há ${diffMin} minutos`;
  if (diffHours === 1) return `${prefix} há 1 hora`;
  if (diffHours < 24) return `${prefix} há ${diffHours} horas`;
  if (diffDays === 1) return `${prefix} há 1 dia`;
  if (diffDays < 30) return `${prefix} há ${diffDays} dias`;
  if (diffMonths === 1) return `${prefix} há 1 mês`;
  if (diffMonths < 12) return `${prefix} há ${diffMonths} meses`;
  if (diffYears === 1) return `${prefix} há 1 ano`;
  return `${prefix} há ${diffYears} anos`;
}

function formatProjectActivity(item: RecentProject): string {
  if (item.lastEdited && item.lastOpenedAt && item.lastEdited > item.lastOpenedAt) {
    return formatTimeAgo(item.lastEdited, "Editado");
  }
  const openedTs = item.lastOpenedAt || item.lastOpened || item.lastEdited || Date.now();
  return formatTimeAgo(openedTs, "Aberto");
}

type Node = { name: string; path: string; type: "file" | "directory"; children?: Node[] };
type Message = { role: "user" | "assistant" | "system" | "error"; text: string; attachments?: Attachment[]; taskId?: string; durationMs?: number; createdAt?: number };
type PendingPlan = { request: string; attachments: Attachment[]; contextPaths: string[]; planText: string; messageCreatedAt: number; requestId?: string; taskId?: string; sessionID?: string };
type ApprovedPlan = { planText: string; approvedAt: number; messageCreatedAt: number };
type Activity = { id: string; icon: "brain" | "tool" | "file" | "command" | "status" | "check" | "error" | "wait"; title: string; detail?: string; state: "running" | "done" | "error"; ts: number };
type PermissionRequest = { id: string; sessionID: string; permission: string; patterns: string[]; always?: string[]; metadata?: Record<string, unknown>; tool?: { messageID?: string; callID?: string } };
// Interactive question from the agent. It is answered inside the Neko chat:
// the answer is sent to the same agent session and the task continues from
// exactly where it stopped.
type AgentQuestion = { taskId: string; sessionID: string; questionId: string; question: string; options?: string[]; allowFreeText: boolean; requestId?: string; isNativeTool?: boolean };
type Attachment = { path: string; name: string; mime: string; size: number; url?: string; previewUrl?: string; kind: "image" | "document" | "text"; extension?: string };
type SlashCommand = { name?: string; description?: string };
// Console de runtime do Preview (console.log/info/warn/error/debug do projeto).
type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
type PreviewConsoleEntry = {
  id: string;
  level: ConsoleLevel;
  message: string;
  source?: string;   // short origin (e.g. main.tsx:42)
  url?: string;      // full origin, para tooltip
  ts: number;
};

type GithubStatus = { connected: boolean; user?: { login: string; name?: string | null; avatarUrl?: string | null }; repos?: Array<{ id: number; name: string; fullName: string; private: boolean; htmlUrl: string; defaultBranch?: string | null }>; needsInstallation?: boolean; needsReauthorization?: boolean; needsPermissions?: boolean; capabilities?: { canReadRepositories: boolean; canWriteContents: boolean; canCreateRepository: boolean }; installUrl?: string };
type GithubDevice = { userCode: string; verificationUri: string; expiresIn: number; interval: number };
type RecentProject = {
  name: string;
  path: string;
  lastOpenedAt?: number;
  lastOpened?: number;
  lastEdited?: number;
  favorite?: boolean;
  thumbnail?: string | null;
  thumbnailPath?: string | null;
  thumbnailUpdatedAt?: number;
  previewUrl?: string | null;
  technology?: string;
  missing?: boolean;
};

function getProjectParentDirectory(projectPath: string): string {
  if (!projectPath) return "";
  const norm = projectPath.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  if (lastSlash > 0) {
    return norm.slice(0, lastSlash);
  }
  return norm;
}

type GitChangedFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  staged: boolean;
};

type GitStatusSummary = {
  modified: number;
  untracked: number;
  deleted: number;
  staged: number;
  total: number;
};

type GitStatus = {
  initialized: boolean;
  branch: string | null;
  remote: string | null;
  linkedRepo: string | null;
  dirty: boolean;
  changedFiles?: GitChangedFile[];
  summary?: GitStatusSummary;
};

type Modal = "models" | "providers" | "providerAuth" | "github" | "githubDevice" | "githubLink" | "githubClone" | "githubPublish" | "newProject" | "branchChanges" | "branchDiscardConfirm" | "branchCommit" | "supabase" | "supabaseCreate" | "vercel" | "license" | "licenseDeactivateConfirm" | "licenseResetConfirm" | "settings" | "siteClone" | "tutorials" | null;

// Compara caminhos de projeto ignorando separador final (mesma identidade real).
function pathNormalizedEqual(a: string, b: string): boolean {
  const n = (p: string) => String(p || "").replace(/[\\/]+$/g, "").toLowerCase();
  return n(a) === n(b);
}

// CollapsibleMessageBody: recolhimento VISUAL local para mensagens de texto
// longas (<320px de altura visível). O texto completo NUNCA é truncado — o
// usuário recebe a string integral e apenas o overflow é ocultado com fade.
// Estado estritamente local (expanded); nenhuma chamada IPC/OpenCode/gestão.
function CollapsibleMessageBody({ text }: { text: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const [collapsible, setCollapsible] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  // Mede overflow apenas no estado recolhido (scrollHeight inclui o conteúdo
  // cortado). ResizeObserver local, desconectado na limpeza; sem polling/timers.
  React.useLayoutEffect(() => {
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setCollapsible(el.scrollHeight > el.clientHeight + 1);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className={`message-body-wrap${collapsible && !expanded ? " is-collapsed" : ""}`}>
      <div ref={bodyRef} className={`message-body${!expanded ? " collapsible-collapsed" : ""}`}>{text}</div>
      {collapsible && (
        <button type="button" className="message-expand-toggle" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
          {expanded ? "Ver menos" : "Ver mais..."}
        </button>
      )}
    </div>
  );
}

// Interactive Decision Card: apresenta uma pergunta real do agente (estado
// waiting_for_user) como card nativo — opções selecionáveis e/ou resposta
// livre. Envia a resposta para a MESMA sessão do agente (não cria sessão nova).
function AgentDecisionCard({ question, onAnswer, onDismiss }: {
  question: AgentQuestion;
  onAnswer: (value: string) => void;
  onDismiss: () => void;
}) {
  const options = (question.options || []).filter(Boolean);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [custom, setCustom] = React.useState(options.length === 0);
  const [text, setText] = React.useState("");
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  const hasValid = custom ? text.trim().length > 0 : selected !== null;

  const submit = () => {
    if (!hasValid || sending || sent) return;
    const value = custom ? text.trim() : (selected as string);
    setSending(true);
    // Mostra brevemente "Enviando..." e marca enviado; o fluxo real continua
    // na mesma sessão via onAnswer (que limpa o card e volta o Task Runner).
    window.setTimeout(() => { setSent(true); }, 120);
    window.setTimeout(() => onAnswer(value), 260);
  };

  return (
    <div className="decision-card" role="group" aria-label={`Pergunta do Neko: ${question.question}`}>
      <div className="decision-head"><CircleAlert size={15}/><b>1 de 1 perguntas</b></div>
      <div className="decision-question">{question.question}</div>
      {!sent && <div className="decision-label">Selecione uma resposta ou escreva a sua.</div>}

      {options.length > 0 && !sent && options.map((option, i) => (
        <button
          type="button"
          key={`${question.questionId}:${i}`}
          className={`decision-option ${!custom && selected === option ? "selected" : ""}`}
          onClick={() => { setCustom(false); setSelected(option); }}
          aria-pressed={!custom && selected === option}
        >
          <span className="decision-radio">{!custom && selected === option ? <Check size={13}/> : null}</span>
          <span className="decision-option-text">{option}</span>
        </button>
      ))}

      {question.allowFreeText !== false && !sent && (
        <button type="button" className={`decision-option decision-custom ${custom ? "selected" : ""}`} onClick={() => { setCustom(true); setSelected(null); window.setTimeout(() => textRef.current?.focus(), 0); }} aria-pressed={custom}>
          <span className="decision-radio">{custom ? <Check size={13}/> : null}</span>
          <span className="decision-option-text">Digite sua própria resposta</span>
        </button>
      )}
      {custom && !sent && (
        <textarea
          ref={textRef}
          className="decision-text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Digite sua resposta..."
          rows={2}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
      )}

      {!sent ? (
        <div className="decision-actions">
          <button type="button" className="decision-dismiss" onClick={onDismiss} disabled={sending}>Descartar</button>
          <button type="button" className="decision-submit" disabled={!hasValid || sending} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin"/> : "Enviar"}
          </button>
        </div>
      ) : (
        <div className="decision-sent"><CheckCircle2 size={15}/> Resposta enviada — o Neko está continuando a tarefa.</div>
      )}
    </div>
  );
}



function App() {
  // [BLACKSCREEN] DIAGNOSTIC: global error handlers
  React.useEffect(() => {
    window.onerror = (message, source, lineno, colno, error) => {
      const msg = typeof message === "string" ? message : String(message);
      console.error("[BLACKSCREEN] RENDER ERROR", { message: msg, source, lineno, colno, stack: error?.stack });
      window.neko.reportRendererError({ type: "RENDER ERROR", message: msg, filename: String(source || ""), lineno: Number(lineno || 0), colno: Number(colno || 0), stack: error?.stack || "" }).catch(() => {});
      return false;
    };
    window.onunhandledrejection = (event) => {
      const reason = event?.reason;
      console.error("[BLACKSCREEN] UNHANDLED PROMISE REJECTION", { reason, stack: reason?.stack });
      window.neko.reportRendererError({ type: "UNHANDLED PROMISE REJECTION", message: String(reason?.message || reason || ""), filename: "", lineno: 0, colno: 0, stack: reason?.stack || "" }).catch(() => {});
    };
  }, []);

  const [project, setProject] = React.useState<string | null>(null);
  const [isExiting, setIsExiting] = React.useState(false);
  const isExitingRef = React.useRef(false);
  const [isSwitchingProject, setIsSwitchingProject] = React.useState(false);
  const isSwitchingProjectRef = React.useRef(false);
  // Distingue "primeiro carregamento" (sem projeto ativo) de "troca" (já havia
  // outro projeto aberto). Determina o texto exibido no overlay de carregamento.
  const projectLoadKindRef = React.useRef<"load" | "switch">("load");
  const projectGenerationRef = React.useRef(0);
  const projectRef = React.useRef<string | null>(null);

  // [BLACKSCREEN] DIAGNOSTIC: track project state changes
  const prevProjectRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    console.log("[BLACKSCREEN] STATE-CHANGE:project", { from: prevProjectRef.current, to: project, isExiting: isExitingRef.current, isSwitching: isSwitchingProjectRef.current });
    prevProjectRef.current = project;
  }, [project]);

  React.useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
  // Avisos sonoros (configuração ON/OFF persistida). O serviço em sounds.ts
  // controla deduplicação e reprodução; aqui só espelhamos p/ a UI.
  const [soundsOn, setSoundsOn] = React.useState<boolean>(soundEnabled());
  const toggleSounds = (value: boolean) => { setSoundEnabled(value); setSoundsOn(value); };
  const [recentProjects, setRecentProjects] = React.useState<RecentProject[]>([]);
  const [recentProjectsMenuOpen, setRecentProjectsMenuOpen] = React.useState(false);
  const [homeTab, setHomeTab] = React.useState<"all" | "favorites">("all");
  const [brokenThumbs, setBrokenThumbs] = React.useState<Set<string>>(() => new Set());
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  const [projectDisplayName, setProjectDisplayName] = React.useState("Projeto");
  const projectName = projectDisplayName;
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [activity, setActivity] = React.useState<Activity[]>([]);
  const [workingStatus, setWorkingStatus] = React.useState<string>("");
  const [pendingPermission, setPendingPermission] = React.useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = React.useState<AgentQuestion | null>(null);
  const pendingQuestionRef = React.useRef<AgentQuestion | null>(null);
  const handledQuestionIdsRef = React.useRef<Set<string>>(new Set());
  // Lightbox simples para visualizar imagens anexadas em tamanho maior.
  const [lightboxImage, setLightboxImage] = React.useState<{ url: string; name: string } | null>(null);
  // Clonar Site — análise/crawling de uma URL pública.
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [cloneBusy, setCloneBusy] = React.useState(false);
  const [cloneProgress, setCloneProgress] = React.useState<{ scanned: number; currentUrl: string }>({ scanned: 0, currentUrl: "" });
  const [cloneAnalysis, setCloneAnalysis] = React.useState<any>(null);
  const [cloneError, setCloneError] = React.useState("");
  const [cloneReconstructBusy, setCloneReconstructBusy] = React.useState(false);
  // Captura Chromium (Clonar Site V2): snapshot real renderizado.
  const [cloneCapture, setCloneCapture] = React.useState<any>(null);
  const [cloneCaptureBusy, setCloneCaptureBusy] = React.useState(false);
  const completionTimer = React.useRef<number | null>(null);
  // The session can briefly report idle between queued actions. Never treat that
  // transient state as the end of a user request. A real completion requires that
  // this request has observed a busy state first.
  const requestInFlightRef = React.useRef(false);
  const requestObservedBusyRef = React.useRef(false);
  const requestStartedAtRef = React.useRef(0);
  const busyRef = React.useRef(false);
  const sessionIdRef = React.useRef<string | null>(null);
  const [status, setStatus] = React.useState<"offline" | "starting" | "online">("offline");
  // [BLACKSCREEN] DIAGNOSTIC: track status state changes
  const prevStatusRef = React.useRef<"offline" | "starting" | "online">("offline");
  React.useEffect(() => {
    if (prevStatusRef.current !== status) {
      console.log("[BLACKSCREEN] STATE-CHANGE:status", { from: prevStatusRef.current, to: status, project: projectRef.current, isExiting: isExitingRef.current });
      prevStatusRef.current = status;
    }
  }, [status]);
  const statusRef = React.useRef(status);
  React.useEffect(() => { statusRef.current = status; }, [status]);
  const [tree, setTree] = React.useState<Node[]>([]);
  const [models, setModels] = React.useState<Model[]>([]);
  const [managedModels, setManagedModels] = React.useState<Model[]>([]);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const LAST_MODEL_STORAGE_KEY = "nekoai.lastModel";
  const [selectedModel, setSelectedModel] = React.useState<{ providerID: string; modelID: string } | undefined>();
  const [modelOpen, setModelOpen] = React.useState(false);
  const [modelSearch, setModelSearch] = React.useState("");
  const [modal, setModal] = React.useState<Modal>(null);
  const [providerSearch, setProviderSearch] = React.useState("");
  const [selectedProvider, setSelectedProvider] = React.useState<Provider | null>(null);
  const [apiKey, setApiKey] = React.useState("");
  const [authBusy, setAuthBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState("");
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewFramework, setPreviewFramework] = React.useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewStatus, setPreviewStatus] = React.useState<string>("idle");
  const [vercelState, setVercelState] = React.useState<{
    configured: boolean;
    connection: "checking" | "connected" | "disconnected" | "authorizing" | "error";
    deployment: "idle" | "deploying" | "ready" | "error";
    username: string | null;
    projectPath: string | null;
    projectName: string | null;
    linked: boolean;
    deploymentUrl: string | null;
    error: string | null;
  }>({
    configured: false,
    connection: "checking",
    deployment: "idle",
    username: null,
    projectPath: null,
    projectName: null,
    linked: false,
    deploymentUrl: null,
    error: null,
  });
  const [vercelBusy, setVercelBusy] = React.useState(false);
  const [vercelError, setVercelError] = React.useState<string | null>(null);
  const [vercelLogs, setVercelLogs] = React.useState<string[]>([]);
  const [vercelProjectName, setVercelProjectName] = React.useState("");
  const [supabaseState, setSupabaseState] = React.useState<{
    status: "disconnected" | "checking" | "authorizing" | "selecting" | "validating" | "installing" | "connected" | "error";
    configured: boolean;
    projects: Array<{ id: string; ref: string; name: string; region: string; status: string }>;
    organizations: Array<{ id: string; name: string }>;
    projectRef: string | null;
    projectName: string | null;
    projectUrl: string | null;
    pendingRuntimeSetup?: boolean;
    recentCreatedNotice?: string | null;
    error: string | null;
  }>({
    status: "disconnected",
    configured: true,
    projects: [],
    organizations: [],
    projectRef: null,
    projectName: null,
    projectUrl: null,
    pendingRuntimeSetup: false,
    recentCreatedNotice: null,
    error: null,
  });
  const [supabaseBusy, setSupabaseBusy] = React.useState(false);
  const [supabaseToken, setSupabaseToken] = React.useState("");
  const [supabaseError, setSupabaseError] = React.useState("");
  const [supabaseView, setSupabaseView] = React.useState<"auto" | "connected" | "projects" | "create" | "connect">("auto");
  const [newSupabaseProjectName, setNewSupabaseProjectName] = React.useState("");
  const [newSupabaseProjectOrg, setNewSupabaseProjectOrg] = React.useState("");
  const [newSupabaseProjectRegion, setNewSupabaseProjectRegion] = React.useState("sa-east-1");
  const [newSupabaseProjectPassword, setNewSupabaseProjectPassword] = React.useState("");
  const [newSupabaseProjectError, setNewSupabaseProjectError] = React.useState("");
  const [newSupabaseProjectStructuredError, setNewSupabaseProjectStructuredError] = React.useState<{
    code: string;
    title: string;
    message: string;
    detail?: string;
    isLimit?: boolean;
  } | null>(null);

  // Função de máscara rígida: NEKO-XXXX-XXXX-XXXX-XXXX ou NEKO-TEST-XXXX-XXXX-XXXX
  const formatLicenseKey = (input: string): string => {
    const raw = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!raw) return "";

    // Detectar prefixo TEST: NEKOTEST... → preservar TEST como grupo separado
    if (raw.startsWith("NEKOTEST")) {
      const body = raw.slice(8); // tudo após NEKOTEST
      if (body.length === 0) return "NEKO-TEST";
      const parts = ["NEKO", "TEST"];
      for (let i = 0; i < body.length; i += 4) {
        parts.push(body.slice(i, i + 4));
      }
      return parts.join("-");
    }

    if (!raw.startsWith("NEKO")) {
      if (raw.length <= 4) return raw;
      const body = raw.slice(0, 16);
      const parts = ["NEKO"];
      for (let i = 0; i < body.length; i += 4) {
        parts.push(body.slice(i, i + 4));
      }
      return parts.join("-");
    }

    const body = raw.slice(4, 20);
    if (body.length === 0) return "NEKO";

    const parts = ["NEKO"];
    for (let i = 0; i < body.length; i += 4) {
      parts.push(body.slice(i, i + 4));
    }
    return parts.join("-");
  };

  const isLicenseKeyComplete = (key: string): boolean => {
    return /^NEKO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)
      || /^NEKO-TEST-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
  };

  // License System States
  const [licenseState, setLicenseState] = React.useState<{
    state: "MISSING" | "INVALID" | "VALID" | "GRACE" | "EXPIRED";
    isLicensed: boolean;
    plan?: string;
    status?: string;
    expiresAt?: string;
    graceUntil?: string;
    entitlements: string[];
    keyMask?: string;
    deviceId: string;
    licenseId?: string;
  }>({
    state: "MISSING",
    isLicensed: false,
    entitlements: [],
    deviceId: "",
  });
  // [BLACKSCREEN] DIAGNOSTIC: track licenseState changes
  const prevLicenseRef = React.useRef<{ state: string; isLicensed: boolean }>({ state: "MISSING", isLicensed: false });
  React.useEffect(() => {
    if (prevLicenseRef.current.state !== licenseState.state || prevLicenseRef.current.isLicensed !== licenseState.isLicensed) {
      console.log("[BLACKSCREEN] STATE-CHANGE:license", { from: prevLicenseRef.current, to: { state: licenseState.state, isLicensed: licenseState.isLicensed }, project: projectRef.current });
      prevLicenseRef.current = { state: licenseState.state, isLicensed: licenseState.isLicensed };
    }
  }, [licenseState.state, licenseState.isLicensed]);
  const [licenseKeyInput, setLicenseKeyInput] = React.useState("");
  const [licenseBusy, setLicenseBusy] = React.useState(false);
  const [licenseError, setLicenseError] = React.useState<string | null>(null);
  const [licenseErrorCode, setLicenseErrorCode] = React.useState<string | null>(null);
  const [licenseSuccessMessage, setLicenseSuccessMessage] = React.useState<string | null>(null);

  const fetchLicenseState = React.useCallback(async () => {
    try {
      const current = await window.neko.licenseGetState();
      if (current) {
        console.log("[BLACKSCREEN] license:initial-fetch", { state: current.state, isLicensed: current.isLicensed });
        setLicenseState(current);
      }
    } catch (err) {
      console.warn("[Neko/LicenseUI] Falha ao carregar estado de licença:", err);
    }
  }, []);

  React.useEffect(() => {
    void fetchLicenseState();
    const cleanup = window.neko.onLicenseStateChange((newState) => {
      console.log("[Neko/LicenseUI] Recebida atualização de estado via IPC:", newState.state, newState.reason);
      console.log("[BLACKSCREEN] license-callback:start", { isLicensed: newState.isLicensed, reason: newState.reason, project: projectRef.current });
      setLicenseState(newState);
      if (!newState.isLicensed) {
        console.log("[BLACKSCREEN] license-callback:not-licensed", { project: projectRef.current, reason: newState.reason });
        setModal(null);
        setProject(null);
        if (newState.reason === "LOCAL_DEACTIVATION") {
          setLicenseError(null);
          setLicenseErrorCode(null);
          setLicenseSuccessMessage("Dispositivo desativado com sucesso.");
        } else if (newState.reason === "REMOTE_TRANSFER") {
          setLicenseSuccessMessage(null);
          setLicenseError("Sua licença foi ativada em outro dispositivo.");
          setLicenseErrorCode(null);
        } else {
          setLicenseSuccessMessage(null);
          setLicenseError(null);
          setLicenseErrorCode(null);
        }
      }
    });
    return () => {
      cleanup();
    };
  }, [fetchLicenseState]);

  // Auto Updater State
  const [updaterState, setUpdaterState] = React.useState<{
    status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
    currentVersion: string;
    updateInfo: { version: string; releaseDate?: string; releaseNotes?: string | any[] } | null;
    progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
    error: string | null;
    lastCheckedAt: number | null;
  }>({
    status: "idle",
    currentVersion: "0.4.73",
    updateInfo: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  });
  const [updaterBusy, setUpdaterBusy] = React.useState(false);

  const fetchUpdaterState = React.useCallback(async () => {
    try {
      const state = await window.neko.updaterGetState();
      if (state) {
        setUpdaterState(state);
      }
    } catch (err) {
      console.warn("[Neko/UpdaterUI] Falha ao ler estado do updater:", err);
    }
  }, []);

  React.useEffect(() => {
    void fetchUpdaterState();
    const cleanup = window.neko.onUpdaterStateChange((newState) => {
      console.log("[Neko/UpdaterUI] Estado do updater atualizado:", newState.status);
      setUpdaterState(newState);
    });
    return () => {
      cleanup();
    };
  }, [fetchUpdaterState]);

  const handleCheckForUpdates = async () => {
    setUpdaterBusy(true);
    try {
      await window.neko.updaterCheck();
    } catch (err) {
      console.warn("[Neko/UpdaterUI] Falha ao verificar atualizações:", err);
    } finally {
      setUpdaterBusy(false);
    }
  };

  const handleDownloadUpdate = async () => {
    setUpdaterBusy(true);
    try {
      await window.neko.updaterDownload();
    } catch (err) {
      console.warn("[Neko/UpdaterUI] Falha ao baixar atualização:", err);
    } finally {
      setUpdaterBusy(false);
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await window.neko.updaterInstall();
    } catch (err) {
      console.warn("[Neko/UpdaterUI] Falha ao instalar atualização:", err);
    }
  };

  const formatRemainingTime = (seconds?: number): string => {
    if (!seconds || seconds <= 0) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes > 0 ? `${minutes}min` : ""}`.trim();
    }
    return `${Math.max(1, minutes)}min`;
  };

  const mapLicenseError = (code?: string, rawMsg?: string, retryAfter?: number): string => {
    switch (code) {
      case "INVALID_LICENSE_KEY":
      case "INVALID_KEY_FORMAT":
        return "Chave de licença inválida. Digite no formato NEKO-XXXX-XXXX-XXXX-XXXX.";
      case "DEVICE_ALREADY_ACTIVE":
        return "Esta licença já está ativada em outro dispositivo.";
      case "NOT_FOUND":
        return "Esta chave de licença não foi encontrada.";
      case "REVOKED":
        return "Esta licença foi revogada administrativamente.";
      case "EXPIRED":
        return "Esta licença expirou. Renove sua assinatura para continuar usando.";
      case "RATE_LIMITED": {
        const timeStr = formatRemainingTime(retryAfter);
        return `Muitas tentativas em pouco tempo. Aguarde ${timeStr ? `${timeStr} ` : "alguns instantes "}e tente novamente.`;
      }
      case "NETWORK_ERROR":
        return "Não foi possível conectar ao servidor de licenças. Verifique sua conexão com a internet.";
      case "INVALID_GRANT":
        return "O certificado emitido pelo servidor falhou na verificação de integridade local.";
      case "INTERNAL_ERROR":
      case "DB_ERROR":
        return "Não foi possível processar a licença no momento. Tente novamente em instantes.";
      default:
        return rawMsg || "Ocorreu um erro ao processar sua licença.";
    }
  };

  const handleActivateLicense = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanKey = formatLicenseKey(licenseKeyInput);

    if (!isLicenseKeyComplete(cleanKey)) {
      setLicenseError("Informe a chave de licença completa no formato NEKO-XXXX-XXXX-XXXX-XXXX.");
      return;
    }

    setLicenseBusy(true);
    setLicenseError(null);
    setLicenseErrorCode(null);
    setLicenseSuccessMessage(null);

    try {
      const res = await window.neko.licenseActivate(cleanKey);
      if (res.ok) {
        setLicenseSuccessMessage("Licença ativada com sucesso!");
        setLicenseKeyInput("");
        await fetchLicenseState();
      } else {
        setLicenseErrorCode(res.error_code || null);
        setLicenseError(mapLicenseError(res.error_code, res.message));
      }
    } catch (err: any) {
      setLicenseErrorCode("NETWORK_ERROR");
      setLicenseError(mapLicenseError("NETWORK_ERROR", err?.message));
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleResetLicense = async () => {
    const cleanKey = formatLicenseKey(licenseKeyInput);
    if (!isLicenseKeyComplete(cleanKey)) {
      setLicenseError("Informe a chave de licença completa no formato NEKO-XXXX-XXXX-XXXX-XXXX.");
      return;
    }

    setLicenseBusy(true);
    setLicenseError(null);
    setLicenseErrorCode(null);
    setLicenseSuccessMessage(null);

    try {
      const res = await window.neko.licenseResetDevice(cleanKey);
      if (res.ok) {
        setLicenseSuccessMessage("Licença transferida e ativada neste computador com sucesso!");
        setLicenseKeyInput("");
        setModal(null);
        await fetchLicenseState();
      } else {
        setLicenseErrorCode(res.error_code || null);
        setLicenseError(mapLicenseError(res.error_code, res.message, res.retry_after));
      }
    } catch (err: any) {
      setLicenseErrorCode("NETWORK_ERROR");
      setLicenseError(mapLicenseError("NETWORK_ERROR", err?.message));
    } finally {
      setLicenseBusy(false);
    }
  };



  const handleDeactivateLicense = async () => {
    if (!licenseState.licenseId) {
      setLicenseError("ID da licença não identificado para desativação.");
      return;
    }

    setLicenseBusy(true);
    setLicenseError(null);
    setLicenseErrorCode(null);
    setLicenseSuccessMessage(null);

    try {
      const res = await window.neko.licenseDeactivate(licenseState.licenseId);
      if (res.ok) {
        setLicenseSuccessMessage("Dispositivo desativado com sucesso.");
        setLicenseError(null);
        setLicenseErrorCode(null);
        setModal(null);
        await fetchLicenseState();
      } else {
        setLicenseErrorCode(res.error_code || null);
        setLicenseError(mapLicenseError(res.error_code, res.message));
      }
    } catch (err: any) {
      setLicenseErrorCode("NETWORK_ERROR");
      setLicenseError(mapLicenseError("NETWORK_ERROR", err?.message));
    } finally {
      setLicenseBusy(false);
    }
  };

  const effectiveSupabaseView = React.useMemo(() => {
    if (supabaseView !== "auto") return supabaseView;
    if (supabaseState.status === "connected") return "connected";
    if (
      (supabaseState.projects && supabaseState.projects.length > 0) ||
      (supabaseState.organizations && supabaseState.organizations.length > 0)
    ) {
      return "projects";
    }
    return "connect";
  }, [supabaseView, supabaseState.status, supabaseState.projects, supabaseState.organizations]);

  const [previewMessage, setPreviewMessage] = React.useState("");
  const [previewFrameReady, setPreviewFrameReady] = React.useState(false);
  const previewFrameRef = React.useRef<HTMLIFrameElement | null>(null);
  // Nonce usado apenas como `key` do iframe de fallback para forçar reload
  // sem alterar a URL (a rota atual é preservada porque o `src` não muda).
  const [previewFrameReloadKey, setPreviewFrameReloadKey] = React.useState(0);
  // Preview Page Selector: rotas reais descobertas no projeto ativo.
  const [previewRoutes, setPreviewRoutes] = React.useState<{ path: string; label: string }[]>([]);
  const [previewCurrentRoute, setPreviewCurrentRoute] = React.useState<string>("/");
  const [previewRouteOpen, setPreviewRouteOpen] = React.useState(false);
  const previewRouteLoadingRef = React.useRef(false);
  const previewRoutesProjectRef = React.useRef<string | null>(null);
  const [previewRouteMenuFocus, setPreviewRouteMenuFocus] = React.useState(-1);
  // Keep the legacy iframe as a reversible fallback. The default surface is a
  // native guest WebContents controlled by the main process.
  const [previewSurface, setPreviewSurface] = React.useState<"webcontents" | "iframe">("webcontents");
  const [previewInternalSession, setPreviewInternalSession] = React.useState(0);
  const previewViewHostRef = React.useRef<HTMLDivElement | null>(null);
  const previewViewSyncKeyRef = React.useRef("");
  const lastAgentEventAtRef = React.useRef(0);
  const [terminalTab, setTerminalTab] = React.useState<"logs" | "console" | "errors">("logs");
  // Console funcional do Preview (runtime do projeto). Separado de Logs/Erros.
  const [consoleEntries, setConsoleEntries] = React.useState<PreviewConsoleEntry[]>([]);
  const [consoleFilter, setConsoleFilter] = React.useState<ConsoleLevel | "all">("all");
  const [consoleNewBelow, setConsoleNewBelow] = React.useState(false);
  const consoleBodyRef = React.useRef<HTMLDivElement | null>(null);
  const consoleAtBottomRef = React.useRef(true);
  // Painel inferior de diagnóstico inicia FECHADO. Logs/Console/Erros seguem
  // sendo coletados normalmente; apenas a visualização começa recolhida até o
  // usuário abrir pela barra/abas.
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  const [terminalLines, setTerminalLines] = React.useState<Array<{id:string; kind:"log"|"console"|"error"; text:string; source?:string}>>([]);
  const validationRunningRef = React.useRef(false);
  const repairAttemptsRef = React.useRef(0);
  const previewRuntimeErrorRef = React.useRef<string | null>(null);
  // Rastreia assinaturas de erros já tentados para evitar loops de correção
  const attemptedErrorSignaturesRef = React.useRef<Map<string, { count: number; lastAttempt: number }>>(new Map());
  // Estado do ciclo de reparo
  const [repairState, setRepairState] = React.useState<"idle" | "awaiting-fix" | "awaiting-preview-update" | "validating">("idle");
  const [currentErrorSignature, setCurrentErrorSignature] = React.useState<string | null>(null);
  const [device, setDevice] = React.useState<"desktop" | "tablet" | "mobile">("desktop");
  const [workspaceTab, setWorkspaceTab] = React.useState<"preview" | "code">("preview");
  const [activeFile, setActiveFile] = React.useState<{ path: string; content: string } | null>(null);
  const [codeChangedFile, setCodeChangedFile] = React.useState<string | null>(null);
  const [codeSearch, setCodeSearch] = React.useState("");
  const openFile = React.useCallback((node: Node) => {
    if (node.type !== "directory") {
      window.neko.readFile(node.path).then(setActiveFile).catch(() => {});
    }
  }, []);
  const EFFORT_STORAGE_KEY = "nekoai.effort";
  const [effort, setEffort] = React.useState(() => {
    try {
      const saved = localStorage.getItem(EFFORT_STORAGE_KEY);
      return saved === "Medium" || saved === "High" ? saved : "Low";
    } catch { return "Low"; }
  });
  // Modo do composer: "build" (padrão) ou "plan" (agente nativo de plano,
  // somente leitura + card de aprovação). Fonte única = chatMode.
  const [chatMode, setChatMode] = React.useState<ChatMode>("build");
  const planMode = chatMode === "plan";
  const [chatModeMenuOpen, setChatModeMenuOpen] = React.useState(false);
  const [pendingPlan, setPendingPlan] = React.useState<PendingPlan | null>(null);
  const [approvedPlan, setApprovedPlan] = React.useState<ApprovedPlan | null>(null);
  const [planExpanded, setPlanExpanded] = React.useState(false);
  const [planApprovalBusy, setPlanApprovalBusy] = React.useState(false);
  const [permissionStep, setPermissionStep] = React.useState(0);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [uploadErrors, setUploadErrors] = React.useState<Array<{id:string; name:string; message:string; extension:string}>>([]);
  const [chatCollapsed, setChatCollapsed] = React.useState(false);
  const [githubStatus, setGithubStatus] = React.useState<GithubStatus>({ connected: false, repos: [] });
  const [githubDevice, setGithubDevice] = React.useState<GithubDevice | null>(null);
  const [githubBusy, setGithubBusy] = React.useState(false);
  const [githubError, setGithubError] = React.useState("");
  const [githubLinkRepo, setGithubLinkRepo] = React.useState<GithubStatus["repos"][number] | null>(null);
  const [githubLinkStatus, setGithubLinkStatus] = React.useState<GitStatus>({ initialized: false, branch: null, remote: null, linkedRepo: null, dirty: false, changedFiles: [], summary: { modified: 0, untracked: 0, deleted: 0, staged: 0, total: 0 } });
  const [githubLinkBusy, setGithubLinkBusy] = React.useState(false);
  const [githubLinkError, setGithubLinkError] = React.useState("");
  const [githubReplaceRemote, setGithubReplaceRemote] = React.useState(false);
  const [githubBranches, setGithubBranches] = React.useState<string[]>([]);
  const [githubBranchMenuOpen, setGithubBranchMenuOpen] = React.useState(false);
  const [githubBranchBusy, setGithubBranchBusy] = React.useState(false);
  const [githubBranchError, setGithubBranchError] = React.useState("");
  const [pendingTargetBranch, setPendingTargetBranch] = React.useState<string | null>(null);
  const [showBranchDiffList, setShowBranchDiffList] = React.useState(false);
  const [branchCommitMessage, setBranchCommitMessage] = React.useState("WIP: alterações antes de trocar de branch");
  const [branchActionBusy, setBranchActionBusy] = React.useState(false);
  const [branchActionError, setBranchActionError] = React.useState("");
  const [githubCloneRepo, setGithubCloneRepo] = React.useState<GithubStatus["repos"][number] | null>(null);
  const [githubCloneParent, setGithubCloneParent] = React.useState("");
  const [githubCloneName, setGithubCloneName] = React.useState("");
  const [githubPublishRepoName, setGithubPublishRepoName] = React.useState("");
  const [githubPublishPrivate, setGithubPublishPrivate] = React.useState(true);
  const [githubPublishBusy, setGithubPublishBusy] = React.useState(false);
  const [githubPublishError, setGithubPublishError] = React.useState("");
  const [githubShowRepos, setGithubShowRepos] = React.useState(false);
  const [githubCommitMessage, setGithubCommitMessage] = React.useState("");
  const [githubCommitBusy, setGithubCommitBusy] = React.useState(false);
  const [githubCommitError, setGithubCommitError] = React.useState("");
  const [githubCommitSuccess, setGithubCommitSuccess] = React.useState(false);
  const [newProjectName, setNewProjectName] = React.useState("");
  const [newProjectParent, setNewProjectParent] = React.useState("");
  const [editingMessageIndex, setEditingMessageIndex] = React.useState<number | null>(null);
  const [toast, setToast] = React.useState<{ message: string; left: number; top: number } | null>(null);
  const toastTimerRef = React.useRef<number | null>(null);
  const terminalBodyRef = React.useRef<HTMLDivElement | null>(null);
  const activeTaskRef = React.useRef<{ id: string; startedAt: number; userIndex: number } | null>(null);

  // --- Computed variables (previously undefined — caused ReferenceErrors) ---

  const selected = React.useMemo(
    () => selectedModel ? models.find(m => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID) : undefined,
    [models, selectedModel]
  );

  const modelGroups = React.useMemo(() => {
    const map = new Map<string, { providerID: string; providerName: string; models: Model[] }>();
    for (const m of models) {
      if (!m.connected || !m.enabled) continue;
      if (!map.has(m.providerID)) map.set(m.providerID, { providerID: m.providerID, providerName: m.providerName, models: [] });
      map.get(m.providerID)!.models.push(m);
    }
    const q = modelSearch.toLowerCase();
    return Array.from(map.values()).filter(g => !q || g.models.some(m => m.name.toLowerCase().includes(q) || m.modelID.toLowerCase().includes(q)) || g.providerName.toLowerCase().includes(q));
  }, [models, modelSearch]);

  const managedModelGroups = React.useMemo(() => {
    const map = new Map<string, { providerID: string; providerName: string; models: Model[] }>();
    for (const m of managedModels) {
      if (!map.has(m.providerID)) map.set(m.providerID, { providerID: m.providerID, providerName: m.providerName, models: [] });
      map.get(m.providerID)!.models.push(m);
    }
    const q = modelSearch.toLowerCase();
    return Array.from(map.values()).filter(g => !q || g.models.some(m => m.name.toLowerCase().includes(q) || m.modelID.toLowerCase().includes(q)) || g.providerName.toLowerCase().includes(q));
  }, [managedModels, modelSearch]);

  const connectedProviders = React.useMemo(() => providers.filter(p => p.connected), [providers]);

  const filteredProviders = React.useMemo(() => {
    const q = providerSearch.toLowerCase();
    return q ? providers.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : providers;
  }, [providers, providerSearch]);

  const POPULAR_PROVIDER_IDS = React.useMemo(() => new Set([
    "openai", "anthropic", "google", "deepseek", "xai", "mistral", "groq", "opencode"
  ]), []);

  const popularProviders = React.useMemo(
    () => filteredProviders.filter(p => POPULAR_PROVIDER_IDS.has(p.id)),
    [filteredProviders, POPULAR_PROVIDER_IDS]
  );

  const connectedProviderList = React.useMemo(() => {
    const q = providerSearch.toLowerCase();
    return providers.filter(p => p.connected && (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  }, [providers, providerSearch]);

  const otherProviders = React.useMemo(
    () => filteredProviders.filter(p => !p.connected && !popularProviders.some(pp => pp.id === p.id)),
    [filteredProviders, popularProviders]
  );

  // --- End computed variables (filteredSlashCommands & filteredContextResults below, after their state declarations) ---

  const showToast = React.useCallback((message: string, target?: HTMLElement | null) => {
    const rect = target?.getBoundingClientRect();
    const left = rect ? Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70) : window.innerWidth / 2;
    const top = rect ? Math.min(rect.bottom + 8, window.innerHeight - 42) : 74;
    setToast({ message, left, top });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 1800);
  }, []);

  const loadRecentProjects = React.useCallback(async () => {
    try {
      const list = await window.neko.getRecentProjects();
      if (Array.isArray(list) && list.length > 0) {
        setRecentProjects(list);
        return;
      }
      // Migração de registros prévios do localStorage caso o armazenamento central esteja vazio
      const legacyRaw = localStorage.getItem("nekoai.recentProjects") || localStorage.getItem("neko:recentProjects");
      if (legacyRaw) {
        try {
          const parsed = JSON.parse(legacyRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const migrated = await window.neko.saveRecentProjects(parsed);
            if (Array.isArray(migrated) && migrated.length > 0) {
              setRecentProjects(migrated);
              return;
            }
          }
        } catch {}
      }
      setRecentProjects(list || []);
    } catch {
      setRecentProjects([]);
    }
  }, []);

  const touchRecentProject = React.useCallback(async (path: string) => {
    if (!path) return;
    try {
      const updated = await window.neko.touchRecentProject(path);
      if (Array.isArray(updated)) setRecentProjects(updated);
    } catch {}
  }, []);

  const removeRecentProject = React.useCallback(async (path: string) => {
    if (!path) return;
    try {
      const updated = await window.neko.removeRecentProject(path);
      if (Array.isArray(updated)) setRecentProjects(updated);
    } catch {}
  }, []);

  const toggleFavoriteProject = React.useCallback(async (targetPath: string, e?: React.MouseEvent) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!targetPath) return;
    try {
      const updated = await window.neko.toggleFavoriteProject(targetPath);
      if (Array.isArray(updated)) setRecentProjects(updated);
    } catch {}
  }, []);

  const openRecentProject = React.useCallback(async (path: string, source = "Home") => {
    console.log("[BLACKSCREEN] openRecentProject:start", { path, source, currentProject: project, isExiting: isExitingRef.current, isSwitching: isSwitchingProjectRef.current });
    if (!path || isSwitchingProjectRef.current) { console.log("[BLACKSCREEN] openRecentProject:early-exit", { noPath: !path, alreadySwitching: isSwitchingProjectRef.current }); return; }

    // Valida se a pasta ainda existe no disco antes de tentar abrir
    const exists = await window.neko.projectExists(path);
    if (!exists) {
      showToast("Pasta não encontrada no disco: " + path);
      setRecentProjects(prev => prev.map(p => p.path === path ? { ...p, missing: true } : p));
      return false;
    }

    const insideApp = await window.neko.isInsideApplicationRoot(path).catch(() => false);
    if (insideApp) {
      console.warn("[BLACKSCREEN] openRecentProject:blocked-inside-application-root", { path });
      showToast("Este diretório faz parte do NekoAI e não pode ser usado como projeto.");
      void removeRecentProject(path);
      return;
    }
    const normalizeProjectPath = (value: string | null | undefined) =>
      String(value || "").replace(/[\\/]+$/g, "").toLowerCase();
    const activeProject = projectRef.current;
    const normalizedActive = normalizeProjectPath(activeProject);
    const normalizedTarget = normalizeProjectPath(path);
    if (activeProject && normalizedActive === normalizedTarget) {
      console.log("[BLACKSCREEN] openRecentProject:same-project-reuse", { path, activeProject });
      setModal(null);
      setProjectMenuOpen(false);
      setRecentProjectsMenuOpen(false);
      return true;
    }
    projectLoadKindRef.current = activeProject ? "switch" : "load";
    isSwitchingProjectRef.current = true;
    isExitingRef.current = true;
    setIsExiting(true);
    setStatus("starting");
    try {
      console.log("[BLACKSCREEN] openRecentProject:before-ipc", { path });
      const res = await window.neko.openProject(path, source);
      console.log("[BLACKSCREEN] openRecentProject:ipc-result", { hasResult: !!res, hasError: !!res?.error, resultPath: res?.path, hasSession: !!res?.session, hasTree: !!res?.tree, hasSupabase: !!res?.supabaseState, hasVercel: !!res?.vercelState });
      if (!res) { console.log("[BLACKSCREEN] openRecentProject:null-result"); return false; }
      if (res.error) {
        console.log("[BLACKSCREEN] openRecentProject:error-result", { error: res.error });
        showToast(res.error || "Erro ao abrir projeto");
        return false;
      }
      console.log("[BLACKSCREEN] openRecentProject:before-set-state", { targetPath: res.path || path, projectBefore: project });
      setProject(res.path || path);
      setStatus("online");
      setMessages([]);
      setSessionId(res.session?.id || "");
      setTree(res.tree || []);
      setActiveFile(null);
      setCodeChangedFile(null);
      setGithubLinkStatus({ loading: false, linkedRepo: res.gitStatus?.linkedRepo || null, branch: res.gitStatus?.branch || null });
      setSupabaseState(res.supabaseState || null);
      setVercelState(res.vercelState || null);
      setConsoleEntries([]);
      setTerminalLines([]);
      console.log("[BLACKSCREEN] openRecentProject:after-set-state", { newPath: res.path || path });
      setModal(null);
      setProjectMenuOpen(false);
      setRecentProjectsMenuOpen(false);
      return true;
    } catch (err: any) {
      console.error("[BLACKSCREEN] openRecentProject:runtime-error", err);
      showToast(err?.message || "Erro ao abrir projeto");
      return false;
    } finally {
      isSwitchingProjectRef.current = false;
      isExitingRef.current = false;
      setIsExiting(false);
      console.log("[BLACKSCREEN] openRecentProject:finally");
    }
  }, [showToast, removeRecentProject]);

  const exitProject = React.useCallback(async (source?: string) => {
    console.log("[BLACKSCREEN] exitProject:start", { source, project: projectRef.current, isExiting: isExitingRef.current });
    if (isExitingRef.current) return;
    isExitingRef.current = true;
    try {
      await window.neko.stop({ source: source || "user" }).catch(() => {});
    } catch {}
    setProject(null);
    setStatus("offline");
    setMessages([]);
    setSessionId("");
    setTree([]);
    setActiveFile(null);
    setCodeChangedFile(null);
    setConsoleEntries([]);
    setTerminalLines([]);
    setIsExiting(false);
    isExitingRef.current = false;
  }, []);

  const openOtherProject = React.useCallback(async () => {
    try {
      const chosen = await window.neko.chooseProject();
      if (chosen) {
        setRecentProjectsMenuOpen(false);
        setProjectMenuOpen(false);
        void openRecentProject(chosen, "ProjectChooser");
      }
    } catch (err) {
      console.error("[App] openOtherProject error:", err);
    }
  }, [openRecentProject]);

  const chooseNewProjectParent = React.useCallback(async () => {
    try {
      const chosen = await window.neko.chooseProject({ defaultPath: newProjectParent || undefined });
      if (chosen) setNewProjectParent(chosen);
    } catch {}
  }, [newProjectParent]);

  const confirmCreateProject = React.useCallback(async () => {
    if (!newProjectParent.trim() || !newProjectName.trim()) return;
    try {
      const sep = newProjectParent.includes("\\") ? "\\" : "/";
      const fullPath = `${newProjectParent}${sep}${newProjectName.trim()}`;
      const success = await openRecentProject(fullPath, "NewProject");
      if (success) {
        setModal(null);
        setNewProjectName("");
        setNewProjectParent("");
      }
    } catch (err) {
      console.error("[App] confirmCreateProject error:", err);
      showToast("Erro ao criar projeto");
    }
  }, [newProjectParent, newProjectName, openRecentProject, showToast]);

  const openProjectSelector = React.useCallback(() => {
    setProjectMenuOpen(v => !v);
    setRecentProjectsMenuOpen(false);
  }, []);

  const renderProjectCard = React.useCallback((item: RecentProject, source = "Home") => {
    const parentDir = getProjectParentDirectory(item.path);
    const hasValidThumb = Boolean(item.thumbnail) && !brokenThumbs.has(item.path);
    return (
      <div
        key={item.path}
        className={`home-project-card ${item.missing ? "missing-project" : ""}`}
        onClick={() => {
          if (item.missing) {
            showToast("Esta pasta não existe mais no computador.");
            return;
          }
          void openRecentProject(item.path, source);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (item.missing) {
              showToast("Esta pasta não existe mais no computador.");
              return;
            }
            void openRecentProject(item.path, source);
          }
        }}
      >
        <div className="home-project-preview-box">
          {hasValidThumb ? (
            <img
              className="home-project-real-thumb"
              src={item.thumbnail!}
              alt={`Preview de ${item.name}`}
              onError={() => setBrokenThumbs(prev => new Set(prev).add(item.path))}
            />
          ) : (
            <div className="home-project-fallback-thumb">
              <div className="fallback-glow" />
              <div className="fallback-content">
                <div className="fallback-icon-wrap">
                  <Code2 size={24} />
                </div>
                <span className="fallback-title">{item.name}</span>
                <span className={`fallback-badge ${item.missing ? "missing-badge" : ""}`}>
                  {item.missing ? "Pasta não encontrada" : (item.technology || "Projeto")}
                </span>
              </div>
            </div>
          )}
          <button
            className={`home-project-fav-btn ${item.favorite ? "favorited" : ""}`}
            onClick={e => toggleFavoriteProject(item.path, e)}
            title={item.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}
            aria-label={item.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"}
          >
            <Star size={14} fill={item.favorite ? "#a855f7" : "none"} />
          </button>
        </div>
        <div className="home-project-footer">
          <div className="home-project-info">
            <span className="home-project-name" title={item.name}>{item.name}</span>
            {parentDir ? <span className="home-project-parent" title={item.path}>{parentDir}</span> : null}
            <small className="home-project-time">{formatProjectActivity(item)}</small>
          </div>
          {item.missing ? (
            <button
              className="home-project-remove-btn"
              onClick={e => {
                e.stopPropagation();
                void removeRecentProject(item.path);
              }}
              title="Remover do histórico"
              aria-label={`Remover projeto ${item.name} do histórico`}
            >
              <Trash2 size={13} />
              <span>Remover</span>
            </button>
          ) : (
            <button
              className="home-project-open-btn"
              onClick={e => {
                e.stopPropagation();
                void openRecentProject(item.path, source);
              }}
              aria-label={`Abrir projeto ${item.name}`}
            >
              <FolderOpen size={14} />
              <span>Abrir Projeto</span>
            </button>
          )}
        </div>
      </div>
    );
  }, [openRecentProject, removeRecentProject, showToast, toggleFavoriteProject, brokenThumbs]);

  const appendTerminalLine = React.useCallback((kind: "log" | "console" | "error", text: unknown, source = "Neko") => {
    const raw = String(text ?? "").trim();
    if (!raw) return;
    let clean = raw
      .replace(/\bOpenCode\b/gi, "Neko")
      .replace(/\bMCP\b/gi, "serviço interno")
      .replace(/OPENCODE_SERVER_PASSWORD[^\n]*/gi, "Configuração interna do serviço")
      .replace(/127\.0\.0\.1:\d+/g, "servidor local")
      .replace(/https?:\/\/127\.0\.0\.1:\d+/gi, "servidor local");
    if (/^Neko$/i.test(source) && /server listening on/i.test(clean)) clean = "Ambiente local iniciado.";
    if (/^Neko$/i.test(source) && /configura[cç][aã]o interna do servi[cç]o/i.test(clean) && /warning/i.test(clean)) clean = "Configuração interna do ambiente.";
    const cleanSource = String(source || "Neko")
      .replace(/\bOpenCode\b/gi, "Neko")
      .replace(/\bMCP\b/gi, "serviço interno")
      .replace(/\bopencode\b/gi, "Neko");
    setTerminalLines(prev => {
      const last = prev[prev.length - 1];
      if (last && last.kind === kind && last.source === cleanSource && last.text === clean) return prev;
      return [...prev, { id: `${Date.now()}-${Math.random()}`, kind, text: clean, source: cleanSource }].slice(-800);
    });
  }, []);

  React.useEffect(() => {
    const body = terminalBodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distanceFromBottom < 48) body.scrollTop = body.scrollHeight;
  }, [terminalLines.length, terminalTab, terminalOpen]);

  React.useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  // ==== Console do Preview (runtime) ====
  const CONSOLE_LIMIT = 1000;
  const pushConsoleEntry = React.useCallback((level: ConsoleLevel, message: string, source?: string, url?: string) => {
    const text = String(message ?? "");
    if (!text) return;
    setConsoleEntries(prev => {
      const entry: PreviewConsoleEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        level,
        message: text,
        source: source || undefined,
        url,
        ts: Date.now()
      };
      const next = [...prev, entry];
      return next.length > CONSOLE_LIMIT ? next.slice(next.length - CONSOLE_LIMIT) : next;
    });
  }, []);

  const clearConsole = React.useCallback(() => {
    setConsoleEntries([]);
    setConsoleNewBelow(false);
    consoleAtBottomRef.current = true;
  }, []);

  const CONSOLE_LEVELS: { key: ConsoleLevel | "all"; label: string }[] = [
    { key: "all", label: "Todos" },
    { key: "log", label: "Log" },
    { key: "info", label: "Info" },
    { key: "warn", label: "Warn" },
    { key: "error", label: "Error" },
    { key: "debug", label: "Debug" }
  ];
  const consoleFiltered = React.useMemo(() => {
    const f = consoleFilter;
    const list = f === "all" ? consoleEntries : consoleEntries.filter(e => e.level === f);
    return list;
  }, [consoleEntries, consoleFilter]);
  const consoleCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: consoleEntries.length, log: 0, info: 0, warn: 0, error: 0, debug: 0 };
    for (const e of consoleEntries) counts[e.level] = (counts[e.level] ?? 0) + 1;
    return counts;
  }, [consoleEntries]);

  // Auto-scroll: acompanha o final somente se o usuário já estiver no final;
  // caso contrário mostra "novas mensagens" e não força o scroll.
  const handleConsoleScroll = React.useCallback(() => {
    const body = consoleBodyRef.current;
    if (!body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    consoleAtBottomRef.current = distance < 40;
    if (distance < 40) setConsoleNewBelow(false);
  }, []);
  const scrollConsoleToBottom = React.useCallback(() => {
    const body = consoleBodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    consoleAtBottomRef.current = true;
    setConsoleNewBelow(false);
  }, []);
  React.useEffect(() => {
    if (terminalTab !== "console" || !terminalOpen) return;
    if (consoleAtBottomRef.current) {
      const body = consoleBodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
      setConsoleNewBelow(false);
    } else if (consoleEntries.length > 0) {
      setConsoleNewBelow(true);
    }
  }, [consoleEntries.length, terminalTab, terminalOpen]);

  function shortConsoleSource(sourceId: string, line: number | undefined): string {
    const s = String(sourceId || "");
    if (!s) return "";
    try {
      const u = new URL(s);
      const file = u.pathname.split("/").pop() || s;
      return line ? `${file}:${line}` : file;
    } catch {
      const file = s.split("/").pop() || s;
      return line ? `${file}:${line}` : file;
    }
  }

  // ESC fecha o lightbox de imagem.
  React.useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxImage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxImage]);

  // Site Clone: recebe progresso do crawler no main process.
  React.useEffect(() => {
    return window.neko.onSiteCloneEvent((event) => {
      if (event?.type === "progress") {
        setCloneProgress(prev => ({
          scanned: Number(event.properties?.scanned) || prev.scanned,
          currentUrl: String(event.properties?.currentUrl || prev.currentUrl)
        }));
      }
    });
  }, []);

  // Desbloqueia o áudio no primeiro gesto do usuário (autoplay policy) para que
  // sons discretos funcionem mesmo com o app em segundo plano depois disso.
  React.useEffect(() => {
    const unlock = () => { unlockAudio(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, []);

  // Preview Page Selector keyboard navigation (arrows/Enter/Escape). Never
  // captures Tab — a future Build/Plan feature uses it.
  React.useEffect(() => {
    if (!previewRouteOpen) {
      if (previewRouteMenuFocus !== -1) setPreviewRouteMenuFocus(-1);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const len = previewRoutes.length;
      if (e.key === "Escape") {
        void setPreviewRouteMenuOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (len > 0) setPreviewRouteMenuFocus(f => (f >= len - 1 ? 0 : f + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (len > 0) setPreviewRouteMenuFocus(f => (f <= 0 ? len - 1 : f - 1));
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && previewRouteMenuFocus >= 0 && previewRoutes[previewRouteMenuFocus]) {
        e.preventDefault();
        void goToPreviewRoute(previewRoutes[previewRouteMenuFocus].path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRouteOpen, previewRoutes, previewRouteMenuFocus]);

  // Fecha o seletor ao clicar fora dele.
  const previewRouteRootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!previewRouteOpen) return;
    const onClick = (e: MouseEvent) => {
      const root = previewRouteRootRef.current;
      if (root && !root.contains(e.target as Node)) void setPreviewRouteMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [previewRouteOpen]);

  // Fecha o menu Build/Plan ao clicar fora ou pressionar Escape. Nunca captura
  // Tab globalmente — o atalho só age dentro do textarea do composer.
  const chatModeAnchorRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!chatModeMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChatModeMenuOpen(false); };
    const onClick = (e: MouseEvent) => {
      const host = chatModeAnchorRef.current;
      if (host && !host.contains(e.target as Node)) setChatModeMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [chatModeMenuOpen]);

  // Seletor de projetos: ao abrir o dropdown, esconde a view nativa do Preview
  // (WebContentsView é pintada acima de TODO o DOM). Restaura ao fechar.
  const anyProjectMenuOpen = projectMenuOpen || recentProjectsMenuOpen;
  React.useEffect(() => {
    window.neko.setInternalPreviewOverlay(anyProjectMenuOpen).catch(() => {});
  }, [anyProjectMenuOpen]);

  const pendingPlanTaskRef = React.useRef<string | null>(null);
  const providersGenerationRef = React.useRef(0);

  // ESC na página de Tutoriais fecha o modal. Não afeta outros modais/atalhos.
  React.useEffect(() => {
    if (modal !== "tutorials") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setModal(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  const selectedModelRef = React.useRef<{ providerID: string; modelID: string } | undefined>(undefined);
  // Where the current model selection came from. Only an explicit user pick
  // is persisted; automatic fallbacks never overwrite the saved model.
  const modelPickSourceRef = React.useRef<"user" | "restored" | "fallback" | "none">("none");
  // True while the engine is inside a retry cycle. Keeps the status text on
  // "Ajustando a execução" instead of letting busy erase the retry fact.
  const retryActiveRef = React.useRef(false);
  // Internal id of the task currently in flight, returned by the main process
  // when the prompt is accepted. Used to correlate session.idle events with
  // the task that produced them (idle of task A never concludes task B).
  const currentTaskIdRef = React.useRef<string | null>(null);
  // True while the main process is running the Vision Fallback analysis
  // (MiMo V2.5 Free) BEFORE the main prompt is accepted. While pending, the
  // session is intentionally idle and the fallback watchdog must never
  // conclude the task.
  const visionFallbackPendingRef = React.useRef(false);
  // Mirrors pendingPlan for the event handler without re-subscribing it.
  const pendingPlanRef = React.useRef(false);
  React.useEffect(() => { pendingPlanRef.current = Boolean(pendingPlan); }, [pendingPlan]);
  // True while a Plan request is still awaiting its response in the main
  // process. A completed state for the plan task must not conclude anything:
  // the plan approval card owns the flow.
  const planAwaitingRef = React.useRef(false);
  // Terminal state of the current task. Once "completed", "cancelled" or
  // "failed", delayed SSE events (idle/working/retry/tool/file/command) must
  // NOT re-introduce busy or working status. A new task resets it to "running".
  // waiting_for_user / waiting_for_approval are NOT terminal: the task is
  // paused waiting for the user and resumes on the same agent session.
  const taskPhaseRef = React.useRef<"none" | "running" | "waiting_for_user" | "waiting_for_approval" | "completed" | "cancelled" | "failed">("none");
  const isTaskTerminal = React.useCallback(() => {
    return taskPhaseRef.current === "completed" || taskPhaseRef.current === "cancelled" || taskPhaseRef.current === "failed";
  }, []);
  const isTaskRunning = React.useCallback(() => {
    return taskPhaseRef.current === "running";
  }, []);
  React.useEffect(() => { busyRef.current = busy; }, [busy]);
  React.useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  React.useEffect(() => {
    selectedModelRef.current = selectedModel;
    // Never persist automatic fallbacks: they would silently replace the
    // model the user actually chose.
    if (!selectedModel || modelPickSourceRef.current !== "user") return;
    try {
      localStorage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        updatedAt: Date.now()
      }));
    } catch {}
  }, [selectedModel]);
  React.useEffect(() => {
    try { localStorage.setItem(EFFORT_STORAGE_KEY, effort); } catch {}
  }, [effort]);

  React.useEffect(() => {
    if (effectiveSupabaseView === "create" && !newSupabaseProjectOrg && supabaseState.organizations && supabaseState.organizations.length > 0) {
      setNewSupabaseProjectOrg(supabaseState.organizations[0].id);
    }
  }, [effectiveSupabaseView, newSupabaseProjectOrg, supabaseState.organizations]);

  const [slashCommands, setSlashCommands] = React.useState<SlashCommand[]>([]);
  const [showSlashMenu, setShowSlashMenu] = React.useState(false);
  const [contextResults, setContextResults] = React.useState<string[]>([]);
  const [showContextMenu, setShowContextMenu] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = React.useRef<HTMLDivElement | null>(null);
  const previousContentHeight = React.useRef(0);
  const [homeView, setHomeView] = React.useState<"home" | "allProjects">("home");
  const [projectSearchQuery, setProjectSearchQuery] = React.useState("");

  // Sistema de Autocomplete inteligente (/ comandos e @ contextos)
  const [autocompleteTrigger, setAutocompleteTrigger] = React.useState<TriggerMatch | null>(null);
  const [autocompleteMode, setAutocompleteMode] = React.useState<AutocompleteMode | null>(null);
  const [autocompleteQuery, setAutocompleteQuery] = React.useState<string>("");
  const [autocompleteSelectedIndex, setAutocompleteSelectedIndex] = React.useState<number>(0);

  const projectItems = React.useMemo(() => extractProjectItems(tree), [tree]);

  const autocompleteItems = React.useMemo(() => {
    if (!autocompleteMode) return [];
    if (autocompleteMode === "commands") {
      return filterCommands(autocompleteQuery);
    }
    if (autocompleteMode === "contexts") {
      return filterContexts(autocompleteQuery);
    }
    if (autocompleteMode === "files") {
      return filterProjectItems(projectItems.files, autocompleteQuery);
    }
    if (autocompleteMode === "folders") {
      return filterProjectItems(projectItems.folders, autocompleteQuery);
    }
    return [];
  }, [autocompleteMode, autocompleteQuery, projectItems]);

  const handleAutocompleteSelect = React.useCallback((item: ChatCommand | ChatContext | ProjectItem) => {
    if (!composerRef.current) return;
    const textarea = composerRef.current;
    const currentText = textarea.value;
    const cursor = textarea.selectionStart ?? currentText.length;

    // Se selecionou @file ou @folder, transiciona o menu para arquivos ou pastas do projeto
    if ("isPicker" in item && item.isPicker) {
      if (item.pickerType === "file") {
        setAutocompleteMode("files");
        setAutocompleteQuery("");
        setAutocompleteSelectedIndex(0);
        textarea.focus();
        return;
      }
      if (item.pickerType === "folder") {
        setAutocompleteMode("folders");
        setAutocompleteQuery("");
        setAutocompleteSelectedIndex(0);
        textarea.focus();
        return;
      }
    }

    const trigger = autocompleteTrigger || detectAutocompleteTrigger(currentText, cursor);
    if (!trigger) {
      setAutocompleteMode(null);
      setAutocompleteTrigger(null);
      return;
    }

    let insertionText = "";
    if ("command" in item) {
      insertionText = item.command;
    } else if ("context" in item) {
      insertionText = item.context;
    } else if ("path" in item) {
      insertionText = `@${item.path}`;
    }

    if (!insertionText) return;

    const { newText, newCursor } = applyAutocompleteSelection(currentText, trigger, insertionText);
    setInput(newText);
    setAutocompleteMode(null);
    setAutocompleteTrigger(null);
    setAutocompleteQuery("");
    setAutocompleteSelectedIndex(0);

    requestAnimationFrame(() => {
      if (composerRef.current) {
        composerRef.current.focus();
        composerRef.current.setSelectionRange(newCursor, newCursor);
      }
    });
  }, [autocompleteTrigger]);

  const filteredSlashCommands = React.useMemo(() => {
    const q = input.startsWith("/") ? input.slice(1).toLowerCase() : "";
    return q ? slashCommands.filter(c => (c.name || "").toLowerCase().includes(q)) : slashCommands;
  }, [slashCommands, input]);

  const filteredContextResults = contextResults;

  React.useEffect(() => {
    void loadRecentProjects();
    const unsub = window.neko.onRecentProjectsUpdated?.((updated: RecentProject[]) => {
      if (Array.isArray(updated)) {
        setRecentProjects(updated);
      }
    });
    return () => { unsub?.(); };
  }, [loadRecentProjects]);

  React.useEffect(() => {
    if (!project) return;
    let alive = true;
    const checkProject = async () => {
      try {
        if (!alive || isSwitchingProjectRef.current || isExitingRef.current || projectRef.current !== project) return;
        const exists = await window.neko.projectExists(project);
        if (!alive || exists || isSwitchingProjectRef.current || isExitingRef.current || projectRef.current !== project) return;
        const missingPath = project;
        console.warn("[ProjectSwitch] checkProject: projeto não encontrado no disco:", missingPath);
        console.warn("[BLACKSCREEN] checkProject:missing-project", { missingPath, project: projectRef.current });
        await removeRecentProject(missingPath);
        if (alive && projectRef.current === missingPath) {
          void exitProject("checkProjectMissing");
        }
      } catch {}
    };
    const timer = window.setInterval(() => void checkProject(), 3000);
    void checkProject();
    return () => { alive = false; window.clearInterval(timer); };
  }, [project]);

  React.useEffect(() => {
    let alive = true;
    const syncGithubContext = async () => {
      try {
        const git = await window.neko.githubGitStatus();
        if (!alive) return;
        setGithubLinkStatus(git);
        if (git.linkedRepo) {
          const names = await window.neko.githubListBranches(git.linkedRepo);
          if (!alive) return;
          const filtered = Array.from(new Set(names.filter((name: string) => name && name !== "origin" && name !== "HEAD" && name !== "origin/HEAD")));
          setGithubBranches(filtered.length ? filtered : [git.branch || "main"]);
        } else {
          setGithubBranches(git.branch ? [git.branch] : []);
        }
      } catch {
        if (alive) {
          setGithubLinkStatus({ initialized: false, branch: null, remote: null, linkedRepo: null, dirty: false });
          setGithubBranches([]);
        }
      }
    };
    void syncGithubContext();
    return () => { alive = false; };
  }, [project]);

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (modal) {
        if (target.closest(".modal")) return;
        setModal(null);
        return;
      }

      if (!target.closest(".project-selector-wrap")) {
        setProjectMenuOpen(false);
        setRecentProjectsMenuOpen(false);
      }
      if (!target.closest(".model-anchor")) {
        setModelOpen(false);
      }
      if (!target.closest(".top-branch-wrap") && !target.closest(".branch-picker-wrap")) {
        setGithubBranchMenuOpen(false);
      }
      if (!target.closest(".composer")) {
        setShowSlashMenu(false);
        setShowContextMenu(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [modal]);

  React.useEffect(() => {
    if (!modal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (modal === "providerAuth") {
          setModal("providers");
          setAuthError("");
        } else if (modal === "providers") {
          setModal("models");
          setAuthError("");
        } else if (modal === "githubClone" || modal === "githubPublish" || modal === "githubLink" || modal === "githubDevice") {
          if (modal === "githubDevice") {
            void window.neko.githubCancel?.().catch(() => {});
            setGithubDevice(null);
          }
          setModal("github");
          setGithubError("");
          setGithubBusy(false);
        } else {
          setModal(null);
          setAuthError("");
          setGithubError("");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [modal]);

  React.useEffect(() => {
    window.neko.commands().then(result => setSlashCommands(Array.isArray(result) ? result : [])).catch(() => setSlashCommands([]));
  }, []);

  React.useEffect(() => {
    window.neko.githubStatus().then(result => setGithubStatus(result || { connected: false, repos: [] })).catch(() => setGithubStatus({ connected: false, repos: [] }));
    return window.neko.onGithubEvent((event:any) => {
      if (event?.type === "github.connected") {
        setGithubStatus(event.properties || { connected: true, repos: [] });
        setGithubBusy(false);
        setGithubDevice(null);
        setGithubError("");
        setModal("github");
      }
      if (event?.type === "github.cancelled") {
        setGithubBusy(false);
        setGithubDevice(null);
      }
      if (event?.type === "github.error") {
        setGithubBusy(false);
        setGithubError(String(event.properties?.message || "Falha na conexão com o GitHub."));
      }
    });
  }, []);

  React.useEffect(() => {
    window.neko.supabaseGetState().then((s: any) => { if (s) setSupabaseState(s); }).catch(() => {});
    return window.neko.onSupabaseStateChange((s: any) => {
      if (s) setSupabaseState(s);
    });
  }, []);

  React.useEffect(() => {
    window.neko.vercelGetState().then((s: any) => { if (s) setVercelState(s); }).catch(() => {});
    const unsubState = window.neko.onVercelStateChange((s: any) => {
      if (s) setVercelState(s);
    });
    const unsubLog = window.neko.onVercelLog((log: string) => {
      setVercelLogs(prev => [...prev.slice(-19), log]);
    });
    return () => {
      unsubState();
      unsubLog();
    };
  }, []);

  React.useEffect(() => {
    if (modal === "vercel" && !vercelState.linked && project) {
      const folderName = project.split(/[/\\]/).filter(Boolean).pop() || "";
      const suggested = slugifyVercelProjectName(folderName);
      setVercelProjectName((prev) => (prev ? prev : suggested));
    }
  }, [modal, vercelState.linked, project]);

  const addAttachmentResult = React.useCallback((result:any) => {
    const items=Array.isArray(result?.items)?result.items:[]; const errors=Array.isArray(result?.errors)?result.errors:[];
    setAttachments(prev=>[...prev,...items].slice(0,10));
    if(errors.length) setUploadErrors(prev=>[...prev,...errors.map((e:any)=>({id:`upload:${Date.now()}:${Math.random()}`,name:String(e.name??"Arquivo"),message:String(e.message??"Falha no Upload"),extension:String(e.extension??"FILE")}))].slice(-6));
    composerRef.current?.focus();
  },[]);

  const handlePickAttachments = React.useCallback(async () => {
    try { addAttachmentResult(await window.neko.pickAttachments()); }
    catch(error){ setUploadErrors(prev=>[...prev,{id:`upload:${Date.now()}`,name:"Arquivo",message:String(error),extension:"FILE"}].slice(-6)); }
  },[addAttachmentResult]);

  const handlePaste = React.useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items=Array.from(event.clipboardData.items||[]); const image=items.find(item=>item.kind==="file"&&item.type.startsWith("image/"));
    if(!image) return; const file=image.getAsFile(); if(!file) return; event.preventDefault();
    const reader=new FileReader(); reader.onload=async()=>{
      try { const result=await window.neko.saveClipboardImage(String(reader.result),file.type);
        if(result?.item) setAttachments(prev=>[...prev,result.item].slice(0,10));
        if(result?.error) setUploadErrors(prev=>[...prev,{id:`paste:${Date.now()}`,name:String(result.error.name??"Imagem"),message:String(result.error.message??"Falha no Upload"),extension:String(result.error.extension??"IMG")}].slice(-6));
      } catch(error){ setUploadErrors(prev=>[...prev,{id:`paste:${Date.now()}`,name:"Imagem",message:String(error),extension:"IMG"}].slice(-6)); }
    }; reader.readAsDataURL(file);
  },[]);

  const upsertActivity = React.useCallback((entry: Omit<Activity, "ts"> & { ts?: number }) => {
    const nextEntry: Activity = { ...entry, ts: entry.ts ?? Date.now() };
    setActivity(prev => {
      const index = prev.findIndex(item => item.id === nextEntry.id);
      const next = index === -1 ? [...prev, nextEntry] : prev.map((item, i) => i === index ? { ...item, ...nextEntry, ts: item.ts } : item);
      return next.sort((a, b) => a.ts - b.ts).slice(-12);
    });
  }, []);

  const finishActivity = React.useCallback((ids?: string[]) => {
    setActivity(prev => prev.map(item => {
      if (!ids || ids.includes(item.id)) {
        return item.state === "running" ? { ...item, state: "done", icon: "check" as const } : item;
      }
      return item;
    }));
  }, []);

  const sanitizeUserFacingText = React.useCallback((value: unknown) => {
    let text = String(value ?? "").trim();
    if (!text) return "O Neko encontrou um problema ao executar esta tarefa.";

    // Internal engine terminology must never leak into the Neko UI.
    text = text
      .replace(/OpenCode/gi, "Neko")
      .replace(/MCP server/gi, "serviço interno")
      .replace(/MCP/gi, "serviço interno")
      .replace(/external_directory/gi, "acesso aos arquivos do projeto")
      .replace(/permission\.asked/gi, "solicitação de acesso")
      .replace(/permission\.replied/gi, "resposta de acesso")
      .replace(/tool\.execute\.(before|after)/gi, "ação interna")
      .replace(/\bprompt_async\b/gi, "execução da tarefa")
      .replace(/127\.0\.0\.1:\d+/g, "servidor local")
      .replace(/https?:\/\/127\.0\.0\.1:[^\s]+/gi, "servidor local");

    // The engine can return several text parts for one assistant message.
    // Some models emit an English progress/confirmation part followed by the
    // actual Portuguese answer. Never concatenate those parts: that is what
    // previously produced bilingual bubbles in the Neko chat.
    const paragraphs = text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
    if (paragraphs.length > 1) {
      const ptWords = /\b(o|a|os|as|um|uma|uns|umas|de|do|da|dos|das|para|por|com|sem|em|no|na|nos|nas|que|se|foi|foram|está|estão|foi|foram|alterei|alterado|alteração|arquivo|arquivos|projeto|tarefa|concluída|concluído|agora|botão|botões|link|links|feito|feita|pronto|pronta|sucesso)\b/gi;
      const enWords = /\b(the|this|that|has|have|been|was|were|is|are|changed|change|updated|successfully|task|complete|completed|file|files|project|button|buttons|link|links|now|confirmed|done)\b/gi;
      const scored = paragraphs.map(part => {
        const pt = (part.match(ptWords) || []).length;
        const en = (part.match(enWords) || []).length;
        return { part, pt, en };
      });
      const hasPortuguese = scored.some(item => item.pt >= 1 && item.pt >= item.en);
      if (hasPortuguese) {
        const portugueseParts = scored.filter(item => item.pt >= item.en || item.en === 0).map(item => item.part);
        if (portugueseParts.length) text = portugueseParts.join("\n\n");
      }
    }

    return text;
  }, []);

  const displayPath = React.useCallback((value: unknown) => {
    const raw = String(value ?? "").trim().replace(/\\/g, "/");
    if (!raw) return "arquivo do projeto";
    const projectPath = String(project ?? "").replace(/\\/g, "/").replace(/\/$/, "");
    if (projectPath && raw.toLowerCase().startsWith((projectPath + "/").toLowerCase())) {
      return raw.slice(projectPath.length + 1);
    }
    const marker = "/src/";
    const srcIndex = raw.toLowerCase().indexOf(marker);
    if (srcIndex >= 0) return raw.slice(srcIndex + 1);
    return raw.replace(/^\.\//, "");
  }, [project]);

  // File events under .neko/ are internal Neko/Preview bookkeeping (thumbnail,
  // runtime metadata), never agent edits: they must not show up as activity
  // or change the working status, file tree or recent-projects list.
  const isNekoInternalPath = React.useCallback((value: unknown) => {
    const p = String(value ?? "").trim().replace(/\\/g, "/");
    return p.split("/").some((segment) => segment === ".neko");
  }, []);

  const describeToolActivity = React.useCallback((toolValue: unknown, inputValue?: unknown) => {
    const tool = String(toolValue ?? "").toLowerCase();
    const input = (inputValue && typeof inputValue === "object") ? inputValue as Record<string, unknown> : {};
    const file = input.filePath ?? input.filepath ?? input.path ?? input.filename ?? input.file;
    const pathText = file ? displayPath(file) : "";

    if (["edit", "write", "patch", "apply_patch", "multiedit"].some(name => tool.includes(name))) {
      return pathText ? `Editando ${pathText}...` : "Editando os arquivos do projeto...";
    }
    if (["read", "cat", "view"].some(name => tool === name || tool.includes(name))) {
      return pathText ? `Analisando ${pathText}...` : "Analisando os arquivos do projeto...";
    }
    if (["grep", "search", "glob", "find", "ls", "list"].some(name => tool.includes(name))) {
      return "Analisando os arquivos do projeto...";
    }
    if (["bash", "shell", "terminal", "command", "exec"].some(name => tool.includes(name))) {
      const command = String(input.command ?? input.cmd ?? "").toLowerCase();
      if (/\b(test|vitest|jest|playwright|cypress)\b/.test(command)) return "Executando os testes...";
      if (/\b(build|tsc|vite build|npm run build)\b/.test(command)) return "Verificando a compilação do projeto...";
      if (/\b(install|npm i|pnpm i|yarn add|bun add)\b/.test(command)) return "Configurando as dependências...";
      return "Executando uma ação no projeto...";
    }
    if (tool.includes("task") || tool.includes("agent")) return "Executando uma etapa do projeto...";
    return "Trabalhando no projeto...";
  }, [displayPath]);

  const getEffectiveModel = React.useCallback((base: { providerID: string; modelID: string } | undefined) => {
    if (!base) return undefined;
    const catalog = models.find(m => m.providerID === base.providerID && m.modelID === base.modelID);
    const variant = effort.toLowerCase();
    if (catalog?.variants?.includes(variant)) return { ...base, variant };
    return base;
  }, [models, effort]);

  const planPreview = React.useCallback((text: string, limit = 420) => {
    const normalized = text.replace(/\r/g, "").trim();
    if (normalized.length <= limit) return normalized;
    const cut = normalized.slice(0, limit);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    return (lastBreak > 180 ? cut.slice(0, lastBreak + (cut[lastBreak] === "." ? 1 : 0)) : cut).trimEnd() + "…";
  }, []);


  React.useLayoutEffect(() => {
    const container = messagesRef.current;
    if (!container) return;

    // Always keep the latest user/agent activity visible.
    // requestAnimationFrame lets the browser finish layout before scrolling.
    const frame = window.requestAnimationFrame(() => {
      const target = container.scrollHeight;
      const wasGrowing = target !== previousContentHeight.current;
      previousContentHeight.current = target;
      if (wasGrowing || busy) {
        container.scrollTo({ top: target, behavior: "smooth" });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [messages, activity, busy]);

  const loadProviders = React.useCallback(async (source: string = "unknown") => {
    const requestId = `p${(++providersGenerationRef.current).toString(36)}`;
    const pGen = providersGenerationRef.current;
    console.log(`[Providers] request request-source=${source} requestId=${requestId} project=${projectRef.current ?? "none"} session=${sessionIdRef.current ?? "none"}`);
    try {
      const result = await Promise.race([
        window.neko.providers(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 7000))
      ]);
      if (!result || pGen !== providersGenerationRef.current) {
        console.log(`[Providers] response-dropped requestId=${requestId} source=${source} reason=${!result ? "timeout" : "stale-generation"}`);
        return null;
      }

      const providerCount = (result.providers || []).length;
      if (providerCount === 0 && projectRef.current && (isSwitchingProjectRef.current || isExitingRef.current)) {
        return null;
      }

      console.log(`[Providers] response requestId=${requestId} source=${source} providers=${providerCount} models=${(result.models || []).length}`);

      setModels(result.models || []);
      setManagedModels(result.managedModels || result.models || []);
      setProviders(result.providers || []);

      const availableModels = (result.models || []).filter((m: Model) => m.connected && m.enabled);
      let savedModel: { providerID: string; modelID: string } | undefined;
      try {
        const raw = localStorage.getItem(LAST_MODEL_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
            savedModel = { providerID: parsed.providerID, modelID: parsed.modelID };
          }
        }
      } catch {}

      // Restore the user's last model whenever the provider catalog becomes
      // available (including after opening a project). Only restore it when
      // that exact provider/model is still connected and enabled.
      const restored = savedModel && availableModels.some((m: Model) =>
        m.providerID === savedModel!.providerID && m.modelID === savedModel!.modelID
      ) ? savedModel : undefined;
      const current = selectedModelRef.current;
      const currentIsAvailable = current && availableModels.some((m: Model) =>
        m.providerID === current!.providerID && m.modelID === current!.modelID
      );
      const userPicked = modelPickSourceRef.current === "user";

      // Never override an explicit user pick. Otherwise restore the saved
      // model when it becomes available, and only use the first catalog
      // model as an explicit, logged fallback of last resort.
      if (!userPicked && (!currentIsAvailable || (modelPickSourceRef.current === "fallback" && restored))) {
        let next: { providerID: string; modelID: string } | undefined;
        let source: "restored" | "fallback" | "none" = "none";
        if (restored) {
          next = restored;
          source = "restored";
          console.log(`[Neko/Model] restaurando modelo salvo ${restored.providerID}/${restored.modelID}`);
        } else if (availableModels[0]) {
          next = { providerID: availableModels[0].providerID, modelID: availableModels[0].modelID };
          source = "fallback";
          console.warn(`[Neko/Model] fallback automático: ${next.providerID}/${next.modelID} será usado porque a seleção anterior não está conectada/ativada.`);
        }
        modelPickSourceRef.current = source;
        if (!(next && current && next.providerID === current.providerID && next.modelID === current.modelID)) {
          setSelectedModel(next);
        }
      }
      return result;
    } catch {
      return null;
    }
  }, []);

  const formatTaskDuration = React.useCallback((durationMs: number) => {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }, []);

  const syncSessionOutput = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      const history = await window.neko.messages(sessionId);
      const entries = Array.isArray(history) ? history : [];
      const assistantEntries = entries.filter((entry: any) => entry?.info?.role === "assistant" || entry?.role === "assistant");
      const latest = assistantEntries[assistantEntries.length - 1];
      const parts = latest?.parts ?? [];
      const textParts = parts.map((part: any) => String(part?.text ?? "").trim()).filter(Boolean);
      // Prefer the final assistant text part. OpenCode may expose an internal
      // progress/confirmation text part before the actual user-facing answer.
      // Concatenating both is the source of mixed English/Portuguese replies.
      const rawText = textParts.length ? textParts[textParts.length - 1] : "";
      const text = rawText ? sanitizeUserFacingText(rawText) : "";
      if (text) {
        const activeTask = activeTaskRef.current;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.text === text) return prev;
          const durationMs = activeTask ? Math.max(0, Date.now() - activeTask.startedAt) : undefined;
          return [...prev, { role: "assistant", text, taskId: activeTask?.id, durationMs, createdAt: Date.now() }];
        });
        if (activeTask) activeTaskRef.current = null;
      }
      const nextTree = await window.neko.tree();
      setTree(nextTree);
    } catch {}
  }, [sessionId, sanitizeUserFacingText]);

  // Bounded auto-repair dispatch. It owns the full task lifecycle (busy,
  // in-flight, taskId correlation) so the completion protocol can always
  // conclude the repair cycle. Never dispatched while another request is
  // already in flight.
  const dispatchRepairPrompt = React.useCallback(async (diagnostic: string, title: string) => {
    if (!sessionId || requestInFlightRef.current || validationRunningRef.current) return false;
    requestInFlightRef.current = true;
    requestObservedBusyRef.current = false;
    currentTaskIdRef.current = null;
    taskPhaseRef.current = "running";
    retryActiveRef.current = false;
    setRepairState("awaiting-fix");
    setBusy(true);
    setWorkingStatus(`Corrigindo o projeto (tentativa ${repairAttemptsRef.current}/3)...`);
    upsertActivity({ id: "auto-repair", icon: "error", title, detail: "O Neko encontrou um problema e está corrigindo automaticamente.", state: "running" });
    try {
      const repairResult = await window.neko.prompt(sessionId, `A validação automática encontrou um problema no projeto. NÃO encerre a tarefa. Corrija diretamente os arquivos e continue até o projeto funcionar.\n\nDiagnóstico técnico:\n${diagnostic}\n\nDepois de corrigir, verifique novamente o Preview e o build.`, getEffectiveModel(selectedModel), [], [], false, effort);
      if (repairResult?.taskId) {
        currentTaskIdRef.current = String(repairResult.taskId);
        console.log(`[TaskLifecycle] repair:accepted taskId=${repairResult.taskId}`);
      }
      setRepairState("awaiting-preview-update");
      return true;
    } catch (error) {
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      retryActiveRef.current = false;
      taskPhaseRef.current = "failed";
      setBusy(false);
      setWorkingStatus("");
      setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
      setRepairState("idle");
      return false;
    }
  }, [sessionId, selectedModel, effort, upsertActivity, getEffectiveModel, sanitizeUserFacingText]);

  const runTaskValidation = React.useCallback(async () => {
    if (!sessionId || validationRunningRef.current) return;
    
    // Se estamos aguardando fix do agent, não iniciamos nova validação
    if (repairState === "awaiting-fix" || repairState === "awaiting-preview-update") {
      console.log(`[Neko/PreviewDiag] validation skipped - repair in progress (${repairState})`);
      return;
    }
    
    // Se estamos validando após correção, log
    const isRepairValidation = repairState === "validating";
    if (isRepairValidation) {
      console.log("[Neko/PreviewDiag] validation-start after repair");
    }
    
    validationRunningRef.current = true;
    setBusy(true);
    setWorkingStatus(isRepairValidation ? "Validando correção..." : "Validando o projeto...");
    
    try {
      previewRuntimeErrorRef.current = null;
      const preview = await window.neko.startPreview().catch(error => ({ status: "error", message: String(error?.message ?? error) } as any));
      await new Promise(resolve => window.setTimeout(resolve, 700));
      const build = await window.neko.validateBuild().catch(error => ({ ok: false, skipped: false, message: String(error?.message ?? error), output: "" }));
      const previewFailed = preview?.status === "error" || Boolean(previewRuntimeErrorRef.current);
      const buildFailed = build?.ok === false;
      
      if (previewFailed || buildFailed) {
        if (repairAttemptsRef.current < 3) {
          repairAttemptsRef.current += 1;
          const previewDiagnostic = previewFailed ? String(previewRuntimeErrorRef.current || preview?.message || "O Preview não conseguiu iniciar.") : "";
          const buildDiagnostic = buildFailed ? String(build?.output || build?.message || "O build encontrou erros.").slice(-8000) : "";
          const diagnostic = [previewDiagnostic && `PREVIEW:\n${previewDiagnostic}`, buildDiagnostic && `BUILD:\n${buildDiagnostic}`].filter(Boolean).join("\n\n");
          await dispatchRepairPrompt(diagnostic, "Problema encontrado na validação");
          return;
        }
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        setMessages(prev => [...prev, { role: "error", text: "O Neko encontrou um problema na validação final após várias tentativas de correção. Revise os detalhes na aba Erros." }]);
        setRepairState("idle");
      } else {
        // Validação passou - limpa estado de reparo
        repairAttemptsRef.current = 0;
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        if (currentErrorSignature) {
          console.log(`[Neko/PreviewDiag] validation-passed signature=${currentErrorSignature} cleared`);
          attemptedErrorSignaturesRef.current.delete(currentErrorSignature);
          setCurrentErrorSignature(null);
        }
        setRepairState("idle");
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        setWorkingStatus("Projeto validado.");
        upsertActivity({ id: "validation", icon: "check", title: "Projeto validado", detail: "Build e Preview verificados.", state: "done" });
      }
    } catch (error) {
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      setMessages(prev => [...prev, { role: "error", text: `Falha na validação final: ${sanitizeUserFacingText(error instanceof Error ? error.message : error)}` }]);
      setRepairState("idle");
    } finally {
      validationRunningRef.current = false;
      if (!requestInFlightRef.current) {
        setBusy(false);
        setWorkingStatus("");
      }
    }
  }, [sessionId, selectedModel, effort, repairState, dispatchRepairPrompt, sanitizeUserFacingText, upsertActivity]);

  // Conclusion is driven by the main-process task state machine
  // (neko.task.state = completed). The renderer only reacts: clear busy,
  // sync the assistant answer and run the wrap-up validation. The repair
  // attempt counter is intentionally NOT reset here — it is reset only when
  // a NEW user task starts, so a failing validation can never loop forever.
  const concludeCurrentTask = React.useCallback((state: "completed" | "cancelled" = "completed") => {
    if (taskPhaseRef.current === state) return;
    const beforePhase = taskPhaseRef.current;
    // Terminal state: from now on, delayed events cannot re-introduce busy.
    taskPhaseRef.current = state;
    // Aviso sonoro: conclusão REAL da tarefa (não para cancelamento/plan).
    if (state === "completed") {
      notifyOnce("task-complete", String(currentTaskIdRef.current || "done"));
    }
    retryActiveRef.current = false;
    if (completionTimer.current) { window.clearTimeout(completionTimer.current); completionTimer.current = null; }
    requestInFlightRef.current = false;
    requestObservedBusyRef.current = false;
    // Limpa estado de reparo ao concluir tarefa com sucesso
    if (currentErrorSignature) {
      console.log(`[Neko/PreviewDiag] task ${state} - clearing error signature=${currentErrorSignature}`);
      attemptedErrorSignaturesRef.current.delete(currentErrorSignature);
      setCurrentErrorSignature(null);
    }
    setRepairState("idle");
    setBusy(false);
    setWorkingStatus("");
    finishActivity();
    console.log(`[TaskLifecycle] concludeCurrentTask called state=${state} taskId=${currentTaskIdRef.current ?? "-"} phase-before=${beforePhase} phase-after=${state} -> renderer:setBusy(false)`);
    if (state === "completed") {
      void syncSessionOutput();
      // Final validation is a wrap-up, NOT a gate: the UI is already in the
      // concluded state. It manages its own busy and may trigger bounded
      // auto-repair.
      if (!validationRunningRef.current) {
        void runTaskValidation();
      }
    }
  }, [finishActivity, syncSessionOutput, runTaskValidation, currentErrorSignature]);

  // Authoritative task states coming from the main-process state machine.
  // The agent cycle (running -> question/approval -> running -> completed)
  // is fully owned by the engine; this handler only mirrors it in the UI.
  const applyTaskState = React.useCallback((state: string, props: any) => {
    const sessionID = String(props?.sessionID ?? "");
    if (sessionID && sessionIdRef.current && sessionID !== sessionIdRef.current) return;
    if (state === "running") {
      if (isTaskTerminal()) return;
      if (taskPhaseRef.current === "running") return;
      taskPhaseRef.current = "running";
      retryActiveRef.current = false;
      setBusy(true);
      setWorkingStatus(prev => (prev && prev.startsWith("Falha temporária") ? prev : "Neko está trabalhando..."));
      return;
    }
    if (state === "waiting_for_user") {
      if (isTaskTerminal()) return;
      taskPhaseRef.current = "waiting_for_user";
      setBusy(false);
      const isPlan = Boolean(props?.isPlanApproval);
      setWorkingStatus(isPlan ? "Neko elaborou um plano e aguarda sua aprovação" : "Neko precisa de uma resposta");
      const questionId = String(props?.questionId ?? "");
      const requestId = props?.requestId ? String(props.requestId) : undefined;

      if (isPlan) {
        if (questionId && !handledQuestionIdsRef.current.has(questionId)) {
          handledQuestionIdsRef.current.add(questionId);
          planAwaitingRef.current = true;
          // Capture the last assistant message or props.question for the plan summary
          const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
          const planText = String(lastAssistant?.text || props?.question || "Plano de implementação concluído e pronto para revisão.").trim();
          const pendingPlanObj: PendingPlan = {
            request: String(props?.request || lastAssistant?.text || "Plano de implementação"),
            attachments: [],
            contextPaths: [],
            planText,
            messageCreatedAt: Date.now(),
            requestId,
            taskId: String(props?.taskId ?? currentTaskIdRef.current ?? ""),
            sessionID
          };
          pendingPlanTaskRef.current = String(props?.taskId ?? currentTaskIdRef.current ?? "");
          setPendingPlan(pendingPlanObj);
          upsertActivity({ id: `plan:${questionId}`, icon: "wait", title: "Plano pronto para revisão", detail: "Revise o plano antes de permitir as alterações no projeto.", state: "running" });
          notifyOnce("plan", `plan:${questionId}`);
          console.log(`[TaskLifecycle] state=waiting_for_user (plan) taskId=${props?.taskId ?? "-"} requestId=${requestId || "-"}`);
        }
        return;
      }

      if (questionId && !handledQuestionIdsRef.current.has(questionId)) {
        handledQuestionIdsRef.current.add(questionId);
        const question: AgentQuestion = {
          taskId: String(props?.taskId ?? ""),
          sessionID,
          questionId,
          question: String(props?.question ?? "").trim(),
          options: Array.isArray(props?.options) ? props.options.map((o: any) => String(o)) : [],
          allowFreeText: props?.allowFreeText !== false,
          requestId,
          isNativeTool: Boolean(props?.isNativeTool)
        };
        pendingQuestionRef.current = question;
        setPendingQuestion(question);
        if (question.question) {
          // The question belongs to the conversation history.
          setMessages(prev => [...prev, { role: "assistant", text: question.question, createdAt: Date.now() }]);
        }
        upsertActivity({ id: `question:${questionId}`, icon: "wait", title: "O Neko precisa de uma informação", detail: "Responda no campo de mensagem para continuar a tarefa.", state: "running" });
        // Aviso sonoro de pergunta (deduplicado por questionId).
        notifyOnce("question", `q:${questionId}`);
      }
      console.log(`[TaskLifecycle] state=waiting_for_user taskId=${props?.taskId ?? "-"} questionId=${questionId || "-"}`);
      return;
    }
    if (state === "waiting_for_approval") {
      if (isTaskTerminal()) return;
      taskPhaseRef.current = "waiting_for_approval";
      setBusy(false);
      setWorkingStatus("Neko está aguardando sua aprovação");
      if (props?.permission?.id) {
        notifyOnce("approval", `per:${String(props.permission.id)}`);
        setPendingPermission(prev => prev?.id === props.permission.id ? prev : props.permission as PermissionRequest);
      }
      return;
    }
    if (state === "completed") {
      // The plan review card is its own approval flow; a pending plan
      // response owns the conclusion of the plan task.
      if (pendingPlanRef.current || planAwaitingRef.current) return;
      if (taskPhaseRef.current === "completed") return;
      concludeCurrentTask("completed");
      return;
    }
    if (state === "cancelled") {
      setPendingPermission(null);
      setPendingQuestion(null);
      pendingQuestionRef.current = null;
      concludeCurrentTask("cancelled");
      upsertActivity({ id: `stopped:${Date.now()}`, icon: "error", title: "Tarefa cancelada", detail: "A execução atual foi parada pelo usuário. As alterações já feitas foram mantidas.", state: "error" });
      console.log(`[TaskLifecycle] state=cancelled taskId=${props?.taskId ?? "-"}`);
      return;
    }
    if (state === "failed") {
      taskPhaseRef.current = "failed";
      retryActiveRef.current = false;
      setBusy(false);
      setWorkingStatus("");
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      setPendingPermission(null);
      setPendingQuestion(null);
      pendingQuestionRef.current = null;
      finishActivity();
      notifyOnce("task-error", String(props?.taskId || currentTaskIdRef.current || "fail"));
      console.log(`[TaskLifecycle] state=failed taskId=${props?.taskId ?? "-"} reason=${String(props?.reason ?? "")}`);
      return;
    }
  }, [concludeCurrentTask, isTaskTerminal, upsertActivity, finishActivity]);

  // Stable references for the event-handler effect. The effect must NEVER
  // re-subscribe because a callback identity changed: several callbacks
  // depend on providers/models state, so each providers:list response used
  // to recreate the whole chain (getEffectiveModel -> dispatchRepairPrompt ->
  // runTaskValidation -> concludeCurrentTask -> applyTaskState), re-running
  // the effect, which requested providers again — an infinite loop. Refs
  // break the cycle: the effect subscribes once per session and always
  // calls the latest callback.
  const applyTaskStateRef = React.useRef(applyTaskState);
  const dispatchRepairPromptRef = React.useRef(dispatchRepairPrompt);
  const runTaskValidationRef = React.useRef(runTaskValidation);
  const concludeCurrentTaskRef = React.useRef(concludeCurrentTask);
  React.useEffect(() => {
    applyTaskStateRef.current = applyTaskState;
    dispatchRepairPromptRef.current = dispatchRepairPrompt;
    runTaskValidationRef.current = runTaskValidation;
    concludeCurrentTaskRef.current = concludeCurrentTask;
  });

  React.useEffect(() => {
    let alive = true;
    const syncStatus = async () => {
      try {
        if (isExitingRef.current || !projectRef.current) return;
        const result = await window.neko.status();
        if (!alive || isExitingRef.current || !projectRef.current) return;
        const prevStatus = statusRef.current;
        const newStatus = result?.online ? "online" : result?.project ? "starting" : "offline";
        if (prevStatus !== newStatus) {
          console.log("[BLACKSCREEN] syncStatus:state-change", { from: prevStatus, to: newStatus, online: result?.online, hasProject: result?.project, project: projectRef.current });
        }
        setStatus(newStatus);
      } catch {
        if (alive && !isExitingRef.current && projectRef.current) {
          console.log("[BLACKSCREEN] syncStatus:error-offline", { project: projectRef.current });
          setStatus("offline");
        }
      }
    };
    void syncStatus();
    // Health is only a connection indicator; polling it every 1.2s adds IPC and
    // HTTP traffic while an agent is working. 2.5s is enough and keeps the UI
    // responsive, especially when multiple Neko instances are open.
    const timer = window.setInterval(() => void syncStatus(), 2500);
    void loadProviders("initial-load");

    // Helper centralizado para normalização de timestamps em segundos/milissegundos
    function normalizeTimestampToMs(raw: unknown): number {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return 0;
      // Timestamp UNIX em segundos (< 1e11, ex: ~1.7e9) vs milissegundos (>= 1e11, ex: ~1.7e12)
      return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    }

    // OpenCode emits permission events, but polling the authoritative endpoint
    // as a fallback prevents an approval from being missed when an SSE event
    // arrives before the renderer listener is ready or is temporarily delayed.
    const permissionPoller = window.setInterval(async () => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;
      // Only relevant while the task is running: waiting/terminal states are
      // managed by the main-process state machine.
      if (taskPhaseRef.current !== "running") return;
      try {
        const list = await window.neko.permissions(activeSessionId);
        const candidates = Array.isArray(list) ? list : [];
        // An approval created before this task started belongs to an old task
        // and must never block the current one.
        const startedAtMs = requestStartedAtRef.current;
        const pending = candidates
          .filter((item: any) => {
            if (!item?.id) return false;
            const itemSession = String(item?.sessionID ?? item?.sessionId ?? "");
            if (itemSession && activeSessionId && itemSession !== activeSessionId) return false;
            const createdMs = normalizeTimestampToMs(item?.time?.created ?? item?.createdAt ?? item?.timestamp);
            return createdMs > 0 && createdMs >= startedAtMs;
          })
          .slice(-1)[0] ?? null;
        if (pending?.id) {
          setPendingPermission(prev => prev?.id === pending.id ? prev : pending as PermissionRequest);
          if (!isTaskTerminal()) {
            taskPhaseRef.current = "waiting_for_approval";
            setBusy(false);
            setWorkingStatus("Neko está aguardando sua aprovação");
          }
        }
      } catch {}
    }, 1800);

    const unsubscribe = window.neko.onEvent((event) => {
      const type = event?.type ?? "";
      const props = event?.properties ?? {};
      if (String(type).startsWith("session.") || String(type).startsWith("tool.") || String(type).startsWith("message.part.")) {
        lastAgentEventAtRef.current = Date.now();
      }

      // Internal engine events are translated into Neko terminology before
      // reaching the diagnostic panel. The implementation engine is never
      // exposed as a product concept in the UI.
      if (type === "neko.opencode.ready") appendTerminalLine("log", "Neko está pronto para trabalhar.", "Neko");
      if (type === "session.created") appendTerminalLine("log", "Nova tarefa iniciada.", "Neko");
      if (type === "neko.agent.retrying") appendTerminalLine("log", `Falha temporária. Tentativa ${Number(props?.attempt || 1)} em andamento.`, "Neko");
      // Authoritative task state machine owned by the main process. The
      // renderer mirrors it and never concludes a task on its own.
      if (type === "neko.task.state") {
        applyTaskStateRef.current(String(props?.state ?? ""), props);
        return;
      }
      if (type === "neko.status") {
        // Once the task is completed/cancelled/failed, a delayed status event
        // must not revive busy/working (terminal state wins over transients).
        if (isTaskTerminal()) return;
        const eventSessionId = String(props?.sessionID ?? props?.sessionId ?? "");
        if (eventSessionId && sessionIdRef.current && eventSessionId !== sessionIdRef.current) return;
        // Waiting states are owned by the state machine: engine busy/idle
        // chatter must never overwrite "Neko precisa de uma resposta" or
        // "Neko está aguardando sua aprovação".
        if (taskPhaseRef.current === "waiting_for_user" || taskPhaseRef.current === "waiting_for_approval") return;
        const state = String(props?.state ?? "");
        if (state === "working" || state === "busy") {
          // The engine really entered the busy state for the current request.
          if (requestInFlightRef.current) requestObservedBusyRef.current = true;
          // Busy must never erase the retry fact: while a recovery is in
          // progress the status keeps showing the adjusting message.
          setWorkingStatus(prev => (retryActiveRef.current ? prev : "Neko trabalhando..."));
        } else if (state === "retry") {
          retryActiveRef.current = true;
          if (requestInFlightRef.current) requestObservedBusyRef.current = true;
          setBusy(true);
          setWorkingStatus("Ajustando a execução...");
          upsertActivity({ id: "engine-retry", icon: "status", title: "Ajustando a execução", detail: "O Neko está ajustando a execução atual.", state: "running" });
        } else if (state === "idle" || state === "completed" || state === "done") {
          // The main-process state machine is the only conclusion authority;
          // this handler only clears the transient status text.
          if (!retryActiveRef.current) {
            setWorkingStatus("");
          }
        }
      }
      if (type === "neko.activity") {
        const action = props?.action;
        const filePath = props?.path;
        if (action === "file" && filePath && !isNekoInternalPath(filePath)) {
          retryActiveRef.current = false;
          if (isTaskRunning()) setWorkingStatus(`Criando/editando ${displayPath(filePath)}...`);
          upsertActivity({ id: `file:${displayPath(filePath)}`, icon: "file", title: "Arquivo atualizado", detail: displayPath(filePath), state: "done" });
          window.neko.tree().then(setTree).catch(() => {});
          setCodeChangedFile(displayPath(filePath));
          if (activeFile?.path === displayPath(filePath)) {
            window.neko.readFile(activeFile.path).then(setActiveFile).catch(() => {});
          }
          if (project) {
            touchRecentProject(project, true);
          }
        } else if (action === "command") {
          retryActiveRef.current = false;
          if (isTaskRunning()) setWorkingStatus("Verificando as alterações...");
          upsertActivity({
            id: `neko-${Date.now()}`,
            icon: "status",
            title: "Neko trabalhando",
            detail: String(props?.command || "Executando comando"),
            state: "running"
          });
        } else {
          upsertActivity({
            id: `neko-${Date.now()}`,
            icon: "status",
            title: "Neko trabalhando",
            detail: String(props?.path || props?.command || props?.tool || "Executando etapa"),
            state: "running"
          });
        }
      }
      if (type === "session.status") {
        const statusType = String(props?.status?.type ?? props?.status ?? "").toLowerCase();
        if (statusType === "retry") appendTerminalLine("log", "Neko está ajustando a execução.", "Neko");
        if (statusType === "idle") appendTerminalLine("log", "Neko terminou a etapa atual.", "Neko");
      }
      if (type === "tool.execute.before") appendTerminalLine("log", "Neko está executando uma ação no projeto.", "Neko");
      if (type === "command.executed") appendTerminalLine("log", "Verificação do projeto concluída.", "Neko");
      if (type === "file.edited") {
        const file = props?.file ?? props?.path ?? props?.filePath ?? "arquivo do projeto";
        appendTerminalLine("log", `Arquivo atualizado: ${displayPath(file)}`, "Projeto");
      }

      // The internal engine is only considered ready after its health endpoint responds.
      // Reload the model/provider catalog at that exact point instead of
      // racing the server startup from the initial renderer effect.
      if (type === "neko.opencode.ready") {
        void loadProviders("engine-ready");
      }

      if (type === "neko.agent.retrying") {
        if (isTaskTerminal()) return;
        setBusy(true);
        retryActiveRef.current = true;
        requestInFlightRef.current = true;
        const attempt = Number(props?.attempt || 1);
        const delay = Math.max(0, Number(props?.delayMs || 0));
        const seconds = Math.ceil(delay / 1000);
        setWorkingStatus(`Falha temporária. Tentando novamente em ${seconds}s...`);
        upsertActivity({ id: "agent-retry", icon: "status", title: "Tentando novamente", detail: `Tentativa ${attempt}. O Neko preservou a tarefa e continuará automaticamente.`, state: "running" });
      }
      if (type === "preview.output") {
        const text = String(props?.text || "");
        if (text) {
          const kind = props?.stream === "stderr" ? "error" : "log";
          appendTerminalLine(kind, text, "Preview");
        }
      }
      if (type === "preview.console") {
        const rawLevel = props?.level;
        const numeric = typeof rawLevel === "string" ? ({ verbose: 0, info: 1, warning: 2, warn: 2, error: 3 } as Record<string, number>)[rawLevel.toLowerCase()] ?? 1 : Number(rawLevel ?? 0);
        const level: ConsoleLevel = numeric >= 3 ? "error" : numeric === 2 ? "warn" : numeric === 0 ? "debug" : "log";
        const text = String(props?.message || "");
        if (text) {
          if (numeric >= 3) previewRuntimeErrorRef.current = text;
          // Console do projeto: vai somente para a aba Console.
          const sourceId = String(props?.sourceId || props?.url || "");
          const line = Number(props?.lineNumber) > 0 ? Number(props?.lineNumber) : undefined;
          pushConsoleEntry(level, text, shortConsoleSource(sourceId, line), sourceId || undefined);
        }
      }
      if (type === "preview.error") {
        const text = String(props?.message || "Erro no Preview");
        appendTerminalLine("error", text, "Preview");
      }
      if (type === "session.status") {
        const t = String(props?.status?.type ?? props?.status ?? "").toLowerCase();
        if (t === "retry") {
          if (isTaskTerminal()) return;
          if (taskPhaseRef.current === "waiting_for_user" || taskPhaseRef.current === "waiting_for_approval") return;
          retryActiveRef.current = true;
          if (requestInFlightRef.current) requestObservedBusyRef.current = true;
          setBusy(true);
          const reason = props?.status?.message ?? props?.status?.error ?? props?.message ?? "";
          setWorkingStatus(reason ? `Ajustando a execução: ${sanitizeUserFacingText(reason)}` : "Ajustando a execução...");
          upsertActivity({ id: "retry", icon: "status", title: "Ajustando a execução", detail: reason ? sanitizeUserFacingText(reason) : "O Neko está ajustando a execução atual.", state: "running" });
        }
        if (t === "busy") {
          // Busy may never revive the UI after a terminal or waiting state:
          // the conclusion authority is the main-process state machine.
          if (isTaskTerminal()) return;
          if (taskPhaseRef.current === "waiting_for_user" || taskPhaseRef.current === "waiting_for_approval") return;
          retryActiveRef.current = false;
          if (completionTimer.current) { window.clearTimeout(completionTimer.current); completionTimer.current = null; }
          if (requestInFlightRef.current) requestObservedBusyRef.current = true;
          setBusy(true);
          setWorkingStatus(prev => (prev && prev.startsWith("Falha temporária") ? prev : (prev || "Neko está trabalhando...")));
        }
        if (t === "idle" || t === "completed" || t === "done") {
          // Never conclude here: the main process decides whether this idle
          // means completed, waiting_for_user or waiting_for_approval.
          if (!retryActiveRef.current) setWorkingStatus("");
        }
      }
      if (type === "session.idle") {
        // The conclusion was already applied through neko.task.state emitted
        // by the main process BEFORE this idle event. Nothing to conclude here;
        // late/duplicate idle events are harmless.
        console.log(`[TaskLifecycle] session.idle received (state machine owns conclusion) taskId=${String(props?.taskId ?? "-")} phase=${taskPhaseRef.current}`);
      }
      if (type === "tool.execute.before") {
        if (!isTaskRunning()) return;
        retryActiveRef.current = false;
        const tool = props?.tool ?? props?.name ?? props?.part?.tool ?? "";
        const toolName = typeof tool === "string" ? tool : (tool?.name ?? "");
        const detail = describeToolActivity(toolName, props?.input ?? props?.part?.state?.input);
        setWorkingStatus(detail);
        upsertActivity({ id: "current-tool", icon: "tool", title: detail.replace(/\.\.\.$/, ""), detail: toolName ? String(toolName) : undefined, state: "running" });
      }
      if (type === "tool.execute.after") {
        if (!isTaskRunning()) return;
        const tool = props?.tool ?? props?.name ?? props?.part?.tool ?? "";
        const toolName = typeof tool === "string" ? tool : (tool?.name ?? "");
        const state = props?.state ?? props?.part?.state;
        if (state?.status === "error") setWorkingStatus("Corrigindo o que foi necessário...");
        else setWorkingStatus(describeToolActivity(toolName, props?.input ?? props?.part?.state?.input));
      }
      // Some OpenCode versions expose live tool lifecycle through
      // message.part.updated instead of tool.execute.before/after. Use the
      // same Neko-facing status for both paths.
      if (type === "message.part.updated") {
        const part = props?.part;
        if (part?.type === "tool") {
          const state = part?.state ?? {};
          if (state?.status === "running" && isTaskRunning()) {
            setWorkingStatus(describeToolActivity(part.tool, state.input));
          } else if (state?.status === "error" && isTaskRunning()) {
            setWorkingStatus("Corrigindo o que foi necessário...");
          }
        }
      }
      if (type === "file.edited" || type === "file.watcher.updated" || type === "neko.project.changed") {
        const file = props?.file ?? props?.path ?? props?.file?.path ?? props?.filePath ?? "arquivo do projeto";
        if (isNekoInternalPath(file)) return;
        retryActiveRef.current = false;
        // Vite/HMR and filesystem watchers update the file tree, never the
        // task state: the status text only changes while the task is running.
        if (isTaskRunning()) setWorkingStatus(`Criando/editando ${displayPath(file)}...`);
        upsertActivity({ id: `file:${displayPath(file)}`, icon: "file", title: "Arquivo atualizado", detail: displayPath(file), state: "done" });
        window.neko.tree().then(setTree).catch(() => {});
        setCodeChangedFile(displayPath(file));
        if (activeFile?.path === displayPath(file)) {
          window.neko.readFile(activeFile.path).then(setActiveFile).catch(() => {});
        }
        if (project) {
          touchRecentProject(project, true);
        }
      }
      if (type === "command.executed") {
        retryActiveRef.current = false;
        if (isTaskRunning()) setWorkingStatus("Verificando as alterações...");
      }
      if (type === "permission.asked") {
        if (isTaskTerminal()) return;
        const permission = props as PermissionRequest;
        setPermissionStep(step => step + 1);
        setPendingPermission(permission);
        taskPhaseRef.current = "waiting_for_approval";
        setBusy(false);
        setWorkingStatus("Neko está aguardando sua aprovação");
        notifyOnce("approval", `per:${String(permission?.id || "ask")}`);
        upsertActivity({ id: `permission:${permission.id}`, icon: "wait", title: "Aguardando sua autorização", detail: "O Neko precisa de acesso para continuar.", state: "running" });
      }
      if (type === "permission.replied") {
        const permission = props as any;
        if (permission?.id && pendingPermission?.id === permission.id) setPendingPermission(null);
        // The user answered the approval: the agent continues on the same
        // session. A rejection is a user decision, never a technical error.
        if (!isTaskTerminal()) {
          taskPhaseRef.current = "running";
          setBusy(true);
          setWorkingStatus("Continuando o projeto...");
        }
      }
      if (type === "session.error" || type === "neko.process.error" || type === "neko.connection.error") {
        // Terminal FAILED state: delayed events must not revive busy/working.
        taskPhaseRef.current = "failed";
        setBusy(false); setWorkingStatus("");
        retryActiveRef.current = false;
        // A session/provider error does not mean the local Neko/OpenCode server
        // is offline. Keep the connection state accurate and unlock the composer.
        setStatus(type === "neko.connection.error" ? "offline" : "online");
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        activeTaskRef.current = null;
        if (completionTimer.current) { window.clearTimeout(completionTimer.current); completionTimer.current = null; }
        finishActivity();
        notifyOnce("task-error", String(currentTaskIdRef.current || "fail"));
        console.log(`[Neko/TaskState] error received type=${type} phase=->failed`);

        const diagnostic = formatAgentError(props);
        const errorText = diagnostic.details
          ? `ERRO\n${diagnostic.friendly}\n\n${diagnostic.details}`
          : `ERRO\n${diagnostic.friendly}`;
        appendTerminalLine("error", diagnostic.friendly, "Neko");
        setMessages(prev => [...prev, { role: "error", text: errorText, createdAt: Date.now() }]);
      }
    });
    const unsubscribePreview = window.neko.onPreviewEvent((event) => {
      const props = event?.properties ?? {};
      if (event?.type === "preview.output") {
        const text = String(props?.text || "");
        if (text) {
          const kind = props?.stream === "stderr" && /error|failed|fatal|exception|cannot|unable/i.test(text) ? "error" : "log";
          appendTerminalLine(kind, text, props?.source || "Preview");
        }
      } else if (event?.type?.startsWith("preview.")) {
        // Only update status/message for state-change events, never for output or frame events
        if (!["preview.frame-loading", "preview.frame-ready"].includes(event.type)) {
          if (props.status) setPreviewStatus(props.status);
          if (typeof props.message === "string") setPreviewMessage(props.message);
        }
        if (props.framework) setPreviewFramework(props.framework);
        if (event.type === "preview.ready") {
          setPreviewUrl(props.url);
          setPreviewInternalSession(Number(props.internalSession) || 0);
          setPreviewSurface("webcontents");
          setPreviewFrameReady(false);
          setPreviewLoading(false);
          setPreviewCurrentRoute("/");
          clearConsole();
          void loadPreviewRoutes(false);
        }
        if (event.type === "preview.route-changed") {
          // O seletor acompanha a rota real do Preview interno (links internos,
          // HMR full reload). No fallback iframe a rota não é observável.
          if (previewSurface === "webcontents" && typeof props.path === "string") {
            setPreviewCurrentRoute(props.path === "/" ? "/" : props.path.replace(/\/+$/, "") || "/");
          }
        }
        if (event.type === "preview.frame-loading") setPreviewFrameReady(false);
        if (event.type === "preview.frame-ready") {
          setPreviewFrameReady(true);
          // Preview atualizado via HMR/reload - se estamos aguardando atualização após correção, dispara validação
          if (repairState === "awaiting-preview-update") {
            console.log("[Neko/PreviewDiag] preview-updated via frame-ready");
            setRepairState("validating");
            void runTaskValidationRef.current();
          }
        }
        if (["preview.exit", "preview.stopped", "preview.unsupported"].includes(event.type)) { setPreviewUrl(null); setPreviewFrameReady(false); setPreviewLoading(false); }
        if (["preview.starting", "preview.installing", "preview.detecting"].includes(event.type)) setPreviewLoading(true);
        if (event.type === "preview.error") setPreviewLoading(false);
        if (event.type === "preview.frame-error") {
          const errDesc = props.errorDescription || props.errorCode || "unknown";
          const errUrl = props.url || "";
          console.error("[Neko/Preview] frame-error", errDesc, errUrl);
          appendTerminalLine("error", `Preview frame load failed: ${errDesc} (${errUrl})`, "Preview");
        }
        if (event.type === "preview.internal.failed" || event.type === "preview.internal.crashed") {
          const message = String(props.message || props.state || "falha desconhecida");
          appendTerminalLine("error", `Preview interno nativo falhou: ${message}. Alternando para o iframe de compatibilidade.`, "Preview/Internal");
          setPreviewSurface("iframe");
        }
        // Novo evento: erro detectado no preview - inicia ciclo de autocorreção
        if (event.type === "preview.error-detected") {
          const { signature, diagnostic, attempt, maxAttempts } = props;
          console.log(`[Neko/PreviewDiag] error-detected received attempt=${attempt}/${maxAttempts} signature=${signature}`);
          
          // Verifica se já tentamos corrigir este erro muitas vezes
          const attempted = attemptedErrorSignaturesRef.current.get(signature);
          const attemptCount = attempted?.count ?? 0;
          
          if (attemptCount >= 3) {
            console.log(`[Neko/PreviewDiag] recovery-failed signature=${signature} attempts=${attemptCount}`);
            setRepairState("idle");
            return;
          }
          
          // CRITICAL LOOP GUARDS: a repair prompt is only allowed when the
          // app can actually start one. Never dispatch while another request
          // is in flight, while a validation is running, or when the task is
          // in a waiting/terminal state. This makes the
          // "error -> prompt -> HMR -> error -> prompt" cycle impossible.
          if (requestInFlightRef.current || validationRunningRef.current) {
            console.log(`[Neko/PreviewDiag] repair-skipped reason=busy signature=${signature}`);
            return;
          }
          if (taskPhaseRef.current !== "completed" && taskPhaseRef.current !== "none") {
            console.log(`[Neko/PreviewDiag] repair-skipped reason=phase(${taskPhaseRef.current}) signature=${signature}`);
            return;
          }
          if (repairState !== "idle") {
            console.log(`[Neko/PreviewDiag] repair-skipped reason=repair-state(${repairState}) signature=${signature}`);
            return;
          }
          
          // Atualiza contador de tentativas
          attemptedErrorSignaturesRef.current.set(signature, { 
            count: attemptCount + 1, 
            lastAttempt: Date.now() 
          });
          setCurrentErrorSignature(signature);
          
          // Log de diagnóstico
          console.log(`[Neko/PreviewDiag] repair-start attempt=${attempt + 1}/3 signature=${signature}`);
          
          // Solicita correção ao Agent através do fluxo controlado, que
          // registra taskId/in-flight/busy como qualquer outra tarefa.
          if (sessionId) {
            repairAttemptsRef.current = Math.max(repairAttemptsRef.current, 1);
            void dispatchRepairPromptRef.current(String(diagnostic), "Problema encontrado no Preview");
          }
        }
      }
    });
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.clearInterval(permissionPoller);
      if (completionTimer.current) window.clearTimeout(completionTimer.current);
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      unsubscribe();
      unsubscribePreview();
    };
  }, [loadProviders, syncSessionOutput, isTaskTerminal, isTaskRunning, appendTerminalLine, displayPath, sanitizeUserFacingText]);

  // Bounds are sourced from the actual DOM slot so sidebar, terminal, device
  // mode, tab changes and window resize all drive the native preview surface.
  React.useLayoutEffect(() => {
    const host = previewViewHostRef.current;
    const visible = previewSurface === "webcontents" && workspaceTab === "preview" && !modal && Boolean(previewUrl) && previewInternalSession > 0 && Boolean(host);
    let raf = 0;
    const sync = () => {
      if (!visible || !host || !previewUrl) {
        previewViewSyncKeyRef.current = "";
        void window.neko.syncInternalPreview({ session: previewInternalSession, url: previewUrl || "", visible: false }).catch(() => {});
        return;
      }
      const rect = host.getBoundingClientRect();
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const key = `${previewInternalSession}:${previewUrl}:${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}`;
      if (key === previewViewSyncKeyRef.current) return;
      previewViewSyncKeyRef.current = key;
      void window.neko.syncInternalPreview({ session: previewInternalSession, url: previewUrl, visible: true, bounds }).catch(error => {
        console.error("[Preview/Internal] sync failed", error);
        setPreviewSurface("iframe");
      });
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); };
    schedule();
    const observer = host ? new ResizeObserver(schedule) : null;
    if (host) observer?.observe(host);
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(raf); observer?.disconnect(); window.removeEventListener("resize", schedule); };
  }, [previewSurface, workspaceTab, previewUrl, previewInternalSession, device, terminalOpen, modal]);

  // Fallback watchdog for build execution. OpenCode can occasionally leave
  // session.status as busy or events can be dropped.
  // Cross-checks the authoritative session status.
  React.useEffect(() => {
    if (!busy || !sessionId || pendingPlan) return;
    let alive = true;
    let idleStableSince = 0;
    const poll = async () => {
      try {
        // While the Vision Fallback analyzes images, the session is
        // intentionally idle: the watchdog must never conclude the task.
        if (visionFallbackPendingRef.current) {
          idleStableSince = 0;
          return;
        }
        const state = await window.neko.sessionStatus(sessionId);
        if (!alive || state === "unknown") return;
        if (state === "busy" || state === "retry") {
          idleStableSince = 0;
          if (state === "retry" && !isTaskTerminal()) {
            retryActiveRef.current = true;
            setWorkingStatus(prev => prev || "Ajustando a execução...");
          }
          // Do not infer completion from message history while the authoritative
          // session remains busy/retrying. Long model/tool operations are valid.
          return;
        }
        if (retryActiveRef.current || isTaskTerminal() || pendingPlanRef.current) {
          idleStableSince = 0;
          return;
        }
        if (state === "idle" && taskPhaseRef.current === "running" && requestInFlightRef.current) {
          // Watchdog recovery path: only used when the SSE event stream died
          // and the neko.task.state event was missed. Requires the session to
          // stay continuously idle for 12s — the main-process determination
          // (permission/question/completed) always finishes well before that.
          if (!idleStableSince) idleStableSince = Date.now();
          if (Date.now() - idleStableSince >= 12000) {
            console.log(`[TaskLifecycle] watchdog concluded task (session idle) session=${sessionId} taskId=${currentTaskIdRef.current ?? "-"}`);
            concludeCurrentTaskRef.current("completed");
          }
        } else {
          idleStableSince = 0;
        }
      } catch {}
    };
    // The SSE event stream is authoritative. This poll is only a recovery
    // watchdog for missed events, so keep it deliberately lightweight.
    const timer = window.setInterval(() => {
      if (Date.now() - lastAgentEventAtRef.current >= 4000) void poll();
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [busy, sessionId, pendingPlan, isTaskTerminal]);

  // "Atualizar Preview": reloads the current page WITHOUT changing the URL.
  // The internal surface uses the native WebContents reload (route/query/hash
  // preserved). The iframe fallback is remounted with the SAME src (route
  // preserved). No artificial "?t=timestamp" is ever appended.
  async function handlePreviewRefresh() {
    if (!previewUrl || previewStatus !== "ready") return;
    clearConsole();
    if (previewSurface === "webcontents") {
      try {
        const result = await window.neko.refreshPreview();
        if (!result?.ok) console.warn("[Preview] refresh not ok", result?.reason ?? "");
      } catch (error) {
        console.warn("[Preview] refresh failed", String((error as Error)?.message ?? error));
      }
    } else {
      setPreviewFrameReady(false);
      setPreviewFrameReloadKey(k => k + 1);
    }
  }

  // ===== Site Clone (analisar / reconstruir) =====
  async function runCloneAnalysis() {
    const raw = cloneUrl.trim();
    if (!raw || cloneBusy) return;
    if (!/^https?:\/\//i.test(raw) && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) {
      setCloneError("Informe um endereço público, por exemplo: https://exemplo.com");
      return;
    }
    setCloneError("");
    setCloneAnalysis(null);
    setCloneBusy(true);
    setCloneProgress({ scanned: 0, currentUrl: "" });
    try {
      const analysis = await window.neko.siteCloneAnalyze(raw, { maxPages: 30, maxDepth: 3, concurrency: 5 });
      setCloneAnalysis(analysis);
      if (!analysis?.ok) setCloneError(analysis?.error || "Não foi possível acessar esta página.");
      else if (analysis.routes?.length === 0) setCloneError("Nenhuma página acessível foi encontrada neste site.");
    } catch (error) {
      setCloneError("Não foi possível analisar este site. Tente novamente.");
      console.warn("[SiteClone] analyze error", String((error as Error)?.message ?? error));
    } finally {
      setCloneBusy(false);
      setCloneProgress({ scanned: 0, currentUrl: "" });
    }
  }

  // Captura Chromium real (DOM executado + estilos + assets). O snapshot vira
  // a fonte de verdade para a reconstrução React de alta fidelidade.
  async function runCloneCapture() {
    const raw = cloneUrl.trim();
    if (!raw || cloneCaptureBusy || cloneBusy) return;
    setCloneError("");
    setCloneAnalysis(null);
    setCloneCapture(null);
    setCloneCaptureBusy(true);
    try {
      const capture = await window.neko.siteCloneCapture(raw);
      setCloneCapture(capture);
      if (capture?.ok) {
        // Sintetiza uma "análise" a partir do snapshot para reutilizar a UI e a
        // reconstrução (que agora também recebe o contexto Chromium).
        const synthetic = {
          ok: true,
          origin: capture.origin || "",
          title: capture.title || "",
          routes: Array.isArray(capture.routes) ? capture.routes : [],
          pages: (Array.isArray(capture.pages) ? capture.pages : []).map((p: any) => ({
            route: p.pathname || "/", title: p.title || p.pathname || "/", headings: [], textSample: htmlToText(String(p.html || ""), 700)
          })),
          assets: Array.isArray(capture.assets) ? capture.assets : [],
          style: { fonts: Array.isArray(capture.fonts) ? capture.fonts : [] },
          capture
        };
        setCloneAnalysis(synthetic);
      } else {
        setCloneError(capture?.error || "Não foi possível capturar este site no navegador.");
      }
    } catch (error) {
      setCloneError("Não foi possível capturar este site. Tente novamente.");
      console.warn("[SiteClone] capture error", String((error as Error)?.message ?? error));
    } finally {
      setCloneCaptureBusy(false);
    }
  }

  // Dispara a reconstrução usando o agente existente (Task Runner) com um
  // brief estruturado e limitado (nunca o HTML bruto). O projeto editável é
  // criado dentro do workspace ativo pelo agente.
  async function startCloneReconstruction() {
    const analysis = cloneAnalysis;
    const capture = cloneCapture;
    if (!analysis?.ok || cloneReconstructBusy || busy) return;
    if (!sessionId || !project) {
      setCloneError("Abra ou crie um projeto primeiro — a reconstrução escreve arquivos dentro do workspace.");
      return;
    }
    setCloneReconstructBusy(true);
    setCloneError("");
    try {
      // 1) Importa os assets públicos reais (logo/hero/imagens/fontes) para o
      //    projeto local (public/clone-assets). O agente usa os arquivos locais
      //    — sem hotlink e sem placeholder quando o asset original existe.
      let localAssets: { remoteUrl: string; localPath: string }[] = [];
      const importable = (Array.isArray(analysis.assets) ? analysis.assets : []).filter((a: any) => a && (a.kind === "image" || a.kind === "font") && /^https?:\/\//i.test(String(a.url)));
      if (importable.length > 0) {
        setWorkingStatus("Baixando imagens e fontes do site para o projeto...");
        try {
          const imported = await window.neko.siteCloneImportAssets(importable);
          if (imported?.imported) localAssets = imported.imported;
        } catch (error) {
          console.warn("[SiteClone] asset import failed", String((error as Error)?.message ?? error));
        }
      }

      const routes = Array.isArray(analysis.routes) ? analysis.routes : [];
      const pages = (Array.isArray(analysis.pages) ? analysis.pages : []).slice(0, 30).map((p: any) => ({
        route: p.route, title: p.title || "", headings: (p.headings || []).slice(0, 12), textSample: (p.textSample || "").slice(0, 600)
      }));
      const fonts = Array.isArray(analysis.style?.fonts) ? analysis.style.fonts : [];
      const localAssetList = localAssets.map((a, i) => `${i + 1}. ${a.remoteUrl}  ->  ${a.localPath}`).join("\n");
      const brief = [
        "Você é o agente do NekoAI. Reconstrói um SITE REAL a partir de uma análise estática (crawling público) fornecida abaixo, gerando um projeto local editável e executável no Preview, com ALTA FIDELIDADE VISUAL.",
        "",
        "REGRA ABSOLUTA: crie arquivos reais (componentes, páginas, rotas, estilos) no workspace atual. NÃO use <iframe> apontando para o site original e NÃO use screenshot como página. O resultado precisa rodar localmente.",
        "",
        `Site de origem: ${analysis.origin || ""}`,
        `Título detectado: ${analysis.title || ""}`,
        "",
        "ROTAS a criar (rotas reais do Page Selector):",
        routes.map((r: string) => `- ${r}`).join("\n") || "- /",
        "",
        "TIPOGRAFIA detectada (use estas famílias no CSS; importe de @font-face local ou Google Fonts):",
        fonts.length ? fonts.map(f => `- ${f}`).join("\n") : "- (não detectada — escolha fontes coerentes)",
        "",
        "ASSETS REAIS JÁ BAIXADOS para o projeto (use estes caminhos locais, NÃO hotlink e NÃO placeholder quando listado):",
        localAssetList || "- nenhum asset local",
        "",
        "ESTRUTURA por página (route / título / headings / amostra de texto):",
        pages.map((p: any) => `[${p.route}] ${p.title}\n  headings: ${(p.headings || []).join(" | ")}\n  texto: ${p.textSample}`).join("\n") || "-",
        "",
        "ORIENTAÇÕES DE FIDELIDADE:",
        "1. Priorize fidelidade visual: header, hero (H1/subtítulo/CTA/badge/imagem/mockup), seções na MESMA ordem, cards, footer.",
        "2. Reflita as cores/espaçamentos/backgrounds observados; use imagens locais importadas para logo/hero/produtos/screenshots quando disponíveis.",
        "3. Componentize (Header/Footer/Navbar/Hero/Seção/Card); não crie um único arquivo gigante.",
        "4. Responsivo (desktop/tablet/mobile) — não apenas 'grid-template-columns: 1fr' no mobile.",
        "5. Interações determinísticas (menu, acordeão, sliders) quando indicadas; reproduza a adaptação real.",
        "6. Formulários: campos + validação visível com comportamento local/mock.",
        "7. NÃO inclua credenciais/tokens/secrets. Não invente conteúdo que mude a finalidade.",
        "8. Responda em português do Brasil com um resumo do que foi criado e o que foi limitado/substituído.",
        "",
        "Ao final, verifique que os arquivos existem e que as rotas funcionam."
      ].join("\n");

      const captureContext = (capture && capture.ok)
        ? "\n\nA captura Chromium abaixo é a FONTE DE VERDADE (DOM renderizado, rotas e assets reais). Reconstrua um projeto React editável de alta fidelidade: use os assets locais baixados em /clone-assets, preserve estrutura/espaçamento/tipografia/cores/seções, e não invente imagens ou seções que já estão no snapshot.\n\n" + buildAgentCaptureContext(capture)
        : "";
      const finalMessage = captureContext + brief;

      const originalUrl = analysis.origin || "site";
      setModal(null);
      setMessages(prev => [...prev, { role: "user", text: `Reconstruir o site ${originalUrl} (${routes.length} página${routes.length === 1 ? "" : "s"}).`, createdAt: Date.now() }]);
      setBusy(true);
      requestStartedAtRef.current = Date.now();
      retryActiveRef.current = false;
      requestInFlightRef.current = true;
      requestObservedBusyRef.current = false;
      currentTaskIdRef.current = null;
      taskPhaseRef.current = "running";
      setRepairState("idle");
      repairAttemptsRef.current = 0;
      setWorkingStatus("Reconstruindo o site a partir da análise...");
      try {
        const result = await window.neko.prompt(sessionId, finalMessage, getEffectiveModel(selectedModel), [], [], false, effort);
        if (result?.cancelled) return;
        if (result?.taskId) {
          currentTaskIdRef.current = String(result.taskId);
          console.log(`[SiteClone] reconstruction dispatched taskId=${result.taskId}`);
        }
      } catch (error) {
        if (taskPhaseRef.current === "cancelled") return;
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        taskPhaseRef.current = "failed";
        setBusy(false);
        setWorkingStatus("");
        setCloneError("Não foi possível iniciar a reconstrução. Verifique os logs.");
        console.warn("[SiteClone] reconstruction failed", String((error as Error)?.message ?? error));
      }
    } finally {
      setCloneReconstructBusy(false);
    }
  }

  async function cancelCloneAnalysis() {
    if (cloneBusy) {
      try { await window.neko.siteCloneCancel(); } catch {}
    }
    setCloneBusy(false);
    setCloneAnalysis(null);
    setCloneCapture(null);
    setCloneCaptureBusy(false);
    setCloneProgress({ scanned: 0, currentUrl: "" });
    setCloneError("");
    setModal(null);
  }

  // Alterna o modo Build/Plan. Nunca muda uma execução já iniciada: o seletor
  // é desabilitado enquanto busy. Aplica-se apenas ao próximo envio.
  function selectChatMode(next: ChatMode) {
    if (next === chatMode) { setChatModeMenuOpen(false); return; }
    console.log(`[Chat Mode] changed from=${chatMode} to=${next}`);
    setChatMode(next);
    setChatModeMenuOpen(false);
  }

  // Atalho Tab no contexto do composer: alterna Build <-> Plan. Shift+Tab NÃO
  // é capturado (navegação de foco normal continua intacta). Um Tab sozinho
  // que caia fora do contexto do composer não é sequestrado (nada é capturado
  // globalmente).
  function toggleChatModeViaTab() {
    const next = nextChatMode(chatMode);
    console.log(`[Chat Mode] changed from=${chatMode} to=${next}`);
    setChatMode(next);
    setChatModeMenuOpen(false);
  }

  // ===== Missing function implementations =====

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function createProject() {
    setModal("newProject");
  }

  const send = React.useCallback(async () => {
    if (!sessionId || requestInFlightRef.current) return;
    const text = input.trim();
    const hasAttachments = attachments.length > 0;
    if (!text && !hasAttachments) return;

    if (pendingQuestionRef.current) {
      setInput("");
      setAttachments([]);
      setUploadErrors([]);
      void answerQuestion(text);
      return;
    }

    handledQuestionIdsRef.current.clear();

    // Context resolution via central resolver:
    const resolverState: ResolverContextState = {
      projectRoot: project,
      projectName: project ? project.split(/[/\\]/).pop() : undefined,
      previewUrl,
      previewStatus,
      previewFramework,
      previewMessage,
      tree,
      gitStatus: githubLinkStatus,
      terminalLines,
      consoleEntries
    };
    const resolved = resolveChatMessage(text, resolverState);

    // Se for comando puro do OpenCode que não pertence aos 6 comandos nativos da Neko nem contém contextos semânticos
    if (text.startsWith("/") && !resolved.command && !resolved.semanticContexts.length && !resolved.filePaths.length) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].slice(1);
      const args = parts.slice(1).join(" ");
      setInput("");
      setShowSlashMenu(false);
      setAutocompleteMode(null);
      setAutocompleteTrigger(null);
      requestInFlightRef.current = true;
      requestObservedBusyRef.current = false;
      currentTaskIdRef.current = null;
      taskPhaseRef.current = "running";
      retryActiveRef.current = false;
      setBusy(true);
      setWorkingStatus("Executando comando...");
      setMessages(prev => [...prev, { role: "user", text, createdAt: Date.now() }]);
      try {
        const result = await window.neko.runCommand(sessionId, cmd, args, getEffectiveModel(selectedModel));
        if (result?.taskId) currentTaskIdRef.current = String(result.taskId);
      } catch (error) {
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        taskPhaseRef.current = "failed";
        setBusy(false);
        setWorkingStatus("");
        setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
      }
      return;
    }

    // Build attachment list for prompt
    const promptAttachments = attachments.map(a => ({
      type: a.kind,
      url: a.url || a.previewUrl || "",
      mime: a.mime,
      path: a.path,
      name: a.name
    }));

    // Arquivos físicos referenciados com @ (ex: @src/App.tsx)
    const contextPaths: string[] = [...resolved.filePaths];

    // Reset editing state
    setEditingMessageIndex(null);

    // Adiciona mensagem do usuário no histórico mantendo o texto original limpo
    const userMessage: Message = { role: "user", text: resolved.userDisplayText, attachments: attachments.length > 0 ? [...attachments] : undefined, createdAt: Date.now() };
    setMessages(prev => [...prev, userMessage]);
    const userIndex = messages.length;

    // Clear input e menus
    setInput("");
    setAttachments([]);
    setUploadErrors([]);
    setShowSlashMenu(false);
    setShowContextMenu(false);
    setAutocompleteMode(null);
    setAutocompleteTrigger(null);

    // Set up task lifecycle
    requestStartedAtRef.current = Date.now();
    requestInFlightRef.current = true;
    requestObservedBusyRef.current = false;
    currentTaskIdRef.current = null;
    taskPhaseRef.current = "running";
    retryActiveRef.current = false;
    setRepairState("idle");
    repairAttemptsRef.current = 0;
    setBusy(true);
    setWorkingStatus("Neko está trabalhando...");
    upsertActivity({ id: "user-request", icon: "brain", title: "Neko processando", detail: text.length > 60 ? text.slice(0, 57) + "..." : text, state: "running" });

    // Track active task for duration measurement
    activeTaskRef.current = { id: `task-${Date.now()}`, startedAt: Date.now(), userIndex };

    try {
      const result = await window.neko.prompt(
        sessionId,
        resolved.agentPromptText,
        getEffectiveModel(selectedModel),
        promptAttachments.length > 0 ? promptAttachments : undefined,
        contextPaths.length > 0 ? contextPaths : undefined,
        planMode,
        effort
      );
      if (result?.cancelled) return;
      if (result?.taskId) {
        currentTaskIdRef.current = String(result.taskId);
        console.log(`[Send] prompt accepted taskId=${result.taskId}`);
      }
    } catch (error) {
      if (taskPhaseRef.current === "cancelled") return;
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      taskPhaseRef.current = "failed";
      setBusy(false);
      setWorkingStatus("");
      setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
    }
  }, [sessionId, input, attachments, selectedModel, planMode, effort, messages.length, getEffectiveModel, sanitizeUserFacingText, upsertActivity, project, previewUrl, previewStatus, previewFramework, previewMessage, tree, githubLinkStatus, terminalLines, consoleEntries]);

  const stopDevelopment = React.useCallback(async () => {
    if (!sessionId) return;
    setPendingQuestion(null);
    pendingQuestionRef.current = null;
    setPendingPlan(null);
    planAwaitingRef.current = false;
    pendingPlanTaskRef.current = null;
    try {
      await window.neko.abort(sessionId);
    } catch (error) {
      console.warn("[StopDevelopment] abort failed", String((error as Error)?.message ?? error));
    }
  }, [sessionId]);

  const rejectPlan = React.useCallback(() => {
    const plan = pendingPlan;
    setPendingPlan(null);
    setPlanExpanded(false);
    setPlanApprovalBusy(false);
    planAwaitingRef.current = false;
    pendingPlanTaskRef.current = null;
    taskPhaseRef.current = "cancelled";
    requestInFlightRef.current = false;
    requestObservedBusyRef.current = false;
    setBusy(false);
    setWorkingStatus("");
    upsertActivity({ id: "plan-rejected", icon: "error", title: "Plano cancelado", detail: "O plano não foi aprovado.", state: "error" });

    if (plan?.requestId && sessionId) {
      void window.neko.questionReply(sessionId, plan.requestId, [["No"]]).catch(err => {
        console.warn("[Plan] reject reply error:", err);
      });
      console.log(`[Plan] native rejection sent requestId=${plan.requestId} session=${sessionId}`);
    }
  }, [sessionId, pendingPlan, upsertActivity]);

  const approvePlan = React.useCallback(async () => {
    if (!sessionId || !pendingPlan || planApprovalBusy) return;
    setPlanApprovalBusy(true);
    const plan = pendingPlan;
    setPendingPlan(null);
    setPlanExpanded(false);
    planAwaitingRef.current = false;

    // Show the approved plan card
    setApprovedPlan({ planText: plan.planText, approvedAt: Date.now(), messageCreatedAt: Date.now() });

    // 1. NATIVE OPENCODE PLAN APPROVAL:
    // If this came from a native question (plan_exit), send "Yes" to the existing session!
    if (plan.requestId) {
      requestStartedAtRef.current = Date.now();
      requestInFlightRef.current = true;
      requestObservedBusyRef.current = false;
      taskPhaseRef.current = "running";
      retryActiveRef.current = false;
      pendingPlanTaskRef.current = null;
      setBusy(true);
      setWorkingStatus("Executando o plano aprovado...");

      try {
        await window.neko.questionReply(sessionId, plan.requestId, [["Yes"]]);
        console.log(`[Plan] native approval sent requestId=${plan.requestId} session=${sessionId}`);
      } catch (error) {
        requestInFlightRef.current = false;
        requestObservedBusyRef.current = false;
        taskPhaseRef.current = "failed";
        setBusy(false);
        setWorkingStatus("");
        setApprovedPlan(null);
        setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
      } finally {
        setPlanApprovalBusy(false);
      }
      return;
    }

    // 2. TEXTUAL FALLBACK:
    // If the model did not invoke plan_exit, send the follow-up prompt to continue execution.
    requestStartedAtRef.current = Date.now();
    requestInFlightRef.current = true;
    requestObservedBusyRef.current = false;
    currentTaskIdRef.current = null;
    taskPhaseRef.current = "running";
    retryActiveRef.current = false;
    pendingPlanTaskRef.current = null;
    setBusy(true);
    setWorkingStatus("Executando o plano aprovado...");

    try {
      const result = await window.neko.prompt(
        sessionId,
        "Plano aprovado. Prossiga com a implementação conforme o plano acima.",
        getEffectiveModel(selectedModel),
        plan.attachments.length > 0 ? plan.attachments.map(a => ({ type: a.kind, url: a.url || a.previewUrl || "", mime: a.mime, path: a.path, name: a.name })) : undefined,
        plan.contextPaths.length > 0 ? plan.contextPaths : undefined,
        false,
        effort
      );
      if (result?.taskId) {
        currentTaskIdRef.current = String(result.taskId);
        console.log(`[Plan] fallback approved and dispatched taskId=${result.taskId}`);
      }
    } catch (error) {
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      taskPhaseRef.current = "failed";
      setBusy(false);
      setWorkingStatus("");
      setApprovedPlan(null);
      setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
    } finally {
      setPlanApprovalBusy(false);
    }
  }, [sessionId, pendingPlan, planApprovalBusy, selectedModel, effort, getEffectiveModel, sanitizeUserFacingText]);

  const answerQuestion = React.useCallback(async (value: string) => {
    if (!sessionId || !pendingQuestion) return;
    const question = pendingQuestion;
    setPendingQuestion(null);
    pendingQuestionRef.current = null;
    setWorkingStatus("Continuando...");

    // Add the answer as a user message
    setMessages(prev => [...prev, { role: "user", text: value, createdAt: Date.now() }]);

    // Resume the task by sending the answer as a prompt or native reply
    requestInFlightRef.current = true;
    requestObservedBusyRef.current = false;
    taskPhaseRef.current = "running";
    retryActiveRef.current = false;
    setBusy(true);

    try {
      if (question.isNativeTool && question.requestId) {
        await window.neko.questionReply(sessionId, question.requestId, [value]);
        console.log(`[Question] native reply dispatched requestId=${question.requestId} questionId=${question.questionId}`);
      } else {
        const result = await window.neko.prompt(sessionId, value, getEffectiveModel(selectedModel));
        if (result?.taskId) {
          currentTaskIdRef.current = String(result.taskId);
          console.log(`[Question] answer dispatched taskId=${result.taskId} questionId=${question.questionId}`);
        }
      }
    } catch (error) {
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      taskPhaseRef.current = "failed";
      setBusy(false);
      setWorkingStatus("");
      setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
    }
  }, [sessionId, pendingQuestion, selectedModel, getEffectiveModel, sanitizeUserFacingText]);

  const rejectQuestion = React.useCallback(async (questionParam?: AgentQuestion | null) => {
    const question = questionParam || pendingQuestion;
    if (!sessionId || !question) return;
    setPendingQuestion(null);
    pendingQuestionRef.current = null;
    setWorkingStatus("Continuando...");

    requestInFlightRef.current = true;
    requestObservedBusyRef.current = false;
    taskPhaseRef.current = "running";
    retryActiveRef.current = false;
    setBusy(true);

    try {
      if (question.isNativeTool && question.requestId) {
        await window.neko.questionReject(sessionId, question.requestId);
        console.log(`[Question] native reject dispatched requestId=${question.requestId}`);
      } else {
        const fallbackText = "Continuar sem resposta — escolha por você, mantendo o objetivo da tarefa.";
        setMessages(prev => [...prev, { role: "user", text: fallbackText, createdAt: Date.now() }]);
        const result = await window.neko.prompt(sessionId, fallbackText, getEffectiveModel(selectedModel));
        if (result?.taskId) {
          currentTaskIdRef.current = String(result.taskId);
        }
      }
    } catch (error) {
      requestInFlightRef.current = false;
      requestObservedBusyRef.current = false;
      taskPhaseRef.current = "failed";
      setBusy(false);
      setWorkingStatus("");
      setMessages(prev => [...prev, { role: "error", text: sanitizeUserFacingText(error instanceof Error ? error.message : error) }]);
    }
  }, [sessionId, pendingQuestion, selectedModel, getEffectiveModel, sanitizeUserFacingText]);

  const replyPermission = React.useCallback(async (response: "once" | "always" | "reject") => {
    if (!sessionId || !pendingPermission) return;
    const permission = pendingPermission;
    setPendingPermission(null);

    try {
      await window.neko.permissionReply(sessionId, permission.id, response);
      console.log(`[Permission] replied response=${response} permissionId=${permission.id}`);
    } catch (error) {
      console.warn("[Permission] reply failed", String((error as Error)?.message ?? error));
    }
  }, [sessionId, pendingPermission]);

  const copyMessage = React.useCallback(async (text: string, target?: HTMLElement | null) => {
    try {
      await navigator.clipboard.writeText(text || "");
      showToast("Copiado!", target);
    } catch {
      // Fallback for older Electron
      const textarea = document.createElement("textarea");
      textarea.value = text || "";
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      showToast("Copiado!", target);
    }
  }, [showToast]);

  const undoAgentTask = React.useCallback(async (index: number, target?: HTMLElement | null) => {
    const message = messages[index];
    if (!message?.taskId || busy) return;
    try {
      const result = await window.neko.undoTask(message.taskId);
      if (result) {
        // Remove the assistant message and any subsequent messages from this task
        setMessages(prev => prev.filter((_, i) => {
          if (i === index) return false;
          // Also remove user messages that were part of this task cycle
          if (i > index && prev[i]?.role === "user" && !prev[i]?.taskId) return false;
          return true;
        }));
        showToast("Tarefa desfeita", target);
        // Refresh the file tree
        window.neko.tree().then(setTree).catch(() => {});
      }
    } catch (error) {
      console.warn("[UndoTask] failed", String((error as Error)?.message ?? error));
      showToast("Não foi possível desfazer", target);
    }
  }, [messages, busy, showToast]);

  const editUserMessage = React.useCallback((index: number) => {
    const message = messages[index];
    if (!message || message.role !== "user" || busy) return;
    setEditingMessageIndex(index);
    setInput(message.text);
    composerRef.current?.focus();
  }, [messages, busy]);

  const refreshGithubBranches = React.useCallback(async () => {
    if (!githubLinkStatus.linkedRepo || githubBranchBusy) return;
    setGithubBranchBusy(true);
    setGithubBranchError("");
    try {
      const names = await window.neko.githubListBranches(githubLinkStatus.linkedRepo);
      const filtered = Array.from(new Set(names.filter((name: string) => name && name !== "origin" && name !== "HEAD" && name !== "origin/HEAD")));
      setGithubBranches(filtered.length ? filtered : [githubLinkStatus.branch || "main"]);
    } catch (error) {
      setGithubBranchError("Erro ao listar branches.");
      console.warn("[GithubBranches] refresh failed", String((error as Error)?.message ?? error));
    } finally {
      setGithubBranchBusy(false);
    }
  }, [githubLinkStatus.linkedRepo, githubLinkStatus.branch, githubBranchBusy]);

  const chooseGithubBranch = React.useCallback(async (branch: string) => {
    if (!branch || githubBranchBusy) return;
    setGithubBranchBusy(true);
    setGithubBranchError("");
    setGithubBranchMenuOpen(false);
    try {
      await window.neko.githubCheckoutBranch(branch);
      const git = await window.neko.githubGitStatus();
      setGithubLinkStatus(git);
      if (git.branch) {
        setGithubBranches(prev => prev.includes(git.branch!) ? prev : [...prev, git.branch!]);
      }
    } catch (error) {
      setGithubBranchError(`Erro ao trocar para branch "${branch}".`);
      console.warn("[GithubBranch] checkout failed", String((error as Error)?.message ?? error));
    } finally {
      setGithubBranchBusy(false);
    }
  }, [githubBranchBusy]);

  // ===== Modal functions =====

  async function disconnectProvider(providerId: string) {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      await window.neko.disconnectProvider(providerId);
      await loadProviders("disconnect");
    } catch (error) {
      setAuthError("Erro ao desconectar provedor.");
      console.warn("[Provider] disconnect failed", String((error as Error)?.message ?? error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function connectProvider() {
    if (!selectedProvider || !apiKey.trim() || authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      await window.neko.connectProvider(selectedProvider.id, apiKey.trim());
      await loadProviders("connect");
      setModal("models");
      setApiKey("");
    } catch (error) {
      setAuthError("Chave de API inválida ou conexão falhou.");
      console.warn("[Provider] connect failed", String((error as Error)?.message ?? error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function startGithubConnect() {
    if (githubBusy) return;
    setGithubBusy(true);
    setGithubError("");
    try {
      const result = await window.neko.githubStart();
      if (result?.userCode) {
        setGithubDevice({ userCode: result.userCode, verificationUri: result.verificationUri || "https://github.com/login/device", expiresIn: result.expiresIn || 900, interval: result.interval || 5 });
        setModal("githubDevice");
      }
    } catch (error) {
      setGithubError("Erro ao iniciar conexão com GitHub.");
      console.warn("[Github] connect failed", String((error as Error)?.message ?? error));
      setGithubBusy(false);
    }
  }

  async function commitAndPushGithub() {
    if (!githubCommitMessage.trim() || githubCommitBusy || !githubLinkStatus.linkedRepo) return;
    setGithubCommitBusy(true);
    setGithubCommitError("");
    setGithubCommitSuccess(false);
    try {
      await window.neko.githubCommitPush(githubCommitMessage.trim());
      setGithubCommitSuccess(true);
      setGithubCommitMessage("");
      const git = await window.neko.githubGitStatus();
      setGithubLinkStatus(git);
    } catch (error) {
      setGithubCommitError("Erro ao enviar alterações.");
      console.warn("[Github] commitPush failed", String((error as Error)?.message ?? error));
    } finally {
      setGithubCommitBusy(false);
    }
  }

  function prepareGithubPublish() {
    setGithubPublishRepoName("");
    setGithubPublishPrivate(true);
    setGithubPublishError("");
    setGithubPublishBusy(false);
    setModal("githubPublish");
  }

  async function refreshGithub() {
    try {
      const result = await window.neko.githubStatus(true);
      setGithubStatus(result || { connected: false, repos: [] });
    } catch (error) {
      console.warn("[Github] refresh failed", String((error as Error)?.message ?? error));
    }
  }

  function openGithubLink(repo: GithubStatus["repos"][number]) {
    setGithubLinkRepo(repo);
    setGithubLinkError("");
    setGithubLinkBusy(false);
    setGithubReplaceRemote(false);
    setModal("githubLink");
  }

  function prepareGithubClone(repo: GithubStatus["repos"][number]) {
    setGithubCloneRepo(repo);
    setGithubCloneName(repo.name);
    setGithubCloneParent("");
    setGithubError("");
    setGithubBusy(false);
    setModal("githubClone");
  }

  async function disconnectGithub() {
    try {
      await window.neko.githubDisconnect();
      setGithubStatus({ connected: false, repos: [] });
      setGithubLinkStatus({ initialized: false, branch: null, remote: null, linkedRepo: null, dirty: false });
      setGithubBranches([]);
      setModal("github");
    } catch (error) {
      console.warn("[Github] disconnect failed", String((error as Error)?.message ?? error));
    }
  }

  async function chooseGithubCloneParent() {
    try {
      const result = await window.neko.githubChooseCloneDestination();
      if (result?.path) setGithubCloneParent(result.path);
    } catch (error) {
      console.warn("[Github] chooseCloneParent failed", String((error as Error)?.message ?? error));
    }
  }

  async function cloneGithubRepository(repoFullName: string) {
    if (!repoFullName || githubBusy) return;
    setGithubBusy(true);
    setGithubError("");
    try {
      await window.neko.githubCloneProject(repoFullName, githubCloneParent || undefined, githubCloneName || undefined);
      setModal(null);
    } catch (error) {
      setGithubError("Erro ao clonar repositório.");
      console.warn("[Github] clone failed", String((error as Error)?.message ?? error));
    } finally {
      setGithubBusy(false);
    }
  }

  async function publishCurrentProject() {
    if (!githubPublishRepoName.trim() || githubPublishBusy) return;
    setGithubPublishBusy(true);
    setGithubPublishError("");
    try {
      await window.neko.githubPublishProject(githubPublishRepoName.trim(), githubPublishPrivate);
      setModal(null);
      const git = await window.neko.githubGitStatus();
      setGithubLinkStatus(git);
    } catch (error) {
      setGithubPublishError("Erro ao publicar projeto.");
      console.warn("[Github] publish failed", String((error as Error)?.message ?? error));
    } finally {
      setGithubPublishBusy(false);
    }
  }

  async function linkGithubProject(replaceRemote: boolean) {
    if (!githubLinkRepo || githubLinkBusy) return;
    setGithubLinkBusy(true);
    setGithubLinkError("");
    try {
      await window.neko.githubLinkProject(githubLinkRepo.fullName, replaceRemote, false);
      const git = await window.neko.githubGitStatus();
      setGithubLinkStatus(git);
      setModal("github");
    } catch (error) {
      const msg = String((error as Error)?.message ?? error);
      setGithubLinkError(msg.includes("já contém") ? msg : "Erro ao vincular repositório.");
      console.warn("[Github] link failed", msg);
    } finally {
      setGithubLinkBusy(false);
    }
  }

  function cancelGithubPublish() {
    setGithubPublishBusy(false);
    setGithubPublishError("");
    setModal("github");
  }

  async function handleBranchDiscardAndCheckout() {
    if (!pendingTargetBranch || branchActionBusy) return;
    setBranchActionBusy(true);
    setBranchActionError("");
    try {
      await window.neko.githubDiscardChanges();
      await window.neko.githubCheckoutBranch(pendingTargetBranch);
      const git = await window.neko.githubGitStatus();
      setGithubLinkStatus(git);
      setModal(null);
      setPendingTargetBranch(null);
    } catch (error) {
      setBranchActionError("Erro ao descartar e trocar de branch.");
      console.warn("[Branch] discard+checkout failed", String((error as Error)?.message ?? error));
    } finally {
      setBranchActionBusy(false);
    }
  }

  async function handleBranchCommitAndCheckout() {
    if (!pendingTargetBranch || !branchCommitMessage.trim() || branchActionBusy) return;
    setBranchActionBusy(true);
    setBranchActionError("");
    try {
      await window.neko.githubCommitPush(branchCommitMessage.trim());
      await window.neko.githubCheckoutBranch(pendingTargetBranch);
      const git = await window.neko.githubGitStatus();
      setGithubLinkStatus(git);
      setModal(null);
      setPendingTargetBranch(null);
    } catch (error) {
      setBranchActionError("Erro ao salvar e trocar de branch.");
      console.warn("[Branch] commit+checkout failed", String((error as Error)?.message ?? error));
    } finally {
      setBranchActionBusy(false);
    }
  }

  async function disconnectSupabase() {
    if (supabaseBusy) return;
    setSupabaseBusy(true);
    try {
      await window.neko.supabaseDisconnect();
    } catch (error) {
      console.warn("[Supabase] disconnect failed", String((error as Error)?.message ?? error));
    } finally {
      setSupabaseBusy(false);
    }
  }

  async function openSupabaseTokenPage() {
    try {
      await window.neko.supabaseOpenTokenPage();
    } catch (error) {
      console.warn("[Supabase] openTokenPage failed", String((error as Error)?.message ?? error));
    }
  }

  async function refreshSupabaseProjects(clearNotice = false) {
    if (supabaseBusy) return;
    setSupabaseBusy(true);
    try {
      await window.neko.supabaseRefreshProjects(clearNotice);
    } catch (error) {
      console.warn("[Supabase] refreshProjects failed", String((error as Error)?.message ?? error));
    } finally {
      setSupabaseBusy(false);
    }
  }

  async function selectSupabaseProject(ref: string) {
    if (supabaseBusy) return;
    setSupabaseBusy(true);
    try {
      await window.neko.supabaseSelectProject(ref);
    } catch (error) {
      setSupabaseError("Erro ao selecionar projeto.");
      console.warn("[Supabase] selectProject failed", String((error as Error)?.message ?? error));
    } finally {
      setSupabaseBusy(false);
    }
  }

  async function createSupabaseProject(e: React.FormEvent) {
    e.preventDefault();
    if (supabaseBusy || !newSupabaseProjectName.trim() || !newSupabaseProjectPassword.trim() || !newSupabaseProjectOrg) return;
    setSupabaseBusy(true);
    setNewSupabaseProjectError("");
    setNewSupabaseProjectStructuredError(null);
    try {
      await window.neko.supabaseCreateProject({
        name: newSupabaseProjectName.trim(),
        orgId: newSupabaseProjectOrg,
        dbPassword: newSupabaseProjectPassword,
        region: newSupabaseProjectRegion
      });
      setSupabaseView("projects");
    } catch (error: any) {
      const structured = error?.structuredError || error?.data;
      if (structured?.code && structured?.title) {
        setNewSupabaseProjectStructuredError(structured);
      } else {
        setNewSupabaseProjectError(String(error?.message ?? "Erro ao criar projeto."));
      }
      console.warn("[Supabase] createProject failed", String((error as Error)?.message ?? error));
    } finally {
      setSupabaseBusy(false);
    }
  }

  async function connectSupabaseWithToken(e: React.FormEvent) {
    e.preventDefault();
    if (supabaseBusy || !supabaseToken.trim()) return;
    setSupabaseBusy(true);
    setSupabaseError("");
    try {
      await window.neko.supabaseConnectWithToken(supabaseToken.trim());
      setSupabaseToken("");
    } catch (error) {
      setSupabaseError("Token inválido ou conexão falhou.");
      console.warn("[Supabase] connectWithToken failed", String((error as Error)?.message ?? error));
    } finally {
      setSupabaseBusy(false);
    }
  }

  async function handleConnectVercel() {
    if (vercelBusy) return;
    setVercelBusy(true);
    setVercelError(null);
    try {
      await window.neko.vercelConnect();
    } catch (error) {
      setVercelError("Erro ao conectar com Vercel.");
      console.warn("[Vercel] connect failed", String((error as Error)?.message ?? error));
    } finally {
      setVercelBusy(false);
    }
  }

  async function handleDisconnectVercel() {
    if (vercelBusy || vercelState.deployment === "deploying") return;
    setVercelBusy(true);
    try {
      await window.neko.vercelDisconnect();
      setVercelError(null);
    } catch (error) {
      console.warn("[Vercel] disconnect failed", String((error as Error)?.message ?? error));
    } finally {
      setVercelBusy(false);
    }
  }

  async function handlePublishVercel() {
    if (!project || vercelBusy || vercelState.deployment === "deploying") return;
    if (!vercelState.linked && !isValidVercelProjectName(vercelProjectName)) return;
    setVercelBusy(true);
    setVercelError(null);
    try {
      await window.neko.vercelPublish(vercelState.linked ? undefined : vercelProjectName);
    } catch (error) {
      setVercelError("Erro ao publicar na Vercel.");
      console.warn("[Vercel] publish failed", String((error as Error)?.message ?? error));
    } finally {
      setVercelBusy(false);
    }
  }

  // Preview Page Selector: discover routes of the ACTIVE project. Guarded to
  // prevent concurrent scans and React re-render loops. Only setState when the
  // list actually changed.
  async function loadPreviewRoutes(force = false) {    if (!projectRef.current || previewRouteLoadingRef.current) return;
    if (!force && previewRoutesProjectRef.current === projectRef.current && previewRoutes.length > 0) return;
    previewRouteLoadingRef.current = true;
    try {
      const result = await window.neko.previewRoutes({ force });
      if (!result?.routes || result.projectPath !== projectRef.current) return;
      const next = result.routes.filter((r: any) => r && typeof r.path === "string").map((r: any) => ({ path: r.path, label: r.label ?? r.path }));
      previewRoutesProjectRef.current = result.projectPath;
      setPreviewRoutes(prev => {
        const same = prev.length === next.length && prev.every((r, i) => r.path === next[i].path && r.label === next[i].label);
        return same ? prev : next;
      });
    } catch (error) {
      console.warn("[Preview Routes] load failed", String((error as Error)?.message ?? error));
    } finally {
      previewRouteLoadingRef.current = false;
    }
  }

  // Centraliza abrir/fechar do Page Selector. Enquanto o dropdown está aberto,
  // o Preview nativo (WebContentsView) é escondido no main process — um DOM
  // nunca consegue ficar acima de um WebContentsView; esconder a view é a
  // única forma estrutural do dropdown aparecer por cima do Preview.
  async function setPreviewRouteMenuOpen(open: boolean) {
    setPreviewRouteOpen(open);
    try { await window.neko.setInternalPreviewOverlay(open); } catch {}
  }

  async function openPreviewRouteMenu() {
    if (!previewRouteOpen) {
      await loadPreviewRoutes(true);
      await setPreviewRouteMenuOpen(true);
    } else {
      await setPreviewRouteMenuOpen(false);
    }
  }

  async function goToPreviewRoute(routePath: string) {
    if (!routePath || !project) return;
    await setPreviewRouteMenuOpen(false);
    const normalized = routePath === "/" ? "/" : routePath.replace(/\/+$/, "") || "/";
    setPreviewCurrentRoute(normalized);
    console.log(`[Preview Routes] selected route=${normalized}`);
    try {
      const result = await window.neko.previewNavigate(normalized);
      console.log(`[Preview Routes] navigate ok=${Boolean(result?.ok)} method=${result?.method ?? "-"} target=${result?.target ?? "-"}`);
    } catch (error) {
      console.warn("[Preview Routes] navigate failed", String((error as Error)?.message ?? error));
    }
  }

  const currentRouteLabel = (() => {
    const match = previewRoutes.find(r => r.path === previewCurrentRoute);
    return match ? match.label : (previewCurrentRoute === "/" ? "Home" : previewCurrentRoute.replace(/\//g, " / ") || "Home");
  })();

  // The selector is only shown when the Preview tab has an active server.
  const showPreviewSelector = previewSurface === "webcontents" && Boolean(previewUrl) && workspaceTab === "preview";

  function renderPreviewRouteSelector() {
    if (!showPreviewSelector || !previewUrl) return null;
    return (
      <div ref={previewRouteRootRef} className="preview-page-selector">
        <button
          className={`preview-page-trigger ${previewRouteOpen ? "open" : ""}`}
          onClick={() => void openPreviewRouteMenu()}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
              if (!previewRouteOpen) {
                e.preventDefault();
                void openPreviewRouteMenu();
                setPreviewRouteMenuFocus(0);
              }
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={previewRouteOpen}
          aria-label="Selecionar página do Preview"
          title={previewCurrentRoute === "/" ? "Página inicial" : `Página: ${previewCurrentRoute}`}
        >
          <span className="preview-page-label">{currentRouteLabel || "Home"}</span>
          <ChevronDown size={13} className="preview-page-caret"/>
        </button>
        {previewRouteOpen && (
            <div className="preview-page-menu" role="listbox" aria-label="Páginas do projeto">
              <div className="preview-page-menu-label">Páginas do projeto</div>
              {previewRoutes.length === 0 && <div className="preview-page-empty">Detectando páginas…</div>}
              {previewRoutes.map((route, index) => (
                <button
                  key={route.path}
                  role="option"
                  aria-selected={route.path === previewCurrentRoute}
                  className={`preview-page-item ${route.path === previewCurrentRoute ? "selected" : ""} ${previewRouteMenuFocus === index ? "hovered" : ""}`}
                  onClick={() => void goToPreviewRoute(route.path)}
                  onMouseEnter={() => setPreviewRouteMenuFocus(index)}
                  tabIndex={-1}
                >
                  <span className="preview-page-check">{route.path === previewCurrentRoute ? <Check size={13}/> : null}</span>
                  <span className="preview-page-item-text">{route.label}</span>
                  {route.path !== "/" && <span className="preview-page-item-path">{route.path}</span>}
                </button>
                  ))}
              </div>
          )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast ? <div className="neko-toast" role="status" aria-live="polite" style={{ left: toast.left, top: toast.top }}>
        <CircleAlert size={13} />
        <span>{toast.message}</span>
      </div> : null}

      <ProviderIconSprite />

      {(status === "starting" || isExiting) ? (
        <div className="home-loading-overlay" role="status" aria-live="polite">
          <div className="home-loading-box">
            <Loader2 size={26} className="spin home-loading-spin" />
            <span>{isExiting ? (projectLoadKindRef.current === "switch" ? "Trocando projeto..." : "Carregando projeto...") : "Iniciando ambiente NekoAI..."}</span>
          </div>
        </div>
      ) : null}

      {licenseState.state === "GRACE" && (
        <div className="license-grace-top-banner">
          <div className="grace-banner-left">
            <AlertTriangle size={15} />
            <span>
              <strong>Licença em Período de Tolerância:</strong> Seu acesso offline continuará ativo até {licenseState.graceUntil ? new Date(licenseState.graceUntil).toLocaleDateString("pt-BR") : "breve"}. A validação ocorrerá automaticamente assim que houver conexão.
            </span>
          </div>
        </div>
      )}

      {licenseState.isLicensed ? (
        project ? (
          <>
          {console.log("[BLACKSCREEN] workspace-render", { project, status, isLicensed: licenseState.isLicensed, isExiting: isExitingRef.current })}
          <header className={`topbar ${chatCollapsed ? "chat-collapsed" : ""}`}>
          <div className="brand">
            <img className="neko-logo-image" src={nekoLogo} alt="NekoAI" />
          </div>

          <div className="top-center-actions">
            {(project || recentProjects.length > 0) ? <div className="project-selector-wrap">
              <button
                className="project-selector"
                onClick={() => project ? openProjectSelector() : setRecentProjectsMenuOpen(v => !v)}
                title={project || "Projetos recentes"}
              >
                <span className="project-selector-icon"><FolderOpen size={19}/></span>
                <span className="project-selector-copy">
                  <b>{project ? projectName : "Projetos recentes"}</b>
                  <span>{project ? (githubLinkStatus.linkedRepo || project) : "Selecione um projeto recente"}</span>
                </span>
                <span className="project-selector-chevron">
                  {(projectMenuOpen || recentProjectsMenuOpen) ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
                </span>
              </button>

              {projectMenuOpen && project ? <div className="project-selector-menu recent-menu">
                <div className="recent-menu-label">PROJETO ATUAL</div>
                <div className="project-menu-current">
                  <FolderOpen size={14}/>
                  <div><b>{projectName}</b><small>{project}</small></div>
                </div>
                {recentProjects.filter(item => item.path !== project).length ? <>
                  <div className="recent-menu-label">PROJETOS RECENTES</div>
                  {recentProjects.filter(item => item.path !== project).map(item =>
                    <button
                      key={item.path}
                      className="recent-project-item"
                      disabled={isSwitchingProject}
                      onClick={() => { setProjectMenuOpen(false); setRecentProjectsMenuOpen(false); void openRecentProject(item.path, "RecentProjects"); }}
                    >
                      <Folder size={14}/>
                      <span><b>{item.name}</b><small>{item.path}</small></span>
                      {isSwitchingProject ? <Loader2 size={12} className="spin" /> : null}
                    </button>
                  )}
                </> : null}
                {githubStatus.connected && githubLinkStatus.linkedRepo ? <div className="project-menu-row">
                  <span className="repo-badge"><GitHubIcon size={13}/>{githubLinkStatus.linkedRepo}</span>
                  <button className="branch-menu-trigger" disabled={githubBranchBusy || isSwitchingProject} onClick={() => { if (!githubBranchBusy && !isSwitchingProject) { setGithubBranchMenuOpen(v => !v); void refreshGithubBranches(); } }}>
                    {githubBranchBusy ? <Loader2 size={12} className="spin" /> : <GitBranch size={12}/>}{githubBranchBusy ? "Trocando..." : (githubLinkStatus.branch || "main")}<ChevronDown size={12}/>
                  </button>
                </div> : null}
                <button className="project-menu-action" disabled={isSwitchingProject} onClick={() => void openOtherProject()}>
                  <FolderOpen size={14}/> Abrir outro projeto
                </button>
              </div> : null}

              {recentProjectsMenuOpen && !project ? <div className="project-selector-menu recent-menu">
                <div className="recent-menu-label">PROJETOS RECENTES</div>
                {recentProjects.map(item =>
                  <button
                    key={item.path}
                    className="recent-project-item"
                    disabled={isSwitchingProject}
                    onClick={() => { setProjectMenuOpen(false); setRecentProjectsMenuOpen(false); void openRecentProject(item.path, "RecentProjects"); }}
                  >
                    <Folder size={14}/>
                    <span><b>{item.name}</b><small>{item.path}</small></span>
                    {isSwitchingProject ? <Loader2 size={12} className="spin" /> : null}
                  </button>
                )}
                <button className="project-menu-action" disabled={isSwitchingProject} onClick={() => void openOtherProject()}>
                  <FolderOpen size={14}/> Abrir nova pasta
                </button>
              </div> : null}
            </div> : null}

            <button className="top-action primary-action" onClick={() => void createProject()}>
              <Plus size={18}/> Novo Projeto
            </button>
            <button className="top-action clone-action" onClick={() => { setCloneUrl(""); setCloneBusy(false); setCloneProgress({ scanned: 0, currentUrl: "" }); setCloneAnalysis(null); setCloneError(""); setModal("siteClone"); }}>
              <Globe2 size={18}/> Clonar Site
            </button>
          </div>

          <div className="top-right-actions">
            <button className="tutorials-top-btn" onClick={() => setModal("tutorials")} title="Tutoriais do NekoAI" aria-label="Tutoriais do NekoAI">
              <Play size={13} fill="currentColor"/>
              <span>Tutoriais</span>
            </button>
            <button
              className={`integration-status ${vercelState.connection === "connected" ? "online" : vercelState.deployment === "deploying" ? "busy" : vercelState.connection === "error" || vercelState.deployment === "error" ? "error" : "idle"}`}
              onClick={() => {
                setVercelError(null);
                const folderName = project ? (project.split(/[/\\]/).filter(Boolean).pop() || "") : "";
                setVercelProjectName(slugifyVercelProjectName(folderName));
                setModal("vercel");
              }}
              title={
                vercelState.deployment === "deploying"
                  ? "Vercel — Publicando em produção..."
                  : vercelState.deploymentUrl
                  ? `Vercel — Publicado: ${vercelState.deploymentUrl}`
                  : vercelState.connection === "connected"
                  ? `Vercel — Conectado como ${vercelState.username || "usuário"}`
                  : vercelState.connection === "authorizing"
                  ? "Vercel — Conectando no terminal..."
                  : vercelState.connection === "error"
                  ? `Vercel — Erro: ${vercelState.error || "falha na conexão"}`
                  : "Vercel — Publicar em produção"
              }
            >
              {vercelState.deployment === "deploying" ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <VercelIcon size={17} />
              )}
              <span className="integration-dot" />
            </button>
            <button
              className={`integration-status ${supabaseState.status === "connected" ? "online" : "idle"}`}
              onClick={() => {
                console.log("[SupabaseUI] topbar Supabase icon clicked, current state:", supabaseState);
                setSupabaseError("");
                setSupabaseView("auto");
                setModal("supabase");
              }}
              title={
                supabaseState.status === "connected"
                  ? `Supabase — Conectado${supabaseState.projectName ? `: ${supabaseState.projectName}` : ""}`
                  : ["checking", "authorizing", "verifying", "selecting", "validating", "installing"].includes(supabaseState.status)
                  ? "Supabase — Conectando..."
                  : supabaseState.status === "error"
                  ? `Supabase — Erro${supabaseState.error ? `: ${supabaseState.error}` : ""}`
                  : "Supabase — Não conectado"
              }
            >
              <SupabaseIcon size={17}/>
              <span className="integration-dot"/>
            </button>
            <button
              className={`integration-status ${licenseState.state === "VALID" ? "online" : licenseState.state === "GRACE" ? "busy" : "idle"}`}
              onClick={() => {
                setLicenseError(null);
                setLicenseSuccessMessage(null);
                setModal("license");
              }}
              title={
                licenseState.state === "VALID"
                  ? `Licença Ativa — Plano ${licenseState.plan || ""}`
                  : licenseState.state === "GRACE"
                  ? "Licença em Período de Tolerância"
                  : licenseState.state === "EXPIRED"
                  ? "Licença Expirada"
                  : licenseState.state === "INVALID"
                  ? "Licença Inválida"
                  : "Gerenciar Licença"
              }
            >
              <Key size={16}/>
              <span className="integration-dot"/>
            </button>
            <button className={`integration-status ${githubStatus.connected ? "online" : "idle"}`} onClick={() => { setGithubError(""); setGithubShowRepos(false); setGithubCommitSuccess(false); setModal("github"); }} title={githubStatus.connected ? `GitHub conectado como ${githubStatus.user?.login || ""}` : "GitHub não conectado"}>
              <GitHubIcon size={17}/>
              <span className="integration-dot"/>
            </button>
            <button
              className={`integration-status ${updaterState.status === "available" || updaterState.status === "error" ? "idle" : updaterState.status === "checking" || updaterState.status === "downloading" ? "busy" : "online"}`}
              onClick={() => {
                setModal("settings");
              }}
              title={
                updaterState.status === "available"
                  ? `Configurações — Nova versão disponível (${updaterState.updateInfo?.version || ""})`
                  : updaterState.status === "downloaded"
                  ? "Configurações — Atualização pronta para reiniciar"
                  : updaterState.status === "downloading"
                  ? `Configurações — Baixando atualização (${Math.round(updaterState.progress?.percent || 0)}%)`
                  : updaterState.status === "error"
                  ? `Configurações — Erro na verificação: ${updaterState.error || ""}`
                  : "Configurações — NekoAI atualizado"
              }
            >
              {updaterState.status === "checking" || updaterState.status === "downloading" ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Settings2 size={17} />
              )}
              <span className="integration-dot" />
            </button>
            {project ? (
              <button className="top-exit-btn" onClick={() => void exitProject("topbarExit")} disabled={isExiting} title="Sair do projeto e voltar à Home" aria-label="Sair do projeto">
                <LogOut size={16}/>
                <span>{isExiting ? "Saindo..." : "Sair"}</span>
              </button>
            ) : null}
            {project && githubLinkStatus.linkedRepo ? <div className="top-branch-wrap">
              <button className="top-branch-btn" onClick={() => { if (!githubBranchBusy) { setGithubBranchMenuOpen(v => !v); void refreshGithubBranches(); } }} disabled={githubBranchBusy}>
                {githubBranchBusy ? <Loader2 size={13} className="spin"/> : <GitBranch size={13}/>}
                <span>{githubLinkStatus.branch || "main"}</span>
                <ChevronDown size={13}/>
              </button>
              {githubBranchMenuOpen ? <div className="top-branch-menu">
                {Array.from(new Set(githubBranches.length ? githubBranches : [githubLinkStatus.branch || "main"])).map(branch =>
                  <button
                    key={branch}
                    disabled={githubBranchBusy}
                    className={`top-branch-item ${branch === githubLinkStatus.branch ? "active" : ""}`}
                    onClick={() => { if (!githubBranchBusy) void chooseGithubBranch(branch); }}
                  >
                    {branch === githubLinkStatus.branch ? <Check size={12}/> : <span className="branch-placeholder"/>}
                    <span>{branch}</span>
                    {githubBranchBusy && branch !== githubLinkStatus.branch ? <Loader2 size={10} className="spin branch-item-spin"/> : null}
                  </button>
                )}
                {githubBranchError ? <div className="branch-picker-error">{githubBranchError}</div> : null}
              </div> : null}
            </div> : null}
            <div className="top-status"><span className={`status-dot ${status}`} />{status === "online" ? "Neko online" : status === "starting" ? "Iniciando..." : "Sem projeto"}</div>
          </div>
        </header>

        <main className={`studio ${chatCollapsed ? "chat-collapsed" : ""}`}>
          <section className="chat-panel">
            <div className="messages" ref={messagesRef}>
              {messages.length === 0 && <div className={`empty ${project ? "project-empty" : "no-project-empty"}`}>
                <div className="cat"><Sparkles size={24}/></div>
                <h2>{project ? "O que vamos construir?" : "O que vamos construir?"}</h2>
                <p>{project ? "Descreva seu software. O Neko cuida do código, dependências e preview." : "Descreva seu software. O Neko cuida do código, dependências e preview."}</p>
                {!project ? <button className="empty-new-project" onClick={() => void createProject()}><Plus size={17}/> Novo Projeto</button> : null}
              </div>}
              {(() => {
                const timeline: Array<{ kind: "message" | "pendingPlan" | "approvedPlan"; createdAt: number; index?: number }> = messages.map((message, index) => ({ kind: "message", createdAt: message.createdAt ?? index, index }));
                if (pendingPlan) timeline.push({ kind: "pendingPlan", createdAt: pendingPlan.messageCreatedAt + 0.1 });
                if (approvedPlan) timeline.push({ kind: "approvedPlan", createdAt: approvedPlan.approvedAt });
                timeline.sort((a, b) => a.createdAt - b.createdAt);
                return timeline.map((item, timelineIndex) => {
                  if (item.kind === "pendingPlan" && pendingPlan) return <div key={`pending-plan-${pendingPlan.messageCreatedAt}`} className="plan-approval-card">
                    <div className="plan-approval-head"><div><b>Plano pronto para revisão</b><span>O Neko analisou a tarefa. Revise um resumo antes de permitir as alterações.</span></div><Sparkles size={16}/></div>
                    <div className="plan-approval-title">Resumo do plano</div>
                    <div className="plan-approval-body plan-approval-preview">{planPreview(pendingPlan.planText)}</div>
                    <button className="plan-expand-btn" onClick={() => setPlanExpanded(v => !v)}>{planExpanded ? <><ChevronUp size={12}/> Ocultar plano completo</> : <><ChevronDown size={12}/> Ver plano completo</>}</button>
                    {planExpanded && <div className="plan-approval-body plan-approval-full">{pendingPlan.planText}</div>}
                    <div className="plan-approval-actions"><button className="plan-reject-btn" onClick={rejectPlan} disabled={planApprovalBusy}>Cancelar</button><button className="plan-approve-btn" onClick={() => void approvePlan()} disabled={planApprovalBusy}>{planApprovalBusy ? "Executando..." : "Aprovar e executar"}</button></div>
                  </div>;
                  if (item.kind === "approvedPlan" && approvedPlan) return <div key={`approved-plan-${approvedPlan.approvedAt}`} className="plan-approved-card">
                    <div className="plan-approved-head"><span><Check size={13}/> PLANO APROVADO</span><span>Build iniciado</span></div>
                    <div className="plan-approved-summary">{planPreview(approvedPlan.planText)}</div>
                    <button className="plan-expand-btn" onClick={() => setPlanExpanded(v => !v)}>{planExpanded ? <><ChevronUp size={12}/> Ocultar plano completo</> : <><ChevronDown size={12}/> Ver plano completo</>}</button>
                    {planExpanded && <div className="plan-approval-body plan-approval-full">{approvedPlan.planText}</div>}
                  </div>;
                  const index = item.index!; const message = messages[index];
                  return <div key={`message-${index}-${message.createdAt ?? timelineIndex}`} className={`message ${message.role}`}>
                    <div className="message-label">{message.role === "user" ? "Você" : message.role === "assistant" ? "Neko" : message.role}</div>
                    {message.text&&<CollapsibleMessageBody text={message.text}/>}
                    {message.attachments?.length?<div className="message-attachments">{message.attachments.map((a,i)=>(
                      a.kind==="image"&&a.previewUrl
                        ? <button type="button" className="message-image-thumb" key={`${a.path}:${i}`} onClick={()=>setLightboxImage({url:a.previewUrl!,name:a.name})} title={`Visualizar ${a.name}`} aria-label={`Visualizar ${a.name}`}><img src={a.previewUrl} alt={a.name}/></button>
                        : <div className={`message-attachment ${a.kind}`} key={`${a.path}:${i}`}>{a.kind==="image"&&a.previewUrl?<img src={a.previewUrl} alt={a.name}/>:<div className="attachment-ext">{(a.extension||"FILE").slice(0,6)}</div>}<span title={a.name}>{a.name.length>28?`${a.name.slice(0,28)}…`:a.name}</span></div>
                    ))}</div>:null}
                    {message.role === "assistant" && message.taskId && message.durationMs !== undefined && <div className="message-actions assistant-actions"><button onClick={(e) => void undoAgentTask(index, e.currentTarget)} disabled={busy} title="Desfazer tarefa" aria-label="Desfazer tarefa"><Undo2 size={13}/></button><button onClick={(e) => void copyMessage(message.text, e.currentTarget)} title="Copiar resposta" aria-label="Copiar resposta"><Copy size={13}/></button><span className="message-duration" title="Tempo da tarefa">{formatTaskDuration(message.durationMs)}</span></div>}
                    {message.role === "user" && <div className="message-actions user-actions"><button onClick={(e) => void copyMessage(message.text, e.currentTarget)} title="Copiar" aria-label="Copiar"><Copy size={13}/></button><button onClick={() => editUserMessage(index)} disabled={busy} title="Editar" aria-label="Editar"><Pencil size={12}/></button></div>}
                  </div>;
                });
              })()}
              {busy && <div className="working"><Loader2 size={15} className="spin"/><span>{workingStatus || "Neko está trabalhando..."}</span></div>}
              {!busy && (pendingQuestion || pendingPermission) && workingStatus && <div className="working waiting"><CircleAlert size={15}/><span>{workingStatus}</span></div>}
            </div>
            {pendingQuestion && <AgentDecisionCard
              question={pendingQuestion}
              onAnswer={(value) => void answerQuestion(value)}
              onDismiss={() => void rejectQuestion(pendingQuestion)}
            />}
            {pendingPermission && (
            <div className="permission-card">
              <div className="permission-head"><ShieldAlert size={15}/><div><b>O Neko precisa da sua autorização</b><small>Uma autorização é necessária para continuar esta etapa do projeto.</small></div></div>
              <div className="permission-body"><b>Acesso necessário aos arquivos do projeto</b><small className="permission-reason">O Neko precisa desse acesso para continuar trabalhando. Nenhum detalhe interno do mecanismo é exibido aqui.</small></div>
              <div className="permission-actions"><button className="permission-reject" onClick={() => void replyPermission("reject")}>Rejeitar</button><button className="permission-once" onClick={() => void replyPermission("once")}>Permitir uma vez</button><button className="permission-always" onClick={() => void replyPermission("always")}>Permitir sempre</button></div>
            </div>
          )}

          <div className="composer-wrap">
              <div className="composer">
                <textarea
                  ref={composerRef}
                  value={input}
                  onChange={e => {
                    const value = e.target.value;
                    const cursor = e.target.selectionStart ?? value.length;
                    setInput(value);

                    const trigger = detectAutocompleteTrigger(value, cursor);
                    if (trigger) {
                      setAutocompleteTrigger(trigger);
                      if (autocompleteMode === "files" && trigger.mode === "contexts") {
                        setAutocompleteQuery(trigger.query);
                        setAutocompleteSelectedIndex(0);
                      } else if (autocompleteMode === "folders" && trigger.mode === "contexts") {
                        setAutocompleteQuery(trigger.query);
                        setAutocompleteSelectedIndex(0);
                      } else {
                        setAutocompleteMode(trigger.mode);
                        setAutocompleteQuery(trigger.query);
                        setAutocompleteSelectedIndex(0);
                      }
                    } else {
                      setAutocompleteTrigger(null);
                      setAutocompleteMode(null);
                      setAutocompleteQuery("");
                      setAutocompleteSelectedIndex(0);
                    }
                  }}
                  onPaste={handlePaste}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={async e => {
                    e.preventDefault();
                    setDragOver(false);
                    const paths = Array.from(e.dataTransfer.files).map((f: any) => f.path).filter(Boolean);
                    if (paths.length) {
                      try {
                        addAttachmentResult(await window.neko.attachmentsFromPaths(paths));
                      } catch (error) {
                        setUploadErrors(prev => [...prev, { id: `drop:${Date.now()}`, name: "Arquivo", message: String(error), extension: "FILE" }].slice(-6));
                      }
                    }
                  }}
                  onKeyDown={e => {
                    if (autocompleteMode && autocompleteItems.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAutocompleteSelectedIndex(prev => (prev + 1) % autocompleteItems.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAutocompleteSelectedIndex(prev => (prev - 1 + autocompleteItems.length) % autocompleteItems.length);
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const selected = autocompleteItems[autocompleteSelectedIndex] || autocompleteItems[0];
                        if (selected) {
                          handleAutocompleteSelect(selected);
                        }
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        if (autocompleteMode === "files" || autocompleteMode === "folders") {
                          setAutocompleteMode("contexts");
                          setAutocompleteQuery("");
                          setAutocompleteSelectedIndex(0);
                        } else {
                          setAutocompleteMode(null);
                          setAutocompleteTrigger(null);
                        }
                        return;
                      }
                    }

                    if (e.key === "Escape") {
                      setAutocompleteMode(null);
                      setAutocompleteTrigger(null);
                      setShowSlashMenu(false);
                      setShowContextMenu(false);
                      setChatModeMenuOpen(false);
                    }
                    if (e.key === "Tab" && !e.shiftKey) {
                      e.preventDefault();
                      toggleChatModeViaTab();
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={sessionId ? "Pergunte qualquer coisa, / para comandos, @ para contexto..." : "Crie um projeto para começar..."}
                  disabled={!sessionId || busy}
                  className={dragOver ? "drag-over" : ""}
                />
                {autocompleteMode && autocompleteItems.length > 0 && (
                  <AutocompleteMenu
                    mode={autocompleteMode}
                    items={autocompleteItems}
                    selectedIndex={autocompleteSelectedIndex}
                    onSelect={handleAutocompleteSelect}
                    onHoverIndex={setAutocompleteSelectedIndex}
                    onBack={(autocompleteMode === "files" || autocompleteMode === "folders") ? () => {
                      setAutocompleteMode("contexts");
                      setAutocompleteQuery("");
                      setAutocompleteSelectedIndex(0);
                    } : undefined}
                  />
                )}
                {(attachments.length>0||uploadErrors.length>0)&&<div className="attachment-strip">{attachments.map((a,i)=>(a.kind==="image"&&a.previewUrl?
                  <div className="attachment-preview-card image-thumb" key={`${a.path}:${i}`}>
                    <button type="button" className="image-thumb-btn" onClick={()=>setLightboxImage({url:a.previewUrl!,name:a.name})} title={`Visualizar ${a.name}`} aria-label={`Visualizar ${a.name}`}><img src={a.previewUrl} alt={a.name}/></button>
                    <button className="attachment-remove" onClick={()=>setAttachments(prev=>prev.filter((_,idx)=>idx!==i))} aria-label={`Remover ${a.name}`}><X size={12}/></button>
                  </div>
                  :<div className={`attachment-preview-card ${a.kind}`} key={`${a.path}:${i}`}><div className="attachment-preview-media">{a.kind==="image"&&a.previewUrl?<img src={a.previewUrl} alt={a.name}/>:<div className="attachment-doc-preview">{(a.extension||(a.name.split(".").pop()||"FILE")).slice(0,6).toUpperCase()}</div>}</div><div className="attachment-preview-info"><b title={a.name}>{a.name}</b><small>{formatBytes(a.size)}</small></div><button className="attachment-remove" onClick={()=>setAttachments(prev=>prev.filter((_,idx)=>idx!==i))} aria-label={`Remover ${a.name}`}><X size={12}/></button></div>
                ))}{uploadErrors.map(e=><div className="attachment-preview-card failed" key={e.id}><div className="attachment-preview-media"><div className="attachment-doc-preview error">{e.extension.slice(0,6).toUpperCase()}</div></div><div className="attachment-preview-info"><b>Falha no Upload</b><small title={e.message}>{e.name}</small></div><button className="attachment-remove" onClick={()=>setUploadErrors(prev=>prev.filter(x=>x.id!==e.id))} aria-label="Remover erro"><X size={12}/></button></div>)}</div>}
                <div className="composer-bar"><button className="plus" aria-label="Adicionar contexto" onClick={() => void handlePickAttachments()} disabled={busy}><Plus size={17}/></button>
                  <div className="model-anchor">
                    <button className="model-inline" onClick={() => setModelOpen(v => !v)} disabled={busy}><span className="spark">{selected ? <ProviderIcon id={selected.providerID} size={15}/> : <Sparkles size={15}/>}</span><span>{selected?.name || "Selecionar modelo"}</span><ChevronDown size={14}/></button>
                    {modelOpen && <div className="model-popover" role="dialog" aria-label="Selecionar modelo">
                      <div className="model-search"><Search size={15}/><input autoFocus value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="Buscar modelos" aria-label="Buscar modelos" /></div>
                      <div className="model-list" onWheel={e => e.stopPropagation()}>
                        {modelGroups.length ? modelGroups.map(group => <section className="model-picker-group" key={group.providerID}>
                          <div className="model-picker-provider"><span className="model-picker-provider-icon"><ProviderIcon id={group.providerID} size={14}/></span><span>{group.providerName}</span><small>{group.models.length} {group.models.length === 1 ? "modelo" : "modelos"}</small></div>
                          <div className="model-picker-items">
                            {group.models.map(m => <button key={`${m.providerID}:${m.modelID}`} className={`model-choice ${selectedModel?.providerID === m.providerID && selectedModel?.modelID === m.modelID ? "selected" : ""}`} onClick={() => { modelPickSourceRef.current = "user"; setSelectedModel({ providerID: m.providerID, modelID: m.modelID }); setModelOpen(false); }}>
                              <span className="model-glyph"><ProviderIcon id={m.providerID} size={15}/></span><span><b>{m.name}</b><small>{m.modelID}</small></span>{selectedModel?.providerID === m.providerID && selectedModel?.modelID === m.modelID && <i><Check size={14}/></i>}
                            </button>)}
                          </div>
                        </section>) : <div className="model-picker-empty">{modelSearch ? "Nenhum modelo encontrado." : "Nenhum provider ativo disponível."}</div>}
                      </div>
                      <button className="manage-models" onClick={() => { setModelOpen(false); setModal("models"); }}><Settings2 size={15}/> Gerenciar modelos</button>
                    </div>}
                  </div>
                  <button className="effort" onClick={() => setEffort(effort === "Low" ? "Medium" : effort === "Medium" ? "High" : "Low")} disabled={busy}>{effort} <ChevronDown size={14}/></button>
                  <div className="chat-mode-anchor" ref={chatModeAnchorRef}>
                    <button
                      className={`chat-mode-trigger ${planMode ? "plan" : "build"}`}
                      onClick={() => { if (!busy) setChatModeMenuOpen(v => !v); }}
                      disabled={busy}
                      aria-haspopup="listbox"
                      aria-expanded={chatModeMenuOpen}
                      aria-label={`Modo: ${chatModeLabel(chatMode)}`}
                      title={`${chatModeLabel(chatMode)} — Tab alterna para ${chatModeLabel(nextChatMode(chatMode))}`}
                    >
                      {planMode ? <FileCode2 size={14}/> : <Zap size={14}/>}
                      <span>{chatModeLabel(chatMode)}</span>
                      <ChevronDown size={13} className="chat-mode-caret"/>
                    </button>
                    {chatModeMenuOpen && (
                      <div className="chat-mode-menu" role="listbox" aria-label="Modo do chat">
                        {CHAT_MODES.map(m => (
                          <button key={m} role="option" aria-selected={chatMode === m} className={`chat-mode-item ${chatMode === m ? "selected" : ""}`} onClick={() => selectChatMode(m)}>
                            <span className="chat-mode-check">{chatMode === m ? <Check size={13}/> : null}</span>
                            <span>{chatModeLabel(m)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className={`send-btn ${busy ? "stop" : ""}`} onClick={() => void (busy ? stopDevelopment() : send())} disabled={!sessionId || (!busy && !input.trim() && attachments.length === 0)} aria-label={busy ? "Parar desenvolvimento" : "Enviar"}>{busy ? <Square size={13} fill="currentColor"/> : <ArrowUp size={17}/>}</button>
                </div>
              </div>
            </div>
          </section>

          <section className="workspace">
            <div className="workspace-toolbar"><div className="workspace-toolbar-left"><div className="workspace-tabs"><button className="collapse-chat-btn" onClick={()=>setChatCollapsed(v=>!v)} aria-label={chatCollapsed?"Abrir chat":"Fechar chat"}>{chatCollapsed?<PanelLeftOpen size={15}/>:<PanelLeftClose size={15}/>}</button><button className={workspaceTab === "preview" ? "active" : ""} onClick={() => setWorkspaceTab("preview")}><Eye size={15}/> Preview</button><button className={workspaceTab === "code" ? "active" : ""} onClick={() => setWorkspaceTab("code")}><Code2 size={15}/> Código</button>{previewFramework ? <span className="workspace-framework">{previewFramework}</span> : null}</div></div><div className="workspace-toolbar-center">{renderPreviewRouteSelector()}</div><div className="workspace-tools">{workspaceTab === "preview" && <><button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")}><Monitor size={14}/></button><button className={device === "tablet" ? "active" : ""} onClick={() => setDevice("tablet")}><Tablet size={14}/></button><button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")}><Smartphone size={14}/></button></>}<button disabled={!previewUrl || previewStatus !== "ready"} onClick={() => void handlePreviewRefresh()} aria-label="Atualizar preview" title={previewUrl && previewStatus === "ready" ? "Atualizar preview" : "Preview indisponível"}><RefreshCw size={15}/></button><button disabled={!previewUrl || previewStatus !== "ready"} onClick={() => { if (!previewUrl || previewStatus !== "ready") return; console.log("[Neko/PreviewExternal] click", `url=${String(previewUrl)}`); void window.neko.openPreviewExternal(previewUrl).then(() => console.log("[Neko/PreviewExternal] invoke-resolved")).catch((error) => console.warn("[Neko/PreviewExternal] invoke-rejected", String(error?.message ?? error))); }} aria-label="Abrir externamente" title={previewUrl && previewStatus === "ready" ? "Abrir em janela externa" : "Preview indisponível"}><ExternalLink size={15}/></button></div></div>
            <div className="workspace-content">{workspaceTab === "preview" ? <div className="preview-body">{previewUrl ? <div className={`browser-frame device-${device}`}><div className="browser-bar"><span className="browser-dots"><i/><i/><i/></span><span className="url">{previewUrl}</span></div>{previewSurface === "webcontents" ? <div ref={previewViewHostRef} className="preview-webcontents-host" aria-label="Neko Preview interno"/> : <iframe key={previewFrameReloadKey} ref={previewFrameRef} title="Neko Preview (fallback)" className={previewFrameReady ? "preview-frame-ready" : "preview-frame-loading"} src={previewUrl} onLoad={() => { const readyTimeout = setTimeout(() => setPreviewFrameReady(true), 3000); void window.neko.stylePreviewFrame().finally(() => { clearTimeout(readyTimeout); setPreviewFrameReady(true); }); }} onError={() => { appendTerminalLine("error", "Erro ao carregar preview de fallback", "Preview"); setPreviewFrameReady(true); }}/>}</div> : <div className="preview-empty"><div className="preview-icon"><Globe2 size={26}/></div><strong>{previewStatus === "error" ? "Não foi possível iniciar o preview" : previewStatus === "starting" ? "Iniciando servidor..." : previewStatus === "installing" ? "Instalando dependências..." : "Seu app aparecerá aqui"}</strong><span>{previewMessage || "Crie ou abra um projeto com um script dev para iniciar o preview."}</span>{previewStatus === "error" && <button className="preview-retry" onClick={() => void window.neko.startPreview().then(preview => { if (preview?.status === "ready" && preview?.url) { setPreviewUrl(preview.url); setPreviewStatus(preview.status); if (preview.framework) setPreviewFramework(preview.framework); setPreviewLoading(false); } })}><RefreshCw size={15}/> Tentar novamente</button>}</div>}</div> : <CodeWorkspace projectRoot={project} tree={tree} lastChangedFile={codeChangedFile} />}</div>
            <div className={`terminal-panel ${terminalOpen ? "open" : "closed"}`}>
              <div className="terminal-head"><div className="terminal-tabs"><button className={terminalTab === "logs" ? "active" : ""} onClick={() => { setTerminalTab("logs"); setTerminalOpen(true); }}>Logs</button><button className={terminalTab === "console" ? "active" : ""} onClick={() => { setTerminalTab("console"); setTerminalOpen(true); }}>Console</button><button className={terminalTab === "errors" ? "active" : ""} onClick={() => { setTerminalTab("errors"); setTerminalOpen(true); }}>Erros</button></div><button className="terminal-collapse" onClick={() => setTerminalOpen(v => !v)}>{terminalOpen ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button></div>
              {terminalOpen && (terminalTab === "console" ? (
                <div className="console-panel">
                  <div className="console-toolbar">
                    <div className="console-filters">
                      {CONSOLE_LEVELS.map(opt => (
                        <button key={opt.key} className={`console-filter ${consoleFilter === opt.key ? "active" : ""}`} onClick={() => setConsoleFilter(opt.key)}>
                          {opt.label} <span className="console-count">{consoleCounts[opt.key] ?? 0}</span>
                        </button>
                      ))}
                    </div>
                    <button className="console-clear" onClick={clearConsole} title="Limpar console" aria-label="Limpar console"><Trash2 size={12}/> Limpar</button>
                  </div>
                  <div className="terminal-body console-body" ref={consoleBodyRef} onScroll={handleConsoleScroll}>
                    {consoleFiltered.length === 0 && <div className="terminal-empty">Os eventos do console do Preview aparecerão aqui.</div>}
                    {consoleFiltered.map(entry => (
                      <div className={`console-line ${entry.level}`} key={entry.id}>
                        <span className="console-time">{new Date(entry.ts).toLocaleTimeString("pt-BR", { hour12: false })}</span>
                        <span className="console-level">{entry.level.toUpperCase()}</span>
                        <span className="console-msg" title={entry.url || ""}>{entry.message}</span>
                        {entry.source ? <span className="console-source" title={entry.url || ""}>{entry.source}</span> : null}
                        <button className="console-copy" onClick={() => navigator.clipboard.writeText(entry.message).catch(() => {})} title="Copiar" aria-label="Copiar"><Copy size={11}/></button>
                      </div>
                    ))}
                  </div>
                  {consoleNewBelow && <button className="console-jump" onClick={scrollConsoleToBottom}>Novas mensagens</button>}
                </div>
              ) : (
                <div className="terminal-body" ref={terminalBodyRef}>{terminalLines.filter(line => terminalTab === "logs" ? line.kind === "log" : terminalTab === "errors" ? line.kind === "error" : line.kind === "error").map(line => <div className={`terminal-line ${line.kind}`} key={line.id}><span className="terminal-source">{line.source || (line.kind === "error" ? "Erro" : "Neko")}</span><span>{line.text}</span></div>)}{terminalLines.filter(line => terminalTab === "logs" ? line.kind === "log" : terminalTab === "errors" ? line.kind === "error" : line.kind === "error").length === 0 && <div className="terminal-empty">Nenhum registro ainda.</div>}</div>
              ))}
            </div>
          </section>
        </main>
      </>
        ) : (
          <>
          {console.log("[BLACKSCREEN] home-render", { project, status, isLicensed: licenseState.isLicensed })}
          <main className="home-screen">
          <div className="home-content-container">
            {homeView === "allProjects" ? (
              <div className="projects-page">
                <div className="breadcrumb-bar">
                  <button className="breadcrumb-home-btn" onClick={() => setHomeView("home")}>
                    <HomeIcon size={14} />
                    <span>Home</span>
                  </button>
                  <span className="breadcrumb-sep">&gt;</span>
                  <span className="breadcrumb-active">Meus Projetos</span>
                </div>

                <div className="projects-search-wrap">
                  <Search size={16} className="projects-search-icon" />
                  <input
                    type="text"
                    className="projects-search-input"
                    placeholder="Pesquise por seus projetos..."
                    value={projectSearchQuery}
                    onChange={e => setProjectSearchQuery(e.target.value)}
                  />
                  {projectSearchQuery && (
                    <button
                      className="projects-search-clear"
                      onClick={() => setProjectSearchQuery("")}
                      title="Limpar busca"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <div className="home-divider-wrap" style={{ marginTop: 0 }}>
                  <div className="home-tabs-nav">
                    <div className="home-tabs-left">
                      <button
                        className={`home-tab-btn ${homeTab === "all" ? "active" : ""}`}
                        onClick={() => setHomeTab("all")}
                      >
                        Meus projetos ({recentProjects.length})
                      </button>
                      <button
                        className={`home-tab-btn ${homeTab === "favorites" ? "active" : ""}`}
                        onClick={() => setHomeTab("favorites")}
                      >
                        Favoritos ({recentProjects.filter(p => p.favorite).length})
                      </button>
                    </div>
                  </div>
                </div>

                <div className="home-projects-area">
                  {(() => {
                    const query = projectSearchQuery.trim().toLowerCase();
                    const filteredByTab = homeTab === "favorites"
                      ? recentProjects.filter(p => p.favorite)
                      : recentProjects;
                    const displayProjects = query
                      ? filteredByTab.filter(p =>
                          (p.name && p.name.toLowerCase().includes(query)) ||
                          (p.path && p.path.toLowerCase().includes(query)) ||
                          (p.technology && p.technology.toLowerCase().includes(query))
                        )
                      : filteredByTab;

                    if (displayProjects.length === 0) {
                      return (
                        <div className="home-empty-projects">
                          <Sparkles size={28} className="home-empty-icon" />
                          <h3>{query ? "Nenhum projeto encontrado" : homeTab === "favorites" ? "Nenhum projeto favoritado" : "Nenhum projeto recente"}</h3>
                          <p>
                            {query
                              ? "Tente buscar por outro termo ou nome de pasta."
                              : homeTab === "favorites"
                              ? "Clique na estrela de qualquer projeto para adicioná-lo aos favoritos."
                              : "Crie um novo projeto ou abra uma pasta existente para começar."}
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div className="home-projects-grid">
                        {displayProjects.map(item => renderProjectCard(item, "AllProjects"))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <>
                <div className="home-hero">
                  <div className="home-brand-logo-wrap">
                    <img className="home-brand-logo" src={nekoLogo} alt="NekoAI Logo" />
                  </div>
                  <h1 className="home-hero-title">O que iremos construir juntos?</h1>
                  <p className="home-hero-subtitle">
                    Comece um projeto ou abra um existente, nós cuidamos de tudo,<br />
                    as tecnologias, dependências e servidor
                  </p>
                  <div className="home-hero-actions">
                    <button className="home-btn home-btn-primary" onClick={() => void createProject()}>
                      <FolderPlus size={17} />
                      <span>Criar novo projeto</span>
                    </button>
                    <button className="home-btn home-btn-secondary" onClick={() => void openOtherProject()}>
                      <Folder size={17} />
                      <span>Abrir projeto existente</span>
                    </button>
                  </div>
                </div>

                <div className="home-divider-wrap">
                  <div className="home-tabs-nav">
                    <div className="home-tabs-left">
                      <button
                        className={`home-tab-btn ${homeTab === "all" ? "active" : ""}`}
                        onClick={() => setHomeTab("all")}
                      >
                        Meus projetos
                      </button>
                      <button
                        className={`home-tab-btn ${homeTab === "favorites" ? "active" : ""}`}
                        onClick={() => setHomeTab("favorites")}
                      >
                        Favoritos
                      </button>
                    </div>
                    <button className="home-view-all-link" onClick={() => { setHomeView("allProjects"); setProjectSearchQuery(""); }}>
                      <span>Ver todos</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>

                <div className="home-projects-area">
                  {(() => {
                    const candidates = homeTab === "favorites"
                      ? recentProjects.filter(p => p.favorite)
                      : recentProjects;
                    // Limite na Home: máximo 8 projetos ordenados por último acesso descrescente
                    const displayProjects = candidates.slice(0, 8);

                    if (displayProjects.length === 0) {
                      return (
                        <div className="home-empty-projects">
                          <Sparkles size={28} className="home-empty-icon" />
                          <h3>{homeTab === "favorites" ? "Nenhum projeto favoritado" : "Nenhum projeto recente"}</h3>
                          <p>
                            {homeTab === "favorites"
                              ? "Clique na estrela de qualquer projeto para adicioná-lo aos favoritos."
                              : "Crie um novo projeto ou abra uma pasta existente para começar."}
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div className="home-projects-grid">
                        {displayProjects.map(item => renderProjectCard(item, "Home"))}
                      </div>
                    );
                  })()}
                </div>
              </>
            )}
          </div>
        </main>
        </>
      )
      ) : (
        <>
        {console.log("[BLACKSCREEN] license-activation-render", { isLicensed: licenseState.isLicensed, project, status })}
        <main className="home-screen license-lock-screen">
          <div className="home-content-container license-lock-container">
            <div className="home-hero">
              <div className="home-brand-logo-wrap">
                <img className="home-brand-logo" src={nekoLogo} alt="NekoAI Logo" />
              </div>
              <h1 className="home-hero-title">
                {licenseState.state === "EXPIRED" ? "Licença Expirada" : licenseState.state === "INVALID" ? "Licença Inválida" : "Ative sua licença"}
              </h1>
              <p className="home-hero-subtitle">
                {licenseState.state === "EXPIRED"
                  ? "Sua assinatura do NekoAI expirou. Renove sua licença para continuar utilizando o workspace."
                  : licenseState.state === "INVALID"
                  ? "O certificado de licença local é inválido. Insira uma chave de licença válida para desbloquear o aplicativo."
                  : "Para começar a criar e editar projetos com IA, ative sua licença."}
              </p>
              <div className="license-lock-card">
                {licenseSuccessMessage && (
                  <div className="license-success-box" style={{ marginBottom: 14 }}>
                    <CheckCircle2 size={16}/> <span>{licenseSuccessMessage}</span>
                  </div>
                )}
                {licenseError && (
                  <div className={licenseError === "Sua licença foi ativada em outro dispositivo." ? "license-info-box" : "creation-error"} style={{ marginBottom: 14 }}>
                    {licenseError === "Sua licença foi ativada em outro dispositivo." ? <ShieldCheck size={15}/> : <AlertTriangle size={15}/>}
                    <span>{licenseError}</span>
                  </div>
                )}
                {licenseErrorCode === "DEVICE_ALREADY_ACTIVE" && (
                  <div className="branch-discard-warning-card" style={{ marginBottom: 14, borderColor: "rgba(234, 179, 8, .3)", background: "rgba(234, 179, 8, .06)" }}>
                    <b style={{ color: "#fef08a" }}>Esta licença já está ativada em outro dispositivo.</b>
                    <p style={{ margin: "4px 0 10px 0", fontSize: "11.5px", color: "#eee" }}>
                      Deseja transferir o acesso para este computador? O dispositivo anterior perderá a conexão.
                    </p>
                    <button type="button" className="primary" style={{ width: "100%", justifyContent: "center", background: "#ca8a04", borderColor: "#eab308" }} onClick={() => setModal("licenseResetConfirm")}>
                      <RefreshCw size={14}/> <span>Transferir para este computador</span>
                    </button>
                  </div>
                )}
                <form onSubmit={handleActivateLicense} className="license-activate-form">
                  <div className="input-group">
                    <label htmlFor="lock-license-key">Chave de Licença:</label>
                    <input
                      id="lock-license-key"
                      type="text"
                      className="api-input"
                      value={licenseKeyInput}
                      onChange={e => setLicenseKeyInput(formatLicenseKey(e.target.value))}
                      maxLength={24}
                      placeholder="NEKO-XXXX-XXXX-XXXX-XXXX"
                      disabled={licenseBusy}
                      autoFocus
                      spellCheck={false}
                    />
                  </div>
                  <div className="modal-actions" style={{ justifyContent: "flex-end", marginTop: 16 }}>
                    <button type="submit" className="primary" style={{ width: "100%", justifyContent: "center" }} disabled={licenseBusy || !isLicenseKeyComplete(licenseKeyInput)}>
                      {licenseBusy ? <Loader2 size={16} className="spin"/> : <Check size={16}/>}
                      <span>{licenseBusy ? "Ativando..." : "Ativar Licença"}</span>
                    </button>
                  </div>
                </form>
                <div className="license-acquire-cta">
                  <span>Ainda não possui? </span>
                  <a href="https://nekoai.com.br" className="license-acquire-link" onClick={e => {
                    e.preventDefault();
                    void window.neko.openExternal("https://nekoai.com.br");
                  }}>
                    Adquira sua licença por aqui
                  </a>
                </div>
              </div>
            </div>
          </div>
        </main>
        </>
      )}

    {modal && <div className="modal-backdrop" role="presentation" onClick={() => { if (!(modal === "siteClone" && cloneBusy)) setModal(null); }}><div className={`modal ${modal === "tutorials" ? "tutorials-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} onClick={e => e.stopPropagation()}>
      {modal === "tutorials" && (() => {
        const tutorials = getNekoTutorials();
        const openVideo = (tutorial: NekoTutorial) => {
          // Abre a URL oficial no navegador padrão (shell.openExternal via IPC).
          window.neko.openExternal(tutorial.youtubeUrl).catch(() => {});
        };
        return <>
          <div className="modal-head tutorials-head">
            <div>
              <h2 id="modal-title"><Play size={17} fill="currentColor" style={{ marginRight: 6, verticalAlign: -2 }}/> Tutoriais</h2>
              <p>Assista aos vídeos no YouTube, em uma janela externa.</p>
            </div>
            <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
          </div>
          <div className="tutorials-scroll">
            <div className="tutorials-eyebrow">TUTORIAIS EM VÍDEO</div>
            <h3 className="tutorials-title">Aprenda a dominar o NekoAI</h3>
            <p className="tutorials-desc">Vídeos curtos e práticos para você começar a usar o NekoAI do zero e aproveitar todo o seu potencial.</p>
            <div className="tutorials-grid">
              {tutorials.map(tutorial => (
                <button
                  key={tutorial.videoId}
                  type="button"
                  className="tutorial-card"
                  onClick={() => openVideo(tutorial)}
                  aria-label={`Ver no YouTube: ${tutorial.title}`}
                >
                  <span className="tutorial-thumb">
                    <img src={tutorial.thumb} alt="" loading="lazy"/>
                    <span className="tutorial-play"><Play size={20} fill="currentColor"/></span>
                  </span>
                  <span className="tutorial-card-title">{tutorial.title}</span>
                  <span className="tutorial-card-desc">{tutorial.description}</span>
                  <span className="tutorial-watch-btn"><ExternalLink size={13}/> Ver no YouTube</span>
                </button>
              ))}
            </div>
          </div>
        </>;
      })()}

      {modal === "siteClone" && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title"><Globe2 size={17} style={{ marginRight: 6, verticalAlign: -3 }}/> Clonar Site</h2>
            <p>Analisa uma URL pública e reconstrói um projeto editável e executável no Preview do NekoAI.</p>
          </div>
          <button className="close-btn" onClick={() => { if (cloneBusy) void cancelCloneAnalysis(); else { setCloneAnalysis(null); setCloneError(""); setModal(null); } }} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="clone-body">
          {!cloneAnalysis && (
            <>
              <label className="clone-field-label">Cole a URL do site que deseja reconstruir</label>
              <input
                className="clone-url-input"
                value={cloneUrl}
                onChange={e => { setCloneUrl(e.target.value); setCloneError(""); }}
                onKeyDown={e => { if (e.key === "Enter" && !cloneBusy) void runCloneAnalysis(); }}
                placeholder="https://exemplo.com"
                disabled={cloneBusy}
                autoFocus
                spellCheck={false}
              />
              {cloneError && <div className="clone-error">{cloneError}</div>}
              {cloneBusy && (
                <div className="clone-progress">
                  <Loader2 size={15} className="spin"/>
                  <span>Analisando site… {cloneProgress.scanned > 0 ? `(${cloneProgress.scanned} páginas)` : ""}</span>
                  {cloneProgress.currentUrl ? <small title={cloneProgress.currentUrl}>{cloneProgress.currentUrl}</small> : null}
                </div>
              )}
              {cloneCaptureBusy && (
                <div className="clone-progress">
                  <Loader2 size={15} className="spin"/>
                  <span>Capturando o site no navegador… (DOM executado e estilos; pode levar alguns segundos)</span>
                </div>
              )}
              <div className="clone-note">Somente conteúdo publicamente acessível. Não usamos login, não acessamos áreas privadas e não armazenamos credenciais.</div>
              <div className="modal-actions clone-actions">
                <button className="secondary" onClick={() => { if (!cloneBusy) void cancelCloneAnalysis(); }} disabled={cloneReconstructBusy}>Cancelar</button>
                <button className="secondary" onClick={() => void runCloneCapture()} disabled={cloneCaptureBusy || cloneBusy || !cloneUrl.trim()} title="Captura com navegador (DOM executado + estilos) para reconstrução de alta fidelidade">
                  {cloneCaptureBusy ? <Loader2 size={15} className="spin"/> : <><Globe2 size={15}/> Capturar com Chromium</>}
                </button>
                <button className="primary" onClick={() => void runCloneAnalysis()} disabled={cloneBusy || cloneCaptureBusy || !cloneUrl.trim()}>
                  {cloneBusy ? <>Analisando…</> : <><Search size={15}/> Analisar</>}
                </button>
              </div>
            </>
          )}

          {cloneAnalysis && cloneAnalysis.ok && (
            <>
              <div className="clone-result-title"><CheckCircle2 size={16}/> Análise concluída</div>
              <div className="clone-result-meta">
                <div><b>{(cloneAnalysis.pages || []).length}</b><span>páginas</span></div>
                <div><b>{(cloneAnalysis.routes || []).length}</b><span>rotas</span></div>
                <div><b>{(cloneAnalysis.assets || []).length}</b><span>assets</span></div>
                <div><b>{(cloneAnalysis.externalLinks || []).length}</b><span>links externos</span></div>
              </div>
              <div className="clone-routes-label">Rotas encontradas</div>
              <div className="clone-routes">
                {(cloneAnalysis.routes || []).map((r: string) => <code key={r}>{r}</code>)}
              </div>
              {cloneError && <div className="clone-error">{cloneError}</div>}
              <div className="modal-actions clone-actions">
                <button className="secondary" onClick={() => void cancelCloneAnalysis()} disabled={cloneBusy || cloneReconstructBusy}>Refazer análise</button>
                <button className="primary" onClick={() => void startCloneReconstruction()} disabled={cloneReconstructBusy || busy}>
                  {cloneReconstructBusy ? <Loader2 size={15} className="spin"/> : <><Sparkles size={15}/> Reconstruir neste projeto</>}
                </button>
              </div>
              {!project && !busy && <div className="clone-note warn">Abra ou crie um projeto primeiro para a reconstrução (ela escreve arquivos dentro do workspace ativo).</div>}
            </>
          )}

          {cloneAnalysis && !cloneAnalysis.ok && (
            <>
              <div className="clone-error" style={{ marginBottom: 12 }}>{cloneAnalysis.error || "Não foi possível acessar este site."}</div>
              <div className="modal-actions clone-actions">
                <button className="secondary" onClick={() => { setCloneAnalysis(null); }}>Voltar</button>
              </div>
            </>
          )}
        </div>
      </>}

      {modal === "models" && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title">Gerenciar modelos</h2>
            <p>Ative ou desative providers conectados e controle os modelos disponíveis.</p>
          </div>
          <div className="modal-head-actions">
            <button className="connect-provider-btn" onClick={() => { setProviderSearch(""); setAuthError(""); setModal("providers"); }}><Plus size={15}/> Conectar provedor</button>
            <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
          </div>
        </div>
        <div className="modal-search-wrap"><Search size={15}/><input className="modal-search" value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="Buscar modelos" autoFocus/></div>
        <div className="modal-scroll-body models-scroll-body">
          {managedModelGroups.length ? managedModelGroups.map(group => {
            const provider = connectedProviders.find(p => p.id === group.providerID)!;
            return <section className={`model-provider-card ${provider.enabled ? "" : "disabled"}`} key={group.providerID}>
              <div className="model-provider-title">
                <div className="model-provider-identity"><span className="model-provider-icon"><ProviderIcon id={group.providerID} size={19}/></span><span><b>{group.providerName}</b><small>{provider.enabled ? "Provider conectado" : "Provider desativado"}</small></span></div>
                <div className="model-provider-controls"><span className={`provider-status ${provider.enabled ? "active" : "off"}`}>{provider.enabled ? "Ativo" : "Desativado"}</span>
                  <button className={`toggle provider-toggle ${provider.enabled ? "on" : ""}`} aria-pressed={provider.enabled} onClick={async () => { try { const result = await window.neko.setProviderEnabled(provider.id, !provider.enabled); setModels(result.models || []); setManagedModels(result.managedModels || result.models || []); setProviders(result.providers || []); } catch (error) { setAuthError(error instanceof Error ? error.message : String(error)); } }}><i/></button>
                </div>
              </div>
              <div className="provider-model-divider"><span>{group.models.length} modelos disponíveis</span><span>Modelos ativos: {group.models.filter((m: Model) => m.enabled).length}</span></div>
              <div className="model-card-list">
                {group.models.length ? group.models.map(m => <div className="manage-row model-card-row" key={`${m.providerID}:${m.modelID}`}><div><b>{m.name}</b><span>{m.modelID}</span></div>
                  <button className={`toggle ${m.enabled ? "on" : ""}`} aria-pressed={m.enabled} onClick={async () => { try { const result = await window.neko.setModelEnabled(m.providerID, m.modelID, !m.enabled); setModels(result.models || []); setManagedModels(result.managedModels || result.models || []); setProviders(result.providers || []); } catch {} }}><i/></button>
                </div>) : <div className="provider-disabled-message">Este provider está desativado. Ative-o para disponibilizar seus modelos.</div>}
              </div>
            </section>;
          }) : <div className="models-empty-state"><CircleAlert size={18}/><div><b>Nenhum provider conectado</b><span>Conecte um provider para gerenciar seus modelos.</span></div></div>}
        </div>
      </>}

      {modal === "providers" && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title">Conectar provedor</h2>
            <p>Gerencie suas conexões de IA usando suas próprias chaves.</p>
          </div>
          <button className="close-btn" onClick={() => setModal("models")} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-search-wrap"><Search size={15}/><input className="modal-search" value={providerSearch} onChange={e => setProviderSearch(e.target.value)} placeholder="Buscar provedores" autoFocus/></div>
        {authError && <div className="auth-error provider-global-error">{authError}</div>}
        <div className="modal-scroll-body provider-scroll-body" onWheel={e => { const el = e.currentTarget; if (el.scrollHeight > el.clientHeight) { e.preventDefault(); el.scrollTop += e.deltaY; } }}>
          {connectedProviderList.length ? <section className="provider-section provider-connected-section">
            <div className="provider-section-title"><span>Provedores conectados</span><small>Gerencie suas conexões ativas</small></div>
            <div className="provider-list">
              {connectedProviderList.map(p => <div className="provider-line connected" key={p.id}>
                <div className="provider-line-main"><span className="provider-line-icon"><ProviderIcon id={p.id} size={19}/></span><span><b>{p.name}</b><small>{p.id}</small></span></div>
                <div className="provider-line-actions">
                  <span className="provider-connected"><Check size={11}/> Conectado</span>
                  <button className="provider-disconnect-action" disabled={authBusy} onClick={() => void disconnectProvider(p.id)} title="Desconectar"><Unlink size={14}/></button>
                </div>
              </div>)}
            </div>
          </section> : null}
          {popularProviders.filter(p => !p.connected && filteredProviders.some(x => x.id === p.id)).length ? <section className="provider-section provider-popular">
            <div className="provider-section-title"><span>Mais populares</span><small>Conecte rapidamente os providers mais usados</small></div>
            <div className="provider-list">
              {popularProviders.filter(p => !p.connected && filteredProviders.some(x => x.id === p.id)).map(p => <div className="provider-line" key={p.id}>
                <button className="provider-line-main" onClick={() => { setSelectedProvider(p); setApiKey(""); setAuthError(""); setModal("providerAuth"); }}><span className="provider-line-icon"><ProviderIcon id={p.id} size={19}/></span><span><b>{p.name}</b><small>{p.id}</small></span></button>
                <div className="provider-line-actions"><button className="provider-connect-action" onClick={() => { setSelectedProvider(p); setApiKey(""); setAuthError(""); setModal("providerAuth"); }}><Link2 size={13}/> Conectar</button></div>
              </div>)}
            </div>
          </section> : null}
          <section className="provider-section">
            <div className="provider-section-title"><span>Outros providers</span><small>Todos os providers disponíveis para conexão</small></div>
            <div className="provider-list">
              {otherProviders.map(p => <div className="provider-line" key={p.id}>
                <button className="provider-line-main" onClick={() => { setSelectedProvider(p); setApiKey(""); setAuthError(""); setModal("providerAuth"); }}><span className="provider-line-icon"><ProviderIcon id={p.id} size={19}/></span><span><b>{p.name}</b><small>{p.id}</small></span></button>
                <div className="provider-line-actions"><button className="provider-connect-action" onClick={() => { setSelectedProvider(p); setApiKey(""); setAuthError(""); setModal("providerAuth"); }}><Link2 size={13}/> Conectar</button></div>
              </div>)}
            </div>
          </section>
        </div>
      </>}

      {modal === "github" && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title"><GitHubIcon size={18} /> GitHub</h2>
            <p>{githubStatus.connected ? `Conectado${githubStatus.user?.login ? ` como @${githubStatus.user.login}` : ""}.` : "Conecte sua conta para acessar seus repositórios pelo NekoAI."}</p>
          </div>
          <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
        </div>
        {!githubStatus.connected ? <div className="github-connect-panel">
          <div className="github-hero-icon"><GitHubIcon size={34} /></div>
          <h3>Conectar GitHub</h3>
          <p>O NekoAI vai abrir o GitHub no navegador e usar o Device Flow para autorizar esta aplicação desktop.</p>
          {githubError && <div className="auth-error">{githubError}</div>}
          <button className="primary github-connect-main" onClick={() => void startGithubConnect()} disabled={githubBusy}>{githubBusy ? <><Loader2 size={15} className="spin"/> Aguardando autorização...</> : <><GitHubIcon size={15} /> Conectar GitHub</>}</button>
        </div> : <div className="modal-scroll-body github-connected-panel">
          <div className="github-user">
            <div className="github-avatar">{githubStatus.user?.avatarUrl ? <img src={githubStatus.user.avatarUrl} alt=""/> : <GitHubIcon size={20} />}</div>
            <div><b>{githubStatus.user?.name || githubStatus.user?.login || "GitHub"}</b><small>@{githubStatus.user?.login || ""}</small></div>
            <span className="github-ok">Conectado</span>
          </div>
          {githubStatus.needsPermissions ? <div className="github-auth-update-needed"><div><b>Permissões do GitHub precisam de aprovação</b><small>O NekoAI está conectado, mas o GitHub App ainda não tem todas as permissões necessárias para publicar e enviar código.</small></div><button className="primary" onClick={() => githubStatus.installUrl && window.neko.githubOpen(githubStatus.installUrl)}><GitHubIcon size={14}/> Verificar permissões</button></div> : null}
          {project && githubLinkStatus.linkedRepo ? (() => {
            const linkedRepoUrl = githubStatus.repos?.find(r => r.fullName.toLowerCase() === githubLinkStatus.linkedRepo?.toLowerCase())?.htmlUrl || `https://github.com/${githubLinkStatus.linkedRepo}`;
            return <div className="github-connected-project">
              <div className="github-connected-project-head"><div><b>Projeto conectado</b><small>{githubLinkStatus.linkedRepo}</small></div><span className={githubLinkStatus.dirty ? "dirty" : "clean"}>{githubLinkStatus.dirty ? "Alterado" : "Sincronizado"}</span></div>
              <div className="github-project-meta"><span><GitBranch size={12}/> {githubLinkStatus.branch || "main"}</span><span>{githubLinkStatus.dirty ? "Há alterações locais" : "Nenhuma alteração pendente"}</span></div>
              <textarea className="github-commit-input" value={githubCommitMessage} onChange={e => { setGithubCommitMessage(e.target.value); if (githubCommitError) setGithubCommitError(""); if (githubCommitSuccess) setGithubCommitSuccess(false); }} placeholder="Mensagem do commit" rows={2} disabled={githubCommitBusy}/>
              {githubCommitError && <div className="auth-error" style={{ marginTop: 8 }}>{githubCommitError}</div>}
              {githubCommitSuccess && <div className="github-linked-success" style={{ marginTop: 8 }}><Check size={16}/><div><b>Commit e Push realizado com sucesso</b><small>Alterações publicadas no GitHub com sucesso.</small></div></div>}
              <div className="github-connected-actions">
                <button className="primary github-commit-btn" disabled={!githubLinkStatus.dirty || !githubCommitMessage.trim() || githubCommitBusy} onClick={() => void commitAndPushGithub()}>{githubCommitBusy ? <><Loader2 size={15} className="spin"/> Enviando...</> : <><Check size={15}/> Commit e Push</>}</button>
                {linkedRepoUrl ? <button className="secondary github-view-repo-btn" onClick={() => void window.neko.githubOpen(linkedRepoUrl)} title="Abrir repositório no GitHub"><ExternalLinkIcon size={14}/> Ver no GitHub</button> : null}
              </div>
            </div>;
          })() : null}
          {project && !githubLinkStatus.linkedRepo ? <>
            <div className="github-local-project-card">
              <div className="github-local-project-copy"><b>Projeto local</b><small>{projectDisplayName}</small><span>Este projeto ainda não está conectado ao GitHub.</span></div>
              <button className="primary github-publish-main" onClick={() => prepareGithubPublish()}><GitHubIcon size={14}/> Publicar no GitHub</button>
            </div>
            <button className={`github-link-existing-btn ${githubShowRepos ? "active" : ""}`} onClick={() => setGithubShowRepos(prev => !prev)}>
              <div><Link2 size={13}/><span>Vincular a um repositório existente</span></div>
              {githubShowRepos ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
            </button>
          </> : null}
          {(!project || (project && !githubLinkStatus.linkedRepo && githubShowRepos)) ? <>
            <div className="github-repo-head"><b>{project ? "Escolha um repositório para vincular" : "Repositórios"}</b><button className="icon-btn" onClick={() => void refreshGithub()} title="Atualizar"><RefreshCw size={15}/></button></div>
            {githubStatus.needsInstallation ? <div className="github-install-needed"><div><b>Instale o NekoAI no GitHub</b><small>Para acessar repositórios privados, o GitHub App precisa estar instalado na sua conta e autorizado para os repositórios que você deseja usar.</small></div><button className="primary" onClick={() => githubStatus.installUrl && window.neko.githubOpen(githubStatus.installUrl)}><GitHubIcon size={14}/> Instalar / configurar</button></div> : null}
            <div className="github-repos">{(githubStatus.repos || []).length ? githubStatus.repos!.map(repo => <div className="github-repo-row" key={repo.id}><button className="github-repo-main" onClick={() => project ? void openGithubLink(repo) : prepareGithubClone(repo)}><div><b>{repo.name}</b><small>{repo.fullName}</small></div><span className={repo.private ? "private" : "public"}>{repo.private ? "Privado" : "Público"}</span></button><button className="github-repo-link" onClick={() => project ? void openGithubLink(repo) : prepareGithubClone(repo)} title={project ? "Vincular projeto" : "Clonar para este computador"}>{project ? <Link2 size={14}/> : <Download size={14}/>}</button><button className="github-repo-open" onClick={() => window.neko.githubOpen(repo.htmlUrl)} title="Abrir no GitHub"><ExternalLinkIcon size={14}/></button></div>) : <div className="github-empty">{githubStatus.needsInstallation ? "Nenhum repositório foi concedido ao NekoAI ainda." : "Nenhum repositório encontrado."}</div>}</div>
          </> : null}
          <button className="secondary github-disconnect" onClick={() => void disconnectGithub()}><Unplug size={14}/> Desconectar</button>
        </div>}
      </>}

      {modal === "githubClone" && githubCloneRepo && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title"><FolderPlus size={18}/> Criar novo projeto</h2>
            <p>A pasta será aberta automaticamente no NekoAI.</p>
          </div>
          <button className="close-btn" onClick={() => setModal("github")} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body new-project-panel github-clone-project-panel">
          <div className="github-clone-source"><GitHubIcon size={16}/><div><b>{githubCloneRepo.fullName}</b><small>{githubCloneRepo.private ? "Repositório privado" : "Repositório público"} · {githubCloneRepo.defaultBranch || "main"}</small></div></div>
          <label>Nome do projeto</label><input className="api-input" value={githubCloneName} onChange={e => setGithubCloneName(e.target.value)} placeholder="meu-projeto" autoFocus/>
          <label>Local onde será salvo</label><div className="new-project-folder"><FolderOpen size={15}/><span>{githubCloneParent || "Escolha a pasta principal"}</span><button className="secondary" onClick={() => void chooseGithubCloneParent()}>Escolher</button></div>
          {githubError && <div className="auth-error">{githubError}</div>}
          <div className="github-clone-note">O NekoAI fará um clone Git completo, preservando histórico, branches e o vínculo com <b>{githubCloneRepo.fullName}</b>.</div>
        </div>
        <div className="modal-actions auth-actions">
          <button className="secondary" onClick={() => setModal("github")}>Cancelar</button>
          <button className="primary" disabled={!githubCloneParent || !githubCloneName.trim() || githubBusy} onClick={() => void cloneGithubRepository(githubCloneRepo.fullName)}>{githubBusy ? <><Loader2 size={15} className="spin"/> Clonando...</> : <><Download size={15}/> Criar e abrir</>}</button>
        </div>
      </>}

      {modal === "githubPublish" && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title"><GitHubIcon size={18}/> Publicar no GitHub</h2>
            <p>Conecte este projeto local a um novo repositório do GitHub.</p>
          </div>
          <button className="close-btn" onClick={() => cancelGithubPublish()} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body new-project-panel github-publish-panel">
          <div className="github-clone-source"><FolderOpen size={16}/><div><b>{projectDisplayName}</b><small>{project}</small></div></div>
          <label>Nome do repositório</label><input className="api-input" value={githubPublishRepoName} onChange={e => { setGithubPublishRepoName(e.target.value); if (githubPublishError) setGithubPublishError(""); }} placeholder="meu-projeto" autoFocus/>
          {githubPublishRepoName.trim() && !isValidGithubRepoName(githubPublishRepoName) && (
            <div className="auth-error">
              {githubPublishRepoName.trim().length > 100
                ? "O nome do repositório deve ter no máximo 100 caracteres."
                : "O nome do repositório deve conter apenas letras, números, hífens (-), sublinhados (_) e pontos (.), sem espaços ou acentos."}
            </div>
          )}
          <label className="github-visibility-label">Visibilidade</label>
          <div className="github-visibility"><button className={githubPublishPrivate ? "selected" : ""} onClick={() => setGithubPublishPrivate(true)} disabled={githubPublishBusy}><Lock size={14}/><span><b>Privado</b><small>Somente você e quem autorizar.</small></span></button><button className={!githubPublishPrivate ? "selected" : ""} onClick={() => setGithubPublishPrivate(false)} disabled={githubPublishBusy}><Globe2 size={14}/><span><b>Público</b><small>Qualquer pessoa poderá ver.</small></span></button></div>
          {githubPublishError && <div className="auth-error">{githubPublishError}</div>}
          <div className="github-clone-note">O NekoAI inicializará o Git se necessário, criará o repositório, fará o primeiro commit e enviará o projeto. Depois disso, este projeto ficará conectado ao GitHub.</div>
        </div>
        <div className="modal-actions auth-actions">
          <button className="secondary" onClick={() => cancelGithubPublish()}>Cancelar</button>
          <button className="primary" disabled={!isValidGithubRepoName(githubPublishRepoName) || githubPublishBusy} onClick={() => void publishCurrentProject()}>{githubPublishBusy ? <><Loader2 size={15} className="spin"/> Publicando...</> : <><GitHubIcon size={15}/> Publicar projeto</>}</button>
        </div>
      </>}

      {modal === "newProject" && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title"><Plus size={18}/> Criar novo projeto</h2>
            <p>Crie a pasta e abra o projeto diretamente no NekoAI.</p>
          </div>
          <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body new-project-panel">
          <label>Nome do projeto</label><input className="api-input" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="meu-projeto" autoFocus disabled={authBusy}/>
          <label>Local onde será salvo</label><div className="new-project-folder"><FolderOpen size={15}/><span>{newProjectParent || "Escolha a pasta principal"}</span><button className="secondary" onClick={() => void chooseNewProjectParent()} disabled={authBusy}>Escolher</button></div>
          {authError && <div className="auth-error">{authError}</div>}
        </div>
        <div className="modal-actions auth-actions">
          <button className="secondary" onClick={() => setModal(null)} disabled={authBusy}>Cancelar</button>
          <button className="primary" disabled={!newProjectName.trim() || !newProjectParent.trim() || authBusy} onClick={() => void confirmCreateProject()}>{authBusy ? <><Loader2 size={15} className="spin"/> Criando e abrindo...</> : <><Plus size={15}/> Criar e abrir no Neko</>}</button>
        </div>
      </>}

      {modal === "githubLink" && githubLinkRepo && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title"><Download size={18} /> Clonar repositório</h2>
            <p>{githubLinkStatus.linkedRepo === githubLinkRepo.fullName ? "Projeto conectado ao GitHub. As alterações podem ser enviadas pelo painel principal." : "Os arquivos do GitHub serão baixados para esta pasta local."}</p>
          </div>
          <button className="close-btn" onClick={() => setModal("github")} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body github-link-panel">
          <div className="github-link-repo"><GitHubIcon size={18}/><div><b>{githubLinkRepo.fullName}</b><small>{githubLinkRepo.private ? "Repositório privado" : "Repositório público"}</small></div></div>
          <div className="github-link-detail"><span>Repositório</span><code>{githubLinkRepo.fullName}</code></div>
          <div className="github-link-detail"><span>Destino local</span><code>{project || "Nenhum projeto aberto"}</code></div>
          <div className="github-link-detail"><span>Remote atual</span><code>{githubLinkStatus.remote || "Nenhum remote origin configurado"}</code></div>
          <div className="github-link-detail"><span>Branch local</span><code>{githubLinkStatus.branch || "Ainda sem branch local"}</code></div>
          {!project ? <div className="auth-error">Abra uma pasta antes de clonar um repositório.</div> : null}
          {githubLinkStatus.remote && githubLinkStatus.linkedRepo !== githubLinkRepo.fullName ? <label className="github-replace"><input type="checkbox" checked={githubReplaceRemote} onChange={e => setGithubReplaceRemote(e.target.checked)} /> Substituir o remote <b>origin</b> atual</label> : null}
          {githubLinkError && <div className="auth-error">{githubLinkError}</div>}
          {githubLinkStatus.linkedRepo === githubLinkRepo.fullName && !githubLinkBusy && !githubLinkError ? <div className="github-linked-success"><Check size={16}/><div><b>Projeto já conectado</b><small>O projeto local já contém este repositório clonado e configurado.</small></div></div> : null}
          {githubLinkBusy ? <div className="github-link-progress"><Loader2 size={16} className="spin"/><div><b>Clonando repositório...</b><small>Baixando arquivos, histórico Git e configurando a branch local.</small></div></div> : null}
        </div>
        <div className="modal-actions auth-actions">
          <button className="secondary" onClick={() => setModal("github")}>{githubLinkStatus.linkedRepo === githubLinkRepo.fullName ? "Fechar" : "Cancelar"}</button>
          {project && githubLinkError && githubLinkError.includes("já contém arquivos") ? (
            <button className="primary danger-confirm-btn" disabled={githubLinkBusy} onClick={() => void linkGithubProject(true)}>
              {githubLinkBusy ? <><Loader2 size={15} className="spin"/> Substituindo...</> : "Substituir conteúdo local"}
            </button>
          ) : null}
          {!project ? <button className="primary" disabled={githubLinkBusy} onClick={() => void cloneGithubRepository(githubLinkRepo.fullName)}>{githubLinkBusy ? <><Loader2 size={15} className="spin"/> Clonando...</> : <><Download size={15}/> Escolher outra pasta para clonar</>}</button> : null}
          {project && githubLinkStatus.linkedRepo !== githubLinkRepo.fullName && !(githubLinkError && githubLinkError.includes("já contém arquivos")) ? <button className="primary" disabled={githubLinkBusy || (!!githubLinkStatus.remote && githubLinkStatus.linkedRepo !== githubLinkRepo.fullName && !githubReplaceRemote)} onClick={() => void linkGithubProject(false)}>{githubLinkBusy ? <><Loader2 size={15} className="spin"/> Clonando...</> : <><Download size={15}/> Clonar para esta pasta</>}</button> : null}
        </div>
      </>}

      {modal === "githubDevice" && githubDevice && <>
        <div className="modal-head">
          <div>
            <h2 id="modal-title">Autorizar GitHub</h2>
            <p>Use o código abaixo no GitHub para autorizar o NekoAI.</p>
          </div>
          <button className="close-btn" onClick={() => {
            setGithubBusy(false);
            setGithubDevice(null);
            setModal("github");
            void window.neko.githubCancel?.().catch(() => {});
          }} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body github-device-panel">
          <div className="device-label">Código de autorização</div>
          <div className="device-code">{githubDevice.userCode}</div>
          <button className="secondary" onClick={(e) => void copyMessage(githubDevice.userCode, e.currentTarget)}><Copy size={14}/> Copiar código</button>
          <button className="primary" onClick={() => window.neko.githubOpen(githubDevice.verificationUri)}><ExternalLinkIcon size={14}/> Abrir GitHub</button>
          <div className="device-wait"><Loader2 size={15} className="spin"/> Aguardando autorização no GitHub...</div>
          {githubError && <div className="auth-error">{githubError}</div>}
        </div>
      </>}

      {modal === "providerAuth" && selectedProvider && <>
        <div className="modal-head">
          <button className="back-btn" onClick={() => setModal("providers")} aria-label="Voltar"><ArrowLeft size={18}/></button>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
            <span className="provider-line-icon"><ProviderIcon id={selectedProvider.id} size={20}/></span>
            <div>
              <h2 id="modal-title" style={{ margin: 0 }}>Conectar {selectedProvider.name}</h2>
              <p style={{ margin: "2px 0 0" }}>Digite sua chave de API para conectar sua conta ao NekoAI.</p>
            </div>
          </div>
          <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body provider-auth-body">
          <label>Chave de API do {selectedProvider.name}</label>
          <input className="api-input" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Chave de API" autoFocus onKeyDown={e => { if (e.key === "Enter") void connectProvider(); }}/>
          {authError && <div className="auth-error">{authError}</div>}
        </div>
        <div className="modal-actions auth-actions">
          <button className="secondary" onClick={() => setModal("providers")}>Voltar</button>
          <button className="primary" disabled={!apiKey.trim() || authBusy} onClick={() => void connectProvider()}>{authBusy ? <><Loader2 size={15} className="spin"/> Conectando...</> : "Continuar"}</button>
        </div>
      </>}

      {modal === "branchChanges" && <>
        <div className="modal-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="branch-modal-icon-wrap"><AlertTriangle size={18} color="#f59e0b"/></div>
            <div>
              <h2 id="modal-title">Alterações locais detectadas</h2>
              <p>Você possui alterações locais não commitadas neste projeto.</p>
            </div>
          </div>
          <button className="close-btn" disabled={branchActionBusy} onClick={() => { setModal(null); setPendingTargetBranch(null); }} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body branch-changes-modal-body">
          <div className="branch-target-banner">
            <span>Antes de trocar para o branch <b>{pendingTargetBranch}</b>, escolha como deseja continuar:</span>
          </div>

          <div className="branch-summary-chips">
            {githubLinkStatus.summary?.modified ? <span className="branch-chip mod"><FileText size={12}/>{githubLinkStatus.summary.modified} modificado{githubLinkStatus.summary.modified > 1 ? "s" : ""}</span> : null}
            {githubLinkStatus.summary?.untracked ? <span className="branch-chip new"><Plus size={12}/>{githubLinkStatus.summary.untracked} novo{githubLinkStatus.summary.untracked > 1 ? "s" : ""}</span> : null}
            {githubLinkStatus.summary?.deleted ? <span className="branch-chip del"><Trash2 size={12}/>{githubLinkStatus.summary.deleted} excluído{githubLinkStatus.summary.deleted > 1 ? "s" : ""}</span> : null}
            {!githubLinkStatus.summary?.total ? <span className="branch-chip mod"><FileText size={12}/>Arquivos modificados</span> : null}
          </div>

          <div className="branch-diff-toggle-wrap">
            <button className="secondary branch-toggle-diff-btn" onClick={() => setShowBranchDiffList(v => !v)}>
              <FileCode2 size={13}/>
              <span>{showBranchDiffList ? "Ocultar arquivos alterados" : "Ver alterações detalhadas"}</span>
              {showBranchDiffList ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
            </button>
          </div>

          {showBranchDiffList ? (
            <div className="branch-files-drawer">
              {(githubLinkStatus.changedFiles || []).length > 0 ? (
                <div className="branch-files-list">
                  {(githubLinkStatus.changedFiles || []).map(f => (
                    <div className="branch-file-item" key={f.path}>
                      <span className={`branch-file-badge ${f.status}`}>
                        {f.status === "modified" ? "MODIFICADO" : f.status === "untracked" || f.status === "added" ? "NOVO" : f.status === "deleted" ? "EXCLUÍDO" : "ALTERADO"}
                      </span>
                      <span className="branch-file-path" title={f.path}>{f.path}</span>
                      {f.staged ? <span className="branch-staged-tag">staged</span> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="branch-files-empty">Nenhum arquivo listado.</div>
              )}
            </div>
          ) : null}

          {branchActionError && <div className="auth-error">{branchActionError}</div>}
        </div>
        <div className="modal-actions branch-modal-actions">
          <button className="secondary" disabled={branchActionBusy} onClick={() => { setModal(null); setPendingTargetBranch(null); }}>Cancelar</button>
          <button className="secondary danger-btn" disabled={branchActionBusy} onClick={() => setModal("branchDiscardConfirm")}>
            <Trash2 size={14}/> Descartar alterações
          </button>
          <button className="primary" disabled={branchActionBusy} onClick={() => setModal("branchCommit")}>
            <Check size={14}/> Fazer Commit
          </button>
        </div>
      </>}

      {modal === "branchDiscardConfirm" && <>
        <div className="modal-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="branch-modal-icon-wrap danger"><AlertTriangle size={18} color="#ef4444"/></div>
            <div>
              <h2 id="modal-title">Descartar alterações locais?</h2>
              <p>Esta ação removerá as alterações não commitadas deste projeto.</p>
            </div>
          </div>
          <button className="close-btn" disabled={branchActionBusy} onClick={() => setModal("branchChanges")} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body branch-discard-modal-body">
          <div className="branch-discard-warning-card">
            <b>Atenção: Esta ação não poderá ser desfeita.</b>
            <p>Todas as alterações no working tree que não foram salvas em um commit serão descartadas para permitir a troca para <b>{pendingTargetBranch}</b>.</p>
            <small>Arquivos de ambiente e segredos locais (como <code>.env</code>) serão preservados com segurança.</small>
          </div>
          {branchActionError && <div className="auth-error">{branchActionError}</div>}
        </div>
        <div className="modal-actions branch-modal-actions">
          <button className="secondary" disabled={branchActionBusy} onClick={() => setModal("branchChanges")}>Voltar</button>
          <button className="primary danger-confirm-btn" disabled={branchActionBusy} onClick={() => void handleBranchDiscardAndCheckout()}>
            {branchActionBusy ? <><Loader2 size={15} className="spin"/> Descartando e trocando...</> : <><Trash2 size={14}/> Descartar e trocar</>}
          </button>
        </div>
      </>}

      {modal === "branchCommit" && <>
        <div className="modal-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="branch-modal-icon-wrap"><GitBranch size={18} color="#a855f7"/></div>
            <div>
              <h2 id="modal-title">Commit antes de trocar de branch</h2>
              <p>Salve suas alterações antes de alternar para <b>{pendingTargetBranch}</b>.</p>
            </div>
          </div>
          <button className="close-btn" disabled={branchActionBusy} onClick={() => setModal("branchChanges")} aria-label="Fechar"><X size={17}/></button>
        </div>
        <div className="modal-scroll-body branch-commit-modal-body">
          <label>Mensagem do Commit</label>
          <textarea
            className="branch-commit-textarea"
            rows={3}
            value={branchCommitMessage}
            onChange={e => setBranchCommitMessage(e.target.value)}
            placeholder="Descreva as alterações realizadas..."
            autoFocus
          />
          <div className="branch-commit-help">
            <span>Após o commit, o NekoAI trocará automaticamente para <b>{pendingTargetBranch}</b>.</span>
          </div>
          {branchActionError && <div className="auth-error">{branchActionError}</div>}
        </div>
        <div className="modal-actions branch-modal-actions">
          <button className="secondary" disabled={branchActionBusy} onClick={() => setModal("branchChanges")}>Voltar</button>
          <button className="primary" disabled={!branchCommitMessage.trim() || branchActionBusy} onClick={() => void handleBranchCommitAndCheckout()}>
            {branchActionBusy ? <><Loader2 size={15} className="spin"/> Salvando e trocando...</> : <><Check size={14}/> Salvar e trocar para {pendingTargetBranch}</>}
          </button>
        </div>
      </>}

      {modal === "supabase" && (
        <>
          <div className="modal-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="modal-icon supabase-mark"><SupabaseIcon size={20}/></div>
              <div>
                <h2 id="modal-title">Integração Supabase</h2>
                <p>Conecte a aplicação e o OpenCode ao projeto selecionado.</p>
              </div>
            </div>
            <button
              className="close-btn"
              disabled={supabaseBusy}
              onClick={() => {
                console.log("[SupabaseUI] closing modal");
                setModal(null);
                setSupabaseView("auto");
                setSupabaseError("");
                setNewSupabaseProjectError("");
                setNewSupabaseProjectStructuredError(null);
              }}
              aria-label="Fechar"
            >
              <X size={17}/>
            </button>
          </div>

          {supabaseBusy || ["checking", "authorizing", "verifying", "selecting", "validating", "installing"].includes(supabaseState.status) ? (
            <div className="modal-scroll-body supabase-loading">
              <Loader2 className="spin" size={28}/>
              <strong>
                {supabaseState.status === "checking"
                  ? "Preparando integração"
                  : supabaseState.status === "authorizing"
                  ? "Conclua a autorização no navegador"
                  : supabaseState.status === "verifying"
                  ? "Verificando autorização"
                  : supabaseState.status === "selecting"
                  ? "Carregando projetos"
                  : supabaseState.status === "validating"
                  ? "Validando conexão"
                  : supabaseState.status === "installing"
                  ? "Preparando o projeto"
                  : "Processando..."}
              </strong>
              <span>
                {supabaseState.status === "checking"
                  ? "Verificando o Supabase CLI."
                  : supabaseState.status === "authorizing"
                  ? "O navegador oficial foi aberto para autorizar o OpenCode no Supabase."
                  : supabaseState.status === "verifying"
                  ? "Confirmando as credenciais e status de conexão do MCP no OpenCode."
                  : supabaseState.status === "selecting"
                  ? "Buscando a lista dos seus projetos Supabase."
                  : supabaseState.status === "validating"
                  ? "O NekoAI está validando a conexão e preparando o MCP."
                  : supabaseState.status === "installing"
                  ? "O NekoAI está configurando o SDK, o ambiente e as ferramentas do OpenCode."
                  : "Aguarde a conclusão da operação."}
              </span>
            </div>
          ) : effectiveSupabaseView === "create" ? (
            <form className="modal-scroll-body supabase-project-list" onSubmit={e => void createSupabaseProject(e)}>
              <div className="supabase-project-list-heading">
                <div>
                  <strong>Criar novo projeto</strong>
                  <span>Em {supabaseState.organizations?.find(o => o.id === newSupabaseProjectOrg)?.name || "Organização"}</span>
                </div>
                <button
                  type="button"
                  className="secondary btn-sm"
                  onClick={() => {
                    console.log("[SupabaseUI] cancel create clicked, returning to projects view");
                    setNewSupabaseProjectStructuredError(null);
                    setNewSupabaseProjectError("");
                    setSupabaseView("projects");
                  }}
                >
                  Cancelar
                </button>
              </div>
              <div className="project-form-fields">
                <label className="field-label">Nome do Projeto</label>
                <input
                  type="text"
                  className="api-input"
                  value={newSupabaseProjectName}
                  onChange={e => setNewSupabaseProjectName(e.target.value)}
                  placeholder="meu-novo-projeto"
                  disabled={supabaseBusy}
                  autoFocus
                />
                <label className="field-label">Senha do Banco de Dados</label>
                <input
                  type="password"
                  className="api-input"
                  value={newSupabaseProjectPassword}
                  onChange={e => setNewSupabaseProjectPassword(e.target.value)}
                  placeholder="Senha forte..."
                  disabled={supabaseBusy}
                />
                <label className="field-label">Organização</label>
                <select
                  className="api-input"
                  value={newSupabaseProjectOrg}
                  onChange={e => setNewSupabaseProjectOrg(e.target.value)}
                  disabled={supabaseBusy || !supabaseState.organizations || supabaseState.organizations.length === 0}
                >
                  {supabaseState.organizations && supabaseState.organizations.length > 0 ? (
                    supabaseState.organizations.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))
                  ) : (
                    <option value="">Carregando organizações...</option>
                  )}
                </select>
                <label className="field-label">Região</label>
                <select
                  className="api-input"
                  value={newSupabaseProjectRegion}
                  onChange={e => setNewSupabaseProjectRegion(e.target.value)}
                  disabled={supabaseBusy}
                >
                  {["sa-east-1","us-east-1","us-west-1","eu-west-1","eu-central-1","ap-southeast-1","ap-northeast-1"].map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              {(newSupabaseProjectStructuredError || newSupabaseProjectError) && (
                <div
                  className={`supabase-error-card ${
                    newSupabaseProjectStructuredError?.isLimit ? "limit-warning" : ""
                  }`}
                >
                  <div className="supabase-error-card-header">
                    <AlertTriangle size={15} />
                    <strong>
                      {newSupabaseProjectStructuredError?.title || "Não foi possível criar o projeto"}
                    </strong>
                  </div>
                  <p className="supabase-error-card-message">
                    {newSupabaseProjectStructuredError?.message || newSupabaseProjectError}
                  </p>
                  {newSupabaseProjectStructuredError?.detail && (
                    <p className="supabase-error-card-detail">
                      {newSupabaseProjectStructuredError.detail}
                    </p>
                  )}
                  {newSupabaseProjectStructuredError?.isLimit && (
                    <div className="supabase-error-card-actions">
                      <button
                        type="button"
                        className="secondary btn-sm"
                        onClick={() => void window.neko.supabaseOpenDashboard()}
                      >
                        Abrir painel do Supabase ↗
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="modal-actions" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    console.log("[SupabaseUI] cancel create clicked, returning to projects view");
                    setNewSupabaseProjectStructuredError(null);
                    setNewSupabaseProjectError("");
                    setSupabaseView("projects");
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    supabaseBusy ||
                    !newSupabaseProjectName.trim() ||
                    !newSupabaseProjectPassword.trim() ||
                    !newSupabaseProjectOrg
                  }
                >
                  {supabaseBusy ? (
                    <>
                      <Loader2 size={14} className="spin" /> Criando...
                    </>
                  ) : (
                    "Criar Projeto"
                  )}
                </button>
              </div>
            </form>
          ) : effectiveSupabaseView === "connected" ? (
            <div className="modal-scroll-body supabase-connected-panel">
              <div className="connection-badge">
                <Check size={16}/>
                <span>Conectado</span>
              </div>
              <h3>{supabaseState.projectName || "Projeto Supabase"}</h3>
              <code>{supabaseState.projectRef}</code>
              <p>
                {supabaseState.pendingRuntimeSetup
                  ? "O MCP está configurado. O SDK será instalado quando existir um package.json nesta pasta."
                  : "SDK, variáveis públicas e MCP do OpenCode configurados."}
              </p>
              {supabaseError && (
                <div className="creation-error">
                  <AlertTriangle size={14}/> {supabaseError}
                </div>
              )}
              <div className="modal-actions split-actions">
                <button
                  type="button"
                  className="secondary danger-action"
                  disabled={supabaseBusy}
                  onClick={() => void disconnectSupabase()}
                >
                  <Unplug size={14}/> Desconectar
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={supabaseBusy}
                  onClick={() => {
                    console.log("[SupabaseUI] switch project clicked, opening projects view");
                    setSupabaseError("");
                    setSupabaseView("projects");
                    void refreshSupabaseProjects(true);
                  }}
                >
                  <SupabaseIcon size={14}/> Trocar projeto
                </button>
              </div>
            </div>
          ) : effectiveSupabaseView === "connect" ? (
            <form className="modal-scroll-body supabase-connect-step" onSubmit={e => void connectSupabaseWithToken(e)}>
              <div className="supabase-connect-visual"><SupabaseIcon size={32}/></div>
              <h3>Conecte sua conta do Supabase</h3>
              <p>
                Gere um token de acesso em{" "}
                <button type="button" className="supabase-pat-link" onClick={() => void openSupabaseTokenPage()}>
                  supabase.com/dashboard/account/tokens →
                </button>
              </p>
              <div className="github-token-row">
                <input
                  type="password"
                  className="api-input"
                  placeholder="Cole seu Personal Access Token aqui"
                  value={supabaseToken}
                  onChange={e => setSupabaseToken(e.target.value)}
                  disabled={supabaseBusy}
                  autoFocus
                />
                <button
                  type="submit"
                  className="primary"
                  disabled={supabaseBusy || !supabaseToken.trim()}
                >
                  {supabaseBusy ? <Loader2 size={14} className="spin"/> : <SupabaseIcon size={14}/>} Conectar
                </button>
              </div>
              {(supabaseError || supabaseState.error) && (
                <div className="creation-error">
                  <AlertTriangle size={14}/> {supabaseError || supabaseState.error}
                </div>
              )}
            </form>
          ) : (
            <div className="modal-scroll-body supabase-project-list">
              <div className="supabase-project-list-heading">
                <div>
                  <strong>Escolha um projeto</strong>
                  <span>{supabaseState.projects.length} disponível(is)</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void refreshSupabaseProjects(true)}
                    title="Atualizar lista"
                    disabled={supabaseBusy}
                  >
                    {supabaseBusy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                  </button>
                  <button
                    type="button"
                    className="secondary btn-sm"
                    onClick={() => {
                      console.log("[SupabaseUI] new-project clicked");
                      console.log("[SupabaseUI] current state:", {
                        status: supabaseState.status,
                        projectRef: supabaseState.projectRef,
                        orgsCount: supabaseState.organizations?.length,
                        projsCount: supabaseState.projects?.length,
                      });
                      const defaultOrg = supabaseState.organizations?.[0]?.id || "";
                      setNewSupabaseProjectOrg(defaultOrg);
                      setNewSupabaseProjectName("");
                      setNewSupabaseProjectPassword("");
                      setNewSupabaseProjectError("");
                      setNewSupabaseProjectStructuredError(null);
                      console.log("[SupabaseUI] opening create form with defaultOrg:", defaultOrg);
                      setSupabaseView("create");
                      if (!supabaseState.organizations || supabaseState.organizations.length === 0) {
                        void refreshSupabaseProjects(false);
                      }
                    }}
                  >
                    <Plus size={13} /> Novo Projeto
                  </button>
                </div>
              </div>

              {supabaseState.recentCreatedNotice && (
                <div className="supabase-banner-notice">
                  <div className="supabase-banner-content">
                    <AlertTriangle size={15}/>
                    <span>{supabaseState.recentCreatedNotice}</span>
                  </div>
                  <button
                    type="button"
                    className="secondary btn-sm"
                    onClick={() => void refreshSupabaseProjects(false)}
                    disabled={supabaseBusy}
                  >
                    {supabaseBusy ? <Loader2 size={13} className="spin"/> : <RefreshCw size={13}/>} Atualizar
                  </button>
                </div>
              )}

              {(supabaseError || supabaseState.error) && (
                <div className="creation-error">
                  <AlertTriangle size={14}/> {supabaseError || supabaseState.error}
                </div>
              )}

              <div className="supabase-items-scroll">
                {supabaseState.projects.length ? (
                  supabaseState.projects.map(proj => (
                    <button
                      type="button"
                      className={`supabase-item-row ${supabaseState.projectRef === proj.ref ? "active" : ""}`}
                      key={proj.ref}
                      onClick={() => void selectSupabaseProject(proj.ref)}
                      disabled={supabaseBusy}
                    >
                      <div className="supabase-item-radio">
                        <span className={`radio-dot ${supabaseState.projectRef === proj.ref ? "selected" : ""}`}/>
                      </div>
                      <div className="supabase-item-info">
                        <strong>{proj.name}</strong>
                        <code>{proj.ref}</code>
                        <small>{proj.region} · {proj.status}</small>
                      </div>
                      {supabaseState.projectRef === proj.ref && (
                        <span className="supabase-active-badge">Ativo</span>
                      )}
                    </button>
                  ))
                ) : (
                  <div className="supabase-empty-list">
                    Nenhum projeto encontrado. Clique em Novo Projeto para criar.
                  </div>
                )}
              </div>

              <div className="modal-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
                <button
                  type="button"
                  className="secondary danger-action"
                  disabled={supabaseBusy}
                  onClick={() => void disconnectSupabase()}
                >
                  <Unplug size={14}/> Desconectar
                </button>
                {supabaseState.status === "connected" && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      console.log("[SupabaseUI] cancel projects view, returning to connected view");
                      setSupabaseView("connected");
                    }}
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {modal === "vercel" && (
        <>
          <div className="modal-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="modal-icon vercel-mark"><VercelIcon size={20}/></div>
              <div>
                <h2 id="modal-title">Publicar na Vercel</h2>
                <p>Hospede seu frontend em produção globalmente com deploy instantâneo.</p>
              </div>
            </div>
            <button
              className="close-btn"
              disabled={vercelBusy || vercelState.deployment === "deploying"}
              onClick={() => {
                setModal(null);
                setVercelError(null);
              }}
              aria-label="Fechar"
            >
              <X size={17}/>
            </button>
          </div>

          {vercelState.connection !== "connected" ? (
            <div className="modal-scroll-body vercel-connect-step">
              <div className="vercel-connect-visual"><VercelIcon size={36}/></div>
              <h3>Conecte sua conta da Vercel</h3>
              <p>
                Publique seus projetos com 1 clique diretamente da NekoAI com deploy contínuo em produção.
              </p>

              {vercelState.connection === "authorizing" ? (
                <div className="vercel-authorizing-box">
                  <Loader2 size={24} className="spin"/>
                  <div>
                    <strong>Aguardando autorização no terminal...</strong>
                    <span>Conclua o login na janela do terminal aberta no seu computador.</span>
                  </div>
                </div>
              ) : (
                <div className="vercel-connect-action">
                  <button
                    type="button"
                    className="primary vercel-connect-btn"
                    disabled={vercelBusy}
                    onClick={() => void handleConnectVercel()}
                  >
                    {vercelBusy ? <Loader2 size={16} className="spin"/> : <VercelIcon size={16}/>}
                    {vercelState.connection === "error" ? "Tentar conectar novamente" : "Conectar com Vercel"}
                  </button>
                </div>
              )}

              {(vercelError || vercelState.error) && (
                <div className="creation-error">
                  <AlertTriangle size={14}/> {vercelError || vercelState.error}
                </div>
              )}
            </div>
          ) : (
            <div className="modal-scroll-body vercel-publish-step">
              <div className="vercel-account-bar">
                <div className="vercel-user-info">
                  <CheckCircle2 size={16} className="text-success"/>
                  <span>Conectado como <strong>{vercelState.username || "usuário"}</strong></span>
                </div>
                <div className="vercel-account-actions">
                  <button type="button" className="secondary btn-sm" onClick={() => void window.neko.vercelOpenDashboard()}>
                    <ExternalLink size={13}/> Dashboard
                  </button>
                  <button
                    type="button"
                    className="secondary btn-sm danger-action"
                    disabled={vercelState.deployment === "deploying" || vercelBusy}
                    onClick={() => void handleDisconnectVercel()}
                  >
                    <Unplug size={13}/> Desconectar
                  </button>
                </div>
              </div>

              <div className="vercel-project-card">
                <span className="vercel-card-label">Frontend detectado</span>
                <strong className="vercel-card-name">{vercelState.projectName || (project ? (project.split(/[/\\]/).filter(Boolean).pop() || project) : "Nenhum projeto selecionado")}</strong>
                <code className="vercel-card-path">{vercelState.projectPath || project || "Selecione uma pasta com um frontend válido."}</code>
                {project ? (
                  <small className="vercel-card-hint">
                    {vercelState.linked
                      ? "✓ Projeto já vinculado à Vercel (.vercel/project.json)"
                      : "O projeto será criado e vinculado automaticamente no primeiro deploy"}
                  </small>
                ) : null}
              </div>

              {!vercelState.linked && (
                <div className="vercel-field-group">
                  <label className="vercel-field-label">
                    Nome do projeto na Vercel
                  </label>
                  <input
                    type="text"
                    className="api-input"
                    value={vercelProjectName}
                    onChange={(e) => {
                      setVercelProjectName(e.target.value);
                      if (vercelError) setVercelError(null);
                    }}
                    placeholder="ex: meu-projeto"
                    disabled={vercelBusy || vercelState.deployment === "deploying"}
                    maxLength={100}
                    autoFocus
                  />
                  {vercelProjectName.trim() && !isValidVercelProjectName(vercelProjectName) && (
                    <div className="auth-error" style={{ marginTop: 0 }}>
                      {getVercelNameValidationError(vercelProjectName)}
                    </div>
                  )}
                  {!vercelProjectName.trim() && (
                    <div className="auth-error" style={{ marginTop: 0 }}>
                      Informe o nome do projeto na Vercel.
                    </div>
                  )}
                </div>
              )}

              {vercelState.deployment === "deploying" ? (
                <div className="vercel-deploying-box">
                  <Loader2 size={24} className="spin text-primary"/>
                  <div>
                    <strong>Publicando em produção...</strong>
                    <span>A Vercel está enviando os arquivos e construindo o frontend.</span>
                  </div>
                </div>
              ) : vercelState.deploymentUrl ? (
                <div className="vercel-success-box">
                  <div className="connection-badge">
                    <CheckCircle2 size={18}/>
                    <span>Publicado com sucesso</span>
                  </div>
                  <a
                    href={vercelState.deploymentUrl}
                    className="vercel-url-link"
                    onClick={(e) => {
                      e.preventDefault();
                      void window.neko.vercelOpenDeployment();
                    }}
                  >
                    {vercelState.deploymentUrl}
                  </a>
                </div>
              ) : null}

              {(vercelError || vercelState.error) && (
                <div className="creation-error">
                  <AlertTriangle size={14}/> {vercelError || vercelState.error}
                </div>
              )}

              <div className="modal-actions split-actions">
                {vercelState.deploymentUrl ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void window.neko.vercelOpenDeployment()}
                  >
                    <ExternalLink size={14}/> Abrir site
                  </button>
                ) : <div />}

                <button
                  type="button"
                  className="primary vercel-publish-btn"
                  disabled={!project || vercelState.deployment === "deploying" || vercelBusy || (!vercelState.linked && !isValidVercelProjectName(vercelProjectName))}
                  onClick={() => void handlePublishVercel()}
                >
                  {vercelState.deployment === "deploying" || vercelBusy ? (
                    <Loader2 size={16} className="spin"/>
                  ) : (
                    <CloudUpload size={16}/>
                  )}
                  {vercelState.deploymentUrl ? "Publicar novamente" : "Publicar em produção"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {modal === "license" && (
        <div className="license-modal-container">
          <div className="modal-head">
            <div>
              <h2 id="modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Key size={19} className="text-primary"/> Gerenciamento de Licença
              </h2>
              <p>Controle a ativação, plano e dispositivos vinculados ao NekoAI Desktop.</p>
            </div>
            <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
          </div>

          <div className="license-modal-content">
            {/* Badge de Estado da Licença */}
            <div className={`license-status-banner ${licenseState.state.toLowerCase()}`}>
              <div className="license-status-icon">
                {licenseState.state === "VALID" ? <BadgeCheck size={20}/> :
                 licenseState.state === "GRACE" ? <AlertTriangle size={20}/> :
                 licenseState.state === "EXPIRED" ? <CircleAlert size={20}/> :
                 licenseState.state === "INVALID" ? <ShieldAlert size={20}/> :
                 <Key size={20}/>}
              </div>
              <div className="license-status-info">
                <strong>
                  {licenseState.state === "VALID" ? "Licença Ativa" :
                   licenseState.state === "GRACE" ? "Licença em Período de Tolerância" :
                   licenseState.state === "EXPIRED" ? "Licença Expirada" :
                   licenseState.state === "INVALID" ? "Licença Inválida" :
                   "Nenhuma Licença Ativada"}
                </strong>
                <span>
                  {licenseState.state === "VALID" ? "Seu aplicativo está totalmente licenciado para este dispositivo." :
                   licenseState.state === "GRACE" ? "Acesso permitido em modo offline temporário. A verificação ocorrerá automaticamente quando houver conexão." :
                   licenseState.state === "EXPIRED" ? "O período de validade da sua assinatura expirou." :
                   licenseState.state === "INVALID" ? "O certificado local não passou na validação de integridade." :
                   "Insira sua chave de ativação para desbloquear todos os recursos."}
                </span>
              </div>
            </div>

            {licenseSuccessMessage && (
              <div className="license-success-box">
                <CheckCircle2 size={16}/> <span>{licenseSuccessMessage}</span>
              </div>
            )}

            {licenseError && (
              <div className="creation-error" style={{ margin: "10px 0" }}>
                <AlertTriangle size={15}/> <span>{licenseError}</span>
              </div>
            )}

            {/* Visualização de Licença Ativa / Grace */}
            {(licenseState.state === "VALID" || licenseState.state === "GRACE" || licenseState.state === "EXPIRED") && (
              <div className="license-details-card">
                <div className="license-detail-grid">
                  <div className="license-detail-item">
                    <span className="detail-label"><ShieldCheck size={14}/> Plano</span>
                    <strong className="detail-value">{licenseState.plan || "ANNUAL"}</strong>
                  </div>
                  <div className="license-detail-item">
                    <span className="detail-label"><Calendar size={14}/> Validade</span>
                    <strong className="detail-value">
                      {licenseState.expiresAt ? new Date(licenseState.expiresAt).toLocaleDateString("pt-BR") : "Indeterminado"}
                    </strong>
                  </div>
                  {licenseState.state === "GRACE" && licenseState.graceUntil && (
                    <div className="license-detail-item warning-highlight">
                      <span className="detail-label"><AlertTriangle size={14}/> Tolerância até</span>
                      <strong className="detail-value">
                        {new Date(licenseState.graceUntil).toLocaleDateString("pt-BR")}
                      </strong>
                    </div>
                  )}
                  <div className="license-detail-item">
                    <span className="detail-label"><Laptop size={14}/> Dispositivo</span>
                    <strong className="detail-value" title={licenseState.deviceId}>
                      {licenseState.deviceId ? `${licenseState.deviceId.slice(0, 8)}••••••••` : "Este computador"}
                    </strong>
                  </div>
                </div>

                {licenseState.keyMask && (
                  <div className="license-keymask-bar">
                    <span>Chave vinculada: <code>{licenseState.keyMask}</code></span>
                  </div>
                )}

                <div className="modal-actions" style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="secondary text-danger"
                    disabled={licenseBusy}
                    onClick={() => {
                      setLicenseError(null);
                      setModal("licenseDeactivateConfirm");
                    }}
                  >
                    <Unplug size={14}/> Desativar Dispositivo
                  </button>
                </div>
              </div>
            )}

            {/* Formulário de Ativação (MISSING ou INVALID) */}
            {(licenseState.state === "MISSING" || licenseState.state === "INVALID") && (
              <>
                {licenseErrorCode === "DEVICE_ALREADY_ACTIVE" && (
                  <div className="branch-discard-warning-card" style={{ marginBottom: 14, borderColor: "rgba(234, 179, 8, .3)", background: "rgba(234, 179, 8, .06)" }}>
                    <b style={{ color: "#fef08a" }}>Esta licença já está ativada em outro dispositivo.</b>
                    <p style={{ margin: "4px 0 10px 0", fontSize: "11.5px", color: "#eee" }}>
                      Deseja transferir o acesso para este computador? O dispositivo anterior perderá a conexão.
                    </p>
                    <button
                      type="button"
                      className="primary"
                      style={{ width: "100%", justifyContent: "center", background: "#ca8a04", borderColor: "#eab308" }}
                      onClick={() => setModal("licenseResetConfirm")}
                    >
                      <RefreshCw size={14} />
                      <span>Transferir para este computador</span>
                    </button>
                  </div>
                )}

                <form onSubmit={handleActivateLicense} className="license-activate-form">
                  <div className="input-group">
                    <label htmlFor="license-key-field">Chave de Licença:</label>
                    <input
                      id="license-key-field"
                      type="text"
                      className="api-input"
                      value={licenseKeyInput}
                      onChange={e => setLicenseKeyInput(formatLicenseKey(e.target.value))}
                      maxLength={24}
                      placeholder="NEKO-XXXX-XXXX-XXXX-XXXX"
                      disabled={licenseBusy}
                      autoFocus
                      spellCheck={false}
                    />
                  </div>

                  <div className="modal-actions" style={{ justifyContent: "flex-end", marginTop: 16 }}>
                    <button
                      type="submit"
                      className="primary"
                      disabled={licenseBusy || !isLicenseKeyComplete(licenseKeyInput)}
                    >
                      {licenseBusy ? <Loader2 size={16} className="spin"/> : <Check size={16}/>}
                      <span>{licenseBusy ? "Ativando..." : "Ativar Licença"}</span>
                    </button>
                  </div>
                </form>

                <div className="license-acquire-cta">
                  <span>Ainda não possui? </span>
                  <a
                    href="https://nekoai.com.br"
                    className="license-acquire-link"
                    onClick={e => {
                      e.preventDefault();
                      void window.neko.openExternal("https://nekoai.com.br");
                    }}
                  >
                    Adquira sua licença por aqui
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {modal === "licenseResetConfirm" && (
        <>
          <div className="modal-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="branch-modal-icon-wrap" style={{ background: "rgba(234, 179, 8, .12)", borderColor: "rgba(234, 179, 8, .28)" }}>
                <RefreshCw size={18} color="#eab308" />
              </div>
              <div>
                <h2 id="modal-title">Transferir licença?</h2>
                <p>Vincular esta licença a este computador.</p>
              </div>
            </div>
            <button className="close-btn" disabled={licenseBusy} onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
          </div>

          <div className="modal-scroll-body branch-discard-modal-body">
            <div className="branch-discard-warning-card" style={{ borderColor: "rgba(234, 179, 8, .3)", background: "rgba(234, 179, 8, .06)" }}>
              <b style={{ color: "#fef08a" }}>Atenção: O computador anterior perderá o acesso imediatamente.</b>
              <p style={{ color: "#eee" }}>
                Cada licença NekoAI permite <b>1 dispositivo ativo por vez</b>. Ao transferir para esta máquina, o computador anterior será desconectado e este passará a ser o dispositivo ativo.
              </p>
              <small style={{ color: "#9ca3af" }}>
                Você pode transferir sua licença entre seus computadores sempre que precisar.
              </small>
            </div>

            {licenseError && (
              <div className="creation-error" style={{ marginTop: 12 }}>
                <AlertTriangle size={14} /> {licenseError}
              </div>
            )}
          </div>

          <div className="modal-actions branch-modal-actions">
            <button
              type="button"
              className="secondary"
              disabled={licenseBusy}
              onClick={() => setModal(null)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="primary"
              style={{ background: "#ca8a04", borderColor: "#eab308" }}
              disabled={licenseBusy}
              onClick={() => void handleResetLicense()}
            >
              {licenseBusy ? <><Loader2 size={15} className="spin" /> Transferindo...</> : <><RefreshCw size={14} /> Confirmar Transferência</>}
            </button>
          </div>
        </>
      )}

      {modal === "licenseDeactivateConfirm" && (
        <>
          <div className="modal-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="branch-modal-icon-wrap danger">
                <AlertTriangle size={18} color="#ef4444" />
              </div>
              <div>
                <h2 id="modal-title">Desativar este dispositivo?</h2>
                <p>Libere a vaga da sua licença para ser utilizada em outro computador.</p>
              </div>
            </div>
            <button className="close-btn" disabled={licenseBusy} onClick={() => setModal("license")} aria-label="Fechar"><X size={17}/></button>
          </div>

          <div className="modal-scroll-body branch-discard-modal-body">
            <div className="branch-discard-warning-card">
              <b>Atenção: O acesso a este workspace será bloqueado.</b>
              <p>
                O certificado de licença deste computador será revogado localmente e no servidor. Você precisará informar a chave novamente para reativar este computador.
              </p>
              <small>Seus projetos, arquivos e configurações locais continuarão intactos e seguros.</small>
            </div>

            {licenseError && (
              <div className="creation-error" style={{ marginTop: 12 }}>
                <AlertTriangle size={14} /> {licenseError}
              </div>
            )}
          </div>

          <div className="modal-actions branch-modal-actions">
            <button
              type="button"
              className="secondary"
              disabled={licenseBusy}
              onClick={() => setModal("license")}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="primary danger-confirm-btn"
              disabled={licenseBusy}
              onClick={() => void handleDeactivateLicense()}
            >
              {licenseBusy ? <><Loader2 size={15} className="spin" /> Desativando...</> : <><Unplug size={14} /> Confirmar Desativação</>}
            </button>
          </div>
        </>
      )}

      {modal === "settings" && (
        <div className="settings-modal-container">
          <div className="modal-head">
            <div>
              <h2 id="modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Settings2 size={19} className="text-primary"/> Configurações & Atualizações
              </h2>
              <p>Gerencie as preferências e atualizações automáticas do NekoAI Studio.</p>
            </div>
            <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar"><X size={17}/></button>
          </div>

          <div className="modal-scroll-body settings-modal-body">
            {/* Sons de notificação */}
            <div className="settings-section-card">
              <div className="settings-section-head">
                <div className="settings-section-title">
                  <Volume2 size={16} className="text-primary"/>
                  <strong>Sons de notificação</strong>
                </div>
              </div>
              <div className="settings-sound-row">
                <span className="settings-sound-label">Avisos sonoros discretos quando uma tarefa termina, gera erro, faz uma pergunta ou aguarda aprovação/plano.</span>
                <div className="settings-sound-controls">
                  <button className="settings-sound-test" onClick={() => { unlockAudio(); playNotify("test"); }}>Testar som</button>
                  <button className={`toggle sound-toggle ${soundsOn ? "on" : ""}`} aria-pressed={soundsOn} onClick={() => toggleSounds(!soundsOn)}><i/></button>
                </div>
              </div>
            </div>
            {/* Card de Atualização */}
            <div className="settings-section-card">
              <div className="settings-section-head">
                <div className="settings-section-title">
                  <RefreshCw size={16} className={updaterState.status === "checking" ? "spin text-primary" : "text-primary"}/>
                  <strong>Atualizações do NekoAI</strong>
                </div>
                <span className="settings-version-badge">v{updaterState.currentVersion}</span>
              </div>

              {/* Status do Updater */}
              {updaterState.status === "checking" && (
                <div className="updater-status-box checking">
                  <Loader2 size={18} className="spin text-primary"/>
                  <div>
                    <strong>Verificando atualizações...</strong>
                    <span>Consultando novos lançamentos no servidor oficial...</span>
                  </div>
                </div>
              )}

              {updaterState.status === "available" && (
                <div className="updater-status-box available">
                  <Sparkles size={18} color="#a855f7"/>
                  <div style={{ flex: 1 }}>
                    <div className="updater-available-title">
                      <strong>Nova versão disponível: v{updaterState.updateInfo?.version}</strong>
                      <span className="updater-pill-new">NOVA</span>
                    </div>
                    <span>Uma nova versão do NekoAI está pronta para download.</span>
                    {updaterState.updateInfo?.releaseNotes ? (
                      <div className="updater-release-notes">
                        <small><b>Novidades:</b></small>
                        <p>{typeof updaterState.updateInfo.releaseNotes === "string" ? updaterState.updateInfo.releaseNotes : "Melhorias de estabilidade e novas funcionalidades."}</p>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {updaterState.status === "downloading" && (
                <div className="updater-status-box downloading">
                  <Loader2 size={18} className="spin text-primary"/>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <strong>Baixando atualização (v{updaterState.updateInfo?.version || ""})...</strong>
                      <span style={{ fontWeight: "bold", color: "#a855f7" }}>{Math.round(updaterState.progress?.percent || 0)}%</span>
                    </div>
                    <div className="updater-progress-bar-bg">
                      <div
                        className="updater-progress-bar-fill"
                        style={{ width: `${Math.max(2, Math.min(100, updaterState.progress?.percent || 0))}%` }}
                      />
                    </div>
                    <div className="updater-progress-meta">
                      <small>
                        {updaterState.progress?.transferred ? (updaterState.progress.transferred / 1024 / 1024).toFixed(1) : "0"} MB de{" "}
                        {updaterState.progress?.total ? (updaterState.progress.total / 1024 / 1024).toFixed(1) : "0"} MB
                      </small>
                      {updaterState.progress?.bytesPerSecond ? (
                        <small>{(updaterState.progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s</small>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}

              {updaterState.status === "downloaded" && (
                <div className="updater-status-box downloaded">
                  <CheckCircle2 size={20} color="#22c55e"/>
                  <div>
                    <strong>Atualização pronta para instalação! (v{updaterState.updateInfo?.version})</strong>
                    <span>O pacote de instalação foi baixado com sucesso e validado.</span>
                  </div>
                </div>
              )}

              {updaterState.status === "not-available" && (
                <div className="updater-status-box up-to-date">
                  <CheckCircle2 size={18} color="#22c55e"/>
                  <div>
                    <strong>Você está utilizando a versão mais atualizada</strong>
                    <span>Nenhuma atualização pendente no momento.</span>
                  </div>
                </div>
              )}

              {updaterState.status === "error" && (
                <div className="creation-error" style={{ margin: "10px 0" }}>
                  <AlertTriangle size={15}/>
                  <span>{updaterState.error || "Ocorreu um erro ao verificar atualizações."}</span>
                </div>
              )}

              {updaterState.status === "idle" && !updaterState.error && (
                <div className="updater-status-box idle">
                  <Settings2 size={18} color="#8a7f92"/>
                  <div>
                    <strong>NekoAI Auto Updater</strong>
                    <span>Verifique manualmente se há atualizações ou novidades disponíveis.</span>
                  </div>
                </div>
              )}

              {/* Ações do Updater */}
              <div className="updater-actions" style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                {updaterState.status === "available" ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={updaterBusy}
                    onClick={() => void handleDownloadUpdate()}
                  >
                    {updaterBusy ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                    <span>Baixar Atualização</span>
                  </button>
                ) : updaterState.status === "downloaded" ? (
                  <button
                    type="button"
                    className="primary"
                    style={{ background: "#16a34a", borderColor: "#22c55e" }}
                    onClick={() => void handleInstallUpdate()}
                  >
                    <RefreshCw size={15} />
                    <span>Reiniciar e Instalar Agora</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={updaterBusy || updaterState.status === "checking" || updaterState.status === "downloading"}
                    onClick={() => void handleCheckForUpdates()}
                  >
                    {updaterBusy || updaterState.status === "checking" ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    <span>Verificar Atualizações</span>
                  </button>
                )}
              </div>
            </div>

            {/* Card de Informações da Aplicação & Licenciamento */}
            <div className="settings-section-card" style={{ marginTop: 14 }}>
              <div className="settings-section-head">
                <div className="settings-section-title">
                  <Key size={16} className="text-primary"/>
                  <strong>Licenciamento & Sistema</strong>
                </div>
              </div>

              <div className="settings-info-grid">
                <div className="settings-info-item">
                  <span className="settings-info-label">Status da Licença</span>
                  <strong className={`settings-info-value ${licenseState.state === "VALID" ? "text-success" : ""}`}>
                    {licenseState.state === "VALID" ? "Ativa (Licenciado)" :
                     licenseState.state === "GRACE" ? "Tolerância Offline" :
                     licenseState.state === "EXPIRED" ? "Expirada" : "Não Ativada"}
                  </strong>
                </div>
                <div className="settings-info-item">
                  <span className="settings-info-label">Plano</span>
                  <strong className="settings-info-value">{licenseState.plan || "Nenhum"}</strong>
                </div>
                <div className="settings-info-item">
                  <span className="settings-info-label">Canal de Lançamento</span>
                  <strong className="settings-info-value">Produção (GitHub Releases)</strong>
                </div>
                <div className="settings-info-item">
                  <span className="settings-info-label">Motor de Inteligência</span>
                  <strong className="settings-info-value">OpenCode Standalone</strong>
                </div>
              </div>

              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setLicenseError(null);
                    setLicenseSuccessMessage(null);
                    setModal("license");
                  }}
                >
                  <Key size={14} />
                  <span>Gerenciar Licença</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
    }

    {lightboxImage && (
      <div className="lightbox-overlay" role="dialog" aria-label="Visualização da imagem" onClick={() => setLightboxImage(null)}>
        <button type="button" className="lightbox-close" onClick={() => setLightboxImage(null)} aria-label="Fechar visualização"><X size={18}/></button>
        <img className="lightbox-image" src={lightboxImage.url} alt={lightboxImage.name} onClick={e => e.stopPropagation()}/>
      </div>
    )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);

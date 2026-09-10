export type VercelConnectionStatus = "checking" | "connected" | "disconnected" | "authorizing" | "error";
export type VercelDeploymentStatus = "idle" | "deploying" | "ready" | "error";

export interface VercelState {
  configured: boolean;
  connection: VercelConnectionStatus;
  deployment: VercelDeploymentStatus;
  username: string | null;
  projectPath: string | null;
  projectName: string | null;
  linked: boolean;
  deploymentUrl: string | null;
  error: string | null;
}

export const EMPTY_VERCEL_STATE: VercelState = {
  configured: false,
  connection: "checking",
  deployment: "idle",
  username: null,
  projectPath: null,
  projectName: null,
  linked: false,
  deploymentUrl: null,
  error: null,
};

export interface VercelProjectDeployment {
  projectPath: string;
  projectName?: string;
  deploymentUrl: string;
  updatedAt: string;
}

export interface VercelCliCommand {
  command: string;
  prefix: string[];
}

export function isValidVercelProjectName(name: string): boolean {
  const trimmed = String(name || "").trim();
  if (trimmed.length < 1 || trimmed.length > 100) return false;
  if (trimmed.includes("---")) return false;
  return /^[a-z0-9_.-]+$/.test(trimmed);
}

export function slugifyVercelProjectName(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

export function getVercelNameValidationError(name: string): string | null {
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


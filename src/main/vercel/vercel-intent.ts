import crypto from "node:crypto";
import path from "node:path";

export interface VercelPublishIntent {
  intentId: string;
  projectPath: string;
  projectName?: string;
  projectGeneration: number;
  username: string | null;
  createdAt: number;
  expiresAt: number;
  state: "created" | "consumed" | "invalidated" | "expired";
}

export interface IntentValidationResult {
  valid: boolean;
  reason?: string;
  userMessage?: string;
  intent?: VercelPublishIntent;
}

export interface CreateIntentParams {
  projectPath: string;
  projectName?: string;
  projectGeneration: number;
  username: string | null;
  ttlMs?: number;
}

function normalizePath(p: string): string {
  return path.resolve(p || "").replace(/[/\\]+$/, "").toLowerCase();
}

export class VercelPublishIntentManager {
  private intents = new Map<string, VercelPublishIntent>();
  private defaultTtlMs = 60_000; // 60 seconds

  constructor(defaultTtlMs = 60_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  public createIntent(params: CreateIntentParams): VercelPublishIntent {
    const { projectPath, projectName, projectGeneration, username, ttlMs } = params;
    
    // Invalidate any prior active intent for the same workspace
    this.invalidateByPath(projectPath, "new intent created");

    const intentId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);

    const intent: VercelPublishIntent = {
      intentId,
      projectPath,
      projectName,
      projectGeneration,
      username,
      createdAt: now,
      expiresAt,
      state: "created",
    };

    this.intents.set(intentId, intent);
    console.log(`[Vercel/Security] publish intent created intentId=${intentId} project=${projectPath} gen=${projectGeneration}`);

    return intent;
  }

  public validateAndConsume(
    intentId: string | undefined,
    projectPath: string,
    projectGeneration: number,
    currentUsername: string | null
  ): IntentValidationResult {
    if (!intentId || typeof intentId !== "string") {
      console.warn("[Vercel/Security] publicação rejeitada: intenção inválida");
      return {
        valid: false,
        reason: "intenção inválida ou ausente",
        userMessage: "Publicação na Vercel requer confirmação explícita.",
      };
    }

    const intent = this.intents.get(intentId);
    if (!intent) {
      console.warn(`[Vercel/Security] publish intent rejected reason=not_found intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção não encontrada",
        userMessage: "Publicação na Vercel requer confirmação explícita.",
      };
    }

    if (intent.state === "consumed") {
      console.warn(`[Vercel/Security] publish intent rejected reason=already_consumed intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção já consumida (one-shot)",
        userMessage: "Esta autorização de publicação já foi utilizada. Confirme novamente.",
      };
    }

    if (intent.state === "invalidated") {
      console.warn(`[Vercel/Security] publish intent rejected reason=invalidated intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção invalidada",
        userMessage: "A autorização de publicação foi invalidada por mudança de contexto.",
      };
    }

    const now = Date.now();
    if (now > intent.expiresAt || intent.state === "expired") {
      intent.state = "expired";
      console.warn(`[Vercel/Security] publish intent expired intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção expirada",
        userMessage: "A autorização de publicação expirou. Inicie a publicação novamente.",
      };
    }

    // Validate project path
    if (normalizePath(intent.projectPath) !== normalizePath(projectPath)) {
      console.warn(`[Vercel/Security] publish intent rejected reason=project_mismatch intentId=${intentId}`);
      return {
        valid: false,
        reason: "projeto não corresponde à intenção",
        userMessage: "A autorização não corresponde ao projeto ativo.",
      };
    }

    // Validate project transition generation
    if (intent.projectGeneration !== projectGeneration) {
      console.warn(`[Vercel/Security] publish intent rejected reason=generation_mismatch intentId=${intentId}`);
      return {
        valid: false,
        reason: "geração do projeto mudou",
        userMessage: "O estado do projeto mudou durante a autorização. Confirme novamente.",
      };
    }

    // Validate user account
    if (!intent.username || !currentUsername || intent.username !== currentUsername) {
      console.warn(`[Vercel/Security] publish intent rejected reason=account_mismatch intentId=${intentId}`);
      return {
        valid: false,
        reason: "conta Vercel mudou",
        userMessage: "A conta da Vercel foi alterada. Autorize novamente com a nova conta.",
      };
    }

    // All checks passed -> ONE-SHOT: consume immediately
    intent.state = "consumed";
    console.log(`[Vercel/Security] publish intent confirmed intentId=${intentId} project=${projectPath}`);
    console.log(`[Vercel/Security] publish intent consumed intentId=${intentId} project=${projectPath}`);

    return {
      valid: true,
      intent,
    };
  }

  public invalidateByPath(projectPath: string, reason = "path context changed"): void {
    const norm = normalizePath(projectPath);
    for (const [id, intent] of this.intents) {
      if (intent.state === "created" && normalizePath(intent.projectPath) === norm) {
        intent.state = "invalidated";
        console.log(`[Vercel/Security] publish intent invalidated intentId=${id} reason=${reason}`);
      }
    }
  }

  public invalidateAll(reason = "context reset"): void {
    for (const [id, intent] of this.intents) {
      if (intent.state === "created") {
        intent.state = "invalidated";
        console.log(`[Vercel/Security] publish intent invalidated intentId=${id} reason=${reason}`);
      }
    }
  }

  public getIntent(intentId: string): VercelPublishIntent | null {
    return this.intents.get(intentId) ?? null;
  }

  public clear(): void {
    this.intents.clear();
  }
}

export const vercelIntentManager = new VercelPublishIntentManager();

export interface VercelLinkIntent {
  intentId: string;
  projectPath: string;
  projectId?: string;
  projectName: string;
  gitRepo: string;
  projectGeneration: number;
  username: string | null;
  createdAt: number;
  expiresAt: number;
  state: "created" | "consumed" | "invalidated" | "expired";
}

export interface LinkIntentValidationResult {
  valid: boolean;
  reason?: string;
  userMessage?: string;
  intent?: VercelLinkIntent;
}

export interface CreateLinkIntentParams {
  projectPath: string;
  projectId?: string;
  projectName: string;
  gitRepo: string;
  projectGeneration: number;
  username: string | null;
  ttlMs?: number;
}

export class VercelLinkIntentManager {
  private intents = new Map<string, VercelLinkIntent>();
  private defaultTtlMs = 60_000; // 60 seconds

  constructor(defaultTtlMs = 60_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  public createIntent(params: CreateLinkIntentParams): VercelLinkIntent {
    const { projectPath, projectId, projectName, gitRepo, projectGeneration, username, ttlMs } = params;

    // Invalidate any prior active link intent for the same workspace
    this.invalidateByPath(projectPath, "new link intent created");

    const intentId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);

    const intent: VercelLinkIntent = {
      intentId,
      projectPath,
      projectId,
      projectName,
      gitRepo,
      projectGeneration,
      username,
      createdAt: now,
      expiresAt,
      state: "created",
    };

    this.intents.set(intentId, intent);
    console.log(
      `[Vercel/Security] link intent created intentId=${intentId} project=${projectPath} target=${projectName} gen=${projectGeneration}`
    );

    return intent;
  }

  public validateAndConsume(
    intentId: string | undefined,
    projectPath: string,
    projectGeneration: number,
    currentUsername: string | null
  ): LinkIntentValidationResult {
    if (!intentId || typeof intentId !== "string") {
      console.warn("[Vercel/Security] vínculo rejeitado: intenção inválida");
      return {
        valid: false,
        reason: "intenção inválida ou ausente",
        userMessage: "O vínculo com a Vercel requer confirmação explícita.",
      };
    }

    const intent = this.intents.get(intentId);
    if (!intent) {
      console.warn(`[Vercel/Security] link intent rejected reason=not_found intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção não encontrada",
        userMessage: "O vínculo com a Vercel requer confirmação explícita.",
      };
    }

    if (intent.state === "consumed") {
      console.warn(`[Vercel/Security] link intent rejected reason=already_consumed intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção já consumida (one-shot)",
        userMessage: "Esta autorização de vínculo já foi utilizada. Confirme novamente.",
      };
    }

    if (intent.state === "invalidated") {
      console.warn(`[Vercel/Security] link intent rejected reason=invalidated intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção invalidada",
        userMessage: "A autorização de vínculo foi invalidada por mudança de contexto.",
      };
    }

    const now = Date.now();
    if (now > intent.expiresAt || intent.state === "expired") {
      intent.state = "expired";
      console.warn(`[Vercel/Security] link intent expired intentId=${intentId}`);
      return {
        valid: false,
        reason: "intenção expirada",
        userMessage: "A autorização de vínculo expirou. Tente vincular novamente.",
      };
    }

    // Validate project path
    if (normalizePath(intent.projectPath) !== normalizePath(projectPath)) {
      console.warn(`[Vercel/Security] link intent rejected reason=project_mismatch intentId=${intentId}`);
      return {
        valid: false,
        reason: "projeto não corresponde à intenção",
        userMessage: "A autorização não corresponde ao projeto ativo.",
      };
    }

    // Validate project transition generation
    if (intent.projectGeneration !== projectGeneration) {
      console.warn(`[Vercel/Security] link intent rejected reason=generation_mismatch intentId=${intentId}`);
      return {
        valid: false,
        reason: "geração do projeto mudou",
        userMessage: "O estado do projeto mudou durante a autorização. Confirme novamente.",
      };
    }

    // Validate user account
    if (!intent.username || !currentUsername || intent.username !== currentUsername) {
      console.warn(`[Vercel/Security] link intent rejected reason=account_mismatch intentId=${intentId}`);
      return {
        valid: false,
        reason: "conta Vercel mudou",
        userMessage: "A conta da Vercel foi alterada. Autorize novamente com a nova conta.",
      };
    }

    // All checks passed -> ONE-SHOT: consume immediately
    intent.state = "consumed";
    console.log(`[Vercel/Security] link intent confirmed intentId=${intentId} project=${projectPath}`);
    console.log(`[Vercel/Security] link intent consumed intentId=${intentId} project=${projectPath}`);

    return {
      valid: true,
      intent,
    };
  }

  public invalidateByPath(projectPath: string, reason = "path context changed"): void {
    const norm = normalizePath(projectPath);
    for (const [id, intent] of this.intents) {
      if (intent.state === "created" && normalizePath(intent.projectPath) === norm) {
        intent.state = "invalidated";
        console.log(`[Vercel/Security] link intent invalidated intentId=${id} reason=${reason}`);
      }
    }
  }

  public invalidateAll(reason = "context reset"): void {
    for (const [id, intent] of this.intents) {
      if (intent.state === "created") {
        intent.state = "invalidated";
        console.log(`[Vercel/Security] link intent invalidated intentId=${id} reason=${reason}`);
      }
    }
  }

  public getIntent(intentId: string): VercelLinkIntent | null {
    return this.intents.get(intentId) ?? null;
  }

  public clear(): void {
    this.intents.clear();
  }
}

export const vercelLinkIntentManager = new VercelLinkIntentManager();

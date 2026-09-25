import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { LovableDetectionResult, LOVABLE_PROJECT_ID_REGEX } from "./lovable-types";

export async function detectLovableProject(projectPath: string): Promise<LovableDetectionResult> {
  if (!projectPath || typeof projectPath !== "string") {
    return {
      isLovable: false,
      reason: "Caminho do projeto inválido ou não fornecido."
    };
  }

  const resolved = path.resolve(projectPath);
  if (!fsSync.existsSync(resolved)) {
    return {
      isLovable: false,
      reason: "Diretório do projeto não existe no disco."
    };
  }

  let hasLocalConfig = false;
  let hasAgentsMarker = false;
  let hasSupabaseConfig = false;
  let detectedProjectId: string | undefined;

  // 1. Verificar .lovable/project.json
  const configPath = path.join(resolved, ".lovable", "project.json");
  if (fsSync.existsSync(configPath)) {
    hasLocalConfig = true;
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw);
      const rawId = parsed?.projectId || parsed?.id || parsed?.project_id;
      if (typeof rawId === "string" && LOVABLE_PROJECT_ID_REGEX.test(rawId.trim())) {
        detectedProjectId = rawId.trim();
      }
    } catch {
      // Arquivo existe mas JSON pode estar corrompido; ainda é indicativo de Lovable
    }
  }

  // 2. Verificar AGENTS.md
  const agentsPath = path.join(resolved, "AGENTS.md");
  if (fsSync.existsSync(agentsPath)) {
    try {
      const content = await fs.readFile(agentsPath, "utf8");
      if (
        content.includes("LOVABLE:BEGIN") ||
        content.includes("lovable.dev") ||
        content.includes("Lovable Project") ||
        content.includes("# Lovable")
      ) {
        hasAgentsMarker = true;
      }
    } catch {
      // Ignora erro de leitura
    }
  }

  // 3. Verificar supabase/config.toml (sinal complementar de stack)
  const supabaseConfigPath = path.join(resolved, "supabase", "config.toml");
  if (fsSync.existsSync(supabaseConfigPath)) {
    hasSupabaseConfig = true;
  }

  const isLovable = hasLocalConfig || hasAgentsMarker;
  const reasons: string[] = [];

  if (hasLocalConfig) reasons.push("Arquivo .lovable/project.json encontrado");
  if (hasAgentsMarker) reasons.push("Marcador de agente Lovable encontrado em AGENTS.md");
  if (hasSupabaseConfig) reasons.push("Configuração Supabase (supabase/config.toml) presente");

  return {
    isLovable,
    reason: reasons.length > 0 ? reasons.join("; ") : "Nenhum marcador do Lovable encontrado no projeto.",
    projectId: detectedProjectId,
    hasLocalConfig,
    hasAgentsMarker,
    hasSupabaseConfig,
  };
}

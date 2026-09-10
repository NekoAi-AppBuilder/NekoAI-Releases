import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  SupabaseConfigureOptions,
  SupabaseEnvironmentNames,
} from "./supabase-types";
import { resolvePackageManager, getSpawnInvocation } from "./supabase-cli";

export const getSupabaseMcpName = (projectRef: string): string =>
  `neko_supabase_${projectRef}`;

export const getSupabaseMcpUrl = (projectRef: string): string =>
  `https://mcp.supabase.com/mcp?project_ref=${projectRef}`;

export const getSupabaseSkillPath = (root: string, projectRef: string): string =>
  path.join(root, ".opencode", "skills", `neko-supabase-${projectRef}`, "SKILL.md");

export const getSupabaseEnvironmentNames = (framework?: string | null): SupabaseEnvironmentNames => {
  const name = (framework || "").toLowerCase();
  if (name.includes("next")) {
    return {
      url: "NEXT_PUBLIC_SUPABASE_URL",
      publishableKey: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  if (name.includes("nuxt")) {
    return {
      url: "NUXT_PUBLIC_SUPABASE_URL",
      publishableKey: "NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  if (name.includes("vite") || name.includes("remix") || name.includes("qwik")) {
    return {
      url: "VITE_SUPABASE_URL",
      publishableKey: "VITE_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  if (name.includes("astro") || name.includes("sveltekit")) {
    return {
      url: "PUBLIC_SUPABASE_URL",
      publishableKey: "PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  if (name.includes("create react app")) {
    return {
      url: "REACT_APP_SUPABASE_URL",
      publishableKey: "REACT_APP_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  if (name.includes("vue")) {
    return {
      url: "VUE_APP_SUPABASE_URL",
      publishableKey: "VUE_APP_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  if (name.includes("gatsby")) {
    return {
      url: "GATSBY_SUPABASE_URL",
      publishableKey: "GATSBY_SUPABASE_PUBLISHABLE_KEY",
    };
  }
  return {
    url: "SUPABASE_URL",
    publishableKey: "SUPABASE_PUBLISHABLE_KEY",
  };
};

export const mergeEnvironmentValues = (source: string, values: Record<string, string>): string => {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source ? source.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(values));
  const managedKeys = new Set(remaining.keys());
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !managedKeys.has(key)) {
      output.push(line);
      continue;
    }
    if (!remaining.has(key)) continue;
    output.push(`${key}=${remaining.get(key)}`);
    remaining.delete(key);
  }

  if (output.length > 0 && remaining.size > 0 && output[output.length - 1] !== "") {
    output.push("");
  }
  for (const [key, value] of remaining) {
    output.push(`${key}=${value}`);
  }
  return `${output.join(eol)}${eol}`;
};

export const ensureEnvironmentIgnored = async (root: string): Promise<void> => {
  const gitignorePath = path.join(root, ".gitignore");
  let source = "";
  if (fsSync.existsSync(gitignorePath)) {
    source = await fs.readFile(gitignorePath, "utf8");
  }
  if (/^\.env\.local\s*$/m.test(source) || /^\.env\*\.local\s*$/m.test(source)) {
    return;
  }
  const separator = source && !source.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${source}${separator}.env.local\n`, "utf8");
};

export const writeSupabaseSkill = async (root: string, projectRef: string): Promise<string> => {
  const skillPath = getSupabaseSkillPath(root, projectRef);
  const mcpName = getSupabaseMcpName(projectRef);
  const content = `---
name: neko-supabase-${projectRef}
description: Use when any task involves Supabase, PostgreSQL, database schema, migrations, RLS, Auth, Storage, Realtime, Edge Functions, SQL, tables, indexes, triggers or performance in this project.
---

# Supabase project

This folder is connected to Supabase project \`${projectRef}\` through MCP server \`${mcpName}\`.

- Use the Supabase MCP tools automatically for database and platform operations.
- Inspect existing tables and migrations before changing the schema.
- Prefer named migrations for DDL changes so schema history remains auditable.
- Always enable and review Row Level Security (RLS) for application tables.
- Never request or write a secret key, service_role key, database password or access token into the project.
- Ask the user for explicit confirmation before DROP, TRUNCATE, destructive ALTER, mass DELETE/UPDATE, branch reset or any irreversible operation.
- Ask before deleting, resetting, merging or rebasing a database branch.
- After changes, check security and performance advisors when relevant.
`;
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content, "utf8");
  return skillPath;
};

export const removeSupabaseSkill = async (root: string, projectRef: string): Promise<void> => {
  const skillPath = getSupabaseSkillPath(root, projectRef);
  try {
    await fs.rm(path.dirname(skillPath), { recursive: true, force: true });
  } catch {}
};

export const findOpenCodeConfig = (root: string): string => {
  const candidates = [
    path.join(root, "opencode.json"),
    path.join(root, "opencode.jsonc"),
    path.join(root, ".opencode", "opencode.json"),
    path.join(root, ".opencode", "opencode.jsonc"),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return path.join(root, "opencode.json");
};

export const writeSupabaseOpenCodeConfig = async (root: string, projectRef: string): Promise<string> => {
  const configPath = findOpenCodeConfig(root);
  let config: Record<string, any> = {};
  if (fsSync.existsSync(configPath)) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
      config = JSON.parse(cleaned);
    } catch {
      config = {};
    }
  }

  const mcpName = getSupabaseMcpName(projectRef);
  const mcpUrl = getSupabaseMcpUrl(projectRef);

  if (!config.mcp || typeof config.mcp !== "object") {
    config.mcp = {};
  }
  config.mcp[mcpName] = {
    type: "remote",
    url: mcpUrl,
    enabled: true,
    timeout: 30000,
  };

  if (!config.permission || typeof config.permission !== "object") {
    config.permission = {};
  }
  config.permission[`${mcpName}_*`] = "ask";

  const readTools = [
    "list_tables",
    "list_extensions",
    "list_migrations",
    "get_logs",
    "get_advisors",
    "get_project_url",
    "get_publishable_keys",
    "generate_typescript_types",
    "list_edge_functions",
    "get_edge_function",
    "search_docs",
    "list_branches",
    "get_storage_config",
  ];
  for (const tool of readTools) {
    config.permission[`${mcpName}_${tool}`] = "allow";
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
};

export const removeSupabaseOpenCodeConfig = async (root: string, projectRef: string): Promise<void> => {
  const configPath = findOpenCodeConfig(root);
  if (!fsSync.existsSync(configPath)) return;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
    const config = JSON.parse(cleaned);
    const mcpName = getSupabaseMcpName(projectRef);
    if (config.mcp && config.mcp[mcpName]) {
      delete config.mcp[mcpName];
    }
    if (config.permission) {
      for (const key of Object.keys(config.permission)) {
        if (key.startsWith(`${mcpName}_`)) {
          delete config.permission[key];
        }
      }
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch {}
};

export const writeSupabaseVsCodeMcpConfig = async (root: string, projectRef: string): Promise<string> => {
  const vsCodePath = path.join(root, ".vscode", "mcp.json");
  let config: Record<string, any> = {};
  if (fsSync.existsSync(vsCodePath)) {
    try {
      const raw = await fs.readFile(vsCodePath, "utf8");
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
      config = JSON.parse(cleaned);
    } catch {
      config = {};
    }
  }

  const mcpName = getSupabaseMcpName(projectRef);
  const mcpUrl = getSupabaseMcpUrl(projectRef);

  if (!config.servers || typeof config.servers !== "object") {
    config.servers = {};
  }
  config.servers[mcpName] = {
    type: "http",
    url: mcpUrl,
  };

  await fs.mkdir(path.dirname(vsCodePath), { recursive: true });
  await fs.writeFile(vsCodePath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return vsCodePath;
};

export const removeSupabaseVsCodeMcpConfig = async (root: string, projectRef: string): Promise<void> => {
  const vsCodePath = path.join(root, ".vscode", "mcp.json");
  if (!fsSync.existsSync(vsCodePath)) return;
  try {
    const raw = await fs.readFile(vsCodePath, "utf8");
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "");
    const config = JSON.parse(cleaned);
    const mcpName = getSupabaseMcpName(projectRef);
    if (config.servers && config.servers[mcpName]) {
      delete config.servers[mcpName];
      await fs.writeFile(vsCodePath, JSON.stringify(config, null, 2) + "\n", "utf8");
    }
  } catch {}
};

export const writeSupabaseAntigravityMcpConfig = async (projectRef: string): Promise<string[]> => {
  const mcpName = getSupabaseMcpName(projectRef);
  const mcpUrl = getSupabaseMcpUrl(projectRef);
  const geminiDir = path.join(os.homedir(), ".gemini");
  const variants = ["antigravity-ide", "antigravity"];
  const written: string[] = [];

  for (const variant of variants) {
    const dir = path.join(geminiDir, variant);
    if (!fsSync.existsSync(dir)) continue;
    const configPath = path.join(dir, "mcp_config.json");
    let config: Record<string, any> = {};
    if (fsSync.existsSync(configPath)) {
      try {
        const raw = await fs.readFile(configPath, "utf8");
        config = JSON.parse(raw);
      } catch {
        config = {};
      }
    }
    const servers = { ...(config.mcpServers || {}) };
    servers[mcpName] = { serverUrl: mcpUrl };
    config.mcpServers = servers;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    written.push(configPath);
  }
  return written;
};

export const removeSupabaseAntigravityMcpConfig = async (projectRef: string): Promise<void> => {
  const mcpName = getSupabaseMcpName(projectRef);
  const geminiDir = path.join(os.homedir(), ".gemini");
  const variants = ["antigravity-ide", "antigravity"];

  for (const variant of variants) {
    const configPath = path.join(geminiDir, variant, "mcp_config.json");
    if (!fsSync.existsSync(configPath)) continue;
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(raw);
      if (config.mcpServers && config.mcpServers[mcpName]) {
        delete config.mcpServers[mcpName];
        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      }
    } catch {}
  }
};

const PROJECT_SNAPSHOT_FILES = [
  ".env.local",
  ".gitignore",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "opencode.json",
  path.join(".opencode", "opencode.json"),
  path.join(".vscode", "mcp.json"),
];

export const createProjectFileRollback = async (
  roots: (string | null | undefined)[]
): Promise<() => Promise<void>> => {
  const validRoots = roots.filter(Boolean) as string[];
  const targetPaths = [
    ...new Set(
      validRoots.flatMap((root) =>
        PROJECT_SNAPSHOT_FILES.map((file) => path.join(root, file))
      )
    ),
  ];

  const snapshots = new Map<string, Buffer | null>();
  for (const targetPath of targetPaths) {
    if (fsSync.existsSync(targetPath)) {
      snapshots.set(targetPath, await fs.readFile(targetPath));
    } else {
      snapshots.set(targetPath, null);
    }
  }

  return async () => {
    for (const [targetPath, content] of snapshots) {
      try {
        if (content === null) {
          if (fsSync.existsSync(targetPath)) {
            await fs.rm(targetPath, { force: true });
          }
        } else {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, content);
        }
      } catch (err) {
        console.warn(`[Neko/Supabase] Falha ao restaurar ${targetPath}:`, err);
      }
    }
  };
};

export const installSupabasePackage = async (
  root: string,
  packageManager: string = "npm",
  log?: (msg: string) => void
): Promise<boolean> => {
  const packagePath = path.join(root, "package.json");
  if (!fsSync.existsSync(packagePath)) return false;

  let pkg: any;
  try {
    pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  } catch {
    return false;
  }

  if (
    pkg.dependencies?.["@supabase/supabase-js"] ||
    pkg.devDependencies?.["@supabase/supabase-js"]
  ) {
    log?.("SDK @supabase/supabase-js já configurado no package.json.");
    return false;
  }

  const { command: managerName, executable } = await resolvePackageManager(packageManager);
  const action = managerName === "npm" ? "install" : "add";
  const args = [action, "@supabase/supabase-js"];
  const invocation = getSpawnInvocation(executable, args);

  console.log(
    `[Neko/PackageManager] spawn executable=${invocation.command} args=${JSON.stringify(args)} cwd=${root} platform=${process.platform}`
  );
  log?.(`Instalando @supabase/supabase-js com ${managerName}...`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        ...invocation.options,
        cwd: root,
        env: { ...process.env, NO_COLOR: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (spawnErr: any) {
      console.error(`[Neko/PackageManager] spawn failed:`, spawnErr);
      return reject(
        new Error(`Não foi possível iniciar o gerenciador de pacotes (${managerName}): ${spawnErr?.message || spawnErr}`)
      );
    }

    child.stdout?.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      if (line) log?.(line);
    });

    child.stderr?.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      if (line) log?.(line);
    });

    child.once("error", (err: any) => {
      console.error(`[Neko/PackageManager] Process error:`, err);
      if (err?.code === "ENOENT") {
        reject(new Error(`Gerenciador de pacotes (${managerName}) não encontrado no sistema.`));
      } else if (err?.code === "EINVAL") {
        reject(new Error(`Erro nos argumentos do gerenciador de pacotes (${managerName}).`));
      } else if (err?.code === "EACCES") {
        reject(new Error(`Permissão negada ao executar o gerenciador de pacotes (${managerName}).`));
      } else {
        reject(new Error(err?.message || `Falha no processo do gerenciador de pacotes (${managerName}).`));
      }
    });

    child.once("close", (code) => {
      if (code === 0) {
        log?.("SDK @supabase/supabase-js instalado com sucesso.");
        resolve(true);
      } else {
        reject(new Error(`A instalação do SDK Supabase terminou com código ${code}.`));
      }
    });
  });
};

export const configureSupabaseProject = async (
  options: SupabaseConfigureOptions
): Promise<{
  pendingRuntimeSetup: boolean;
  openCodeConfigPath: string;
  environmentPath: string | null;
  packageInstalled: boolean;
}> => {
  const openCodeConfigPath = await writeSupabaseOpenCodeConfig(
    options.selectedRoot,
    options.connection.ref
  );
  await writeSupabaseSkill(options.selectedRoot, options.connection.ref);
  await writeSupabaseVsCodeMcpConfig(options.selectedRoot, options.connection.ref);
  await writeSupabaseAntigravityMcpConfig(options.connection.ref).catch(() => []);

  const runtimeRoot = options.projectRoot || options.selectedRoot;
  const packagePath = path.join(runtimeRoot, "package.json");

  if (!fsSync.existsSync(packagePath)) {
    return {
      pendingRuntimeSetup: true,
      openCodeConfigPath,
      environmentPath: null,
      packageInstalled: false,
    };
  }

  const names = getSupabaseEnvironmentNames(options.framework);
  const environmentPath = path.join(runtimeRoot, ".env.local");
  let source = "";
  if (fsSync.existsSync(environmentPath)) {
    source = await fs.readFile(environmentPath, "utf8");
  }

  const updatedEnv = mergeEnvironmentValues(source, {
    [names.url]: options.connection.url,
    [names.publishableKey]: options.connection.publishableKey,
  });

  await fs.writeFile(environmentPath, updatedEnv, "utf8");
  await ensureEnvironmentIgnored(runtimeRoot);

  let packageInstalled = false;
  try {
    packageInstalled = await installSupabasePackage(
      runtimeRoot,
      options.packageManager || "npm",
      options.log
    );
  } catch (err) {
    throw err;
  }

  return {
    pendingRuntimeSetup: false,
    openCodeConfigPath,
    environmentPath,
    packageInstalled,
  };
};

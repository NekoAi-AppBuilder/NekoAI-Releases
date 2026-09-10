// src/main/recent-projects-manager.ts
// Gerenciamento e persistência universal de Projetos Recentes no NekoAI.
// Agnóstico de linguagem, framework e ferramentas de build.

import electron from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";

export interface RecentProjectItem {
  path: string;
  name: string;
  lastOpenedAt: number;
  lastEdited?: number;
  favorite?: boolean;
  thumbnail?: string | null;
  thumbnailPath?: string | null;
  thumbnailUpdatedAt?: number;
  previewUrl?: string | null;
  technology?: string;
  missing?: boolean;
}

export const MAX_RECENT_PROJECTS = 20;

function getUserDataDir(): string {
  try {
    const appInstance = (electron as any)?.app || (electron as any)?.default?.app;
    if (appInstance && typeof appInstance.getPath === "function") {
      return appInstance.getPath("userData");
    }
  } catch {}
  return process.env.NEKO_USER_DATA || path.join(os.homedir(), ".nekoai");
}

export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath) return "";
  let resolved = path.resolve(String(projectPath).trim());
  if (resolved.length > 3 && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.replace(/[/\\]+$/, "");
  }
  return resolved;
}

export function areProjectPathsEqual(a: string, b: string): boolean {
  const normA = normalizeProjectPath(a);
  const normB = normalizeProjectPath(b);
  if (!normA || !normB) return false;
  if (process.platform === "win32") {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

export function extractFriendlyProjectName(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return "Projeto";
  const base = path.basename(normalized);
  return base || normalized;
}

export async function checkProjectExistsOnDisk(projectPath: string): Promise<boolean> {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return false;
  try {
    const stat = await fs.stat(normalized);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detecção universal e rápida da tecnologia predominante no diretório do projeto.
 * Não bloqueia e sempre retorna uma string legível (fallback: "Projeto").
 */
export async function detectProjectTechnology(projectPath: string): Promise<string> {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return "Projeto";

  try {
    const entries = await fs.readdir(normalized, { withFileTypes: true }).catch(() => []);
    const fileNames = new Set(entries.map(e => e.name.toLowerCase()));

    // 1. Ecossistema Node.js / JavaScript / TypeScript
    if (fileNames.has("package.json")) {
      try {
        const pkgRaw = await fs.readFile(path.join(normalized, "package.json"), "utf8");
        const pkg = JSON.parse(pkgRaw);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        if (deps.next) return "Next.js";
        if (deps.react && deps.vite) return "React + Vite";
        if (deps.react) return "React";
        if (deps.nuxt) return "Nuxt";
        if (deps.vue && deps.vite) return "Vue + Vite";
        if (deps.vue) return "Vue";
        if (deps.svelte || deps["@sveltejs/kit"]) return "Svelte";
        if (deps["@angular/core"]) return "Angular";
        if (deps.astro) return "Astro";
        if (deps.remix || deps["@remix-run/react"]) return "Remix";
        if (deps.express) return "Node.js / Express";
        if (deps.fastify) return "Node.js / Fastify";
        if (deps.nestjs || deps["@nestjs/core"]) return "NestJS";
        if (deps.electron) return "Electron";
        return "Node.js";
      } catch {
        return "Node.js";
      }
    }

    // 2. Python
    const hasPythonFiles = Array.from(fileNames).some(f => f.endsWith(".py"));
    if (fileNames.has("requirements.txt") || fileNames.has("pyproject.toml") || fileNames.has("pipfile") || fileNames.has("setup.py") || hasPythonFiles) {
      let pyContent = "";
      if (fileNames.has("requirements.txt")) {
        try { pyContent += await fs.readFile(path.join(normalized, "requirements.txt"), "utf8"); } catch {}
      }
      if (fileNames.has("pyproject.toml")) {
        try { pyContent += await fs.readFile(path.join(normalized, "pyproject.toml"), "utf8"); } catch {}
      }
      const lowerPy = pyContent.toLowerCase();

      if (lowerPy.includes("fastapi")) return "Python / FastAPI";
      if (lowerPy.includes("django") || fileNames.has("manage.py")) return "Python / Django";
      if (lowerPy.includes("flask")) return "Python / Flask";
      return "Python";
    }

    // 3. PHP
    if (fileNames.has("artisan") || fileNames.has("composer.json") || fileNames.has("index.php") || Array.from(fileNames).some(f => f.endsWith(".php"))) {
      if (fileNames.has("artisan")) return "PHP / Laravel";
      if (fileNames.has("composer.json")) {
        try {
          const compRaw = await fs.readFile(path.join(normalized, "composer.json"), "utf8");
          if (compRaw.toLowerCase().includes("laravel/framework")) return "PHP / Laravel";
        } catch {}
      }
      return "PHP";
    }

    // 4. Java / Kotlin / Spring
    if (fileNames.has("pom.xml") || fileNames.has("build.gradle") || fileNames.has("build.gradle.kts") || Array.from(fileNames).some(f => f.endsWith(".java") || f.endsWith(".kt"))) {
      let buildContent = "";
      if (fileNames.has("pom.xml")) {
        try { buildContent += await fs.readFile(path.join(normalized, "pom.xml"), "utf8"); } catch {}
      }
      if (fileNames.has("build.gradle")) {
        try { buildContent += await fs.readFile(path.join(normalized, "build.gradle"), "utf8"); } catch {}
      }
      if (buildContent.toLowerCase().includes("spring-boot") || buildContent.toLowerCase().includes("springframework")) {
        return "Java / Spring";
      }
      return "Java";
    }

    // 5. C# / .NET
    if (Array.from(fileNames).some(f => f.endsWith(".csproj") || f.endsWith(".sln") || f.endsWith(".cs"))) {
      return "C# / .NET";
    }

    // 6. Go
    if (fileNames.has("go.mod") || fileNames.has("main.go") || Array.from(fileNames).some(f => f.endsWith(".go"))) {
      return "Go";
    }

    // 7. Rust
    if (fileNames.has("cargo.toml") || Array.from(fileNames).some(f => f.endsWith(".rs"))) {
      return "Rust";
    }

    // 8. Ruby / Rails
    if (fileNames.has("gemfile") || fileNames.has("config.ru") || Array.from(fileNames).some(f => f.endsWith(".rb"))) {
      if (fileNames.has("gemfile")) {
        try {
          const gemRaw = await fs.readFile(path.join(normalized, "gemfile"), "utf8");
          if (gemRaw.toLowerCase().includes("rails")) return "Ruby / Rails";
        } catch {}
      }
      return "Ruby";
    }

    // 9. HTML puro / estático
    if (fileNames.has("index.html") || Array.from(fileNames).some(f => f.endsWith(".html"))) {
      return "HTML / CSS / JavaScript";
    }

    return "Projeto";
  } catch {
    return "Projeto";
  }
}

export class RecentProjectsManager {
  private customStoragePath: string | null = null;
  private cache: RecentProjectItem[] | null = null;

  constructor(customStoragePath?: string) {
    if (customStoragePath) {
      this.customStoragePath = customStoragePath;
    }
  }

  public getStorageFilePath(): string {
    if (this.customStoragePath) return this.customStoragePath;
    return path.join(getUserDataDir(), "recent-projects.json");
  }

  public async getRecentProjects(): Promise<RecentProjectItem[]> {
    if (this.cache) {
      return [...this.cache];
    }

    const filePath = this.getStorageFilePath();
    try {
      if (!fsSync.existsSync(filePath)) {
        this.cache = [];
        return [];
      }
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const cleaned: RecentProjectItem[] = [];
        for (const item of parsed) {
          if (!item || typeof item.path !== "string") continue;
          const norm = normalizeProjectPath(item.path);
          if (!norm) continue;
          cleaned.push({
            path: norm,
            name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : extractFriendlyProjectName(norm),
            lastOpenedAt: Number(item.lastOpenedAt || item.lastOpened || item.lastEdited || Date.now()),
            lastEdited: item.lastEdited ? Number(item.lastEdited) : undefined,
            favorite: Boolean(item.favorite),
            thumbnail: typeof item.thumbnail === "string" ? item.thumbnail : null,
            thumbnailPath: typeof item.thumbnailPath === "string" ? item.thumbnailPath : null,
            thumbnailUpdatedAt: item.thumbnailUpdatedAt ? Number(item.thumbnailUpdatedAt) : undefined,
            previewUrl: typeof item.previewUrl === "string" ? item.previewUrl : null,
            technology: typeof item.technology === "string" ? item.technology : undefined
          });
        }
        this.cache = this.sortAndDeduplicate(cleaned);
        return [...this.cache];
      }
      this.cache = [];
      return [];
    } catch {
      this.cache = [];
      return [];
    }
  }

  public async touchRecentProject(
    projectPath: string,
    options?: {
      lastEdited?: number;
      favorite?: boolean;
      thumbnail?: string | null;
      thumbnailPath?: string | null;
      thumbnailUpdatedAt?: number;
      previewUrl?: string | null;
      technology?: string;
    }
  ): Promise<RecentProjectItem[]> {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) return this.getRecentProjects();

    const currentList = await this.getRecentProjects();
    const existingIndex = currentList.findIndex(p => areProjectPathsEqual(p.path, normalized));

    const now = Date.now();
    let technology = options?.technology;
    if (!technology) {
      technology = await detectProjectTechnology(normalized);
    }

    let itemToPlace: RecentProjectItem;

    if (existingIndex >= 0) {
      const existing = currentList[existingIndex];
      itemToPlace = {
        ...existing,
        path: normalized,
        name: existing.name || extractFriendlyProjectName(normalized),
        lastOpenedAt: now,
        lastEdited: options?.lastEdited ?? existing.lastEdited ?? now,
        favorite: options?.favorite !== undefined ? options?.favorite : existing.favorite,
        thumbnail: options?.thumbnail !== undefined ? options?.thumbnail : existing.thumbnail,
        thumbnailPath: options?.thumbnailPath !== undefined ? options?.thumbnailPath : existing.thumbnailPath,
        thumbnailUpdatedAt: options?.thumbnailUpdatedAt !== undefined ? options?.thumbnailUpdatedAt : existing.thumbnailUpdatedAt,
        previewUrl: options?.previewUrl !== undefined ? options?.previewUrl : existing.previewUrl,
        technology: technology || existing.technology || "Projeto",
        missing: false
      };
      // Remove previous position
      currentList.splice(existingIndex, 1);
    } else {
      itemToPlace = {
        path: normalized,
        name: extractFriendlyProjectName(normalized),
        lastOpenedAt: now,
        lastEdited: options?.lastEdited ?? now,
        favorite: options?.favorite ?? false,
        thumbnail: options?.thumbnail ?? null,
        thumbnailPath: options?.thumbnailPath ?? null,
        thumbnailUpdatedAt: options?.thumbnailUpdatedAt,
        previewUrl: options?.previewUrl ?? null,
        technology: technology || "Projeto",
        missing: false
      };
    }

    // Place at the top of the list
    currentList.unshift(itemToPlace);

    const pruned = this.pruneList(currentList);
    this.cache = pruned;
    await this.persist(pruned);
    return [...pruned];
  }

  public async updateProjectThumbnail(
    projectPath: string,
    metadata: {
      thumbnail: string | null;
      thumbnailPath?: string | null;
      thumbnailUpdatedAt?: number;
      previewUrl?: string | null;
    }
  ): Promise<RecentProjectItem[]> {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) return this.getRecentProjects();

    const currentList = await this.getRecentProjects();
    const target = currentList.find(p => areProjectPathsEqual(p.path, normalized));
    if (target) {
      target.thumbnail = metadata.thumbnail;
      if (metadata.thumbnailPath !== undefined) target.thumbnailPath = metadata.thumbnailPath;
      if (metadata.thumbnailUpdatedAt !== undefined) target.thumbnailUpdatedAt = metadata.thumbnailUpdatedAt;
      if (metadata.previewUrl !== undefined) target.previewUrl = metadata.previewUrl;

      this.cache = [...currentList];
      await this.persist(this.cache);
    }
    return [...(this.cache || currentList)];
  }

  public async removeRecentProject(projectPath: string): Promise<RecentProjectItem[]> {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) return this.getRecentProjects();

    const currentList = await this.getRecentProjects();
    const filtered = currentList.filter(p => !areProjectPathsEqual(p.path, normalized));

    this.cache = filtered;
    await this.persist(filtered);
    return [...filtered];
  }

  public async toggleFavoriteProject(projectPath: string): Promise<RecentProjectItem[]> {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) return this.getRecentProjects();

    const currentList = await this.getRecentProjects();
    const target = currentList.find(p => areProjectPathsEqual(p.path, normalized));
    if (target) {
      target.favorite = !target.favorite;
      this.cache = [...currentList];
      await this.persist(this.cache);
    }
    return [...(this.cache || currentList)];
  }

  public async saveRecentProjects(projects: RecentProjectItem[]): Promise<RecentProjectItem[]> {
    const cleaned = this.sortAndDeduplicate(projects);
    const pruned = this.pruneList(cleaned);
    this.cache = pruned;
    await this.persist(pruned);
    return [...pruned];
  }

  /**
   * Verifica a integridade em disco dos projetos na lista e reconcilia o estado da miniatura real.
   * Não altera a persistência, apenas adiciona `missing: true` se a pasta foi removida e
   * sincroniza a miniatura local (.neko/thumbnail.png) caso exista no disco.
   */
  public async getRecentProjectsWithStatus(): Promise<RecentProjectItem[]> {
    const list = await this.getRecentProjects();
    const enriched: RecentProjectItem[] = [];
    let cacheChanged = false;

    for (const item of list) {
      const exists = await checkProjectExistsOnDisk(item.path);
      let tech = item.technology;
      if (exists && (!tech || tech === "Unknown")) {
        tech = await detectProjectTechnology(item.path);
      }

      let thumbnail = item.thumbnail;
      let thumbnailPath = item.thumbnailPath;
      let thumbnailUpdatedAt = item.thumbnailUpdatedAt;
      let lastEdited = item.lastEdited;

      if (exists) {
        // 1. Sincroniza mtime do disco para lastEdited se disponível
        try {
          const folderStat = await fs.stat(item.path);
          if (!lastEdited || folderStat.mtimeMs > lastEdited) {
            lastEdited = Math.round(folderStat.mtimeMs);
          }
        } catch {}

        // 2. Reconciliação inteligente da thumbnail em disco (.neko/thumbnail.png)
        const diskThumbPath = path.join(item.path, ".neko", "thumbnail.png");
        try {
          const thumbStat = await fs.stat(diskThumbPath);
          if (thumbStat.isFile() && thumbStat.size > 0) {
            const diskMtime = Math.round(thumbStat.mtimeMs);
            if (!thumbnail || !thumbnailUpdatedAt || diskMtime > thumbnailUpdatedAt) {
              const buffer = await fs.readFile(diskThumbPath);
              thumbnail = `data:image/png;base64,${buffer.toString("base64")}`;
              thumbnailPath = diskThumbPath;
              thumbnailUpdatedAt = diskMtime;

              // Atualiza o item no cache em memória
              item.thumbnail = thumbnail;
              item.thumbnailPath = thumbnailPath;
              item.thumbnailUpdatedAt = thumbnailUpdatedAt;
              cacheChanged = true;
            }
          }
        } catch {
          // Arquivo de thumbnail em disco não existe
          if (thumbnailPath && thumbnailPath.toLowerCase().includes(".neko")) {
            thumbnail = null;
            thumbnailPath = null;
            thumbnailUpdatedAt = undefined;
            item.thumbnail = null;
            item.thumbnailPath = null;
            item.thumbnailUpdatedAt = undefined;
            cacheChanged = true;
          }
        }
      }

      enriched.push({
        ...item,
        lastEdited,
        thumbnail,
        thumbnailPath,
        thumbnailUpdatedAt,
        missing: !exists,
        technology: tech || "Projeto"
      });
    }

    if (cacheChanged) {
      await this.persist(this.cache || list);
    }

    return enriched;
  }

  private pruneList(list: RecentProjectItem[]): RecentProjectItem[] {
    // Favoritos nunca são removidos automaticamente pelo limite
    const favorites = list.filter(p => p.favorite);
    const nonFavorites = list.filter(p => !p.favorite);

    const allowedNonFavorites = nonFavorites.slice(0, MAX_RECENT_PROJECTS);
    const combined = [...favorites, ...allowedNonFavorites];

    return this.sortAndDeduplicate(combined);
  }

  private sortAndDeduplicate(list: RecentProjectItem[]): RecentProjectItem[] {
    const seen = new Set<string>();
    const unique: RecentProjectItem[] = [];

    // Prioriza ordenamento por data de último acesso descrescente
    const sorted = [...list].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));

    for (const item of sorted) {
      const key = process.platform === "win32" ? item.path.toLowerCase() : item.path;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }

    return unique;
  }

  private async persist(list: RecentProjectItem[]): Promise<void> {
    const filePath = this.getStorageFilePath();
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const payload = JSON.stringify(list, null, 2);
      await fs.writeFile(filePath, payload, "utf8");
    } catch (err) {
      console.warn("[Neko/RecentProjects] Erro ao persistir projetos recentes:", err);
    }
  }
}

export const recentProjectsManager = new RecentProjectsManager();

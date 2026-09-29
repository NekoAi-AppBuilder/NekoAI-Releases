// ============================================================
// PREVIEW ROUTE DISCOVERY (main process)
// ------------------------------------------------------------
// Discovers the REAL pages/routes of a project through bounded static
// analysis. Never runs arbitrary project code, never executes scripts and
// never returns file contents — only derived route paths + friendly labels.
// Prefers showing FEWER correct pages over many false ones.
// ============================================================

import fs from "node:fs";
import path from "node:path";

export type PreviewRoute = { path: string; label: string };

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".nuxt", ".svelte-kit", ".vercel", ".netlify",
  "dist", "build", ".vite", ".cache", "coverage", ".output", ".astro", "out", "storybook-static",
  ".neko", ".parcel", "vendor", "public"
]);

const NON_PAGE_DIR_NAMES = new Set([
  "components", "layouts", "lib", "services", "mocks", "hooks", "utils",
  "store", "types", "styles", "assets", "api", "helpers", "middleware",
  "queries", "mutations", "context", "contexts", "providers"
]);

const SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".mjs", ".cjs"]);
const ROUTE_FILE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro"]);
const MAX_FILES_SCANNED = 900;
const MAX_FILE_BYTES = 200_000;
const MAX_TREE_DEPTH = 9;

// React Router / TanStack / generic config-style route objects.
const ROUTER_INDICATORS = [
  "createBrowserRouter", "createHashRouter", "createRoutesFromElements",
  "RouterProvider", "react-router", "<Routes>", "<Route", "useRoutes",
  "@tanstack/react-router", "createFileRoute", "routes:", "routes =",
  "defineRoutes", "route("
];

// --- pure helpers (unit-testable, no fs) --------------------

// Strips query/hash and normalizes to a clean "/..." path.
export function normalizeRoutePath(value: string | undefined | null): string {
  let raw = String(value ?? "").trim();
  const hashIndex = raw.indexOf("#");
  if (hashIndex >= 0) raw = raw.slice(0, hashIndex);
  const queryIndex = raw.indexOf("?");
  if (queryIndex >= 0) raw = raw.slice(0, queryIndex);
  if (raw.startsWith(".")) raw = raw.replace(/^\.+/, "");
  if (!raw.startsWith("/")) raw = "/" + raw;
  raw = raw.replace(/\/+/g, "/");
  if (raw.length > 1) raw = raw.replace(/\/+$/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  return raw === "" ? "/" : raw;
}

function titleCase(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// "/dashboard" -> "Dashboard"; "/meus-produtos" -> "Meus Produtos";
// "/admin/users" -> "Admin / Users"; dynamic segments are kept readable.
export function routeLabelFromPath(inputPath: string): string {
  const normalized = normalizeRoutePath(inputPath);
  if (normalized === "/") return "Home";
  const segments = normalized.split("/").filter(Boolean);
  const labels = segments.map(segment => {
    let seg = segment.replace(/\.html$/i, "");
    const dynamic = seg.startsWith(":") || /^\[.*\]$/.test(seg) || seg.startsWith("$");
    seg = seg.replace(/^[:$]+/, "").replace(/^\[|\]$/g, "").replace(/_/g, " ");
    if (!seg) return dynamic ? "Detalhe" : "";
    const words = seg.split("-").filter(Boolean).map(w => titleCase(w));
    let label = words.join(" ");
    if (!label.trim() && dynamic) label = "Detalhe";
    return label || titleCase(seg);
  }).filter(Boolean);
  return labels.join(" / ");
}

export function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(":") || /^\[.*\]$/.test(segment) || segment.startsWith("$");
}

function isLikelyApiOrPrivate(pathValue: string): boolean {
  const p = pathValue.toLowerCase();
  if (p.startsWith("/api") || p.startsWith("/_") || p === "/*" || p.includes("*")) return true;
  if (/\.(json|xml|ico|png|jpg|webp|svg|css|js|map)$/.test(p)) return true;
  return false;
}

// --- fs-backed discovery -------------------------------------

async function pathExists(file: string): Promise<boolean> {
  try { await fs.promises.access(file); return true; } catch { return false; }
}

async function readTextSafe(file: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const content = await fs.promises.readFile(file, "utf8");
    return content.length > MAX_FILE_BYTES ? null : content;
  } catch {
    return null;
  }
}

type WalkResult = { files: string[]; allText: string };

async function walkSource(root: string, relative = "", state: WalkResult, depth: number): Promise<void> {
  if (state.files.length >= MAX_FILES_SCANNED || depth > MAX_TREE_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.files.length >= MAX_FILES_SCANNED) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(relative, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      // Descend into non-skipped source directories
      if (!isIgnoredSourceDir(entry.name)) {
        await walkSource(root, rel, state, depth + 1);
      }
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;
    const abs = path.join(root, rel);
    if (state.files.includes(rel)) continue;
    state.files.push(rel);
    const text = await readTextSafe(abs);
    if (text) state.allText += "\n" + text;
  }
}

function isIgnoredSourceDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

async function readPackageJson(root: string): Promise<Record<string, any> | null> {
  const raw = await readTextSafe(path.join(root, "package.json"));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function depsString(pkg: Record<string, any>): string {
  return JSON.stringify({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
}

// Convert a directory/file-based router file path into a URL route.
function routeFromFilePath(relPath: string, rootSegments: string[], hasLayout: boolean): string | null {
  const segments = relPath.split("/").filter(Boolean);
  const rootLen = rootSegments.length;
  const body = segments.slice(rootLen);
  const file = body.length ? body[body.length - 1] : "";
  const rest = body.slice(0, body.length - 1);

  // Anti-false-positive: ignore test, story, type declaration and auxiliary files
  const fileLower = file.toLowerCase();
  if (
    fileLower.includes(".test.") || fileLower.includes(".spec.") ||
    fileLower.includes(".stories.") || fileLower.endsWith(".d.ts")
  ) {
    return null;
  }

  // Ignore internal components/layouts/helpers directories inside pages
  for (const part of rest) {
    const partLower = part.toLowerCase();
    if (NON_PAGE_DIR_NAMES.has(partLower) || partLower.startsWith("_")) {
      return null;
    }
  }

  const isIndex = fileLower === "index" || fileLower === "index.page" ||
    /^index\./i.test(file) || /^\+page/i.test(file) || fileLower === "page";
  
  const isLayoutFile = /^layout/i.test(file) || /^\+layout/i.test(file) ||
    /^\+page\.server|\.load/i.test(file) || (/^_/i.test(file) && !/^_index/i.test(file)) ||
    /^error\./i.test(file) || /^loading\./i.test(file) || /^not-found\./i.test(file);
  if (isLayoutFile) return null;

  const routeSegments: string[] = [];
  for (const dir of rest) {
    if (dir.startsWith("(") && dir.endsWith(")")) continue; // route groups
    if (dir.toLowerCase() === "api" || dir.startsWith("_")) return null;
    routeSegments.push(normalizeSegment(dir));
  }
  if (!isIndex) {
    if (fileLower.startsWith("404") || fileLower.startsWith("500")) return null;
    routeSegments.push(normalizeSegment(file));
  }
  const routePath = "/" + routeSegments.join("/");
  return normalizeRoutePath(routePath);
}

function normalizeSegment(segment: string): string {
  let seg = segment.replace(/\.(jsx|js|tsx|ts|vue|svelte|astro|page|route)$/i, "");
  if (/^\$/.test(seg) || /^\[.*\]$/.test(seg)) return ":" + seg.replace(/^\[|\]$/g, "").replace(/^\$/, "").replace(/\.(page|route)$/i, "");
  if (/\.page$/i.test(seg)) seg = seg.replace(/\.page$/i, "");
  return seg.toLowerCase();
}

// --- nested JSX <Route> extraction ----------------------------

function joinRoutePath(parent: string | undefined, child: string | undefined): string {
  const prefix = parent && parent !== "/" ? parent : "";
  if (child === undefined || child === "" || child === "/" || child === "index") {
    return prefix || "/";
  }
  if (child.startsWith("/")) return normalizeRoutePath(child);
  return normalizeRoutePath(`${prefix}/${child}`);
}

function readTagProps(source: string, start: number): { end: number; selfClosed: boolean; props: Record<string, string> } {
  let i = start;
  const n = source.length;
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  let selfClosed = false;
  const props: Record<string, string> = {};
  let attrBlock = "";
  while (i < n) {
    const ch = source[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      attrBlock += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      attrBlock += ch;
      i++;
      continue;
    }
    if (ch === "'") { inSingle = true; attrBlock += ch; i++; continue; }
    if (ch === '"') { inDouble = true; attrBlock += ch; i++; continue; }
    if (ch === "<") { depth++; attrBlock += ch; i++; continue; }
    if (ch === ">") {
      if (depth === 0) { i++; break; }
      depth--;
      attrBlock += ch;
      i++;
      continue;
    }
    attrBlock += ch;
    i++;
  }
  const trimmed = attrBlock.trim();
  selfClosed = /\/$/.test(trimmed.replace(/\s+$/g, ""));
  const pathMatch = trimmed.match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{["']([^"'{}]*)["']\})/);
  if (pathMatch) {
    const value = pathMatch[1] ?? pathMatch[2] ?? pathMatch[3];
    props.path = value ?? "";
  }
  return { end: i, selfClosed, props };
}

export function extractJsxRoutePaths(text: string): string[] {
  const out: string[] = [];
  try {
    const stack: string[] = []; // resolved absolute prefixes
    let pos = 0;
    while (pos < text.length) {
      const openIdx = text.indexOf("<Route", pos);
      const closeIdx = text.indexOf("</Route>", pos);
      if (openIdx === -1 && closeIdx === -1) break;
      if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        if (stack.length > 1) stack.pop();
        pos = closeIdx + 8;
        continue;
      }
      if (openIdx === -1) break;
      const after = text[openIdx + 6];
      if (after && /[\w$]/.test(after)) { pos = openIdx + 6; continue; }
      const parsed = readTagProps(text, openIdx + 5);
      const rawPath = parsed.props.path;
      const parentPrefix = stack[stack.length - 1];
      const resolved = joinRoutePath(parentPrefix, rawPath);
      if (rawPath !== undefined && !/^(index|\*|404)$/.test(String(rawPath).trim())) {
        if (!isLikelyApiOrPrivate(resolved)) out.push(resolved);
      }
      if (!parsed.selfClosed) {
        stack.push(rawPath !== undefined && !rawPath.startsWith("/") && rawPath !== "" && rawPath !== "/" && rawPath !== "index"
          ? (parentPrefix && parentPrefix !== "/" ? `${parentPrefix}/${rawPath}` : `/${rawPath}`)
          : resolved);
      }
      pos = parsed.end;
    }
  } catch {}
  return out;
}

// --- Layer 1: Manifest Discovery -----------------------------

const MANIFEST_FILES = [
  "neko-pages.json", "src/neko-pages.json", ".neko/pages.json",
  "neko-pages.ts", "src/neko-pages.ts", "neko-pages.js", "src/neko-pages.js",
  "src/pages.json", "pages.json"
];

export async function extractManifestRoutes(projectRoot: string): Promise<PreviewRoute[]> {
  const routes: PreviewRoute[] = [];
  const seen = new Set<string>();

  for (const relFile of MANIFEST_FILES) {
    const absPath = path.join(projectRoot, relFile);
    const content = await readTextSafe(absPath);
    if (!content) continue;

    if (relFile.endsWith(".json")) {
      try {
        const parsed = JSON.parse(content);
        const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.pages) ? parsed.pages : Array.isArray(parsed.routes) ? parsed.routes : [];
        for (const item of items) {
          if (typeof item === "string") {
            const p = normalizeRoutePath(item);
            if (p && !seen.has(p)) {
              seen.add(p);
              routes.push({ path: p, label: routeLabelFromPath(p) });
            }
          } else if (item && typeof item === "object") {
            const p = normalizeRoutePath(item.path ?? item.route ?? item.url);
            if (p && !seen.has(p)) {
              seen.add(p);
              const customLabel = item.label ?? item.title ?? item.name;
              routes.push({ path: p, label: typeof customLabel === "string" && customLabel.trim() ? customLabel.trim() : routeLabelFromPath(p) });
            }
          }
        }
      } catch {}
    } else {
      // TS/JS static parsing: matches `{ ... path: "/...", label: "..." ... }` or array of routes
      const objPattern = /\{\s*(?:[^{}]*?\b(?:path|route|url)\s*:\s*["']([^"']+)["'])(?:[^{}]*?\b(?:label|title|name)\s*:\s*["']([^"']+)["'])?[^{}]*?\}/g;
      let m: RegExpExecArray | null;
      while ((m = objPattern.exec(content)) !== null) {
        const p = normalizeRoutePath(m[1]);
        if (p && !seen.has(p)) {
          seen.add(p);
          const customLabel = m[2];
          routes.push({ path: p, label: customLabel ? customLabel.trim() : routeLabelFromPath(p) });
        }
      }
      const altObjPattern = /\{\s*(?:[^{}]*?\b(?:label|title|name)\s*:\s*["']([^"']+)["'])(?:[^{}]*?\b(?:path|route|url)\s*:\s*["']([^"']+)["'])[^{}]*?\}/g;
      while ((m = altObjPattern.exec(content)) !== null) {
        const p = normalizeRoutePath(m[2]);
        if (p && !seen.has(p)) {
          seen.add(p);
          const customLabel = m[1];
          routes.push({ path: p, label: customLabel ? customLabel.trim() : routeLabelFromPath(p) });
        }
      }
    }
  }

  return routes;
}

// --- Layer 2: Explicit Router Configurations -----------------

export function extractConfigRoutePaths(text: string): string[] {
  const out: string[] = [];
  // Match path: "/foo" or path: "foo"
  const pathRegex = /(?:^|[,{\s])\s*path\s*:\s*(['"])([^'"\s,;})\]]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = pathRegex.exec(text)) !== null) {
    const raw = m[2];
    if (raw && !/^(index|\*|404)$/i.test(raw.trim())) {
      const normalized = normalizeRoutePath(raw);
      if (!isLikelyApiOrPrivate(normalized)) out.push(normalized);
    }
  }
  // TanStack createFileRoute('/foo')
  const tanstackRegex = /createFileRoute\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = tanstackRegex.exec(text)) !== null) {
    const raw = m[2];
    if (raw) {
      const normalized = normalizeRoutePath(raw);
      if (!isLikelyApiOrPrivate(normalized)) out.push(normalized);
    }
  }
  return out;
}

// --- Layer 3: Conventional Page Directories ------------------

async function listDirFilesRecursive(dir: string, rel = "", depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!NON_PAGE_DIR_NAMES.has(entry.name.toLowerCase())) {
        const children = await listDirFilesRecursive(dir, relPath, depth + 1);
        results.push(...children);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ROUTE_FILE_EXTS.has(ext)) {
        results.push(relPath.replaceAll("\\", "/"));
      }
    }
  }
  return results;
}

const CONVENTIONAL_PAGE_DIRS = [
  "src/pages", "pages", "src/routes", "routes",
  "src/views", "views", "src/screens", "screens",
  "src/app", "app"
];

// --- Layer 4: History-API / Manual Navigation Fallback -------

const PATHNAME_ROUTE_TOKENS = [
  "location.pathname", ".pathname", "pushState(", "replaceState(",
  "navigateTo(", "location.href", "location.assign", "location.replace"
];

export function extractManualRoutePaths(text: string): string[] {
  const out: string[] = [];
  if (!PATHNAME_ROUTE_TOKENS.some(tok => text.includes(tok))) return out;
  const lines = text.split(/\r?\n/);
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const windowLines: string[] = [];
    if (i > 0) windowLines.push(lines[i - 1]);
    windowLines.push(lines[i]);
    if (i + 1 < n) windowLines.push(lines[i + 1]);
    const windowText = windowLines.join("\n");
    if (!PATHNAME_ROUTE_TOKENS.some(tok => windowText.includes(tok))) continue;
    const literal = /["'](\/[A-Za-z0-9][A-Za-z0-9_\-/:.$\[\]{}]*?)["']/g;
    let m: RegExpExecArray | null;
    while ((m = literal.exec(windowText)) !== null) {
      const p = m[1];
      if (!p || p.length <= 1 || p.includes(" ") || /^\/\//.test(p)) continue;
      if (isLikelyApiOrPrivate(p)) continue;
      out.push(p);
    }
  }
  return out;
}

// --- Real Page Discovery (Multi-layered Union) ---------------

export async function discoverPreviewRoutes(projectRoot: string): Promise<PreviewRoute[]> {
  const routeMap = new Map<string, PreviewRoute>();

  function add(pathValue: string, customLabel?: string): void {
    const normalized = normalizeRoutePath(pathValue);
    if (!normalized || isLikelyApiOrPrivate(normalized)) return;
    if (normalized === "/") return; // Home handled separately
    if (!routeMap.has(normalized)) {
      routeMap.set(normalized, {
        path: normalized,
        label: customLabel && customLabel.trim() ? customLabel.trim() : routeLabelFromPath(normalized)
      });
    } else if (customLabel && customLabel.trim() && routeMap.get(normalized)?.label === routeLabelFromPath(normalized)) {
      // Upgrade auto-generated label with explicit custom label if available
      routeMap.set(normalized, { path: normalized, label: customLabel.trim() });
    }
  }

  // ============================================================
  // LAYER 1: Explicit Manifests (neko-pages.ts, .neko/pages.json, etc.)
  // ============================================================
  const manifestRoutes = await extractManifestRoutes(projectRoot);
  for (const r of manifestRoutes) {
    add(r.path, r.label);
  }

  // ============================================================
  // LAYER 2: Explicit Router Configurations (React Router / JSX / TanStack)
  // ============================================================
  const state: WalkResult = { files: [], allText: "" };
  await walkSource(projectRoot, "", state, 0);
  const routerPresent = ROUTER_INDICATORS.some(tok => state.allText.includes(tok));
  if (routerPresent) {
    for (const file of state.files) {
      const text = await readTextSafe(path.join(projectRoot, file));
      if (!text) continue;
      if (text.includes("<Route")) {
        for (const routePath of extractJsxRoutePaths(text)) add(routePath);
      }
      for (const routePath of extractConfigRoutePaths(text)) add(routePath);
    }
  }

  // ============================================================
  // LAYER 3: Conventional Page Directories (Agnostic to framework)
  // ============================================================
  for (const pageDir of CONVENTIONAL_PAGE_DIRS) {
    const absDir = path.join(projectRoot, pageDir);
    if (await pathExists(absDir)) {
      const files = await listDirFilesRecursive(absDir);
      for (const rel of files) {
        const route = routeFromFilePath(rel, [], pageDir.includes("app"));
        if (route) add(route);
      }
    }
  }

  // ============================================================
  // LAYER 4: History-API / Manual Pathname Navigation Fallback
  // ============================================================
  for (const file of state.files) {
    const text = await readTextSafe(path.join(projectRoot, file));
    if (!text) continue;
    for (const routePath of extractManualRoutePaths(text)) add(routePath);
  }

  // ============================================================
  // LAYER 5: Static HTML Files Fallback
  // ============================================================
  try {
    const scanHtmlDir = async (dir: string, relPrefix = "", depth = 0) => {
      if (depth > 2) return;
      let entries: import("node:fs").Dirent[] = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
          const lower = entry.name.toLowerCase();
          if (lower === "index.html" && !relPrefix) continue;
          const routeRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          add("/" + routeRel.replace(/\\/g, "/"));
        } else if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !NON_PAGE_DIR_NAMES.has(entry.name.toLowerCase())) {
            await scanHtmlDir(path.join(dir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name, depth + 1);
          }
        }
      }
    };
    await scanHtmlDir(projectRoot);
  } catch {}

  // Always show Home as the root.
  const result: PreviewRoute[] = [{ path: "/", label: "Home" }];
  const discovered = Array.from(routeMap.values());

  // Order: sort by segment depth ascending then lexically; keep Home first.
  const sorted = discovered.sort((a, b) => {
    const da = a.path.split("/").filter(Boolean).length;
    const db = b.path.split("/").filter(Boolean).length;
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  });

  for (const r of sorted) {
    if (r.path === "/" || result.some(x => x.path === r.path)) continue;
    if (result.length >= 100) break;
    result.push(r);
  }

  console.log(`[Preview Routes] discover projectPath=${projectRoot} count=${result.length}`);
  for (const r of result) {
    console.log(`[Preview Routes] route path=${r.path} label=${r.label}`);
  }
  return result;
}

// Reconstruct the current pathname (origin-independent) from a full URL.
export function routeFromUrl(url: string): string {
  try {
    return normalizeRoutePath(new URL(url).pathname);
  } catch {
    return normalizeRoutePath(url);
  }
}


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
const SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".mjs", ".cjs"]);
const ROUTE_FILE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro"]);
const MAX_FILES_SCANNED = 900;
const MAX_FILE_BYTES = 200_000;
const MAX_TREE_DEPTH = 9;

// React Router / TanStack / generic config-style route objects.
const ROUTER_INDICATORS = [
  "createBrowserRouter", "createHashRouter", "createRoutesFromElements",
  "RouterProvider", "react-router", "<Routes>", "<Route", "useRoutes",
  "@tanstack/react-router", "createFileRoute", "routes:"
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
      // Only descend into conventional source directories to avoid scanning
      // arbitrary deep folders (db dumps, assets, tests fixtures, etc.).
      if (isSourceDir(entry.name)) await walkSource(root, rel, state, depth + 1);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;
    if (!isSourceDir(path.dirname(rel).split("/")[0])) continue;
    const abs = path.join(root, rel);
    if (state.files.includes(rel)) continue;
    state.files.push(rel);
    const text = await readTextSafe(abs);
    if (text) state.allText += "\n" + text;
  }
}

function isSourceDir(name: string): boolean {
  return ["src", "app", "pages", "routes"].includes(name);
}

async function readPackageJson(root: string): Promise<Record<string, any> | null> {
  const raw = await readTextSafe(path.join(root, "package.json"));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function hasDependency(deps: Record<string, string> | undefined, name: string): boolean {
  if (!deps) return false;
  const needle = `"${name}"`;
  return Object.prototype.hasOwnProperty.call(deps, name) || needle === `"${name}"`;
}

function depsString(pkg: Record<string, any>): string {
  return JSON.stringify({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
}

// Convert a directory/file-based router file path into a URL route.
function routeFromFilePath(relPath: string, rootSegments: string[], hasLayout: boolean): string | null {
  const segments = relPath.split("/").filter(Boolean);
  // Remove the route-root dir prefix (already consumed by caller rootSegments).
  const rootLen = rootSegments.length;
  const body = segments.slice(rootLen);
  const file = body.length ? body[body.length - 1] : "";
  const rest = body.slice(0, body.length - 1);
  const isIndex = file === "index" || file.toLowerCase() === "index.page" ||
    /^index\./.test(file) || file.startsWith("index.") || /^\+page/.test(file);
  const isLayoutFile = hasLayout && (/^layout/.test(file) || /^\+layout/.test(file) || /^\+page\.server|\.load/.test(file) || /^_/.test(file));
  if (isLayoutFile) return null;
  const routeSegments: string[] = [];
  for (const dir of rest) {
    if (dir.startsWith("(") && dir.endsWith(")")) continue; // next route groups
    if (dir === "api" || dir.startsWith("_")) return null;
    routeSegments.push(normalizeSegment(dir));
  }
  if (!isIndex) {
    if (file === "404") return null;
    routeSegments.push(normalizeSegment(file));
  }
  const routePath = "/" + routeSegments.join("/");
  return normalizeRoutePath(routePath);
}

function normalizeSegment(segment: string): string {
  let seg = segment.replace(/\.(jsx|js|tsx|ts|vue|svelte|astro|page|route)$/i, "");
  if (/^\$/.test(seg) || /^\[.*\]$/.test(seg)) return ":" + seg.replace(/^\[|\]$/g, "").replace(/^\$/, "").replace(/\.(page|route)$/i, "");
  if (/\.page$/.test(seg)) seg = seg.replace(/\.page$/i, "");
  return seg;
}

// --- nested JSX <Route> extraction ----------------------------
// Real projects often declare routes as nested JSX:
//   <Route path="/admin" element={...}>
//     <Route index element={<Dashboard/>} />
//     <Route path="equipamentos" element={<Equipamentos/>} />
//     <Route path="equipamentos/:id" .../>
//   </Route>
// Children use RELATIVE paths resolved against the nearest absolute parent.
// This lightweight scanner walks the tag tree (quote- and bracket-aware) and
// resolves each route to a real URL path. Dynamic segments (:id) are kept as
// literals; index/nested-empty routes collapse onto their parent path.

type JsxRouteNode = { path?: string; resolved: string };

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
  // consume until the tag's own closing '>' at JSX depth 0
  const props: Record<string, string> = {};
  // scan the raw attribute block text first
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
  // parse path="..." / path='...' / path={"..."} / path: '...' (defensive)
  const pathMatch = trimmed.match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{["']([^"'{}]*)["']\})/);
  const pathKey = trimmed.match(/\bpath\s*=\s*\{/);
  void pathKey;
  if (pathMatch) {
    const value = pathMatch[1] ?? pathMatch[2] ?? pathMatch[3];
    props.path = value ?? "";
  }
  return { end: i, selfClosed, props };
}

function extractJsxRoutePaths(text: string): string[] {
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
        pos = closeIdx + 9;
        continue;
      }
      if (openIdx === -1) break;
      // ensure the token is a tag (word boundary)
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
        // push this route's resolved path as context for children (unless it
        // resolved to "/", which keeps children at root anyway)
        stack.push(rawPath !== undefined && !rawPath.startsWith("/") && rawPath !== "" && rawPath !== "/" && rawPath !== "index"
          ? (parentPrefix && parentPrefix !== "/" ? `${parentPrefix}/${rawPath}` : `/${rawPath}`)
          : resolved);
      }
      pos = parsed.end;
    }
  } catch {}
  return out;
}

async function listRouteDirFiles(root: string, dirCandidates: string[]): Promise<string[]> {
  for (const candidate of dirCandidates) {
    const abs = path.join(root, candidate);
    if (await pathExists(abs)) {
      const files: string[] = [];
      const walk = async (rel: string): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try { entries = await fs.promises.readdir(path.join(abs, rel), { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          const relFile = path.join(rel, entry.name).replaceAll("\\", "/");
          if (entry.isDirectory()) {
            if (rel.split("/").length <= 6) await walk(relFile);
          } else if (ROUTE_FILE_EXTS.has(path.extname(entry.name).toLowerCase())) {
            files.push(relFile);
          }
        }
      };
      await walk("");
      return files;
    }
  }
  return [];
}

function detectFileBasedFramework(pkg: Record<string, any> | null): "next" | "remix" | "nuxt" | "sveltekit" | "astro" | null {
  const s = depsString(pkg ?? {});
  if (/"next"/.test(s)) return "next";
  if (/"@remix-run|\"remix"/.test(s)) return "remix";
  if (/"nuxt|@nuxt/.test(s)) return "nuxt";
  if (/"@sveltejs\/kit"/.test(s)) return "sveltekit";
  if (/"astro"/.test(s)) return "astro";
  return null;
}

// Manual History-API / pathname routing (NO router library). Real projects
// route by comparing window.location.pathname against string literals, e.g.:
//   const isTutoriais = () => location.pathname === "/tutoriais";
//   navigateTo("/tutoriais");  history.pushState({}, "", "/tutoriais");
// This fallback finds those literals wherever pathname-navigation evidence
// appears. It never invents pages and never inspects file contents beyond a
// deterministic path extraction.
const PATHNAME_ROUTE_TOKENS = [
  "location.pathname", ".pathname", "pushState(", "replaceState(",
  "navigateTo(", "location.href", "location.assign", "location.replace"
];

function extractManualRoutePaths(text: string): string[] {
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

// Real page discovery.
export async function discoverPreviewRoutes(projectRoot: string): Promise<PreviewRoute[]> {
  const routes: PreviewRoute[] = [];
  const seen = new Set<string>();

  function add(pathValue: string): void {
    const normalized = normalizeRoutePath(pathValue);
    if (!normalized || normalized === "/" || isLikelyApiOrPrivate(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    routes.push({ path: normalized, label: routeLabelFromPath(normalized) });
  }

  const pkg = await readPackageJson(projectRoot);
  const fileBased = detectFileBasedFramework(pkg);

  // 1) File-based routers (Next/Remix/Nuxt/SvelteKit/Astro): deterministic.
  if (fileBased === "next") {
    for (const rootDir of ["app", "src/app", "pages", "src/pages"]) {
      const files = await listRouteDirFiles(projectRoot, [rootDir]);
      for (const rel of files) {
        const route = routeFromFilePath(rel, rootDir.split("/"), rootDir.includes("app"));
        if (route) add(route);
      }
      if (files.length) break;
    }
  } else if (fileBased) {
    const rootDirs = fileBased === "sveltekit" ? ["src/routes", "routes"] : fileBased === "nuxt" ? ["pages"] : fileBased === "astro" ? ["src/pages", "pages"] : fileBased === "remix" ? ["app/routes", "routes"] : [];
    for (const rootDir of rootDirs) {
      const files = await listRouteDirFiles(projectRoot, [rootDir]);
      for (const rel of files) {
        const route = routeFromFilePath(rel, rootDir.split("/"), false);
        if (route) add(route);
      }
      if (files.length) break;
    }
  }

  // 2) Config/JSX routing (React Router / Vue Router / TanStack / remix).
  if (!fileBased || routes.length === 0) {
    const state: WalkResult = { files: [], allText: "" };
    await walkSource(projectRoot, "", state, 0);
    const routerPresent = ROUTER_INDICATORS.some(tok => state.allText.includes(tok));
    if (routerPresent) {
      // Nested JSX <Route> trees resolve relative children against parents.
      for (const file of state.files) {
        const text = await readTextSafe(path.join(projectRoot, file));
        if (!text || !text.includes("<Route")) continue;
        for (const routePath of extractJsxRoutePaths(text)) add(routePath);
      }
      // Config/data-router absolute literals: { path: '/x' } / path: "/x".
      const pathLiteral = /(?:^|[,{\s])\s*path\s*[:=]\s*(['"])(\/[^'"\s,;})\]]*)\1/g;
      let m: RegExpExecArray | null;
      while ((m = pathLiteral.exec(state.allText)) !== null) {
        if (m[2]) add(m[2]);
      }
    }
  }

  // 3) Manual History-API / pathname routing (projects without a router
  //     library). Only used as a fallback so router-based projects never get
  //     noisy extra entries.
  if (routes.length === 0) {
    const manualState: WalkResult = { files: [], allText: "" };
    await walkSource(projectRoot, "", manualState, 0);
    for (const file of manualState.files) {
      const text = await readTextSafe(path.join(projectRoot, file));
      if (!text) continue;
      for (const routePath of extractManualRoutePaths(text)) add(routePath);
    }
    if (routes.length > 0) {
      console.log("[Preview Routes] discover source=manual-pathname-routing");
    }
  }

  // 4) Static HTML file discovery: finds *.html files (excluding index.html which is already Home)
  if (routes.length === 0) {
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
            if (!SKIP_DIRS.has(entry.name)) {
              await scanHtmlDir(path.join(dir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name, depth + 1);
            }
          }
        }
      };
      await scanHtmlDir(projectRoot);
      if (routes.length > 0) {
        console.log("[Preview Routes] discover source=static-html-files");
      }
    } catch {}
  }

  // Always show Home as the root.
  const result: PreviewRoute[] = [{ path: "/", label: "Home" }];
  // Order: sort by segment depth ascending then lexically; keep Home first.
  const sorted = routes.sort((a, b) => {
    const da = a.path.split("/").filter(Boolean).length;
    const db = b.path.split("/").filter(Boolean).length;
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  });
  // De-duplicate against Home and cap to a sane number.
  for (const r of sorted) {
    if (r.path === "/" || result.some(x => x.path === r.path)) continue;
    if (result.length >= 60) break;
    result.push(r);
  }
  console.log(`[Preview Routes] discover projectPath=${projectRoot} count=${result.length} source=${fileBased ?? "config-or-none"}`);
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

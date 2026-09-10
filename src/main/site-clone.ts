// ============================================================
// SITE CLONE — crawler/análise (main process)
// ------------------------------------------------------------
// ... (ver topo do arquivo)
// ============================================================

import fs from "node:fs";
import path from "node:path";

export type SitePage = {
  route: string;        // normalized pathname ("/", "/sobre")
  url: string;
  title: string;
  headings: string[];
  textSample: string;
};

export type SiteStyleHint = {
  fonts: string[];      // font families referenced publicly (Google Fonts / inline)
};

export type SiteCloneAnalysis = {
  ok: boolean;
  origin: string;
  seedUrl: string;
  title: string;
  pages: SitePage[];
  routes: string[];             // unique routes, root first
  assets: { url: string; kind: string }[];
  style?: SiteStyleHint;
  externalLinks: string[];
  pagesScanned: number;
  stopped?: boolean;
  error?: string;
};

export type SiteCloneLimits = {
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  pageTimeoutMs?: number;
  maxPageBytes?: number;
  crawlTimeoutMs?: number;
};

export const SITE_CLONE_DEFAULTS = {
  maxPages: 30,
  maxDepth: 3,
  concurrency: 5,
  pageTimeoutMs: 12000,
  maxPageBytes: 2 * 1024 * 1024,
  crawlTimeoutMs: 90000
};

export const SITE_CLONE_ABORTS = new Map<string, AbortController>();

export function cancelSiteClone(id: string): boolean {
  const ctrl = SITE_CLONE_ABORTS.get(id);
  if (!ctrl) return false;
  try { ctrl.abort(); } catch {}
  SITE_CLONE_ABORTS.delete(id);
  return true;
}

export function cancelAllSiteClones(): void {
  for (const key of Array.from(SITE_CLONE_ABORTS.keys())) cancelSiteClone(key);
}

// --- pure helpers (unit-testable, no network) -----------------

export function normalizeSiteUrl(raw: string): string | null {
  let value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // has an explicit scheme: only http(s) is acceptable
    if (!/^https?:\/\//i.test(value)) return null;
  } else {
    value = "https://" + value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url.toString();
}

export function sameSite(candidate: string | undefined, origin: string): boolean {
  if (!candidate) return false;
  try {
    const c = new URL(candidate);
    const o = new URL(origin);
    return c.host.toLowerCase() === o.host.toLowerCase();
  } catch {
    return false;
  }
}

export function isAssetUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|css|js|mjs)(\?|$)/i.test(new URL(url).pathname);
}

export function assetKindFromUrl(url: string): string {
  const p = new URL(url).pathname.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)(\?|$)/.test(p)) return "image";
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(p)) return "font";
  if (/\.(mp4|webm)(\?|$)/.test(p)) return "video";
  if (/\.(css)(\?|$)/.test(p)) return "style";
  if (/\.(js|mjs)(\?|$)/.test(p)) return "script";
  return "asset";
}

export function routeFromHref(href: string, origin: string): string | null {
  if (!sameSite(href, origin)) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  url.hash = "";
  let route = url.pathname || "/";
  if (route.length > 1) route = route.replace(/\/+$/, "");
  if (!route) route = "/";
  return route;
}

export function sanitizeRoute(route: string): string {
  let r = String(route ?? "");
  if (!r.startsWith("/")) r = "/" + r;
  r = r.replace(/\.\.(\/|$)/g, "").replace(/[?#].*$/, "").replace(/\/+/g, "/");
  if (r.length > 1) r = r.replace(/\/+$/, "");
  return r === "" ? "/" : r;
}

const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|pdf|zip|json|xml)(\?|$)/i;

function isProbablyAssetPath(pathname: string): boolean {
  return ASSET_SUFFIX.test(pathname);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => { try { return String.fromCodePoint(Number(code)); } catch { return ""; } });
}

// --- HTML extraction ------------------------------------------

function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function extractHeadings(html: string, max: number): string[] {
  const out: string[] = [];
  const re = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const text = decodeEntities(String(m[2]).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text && text.length <= 300) out.push(text);
  }
  return out;
}

function extractTextSample(html: string): string {
  const body = /<body[\s\S]*?>([\s\S]*?)<\/body>/i.exec(html);
  const scope = body ? body[1] : html;
  const text = decodeEntities(scope
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "))
    .trim();
  return text.slice(0, 400);
}

function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = String(m[2] ?? "").trim();
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    out.push(href);
  }
  return out;
}

function extractAssetUrls(html: string, origin: string, max: number): string[] {
  const out: string[] = [];
  const patterns = [
    /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi,
    /<source\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi,
    /<video\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi,
    /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < max) {
      const src = String(m[2] ?? "").trim();
      if (!src || /^(data:|blob:|javascript:)/i.test(src)) continue;
      let abs: string;
      try { abs = new URL(src, origin).toString(); } catch { continue; }
      if (!out.includes(abs)) out.push(abs);
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// Collect publicly-referenced font families for fidelity hints.
const GENERIC_FONTS = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "revert"]);

function cleanFontName(raw: string): string {
  return String(raw ?? "").replace(/["']/g, "").split(",")[0].trim();
}

function extractFontFamilies(html: string, max: number): string[] {
  const set = new Set<string>();
  // Google Fonts <link> (css2): family=Anton&family=Space+Grotesk:wght@...
  const linkRe = /<link\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const href = lm[2];
    if (!/fonts\.(googleapis|gstatic)/i.test(href)) continue;
    const famRe = /family=([^&]+)/gi;
    let fm: RegExpExecArray | null;
    while ((fm = famRe.exec(href)) !== null && set.size < max) {
      const seg = decodeURIComponent(fm[1]).split(":")[0].replace(/\+/g, " ").trim();
      if (seg && !GENERIC_FONTS.has(seg.toLowerCase())) set.add(seg);
    }
  }
  // inline style="font-family: ..." / <style> blocks
  const inlineRe = /font-family\s*:\s*([^;"}]+)/gi;
  let im: RegExpExecArray | null;
  while ((im = inlineRe.exec(html)) !== null && set.size < max) {
    const name = cleanFontName(im[1]);
    if (name && name.length <= 60 && !GENERIC_FONTS.has(name.toLowerCase()) && !/var\(/.test(name)) set.add(name);
  }
  return Array.from(set).slice(0, max);
}

// --- asset import (download public assets into the project) ---

export type ImportedAsset = { remoteUrl: string; localPath: string }; // localPath is a URL-ish "/clone-assets/x.png"
export type ImportAssetsResult = { ok: boolean; imported: ImportedAsset[]; failed: string[]; skipped: string[] };

const IMPORTABLE_KINDS = new Set(["image", "font"]);
const ASSET_SAFE_RE = /[^a-z0-9._-]/gi;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;

async function fetchBytes(url: string, ctrl: AbortController, timeoutMs: number, maxBytes: number): Promise<{ ok: boolean; bytes?: Buffer; contentType?: string }> {
  const local = new AbortController();
  const onAbort = () => local.abort();
  ctrl.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => local.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: local.signal, headers: { "User-Agent": "NekoAI-SiteClone/1.0" } });
    if (!response.ok) return { ok: false };
    if (!response.body) return { ok: false };
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared && declared > maxBytes) return { ok: false };
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received > maxBytes) return { ok: false };
      chunks.push(Buffer.from(value));
    }
    return { ok: true, bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? undefined };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    ctrl.signal.removeEventListener("abort", onAbort);
  }
}

function assetLocalName(url: string, index: number): { file: string; ext: string } {
  const parsed = new URL(url);
  let base = path.posix.basename(parsed.pathname) || "";
  base = base.replace(ASSET_SAFE_RE, "").slice(0, 40);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  if (!ext || ext.length > 6) {
    const fallbackExt = /\.svg/i.test(parsed.pathname) ? ".svg" : /\.png/i.test(parsed.pathname) ? ".png" : /\.jpe?g/i.test(parsed.pathname) ? ".jpg" : /\.webp/i.test(parsed.pathname) ? ".webp" : /\.(woff2?|ttf|otf)/i.test(parsed.pathname) ? /\.woff2/i.test(parsed.pathname) ? ".woff2" : /\.woff/i.test(parsed.pathname) ? ".woff" : ".ttf" : ".png";
    base = (base.split(".")[0] || "asset").replace(/\.$/, "");
    return { file: `${base}${fallbackExt}`, ext: fallbackExt };
  }
  return { file: `${base}`, ext };
}

export async function importSiteAssets(
  projectRoot: string,
  assets: { url: string; kind: string }[],
  limits?: { concurrency?: number; pageTimeoutMs?: number }
): Promise<ImportAssetsResult> {
  const L = { concurrency: 4, pageTimeoutMs: 15000, ...(limits ?? {}) };
  const imported: ImportedAsset[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const root = path.resolve(projectRoot);
  const targetDir = path.join(root, "public", "clone-assets");
  try { fs.mkdirSync(targetDir, { recursive: true }); } catch { /* ignore */ }

  const candidates = (assets ?? []).filter(a => IMPORTABLE_KINDS.has(a.kind) && /^https?:\/\//i.test(a.url));
  const ctrl = new AbortController();
  let index = 0;

  const worker = async () => {
    for (;;) {
      const job = candidates[index++];
      if (!job) return;
      const { file } = assetLocalName(job.url, index);
      // avoid collisions
      const uniq = `${index}_${file}`;
      const absTarget = path.join(targetDir, uniq);
      if (!absTarget.startsWith(targetDir + path.sep)) { skipped.push(job.url); continue; }
      const res = await fetchBytes(job.url, ctrl, L.pageTimeoutMs, MAX_ASSET_BYTES);
      if (!res.ok || !res.bytes) { failed.push(job.url); continue; }
      try {
        fs.writeFileSync(absTarget, res.bytes);
        imported.push({ remoteUrl: job.url, localPath: `/clone-assets/${uniq}` });
      } catch {
        failed.push(job.url);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(L.concurrency, 8)) }, () => worker()));
  return { ok: failed.length === 0 || imported.length > 0, imported, failed, skipped };
}

// --- network fetch (bounded) ----------------------------------

async function fetchPageText(url: string, controller: AbortController, timeoutMs: number, maxBytes: number): Promise<string> {
  const local = new AbortController();
  const onAbort = () => local.abort();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => local.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: local.signal,
      headers: { "User-Agent": "NekoAI-SiteClone/1.0 (static analysis)" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received > maxBytes) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export type AnalyzeProgress = (info: { scanned: number; currentUrl: string }) => void;

// --- main entry -----------------------------------------------

export async function analyzeSite(rawSeedUrl: string, limits?: SiteCloneLimits, onProgress?: AnalyzeProgress): Promise<SiteCloneAnalysis> {
  const L = { ...SITE_CLONE_DEFAULTS, ...(limits ?? {}) };
  const seed = normalizeSiteUrl(rawSeedUrl);
  const failure = (message: string): SiteCloneAnalysis => ({
    ok: false, origin: "", seedUrl: rawSeedUrl, title: "", pages: [], routes: [],
    assets: [], externalLinks: [], pagesScanned: 0, error: message
  });
  if (!seed) return failure("URL inválida. Informe um endereço público, por exemplo: https://exemplo.com");

  const origin = new URL(seed).origin;
  const id = `clone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const controller = new AbortController();
  SITE_CLONE_ABORTS.set(id, controller);

  const visited = new Set<string>(); // normalized route
  const queuedUrls = new Set<string>();
  const pages: SitePage[] = [];
  const assetMap = new Map<string, string>();
  const externalSet = new Set<string>();
  const fontSet = new Set<string>();
  const seedRoute = sanitizeRoute(new URL(seed).pathname);
  const overallDeadline = Date.now() + L.crawlTimeoutMs;
  let halted = false;
  let stopped = false;

  visited.add(seedRoute);
  queuedUrls.add(seed);
  const pending: { url: string; route: string; depth: number }[] = [{ url: seed, route: seedRoute, depth: 0 }];
  let started = false;
  let running = 0;

  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const maybeDone = () => {
      if (!started) return;
      if (running === 0 && (halted || pending.length === 0) && !settled) {
        settled = true;
        stopped = halted || controller.signal.aborted || Date.now() >= overallDeadline;
        resolvePromise();
      }
    };

    const worker = async () => {
      running++;
      try {
        for (;;) {
          if (halted || controller.signal.aborted || Date.now() >= overallDeadline || pages.length >= L.maxPages) {
            halted = true;
            break;
          }
          const job = pending.shift();
          if (!job) break;
          let html = "";
          try {
            html = await fetchPageText(job.url, controller, L.pageTimeoutMs, L.maxPageBytes);
          } catch {
            continue; // individual page failure: log and continue
          }
          if (controller.signal.aborted || halted) { halted = true; break; }
          if (!html) continue;

          pages.push({
            route: job.route,
            url: job.url,
            title: extractTitle(html) || job.route,
            headings: extractHeadings(html, 24),
            textSample: extractTextSample(html)
          });
          onProgress?.({ scanned: pages.length, currentUrl: job.url });
          for (const family of extractFontFamilies(html, 40)) fontSet.add(family);

          for (const asset of extractAssetUrls(html, origin, 60)) {
            if (sameSite(asset, origin)) {
              if (!assetMap.has(asset)) assetMap.set(asset, assetKindFromUrl(asset));
            } else if (externalSet.size < 80) {
              externalSet.add(asset);
            }
          }

          if (pages.length >= L.maxPages) { halted = true; break; }
          for (const href of extractHrefs(html)) {
            if (controller.signal.aborted) { halted = true; break; }
            let abs: string;
            try { abs = new URL(href, job.url).toString(); } catch { continue; }
            if (!sameSite(abs, origin)) {
              if (externalSet.size < 80) externalSet.add(abs.split("#")[0]);
              continue;
            }
            const route = routeFromHref(abs, origin);
            if (!route || route === job.route) continue;
            if (isProbablyAssetPath(new URL(abs).pathname)) continue;
            if (visited.has(route)) continue;
            const nextDepth = job.depth + 1;
            if (nextDepth > L.maxDepth) continue;
            visited.add(route);
            queuedUrls.add(abs);
            pending.push({ url: abs, route, depth: nextDepth });
          }
        }
      } finally {
        running--;
        maybeDone();
      }
    };

    started = true;
    const n = Math.max(1, Math.min(L.concurrency, 8));
    for (let i = 0; i < n; i++) void worker();
  });

  SITE_CLONE_ABORTS.delete(id);

  const routes = Array.from(new Set(pages.map(p => p.route))).sort((a, b) => {
    if (a === "/") return -1;
    if (b === "/") return 1;
    const da = a.split("/").filter(Boolean).length;
    const db = b.split("/").filter(Boolean).length;
    return da - db || a.localeCompare(b);
  });

  const result: SiteCloneAnalysis = {
    ok: true,
    origin,
    seedUrl: seed,
    title: pages[0]?.title ?? "",
    pages,
    routes,
    assets: Array.from(assetMap.entries()).map(([url, kind]) => ({ url, kind })),
    style: { fonts: Array.from(fontSet).slice(0, 40) },
    externalLinks: Array.from(externalSet),
    pagesScanned: pages.length,
    stopped
  };
  if (controller.signal.aborted) result.stopped = true;
  return result;
}

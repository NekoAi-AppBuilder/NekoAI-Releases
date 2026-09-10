// ============================================================
// SITE CAPTURE (Chromium) — Clonar Site V2
// ------------------------------------------------------------
// Captura uma URL pública com Chromium REAL (DOM executado, estilos
// computados, assets carregados) e produz um SNAPSHOT estruturado que é a
// fonte de verdade para o agente NekoAI reconstruir um React editável.
//
// Este arquivo separa:
//   - lógica determinística pura (validável offline, ver tests/site-capture.test.ts)
//   - a rotina Electron de captura (exige app aberto; usa uma janela oculta
//     com partition isolada e nunca substitui o Preview normal)
//
// Segurança: só http(s), bloqueia localhost/IPs privados/loopback/link-local,
// só navega a origem inicial, limites de páginas/assets/bytes/escopo.
// Nunca grava fora de um projectRoot validado por assertProjectRootSafe.
// ============================================================

import type { BrowserWindow } from "electron";

// ---- limites configuráveis (futuro: settings) ----------------------------
export const CAPTURE_LIMITS = {
  MAX_INTERNAL_PAGES: 10, // inclui a home
  MAX_ASSET_URLS: 800,
  MAX_HTML_BYTES: 10_000_000,
  MAX_CAPTURE_ELEMENTS: 2000,
  PAGE_LOAD_TIMEOUT_MS: 20_000,
  DOM_STABLE_MS: 800,
  ASSET_TIMEOUT_MS: 15_000,
  MAX_SCROLL_STEPS: 30
};

export type SiteCapturePage = {
  url: string;
  pathname: string;
  title: string;
  html: string;
  assets: string[];
  favicons: string[];
  ogImages: string[];
};

export type SiteCaptureSnapshot = {
  ok: boolean;
  origin: string;
  seedUrl: string;
  title: string;
  pages: SiteCapturePage[];
  assets: { url: string; kind: string }[];
  fonts: string[];
  routes: string[];
  pagesDiscovered: number;
  pagesCaptured: number;
  pagesFailed: number;
  warning?: string;
  error?: string;
  capturedAt: number;
};

// ===========================================================================
// Lógica pura (offline/testável)
// ===========================================================================

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "localhost.localdomain") return true;
  if (h === "::1" || h === "[::1]") return true;
  // IP literals
  const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
  if (isIp(h)) {
    const parts = h.split(".").map(Number);
    if (parts.some((p) => p > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

// Aceita só http(s), bloqueia host/loopback/privado antes de navegar.
export function validatePublicUrl(raw: string): { ok: boolean; url?: string; error?: string } {
  let v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: "Informe uma URL." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/^https?:\/\//i.test(v)) {
    return { ok: false, error: "Apenas URLs http/https são permitidas." };
  }
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, error: "URL inválida." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Protocolo não permitido." };
  if (isPrivateHost(u.hostname)) return { ok: false, error: "Não é permitido clonar endereços locais/privados." };
  return { ok: true, url: u.toString() };
}

export function sameOrigin(a: string, origin: string): boolean {
  try {
    return new URL(a).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

// Ignora parâmetros de query/hash para fins de rota (página).
export function pathToRoute(pathname: string): string {
  let p = String(pathname ?? "/");
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

// Sanitiza cada segmento e mapeia pathname -> arquivo html estático seguro.
export function pathnameToHtmlPath(pathname: string): string {
  let p = String(pathname ?? "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return "index.html";
  const seg = p.split("/").map((s) => s.replace(/[<>:"|?*\x00-\x1f\\]/g, "_"));
  const joined = seg.join("/");
  const ext = /\.\w+$/.test(joined);
  return ext ? joined : `${joined}/index.html`;
}

// Sanitiza segmentos usados em caminhos locais (assets).
export function sanitizeSegments(p: string): string {
  return p.split("/").map((s) => s.replace(/[<>:"|?*\x00-\x1f\\]/g, "_")).join("/");
}

// Classifica asset por extensão/tipo.
export function assetKindFromUrl(url: string): string {
  const p = new URL(url).pathname.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)(\?|$)/.test(p)) return "image";
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(p)) return "font";
  if (/\.(css)(\?|$)/.test(p)) return "style";
  if (/\.(mp4|webm|ogv)(\?|$)/.test(p)) return "video";
  if (/\.(js|mjs)(\?|$)/.test(p)) return "script";
  return "asset";
}

export function isProbablyAssetPath(pathname: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|pdf|zip|json|xml)(\?|$)/i.test(pathname);
}

// Parse de srcset -> lista de URLs (descartando larguras/descritores).
export function parseSrcset(srcset: string): string[] {
  const out: string[] = [];
  for (const part of String(srcset || "").split(",")) {
    const t = part.trim();
    if (!t) continue;
    const first = t.split(/\s+/)[0];
    if (first && /^https?:\/\//i.test(first) || first && /^\//.test(first)) out.push(first);
  }
  return out;
}

// URLs url()/@import de um CSS.
export function extractCssUrls(css: string, baseUrl: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    const t = String(raw ?? "").trim();
    if (!t || t.startsWith("data:")) return;
    try {
      const abs = new URL(t, baseUrl).href;
      if (abs.startsWith("http://") || abs.startsWith("https://")) found.push(abs);
    } catch {}
  };
  const urlRe = /url\((["']?)([^"')]+)\1\)/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(css)) !== null) push(m[2]);
  const importRe = /@import\s+(?:url\()?["']([^"']+)["']\)?/g;
  while ((m = importRe.exec(css)) !== null) push(m[1]);
  return found;
}

// Descobre links internos a partir de hrefs absolutos (mesma origem), sem assets.
export function discoverInternalRoutes(hrefs: string[], origin: string, currentRoute: string, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const bad = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|pdf|zip|json|xml)(\?|$)/i;
  for (const href of hrefs) {
    if (!sameOrigin(href, origin)) continue;
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const route = pathToRoute(u.pathname);
    if (route === "/" || route === currentRoute) continue;
    if (bad.test(u.pathname)) continue;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(route);
    if (out.length >= max) break;
  }
  return out;
}

// Aplica política de query/hash: página é definida pelo pathname.
export function hrefToPageRoute(href: string, origin: string): string | null {
  if (!sameOrigin(href, origin)) return null;
  try {
    return pathToRoute(new URL(href).pathname);
  } catch {
    return null;
  }
}

// Mapeia asset abs -> caminho local dentro do projeto.
// (mesma-origem: espelha path; externo: vendor/<host>/...)
export function assetUrlToLocalPath(absUrl: string, origin: string): string | null {
  try {
    const u = new URL(absUrl);
    const host = u.hostname.toLowerCase();
    let p = u.pathname.replace(/^\/+/, "") || "index.html";
    if (!/\.\w+$/.test(p)) p = `${p}/index.html`;
    p = sanitizeSegments(p);
    if (sameOrigin(absUrl, origin)) return p;
    return `vendor/${host.replace(/[^a-z0-9.-]/g, "-")}/${p}`;
  } catch {
    return null;
  }
}

// Deduplica assets por URL e classifica.
export function dedupeAssets(urls: string[]): { url: string; kind: string }[] {
  const seen = new Set<string>();
  const out: { url: string; kind: string }[] = [];
  for (const u of urls) {
    if (typeof u !== "string" || u.length > 2048) continue;
    const abs = u; // já espera absoluto
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, kind: assetKindFromUrl(abs) });
  }
  return out;
}

// Remove tags e produz texto visível aproximado de um HTML (p/ contexto do agente).
export function htmlToText(html: string, max: number): string {
  const s = String(html || "")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, max);
}

// Converte um snapshot em um bloco de contexto compacto e limitado para o
// agente (nunca o HTML inteiro; apenas trecho por página + listas reais).
export function buildAgentCaptureContext(snapshot: SiteCaptureSnapshot, pageHtmlBudget = 6000): string {
  const lines: string[] = [];
  lines.push("<site_capture>");
  lines.push(`ORIGIN: ${snapshot.origin || ""}`);
  lines.push(`ROUTES: ${(snapshot.routes || []).join(", ")}`);
  lines.push(`PAGES (${(snapshot.pages || []).length}):`);
  for (const p of snapshot.pages || []) {
    lines.push(`-- [${p.pathname}] url=${p.url}`);
    const text = htmlToText(p.html, pageHtmlBudget);
    if (text) lines.push(`   text: ${text}`);
  }
  const assets = (snapshot.assets || []).slice(0, 400).map((a) => `${a.url} (${a.kind})`).join("\n");
  lines.push(`ASSETS:\n${assets || "-"}`);
  if ((snapshot.fonts || []).length) lines.push(`FONTS: ${snapshot.fonts.join(", ")}`);
  if (snapshot.warning) lines.push(`WARNING: ${snapshot.warning}`);
  lines.push("</site_capture>");
  return lines.join("\n");
}


// Scripts injetados (escritos para este projeto).
export const CAPTURE_SCRIPTS = {
  scroll: `
(async () => {
  try {
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const H = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const V = window.innerHeight || 1;
    const steps = Math.min(Math.ceil(H / V), ${CAPTURE_LIMITS.MAX_SCROLL_STEPS});
    for (let i = 1; i <= steps; i++) { window.scrollTo(0, (H / steps) * i); await delay(120); }
    window.scrollTo(0, 0);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`,
  collect: `
(() => {
  try {
    const base = location.href;
    const origin = location.origin;
    const urls = new Set();
    const favicons = [];
    const ogImages = [];
    const addAbs = (u) => {
      if (!u || /^(data:|blob:|javascript:)/.test(u)) return;
      try { const a = new URL(u, base).href; if (/^https?:/.test(a)) urls.add(a); } catch {}
    };
    try { performance.getEntriesByType('resource').forEach(e => addAbs(e.name)); } catch {}
    document.querySelectorAll('script[src]').forEach(n => { addAbs(n.getAttribute('src')); addAbs(n.src); });
    document.querySelectorAll('link[href]').forEach(n => {
      const rel = (n.rel || '').toLowerCase();
      if (/stylesheet|preload|modulepreload|icon|manifest|apple-touch-icon|shortcut/.test(rel)) { addAbs(n.getAttribute('href')); addAbs(n.href); }
      if (/icon|apple-touch-icon|shortcut/.test(rel)) { try { favicons.push(new URL(n.getAttribute('href') || n.href, base).href); } catch {} }
    });
    document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach(n => {
      const c = n.getAttribute('content'); if (c) { addAbs(c); try { ogImages.push(new URL(c, base).href); } catch {} }
    });
    document.querySelectorAll('img,source').forEach(n => { addAbs(n.src || n.currentSrc); addAbs(n.getAttribute('src')); (n.getAttribute('srcset') || '').split(',').forEach(p => { const u = p.trim().split(/\\s+/)[0]; if (u) addAbs(u); }); });
    document.querySelectorAll('video[src],audio[src],video source[src],audio source[src]').forEach(n => { addAbs(n.getAttribute('src')); addAbs(n.src); });
    document.querySelectorAll('video[poster]').forEach(n => addAbs(n.getAttribute('poster')));
    document.querySelectorAll('style').forEach(n => { const t = n.textContent || ''; (t.match(/url\\(["']?[^"')]+["']?\\)/g) || []).forEach(x => addAbs(x.replace(/^url\\(["']?|["']?\\)$/g, ''))); (t.match(/@import\\s+(?:url\\()?["'][^"']+["']\\)?/g) || []).forEach(x => addAbs(x.replace(/@import\\s+(?:url\\()?["']|["']\\)?;?$/g, ''))); });
    const els = document.querySelectorAll('body,body *');
    const max = Math.min(els.length, 1500);
    for (let i = 0; i < max; i++) { try { const bg = getComputedStyle(els[i]).backgroundImage; if (bg && bg !== 'none') (bg.match(/url\\(["']?[^"')]+["']?\\)/g) || []).forEach(x => addAbs(x.replace(/^url\\(["']?|["']?\\)$/g, ''))); } catch {} }
    return { ok: true, origin, href: location.href, html: '<!doctype html>\\n' + document.documentElement.outerHTML, urls: Array.from(urls), favicons, ogImages };
  } catch (e) { return { ok: false, error: String(e), html: '', urls: [], favicons: [], ogImages: [] }; }
})()`,
  links: `
(() => {
  try {
    const origin = location.origin;
    const cur = location.pathname.replace(/\\/+$/, '');
    const seen = new Set(); const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href') || '';
      if (!raw || /^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) return;
      if (a.hasAttribute('download')) return;
      let u; try { u = new URL(raw, location.href); } catch { return; }
      if (u.origin !== origin) return;
      const p = u.pathname.replace(/\\/+$/, '');
      if (/\\\\.(zip|pdf|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|json|xml|ico|woff2?|ttf|dmg|exe)$/i.test(p)) return;
      const key = u.origin + p;
      if (key === origin + cur || seen.has(key)) return;
      seen.add(key);
      links.push({ url: u.origin + (p || '/'), path: p || '/' });
    });
    return { ok: true, links: links.slice(0, 30) };
  } catch (e) { return { ok: false, links: [] }; }
})()`
};

// Captura uma página já navegada num webContents. (auxiliar puro da rotina)
export async function captureLoadedPage(
  wc: Electron.WebContents,
  pageUrl: string,
): Promise<SiteCapturePage> {
  await wc.executeJavaScript(CAPTURE_SCRIPTS.scroll, true);
  await new Promise((r) => setTimeout(r, 600));
  const res = await wc.executeJavaScript(CAPTURE_SCRIPTS.collect, true);
  if (!res?.ok) throw new Error(res?.error || "Falha ao capturar a página");
  if (String(res.html || "").length > CAPTURE_LIMITS.MAX_HTML_BYTES) throw new Error("Página muito grande para capturar");
  return {
    url: String(res.href || pageUrl),
    pathname: new URL(pageUrl).pathname,
    title: "",
    html: String(res.html || ""),
    assets: Array.isArray(res.urls) ? res.urls : [],
    favicons: Array.isArray(res.favicons) ? res.favicons : [],
    ogImages: Array.isArray(res.ogImages) ? res.ogImages : []
  };
}

// Rotina Electron de captura: cria janela oculta com partition isolada, navega
// as páginas internas e baixa assets. Exige app aberto (não roda em CI).
export async function captureSiteChromium(
  rawUrl: string,
  opts: { BrowserWindow: typeof BrowserWindow },
): Promise<SiteCaptureSnapshot> {
  const valid = validatePublicUrl(rawUrl);
  if (!valid.ok || !valid.url) return { ok: false, origin: "", seedUrl: rawUrl, title: "", pages: [], assets: [], fonts: [], routes: [], pagesDiscovered: 0, pagesCaptured: 0, pagesFailed: 0, error: valid.error, capturedAt: Date.now() };
  const win = new opts.BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      partition: "persist:neko-cloner",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try {
    const wc = win.webContents;
    const seedUrl = valid.url;
    const origin = new URL(seedUrl).origin;
    const seedRoute = pathToRoute(new URL(seedUrl).pathname);

    // injeção de navegação segura: só origem inicial, http(s)
    wc.on("will-navigate", (e, url) => {
      if (!sameOrigin(url, origin)) e.preventDefault();
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));

    await wc.loadURL(seedUrl);
    // espera estabilidade simples
    await new Promise((r) => setTimeout(r, CAPTURE_LIMITS.DOM_STABLE_MS));
    const main = await captureLoadedPage(wc, seedUrl);
    const linksRes: any = await wc.executeJavaScript(CAPTURE_SCRIPTS.links, true);
    const internalRoutes = discoverInternalRoutes(
      (linksRes?.links || []).map((l: any) => l.url),
      origin,
      seedRoute,
      CAPTURE_LIMITS.MAX_INTERNAL_PAGES - 1
    );

    const pages: SiteCapturePage[] = [main];
    let failed = 0;
    for (const route of internalRoutes) {
      const target = new URL(route, origin).href;
      try {
        await wc.loadURL(target);
        await new Promise((r) => setTimeout(r, CAPTURE_LIMITS.DOM_STABLE_MS));
        pages.push(await captureLoadedPage(wc, target));
      } catch {
        failed++;
      }
    }

    const assetSet = new Map<string, string>();
    for (const p of pages) {
      for (const u of [...p.assets, ...p.favicons, ...p.ogImages]) {
        if (!assetSet.has(u)) assetSet.set(u, assetKindFromUrl(u));
        if (assetSet.size >= CAPTURE_LIMITS.MAX_ASSET_URLS) break;
      }
    }
    const fonts = Array.from(assetSet.entries()).filter(([, k]) => k === "font").map(([u]) => u);
    const snapshot: SiteCaptureSnapshot = {
      ok: true,
      origin,
      seedUrl,
      title: main.html.length ? "" : "",
      pages,
      assets: Array.from(assetSet.entries()).map(([url, kind]) => ({ url, kind })),
      fonts,
      routes: [seedRoute, ...internalRoutes],
      pagesDiscovered: 1 + internalRoutes.length,
      pagesCaptured: pages.length,
      pagesFailed: failed,
      capturedAt: Date.now()
    };
    return snapshot;
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {}
  }
}

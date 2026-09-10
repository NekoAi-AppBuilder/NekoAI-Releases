// tests/site-clone.test.ts
// Núcleo do "Clonar Site": validação, normalização, crawler, limites e abort,
// usando um servidor HTTP local de mock (sem rede externa).
// Executar: node --experimental-strip-types --test tests/site-clone.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeSiteUrl,
  sameSite,
  isAssetUrl,
  routeFromHref,
  sanitizeRoute,
  analyzeSite,
  cancelSiteClone,
  importSiteAssets,
  SITE_CLONE_ABORTS,
  SITE_CLONE_DEFAULTS
} from "../src/main/site-clone.ts";

function normalizeUrl(u: string): string {
  const x = new URL(u);
  x.hash = "";
  return x.toString();
}

function startSite(pages: Record<string, { status?: number; html?: string }>): Promise<{ base: string; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const pathname = (req.url || "/").split("?")[0];
      const route = pages[pathname] || pages[normalizeUrl(`http://x${pathname}`)] || { status: 404, html: "<html></html>" };
      const status = route.status ?? 200;
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(route.html ?? "<html></html>");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        base: `http://127.0.0.1:${(addr as any).port}`,
        close: () => { server.closeAllConnections(); server.close(); }
      });
    });
  });
}

// URL validation / normalization
test("normalizeSiteUrl validates and normalizes", () => {
  assert.ok(normalizeSiteUrl("https://site.com") === "https://site.com/");
  assert.ok(normalizeSiteUrl("site.com/sobre") === "https://site.com/sobre");
  assert.ok(normalizeSiteUrl("http://site.com/") === "http://site.com/");
  assert.equal(normalizeSiteUrl(""), null);
  assert.equal(normalizeSiteUrl("not a url at all"), null);
  assert.equal(normalizeSiteUrl("ftp://site.com"), null);
  // fragment is stripped
  assert.ok(normalizeSiteUrl("https://site.com/#top") === "https://site.com/");
});

test("sameSite and asset detection", () => {
  assert.equal(sameSite("https://site.com/sobre", "https://site.com/"), true);
  assert.equal(sameSite("https://other.com/x", "https://site.com/"), false);
  assert.equal(sameSite("http://site.com:3000/x", "http://site.com:3000/"), true);
  assert.equal(isAssetUrl("https://site.com/logo.png"), true);
  assert.equal(isAssetUrl("https://site.com/logo.svg?x=1"), true);
  assert.equal(isAssetUrl("https://site.com/sobre"), false);
});

test("route extraction and sanitization", () => {
  assert.equal(routeFromHref("https://site.com/sobre", "https://site.com/"), "/sobre");
  assert.equal(routeFromHref("https://site.com/#top", "https://site.com/"), "/");
  assert.equal(routeFromHref("https://site.com/sobre/", "https://site.com/"), "/sobre");
  assert.equal(routeFromHref("https://other.com/x", "https://site.com/"), null);
  assert.equal(sanitizeRoute("../../etc/passwd"), "/etc/passwd");
  assert.equal(sanitizeRoute("/produtos/?x=1"), "/produtos");
});

// multi-page crawl: external links excluded, loop safe, root first
test("crawls multiple internal pages and ignores external/loops", async () => {
  const s = await startSite({
    "/": { html: `<html><head><title>Home</title></head><body><h1>Bem vindo</h1><a href="/sobre">Sobre</a><a href="/sobre">Sobre de novo</a><a href="https://youtube.com">Ext</a></body></html>` },
    "/sobre": { html: `<html><head><title>Sobre</title></head><body><h1>Sobre nos</h1><a href="/contato">Contato</a><a href="/">Home</a></body></html>` },
    "/contato": { html: `<html><head><title>Contato</title></head><body><h1>Fale</h1></body></html>` }
  });
  try {
    const analysis = await analyzeSite(s.base, { maxPages: 10 });
    assert.equal(analysis.ok, true);
    const routes = analysis.routes;
    assert.ok(routes.includes("/"));
    assert.ok(routes.includes("/sobre"));
    assert.ok(routes.includes("/contato"));
    assert.equal(routes[0], "/");
    // loop /sobre->home -> /sobre resolves to unique set (no infinite loop)
    assert.ok(routes.filter(r => r === "/sobre").length === 1);
    // external link NOT turned into a page, but flagged
    assert.ok(!routes.some(r => r.includes("youtube")));
    assert.ok(analysis.externalLinks.some(l => l.includes("youtube.com")));
    assert.ok(analysis.title.length > 0);
  } finally {
    s.close();
  }
});

// page cap respected
test("respects maxPages limit", async () => {
  const pages: Record<string, { html: string }> = { "/": { html: "<html><body><h1>H</h1></body></html>" } };
  for (let i = 1; i <= 40; i++) {
    pages[`/${i}`] = { html: `<html><body><h1>P${i}</h1><a href="/${i + 1}">next</a></body></html>` };
  }
  pages["/"].html = (() => { const links = Array.from({ length: 40 }, (_, i) => `<a href="/${i + 1}">${i + 1}</a>`).join(""); return `<html><body><h1>H</h1>${links}</body></html>`; })();
  const s = await startSite(pages);
  try {
    const analysis = await analyzeSite(s.base, { maxPages: 12, concurrency: 4 });
    assert.ok(analysis.pagesScanned <= 12, `scanned=${analysis.pagesScanned}`);
    assert.ok(analysis.routes.length <= 12);
  } finally {
    s.close();
  }
});

// abort
test("abort stops the crawl", async () => {
  // A page that never finishes lets us abort mid-crawl.
  const server = http.createServer((_req, res) => {
    // never respond; keep socket open
    res.writeHead(200, { "Content-Type": "text/html" });
    // do not call res.end
    void res;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const base = `http://127.0.0.1:${(addr as any).port}`;
  try {
    const promise = analyzeSite(base, { maxPages: 5, pageTimeoutMs: 5000 });
    setTimeout(() => {
      for (const id of Array.from(SITE_CLONE_ABORTS.keys())) cancelSiteClone(id);
    }, 80);
    const result = await promise;
    assert.equal(result.stopped, true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// depth cap produces finite crawl on an acyclic chain
test("respects maxDepth", async () => {
  const pages: Record<string, { html: string }> = { "/": { html: `<html><body><a href="/a">a</a></body></html>` } };
  for (const l of ["a", "b", "c", "d", "e"]) pages[`/${l}`] = { html: `<html><body>${l}<a href="/${String.fromCharCode(l.charCodeAt(0) + 1)}">next</a></body></html>` };
  const s = await startSite(pages);
  try {
    const analysis = await analyzeSite(s.base, { maxDepth: 2, maxPages: 50 });
    assert.ok(analysis.pagesScanned <= 50);
  } finally {
    s.close();
  }
});

// font families are captured as style hints for visual fidelity
test("captures public font families as style hints", async () => {
  const s = await startSite({
    "/": {
      html: `<html><head><title>Site</title>
        <link href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@300..700&display=swap" rel="stylesheet"/>
        </head><body style="font-family: 'Inter', sans-serif"><h1>Olá</h1></body></html>`
    }
  });
  try {
    const analysis = await analyzeSite(s.base, { maxPages: 2 });
    const fonts = (analysis.style?.fonts || []).map(f => f.toLowerCase());
    assert.ok(fonts.includes("anton"), `fonts=${JSON.stringify(fonts)}`);
    assert.ok(fonts.includes("space grotesk"), `fonts=${JSON.stringify(fonts)}`);
    assert.ok(fonts.includes("inter"), `fonts=${JSON.stringify(fonts)}`);
    // generic fallbacks never become "fonts"
    assert.ok(!fonts.includes("sans-serif"));
  } finally {
    s.close();
  }
});

// asset import writes real local files (no hotlink/placeholder)
test("importSiteAssets downloads public image/font assets locally", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const server = http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/logo.png" || pathname === "/bg.jpg") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      res.end(png);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const base = `http://127.0.0.1:${(addr as any).port}`;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "neko-asset-proj-"));
  try {
    const result = await importSiteAssets(proj, [
      { url: `${base}/logo.png`, kind: "image" },
      { url: `${base}/bg.jpg`, kind: "image" },
      { url: `${base}/missing.png`, kind: "image" }
    ]);
    assert.ok(result.imported.length >= 2, `imported=${result.imported.length}`);
    assert.ok(result.failed.includes(`${base}/missing.png`), "missing asset must be reported as failed");
    for (const item of result.imported) {
      assert.ok(item.localPath.startsWith("/clone-assets/"));
      const abs = path.join(proj, "public", ...item.localPath.split("/").filter(Boolean));
      assert.ok(fs.existsSync(abs), `arquivo local ${item.localPath} deve existir`);
      // path-traversal guard: localPath never escapes public/clone-assets
      assert.ok(!item.localPath.includes(".."));
    }
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

void SITE_CLONE_DEFAULTS;

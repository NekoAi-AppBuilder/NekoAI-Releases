// tests/site-capture.test.ts
// Clonar Site V2 — lógica determinística (validação, assets, CSS, rotas, path).
// A parte Electron (Chromium) exige o app aberto e é coberta por análise, não
// aqui. Executar: node --experimental-strip-types --test tests/site-capture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePublicUrl,
  sameOrigin,
  pathToRoute,
  pathnameToHtmlPath,
  sanitizeSegments,
  assetKindFromUrl,
  isProbablyAssetPath,
  parseSrcset,
  extractCssUrls,
  discoverInternalRoutes,
  hrefToPageRoute,
  assetUrlToLocalPath,
  dedupeAssets
} from "../src/main/site-capture.ts";

const ORIGIN = "https://exemplo.com";

test("validatePublicUrl aceita http/https e bloqueia internos/privados", () => {
  assert.equal(validatePublicUrl("https://exemplo.com").ok, true);
  assert.equal(validatePublicUrl("exemplo.com/sobre").ok, true);
  assert.equal(validatePublicUrl("http://exemplo.com").ok, true);
  assert.equal(validatePublicUrl("file:///etc/passwd").ok, false);
  assert.equal(validatePublicUrl("data:text/html,oi").ok, false);
  assert.equal(validatePublicUrl("ftp://x.com").ok, false);
  assert.equal(validatePublicUrl("http://localhost/x").ok, false);
  assert.equal(validatePublicUrl("http://127.0.0.1/x").ok, false);
  assert.equal(validatePublicUrl("http://[::1]/x").ok, false);
  assert.equal(validatePublicUrl("http://192.168.0.10/x").ok, false);
  assert.equal(validatePublicUrl("http://10.0.0.5/x").ok, false);
  assert.equal(validatePublicUrl("http://169.254.1.1/x").ok, false);
  assert.equal(validatePublicUrl("não é url").ok, false);
});

test("rotas ignoram query/hash e usam pathname", () => {
  assert.equal(hrefToPageRoute("https://exemplo.com/sobre?id=1#x", ORIGIN), "/sobre");
  assert.equal(hrefToPageRoute("https://exemplo.com/", ORIGIN), "/");
  assert.equal(hrefToPageRoute("https://externo.com/sobre", ORIGIN), null);
  assert.equal(pathToRoute("/produtos/"), "/produtos");
  assert.equal(pathToRoute("/"), "/");
});

test("mapeamento de html e sanitização", () => {
  assert.equal(pathnameToHtmlPath("/"), "index.html");
  assert.equal(pathnameToHtmlPath("/sobre"), "sobre/index.html");
  assert.equal(pathnameToHtmlPath("/sobre/"), "sobre/index.html");
  assert.equal(pathnameToHtmlPath("/logo.png"), "logo.png");
  assert.equal(sanitizeSegments("a:b/c<d|e?f"), "a_b/c_d_e_f");
  assert.equal(assetUrlToLocalPath("https://exemplo.com/img/a.png", ORIGIN), "img/a.png");
  assert.ok(String(assetUrlToLocalPath("https://cdn.example.com/x.png", ORIGIN)).startsWith("vendor/"));
});

test("classificação e detecção de assets", () => {
  assert.equal(assetKindFromUrl("https://x.com/a.png"), "image");
  assert.equal(assetKindFromUrl("https://x.com/a.woff2"), "font");
  assert.equal(assetKindFromUrl("https://x.com/a.css"), "style");
  assert.equal(isProbablyAssetPath("/a.jpg"), true);
  assert.equal(isProbablyAssetPath("/sobre"), false);
});

test("srcset", () => {
  const u = parseSrcset("https://x.com/a.jpg 1x, /b.jpg 2x");
  assert.ok(u.includes("https://x.com/a.jpg"));
  assert.ok(u.includes("/b.jpg"));
});

test("extractCssUrls url()/@import", () => {
  const css = "body{background:url(img/b.png)}@import 'https://x.com/f.css';@font-face{src:url(../font.woff2)}";
  const urls = extractCssUrls(css, "https://exemplo.com/style/app.css");
  assert.ok(urls.some((x) => x.includes("img/b.png")));
  assert.ok(urls.some((x) => x.includes("font.woff2")));
  assert.ok(urls.some((x) => x === "https://x.com/f.css"));
  // data: não vira asset
  assert.ok(!urls.some((x) => x.startsWith("data:")));
});

test("discoverInternalRoutes ignora externos/assets/loop e deduplica por rota", () => {
  const hrefs = [
    "https://exemplo.com/sobre",
    "https://exemplo.com/sobre?id=1",
    "https://externo.com/x",
    "https://exemplo.com/logo.png",
    "https://exemplo.com/",
    "mailto:a@b.com",
    "https://exemplo.com/contato"
  ];
  const routes = discoverInternalRoutes(hrefs, ORIGIN, "/", 10);
  assert.ok(routes.includes("/sobre"));
  assert.ok(routes.includes("/contato"));
  assert.ok(!routes.includes("/"));
  assert.ok(!routes.includes("externo"));
  assert.ok(!routes.some((r) => r.includes("logo.png")));
  assert.equal(routes.filter((r) => r === "/sobre").length, 1);
});

test("dedupeAssets por URL", () => {
  const a = dedupeAssets(["https://x.com/a.png", "https://x.com/a.png", "https://x.com/b.css"]);
  assert.equal(a.length, 2);
});

test("sameOrigin", () => {
  assert.equal(sameOrigin("https://exemplo.com/sobre", ORIGIN), true);
  assert.equal(sameOrigin("https://exemplo.com.br/x", ORIGIN), false);
});

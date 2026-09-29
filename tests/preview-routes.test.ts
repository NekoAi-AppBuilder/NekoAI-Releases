// tests/preview-routes.test.ts
// Preview Page Selector — descoberta de rotas, labels, normalização e pesquisa.
// Executar: node --experimental-strip-types --test tests/preview-routes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeRoutePath,
  routeLabelFromPath,
  isDynamicSegment,
  discoverPreviewRoutes,
  routeFromUrl,
  extractJsxRoutePaths,
  extractConfigRoutePaths,
  extractManifestRoutes
} from "../src/main/preview-routes.ts";

// TESTE labels / normalização
test("normalizeRoutePath strips query/hash and trailing slash", () => {
  assert.equal(normalizeRoutePath("/dashboard?foo=bar"), "/dashboard");
  assert.equal(normalizeRoutePath("/dashboard#section"), "/dashboard");
  assert.equal(normalizeRoutePath("dashboard/"), "/dashboard");
  assert.equal(normalizeRoutePath(""), "/");
  assert.equal(normalizeRoutePath("///"), "/");
});

test("route labels", () => {
  assert.equal(routeLabelFromPath("/"), "Home");
  assert.equal(routeLabelFromPath("/dashboard"), "Dashboard");
  assert.equal(routeLabelFromPath("/configuracoes"), "Configuracoes");
  assert.equal(routeLabelFromPath("/meus-produtos"), "Meus Produtos");
  assert.equal(routeLabelFromPath("/admin/users"), "Admin / Users");
});

test("dynamic segment detection", () => {
  assert.equal(isDynamicSegment(":id"), true);
  assert.equal(isDynamicSegment("[id]"), true);
  assert.equal(isDynamicSegment("$id"), true);
  assert.equal(isDynamicSegment("dashboard"), false);
});

test("routeFromUrl strips query/hash and keeps pathname", () => {
  assert.equal(routeFromUrl("http://127.0.0.1:5173/dashboard?foo=bar#x"), "/dashboard");
  assert.equal(routeFromUrl("http://127.0.0.1:5173/"), "/");
});

// TESTE 1: Vite + React com src/pages/ (sem Next/Remix/etc. no package.json)
test("TESTE 1: Vite + React src/pages discovery without file-based router package", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-vite-pages-"));
  fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "pages", "Home.tsx"), "export default function Home(){ return <div>Home</div>; }", "utf8");
  fs.writeFileSync(path.join(dir, "src", "pages", "Contato.tsx"), "export default function Contato(){ return <div>Contato</div>; }", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "vite-react-app", dependencies: { "react": "^18.2.0", "vite": "^5.0.0" } }), "utf8");

  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/"), "deve conter Home /");
  assert.ok(paths.includes("/contato"), "deve descobrir /contato em src/pages");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 2: Subdiretórios em src/pages
test("TESTE 2: Subdirectories in src/pages are discovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-subdirs-"));
  fs.mkdirSync(path.join(dir, "src", "pages", "admin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "pages", "admin", "usuarios.tsx"), "export default function Usuarios(){ return <div/>; }", "utf8");
  fs.writeFileSync(path.join(dir, "src", "pages", "admin", "relatorios.tsx"), "export default function Relatorios(){ return <div/>; }", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "subdirs-app" }), "utf8");

  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/admin/usuarios"), "deve descobrir /admin/usuarios");
  assert.ok(paths.includes("/admin/relatorios"), "deve descobrir /admin/relatorios");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 3: Manifesto src/neko-pages.ts
test("TESTE 3: Explicit manifesto src/neko-pages.ts discovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-manifest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest = `
export const pages = [
  { path: "/sobre", label: "Quem Somos" },
  { path: "/contato", label: "Fale Conosco" },
  { path: "/aulas", title: "Minhas Aulas" }
];
`;
  fs.writeFileSync(path.join(dir, "src", "neko-pages.ts"), manifest, "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "manifest-app" }), "utf8");

  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/sobre"), "deve incluir /sobre");
  assert.ok(paths.includes("/contato"), "deve incluir /contato");
  assert.ok(paths.includes("/aulas"), "deve incluir /aulas");

  const sobre = routes.find(r => r.path === "/sobre");
  assert.equal(sobre?.label, "Quem Somos", "deve usar label customizado do manifesto");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 4: Componentes auxiliares, layouts e services NÃO viram páginas
test("TESTE 4: Non-page components and layouts are excluded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-false-pos-"));
  fs.mkdirSync(path.join(dir, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "layouts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "services"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "pages", "components"), { recursive: true });

  fs.writeFileSync(path.join(dir, "src", "components", "Header.tsx"), "export function Header(){ return <header/>; }", "utf8");
  fs.writeFileSync(path.join(dir, "src", "layouts", "AppLayout.tsx"), "export function AppLayout(){ return <div/>; }", "utf8");
  fs.writeFileSync(path.join(dir, "src", "services", "api.ts"), "export const api = {};", "utf8");
  fs.writeFileSync(path.join(dir, "src", "pages", "components", "PageCard.tsx"), "export function PageCard(){ return <div/>; }", "utf8");
  fs.writeFileSync(path.join(dir, "src", "pages", "Dashboard.tsx"), "export default function Dashboard(){ return <div/>; }", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "clean-app" }), "utf8");

  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/dashboard"), "deve conter /dashboard");
  assert.ok(!paths.includes("/header"), "NÃO deve conter /header");
  assert.ok(!paths.includes("/applayout"), "NÃO deve conter /applayout");
  assert.ok(!paths.includes("/api"), "NÃO deve conter /api");
  assert.ok(!paths.includes("/pages/components/pagecard"), "NÃO deve conter componentes internos");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 5: React Router path: "sobre" (relativo sem barra)
test("TESTE 5: React Router relative paths normalized", () => {
  const code = `
const routes = [
  { path: "sobre", element: <Sobre/> },
  { path: "produtos", element: <Produtos/> }
];
`;
  const extracted = extractConfigRoutePaths(code);
  assert.ok(extracted.includes("/sobre"), "deve normalizar 'sobre' para '/sobre'");
  assert.ok(extracted.includes("/produtos"), "deve normalizar 'produtos' para '/produtos'");
});

// TESTE 6: Rotas aninhadas JSX /admin + usuarios -> /admin/usuarios
test("TESTE 6: Nested JSX <Route> resolution", () => {
  const jsx = `
<Routes>
  <Route path="/admin" element={<AdminLayout/>}>
    <Route index element={<Dashboard/>} />
    <Route path="usuarios" element={<Usuarios/>} />
    <Route path="usuarios/:id" element={<UserDetail/>} />
  </Route>
</Routes>
`;
  const extracted = extractJsxRoutePaths(jsx);
  assert.ok(extracted.includes("/admin"), "deve conter /admin");
  assert.ok(extracted.includes("/admin/usuarios"), "deve resolver /admin/usuarios");
  assert.ok(extracted.includes("/admin/usuarios/:id"), "deve resolver /admin/usuarios/:id");
});

// TESTE 7: Deduplicação entre múltiplas fontes
test("TESTE 7: Deduplication across multiple sources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-dedup-"));
  fs.mkdirSync(path.join(dir, "src", "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "pages", "Contato.tsx"), "export default function Contato(){}", "utf8");
  fs.writeFileSync(path.join(dir, "src", "neko-pages.json"), JSON.stringify([{ path: "/contato", label: "Fale Conosco" }]), "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "dedup" }), "utf8");

  const routes = await discoverPreviewRoutes(dir);
  const contatoMatches = routes.filter(r => r.path === "/contato");
  assert.equal(contatoMatches.length, 1, "deve existir apenas uma rota /contato");
  assert.equal(contatoMatches[0].label, "Fale Conosco", "deve priorizar label do manifesto");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 8: History API fallback (preservado)
test("TESTE 8: History API / pathname routing is discovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-route-manual-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const app = `
const isTutorialsPath = () => window.location.pathname.replace(/\\/+$/, "") === "/tutoriais";
const isLpV2Path = () => window.location.pathname.replace(/\\/+$/, "") === "/lp-v2";
const navigateTo = (path) => { window.history.pushState({}, "", path); };
export function App(){
  return <main>{isTutorialsPath() ? <Tutorials/> : isLpV2Path() ? <LpV2/> : <Home/>}</main>;
}
`;
  fs.writeFileSync(path.join(dir, "src", "App.tsx"), app, "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "manual" }), "utf8");
  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/tutoriais"), "deve incluir /tutoriais (pathname routing)");
  assert.ok(paths.includes("/lp-v2"), "deve incluir /lp-v2 (pathname routing)");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 9: Static HTML discovery (preservado)
test("TESTE 9: Static HTML files discovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-html-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  fs.writeFileSync(path.join(dir, "sobre.html"), "<html></html>", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "html-app" }), "utf8");
  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/"), "deve incluir Home");
  assert.ok(paths.includes("/sobre.html"), "deve incluir sobre.html");
  fs.rmSync(dir, { recursive: true, force: true });
});

// TESTE 10: Watcher filter: apenas alterações em arquivos relevantes disparam reload
test("TESTE 10: Watcher relevant vs irrelevant path filtering", () => {
  function isRelevantPreviewChange(filePath: string): boolean {
    const norm = filePath.toLowerCase().replace(/\\/g, "/");
    return (
      norm.includes("/pages/") || norm.includes("/routes/") || norm.includes("/views/") ||
      norm.includes("/screens/") || norm.includes("neko-pages") || norm.includes("router.") ||
      norm.includes("routes.") || norm.endsWith("app.tsx") || norm.endsWith("app.jsx")
    );
  }

  assert.equal(isRelevantPreviewChange("src/pages/Contato.tsx"), true, "src/pages deve ser relevante");
  assert.equal(isRelevantPreviewChange("src/neko-pages.ts"), true, "neko-pages deve ser relevante");
  assert.equal(isRelevantPreviewChange("src/routes.tsx"), true, "routes.tsx deve ser relevante");
  assert.equal(isRelevantPreviewChange("src/App.tsx"), true, "App.tsx deve ser relevante");
  assert.equal(isRelevantPreviewChange("src/components/Button.tsx"), false, "Button.tsx NÃO deve ser relevante");
  assert.equal(isRelevantPreviewChange("src/services/api.ts"), false, "api.ts NÃO deve ser relevante");
});

// TESTE 11: Race Condition Sequence Protection Simulation
test("TESTE 11: Race Condition Sequence Protection", async () => {
  let activeSeq = 0;
  let finalResult: string | null = null;

  async function simulateRefresh(id: string, delayMs: number) {
    const reqSeq = ++activeSeq;
    await new Promise(r => setTimeout(r, delayMs));
    if (reqSeq === activeSeq) {
      finalResult = id;
    }
  }

  // Request A starts first (slow, 50ms)
  const pA = simulateRefresh("Request A (stale)", 50);
  // Request B starts next (fast, 10ms)
  const pB = simulateRefresh("Request B (newer)", 10);

  await Promise.all([pA, pB]);
  assert.equal(finalResult, "Request B (newer)", "A requisição mais recente B deve prevalecer sobre A");
});

// TESTE 12: Filtragem de pesquisa no seletor (case-insensitive, label e path, empty state)
test("TESTE 12: Search filtering logic in dropdown", () => {
  const routes = [
    { path: "/", label: "Home" },
    { path: "/lp-v2", label: "Lp V2" },
    { path: "/teste-gratis", label: "Teste Gratis" },
    { path: "/tutoriais", label: "Tutoriais" },
    { path: "/contato", label: "Contato" }
  ];

  function filterRoutes(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return routes;
    return routes.filter(r => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }

  // Query vazio -> todas as rotas
  assert.equal(filterRoutes("").length, 5);

  // Busca por "home" -> Home
  const resHome = filterRoutes("home");
  assert.equal(resHome.length, 1);
  assert.equal(resHome[0].path, "/");

  // Busca por "gratis" -> Teste Gratis
  const resGratis = filterRoutes("gratis");
  assert.equal(resGratis.length, 1);
  assert.equal(resGratis[0].label, "Teste Gratis");

  // Busca por "/lp" -> Lp V2
  const resLp = filterRoutes("/lp");
  assert.equal(resLp.length, 1);
  assert.equal(resLp[0].path, "/lp-v2");

  // Busca case-insensitive
  const resTutoriais = filterRoutes("TuToRiAiS");
  assert.equal(resTutoriais.length, 1);
  assert.equal(resTutoriais[0].label, "Tutoriais");

  // Busca sem resultado -> vazio
  const resNone = filterRoutes("xyz123");
  assert.equal(resNone.length, 0);
});

// tests/preview-routes.test.ts
// Preview Page Selector — descoberta de rotas, labels e normalização.
// Executar: node --experimental-strip-types --test tests/preview-routes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeRoutePath,
  routeLabelFromPath,
  isDynamicSegment,
  discoverPreviewRoutes,
  routeFromUrl
} from "../src/main/preview-routes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

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

// TESTE descoberta real a partir de um projeto JSX aninhado
test("discoverPreviewRoutes finds nested relative JSX routes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-route-fixture-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const app = `
import { BrowserRouter, Routes, Route } from "react-router-dom";
export default function App(){
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home/>} />
        <Route path="/admin" element={<AdminLayout/>}>
          <Route index element={<Dashboard/>} />
          <Route path="equipamentos" element={<Equipamentos/>} />
          <Route path="equipamentos/:id" element={<EquipamentoDetail/>} />
          <Route path="relatorios" element={<Relatorios/>} />
          <Route path="configuracoes" element={<Configuracoes/>} />
        </Route>
        <Route path="*" element={<Navigate to="/admin"/>} />
      </Routes>
    </BrowserRouter>
  );
}
`;
  fs.writeFileSync(path.join(dir, "src", "App.tsx"), app, "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: { "react-router-dom": "6" } }), "utf8");

  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/"), "deve incluir Home");
  assert.ok(paths.includes("/admin"), "deve incluir /admin");
  assert.ok(paths.includes("/admin/equipamentos"), "deve resolver filho relativo");
  assert.ok(paths.includes("/admin/relatorios"), "deve resolver filho relativo 2");
  assert.ok(paths.includes("/admin/configuracoes"), "deve resolver filho relativo 3");
  // wildcard "*" e rotas de API nunca devem aparecer
  assert.ok(!paths.some(p => p.includes("*")));
  assert.ok(!paths.some(p => p.startsWith("/api")));
  // "/" deve vir primeiro
  assert.equal(paths[0], "/");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discoverPreviewRoutes returns only Home for a project without router", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-route-norouter-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.tsx"), "console.log('oi')", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "no-router" }), "utf8");
  const routes = await discoverPreviewRoutes(dir);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discoverPreviewRoutes returns only Home for a project without router", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-route-norouter-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.tsx"), "console.log('oi')", "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "no-router" }), "utf8");
  const routes = await discoverPreviewRoutes(dir);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("manual History-API / pathname routing is discovered", async () => {
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

test("createBrowserRouter config array is discovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-route-config-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const app = `
import { createBrowserRouter, RouterProvider } from "react-router-dom";
const router = createBrowserRouter([
  { path: "/", element: <Home/> },
  { path: "/sobre", element: <Sobre/> },
  { path: "/tutoriais", element: <Tutoriais/> }
]);
export default function App(){ return <RouterProvider router={router}/>; }
`;
  fs.writeFileSync(path.join(dir, "src", "App.tsx"), app, "utf8");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "config", dependencies: { "react-router-dom": "6" } }), "utf8");
  const routes = await discoverPreviewRoutes(dir);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes("/sobre"), "deve incluir /sobre");
  assert.ok(paths.includes("/tutoriais"), "deve incluir /tutoriais");
  fs.rmSync(dir, { recursive: true, force: true });
});

void here;

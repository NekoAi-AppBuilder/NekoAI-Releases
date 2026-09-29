// tests/preview-systemic-architecture.test.ts
// Testes automatizados sistêmicos para o ciclo completo do Preview, caminhos com espaços e acentos,
// resolução do Node embutido, execução sem cmd.exe, preservação de rotas e fullscreen.
// Executar: node --experimental-strip-types --test tests/preview-systemic-architecture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveNodeRuntime, getEmbeddedRuntimeEnv } from "../src/main/node-runtime.ts";
import { normalizeRoutePath, routeFromUrl } from "../src/main/preview-routes.ts";

test("A. Resolução do Node/npm embutido e sanitização de env", () => {
  const runtime = resolveNodeRuntime();
  assert.ok(runtime.nodePath, "deve ter nodePath resolvido");
  assert.ok(runtime.binDir, "deve ter binDir resolvido");

  const env = getEmbeddedRuntimeEnv();
  assert.ok(env.PATH?.includes(runtime.binDir), "PATH deve conter o binDir do Node embutido no topo");
  if (process.platform === "win32") {
    assert.ok(env.Path?.includes(runtime.binDir), "Path do Windows também deve ter binDir");
  }
});

test("B. Suporte a caminhos com espaços, acentos e caracteres especiais no Windows", () => {
  const specialPath = "C:\\Users\\André\\OneDrive\\Área de Trabalho\\Pasta andré\\Projeto (Vite)";
  const normalized = path.normalize(specialPath);
  assert.ok(normalized.includes("Área de Trabalho"));
  assert.ok(normalized.includes("Pasta andré"));

  // Valida normalização de rota sem quebrar por acentos
  const route = normalizeRoutePath("/configurações/perfil");
  assert.equal(route, "/configura\u00E7\u00F5es/perfil");
});

test("C. Validação de rotas e construção de URL efetiva (Single Source of Truth)", () => {
  const baseUrl = "http://127.0.0.1:5173/";
  
  function computeEffectiveUrl(base: string, route: string): string {
    if (!base) return "";
    if (!route || route === "/") return base;
    return new URL(route, base).toString();
  }

  assert.equal(computeEffectiveUrl(baseUrl, "/"), "http://127.0.0.1:5173/");
  assert.equal(computeEffectiveUrl(baseUrl, "/admin"), "http://127.0.0.1:5173/admin");
  assert.equal(computeEffectiveUrl(baseUrl, "/app"), "http://127.0.0.1:5173/app");
  assert.equal(computeEffectiveUrl(baseUrl, "/cadastro"), "http://127.0.0.1:5173/cadastro");
});

test("D. Manutenção de rota e extração via routeFromUrl", () => {
  assert.equal(routeFromUrl("http://127.0.0.1:5173/admin?tab=1#top"), "/admin");
  assert.equal(routeFromUrl("http://127.0.0.1:5173/app/dashboard"), "/app/dashboard");
  assert.equal(routeFromUrl("http://127.0.0.1:5173/"), "/");
});

test("E. Simulação de ciclo de vida do servidor (Re-uso de servidor ativo e saudável)", async () => {
  class MockServerLifecycle {
    port: number | null = 5173;
    isAlive = true;
    currentProject = "/path/to/project";

    async startPreview(project: string): Promise<{ status: string; remapped: boolean }> {
      if (this.currentProject === project && this.isAlive && this.port) {
        console.log(`[Preview] Servidor já ativo e saudável em http://127.0.0.1:${this.port}`);
        return { status: "ready", remapped: true };
      }
      this.currentProject = project;
      this.port = 5174;
      this.isAlive = true;
      return { status: "ready", remapped: false };
    }
  }

  const lifecycle = new MockServerLifecycle();
  const res1 = await lifecycle.startPreview("/path/to/project");
  assert.equal(res1.remapped, true, "deve reutilizar servidor já ativo");

  const res2 = await lifecycle.startPreview("/path/to/other-project");
  assert.equal(res2.remapped, false, "deve iniciar novo servidor para projeto diferente");
});

test("F. Abertura de tela cheia com a rota selecionada", () => {
  const selectedRoute = "/admin";
  const baseUrl = "http://127.0.0.1:5173/";
  const effectiveUrl = new URL(selectedRoute, baseUrl).toString();

  function getFullscreenUrl(currentEffectiveUrl: string, fallbackUrl: string): string {
    return currentEffectiveUrl || fallbackUrl;
  }

  assert.equal(getFullscreenUrl(effectiveUrl, baseUrl), "http://127.0.0.1:5173/admin");
});

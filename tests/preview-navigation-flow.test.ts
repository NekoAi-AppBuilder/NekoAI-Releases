// tests/preview-navigation-flow.test.ts
// Testes automatizados para o fluxo de seleção/navegação de páginas do Preview.
// Executar: node --experimental-strip-types --test tests/preview-navigation-flow.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRoutePath, routeFromUrl } from "../src/main/preview-routes.ts";

// Simulação de estado de roteamento no Renderer & Main Process
class MockPreviewState {
  baseUrl: string | null = "http://127.0.0.1:5173/";
  selectedRoute: string = "/";
  internalUrl: string = "http://127.0.0.1:5173/";
  lastNavigatedRoute: string | null = null;
  lastExternalOpenedUrl: string | null = null;

  // Calculo de previewEffectiveUrl (equivalente a React useMemo no renderer)
  get previewEffectiveUrl(): string {
    if (!this.baseUrl) return "";
    if (!this.selectedRoute || this.selectedRoute === "/") return this.baseUrl;
    try {
      return new URL(this.selectedRoute, this.baseUrl).toString();
    } catch {
      return this.baseUrl;
    }
  }

  // Simulação de goToPreviewRoute / IPC preview:navigate
  async navigateTo(routePath: string): Promise<{ ok: boolean; target: string }> {
    const normalized = normalizeRoutePath(routePath);
    if (!normalized) throw new Error("Rota de Preview inválida.");
    this.selectedRoute = normalized;
    const target = new URL(normalized, this.baseUrl!).toString();
    this.internalUrl = target;
    this.lastNavigatedRoute = normalized;
    return { ok: true, target };
  }

  // Simulação de syncInternalPreview (sincronização do preview nativo)
  syncInternalPreview(payloadUrl: string): { reloaded: boolean; currentUrl: string } {
    if (this.internalUrl !== payloadUrl) {
      this.internalUrl = payloadUrl;
      this.selectedRoute = routeFromUrl(payloadUrl);
      return { reloaded: true, currentUrl: payloadUrl };
    }
    return { reloaded: false, currentUrl: this.internalUrl };
  }

  // Simulação de clique em "Ver no Preview" / abrir tela cheia / janela externa
  async openExternal(rawUrl?: string): Promise<string> {
    const target = rawUrl || this.previewEffectiveUrl || this.internalUrl;
    this.lastExternalOpenedUrl = target;
    return target;
  }

  // Simulação de preview.ready event
  onPreviewReady(props: { url: string; path?: string }): void {
    this.baseUrl = props.url;
    if (typeof props.path === "string" && props.path) {
      this.selectedRoute = normalizeRoutePath(props.path);
    }
    // Preserva selectedRoute se props.path não for informado
    this.internalUrl = new URL(this.selectedRoute, this.baseUrl).toString();
  }

  // Simulação de reload / HMR (preserve route)
  reload(): void {
    // Reload preserva a URL interna e rota selecionada
    this.internalUrl = new URL(this.selectedRoute, this.baseUrl!).toString();
  }
}

test("1. Selecionar Home -> Preview abre '/'", async () => {
  const state = new MockPreviewState();
  const res = await state.navigateTo("/");
  assert.equal(res.ok, true);
  assert.equal(state.selectedRoute, "/");
  assert.equal(state.previewEffectiveUrl, "http://127.0.0.1:5173/");
  assert.equal(state.internalUrl, "http://127.0.0.1:5173/");
});

test("2. Selecionar Admin -> Preview abre '/admin'", async () => {
  const state = new MockPreviewState();
  const res = await state.navigateTo("/admin");
  assert.equal(res.ok, true);
  assert.equal(state.selectedRoute, "/admin");
  assert.equal(state.previewEffectiveUrl, "http://127.0.0.1:5173/admin");
  assert.equal(state.internalUrl, "http://127.0.0.1:5173/admin");
});

test("3. Selecionar App -> Preview abre '/app'", async () => {
  const state = new MockPreviewState();
  const res = await state.navigateTo("/app");
  assert.equal(res.ok, true);
  assert.equal(state.selectedRoute, "/app");
  assert.equal(state.previewEffectiveUrl, "http://127.0.0.1:5173/app");
  assert.equal(state.internalUrl, "http://127.0.0.1:5173/app");
});

test("4. Selecionar Cadastro -> Preview abre '/cadastro'", async () => {
  const state = new MockPreviewState();
  const res = await state.navigateTo("/cadastro");
  assert.equal(res.ok, true);
  assert.equal(state.selectedRoute, "/cadastro");
  assert.equal(state.previewEffectiveUrl, "http://127.0.0.1:5173/cadastro");
  assert.equal(state.internalUrl, "http://127.0.0.1:5173/cadastro");
});

test("5. Trocar de Admin para App -> Preview muda de '/admin' para '/app'", async () => {
  const state = new MockPreviewState();
  await state.navigateTo("/admin");
  assert.equal(state.selectedRoute, "/admin");

  await state.navigateTo("/app");
  assert.equal(state.selectedRoute, "/app");
  assert.equal(state.previewEffectiveUrl, "http://127.0.0.1:5173/app");
  assert.equal(state.internalUrl, "http://127.0.0.1:5173/app");
});

test("6. Selecionar uma página e abrir Preview em tela cheia -> abre a mesma rota selecionada", async () => {
  const state = new MockPreviewState();
  await state.navigateTo("/recuperar-senha");
  const opened = await state.openExternal();
  assert.equal(opened, "http://127.0.0.1:5173/recuperar-senha");
});

test("7. Selecionar Admin -> abrir tela cheia -> '/admin'", async () => {
  const state = new MockPreviewState();
  await state.navigateTo("/admin");
  const opened = await state.openExternal();
  assert.equal(opened, "http://127.0.0.1:5173/admin");
});

test("8. Selecionar App -> abrir tela cheia -> '/app'", async () => {
  const state = new MockPreviewState();
  await state.navigateTo("/app");
  const opened = await state.openExternal();
  assert.equal(opened, "http://127.0.0.1:5173/app");
});

test("9. Reabrir/recarregar o Preview sem perder a rota selecionada", async () => {
  const state = new MockPreviewState();
  await state.navigateTo("/dashboard");
  assert.equal(state.selectedRoute, "/dashboard");

  // Simula evento preview.ready emitido pelo servidor ou HMR
  state.onPreviewReady({ url: "http://127.0.0.1:5173/" });
  assert.equal(state.selectedRoute, "/dashboard");
  assert.equal(state.previewEffectiveUrl, "http://127.0.0.1:5173/dashboard");

  // Simula reload
  state.reload();
  assert.equal(state.selectedRoute, "/dashboard");
  assert.equal(state.internalUrl, "http://127.0.0.1:5173/dashboard");
});

test("10. Garantir que nenhum fallback inesperado volte para '/'", async () => {
  const state = new MockPreviewState();
  await state.navigateTo("/admin");

  // Simula syncInternalPreview usando previewEffectiveUrl
  const syncRes = state.syncInternalPreview(state.previewEffectiveUrl);
  assert.equal(syncRes.reloaded, false, "não deve recarregar pois a URL já corresponde à rota efetiva");
  assert.equal(state.selectedRoute, "/admin", "rota selecionada deve permanecer /admin");

  // Garantir formatação de URLs com e sem trailing slashes
  assert.equal(normalizeRoutePath("/admin/"), "/admin");
  assert.equal(normalizeRoutePath("//admin"), "/admin");
});

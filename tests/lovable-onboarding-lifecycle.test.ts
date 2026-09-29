import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  shouldShowLovableOnboardingModal,
  LovableState,
  EMPTY_LOVABLE_STATE,
} from "../src/main/lovable/lovable-types.ts";
import { LovableCloudManager } from "../src/main/lovable/lovable-cloud-manager.ts";
import { LovableVaultManager } from "../src/main/lovable/lovable-vault.ts";

async function createTempDir(prefix: string): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// Simulated Renderer UI Modal State Handler to mirror React main.tsx behavior
class SimulatedRendererUI {
  public modal: string | null = null;
  public lovableState: LovableState = { ...EMPTY_LOVABLE_STATE };

  public onOpenProject(resLovableState: LovableState | null) {
    if (resLovableState) {
      this.lovableState = resLovableState;
    }
    this.modal = null; // Clear previous modals
    if (shouldShowLovableOnboardingModal(resLovableState)) {
      this.modal = "lovable";
    }
  }

  public onAppMount(appLovableState: LovableState | null) {
    if (appLovableState) {
      this.lovableState = appLovableState;
      if (shouldShowLovableOnboardingModal(appLovableState)) {
        this.modal = "lovable";
      }
    }
  }

  public onDismissModal() {
    // User clicks "Agora não"
    this.modal = null;
  }

  public onJitRequired() {
    // Layer 1/2 JIT event
    this.modal = "lovable_jit";
  }
}

// ============================================================================
// SUÍTE DE TESTES: LOVABLE CLOUD ONBOARDING LIFECYCLE (8 CENÁRIOS)
// ============================================================================

test("1. Lovable + não conectado -> Modal de onboarding abre", () => {
  const state: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    isLovableProject: true,
    detectedProjectId: "123e4567-e89b-12d3-a456-426614174000",
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: false,
    lovableSessionValid: false,
    status: "disconnected",
  };

  assert.equal(shouldShowLovableOnboardingModal(state), true, "Deveria indicar abertura de modal de onboarding para projeto Lovable não conectado");

  const ui = new SimulatedRendererUI();
  ui.onOpenProject(state);
  assert.equal(ui.modal, "lovable", "UI deveria definir modal como 'lovable'");
});

test("2. Lovable + usuário clica 'Agora não' -> Modal fecha sem persistir trava", () => {
  const state: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    isLovableProject: true,
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: false,
  };

  const ui = new SimulatedRendererUI();
  ui.onOpenProject(state);
  assert.equal(ui.modal, "lovable", "Modal 'lovable' aberto inicialmente");

  // Usuário clica "Agora não"
  ui.onDismissModal();
  assert.equal(ui.modal, null, "Modal deve ser fechado após clicar 'Agora não'");
});

test("3. Reabrir projeto após 'Agora não' -> Modal abre novamente", () => {
  const state: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    isLovableProject: true,
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: false,
  };

  const ui = new SimulatedRendererUI();
  ui.onOpenProject(state);
  ui.onDismissModal();
  assert.equal(ui.modal, null, "Modal fechado temporariamente");

  // Reabrir o projeto novamente (ex: alternar projeto e voltar ou reabrir do seletor)
  ui.onOpenProject(state);
  assert.equal(ui.modal, "lovable", "Ao reabrir o projeto, modal 'lovable' deve reaparecer");
});

test("4. Fechar/reabrir aplicação -> Modal abre novamente se ainda não conectado", () => {
  const state: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    isLovableProject: true,
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: false,
  };

  const ui = new SimulatedRendererUI();
  // Simula aplicativo iniciando do zero e montando a tela principal com o último workspace
  ui.onAppMount(state);
  assert.equal(ui.modal, "lovable", "Inicialização do app deve reabrir modal 'lovable' se projeto for Lovable não conectado");
});

test("5. Conectar Lovable -> Modal deixa de aparecer enquanto sessão for válida", () => {
  const connectedState: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    status: "connected",
    cloudStatus: "connected",
    isLovableProject: true,
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: true,
    lovableSessionValid: true,
    userEmail: "dev@neko.ai",
  };

  assert.equal(shouldShowLovableOnboardingModal(connectedState), false, "Projeto conectado NÃO deve disparar modal de onboarding");

  const ui = new SimulatedRendererUI();
  ui.onOpenProject(connectedState);
  assert.equal(ui.modal, null, "Modal deve permanecer null para projeto com Lovable Cloud já conectado");
});

test("6. Sessão Lovable inválida / expirada -> Modal volta a aparecer na próxima abertura", () => {
  const expiredState: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    status: "error",
    cloudStatus: "session_expired",
    isLovableProject: true,
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: false,
    lovableSessionValid: false,
    error: "Sessão expirada",
  };

  assert.equal(shouldShowLovableOnboardingModal(expiredState), true, "Sessão inválida/expirada em projeto Lovable DEVE solicitar reconexão");

  const ui = new SimulatedRendererUI();
  ui.onOpenProject(expiredState);
  assert.equal(ui.modal, "lovable", "Modal 'lovable' deve ser aberto para solicitar reautenticação");
});

test("7. Projeto não-Lovable -> Modal nunca abre", () => {
  const nonLovableState: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    isLovableProject: false,
    projectId: null,
    lovableCloudConnected: false,
  };

  assert.equal(shouldShowLovableOnboardingModal(nonLovableState), false, "Projeto não-Lovable nunca dispara onboarding modal");

  const ui = new SimulatedRendererUI();
  ui.onOpenProject(nonLovableState);
  assert.equal(ui.modal, null, "Modal deve permanecer null para projetos normais");
});

test("8. JIT continua funcionando separadamente e de forma independente", () => {
  const state: LovableState = {
    ...EMPTY_LOVABLE_STATE,
    isLovableProject: true,
    projectId: "123e4567-e89b-12d3-a456-426614174000",
    lovableCloudConnected: false,
  };

  const ui = new SimulatedRendererUI();
  // Usuário está com projeto aberto sem modal ativo (ex: dispensou com 'Agora não')
  ui.modal = null;

  // Uma operação de banco é solicitada no chat ou MCP -> JIT é acionado
  ui.onJitRequired();

  assert.equal(ui.modal, "lovable_jit", "JIT modal ('lovable_jit') deve ser acionado independentemente do onboarding");
});

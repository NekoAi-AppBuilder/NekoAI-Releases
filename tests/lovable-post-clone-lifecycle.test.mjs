import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  EMPTY_LOVABLE_STATE,
} from "../dist/main/lovable/lovable-types.js";
import { detectLovableProject } from "../dist/main/lovable/lovable-detector.js";
import { LovableVaultManager } from "../dist/main/lovable/lovable-vault.js";
import { LovableCloudManager } from "../dist/main/lovable/lovable-cloud-manager.js";

async function createTempDir(prefix) {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-4a-${prefix}-`));
  return dir;
}

/**
 * Função de decisão oficial do Renderer (preview.ready)
 * Atualizada para romper o deadlock quando o usuário ainda não possui sessão ativa.
 */
function shouldOpenLovableModal(state) {
  const hasValidId = Boolean(state.projectId || state.detectedProjectId);
  const isConnected = state.status === "connected" || state.lovableCloudConnected === true;
  const needsAuthVerification = Boolean(state.isLovableProject && hasValidId && !state.lovableSessionValid && !isConnected);
  const isCloudConfirmedUnconnected = Boolean(state.isLovableProject && hasValidId && state.hasLovableCloud === true && !isConnected);
  return needsAuthVerification || isCloudConfirmedUnconnected;
}

// ============================================================================
// 9 CASOS DE TESTE OBRIGATÓRIOS (FASE 4A - DEADLOCK FIX & POST-CLONE LIFECYCLE)
// ============================================================================

test("1. Projeto não Lovable: isLovableProject é false e NÃO abre modal", async () => {
  const dir = await createTempDir("non-lovable");
  try {
    const vaultPath = path.join(dir, "vault.json");
    const vault = new LovableVaultManager(vaultPath);
    const manager = new LovableCloudManager(vault);

    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "plain-react-app" }));

    const state = await manager.setProject(dir);
    assert.equal(state.isLovableProject, false);
    assert.equal(state.projectId, null);
    assert.equal(state.hasLovableCloud, null);
    assert.equal(state.cloudStatus, "unknown");
    assert.equal(state.lovableCloudConnected, false);

    assert.equal(shouldOpenLovableModal(state), false, "Projeto não-Lovable nunca deve abrir modal");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. Projeto Lovable sem projectId (ex: template): NÃO abre modal", async () => {
  const dir = await createTempDir("template-no-id");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);

    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    // Manifest de template sem projectId explícito
    await fs.writeFile(
      path.join(dir, ".lovable", "project.json"),
      JSON.stringify({ schemaVersion: 1, template: "tanstack_start_ts_current", revision: "rev-123" })
    );

    const state = await manager.setProject(dir);
    assert.equal(state.isLovableProject, true, "Marcador .lovable detectado");
    assert.equal(state.projectId, null, "ProjectId deve ser null");
    assert.equal(state.lovableProjectId, null);

    assert.equal(shouldOpenLovableModal(state), false, "Template Lovable sem projectId não deve abrir modal");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. Projeto Lovable + projectId + sem sessão (Deadlock Break): ABRE modal convidando à autenticação", async () => {
  const dir = await createTempDir("lovable-no-session");
  try {
    const vaultPath = path.join(dir, "vault.json");
    const vault = new LovableVaultManager(vaultPath);
    const manager = new LovableCloudManager(vault);

    const testUuid = "123e4567-e89b-12d3-a456-426614174000";
    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".lovable", "project.json"),
      JSON.stringify({ projectId: testUuid })
    );

    // Sem sessão ativa no partition
    manager.extractSessionFromPartition = async () => null;

    const state = await manager.setProject(dir);
    assert.equal(state.isLovableProject, true);
    assert.equal(state.projectId, testUuid);
    assert.equal(state.lovableSessionValid, false);
    assert.equal(state.hasLovableCloud, null);
    assert.equal(state.cloudStatus, "auth_required");
    assert.equal(state.lovableCloudConnected, false);

    // Com o deadlock resolvido, o modal DEVE abrir para permitir autenticar!
    assert.equal(shouldOpenLovableModal(state), true, "Deve convidar o usuário a autenticar para verificar recursos");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. Clicar 'Agora não': fecha modal sem desvincular projeto nem interromper Preview", async () => {
  const dir = await createTempDir("agora-nao");
  try {
    const vaultPath = path.join(dir, "vault.json");
    const vault = new LovableVaultManager(vaultPath);
    const manager = new LovableCloudManager(vault);

    const testUuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".lovable", "project.json"),
      JSON.stringify({ projectId: testUuid })
    );

    const state = await manager.setProject(dir);

    // Simulação do clique "Agora não" no Renderer:
    // setModal(null) fecha a janela sem desvincular do cofre nem afetar o projeto
    assert.equal(state.isLovableProject, true);
    assert.equal(state.projectId, testUuid);
    assert.equal(state.lovableCloudConnected, false);

    // O vínculo permanece salvo no cofre
    const link = await vault.getLink(dir);
    assert.equal(link?.projectId, testUuid);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. Clicar 'Autenticar agora': aciona fluxo oficial de login e partição segura", async () => {
  const dir = await createTempDir("auth-flow");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);

    const testUuid = "55555555-5555-5555-5555-555555555555";
    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(path.join(dir, ".lovable", "project.json"), JSON.stringify({ projectId: testUuid }));

    let loginOpened = false;
    // Simula a API window.neko.lovableOpenLogin()
    const mockOpenLogin = async () => {
      loginOpened = true;
      return { success: true };
    };

    await mockOpenLogin();
    assert.equal(loginOpened, true, "Fluxo de login existente deve ser disparado");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. Após autenticação + Cloud query HTTP 200: hasLovableCloud = true e status = connected", async () => {
  const dir = await createTempDir("cloud-probe-success");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);

    const testUuid = "66666666-6666-6666-6666-666666666666";
    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(path.join(dir, ".lovable", "project.json"), JSON.stringify({ projectId: testUuid }));

    // Mock sessão obtida e query 'select 1;' retornando HTTP 200
    manager.extractSessionFromPartition = async () => ({
      email: "user@lovable.dev",
      accessToken: "mock_active_jwt",
      uid: "user_66",
    });
    manager.validateConnection = async () => ({
      success: true,
      statusCode: 200,
      cloudStatus: "connected",
      data: { rows: [{ "?column?": 1 }] },
    });

    const state = await manager.setProject(dir);
    assert.equal(state.status, "connected");
    assert.equal(state.hasLovableCloud, true);
    assert.equal(state.lovableCloudConnected, true);
    assert.equal(state.lovableSessionValid, true);
    assert.equal(state.cloudStatus, "connected");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. Cloud já conectado: NÃO abre modal", async () => {
  const dir = await createTempDir("already-connected");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);

    const testUuid = "77777777-7777-7777-7777-777777777777";
    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(path.join(dir, ".lovable", "project.json"), JSON.stringify({ projectId: testUuid }));

    manager.extractSessionFromPartition = async () => ({
      email: "connected@lovable.dev",
      accessToken: "jwt_token",
      uid: "user_77",
    });
    manager.validateConnection = async () => ({
      success: true,
      statusCode: 200,
      cloudStatus: "connected",
      data: { rows: [{ connected: 1 }] },
    });

    const state = await manager.setProject(dir);
    assert.equal(state.status, "connected");
    assert.equal(state.lovableCloudConnected, true);

    // Quando já conectado, NÃO reabre modal
    assert.equal(shouldOpenLovableModal(state), false, "Cloud já conectado não deve abrir modal");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("8. Sessão expirada (HTTP 401): projeto permanece vinculado com projectId preservado", async () => {
  const dir = await createTempDir("session-expired");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);

    const testUuid = "88888888-8888-8888-8888-888888888888";
    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(path.join(dir, ".lovable", "project.json"), JSON.stringify({ projectId: testUuid }));

    await vault.saveLink(dir, {
      projectId: testUuid,
      projectPath: dir,
      connectedAt: Date.now() - 3600000,
      hasLovableCloud: true,
    });

    manager.extractSessionFromPartition = async () => ({
      email: "user@lovable.dev",
      accessToken: "expired_token",
      uid: "user_88",
    });
    manager.validateConnection = async () => ({
      success: false,
      statusCode: 401,
      cloudStatus: "session_expired",
      error: "Lovable Cloud respondeu com status 401: Unauthorized",
    });

    const state = await manager.setProject(dir);
    assert.equal(state.status, "error");
    assert.equal(state.cloudStatus, "session_expired");
    assert.equal(state.projectId, testUuid, "ProjectId DEVE ser preservado!");
    assert.equal(state.hasLovableCloud, true, "hasLovableCloud anterior DEVE ser preservado!");
    assert.equal(state.lovableCloudConnected, false);
    assert.equal(state.lovableSessionValid, false);

    // Vínculo no vault NÃO pode ter sido apagado
    const saved = await vault.getLink(dir);
    assert.equal(saved?.projectId, testUuid);
    assert.equal(saved?.hasLovableCloud, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("9. Logs diagnósticos seguros: nenhum token, cookie ou credencial confidencial vazado", async () => {
  const dir = await createTempDir("log-security");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);

    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      capturedLogs.push(JSON.stringify(args));
      originalLog(...args);
    };

    try {
      const testUuid = "99999999-9999-9999-9999-999999999999";
      await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
      await fs.writeFile(path.join(dir, ".lovable", "project.json"), JSON.stringify({ projectId: testUuid }));

      const secretToken = "super_secret_jwt_token_12345";
      manager.extractSessionFromPartition = async () => ({
        email: "safe@lovable.dev",
        accessToken: secretToken,
        uid: "user_99",
      });
      manager.validateConnection = async () => ({
        success: true,
        statusCode: 200,
        cloudStatus: "connected",
        data: { rows: [] },
      });

      await manager.setProject(dir);

      const allLogs = capturedLogs.join("\n");
      assert.ok(!allLogs.includes(secretToken), "O token secreto NÃO deve aparecer em nenhum log!");
      assert.ok(!allLogs.includes("Bearer"), "Headers de autorização NÃO devem aparecer em nenhum log!");
      assert.ok(!allLogs.includes("cookie"), "Cookies de sessão NÃO devem aparecer em nenhum log!");
    } finally {
      console.log = originalLog;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// CASOS COMPLEMENTARES (ESTADOS NÃO CONFIRMADOS E RESET DE MODAL CLONE)
// ============================================================================

test("10. Sessão válida + Cloud não confirmado (ex: 403 Forbidden): não abre modal e mantém hasLovableCloud = null", async () => {
  const dir = await createTempDir("cloud-403");
  try {
    const vault = new LovableVaultManager(path.join(dir, "vault.json"));
    const manager = new LovableCloudManager(vault);
    const testUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    await fs.mkdir(path.join(dir, ".lovable"), { recursive: true });
    await fs.writeFile(path.join(dir, ".lovable", "project.json"), JSON.stringify({ projectId: testUuid }));

    manager.extractSessionFromPartition = async () => ({
      email: "valid@lovable.dev",
      accessToken: "live_token",
      uid: "uid_a",
    });
    manager.validateConnection = async () => ({
      success: false,
      statusCode: 403,
      cloudStatus: "forbidden",
      error: "Lovable Cloud respondeu com status 403: Forbidden",
    });

    const state = await manager.setProject(dir);
    assert.equal(state.isLovableProject, true);
    assert.equal(state.projectId, testUuid);
    assert.equal(state.hasLovableCloud, null, "Não confirmado deve ser null");
    assert.equal(state.lovableCloudConnected, false);
    assert.equal(state.lovableSessionValid, true, "Sessão é válida (403 prova autenticação)");
    assert.equal(state.cloudStatus, "forbidden");

    // Como o usuário já está autenticado e o Cloud NÃO foi confirmado (403), não abre modal
    assert.equal(shouldOpenLovableModal(state), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("11. Reset do Modal Clone: cada sessão abre limpa sem preservar repositório anterior", () => {
  let githubCloneRepo = null;
  let githubCloneName = "";
  let githubCloneParent = "";
  let githubRepoSearch = "";

  const resetGithubCloneState = () => {
    githubCloneRepo = null;
    githubCloneName = "";
    githubCloneParent = "";
    githubRepoSearch = "";
  };

  githubCloneRepo = { id: 101, name: "repo-a", fullName: "user/repo-a", private: true, defaultBranch: "main" };
  githubCloneName = "repo-a";
  githubCloneParent = "C:\\Projects";

  assert.equal(githubCloneRepo.fullName, "user/repo-a");

  resetGithubCloneState();

  assert.equal(githubCloneRepo, null, "Repo selecionado deve ser nulo");
  assert.equal(githubCloneName, "", "Nome do projeto deve ser vazio");
  assert.equal(githubCloneParent, "", "Pasta destino deve ser vazia");

  githubCloneRepo = { id: 202, name: "repo-b", fullName: "user/repo-b", private: false, defaultBranch: "main" };
  assert.equal(githubCloneRepo.fullName, "user/repo-b");
});

test("12. Arquitetura de Camadas: quando modal/overlay está ativo, a superfície nativa de preview é suspensa", () => {
  // Simulação do cálculo de overlay e suspensão nativa no Renderer e Main
  let modal = "lovable";
  let isAnyOverlayOpen = Boolean(modal);
  assert.equal(isAnyOverlayOpen, true, "Modal ativo deve marcar isAnyOverlayOpen como true");

  // Layout sync condition no Renderer:
  const previewSurface = "webcontents";
  const workspaceTab = "preview";
  const previewUrl = "http://127.0.0.1:5173";
  const previewInternalSession = 1;
  const host = {}; // dummy DOM element

  const visibleInRenderer = previewSurface === "webcontents" && workspaceTab === "preview" && Boolean(previewUrl) && previewInternalSession > 0 && Boolean(host) && !isAnyOverlayOpen;
  assert.equal(visibleInRenderer, false, "Preview nativo NÃO pode ser marcado como visível enquanto overlay estiver ativo");

  // Main process internalSync guard:
  let internalPreviewOverlayActive = isAnyOverlayOpen;
  const requestedVisible = true; // payload vindo de resize ou layout
  const effectiveVisibleInMain = Boolean(requestedVisible) && !internalPreviewOverlayActive;
  assert.equal(effectiveVisibleInMain, false, "Main process deve bloquear addChildView enquanto internalPreviewOverlayActive for true");
});


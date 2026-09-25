import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  LOVABLE_PROJECT_ID_REGEX,
  LOVABLE_URL_PROJECT_ID_REGEX,
  EMPTY_LOVABLE_STATE,
} from "../src/main/lovable/lovable-types";
import { detectLovableProject } from "../src/main/lovable/lovable-detector";
import {
  LovableVaultManager,
  normalizeVaultProjectPath,
  projectKey,
} from "../src/main/lovable/lovable-vault";
import { LovableCloudManager } from "../src/main/lovable/lovable-cloud-manager";
import { sanitizeErrorMessage } from "../src/shared/error-extractor";

async function createTempDir(prefix: string): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// ============================================================================
// 1. TESTES DE REGEX E FORMATO DE IDENTIFICADORES LOVABLE
// ============================================================================

test("Lovable Types: Validação de regex de ProjectId (UUID)", () => {
  const validUuids = [
    "123e4567-e89b-12d3-a456-426614174000",
    "c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256",
    "A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D",
    "00000000-0000-0000-0000-000000000000",
  ];

  for (const uuid of validUuids) {
    assert.equal(LOVABLE_PROJECT_ID_REGEX.test(uuid), true, `Deveria aceitar UUID: ${uuid}`);
  }

  const invalidUuids = [
    "",
    "not-a-uuid",
    "123e4567-e89b-12d3-a456",
    "123e4567-e89b-12d3-a456-426614174000-extra",
    "123e4567-e89b-12d3-a456-42661417400g", // 'g' não é hexa
    "select * from users;",
    "https://lovable.dev/projects/123",
  ];

  for (const invalid of invalidUuids) {
    assert.equal(LOVABLE_PROJECT_ID_REGEX.test(invalid), false, `Deveria rejeitar UUID inválido: ${invalid}`);
  }
});

test("Lovable Types: Validação de extração de ProjectId por URL do Lovable", () => {
  const testUrls = [
    {
      url: "https://lovable.dev/projects/c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256",
      expected: "c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256",
    },
    {
      url: "https://www.lovable.dev/projects/123e4567-e89b-12d3-a456-426614174000/cloud",
      expected: "123e4567-e89b-12d3-a456-426614174000",
    },
    {
      url: "https://lovable.dev/projects/c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256?tab=database",
      expected: "c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256",
    },
  ];

  for (const item of testUrls) {
    const match = item.url.match(LOVABLE_URL_PROJECT_ID_REGEX);
    assert.ok(match, `Deveria casar com a URL: ${item.url}`);
    assert.equal(match[1], item.expected);
  }

  const nonProjectUrls = [
    "https://lovable.dev/dashboard",
    "https://lovable.dev/login",
    "https://google.com/projects/c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256",
  ];

  for (const url of nonProjectUrls) {
    const match = url.match(LOVABLE_URL_PROJECT_ID_REGEX);
    assert.equal(match, null, `Não deveria extrair de URL não-projeto: ${url}`);
  }
});

// ============================================================================
// 2. TESTES DE DETECTOR LOCAL DE PROJETO LOVABLE
// ============================================================================

test("Lovable Detector: detecta .lovable/project.json com projectId válido", async () => {
  const dir = await createTempDir("detector-json");
  try {
    const lovableDir = path.join(dir, ".lovable");
    await fs.mkdir(lovableDir, { recursive: true });
    await fs.writeFile(
      path.join(lovableDir, "project.json"),
      JSON.stringify({ projectId: "c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256", name: "Meu App" })
    );

    const result = await detectLovableProject(dir);
    assert.equal(result.isLovable, true);
    assert.equal(result.hasLocalConfig, true);
    assert.equal(result.projectId, "c29dfbd1-0e1b-4f51-b844-e3c3b0dfb256");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Lovable Detector: detecta marcador LOVABLE:BEGIN em AGENTS.md", async () => {
  const dir = await createTempDir("detector-agents");
  try {
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "# Project Guidelines\n<!-- LOVABLE:BEGIN -->\nLovable project notes\n<!-- LOVABLE:END -->"
    );

    const result = await detectLovableProject(dir);
    assert.equal(result.isLovable, true);
    assert.equal(result.hasAgentsMarker, true);
    assert.equal(result.hasLocalConfig, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Lovable Detector: detecta projeto sem marcadores como não-Lovable", async () => {
  const dir = await createTempDir("detector-clean");
  try {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "vanilla-project" }));

    const result = await detectLovableProject(dir);
    assert.equal(result.isLovable, false);
    assert.equal(result.hasLocalConfig, false);
    assert.equal(result.hasAgentsMarker, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Lovable Detector: trata caminhos inválidos ou não existentes com segurança", async () => {
  const res1 = await detectLovableProject("");
  assert.equal(res1.isLovable, false);

  const res2 = await detectLovableProject(path.join(os.tmpdir(), "pasta-inexistente-123456789"));
  assert.equal(res2.isLovable, false);
});

// ============================================================================
// 3. TESTES DE NORMALIZAÇÃO DE CAMINHO E HASH DO COFRE
// ============================================================================

test("Lovable Vault: normalização de caminho de projeto e consistência de SHA-256", () => {
  const p1 = "C:\\Projetos\\MeuApp";
  const p2 = "C:\\Projetos\\MeuApp\\";
  const p3 = "c:\\projetos\\meuapp";

  const norm1 = normalizeVaultProjectPath(p1);
  const norm2 = normalizeVaultProjectPath(p2);
  const norm3 = normalizeVaultProjectPath(p3);

  assert.equal(norm1, norm2, "Caminhos com e sem barra final devem normalizar para o mesmo valor");
  assert.equal(norm1, norm3, "Caminhos com letras maiúsculas/minúsculas devem normalizar identicamente");

  const key1 = projectKey(p1);
  const key2 = projectKey(p2);
  const key3 = projectKey(p3);

  assert.equal(key1.length, 64, "A chave deve ser um hash SHA-256 hexadecimal de 64 caracteres");
  assert.equal(key1, key2, "Chaves geradas para variações do mesmo caminho devem ser idênticas");
  assert.equal(key1, key3);
});

// ============================================================================
// 4. TESTES DO COFRE CRIPTOGRAFADO & ISOLAMENTO DE TOKENS
// ============================================================================

test("Lovable Vault: persistência, recuperação e isolamento seguro de vínculos", async () => {
  const tempDir = await createTempDir("vault-test");
  const vaultPath = path.join(tempDir, "lovable-vault.json");

  try {
    const vault = new LovableVaultManager(vaultPath);

    // Inicialmente vazio
    const initial = await vault.loadVault();
    assert.equal(initial.version, 1);
    assert.deepEqual(initial.links, {});

    const projectA = "C:\\Trabalhos\\ProjetoA";
    const projectB = "C:\\Trabalhos\\ProjetoB";
    const uuidA = "11111111-2222-3333-4444-555555555555";
    const uuidB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // Salvar link para Projeto A
    await vault.saveLink(projectA, {
      projectId: uuidA,
      projectPath: projectA,
      connectedAt: 1700000000000,
    });

    // Salvar link para Projeto B
    await vault.saveLink(projectB, {
      projectId: uuidB,
      projectPath: projectB,
      connectedAt: 1700000001000,
    });

    // Recuperar e checar isolamento
    const linkA = await vault.getLink(projectA);
    assert.ok(linkA);
    assert.equal(linkA.projectId, uuidA);

    const linkB = await vault.getLink(projectB);
    assert.ok(linkB);
    assert.equal(linkB.projectId, uuidB);

    // SEGURANÇA: Verificar arquivo em disco para garantir que NENHUM token existe
    const rawOnDisk = await fs.readFile(vaultPath, "utf8");
    assert.equal(rawOnDisk.includes("accessToken"), false, "O cofre em disco NUNCA deve conter accessToken");
    assert.equal(rawOnDisk.includes("jwt"), false, "O cofre em disco NUNCA deve conter jwt");
    assert.equal(rawOnDisk.includes("stsTokenManager"), false, "O cofre em disco NUNCA deve conter stsTokenManager");

    // Remover link do Projeto A
    await vault.removeLink(projectA);
    const linkAAfter = await vault.getLink(projectA);
    assert.equal(linkAAfter, null, "Link do Projeto A deve ter sido removido");

    // Projeto B permanece intacto
    const linkBAfter = await vault.getLink(projectB);
    assert.ok(linkBAfter, "Link do Projeto B deve continuar existindo");
    assert.equal(linkBAfter.projectId, uuidB);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Lovable Vault: resiliência contra arquivo corrompido", async () => {
  const tempDir = await createTempDir("vault-corrupt");
  const vaultPath = path.join(tempDir, "corrupted-vault.json");

  try {
    // Escrever JSON quebrado
    await fs.writeFile(vaultPath, "{ malformed json ::: broken", "utf8");

    const vault = new LovableVaultManager(vaultPath);
    const loaded = await vault.loadVault();

    // Deve recriar um cofre vazio sem lançar exceção fatal
    assert.equal(loaded.version, 1);
    assert.deepEqual(loaded.links, {});
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// 5. TESTES DE GERENCIADOR LOVABLE CLOUD (ESTADO E SEGURANÇA)
// ============================================================================

test("Lovable Manager: getState nunca expõe tokens ou chaves confidenciais", () => {
  const manager = new LovableCloudManager();
  const state = manager.getState();

  assert.deepEqual(state, EMPTY_LOVABLE_STATE);
  assert.equal("accessToken" in (state as any), false, "Estado público não deve ter accessToken");
  assert.equal("jwt" in (state as any), false, "Estado público não deve ter jwt");
  assert.equal("token" in (state as any), false, "Estado público não deve ter token");
});

test("Lovable Manager: validação de parâmetros de conexão", async () => {
  const manager = new LovableCloudManager();

  // Testar com UUID inválido
  const invalidResult = await manager.validateConnection("uuid-invalido", "mock-token");
  assert.equal(invalidResult.success, false);
  assert.ok(invalidResult.error?.includes("inválido"));

  // Testar com token ausente
  const noTokenResult = await manager.validateConnection("123e4567-e89b-12d3-a456-426614174000", "");
  assert.equal(noTokenResult.success, false);
  assert.ok(noTokenResult.error?.includes("autenticada"));
});

test("Lovable Manager: sanitização de mensagens de erro impede vazamento de tokens", () => {
  const rawError = "Erro na requisição POST https://api.lovable.dev com Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN_pL1234567890: 401 Unauthorized";
  const sanitized = sanitizeErrorMessage(rawError);

  assert.equal(sanitized.includes("eyJ"), false, "Token JWT deve ser sanitizado");
  assert.ok(sanitized.includes("Bearer [REDACTED]"), "Bearer deve ser ofuscado");
});

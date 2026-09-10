// tests/app-preferences-and-last-directory.test.ts
// Testes automatizados da persistência e recuperação da última pasta de projetos (lastProjectDirectory)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  AppPreferencesManager,
  extractParentDirectory,
  isValidDirectory
} from "../src/main/app-preferences-manager.ts";
import {
  RecentProjectsManager
} from "../src/main/recent-projects-manager.ts";

test("TESTE 1: Abrir projeto salva a pasta pai e sobrevive ao fechamento e reabertura", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-1-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");

  // Simular pasta de trabalho "Projetos" e subpasta "site-adv"
  const workDir = path.join(tmpDir, "Projetos");
  const projectDir = path.join(workDir, "site-adv");
  await fs.mkdir(projectDir, { recursive: true });

  // Instância 1: Simula NekoAI em execução ao abrir site-adv
  const manager1 = new AppPreferencesManager(prefsFile);
  const savedParent = await manager1.saveLastProjectDirectoryFromProjectPath(projectDir);

  // Deve salvar a pasta pai C:\...\Projetos e NÃO a pasta do projeto site-adv
  assert.equal(savedParent, workDir);
  assert.equal(await manager1.getLastProjectDirectory(), workDir);

  // Instância 2: Simula fechar o NekoAI completamente e reabrir
  const manager2 = new AppPreferencesManager(prefsFile);
  const reloadedDir = await manager2.getLastProjectDirectory();

  assert.equal(reloadedDir, workDir, "Após reabertura, a última pasta utilizada deve ser Projetos");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 2: Criar projeto salva a pasta pai e sobrevive ao fechamento e reabertura", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-2-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");

  // Simular pasta de trabalho "MeusProjetos" e subpasta "NovoProjeto"
  const workDir = path.join(tmpDir, "MeusProjetos");
  const newProjectDir = path.join(workDir, "NovoProjeto");
  await fs.mkdir(newProjectDir, { recursive: true });

  // Instância 1: Simula criação bem-sucedida do novo projeto
  const manager1 = new AppPreferencesManager(prefsFile);
  const savedParent = await manager1.saveLastProjectDirectoryFromProjectPath(newProjectDir);

  assert.equal(savedParent, workDir);
  assert.equal(await manager1.getLastProjectDirectory(), workDir);

  // Instância 2: Simula fechar o NekoAI e reabrir
  const manager2 = new AppPreferencesManager(prefsFile);
  const reloadedDir = await manager2.getLastProjectDirectory();

  assert.equal(reloadedDir, workDir, "Na próxima criação, a pasta inicial do diálogo deve ser MeusProjetos");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 3: Cancelamento de diálogo não altera a última pasta salva", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-3-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");

  const originalWorkDir = path.join(tmpDir, "ProjetosAntigos");
  await fs.mkdir(originalWorkDir, { recursive: true });

  const manager = new AppPreferencesManager(prefsFile);
  await manager.setLastProjectDirectory(originalWorkDir);

  // Usuário abre diálogo, navega por outra pasta mas cancela a operação
  // Nenhuma chamada a saveLastProjectDirectoryFromProjectPath é disparada
  const currentDir = await manager.getLastProjectDirectory();
  assert.equal(currentDir, originalWorkDir, "lastProjectDirectory deve permanecer inalterado ao cancelar");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 4: Pasta que deixa de existir ativa fallback sem gerar erro", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-4-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");

  const ephemeralDir = path.join(tmpDir, "PastaTemporaria");
  await fs.mkdir(ephemeralDir, { recursive: true });

  const manager = new AppPreferencesManager(prefsFile);
  await manager.setLastProjectDirectory(ephemeralDir);

  // Confirmar que estava gravada e válida
  assert.equal(await manager.getLastProjectDirectory(), ephemeralDir);

  // Simular remoção da pasta externamente (excluída, desconectada, movida)
  await fs.rm(ephemeralDir, { recursive: true, force: true });

  // getLastProjectDirectory com validação em disco deve retornar null silenciosamente sem exceção
  let result: string | null = "not-called";
  assert.doesNotThrow(async () => {
    result = await manager.getLastProjectDirectory();
  });

  result = await manager.getLastProjectDirectory();
  assert.equal(result, null, "Deve retornar null para acionar fallback padrão do sistema");

  // No arquivo ainda está a string original, mas não causa erro
  const rawPrefs = await manager.getPreferences();
  assert.equal(rawPrefs.lastProjectDirectory, ephemeralDir);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 5: Alternar entre diferentes diretórios acompanha sempre a última operação bem-sucedida", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-5-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");

  const dirProjetos = path.join(tmpDir, "Projetos", "A");
  const dirClientes = path.join(tmpDir, "Clientes", "B");
  const dirSites = path.join(tmpDir, "Sites", "C");

  await fs.mkdir(dirProjetos, { recursive: true });
  await fs.mkdir(dirClientes, { recursive: true });
  await fs.mkdir(dirSites, { recursive: true });

  const manager = new AppPreferencesManager(prefsFile);

  // 1. Abre Projetos/A -> lastProjectDirectory = Projetos
  await manager.saveLastProjectDirectoryFromProjectPath(dirProjetos);
  assert.equal(await manager.getLastProjectDirectory(), path.dirname(dirProjetos));

  // 2. Abre Clientes/B -> lastProjectDirectory = Clientes
  await manager.saveLastProjectDirectoryFromProjectPath(dirClientes);
  assert.equal(await manager.getLastProjectDirectory(), path.dirname(dirClientes));

  // 3. Abre Sites/C -> lastProjectDirectory = Sites
  await manager.saveLastProjectDirectoryFromProjectPath(dirSites);
  assert.equal(await manager.getLastProjectDirectory(), path.dirname(dirSites));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 6: Primeira execução sem histórico não inventa diretório e retorna null", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-6-"));
  const prefsFile = path.join(tmpDir, "app-preferences-empty.json");

  const manager = new AppPreferencesManager(prefsFile);
  const dir = await manager.getLastProjectDirectory();

  assert.equal(dir, null, "Primeira execução deve retornar null para respeitar o comportamento atual");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 7: Extração segura da pasta pai com caminhos Windows, trailing slashes e raízes", () => {
  // Projeto comum
  const p1 = "C:\\Projetos\\site-adv";
  assert.equal(extractParentDirectory(p1), "C:\\Projetos");

  // Projeto com barra no final
  const p2 = "C:\\Projetos\\site-adv\\";
  assert.equal(extractParentDirectory(p2), "C:\\Projetos");

  // Barras inclinadas comuns no front / Electron
  const p3 = "C:/Projetos/site-adv";
  assert.equal(extractParentDirectory(p3), "C:\\Projetos");

  // Profundidade maior
  const p4 = "D:\\Desenvolvimento\\Clientes\\EmpresaX\\Website";
  assert.equal(extractParentDirectory(p4), "D:\\Desenvolvimento\\Clientes\\EmpresaX");

  // Raiz de unidade
  const rootWin = "C:\\";
  assert.equal(extractParentDirectory(rootWin), "C:\\");

  // Entrada vazia
  assert.equal(extractParentDirectory(""), "");
});

test("TESTE 8: Formato de persistência no arquivo JSON é { lastProjectDirectory: '...' }", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-8-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");

  const testDir = path.join(tmpDir, "Projetos");
  await fs.mkdir(testDir, { recursive: true });

  const manager = new AppPreferencesManager(prefsFile);
  await manager.setLastProjectDirectory(testDir);

  // Leitura direta e crua do arquivo no disco
  const fileRaw = await fs.readFile(prefsFile, "utf8");
  const parsed = JSON.parse(fileRaw);

  assert.ok(typeof parsed === "object");
  assert.equal(parsed.lastProjectDirectory, testDir);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("TESTE 9: Não interferência e separação estrita entre recentProjects e lastProjectDirectory", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-lastdir-9-"));
  const prefsFile = path.join(tmpDir, "app-preferences.json");
  const recentFile = path.join(tmpDir, "recent-projects.json");

  const workDir = path.join(tmpDir, "MeusTrabalhos");
  const projA = path.join(workDir, "ProjetoA");
  const projB = path.join(workDir, "ProjetoB");

  await fs.mkdir(projA, { recursive: true });
  await fs.mkdir(projB, { recursive: true });

  const prefsManager = new AppPreferencesManager(prefsFile);
  const recentManager = new RecentProjectsManager(recentFile);

  // Abrir ProjetoA
  await recentManager.touchRecentProject(projA);
  await prefsManager.saveLastProjectDirectoryFromProjectPath(projA);

  // Abrir ProjetoB
  await recentManager.touchRecentProject(projB);
  await prefsManager.saveLastProjectDirectoryFromProjectPath(projB);

  // recentProjects deve conter a lista com histórico detalhado dos projetos
  const recentList = await recentManager.getRecentProjects();
  assert.equal(recentList.length, 2);
  assert.equal(recentList[0].name, "ProjetoB");
  assert.equal(recentList[1].name, "ProjetoA");

  // lastProjectDirectory deve conter apenas a string da pasta pai onde o usuário trabalha
  const lastDir = await prefsManager.getLastProjectDirectory();
  assert.equal(lastDir, workDir);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

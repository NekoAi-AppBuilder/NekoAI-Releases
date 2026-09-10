// tests/universal-recent-projects.test.ts
// Testes automatizados do Suporte Universal a Projetos Recentes (Requisitos 13 a 30)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  RecentProjectsManager,
  detectProjectTechnology,
  checkProjectExistsOnDisk,
  normalizeProjectPath,
  areProjectPathsEqual,
  extractFriendlyProjectName,
  MAX_RECENT_PROJECTS,
  type RecentProjectItem
} from "../src/main/recent-projects-manager.ts";

test("1. Suporte Universal: projetos sem package.json (HTML puro, Python, PHP, Java, etc.) entram normalmente", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-universal-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  // Criar workspace HTML puro sem package.json
  const htmlProject = path.join(tmpDir, "site-advocacia");
  await fs.mkdir(htmlProject, { recursive: true });
  await fs.writeFile(path.join(htmlProject, "index.html"), "<!DOCTYPE html><html><body>Advocacia</body></html>");

  // Registrar projeto
  const list1 = await manager.touchRecentProject(htmlProject);
  assert.equal(list1.length, 1);
  assert.equal(list1[0].name, "site-advocacia");
  assert.equal(list1[0].technology, "HTML / CSS / JavaScript");
  assert.ok(list1[0].lastOpenedAt > 0);

  // Criar workspace Python puro sem package.json
  const pythonProject = path.join(tmpDir, "api-financeira");
  await fs.mkdir(pythonProject, { recursive: true });
  await fs.writeFile(path.join(pythonProject, "requirements.txt"), "fastapi==0.100.0\nuvicorn\n");
  await fs.writeFile(path.join(pythonProject, "main.py"), "from fastapi import FastAPI\napp = FastAPI()");

  const list2 = await manager.touchRecentProject(pythonProject);
  assert.equal(list2.length, 2);
  assert.equal(list2[0].name, "api-financeira");
  assert.equal(list2[0].technology, "Python / FastAPI");

  // Limpeza
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("2. Detecção agnóstica de tecnologia em múltiplos ecossistemas", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-tech-"));

  // React + Vite
  const reactVite = path.join(tmpDir, "neko-clinica");
  await fs.mkdir(reactVite, { recursive: true });
  await fs.writeFile(path.join(reactVite, "package.json"), JSON.stringify({
    name: "neko-clinica",
    dependencies: { "react": "^18.2.0" },
    devDependencies: { "vite": "^5.0.0" }
  }));
  assert.equal(await detectProjectTechnology(reactVite), "React + Vite");

  // PHP Laravel
  const laravelProject = path.join(tmpDir, "laravel-app");
  await fs.mkdir(laravelProject, { recursive: true });
  await fs.writeFile(path.join(laravelProject, "artisan"), "#!/usr/bin/env php");
  assert.equal(await detectProjectTechnology(laravelProject), "PHP / Laravel");

  // Java Spring
  const javaProject = path.join(tmpDir, "spring-service");
  await fs.mkdir(javaProject, { recursive: true });
  await fs.writeFile(path.join(javaProject, "pom.xml"), "<project><dependencies><dependency><groupId>org.springframework.boot</groupId></dependency></dependencies></project>");
  assert.equal(await detectProjectTechnology(javaProject), "Java / Spring");

  // Go
  const goProject = path.join(tmpDir, "go-microservice");
  await fs.mkdir(goProject, { recursive: true });
  await fs.writeFile(path.join(goProject, "go.mod"), "module github.com/user/service\ngo 1.21");
  assert.equal(await detectProjectTechnology(goProject), "Go");

  // Rust
  const rustProject = path.join(tmpDir, "rust-cli");
  await fs.mkdir(rustProject, { recursive: true });
  await fs.writeFile(path.join(rustProject, "Cargo.toml"), "[package]\nname = \"rust-cli\"\nversion = \"0.1.0\"");
  assert.equal(await detectProjectTechnology(rustProject), "Rust");

  // Projeto vazio / desconhecido (fallback: "Projeto", nunca bloqueia)
  const unknownProject = path.join(tmpDir, "generic-folder");
  await fs.mkdir(unknownProject, { recursive: true });
  await fs.writeFile(path.join(unknownProject, "anotacoes.txt"), "notas do projeto");
  assert.equal(await detectProjectTechnology(unknownProject), "Projeto");

  // Limpeza
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("3. Ordenamento: abrir um projeto antigo faz ele subir para o topo sem duplicatas", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-order-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  const projA = path.join(tmpDir, "projeto-a");
  const projB = path.join(tmpDir, "projeto-b");
  const projC = path.join(tmpDir, "projeto-c");
  await fs.mkdir(projA, { recursive: true });
  await fs.mkdir(projB, { recursive: true });
  await fs.mkdir(projC, { recursive: true });

  await manager.touchRecentProject(projA);
  await new Promise(r => setTimeout(r, 10));
  await manager.touchRecentProject(projB);
  await new Promise(r => setTimeout(r, 10));
  await manager.touchRecentProject(projC);

  let list = await manager.getRecentProjects();
  assert.equal(list.length, 3);
  assert.equal(list[0].name, "projeto-c");
  assert.equal(list[1].name, "projeto-b");
  assert.equal(list[2].name, "projeto-a");

  // Reabrir projeto A: deve subir ao topo
  await new Promise(r => setTimeout(r, 10));
  await manager.touchRecentProject(projA);

  list = await manager.getRecentProjects();
  assert.equal(list.length, 3, "Não deve duplicar");
  assert.equal(list[0].name, "projeto-a", "Projeto A deve ser o primeiro da lista");
  assert.equal(list[1].name, "projeto-c");
  assert.equal(list[2].name, "projeto-b");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("4. Normalização de caminhos e projetos com mesmo nome em pastas pai diferentes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-paths-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  // Duas empresas com pastas chamadas "site"
  const empASite = path.join(tmpDir, "EmpresaA", "site");
  const empBSite = path.join(tmpDir, "EmpresaB", "site");
  await fs.mkdir(empASite, { recursive: true });
  await fs.mkdir(empBSite, { recursive: true });

  await manager.touchRecentProject(empASite);
  await manager.touchRecentProject(empBSite);

  const list = await manager.getRecentProjects();
  assert.equal(list.length, 2, "Projetos com mesmo nome em diretórios diferentes devem ser mantidos como 2 registros");
  assert.ok(list.some(p => p.path === normalizeProjectPath(empASite)));
  assert.ok(list.some(p => p.path === normalizeProjectPath(empBSite)));

  // Teste de normalização com barras diferentes e trailing slashes
  const slashVariation = empASite.replace(/\\/g, "/") + "/";
  await manager.touchRecentProject(slashVariation);

  const listAfter = await manager.getRecentProjects();
  assert.equal(listAfter.length, 2, "Variação de barras do mesmo caminho não pode gerar duplicata");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("5. Limite de 20 projetos com preservação estrita de favoritos", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-limit-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  // Criar 25 projetos
  for (let i = 1; i <= 25; i++) {
    const p = path.join(tmpDir, `project-${String(i).padStart(2, "0")}`);
    await fs.mkdir(p, { recursive: true });
    // Marcar os projetos 1 e 2 como favoritos
    const isFav = i === 1 || i === 2;
    await manager.touchRecentProject(p, { favorite: isFav });
  }

  const list = await manager.getRecentProjects();
  // Os favoritos 1 e 2 devem continuar existindo, mesmo tendo sido criados no início!
  const fav1 = list.find(p => p.name === "project-01");
  const fav2 = list.find(p => p.name === "project-02");
  assert.ok(fav1, "Favorito 1 não pode ter sido removido pelo limite");
  assert.ok(fav1.favorite);
  assert.ok(fav2, "Favorito 2 não pode ter sido removido pelo limite");
  assert.ok(fav2.favorite);

  // Total de não-favoritos não deve exceder MAX_RECENT_PROJECTS (20)
  const nonFavorites = list.filter(p => !p.favorite);
  assert.ok(nonFavorites.length <= MAX_RECENT_PROJECTS);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("6. Projeto que não existe mais: marcado como missing, não cria pasta, permite remoção", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-missing-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  const testProject = path.join(tmpDir, "projeto-temporario");
  await fs.mkdir(testProject, { recursive: true });
  await fs.writeFile(path.join(testProject, "index.html"), "<h1>Olá</h1>");

  await manager.touchRecentProject(testProject);

  // Simular que o usuário deletou a pasta externamente
  await fs.rm(testProject, { recursive: true, force: true });

  assert.equal(await checkProjectExistsOnDisk(testProject), false);

  // getRecentProjectsWithStatus deve enriquecer com missing: true
  const list = await manager.getRecentProjectsWithStatus();
  assert.equal(list.length, 1);
  assert.equal(list[0].missing, true, "Deve marcar missing: true");
  assert.equal(await checkProjectExistsOnDisk(testProject), false, "NÃO deve ter recriado a pasta");

  // Remover do histórico
  const afterRemove = await manager.removeRecentProject(testProject);
  assert.equal(afterRemove.length, 0, "Deve remover com sucesso do histórico");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("7. Persistência em disco: sobrevive ao fechamento e reabertura", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-persist-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");

  const proj = path.join(tmpDir, "meu-saas");
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, "package.json"), JSON.stringify({ name: "meu-saas", dependencies: { next: "14.0.0" } }));

  // Instância 1: cria e salva
  const manager1 = new RecentProjectsManager(storageFile);
  await manager1.touchRecentProject(proj, { favorite: true });

  // Instância 2 (simulando reabertura do aplicativo): carrega do mesmo arquivo
  const manager2 = new RecentProjectsManager(storageFile);
  const loaded = await manager2.getRecentProjects();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "meu-saas");
  assert.equal(loaded[0].technology, "Next.js");
  assert.equal(loaded[0].favorite, true);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("8. Thumbnail: reconciliação automática de .neko/thumbnail.png no disco", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-thumb-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  const proj = path.join(tmpDir, "site-adv");
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, "index.html"), "<h1>Advocacia</h1>");

  // Projeto inicialmente sem thumbnail
  await manager.touchRecentProject(proj);
  const initial = await manager.getRecentProjectsWithStatus();
  assert.equal(initial.length, 1);
  assert.equal(initial[0].thumbnail, null);

  // Agora cria a thumbnail real em .neko/thumbnail.png (como ocorre após o Preview)
  const nekoDir = path.join(proj, ".neko");
  await fs.mkdir(nekoDir, { recursive: true });
  const fakePngBuffer = Buffer.from("fake-png-content-neko");
  await fs.writeFile(path.join(nekoDir, "thumbnail.png"), fakePngBuffer);

  // getRecentProjectsWithStatus deve reconciliar automaticamente a miniatura real!
  const withThumb = await manager.getRecentProjectsWithStatus();
  assert.equal(withThumb.length, 1);
  assert.ok(withThumb[0].thumbnail?.startsWith("data:image/png;base64,"));
  assert.equal(withThumb[0].thumbnailPath, path.join(nekoDir, "thumbnail.png"));
  assert.ok(withThumb[0].thumbnailUpdatedAt && withThumb[0].thumbnailUpdatedAt > 0);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("9. Thumbnail: updateProjectThumbnail atualiza cirurgicamente e persiste metadados", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-update-thumb-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  const projA = path.join(tmpDir, "proj-a");
  const projB = path.join(tmpDir, "proj-b");
  await fs.mkdir(projA, { recursive: true });
  await fs.mkdir(projB, { recursive: true });

  await manager.touchRecentProject(projA);
  await manager.touchRecentProject(projB);

  const now = Date.now();
  await manager.updateProjectThumbnail(projA, {
    thumbnail: "data:image/png;base64,abc123",
    thumbnailPath: path.join(projA, ".neko", "thumbnail.png"),
    thumbnailUpdatedAt: now,
    previewUrl: "http://127.0.0.1:4123"
  });

  const list = await manager.getRecentProjects();
  const foundA = list.find(p => p.name === "proj-a");
  const foundB = list.find(p => p.name === "proj-b");

  assert.ok(foundA);
  assert.equal(foundA.thumbnail, "data:image/png;base64,abc123");
  assert.equal(foundA.thumbnailPath, path.join(projA, ".neko", "thumbnail.png"));
  assert.equal(foundA.thumbnailUpdatedAt, now);
  assert.equal(foundA.previewUrl, "http://127.0.0.1:4123");

  assert.ok(foundB);
  assert.equal(foundB.thumbnail, null, "Proj B não deve ter sofrido alteração na miniatura");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("10. Thumbnail: projetos com mesmo nome em diretórios diferentes possuem miniaturas independentes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-test-same-name-thumb-"));
  const storageFile = path.join(tmpDir, "recent-projects.json");
  const manager = new RecentProjectsManager(storageFile);

  const dir1 = path.join(tmpDir, "cliente1", "site");
  const dir2 = path.join(tmpDir, "cliente2", "site");
  await fs.mkdir(dir1, { recursive: true });
  await fs.mkdir(dir2, { recursive: true });

  await manager.touchRecentProject(dir1);
  await manager.touchRecentProject(dir2);

  await manager.updateProjectThumbnail(dir1, {
    thumbnail: "data:image/png;base64,cliente1thumb",
    previewUrl: "http://127.0.0.1:3001"
  });
  await manager.updateProjectThumbnail(dir2, {
    thumbnail: "data:image/png;base64,cliente2thumb",
    previewUrl: "http://127.0.0.1:3002"
  });

  const list = await manager.getRecentProjects();
  const c1 = list.find(p => areProjectPathsEqual(p.path, dir1));
  const c2 = list.find(p => areProjectPathsEqual(p.path, dir2));

  assert.ok(c1);
  assert.ok(c2);
  assert.equal(c1.thumbnail, "data:image/png;base64,cliente1thumb");
  assert.equal(c2.thumbnail, "data:image/png;base64,cliente2thumb");
  assert.notEqual(c1.thumbnail, c2.thumbnail, "Miniaturas devem ser totalmente independentes");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

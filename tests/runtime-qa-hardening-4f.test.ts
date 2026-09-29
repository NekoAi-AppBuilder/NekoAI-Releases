// tests/runtime-qa-hardening-4f.test.ts
// Suíte de Testes de Hardening Final e QA — NekoAI Fase 4F

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { RuntimeManager } from "../src/main/runtime/runtime-manager";
import { RuntimeStore } from "../src/main/runtime/runtime-store";
import { RuntimeProvisioner } from "../src/main/runtime/runtime-provisioner";
import { RuntimeDownloader } from "../src/main/runtime/runtime-downloader";
import { RuntimeProvisioningOrchestrator } from "../src/main/runtime/runtime-provisioning-orchestrator";
import { RuntimeLifecycleManager } from "../src/main/runtime/runtime-lifecycle";
import { PythonProvider } from "../src/main/runtime/providers";
import { RuntimeDescriptor } from "../src/main/runtime/runtime-types";

function createTempDir(prefix: string): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), `neko-4f-qa-${prefix}-`));
}

const defaultAuth = { approved: true, source: "user-ui" as const };

test("1. HARDENING: Global PATH Immutability (before === after)", async () => {
  const beforePATH = process.env.PATH;

  const baseDir = createTempDir("global-path");
  const manager = new RuntimeManager({
    storeOptions: { baseDir },
  });

  // Executar diversas APIs do Runtime Manager
  await manager.listRuntimes();
  await manager.detectProjectTechnologies(baseDir);
  await manager.evaluateProjectRequirements(baseDir);
  await manager.getOpenCodeScopedEnv(baseDir);
  await manager.resolveRuntimeEnvironment("python-3.12.8");

  const afterPATH = process.env.PATH;

  assert.equal(
    beforePATH,
    afterPATH,
    "GARANTIA ARQUITETURAL: process.env.PATH global DEVE permanecer 100% inalterado antes e depois das operações."
  );

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("2. IDEMPOTÊNCIA: Solicitação dupla para runtime já instalado não rebaixa nem sobrescreve", async () => {
  const baseDir = createTempDir("idempotency");
  const store = new RuntimeStore({ baseDir });

  // Criar um runtime mockado fisicamente como READY
  const runtimeDir = path.join(baseDir, "runtimes", "python-3.12.8");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "python.exe"), "mock python executable");

  const descriptor: RuntimeDescriptor = {
    id: "python-3.12.8",
    name: "Python",
    version: "3.12.8",
    category: "provisioned",
    installDir: runtimeDir,
    binDirs: ["."],
    executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    status: "ready",
    installedAt: new Date().toISOString(),
    environmentVariables: { PYTHONUNBUFFERED: "1" },
  };

  await store.registerRuntime(descriptor);

  let downloadCalled = false;
  const mockDownloader = {
    download: async () => {
      downloadCalled = true;
      return { success: false, error: "Download NÃO deveria ter sido chamado para runtime já instalado!" };
    },
  } as unknown as RuntimeDownloader;

  const orchestrator = new RuntimeProvisioningOrchestrator({
    store,
    downloader: mockDownloader,
    getProvider: () => new PythonProvider(),
  });

  // 1ª Requisição
  const result1 = await orchestrator.requestProvisioning(
    {
      runtimeId: "python",
      version: "3.12.8",
      platform: process.platform as any,
      architecture: process.arch as any,
      reason: "Teste idempotência 1",
    },
    defaultAuth
  );

  assert.equal(result1.status, "already-installed", `Erro inesperado: ${result1.error}`);
  assert.equal(downloadCalled, false);

  // 2ª Requisição
  const result2 = await orchestrator.requestProvisioning(
    {
      runtimeId: "python",
      version: "3.12.8",
      platform: process.platform as any,
      architecture: process.arch as any,
      reason: "Teste idempotência 2",
    },
    defaultAuth
  );

  assert.equal(result2.status, "already-installed");
  assert.equal(downloadCalled, false);

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("3. CONCORRÊNCIA: Duas solicitações simultâneas para o mesmo runtime usam trava e evitam duplicação", async () => {
  const baseDir = createTempDir("concurrency");
  const store = new RuntimeStore({ baseDir });

  let downloadCount = 0;
  const mockDownloader = {
    download: async (opts: any) => {
      downloadCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.mkdir(path.dirname(opts.destinationPath), { recursive: true });
      await fs.writeFile(opts.destinationPath, "mock archive content");
      return { success: true, downloadPath: opts.destinationPath };
    },
  } as unknown as RuntimeDownloader;

  const mockProvisioner = {
    provision: async (req: any) => {
      const targetDir = path.join(store.getBaseDir(), "runtimes", req.id);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "python.exe"), "mock python");

      const descriptor: RuntimeDescriptor = {
        id: req.id,
        name: req.name,
        version: req.version,
        category: "provisioned",
        installDir: targetDir,
        binDirs: ["."],
        executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
        status: "ready",
        installedAt: new Date().toISOString(),
        environmentVariables: req.environmentVariables || {},
      };

      await store.registerRuntime(descriptor);
      return { success: true, descriptor };
    },
  } as unknown as RuntimeProvisioner;

  const provider = new PythonProvider();
  const orchestrator = new RuntimeProvisioningOrchestrator({
    store,
    downloader: mockDownloader,
    provisioner: mockProvisioner,
    getProvider: () => provider,
  });

  const request = {
    runtimeId: "python",
    version: "3.12.8",
    platform: process.platform as any,
    architecture: process.arch as any,
    reason: "Teste concorrência",
  };

  // Disparar duas promessas simultaneamente
  const [res1, res2] = await Promise.all([
    orchestrator.requestProvisioning(request, defaultAuth),
    orchestrator.requestProvisioning(request, defaultAuth),
  ]);

  assert.equal(downloadCount, 1, "O download DEVE ser executado apenas 1 vez devido à trava de concorrência!");
  assert.equal(res1.status, "installed");
  assert.equal(res2.status, "already-in-progress");

  const runtimes = await store.listRuntimes();
  assert.equal(runtimes.length, 1, "O manifesto do Store DEVE possuir exatamente 1 registro no final.");

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("4. FALHA DE DOWNLOAD: SHA-256 incorreto limpa arquivo temporário e não registra no Store", async () => {
  const baseDir = createTempDir("failed-download");
  const store = new RuntimeStore({ baseDir });

  const mockDownloader = {
    download: async () => {
      return {
        success: false,
        error: "SHA256_MISMATCH: Hash calculado não confere com o esperado.",
      };
    },
  } as unknown as RuntimeDownloader;

  const provider = new PythonProvider();
  const orchestrator = new RuntimeProvisioningOrchestrator({
    store,
    downloader: mockDownloader,
    getProvider: () => provider,
  });

  const res = await orchestrator.requestProvisioning(
    {
      runtimeId: "python",
      version: "3.12.8",
      platform: process.platform as any,
      architecture: process.arch as any,
      reason: "Teste SHA256 Incorreto",
    },
    defaultAuth
  );

  assert.equal(res.status, "failed");
  assert.match(res.error || "", /SHA256_MISMATCH/);

  const descriptor = await store.getRuntime("python-3.12.8");
  assert.equal(descriptor, null, "O Store NÃO pode registrar runtime com falha de download!");

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("5. FALHA DE PROVISIONAMENTO: ZIP inválido/extração limpa staging e não deixa READY falso", async () => {
  const baseDir = createTempDir("failed-provision");
  const store = new RuntimeStore({ baseDir });

  const mockDownloader = {
    download: async (opts: any) => {
      await fs.mkdir(path.dirname(opts.destinationPath), { recursive: true });
      await fs.writeFile(opts.destinationPath, "corrupt zip content");
      return { success: true, downloadPath: opts.destinationPath };
    },
  } as unknown as RuntimeDownloader;

  const mockProvisioner = {
    provision: async () => {
      return {
        success: false,
        error: "EXTRACTION_FAILED: O arquivo baixado não é um arquivo ZIP válido.",
      };
    },
  } as unknown as RuntimeProvisioner;

  const provider = new PythonProvider();
  const orchestrator = new RuntimeProvisioningOrchestrator({
    store,
    downloader: mockDownloader,
    provisioner: mockProvisioner,
    getProvider: () => provider,
  });

  const res = await orchestrator.requestProvisioning(
    {
      runtimeId: "python",
      version: "3.12.8",
      platform: process.platform as any,
      architecture: process.arch as any,
      reason: "Teste ZIP inválido",
    },
    defaultAuth
  );

  assert.equal(res.status, "rolled-back");
  assert.match(res.error || "", /EXTRACTION_FAILED/);

  const descriptor = await store.getRuntime("python-3.12.8");
  assert.equal(descriptor, null, "O Store NÃO deve conter registro após falha de extração!");

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("6. INCONSISTÊNCIA E RECUPERAÇÃO: Runtime corrompido (pasta deletada) é detectado como INCONSISTENT e re-provisionado para READY", async () => {
  const baseDir = createTempDir("recovery");

  const manager = new RuntimeManager({ storeOptions: { baseDir } });
  const store = manager.getStore();

  const mockDownloader = {
    download: async (opts: any) => {
      await fs.mkdir(path.dirname(opts.destinationPath), { recursive: true });
      await fs.writeFile(opts.destinationPath, "mock archive");
      return { success: true, downloadPath: opts.destinationPath };
    },
  } as unknown as RuntimeDownloader;

  const mockProvisioner = {
    provision: async (req: any) => {
      const targetDir = path.join(store.getBaseDir(), "runtimes", req.id);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "python.exe"), "restored python exec");

      const descriptor: RuntimeDescriptor = {
        id: req.id,
        name: req.name,
        version: req.version,
        category: "provisioned",
        installDir: targetDir,
        binDirs: ["."],
        executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
        status: "ready",
        installedAt: new Date().toISOString(),
        environmentVariables: req.environmentVariables || {},
      };

      await store.registerRuntime(descriptor);
      return { success: true, descriptor };
    },
  } as unknown as RuntimeProvisioner;

  const orchestrator = new RuntimeProvisioningOrchestrator({
    store,
    downloader: mockDownloader,
    provisioner: mockProvisioner,
    getProvider: (id) => manager.getProvider(id),
  });

  const lifecycle = new RuntimeLifecycleManager({
    runtimeManager: manager,
    orchestrator,
  });

  // 1. Criar registro inicial
  const runtimeDir = path.join(baseDir, "runtimes", "python-3.12.8");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "python.exe"), "mock python");

  const descriptor: RuntimeDescriptor = {
    id: "python-3.12.8",
    name: "Python",
    version: "3.12.8",
    category: "provisioned",
    installDir: runtimeDir,
    binDirs: ["."],
    executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    status: "ready",
    installedAt: new Date().toISOString(),
  };
  await store.registerRuntime(descriptor);

  // Criar pasta de projeto simulada com requirements.txt
  const projectDir = path.join(baseDir, "my-python-app");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask==3.0.0");

  // Avaliação 1: Deve estar READY
  const reqs1 = await manager.evaluateProjectRequirements(projectDir);
  assert.equal(reqs1[0].state, "ready");

  // 2. Corromper: deletar a pasta física
  await fs.rm(runtimeDir, { recursive: true, force: true });

  // Avaliação 2: Deve ser detectado como INCONSISTENT
  const reqs2 = await manager.evaluateProjectRequirements(projectDir);
  assert.equal(reqs2[0].state, "inconsistent");
  assert.equal(reqs2[0].issue, "PHYSICAL_DIRECTORY_MISSING");

  // Confirmar que runtime inconsistente NÃO entra no PATH do OpenCode
  const scopedEnv = await manager.getOpenCodeScopedEnv(projectDir);
  const pathValue = scopedEnv.PATH || scopedEnv.Path || "";
  assert.equal(
    pathValue.includes("python-3.12.8"),
    false,
    "Runtime INCONSISTENT NÃO pode ser incluído no PATH do OpenCode!"
  );

  // Remover o registro corrompido para permitir reinstalação limpa
  await store.unregisterRuntime("python-3.12.8");

  // 3. Recuperação: Autorizar novo provisionamento
  const provResult = await lifecycle.authorizeAndProvision(reqs2[0], defaultAuth);

  assert.equal(provResult.status, "installed");

  // Avaliação 3: Após recuperação, o estado DEVE ser READY novamente
  const reqs3 = await manager.evaluateProjectRequirements(projectDir);
  assert.equal(reqs3[0].state, "ready");

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("7. COEXISTÊNCIA DE VERSÕES: Python 3.12.8 e Python 3.13.1 coexistem sem sobrescrita ou interferência", async () => {
  const baseDir = createTempDir("versions");
  const store = new RuntimeStore({ baseDir });

  // Instalar Python 3.12.8
  const dir12 = path.join(baseDir, "runtimes", "python-3.12.8");
  await fs.mkdir(dir12, { recursive: true });
  await fs.writeFile(path.join(dir12, "python.exe"), "python 3.12.8");

  await store.registerRuntime({
    id: "python-3.12.8",
    name: "Python",
    version: "3.12.8",
    category: "provisioned",
    installDir: dir12,
    binDirs: ["."],
    executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    status: "ready",
    installedAt: new Date().toISOString(),
  });

  // Instalar Python 3.13.1
  const dir13 = path.join(baseDir, "runtimes", "python-3.13.1");
  await fs.mkdir(dir13, { recursive: true });
  await fs.writeFile(path.join(dir13, "python.exe"), "python 3.13.1");

  await store.registerRuntime({
    id: "python-3.13.1",
    name: "Python",
    version: "3.13.1",
    category: "provisioned",
    installDir: dir13,
    binDirs: ["."],
    executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    status: "ready",
    installedAt: new Date().toISOString(),
  });

  const list = await store.listRuntimes();
  assert.equal(list.length, 2, "Ambas as versões DEVEM coexistir no RuntimeStore!");

  const p12 = await store.getRuntime("python-3.12.8");
  const p13 = await store.getRuntime("python-3.13.1");

  assert.equal(p12?.version, "3.12.8");
  assert.equal(p13?.version, "3.13.1");
  assert.notEqual(p12?.installDir, p13?.installDir);

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("8. PERMISSION / SEGURANÇA: Negação de autorização cancela provisionamento sem baixar nada", async () => {
  const baseDir = createTempDir("security");
  const manager = new RuntimeManager({ storeOptions: { baseDir } });

  let downloadCalled = false;
  const mockDownloader = {
    download: async () => {
      downloadCalled = true;
      return { success: false, error: "Download NÃO deve ser iniciado!" };
    },
  } as unknown as RuntimeDownloader;

  const orchestrator = new RuntimeProvisioningOrchestrator({
    store: manager.getStore(),
    downloader: mockDownloader,
  });

  const lifecycle = new RuntimeLifecycleManager({
    runtimeManager: manager,
    orchestrator,
  });

  const req = {
    technology: "Python",
    runtimeId: "python",
    version: "3.12.8",
    reason: "Projeto requer Python",
    confidence: "high" as const,
    evidence: "requirements.txt",
    detectedFrom: "requirements.txt",
    state: "requires-authorization" as const,
  };

  const res = await lifecycle.authorizeAndProvision(req, {
    approved: false,
    reason: "Usuário negou no modal de autorização",
    source: "user-ui",
  });

  assert.equal(res.status, "failed");
  assert.match(res.error || "", /AUTHORIZATION_DENIED/);
  assert.equal(downloadCalled, false, "Download NUNCA deve ser disparado se a autorização for negada.");

  await fs.rm(baseDir, { recursive: true, force: true });
});

test("9. MÁQUINA LIMPA SIMULADA: Runtimes são resolvidos via RuntimeManager sem depender de runtimes globais do sistema", async () => {
  const baseDir = createTempDir("clean-machine");

  // Simular PATH minimalista/limpo (ex: apenas System32 no Windows)
  const cleanPATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin";

  const manager = new RuntimeManager({ storeOptions: { baseDir } });
  const store = manager.getStore();

  // Registrar Bun 1.4.2 provisionado (suportado pelo BunProvider)
  const bunDir = path.join(baseDir, "runtimes", "bun-1.4.2");
  await fs.mkdir(path.join(bunDir, "bun-windows-x64"), { recursive: true });
  await fs.writeFile(path.join(bunDir, "bun-windows-x64", "bun.exe"), "mock bun exec");

  await store.registerRuntime({
    id: "bun-1.4.2",
    name: "Bun",
    version: "1.4.2",
    category: "provisioned",
    installDir: bunDir,
    binDirs: ["bun-windows-x64"],
    executables: [
      { name: "bun", relativePath: "bun-windows-x64/bun.exe", type: "runtime" },
      { name: "bunx", relativePath: "bun-windows-x64/bun.exe", type: "cli" },
    ],
    status: "ready",
    installedAt: new Date().toISOString(),
  });

  const projectDir = path.join(baseDir, "bun-app");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "bun.lockb"), "lockfile content");

  const scopedEnv = await manager.getOpenCodeScopedEnv(projectDir, { PATH: cleanPATH });
  const resultPath = scopedEnv.PATH || scopedEnv.Path || "";

  assert.ok(
    resultPath.includes("bun-windows-x64"),
    "O binDir do Bun provisionado DEVE ser injetado mesmo em uma máquina limpa sem Bun global."
  );

  await fs.rm(baseDir, { recursive: true, force: true });
});

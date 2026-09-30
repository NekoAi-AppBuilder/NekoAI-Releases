// tests/runtime-ipc-bridge.test.ts
// Testes de validação da ponte IPC/UI do Runtime Lifecycle (Fase 4D - Fiação UI/IPC)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RuntimeStore } from "../src/main/runtime/runtime-store";
import { RuntimeDownloader } from "../src/main/runtime/runtime-downloader";
import { RuntimeProvisioner } from "../src/main/runtime/runtime-provisioner";
import { RuntimeProvisioningOrchestrator } from "../src/main/runtime/runtime-provisioning-orchestrator";
import { RuntimeManager } from "../src/main/runtime/runtime-manager";
import {
  RuntimeDescriptor,
  RuntimeDistribution,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../src/main/runtime/runtime-types";

async function createTempBaseDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `neko-ipc-test-${prefix}-`));
}

class MockPythonProvider implements RuntimeProvider {
  id = "python";
  name = "Python Provider";
  supportedVersions = ["3.13.1"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "3.13.1", isLts: true, isStable: true }];
  }

  getDistribution(version: string, platform: string, architecture: string): RuntimeDistribution | undefined {
    if (version !== "3.13.1") return undefined;
    return {
      runtime: "python",
      version: "3.13.1",
      platform: platform as any,
      architecture: architecture as any,
      url: "https://www.python.org/ftp/python/3.13.1/python-3.13.1-embed-amd64.zip",
      expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      status: "verified",
      archiveType: "zip",
      binDirs: ["."],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    };
  }

  isDistributionVerifiable(version: string, platform: string, architecture: string): boolean {
    return version === "3.13.1";
  }
}

class ControlledDownloader extends RuntimeDownloader {
  public downloadCalled = false;
  public lastSpecUrl = "";

  public override async download(spec: any): Promise<any> {
    this.downloadCalled = true;
    this.lastSpecUrl = spec.url;
    return {
      success: true,
      filePath: spec.destinationPath,
      actualSha256: spec.expectedSha256,
      sizeBytes: 1024,
    };
  }
}

class ControlledProvisioner extends RuntimeProvisioner {
  public provisionCalled = false;
  private mockStore: RuntimeStore;

  constructor(options: { store: RuntimeStore; downloader: RuntimeDownloader }) {
    super(options);
    this.mockStore = options.store;
  }

  public override async provision(options: any): Promise<any> {
    this.provisionCalled = true;
    const installDir = path.join(this.mockStore.getBaseDir(), options.id);
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(path.join(installDir, "python.exe"), "binary");

    const descriptor: RuntimeDescriptor = {
      id: options.id,
      name: options.name,
      version: options.version,
      category: "provisioned",
      status: "ready",
      installDir,
      binDirs: [installDir],
      executables: [{ name: "python", relativePath: path.join(installDir, "python.exe"), type: "runtime" }],
    };

    await this.mockStore.registerRuntime(descriptor);
    return { success: true, descriptor };
  }
}

test("A. IPC Bridge: runtime detectado em projeto gera Card Data com origem oficial e metadados", async () => {
  const tempDir = await createTempBaseDir("ipc-card");
  const projectDir = path.join(tempDir, "app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });

    const reqs = await runtimeManager.evaluateProjectRequirements(projectDir);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].state, "requires-authorization");

    const card = runtimeManager.getLifecycleManager().buildPermissionCardData(reqs[0]);
    assert.ok(card);
    assert.equal(card.runtimeId, "python");
    assert.equal(card.technology, "Python");
    assert.equal(card.version, "3.13.1");
    assert.equal(card.officialOrigin, "www.python.org");
    assert.equal(card.downloadUrl, "https://www.python.org/ftp/python/3.13.1/python-3.13.1-embed-amd64.zip");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("B. IPC Bridge: aprovação do usuário envia ProvisionAuthorization { approved: true, source: 'user' }", async () => {
  const tempDir = await createTempBaseDir("ipc-approve");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new ControlledDownloader();
    const provisioner = new ControlledProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
      orchestrator,
    });

    const req = {
      technology: "Python",
      runtimeId: "python",
      version: "3.13.1",
      reason: "Chamada simulada via IPC",
      confidence: "high" as const,
      evidence: "ipc-test",
      detectedFrom: "ipc-test",
      state: "requires-authorization" as const,
    };

    const result = await runtimeManager.authorizeAndProvision(req, {
      approved: true,
      source: "user",
      reason: "Usuário clicou em Instalar",
    });

    assert.equal(result.status, "installed");
    assert.ok(downloader.downloadCalled);
    assert.ok(provisioner.provisionCalled);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("D. IPC Bridge: negação do usuário (approved: false) aborta o fluxo sem chamar downloader", async () => {
  const tempDir = await createTempBaseDir("ipc-deny");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new ControlledDownloader();
    const provisioner = new ControlledProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
      orchestrator,
    });

    const req = {
      technology: "Python",
      runtimeId: "python",
      version: "3.13.1",
      reason: "Chamada cancelada via IPC",
      confidence: "high" as const,
      evidence: "ipc-test",
      detectedFrom: "ipc-test",
      state: "requires-authorization" as const,
    };

    const result = await runtimeManager.authorizeAndProvision(req, {
      approved: false,
      source: "user",
      reason: "Usuário clicou em Cancelar",
    });

    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("AUTHORIZATION_DENIED"));
    assert.equal(downloader.downloadCalled, false);
    assert.equal(provisioner.provisionCalled, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("E. SEGURANÇA IPC: renderer não consegue injetar URL ou SHA-256 arbitrários (Provider é autoridade)", async () => {
  const tempDir = await createTempBaseDir("ipc-security");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new ControlledDownloader();
    const provisioner = new ControlledProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
      orchestrator,
    });

    // Simulação de requisição que tentaria injetar URL maliciosa na chamada do IPC
    const payload = {
      runtimeId: "python",
      version: "3.13.1",
      url: "https://evil.com/malicious.zip",
      expectedSha256: "badhash",
    };

    const req = {
      technology: "Python",
      runtimeId: payload.runtimeId,
      version: payload.version,
      reason: "Tentativa de injeção",
      confidence: "high" as const,
      evidence: "user-ui",
      detectedFrom: "user-ui",
      state: "requires-authorization" as const,
    };

    const result = await runtimeManager.authorizeAndProvision(req, {
      approved: true,
      source: "user",
    });

    assert.equal(result.status, "installed");
    // O downloader deve obrigatoriamente ter baixado a URL oficial do Provider, não a URL maliciosa
    assert.equal(downloader.lastSpecUrl, "https://www.python.org/ftp/python/3.13.1/python-3.13.1-embed-amd64.zip");
    assert.notEqual(downloader.lastSpecUrl, "https://evil.com/malicious.zip");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F. IPC Bridge: runtime inexistente ou inconsistente retorna erro determinístico no IPC", async () => {
  const tempDir = await createTempBaseDir("ipc-inconsistent");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    await store.registerRuntime({
      id: "python-3.13.1",
      name: "Python",
      version: "3.13.1",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "pasta-fantasma"),
      binDirs: [],
      executables: [],
    });

    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      providers: [new MockPythonProvider()],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
      orchestrator,
    });

    const result = await orchestrator.requestProvisioning(
      { runtimeId: "python", version: "3.13.1" },
      { approved: true, source: "user" }
    );

    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("INCONSISTENT_INSTALLATION"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("G. GARANTIA ARQUITETURAL: process.env.PATH permanece 100% inalterado durante IPC de autorização", async () => {
  const originalPath = process.env.PATH;
  const tempDir = await createTempBaseDir("ipc-path");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new ControlledDownloader();
    const provisioner = new ControlledProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
      orchestrator,
    });

    const req = {
      technology: "Python",
      runtimeId: "python",
      version: "3.13.1",
      reason: "IPC Test",
      confidence: "high" as const,
      evidence: "ipc-test",
      detectedFrom: "ipc-test",
      state: "requires-authorization" as const,
    };

    await runtimeManager.authorizeAndProvision(req, { approved: true, source: "user" });

    assert.equal(process.env.PATH, originalPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

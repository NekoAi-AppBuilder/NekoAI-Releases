// tests/runtime-lifecycle.test.ts
// Testes unitários para o RuntimeLifecycleManager (Fase 4D)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RuntimeStore } from "../src/main/runtime/runtime-store";
import { RuntimeDownloader } from "../src/main/runtime/runtime-downloader";
import { RuntimeProvisioner } from "../src/main/runtime/runtime-provisioner";
import { RuntimeProvisioningOrchestrator } from "../src/main/runtime/runtime-provisioning-orchestrator";
import { RuntimeLifecycleManager } from "../src/main/runtime/runtime-lifecycle";
import { RuntimeManager } from "../src/main/runtime/runtime-manager";
import {
  RuntimeDescriptor,
  RuntimeDistribution,
  RuntimeLifecycleEvent,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../src/main/runtime/runtime-types";

async function createTempBaseDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `neko-lifecycle-test-${prefix}-`));
}

class MockPythonProvider implements RuntimeProvider {
  id = "python";
  name = "Python Provider";
  supportedVersions = ["3.12.8"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "3.12.8", isLts: true, isStable: true }];
  }

  getDistribution(version: string, platform: string, architecture: string): RuntimeDistribution | undefined {
    if (version !== "3.12.8") return undefined;
    return {
      runtime: "python",
      version: "3.12.8",
      platform: platform as any,
      architecture: architecture as any,
      url: "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip",
      expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      status: "verified",
      archiveType: "zip",
      binDirs: ["."],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    };
  }

  isDistributionVerifiable(version: string, platform: string, architecture: string): boolean {
    return version === "3.12.8";
  }
}

class MockBunProvider implements RuntimeProvider {
  id = "bun";
  name = "Bun Provider";
  supportedVersions = ["1.1.30"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "1.1.30", isStable: true }];
  }

  getDistribution(version: string, platform: string, architecture: string): RuntimeDistribution | undefined {
    if (version !== "1.1.30") return undefined;
    return {
      runtime: "bun",
      version: "1.1.30",
      platform: platform as any,
      architecture: architecture as any,
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.1.30/bun-windows-x64.zip",
      expectedSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      status: "verified",
      archiveType: "zip",
      binDirs: ["."],
      executables: [{ name: "bun", relativePath: "bun.exe", type: "runtime" }],
    };
  }

  isDistributionVerifiable(version: string, platform: string, architecture: string): boolean {
    return version === "1.1.30";
  }
}

class ControlledDownloader extends RuntimeDownloader {
  public downloadCalled = false;
  public shouldSucceed = true;

  public override async download(spec: any): Promise<any> {
    this.downloadCalled = true;
    if (!this.shouldSucceed) {
      return {
        success: false,
        filePath: spec.destinationPath,
        actualSha256: "",
        sizeBytes: 0,
        error: "CHECKSUM_MISMATCH: SHA-256 incorreto simulado.",
      };
    }
    return {
      success: true,
      filePath: spec.destinationPath,
      actualSha256: spec.expectedSha256,
      sizeBytes: 2048,
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
    const exeName = options.id.startsWith("bun") ? "bun.exe" : "python.exe";
    await fs.writeFile(path.join(installDir, exeName), "mock exe");

    const descriptor: RuntimeDescriptor = {
      id: options.id,
      name: options.name,
      version: options.version,
      category: "provisioned",
      status: "ready",
      installDir,
      binDirs: [installDir],
      executables: [{ name: options.name.toLowerCase(), relativePath: path.join(installDir, exeName), type: "runtime" }],
    };

    await this.mockStore.registerRuntime(descriptor);

    return {
      success: true,
      descriptor,
    };
  }
}

test("1. Lifecycle: Detector encontra Python em projeto e gera RuntimeRequirement determinístico", async () => {
  const tempDir = await createTempBaseDir("life-detect");
  const projectDir = path.join(tempDir, "my-python-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask==3.0.0\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });

    const lifecycle = runtimeManager.getLifecycleManager();
    const requirements = await lifecycle.evaluateProjectRequirements(projectDir);

    assert.equal(requirements.length, 1);
    const req = requirements[0];
    assert.equal(req.technology, "Python");
    assert.equal(req.runtimeId, "python");
    assert.equal(req.version, "3.12.8");
    assert.equal(req.state, "requires-authorization");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. Lifecycle: Runtime já instalado e consistente retorna estado 'ready'", async () => {
  const tempDir = await createTempBaseDir("life-ready");
  const projectDir = path.join(tempDir, "my-python-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "requests\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const installDir = path.join(tempDir, "python-3.12.8");
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(path.join(installDir, "python.exe"), "binary");

    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir,
      binDirs: [installDir],
      executables: [{ name: "python", relativePath: path.join(installDir, "python.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });
    // Forçar uso do store mockado
    (runtimeManager as any).store = store;

    const requirements = await runtimeManager.evaluateProjectRequirements(projectDir);

    assert.equal(requirements.length, 1);
    const req = requirements[0];
    assert.equal(req.state, "ready");
    assert.ok(req.descriptor);
    assert.equal(req.descriptor.id, "python-3.12.8");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. Lifecycle: Recusa de autorização (approved: false) cancela o fluxo e não baixa nada", async () => {
  const tempDir = await createTempBaseDir("life-denied");
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
      version: "3.12.8",
      reason: "Requerido pelo projeto",
      confidence: "high" as const,
      evidence: "requirements.txt",
      detectedFrom: "requirements.txt",
      state: "requires-authorization" as const,
    };

    const events: RuntimeLifecycleEvent[] = [];
    runtimeManager.getLifecycleManager().subscribeEvents((ev) => events.push(ev));

    const result = await runtimeManager.authorizeAndProvision(req, { approved: false, source: "user", reason: "Cancelado pelo usuário." });

    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("AUTHORIZATION_DENIED"));
    assert.equal(downloader.downloadCalled, false);
    assert.equal(provisioner.provisionCalled, false);
    assert.ok(events.some((e) => e.type === "permission-denied"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. Lifecycle: Aprovação de autorização executa o fluxo e registra no Store com emissão de eventos", async () => {
  const tempDir = await createTempBaseDir("life-approved");
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
      version: "3.12.8",
      reason: "Requerido pelo projeto",
      confidence: "high" as const,
      evidence: "requirements.txt",
      detectedFrom: "requirements.txt",
      state: "requires-authorization" as const,
    };

    const events: RuntimeLifecycleEvent[] = [];
    runtimeManager.getLifecycleManager().subscribeEvents((ev) => events.push(ev));

    const result = await runtimeManager.authorizeAndProvision(req, { approved: true, source: "user" });

    assert.equal(result.status, "installed");
    assert.ok(downloader.downloadCalled);
    assert.ok(provisioner.provisionCalled);

    const saved = await store.getRuntime("python-3.12.8");
    assert.ok(saved);
    assert.equal(saved.status, "ready");

    assert.ok(events.some((e) => e.type === "permission-granted"));
    assert.ok(events.some((e) => e.type === "downloading"));
    assert.ok(events.some((e) => e.type === "installed"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. Lifecycle: Checksum incorreto no download simulado gera estado 'failed'", async () => {
  const tempDir = await createTempBaseDir("life-checksum-fail");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new ControlledDownloader();
    downloader.shouldSucceed = false;

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
      version: "3.12.8",
      reason: "Requerido pelo projeto",
      confidence: "high" as const,
      evidence: "requirements.txt",
      detectedFrom: "requirements.txt",
      state: "requires-authorization" as const,
    };

    const result = await runtimeManager.authorizeAndProvision(req, { approved: true, source: "user" });

    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("CHECKSUM_MISMATCH"));
    assert.equal(provisioner.provisionCalled, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. Lifecycle: Suporte a múltiplos runtimes independentes no mesmo projeto (Python + Bun)", async () => {
  const tempDir = await createTempBaseDir("life-multi");
  const projectDir = path.join(tempDir, "multi-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "pip\n");
    await fs.writeFile(path.join(projectDir, "bun.lockb"), "lockfile");

    const store = new RuntimeStore({ baseDir: tempDir });
    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider(), new MockBunProvider()],
    });

    const requirements = await runtimeManager.evaluateProjectRequirements(projectDir);

    assert.equal(requirements.length, 2);
    const pyReq = requirements.find((r) => r.runtimeId === "python");
    const bunReq = requirements.find((r) => r.runtimeId === "bun");

    assert.ok(pyReq);
    assert.ok(bunReq);
    assert.equal(pyReq.state, "requires-authorization");
    assert.equal(bunReq.state, "requires-authorization");
    assert.equal(pyReq.version, "3.12.8");
    assert.equal(bunReq.version, "1.1.30");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. Lifecycle: Runtime registrado no Store mas ausente no disco gera estado 'inconsistent'", async () => {
  const tempDir = await createTempBaseDir("life-inconsistent");
  const projectDir = path.join(tempDir, "inconsistent-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "pip\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "pasta-excluida"),
      binDirs: [],
      executables: [],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });
    (runtimeManager as any).store = store;

    const requirements = await runtimeManager.evaluateProjectRequirements(projectDir);

    assert.equal(requirements.length, 1);
    assert.equal(requirements[0].state, "inconsistent");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("8. Lifecycle: Versão não suportada pelo Provider retorna estado 'unsupported'", async () => {
  const tempDir = await createTempBaseDir("life-unsupported");
  try {
    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });

    const detection = {
      technology: "Python",
      confidence: "high" as const,
      evidence: "pyproject.toml",
      possibleRuntime: "python",
      versionRequirement: "==9.9.9",
    };

    const req = await runtimeManager.getLifecycleManager().evaluateDetectionRequirement(detection);

    assert.equal(req.state, "unsupported");
    assert.equal(req.issue, "UNSUPPORTED_DISTRIBUTION");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("9. Lifecycle: Permission Card Data (buildPermissionCardData) constrói metadados completos da UI", async () => {
  const tempDir = await createTempBaseDir("life-card");
  try {
    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });

    const req = {
      technology: "Python",
      runtimeId: "python",
      version: "3.12.8",
      reason: "Projeto requer Python 3.12.8",
      confidence: "high" as const,
      evidence: "requirements.txt",
      detectedFrom: "requirements.txt",
      state: "requires-authorization" as const,
    };

    const card = runtimeManager.getLifecycleManager().buildPermissionCardData(req);

    assert.ok(card);
    assert.equal(card.runtimeId, "python");
    assert.equal(card.technology, "Python");
    assert.equal(card.version, "3.12.8");
    assert.equal(card.officialOrigin, "www.python.org");
    assert.equal(card.downloadUrl, "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip");
    assert.equal(card.expectedSha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("10. GARANTIA ARQUITETURAL: process.env.PATH permanece 100% inalterado durante o ciclo de vida", async () => {
  const originalPath = process.env.PATH;
  const tempDir = await createTempBaseDir("life-path");
  const projectDir = path.join(tempDir, "app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "pip\n");

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

    const reqs = await runtimeManager.evaluateProjectRequirements(projectDir);
    await runtimeManager.authorizeAndProvision(reqs[0], { approved: true, source: "user" });

    assert.equal(process.env.PATH, originalPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

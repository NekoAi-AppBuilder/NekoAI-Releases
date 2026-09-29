// tests/runtime-provisioning-orchestrator.test.ts
// Testes unitários para o RuntimeProvisioningOrchestrator (Fase 4C)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { RuntimeStore } from "../src/main/runtime/runtime-store";
import { RuntimeDownloader } from "../src/main/runtime/runtime-downloader";
import { RuntimeProvisioner } from "../src/main/runtime/runtime-provisioner";
import {
  RuntimeProvisioningOrchestrator,
  ProvisionAuthorization,
  RuntimeProvisionRequest,
} from "../src/main/runtime/runtime-provisioning-orchestrator";
import {
  RuntimeDescriptor,
  RuntimeDistribution,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../src/main/runtime/runtime-types";

// Helper para criar diretórios temporários limpos
async function createTempBaseDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `neko-test-${prefix}-`));
  return dir;
}

// Dummy Provider Mock para testes
class MockPythonProvider implements RuntimeProvider {
  id = "python";
  name = "Python Mock Provider";
  supportedVersions = ["3.12.8"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "3.12.8", isLts: false, isStable: true }];
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

class MockUnverifiableProvider implements RuntimeProvider {
  id = "unverifiable";
  name = "Unverifiable Provider";
  supportedVersions = ["1.0.0"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "1.0.0" }];
  }

  getDistribution(version: string, platform: string, architecture: string): RuntimeDistribution | undefined {
    return {
      runtime: "unverifiable",
      version: "1.0.0",
      platform: platform as any,
      architecture: architecture as any,
      url: "https://example.com/unverifiable.zip",
      expectedSha256: "",
      status: "unverified",
      archiveType: "zip",
      binDirs: ["."],
      executables: [],
    };
  }

  isDistributionVerifiable(version: string, platform: string, architecture: string): boolean {
    return false;
  }
}

// Downloader e Provisioner Mocks
class FakeDownloader extends RuntimeDownloader {
  public downloadCalled = false;
  public shouldSucceed = true;
  public lastDownloadedUrl = "";

  public override async download(spec: any): Promise<any> {
    this.downloadCalled = true;
    this.lastDownloadedUrl = spec.url;
    if (!this.shouldSucceed) {
      return {
        success: false,
        filePath: spec.destinationPath,
        actualSha256: "",
        sizeBytes: 0,
        error: "MOCK_DOWNLOAD_FAILED: Falha simulada no download.",
      };
    }
    return {
      success: true,
      filePath: spec.destinationPath,
      actualSha256: spec.expectedSha256,
      sizeBytes: 1024,
    };
  }
}

class FakeProvisioner extends RuntimeProvisioner {
  public provisionCalled = false;
  public shouldSucceed = true;
  private mockStore: RuntimeStore;

  constructor(options: { store: RuntimeStore; downloader: RuntimeDownloader }) {
    super(options);
    this.mockStore = options.store;
  }

  public override async provision(options: any): Promise<any> {
    this.provisionCalled = true;
    if (!this.shouldSucceed) {
      return {
        success: false,
        error: "MOCK_PROVISION_FAILED: Extração falhou no teste.",
      };
    }

    const installDir = path.join(this.mockStore.getBaseDir(), options.id);
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(path.join(installDir, "python.exe"), "mock binary content");

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

    return {
      success: true,
      descriptor,
    };
  }
}

test("1. Orchestrator: solicitação válida com autorização executa o fluxo completo e registra no Store", async () => {
  const tempDir = await createTempBaseDir("orch-valid");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    const pythonProvider = new MockPythonProvider();

    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [pythonProvider],
    });

    const authorization: ProvisionAuthorization = { approved: true, source: "test" };
    const request: RuntimeProvisionRequest = { runtimeId: "python", version: "3.12.8" };

    const result = await orchestrator.requestProvisioning(request, authorization);

    assert.equal(result.status, "installed");
    assert.equal(result.runtimeId, "python");
    assert.equal(result.version, "3.12.8");
    assert.ok(result.descriptor);
    assert.equal(result.descriptor.id, "python-3.12.8");
    assert.ok(downloader.downloadCalled);
    assert.ok(provisioner.provisionCalled);
    assert.deepEqual(result.history, ["requested", "resolving", "download-pending", "downloading", "downloaded", "installing", "installed"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. Orchestrator: runtime desconhecido é rejeitado com status 'failed' (PROVIDER_NOT_FOUND)", async () => {
  const tempDir = await createTempBaseDir("orch-unknown");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      providers: [],
    });

    const result = await orchestrator.requestProvisioning({ runtimeId: "unknown-runtime", version: "1.0.0" }, { approved: true, source: "test" });
    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("PROVIDER_NOT_FOUND"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. Orchestrator: versão não suportada ou 'latest' é rejeitada", async () => {
  const tempDir = await createTempBaseDir("orch-version");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      providers: [new MockPythonProvider()],
    });

    const resLatest = await orchestrator.requestProvisioning({ runtimeId: "python", version: "latest" });
    assert.equal(resLatest.status, "failed");
    assert.ok(resLatest.error?.includes("INVALID_VERSION"));

    const resUnsupp = await orchestrator.requestProvisioning({ runtimeId: "python", version: "9.9.9" }, { approved: true, source: "test" });
    assert.equal(resUnsupp.status, "failed");
    assert.ok(resUnsupp.error?.includes("UNSUPPORTED_VERSION"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. Orchestrator: distribuição não verificável é rejeitada com status 'failed'", async () => {
  const tempDir = await createTempBaseDir("orch-unverifiable");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      providers: [new MockUnverifiableProvider()],
    });

    const result = await orchestrator.requestProvisioning({ runtimeId: "unverifiable", version: "1.0.0" }, { approved: true, source: "test" });
    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("UNVERIFIABLE_DISTRIBUTION"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. Orchestrator: autorização ausente ou negada impede download e provisionamento", async () => {
  const tempDir = await createTempBaseDir("orch-unauth");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    // 1. Sem parâmetro de autorização
    const resNoAuth = await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" });
    assert.equal(resNoAuth.status, "failed");
    assert.ok(resNoAuth.error?.includes("AUTHORIZATION_DENIED"));
    assert.equal(downloader.downloadCalled, false);
    assert.equal(provisioner.provisionCalled, false);

    // 2. Com parâmetro approved = false
    const resDenied = await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" }, { approved: false, source: "user" });
    assert.equal(resDenied.status, "failed");
    assert.ok(resDenied.error?.includes("AUTHORIZATION_DENIED"));
    assert.equal(downloader.downloadCalled, false);
    assert.equal(provisioner.provisionCalled, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. Orchestrator / Idempotência: runtime já instalado e consistente retorna status 'already-installed' sem baixar novamente", async () => {
  const tempDir = await createTempBaseDir("orch-idempotent");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

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

    const result = await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" }, { approved: true, source: "test" });

    assert.equal(result.status, "already-installed");
    assert.equal(downloader.downloadCalled, false);
    assert.equal(provisioner.provisionCalled, false);
    assert.ok(result.descriptor);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. Orchestrator: runtime inconsistente (pasta/arquivo apagado) é detectado e gera erro de inconsistência", async () => {
  const tempDir = await createTempBaseDir("orch-inconsistent");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    // Registrar no store apontando para pasta inexistente
    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "pasta-fantasma"),
      binDirs: [],
      executables: [],
    });

    const result = await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" }, { approved: true, source: "test" });

    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("INCONSISTENT_INSTALLATION"));
    assert.equal(downloader.downloadCalled, false);
    assert.equal(provisioner.provisionCalled, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("8. Orchestrator: download falho interrompe fluxo e altera status para 'failed'", async () => {
  const tempDir = await createTempBaseDir("orch-down-fail");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    downloader.shouldSucceed = false;

    const provisioner = new FakeProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const result = await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" }, { approved: true, source: "test" });

    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes("MOCK_DOWNLOAD_FAILED"));
    assert.ok(downloader.downloadCalled);
    assert.equal(provisioner.provisionCalled, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("9. Orchestrator: falha no provisionador altera status para 'rolled-back'", async () => {
  const tempDir = await createTempBaseDir("orch-prov-fail");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    provisioner.shouldSucceed = false;

    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const result = await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" }, { approved: true, source: "test" });

    assert.equal(result.status, "rolled-back");
    assert.ok(result.error?.includes("MOCK_PROVISION_FAILED"));
    assert.ok(downloader.downloadCalled);
    assert.ok(provisioner.provisionCalled);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("10. Orchestrator: validação de transições de estado (isValidTransition) rejeita saltos arbitrários", async () => {
  const orchestrator = new RuntimeProvisioningOrchestrator();

  assert.equal(orchestrator.isValidTransition("requested", "resolving"), true);
  assert.equal(orchestrator.isValidTransition("resolving", "download-pending"), true);
  assert.equal(orchestrator.isValidTransition("download-pending", "downloading"), true);
  assert.equal(orchestrator.isValidTransition("downloading", "downloaded"), true);
  assert.equal(orchestrator.isValidTransition("downloaded", "installing"), true);
  assert.equal(orchestrator.isValidTransition("installing", "installed"), true);
  assert.equal(orchestrator.isValidTransition("installing", "rolled-back"), true);

  // Transições proibidas
  assert.equal(orchestrator.isValidTransition("requested", "installed"), false);
  assert.equal(orchestrator.isValidTransition("resolving", "installed"), false);
  assert.equal(orchestrator.isValidTransition("installed", "downloading"), false);
  assert.equal(orchestrator.isValidTransition("failed", "resolving"), false);
});

test("11. Orchestrator: requisições concorrentes idênticas são bloqueadas com 'already-in-progress'", async () => {
  const tempDir = await createTempBaseDir("orch-concurrent");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });

    // Downloader lento simulado
    class SlowDownloader extends FakeDownloader {
      public override async download(spec: any): Promise<any> {
        this.downloadCalled = true;
        await new Promise((res) => setTimeout(res, 50));
        return super.download(spec);
      }
    }

    const downloader = new SlowDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [new MockPythonProvider()],
    });

    const req: RuntimeProvisionRequest = { runtimeId: "python", version: "3.12.8" };
    const auth: ProvisionAuthorization = { approved: true, source: "test" };

    // Iniciar 2 solicitações ao mesmo tempo
    const p1 = orchestrator.requestProvisioning(req, auth);
    const p2 = orchestrator.requestProvisioning(req, auth);

    const [res1, res2] = await Promise.all([p1, p2]);

    const concurrentResult = res1.status === "already-in-progress" ? res1 : res2;
    const successResult = res1.status === "installed" ? res1 : res2;

    assert.equal(concurrentResult.status, "already-in-progress");
    assert.ok(concurrentResult.error?.includes("CONCURRENT_PROVISIONING_BLOCKED"));
    assert.equal(successResult.status, "installed");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("12. SEGURANÇA DE CONTRATO: caller NÃO pode forçar URL ou SHA-256 arbitrários na solicitação", async () => {
  const tempDir = await createTempBaseDir("orch-security");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const downloader = new FakeDownloader();
    const provisioner = new FakeProvisioner({ store, downloader });
    const pythonProvider = new MockPythonProvider();

    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader,
      provisioner,
      providers: [pythonProvider],
    });

    const maliciousRequest: RuntimeProvisionRequest = {
      runtimeId: "python",
      version: "3.12.8",
      url: "https://hacker.com/malicious-python.zip",
      expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const result = await orchestrator.requestProvisioning(maliciousRequest, { approved: true, source: "test" });

    assert.equal(result.status, "installed");
    // O downloader deve obrigatoriamente ter recebido a URL oficial do Provider, ignorando a URL maliciosa da request
    assert.equal(downloader.lastDownloadedUrl, "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip");
    assert.notEqual(downloader.lastDownloadedUrl, "https://hacker.com/malicious-python.zip");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("13. GARANTIA ARQUITETURAL: process.env.PATH permanece 100% inalterado durante orquestração", async () => {
  const originalPath = process.env.PATH;
  const tempDir = await createTempBaseDir("orch-path");
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const orchestrator = new RuntimeProvisioningOrchestrator({
      store,
      downloader: new FakeDownloader(),
      provisioner: new FakeProvisioner({ store, downloader: new FakeDownloader() }),
      providers: [new MockPythonProvider()],
    });

    await orchestrator.requestProvisioning({ runtimeId: "python", version: "3.12.8" }, { approved: true, source: "test" });

    assert.equal(process.env.PATH, originalPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

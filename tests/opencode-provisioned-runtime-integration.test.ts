// tests/opencode-provisioned-runtime-integration.test.ts
// Testes unitários para a integração de runtimes provisionados ao ambiente do OpenCode (Fase 4E)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RuntimeStore } from "../src/main/runtime/runtime-store";
import { RuntimeManager } from "../src/main/runtime/runtime-manager";
import {
  RuntimeDistribution,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../src/main/runtime/runtime-types";

async function createTempBaseDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `neko-opencode-4e-${prefix}-`));
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
      environmentVariables: { PYTHONUNBUFFERED: "1" },
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

class MockDenoProvider implements RuntimeProvider {
  id = "deno";
  name = "Deno Provider";
  supportedVersions = ["2.0.0"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "2.0.0", isStable: true }];
  }

  getDistribution(version: string, platform: string, architecture: string): RuntimeDistribution | undefined {
    if (version !== "2.0.0") return undefined;
    return {
      runtime: "deno",
      version: "2.0.0",
      platform: platform as any,
      architecture: architecture as any,
      url: "https://github.com/denoland/deno/releases/download/v2.0.0/deno-x86_64-pc-windows-msvc.zip",
      expectedSha256: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      status: "verified",
      archiveType: "zip",
      binDirs: ["."],
      executables: [{ name: "deno", relativePath: "deno.exe", type: "runtime" }],
    };
  }

  isDistributionVerifiable(version: string, platform: string, architecture: string): boolean {
    return version === "2.0.0";
  }
}

class MockPHPProvider implements RuntimeProvider {
  id = "php";
  name = "PHP Provider";
  supportedVersions = ["8.3.12"];

  getSupportedVersions(): RuntimeVersionSpec[] {
    return [{ version: "8.3.12", isStable: true }];
  }

  getDistribution(version: string, platform: string, architecture: string): RuntimeDistribution | undefined {
    if (version !== "8.3.12") return undefined;
    return {
      runtime: "php",
      version: "8.3.12",
      platform: platform as any,
      architecture: architecture as any,
      url: "https://windows.php.net/downloads/releases/php-8.3.12-Win32-vs16-x64.zip",
      expectedSha256: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      status: "verified",
      archiveType: "zip",
      binDirs: ["."],
      executables: [{ name: "php", relativePath: "php.exe", type: "runtime" }],
    };
  }

  isDistributionVerifiable(version: string, platform: string, architecture: string): boolean {
    return version === "8.3.12";
  }
}

test("A. OpenCode sem runtime especializado: env retornado mantém comportamento atual e runtimes embutidos", async () => {
  const tempDir = await createTempBaseDir("opencode-no-spec");
  const projectDir = path.join(tempDir, "plain-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    const runtimeManager = new RuntimeManager({ storeOptions: { baseDir: tempDir } });

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    assert.ok(env);
    assert.ok(env.PATH || env.Path);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("B. Python instalado: OpenCode recebe o binDir do Python e PYTHONUNBUFFERED='1' no scoped env", async () => {
  const tempDir = await createTempBaseDir("opencode-python");
  const projectDir = path.join(tempDir, "py-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const pyInstallDir = path.join(tempDir, "python-3.12.8");
    await fs.mkdir(pyInstallDir, { recursive: true });
    await fs.writeFile(path.join(pyInstallDir, "python.exe"), "mock py binary");

    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: pyInstallDir,
      binDirs: [pyInstallDir],
      executables: [{ name: "python", relativePath: path.join(pyInstallDir, "python.exe"), type: "runtime" }],
      environmentVariables: { PYTHONUNBUFFERED: "1" },
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.ok(pathValue.toLowerCase().includes(pyInstallDir.toLowerCase()));
    assert.equal(env.PYTHONUNBUFFERED, "1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("C. Bun instalado: OpenCode recebe o binDir do Bun no scoped env", async () => {
  const tempDir = await createTempBaseDir("opencode-bun");
  const projectDir = path.join(tempDir, "bun-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "bun.lockb"), "lock");

    const store = new RuntimeStore({ baseDir: tempDir });
    const bunInstallDir = path.join(tempDir, "bun-1.1.30");
    await fs.mkdir(bunInstallDir, { recursive: true });
    await fs.writeFile(path.join(bunInstallDir, "bun.exe"), "mock bun binary");

    await store.registerRuntime({
      id: "bun-1.1.30",
      name: "Bun",
      version: "1.1.30",
      category: "provisioned",
      status: "ready",
      installDir: bunInstallDir,
      binDirs: [bunInstallDir],
      executables: [{ name: "bun", relativePath: path.join(bunInstallDir, "bun.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockBunProvider()],
    });
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.ok(pathValue.toLowerCase().includes(bunInstallDir.toLowerCase()));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("D. Deno instalado: OpenCode recebe o binDir do Deno no scoped env", async () => {
  const tempDir = await createTempBaseDir("opencode-deno");
  const projectDir = path.join(tempDir, "deno-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "deno.json"), "{}");

    const store = new RuntimeStore({ baseDir: tempDir });
    const denoInstallDir = path.join(tempDir, "deno-2.0.0");
    await fs.mkdir(denoInstallDir, { recursive: true });
    await fs.writeFile(path.join(denoInstallDir, "deno.exe"), "mock deno binary");

    await store.registerRuntime({
      id: "deno-2.0.0",
      name: "Deno",
      version: "2.0.0",
      category: "provisioned",
      status: "ready",
      installDir: denoInstallDir,
      binDirs: [denoInstallDir],
      executables: [{ name: "deno", relativePath: path.join(denoInstallDir, "deno.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockDenoProvider()],
    });
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.ok(pathValue.toLowerCase().includes(denoInstallDir.toLowerCase()));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("E. PHP instalado: OpenCode recebe o binDir do PHP no scoped env", async () => {
  const tempDir = await createTempBaseDir("opencode-php");
  const projectDir = path.join(tempDir, "php-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "composer.json"), "{}");

    const store = new RuntimeStore({ baseDir: tempDir });
    const phpInstallDir = path.join(tempDir, "php-8.3.12");
    await fs.mkdir(phpInstallDir, { recursive: true });
    await fs.writeFile(path.join(phpInstallDir, "php.exe"), "mock php binary");

    await store.registerRuntime({
      id: "php-8.3.12",
      name: "PHP",
      version: "8.3.12",
      category: "provisioned",
      status: "ready",
      installDir: phpInstallDir,
      binDirs: [phpInstallDir],
      executables: [{ name: "php", relativePath: path.join(phpInstallDir, "php.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPHPProvider()],
    });
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.ok(pathValue.toLowerCase().includes(phpInstallDir.toLowerCase()));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("F. Runtime não instalado: não injeta PATH inexistente ou não registrado no OpenCode", async () => {
  const tempDir = await createTempBaseDir("opencode-not-installed");
  const projectDir = path.join(tempDir, "py-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.equal(pathValue.toLowerCase().includes("python-3.12.8"), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("G. Runtime inconsistente (pasta apagada): não injeta no ambiente do OpenCode", async () => {
  const tempDir = await createTempBaseDir("opencode-inconsistent");
  const projectDir = path.join(tempDir, "py-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const missingFolder = path.join(tempDir, "pasta-fantasma");

    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: missingFolder,
      binDirs: [missingFolder],
      executables: [{ name: "python", relativePath: path.join(missingFolder, "python.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.equal(pathValue.toLowerCase().includes("pasta-fantasma"), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("H. Runtime com executável ausente: não injeta no ambiente do OpenCode", async () => {
  const tempDir = await createTempBaseDir("opencode-exe-missing");
  const projectDir = path.join(tempDir, "py-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const installDir = path.join(tempDir, "python-3.12.8");
    await fs.mkdir(installDir, { recursive: true });
    // Não criar python.exe

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
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.equal(pathValue.toLowerCase().includes("python-3.12.8"), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("I. GARANTIA ARQUITETURAL: process.env.PATH permanece 100% inalterado", async () => {
  const originalPath = process.env.PATH;
  const tempDir = await createTempBaseDir("opencode-path-check");
  const projectDir = path.join(tempDir, "py-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");

    const store = new RuntimeStore({ baseDir: tempDir });
    const pyInstallDir = path.join(tempDir, "python-3.12.8");
    await fs.mkdir(pyInstallDir, { recursive: true });
    await fs.writeFile(path.join(pyInstallDir, "python.exe"), "mock py binary");

    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: pyInstallDir,
      binDirs: [pyInstallDir],
      executables: [{ name: "python", relativePath: path.join(pyInstallDir, "python.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider()],
    });
    (runtimeManager as any).store = store;

    await runtimeManager.getOpenCodeScopedEnv(projectDir);

    assert.equal(process.env.PATH, originalPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("L. Múltiplos Runtimes (Python + Bun): todos os binDirs válidos são combinados corretamente no OpenCode", async () => {
  const tempDir = await createTempBaseDir("opencode-multi");
  const projectDir = path.join(tempDir, "multi-app");
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "requirements.txt"), "flask\n");
    await fs.writeFile(path.join(projectDir, "bun.lockb"), "lock");

    const store = new RuntimeStore({ baseDir: tempDir });

    const pyDir = path.join(tempDir, "python-3.12.8");
    await fs.mkdir(pyDir, { recursive: true });
    await fs.writeFile(path.join(pyDir, "python.exe"), "mock py");

    const bunDir = path.join(tempDir, "bun-1.1.30");
    await fs.mkdir(bunDir, { recursive: true });
    await fs.writeFile(path.join(bunDir, "bun.exe"), "mock bun");

    await store.registerRuntime({
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: pyDir,
      binDirs: [pyDir],
      executables: [{ name: "python", relativePath: path.join(pyDir, "python.exe"), type: "runtime" }],
    });

    await store.registerRuntime({
      id: "bun-1.1.30",
      name: "Bun",
      version: "1.1.30",
      category: "provisioned",
      status: "ready",
      installDir: bunDir,
      binDirs: [bunDir],
      executables: [{ name: "bun", relativePath: path.join(bunDir, "bun.exe"), type: "runtime" }],
    });

    const runtimeManager = new RuntimeManager({
      storeOptions: { baseDir: tempDir },
      providers: [new MockPythonProvider(), new MockBunProvider()],
    });
    (runtimeManager as any).store = store;

    const env = await runtimeManager.getOpenCodeScopedEnv(projectDir);
    const pathValue = env.PATH || env.Path || "";

    assert.ok(pathValue.toLowerCase().includes(pyDir.toLowerCase()));
    assert.ok(pathValue.toLowerCase().includes(bunDir.toLowerCase()));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

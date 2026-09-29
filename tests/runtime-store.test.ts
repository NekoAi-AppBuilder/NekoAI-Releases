import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { RuntimeStore } from "../src/main/runtime/runtime-store.ts";
import { RuntimeDescriptor } from "../src/main/runtime/runtime-types.ts";

async function createTempDir(): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, "neko-store-test-"));
  return dir;
}

// ============================================================================
// SUÍTE DE TESTES: RUNTIME STORE (PERSISTÊNCIA, MANIFESTO E CONSULTA)
// ============================================================================

test("1. RuntimeStore: carrega manifesto vazio quando arquivo não existe", async () => {
  const tempDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const manifest = await store.loadManifest();

    assert.equal(manifest.version, "1.0");
    assert.ok(manifest.updatedAt);
    assert.deepEqual(manifest.runtimes, {});
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. RuntimeStore: escrita atômica e registro de novo runtime", async () => {
  const tempDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir: tempDir });

    const descriptor: RuntimeDescriptor = {
      id: "python-3.12.7",
      name: "Python",
      version: "3.12.7",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "python-3.12.7"),
      binDirs: [path.join(tempDir, "python-3.12.7")],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    };

    await store.registerRuntime(descriptor);

    // Verificar se o arquivo temporário foi removido e o manifesto oficial criado
    assert.equal(fsSync.existsSync(store.getManifestPath()), true);
    assert.equal(fsSync.existsSync(`${store.getManifestPath()}.tmp`), false);

    const fetched = await store.getRuntime("python-3.12.7");
    assert.ok(fetched);
    assert.equal(fetched.name, "Python");
    assert.equal(fetched.version, "3.12.7");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. RuntimeStore: atualização e listagem de múltiplos runtimes e busca por nome", async () => {
  const tempDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir: tempDir });

    const py312: RuntimeDescriptor = {
      id: "python-3.12.7",
      name: "Python",
      version: "3.12.7",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "py312"),
      binDirs: [path.join(tempDir, "py312")],
      executables: [],
    };

    const py313: RuntimeDescriptor = {
      id: "python-3.13.0",
      name: "Python",
      version: "3.13.0",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "py313"),
      binDirs: [path.join(tempDir, "py313")],
      executables: [],
    };

    const bun11: RuntimeDescriptor = {
      id: "bun-1.1.30",
      name: "Bun",
      version: "1.1.30",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "bun11"),
      binDirs: [path.join(tempDir, "bun11")],
      executables: [],
    };

    await store.registerRuntime(py312);
    await store.registerRuntime(py313);
    await store.registerRuntime(bun11);

    const all = await store.listRuntimes();
    assert.equal(all.length, 3);

    const pyList = await store.findRuntimesByName("Python");
    assert.equal(pyList.length, 2);

    const bunList = await store.findRuntimesByName("bun");
    assert.equal(bunList.length, 1);
    assert.equal(bunList[0].id, "bun-1.1.30");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. RuntimeStore: remoção de registro de runtime", async () => {
  const tempDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir: tempDir });

    const py312: RuntimeDescriptor = {
      id: "python-3.12.7",
      name: "Python",
      version: "3.12.7",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "py312"),
      binDirs: [],
      executables: [],
    };

    await store.registerRuntime(py312);
    assert.ok(await store.getRuntime("python-3.12.7"));

    const removed = await store.unregisterRuntime("python-3.12.7");
    assert.equal(removed, true);
    assert.equal(await store.getRuntime("python-3.12.7"), null);

    const removedNonExistent = await store.unregisterRuntime("non-existent");
    assert.equal(removedNonExistent, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. RuntimeStore: recuperação graciosa em caso de manifesto inválido ou corrompido", async () => {
  const tempDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    await fs.mkdir(path.dirname(store.getManifestPath()), { recursive: true });
    await fs.writeFile(store.getManifestPath(), "{ invalid json ...", "utf8");

    const manifest = await store.loadManifest();
    assert.equal(manifest.version, "1.0");
    assert.deepEqual(manifest.runtimes, {});
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. RuntimeStore: detecção de registros inconsistentes (diretório físico ausente)", async () => {
  const tempDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir: tempDir });
    const realDir = path.join(tempDir, "real-python");
    await fs.mkdir(realDir, { recursive: true });

    const realPy: RuntimeDescriptor = {
      id: "python-real",
      name: "Python",
      version: "3.12",
      category: "provisioned",
      status: "ready",
      installDir: realDir,
      binDirs: [realDir],
      executables: [],
    };

    const ghostPy: RuntimeDescriptor = {
      id: "python-ghost",
      name: "Python",
      version: "3.13",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "ghost-dir-does-not-exist"),
      binDirs: [],
      executables: [],
    };

    await store.registerRuntime(realPy);
    await store.registerRuntime(ghostPy);

    assert.equal(store.verifyPhysicalExistence(realPy), true);
    assert.equal(store.verifyPhysicalExistence(ghostPy), false);

    const inconsistent = await store.detectInconsistentRegistrations();
    assert.equal(inconsistent.length, 1);
    assert.equal(inconsistent[0].id, "python-ghost");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

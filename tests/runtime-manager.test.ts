import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RuntimeManager } from "../src/main/runtime/runtime-manager.ts";
import { RuntimeDescriptor } from "../src/main/runtime/runtime-types.ts";

async function createTempDir(): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, "neko-manager-test-"));
  return dir;
}

// ============================================================================
// SUÍTE DE TESTES: RUNTIME MANAGER (FACHADA E INTEGRACAO DE STORE/DETECTOR)
// ============================================================================

test("1. RuntimeManager: delega registro e consulta de runtimes ao Store", async () => {
  const tempDir = await createTempDir();
  try {
    const manager = new RuntimeManager({ storeOptions: { baseDir: tempDir } });

    const pyDescriptor: RuntimeDescriptor = {
      id: "python-3.12.7",
      name: "Python",
      version: "3.12.7",
      category: "provisioned",
      status: "ready",
      installDir: path.join(tempDir, "py312"),
      binDirs: [path.join(tempDir, "py312")],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    };

    await manager.registerRuntime(pyDescriptor);

    const list = await manager.listRuntimes();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "python-3.12.7");

    const fetched = await manager.getRuntime("python-3.12.7");
    assert.ok(fetched);
    assert.equal(fetched.name, "Python");

    const search = await manager.findRuntimesByName("python");
    assert.equal(search.length, 1);
    assert.equal(search[0].id, "python-3.12.7");

    const unreg = await manager.unregisterRuntime("python-3.12.7");
    assert.equal(unreg, true);
    assert.equal(await manager.getRuntime("python-3.12.7"), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. RuntimeManager: delega detecção de tecnologias ao Detector", async () => {
  const tempDir = await createTempDir();
  try {
    await fs.writeFile(path.join(tempDir, "requirements.txt"), "django==5.0");
    await fs.writeFile(path.join(tempDir, "package.json"), "{}");

    const manager = new RuntimeManager({ storeOptions: { baseDir: tempDir } });
    const results = await manager.detectProjectTechnologies(tempDir);

    assert.equal(results.length, 2);

    const py = results.find((r) => r.technology === "Python");
    assert.ok(py);
    assert.equal(py.confidence, "high");

    const node = results.find((r) => r.technology === "Node.js");
    assert.ok(node);
    assert.equal(node.confidence, "high");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

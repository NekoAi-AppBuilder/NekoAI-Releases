import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RuntimeDetector } from "../src/main/runtime/runtime-detector.ts";

async function createTempProject(): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, "neko-detector-test-"));
  return dir;
}

// ============================================================================
// SUÍTE DE TESTES: RUNTIME DETECTOR (ANÁLISE ESTÁTICA DE PROJETOS)
// ============================================================================

test("1. RuntimeDetector: detecta Node.js via package.json com alta confiança", async () => {
  const tempDir = await createTempProject();
  try {
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "test-app" }));

    const detector = new RuntimeDetector();
    const results = await detector.detectProjectTechnologies(tempDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].technology, "Node.js");
    assert.equal(results[0].confidence, "high");
    assert.equal(results[0].evidence, "package.json");
    assert.equal(results[0].possibleRuntime, "node");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. RuntimeDetector: detecta Python via requirements.txt, pyproject.toml e Pipfile com alta confiança", async () => {
  const tempDir1 = await createTempProject();
  const tempDir2 = await createTempProject();
  const tempDir3 = await createTempProject();

  try {
    const detector = new RuntimeDetector();

    await fs.writeFile(path.join(tempDir1, "requirements.txt"), "flask==3.0.0");
    const res1 = await detector.detectProjectTechnologies(tempDir1);
    assert.equal(res1.length, 1);
    assert.equal(res1[0].technology, "Python");
    assert.equal(res1[0].confidence, "high");
    assert.equal(res1[0].evidence, "requirements.txt");

    await fs.writeFile(path.join(tempDir2, "pyproject.toml"), "[tool.poetry]");
    const res2 = await detector.detectProjectTechnologies(tempDir2);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].technology, "Python");
    assert.equal(res2[0].confidence, "high");
    assert.equal(res2[0].evidence, "pyproject.toml");

    await fs.writeFile(path.join(tempDir3, "Pipfile"), "[packages]");
    const res3 = await detector.detectProjectTechnologies(tempDir3);
    assert.equal(res3.length, 1);
    assert.equal(res3[0].technology, "Python");
    assert.equal(res3[0].confidence, "high");
    assert.equal(res3[0].evidence, "Pipfile");
  } finally {
    await fs.rm(tempDir1, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempDir2, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempDir3, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. RuntimeDetector: detecta Bun via bun.lock e bun.lockb", async () => {
  const tempDir1 = await createTempProject();
  const tempDir2 = await createTempProject();

  try {
    const detector = new RuntimeDetector();

    await fs.writeFile(path.join(tempDir1, "bun.lock"), "");
    const res1 = await detector.detectProjectTechnologies(tempDir1);
    assert.equal(res1.length, 1);
    assert.equal(res1[0].technology, "Bun");
    assert.equal(res1[0].evidence, "bun.lock");

    await fs.writeFile(path.join(tempDir2, "bun.lockb"), "");
    const res2 = await detector.detectProjectTechnologies(tempDir2);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].technology, "Bun");
    assert.equal(res2[0].evidence, "bun.lockb");
  } finally {
    await fs.rm(tempDir1, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempDir2, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. RuntimeDetector: detecta Deno via deno.json e deno.jsonc", async () => {
  const tempDir1 = await createTempProject();
  const tempDir2 = await createTempProject();

  try {
    const detector = new RuntimeDetector();

    await fs.writeFile(path.join(tempDir1, "deno.json"), "{}");
    const res1 = await detector.detectProjectTechnologies(tempDir1);
    assert.equal(res1.length, 1);
    assert.equal(res1[0].technology, "Deno");
    assert.equal(res1[0].evidence, "deno.json");

    await fs.writeFile(path.join(tempDir2, "deno.jsonc"), "{}");
    const res2 = await detector.detectProjectTechnologies(tempDir2);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].technology, "Deno");
    assert.equal(res2[0].evidence, "deno.jsonc");
  } finally {
    await fs.rm(tempDir1, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempDir2, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. RuntimeDetector: detecta PHP via composer.json", async () => {
  const tempDir = await createTempProject();
  try {
    await fs.writeFile(path.join(tempDir, "composer.json"), "{}");

    const detector = new RuntimeDetector();
    const results = await detector.detectProjectTechnologies(tempDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].technology, "PHP");
    assert.equal(results[0].confidence, "high");
    assert.equal(results[0].evidence, "composer.json");
    assert.equal(results[0].possibleRuntime, "php");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. RuntimeDetector: detecção de confiança média via extensão de arquivos (*.py, *.php)", async () => {
  const tempDir = await createTempProject();
  try {
    await fs.writeFile(path.join(tempDir, "script.py"), "print('hello')");
    await fs.writeFile(path.join(tempDir, "index.php"), "<?php echo 'hi';");

    const detector = new RuntimeDetector();
    const results = await detector.detectProjectTechnologies(tempDir);

    assert.equal(results.length, 2);

    const pyRes = results.find((r) => r.technology === "Python");
    assert.ok(pyRes);
    assert.equal(pyRes.confidence, "medium");
    assert.equal(pyRes.evidence, "script.py");

    const phpRes = results.find((r) => r.technology === "PHP");
    assert.ok(phpRes);
    assert.equal(phpRes.confidence, "medium");
    assert.equal(phpRes.evidence, "script.php");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. RuntimeDetector: projeto vazio retorna lista vazia", async () => {
  const tempDir = await createTempProject();
  try {
    const detector = new RuntimeDetector();
    const results = await detector.detectProjectTechnologies(tempDir);

    assert.equal(results.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

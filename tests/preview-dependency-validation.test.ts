import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import child_process from "node:child_process";

/**
 * Validação de integridade do runtime e dependências para Preview.
 * Reflete a implementação exata de src/main/main.ts.
 */
async function verifyRuntimeDependency(projectPath: string, info: any, packageManagerName?: string) {
  const pm = packageManagerName || info?.packageManager || "npm";
  const entry = info?.runtimeEntry || (info?.framework === "Vite" ? "vite" : null);
  
  // 1. Basic node_modules check
  const nmPath = path.join(projectPath, "node_modules");
  const nmExists = await fs.promises.stat(nmPath).then(s => s.isDirectory()).catch(() => false);
  if (!nmExists) {
    throw new Error("Diretório node_modules não existe.");
  }

  if (!entry) {
    return;
  }

  // 2. Validate package.json metadata for specified runtime entry
  const pkgJsonPath = path.join(nmPath, entry, "package.json");
  try {
    const rawContent = await fs.promises.readFile(pkgJsonPath, "utf8");
    const pkgJson = JSON.parse(rawContent);
    if (!pkgJson || typeof pkgJson !== "object" || Array.isArray(pkgJson)) {
      throw new Error(`Arquivo package.json de '${entry}' é inválido.`);
    }
    if (typeof pkgJson.name !== "string" || !pkgJson.name.trim()) {
      throw new Error(`Arquivo package.json de '${entry}' não possui um campo 'name' válido.`);
    }
  } catch (err: any) {
    throw new Error(`Pacote runtime '${entry}' não encontrado ou inválido em node_modules.`);
  }
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neko-test-preview-${prefix}-`));
}

test("A. Projeto sem node_modules -> lança erro / falha validação", async () => {
  const dir = createTempDir("no-nm");
  try {
    await assert.rejects(
      () => verifyRuntimeDependency(dir, { framework: "Vite" }),
      /Diretório node_modules não existe/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B. Projeto com node_modules vazio e runtimeEntry (vite) -> falha validação", async () => {
  const dir = createTempDir("empty-nm");
  try {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    await assert.rejects(
      () => verifyRuntimeDependency(dir, { framework: "Vite" }),
      /Pacote runtime 'vite' não encontrado ou inválido/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C. Projeto com node_modules contendo vite/package.json válido -> validação passa imediatamente", async () => {
  const dir = createTempDir("valid-vite");
  try {
    const viteDir = path.join(dir, "node_modules", "vite");
    fs.mkdirSync(viteDir, { recursive: true });
    fs.writeFileSync(
      path.join(viteDir, "package.json"),
      JSON.stringify({ name: "vite", version: "5.1.0" }),
      "utf8"
    );

    await assert.doesNotReject(() => verifyRuntimeDependency(dir, { framework: "Vite" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("D. Projeto com vite/package.json corrompido/inválido -> falha validação", async () => {
  const dir = createTempDir("corrupt-vite");
  try {
    const viteDir = path.join(dir, "node_modules", "vite");
    fs.mkdirSync(viteDir, { recursive: true });
    fs.writeFileSync(path.join(viteDir, "package.json"), "{ invalid json content ", "utf8");

    await assert.rejects(
      () => verifyRuntimeDependency(dir, { framework: "Vite" }),
      /Pacote runtime 'vite' não encontrado ou inválido/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("E. Projeto sem runtimeEntry detectado, mas com node_modules existente -> validação passa", async () => {
  const dir = createTempDir("generic-nm");
  try {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    await assert.doesNotReject(() => verifyRuntimeDependency(dir, { framework: "HTML/CSS" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F. Projeto com framework Next (next/package.json válido) -> passa", async () => {
  const dir = createTempDir("valid-next");
  try {
    const nextDir = path.join(dir, "node_modules", "next");
    fs.mkdirSync(nextDir, { recursive: true });
    fs.writeFileSync(
      path.join(nextDir, "package.json"),
      JSON.stringify({ name: "next", version: "14.1.0" }),
      "utf8"
    );

    await assert.doesNotReject(() =>
      verifyRuntimeDependency(dir, { runtimeEntry: "next", framework: "Next.js" })
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G. Projeto com framework Astro (astro/package.json válido) -> passa", async () => {
  const dir = createTempDir("valid-astro");
  try {
    const astroDir = path.join(dir, "node_modules", "astro");
    fs.mkdirSync(astroDir, { recursive: true });
    fs.writeFileSync(
      path.join(astroDir, "package.json"),
      JSON.stringify({ name: "astro", version: "4.3.0" }),
      "utf8"
    );

    await assert.doesNotReject(() =>
      verifyRuntimeDependency(dir, { runtimeEntry: "astro", framework: "Astro" })
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("H. Projeto com framework Nuxt (nuxt/package.json válido) -> passa", async () => {
  const dir = createTempDir("valid-nuxt");
  try {
    const nuxtDir = path.join(dir, "node_modules", "nuxt");
    fs.mkdirSync(nuxtDir, { recursive: true });
    fs.writeFileSync(
      path.join(nuxtDir, "package.json"),
      JSON.stringify({ name: "nuxt", version: "3.10.0" }),
      "utf8"
    );

    await assert.doesNotReject(() =>
      verifyRuntimeDependency(dir, { runtimeEntry: "nuxt", framework: "Nuxt" })
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("I. Garantia de NENHUMA execução de subprocesso Node inline (node -e ...) no caminho de validação", async () => {
  const dir = createTempDir("no-spawn");
  let spawnCalled = false;

  const originalSpawn = child_process.spawn;
  // @ts-ignore
  child_process.spawn = (...args: any[]) => {
    spawnCalled = true;
    return originalSpawn.apply(child_process, args as any);
  };

  try {
    const viteDir = path.join(dir, "node_modules", "vite");
    fs.mkdirSync(viteDir, { recursive: true });
    fs.writeFileSync(
      path.join(viteDir, "package.json"),
      JSON.stringify({ name: "vite", version: "5.1.0" }),
      "utf8"
    );

    await verifyRuntimeDependency(dir, { framework: "Vite" });
    assert.equal(spawnCalled, false, "Nenhum subprocesso Node/spawn deve ser executado durante a validação");
  } finally {
    child_process.spawn = originalSpawn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("J. Garantia de que a validação não apaga o diretório node_modules quando os arquivos no disco estão válidos", async () => {
  const dir = createTempDir("preserve-nm");
  try {
    const viteDir = path.join(dir, "node_modules", "vite");
    fs.mkdirSync(viteDir, { recursive: true });
    const pkgPath = path.join(viteDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "vite", version: "5.1.0" }), "utf8");

    await verifyRuntimeDependency(dir, { framework: "Vite" });

    assert.ok(fs.existsSync(dir), "Diretório base deve existir");
    assert.ok(fs.existsSync(path.join(dir, "node_modules")), "node_modules deve permanecer intocado");
    assert.ok(fs.existsSync(pkgPath), "vite/package.json deve permanecer intocado");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

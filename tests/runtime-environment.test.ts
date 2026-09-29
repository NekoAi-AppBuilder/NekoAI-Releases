import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { RuntimeEnvironmentBuilder } from "../src/main/runtime/runtime-environment.ts";
import { RuntimeStore } from "../src/main/runtime/runtime-store.ts";
import { RuntimeManager } from "../src/main/runtime/runtime-manager.ts";
import { RuntimeDescriptor } from "../src/main/runtime/runtime-types.ts";

async function createTempDir(prefix = "neko-env-test-"): Promise<string> {
  const tmpBase = os.tmpdir();
  return await fs.mkdtemp(path.join(tmpBase, prefix));
}

// ============================================================================
// SUÍTE DE TESTES: RUNTIME ENVIRONMENT (ISOLAMENTO, RESOLUÇÃO E PATH)
// ============================================================================

test("1. RuntimeEnvironment: runtime instalado com arquivos físicos gera status 'ready' e ambiente válido", async () => {
  const tempDir = await createTempDir();
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const pyExe = path.join(tempDir, "python.exe");
    await fs.writeFile(pyExe, "MOCK_PYTHON_BINARY");

    const descriptor: RuntimeDescriptor = {
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["."],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
      environmentVariables: { PYTHONUNBUFFERED: "1" },
    };

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor);

    assert.equal(res.status, "ready");
    assert.equal(res.runtimeId, "python-3.12.8");
    assert.equal(res.installDir, tempDir);
    assert.ok(res.env);
    assert.equal(res.executables?.python, pyExe);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. RuntimeEnvironment: PATH coloca binDirs do runtime no topo (no início)", async () => {
  const tempDir = await createTempDir();
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });

    const descriptor: RuntimeDescriptor = {
      id: "bun-1.4.2",
      name: "Bun",
      version: "1.4.2",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["bin"],
      executables: [],
    };

    const dummyBasePath = `${path.join(tempDir, "other")}${path.delimiter}C:\\Windows\\system32`;

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor, {
      basePath: dummyBasePath,
    });

    assert.equal(res.status, "ready");
    assert.ok(res.pathEntries);
    assert.equal(res.pathEntries[0], path.normalize(binDir), "O primeiro item do PATH deve ser o binDir do runtime");
    assert.ok(res.effectivePath?.startsWith(path.normalize(binDir)));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. RuntimeEnvironment: PATH original é preservado após as entradas do runtime", async () => {
  const tempDir = await createTempDir();
  try {
    const descriptor: RuntimeDescriptor = {
      id: "deno-2.9.7",
      name: "Deno",
      version: "2.9.7",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["."],
      executables: [],
    };

    const systemEntry1 = path.normalize("C:\\Windows\\System32");
    const systemEntry2 = path.normalize("C:\\Windows");
    const dummyBasePath = `${systemEntry1}${path.delimiter}${systemEntry2}`;

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor, {
      basePath: dummyBasePath,
    });

    assert.equal(res.status, "ready");
    assert.ok(res.effectivePath);
    assert.ok(res.effectivePath.includes(systemEntry1));
    assert.ok(res.effectivePath.includes(systemEntry2));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. RuntimeEnvironment: PATH não gera entradas duplicadas", async () => {
  const tempDir = await createTempDir();
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });

    const descriptor: RuntimeDescriptor = {
      id: "test-dup-1.0.0",
      name: "TestDup",
      version: "1.0.0",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["bin"],
      executables: [],
    };

    // Dummy basePath que já contém o binDir do runtime para testar deduplicação
    const dummyBasePath = `${binDir}${path.delimiter}${binDir}${path.delimiter}C:\\Tools`;

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor, {
      basePath: dummyBasePath,
    });

    assert.equal(res.status, "ready");
    assert.ok(res.pathEntries);

    const occurrences = res.pathEntries.filter(
      (p) => p.toLowerCase() === path.normalize(binDir).toLowerCase()
    );
    assert.equal(occurrences.length, 1, "O binDir não deve ser duplicado no PATH");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. RuntimeEnvironment: environmentVariables declaradas são aplicadas no env estendido", async () => {
  const tempDir = await createTempDir();
  try {
    const descriptor: RuntimeDescriptor = {
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["."],
      executables: [],
      environmentVariables: {
        PYTHONUNBUFFERED: "1",
        CUSTOM_NEKO_ENV_VAR: "TEST_VALUE_42",
      },
    };

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor);

    assert.equal(res.status, "ready");
    assert.equal(res.env?.PYTHONUNBUFFERED, "1");
    assert.equal(res.env?.CUSTOM_NEKO_ENV_VAR, "TEST_VALUE_42");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. RuntimeEnvironment: PYTHONHOME NÃO é criado ou injetado automaticamente", async () => {
  const tempDir = await createTempDir();
  try {
    const descriptor: RuntimeDescriptor = {
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["."],
      executables: [],
      environmentVariables: { PYTHONUNBUFFERED: "1" },
    };

    const cleanBaseEnv = { ...process.env };
    delete cleanBaseEnv.PYTHONHOME;

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor, {
      baseEnv: cleanBaseEnv,
    });

    assert.equal(res.status, "ready");
    assert.equal(res.env?.PYTHONHOME, undefined, "PYTHONHOME NÃO pode ser injetado no ambiente");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. RuntimeEnvironment: executável existente é resolvido corretamente para caminho absoluto", async () => {
  const tempDir = await createTempDir();
  try {
    const phpExe = path.join(tempDir, "php.exe");
    const phpCgiExe = path.join(tempDir, "php-cgi.exe");
    await fs.writeFile(phpExe, "MOCK_PHP");
    await fs.writeFile(phpCgiExe, "MOCK_PHP_CGI");

    const descriptor: RuntimeDescriptor = {
      id: "php-8.3.35",
      name: "PHP",
      version: "8.3.35",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["."],
      executables: [
        { name: "php", relativePath: "php.exe", type: "runtime" },
        { name: "php-cgi", relativePath: "php-cgi.exe", type: "helper" },
      ],
    };

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor);

    assert.equal(res.status, "ready");
    assert.equal(res.executables?.php, phpExe);
    assert.equal(res.executables?.["php-cgi"], phpCgiExe);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("8. RuntimeEnvironment: executável ausente em disco gera status 'executable-missing'", async () => {
  const tempDir = await createTempDir();
  try {
    // Não criamos o arquivo python.exe intencionalmente
    const descriptor: RuntimeDescriptor = {
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: tempDir,
      binDirs: ["."],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
    };

    const res = RuntimeEnvironmentBuilder.buildEnvironment(descriptor, {
      validateExecutables: true,
    });

    assert.equal(res.status, "executable-missing");
    assert.ok(res.error?.includes("EXECUTABLE_MISSING"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("9. RuntimeManager: consulta de runtime não instalado retorna status 'not-installed'", async () => {
  const baseDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir });
    const manager = new RuntimeManager({ storeOptions: { baseDir } });

    const res = await manager.resolveRuntimeEnvironment("uninstalled-runtime-id");

    assert.equal(res.status, "not-installed");
    assert.ok(res.error?.includes("NOT_INSTALLED"));
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("10. RuntimeEnvironment / RuntimeManager: RuntimeStore inconsistente (pasta excluída fisicamente) gera status 'inconsistent'", async () => {
  const baseDir = await createTempDir();
  try {
    const store = new RuntimeStore({ baseDir });
    const manager = new RuntimeManager({ storeOptions: { baseDir } });

    const phantomDir = path.join(baseDir, "ghost-runtime");

    // Registra runtime que aponta para um diretório que não existe fisicamente
    const descriptor: RuntimeDescriptor = {
      id: "ghost-runtime",
      name: "Ghost Runtime",
      version: "1.0.0",
      category: "provisioned",
      status: "ready",
      installDir: phantomDir,
      binDirs: ["."],
      executables: [],
    };

    await store.registerRuntime(descriptor);

    const res = await manager.resolveRuntimeEnvironment("ghost-runtime");

    assert.equal(res.status, "inconsistent");
    assert.ok(res.error?.includes("INSTALL_DIR_MISSING"));
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("11. RuntimeEnvironment: múltiplos runtimes resolvidos em sequência não se contaminam mutuamente", async () => {
  const dirPy = await createTempDir("neko-py-");
  const dirBun = await createTempDir("neko-bun-");

  try {
    await fs.writeFile(path.join(dirPy, "python.exe"), "PY");
    await fs.writeFile(path.join(dirBun, "bun.exe"), "BUN");

    const pyDesc: RuntimeDescriptor = {
      id: "python-3.12.8",
      name: "Python",
      version: "3.12.8",
      category: "provisioned",
      status: "ready",
      installDir: dirPy,
      binDirs: ["."],
      executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
      environmentVariables: { PYTHONUNBUFFERED: "1" },
    };

    const bunDesc: RuntimeDescriptor = {
      id: "bun-1.4.2",
      name: "Bun",
      version: "1.4.2",
      category: "provisioned",
      status: "ready",
      installDir: dirBun,
      binDirs: ["."],
      executables: [{ name: "bun", relativePath: "bun.exe", type: "runtime" }],
    };

    const baseEnv = { ...process.env, PATH: "C:\\Windows\\System32" };

    const envPy = RuntimeEnvironmentBuilder.buildEnvironment(pyDesc, { baseEnv });
    const envBun = RuntimeEnvironmentBuilder.buildEnvironment(bunDesc, { baseEnv });

    assert.equal(envPy.status, "ready");
    assert.equal(envBun.status, "ready");

    // Verificar que o ambiente de Python possui seu binDir e sua env específica
    assert.ok(envPy.effectivePath?.includes(dirPy));
    assert.equal(envPy.effectivePath?.includes(dirBun), false, "Ambiente Python NÃO pode conter pasta do Bun");
    assert.equal(envPy.env?.PYTHONUNBUFFERED, "1");

    // Verificar que o ambiente de Bun possui seu binDir e não tem variáveis do Python
    assert.ok(envBun.effectivePath?.includes(dirBun));
    assert.equal(envBun.effectivePath?.includes(dirPy), false, "Ambiente Bun NÃO pode conter pasta do Python");
    assert.equal(envBun.env?.PYTHONUNBUFFERED, undefined, "Ambiente Bun NÃO pode herdar env de Python");
  } finally {
    await fs.rm(dirPy, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dirBun, { recursive: true, force: true }).catch(() => {});
  }
});

test("12. GARANTIA ARQUITETURAL: process.env.PATH permanece 100% inalterado após construção de ambientes", async () => {
  const originalProcessPath = process.env.PATH;
  const tempDir = await createTempDir();

  try {
    await fs.writeFile(path.join(tempDir, "python.exe"), "PY");
    await fs.writeFile(path.join(tempDir, "bun.exe"), "BUN");
    await fs.writeFile(path.join(tempDir, "deno.exe"), "DENO");
    await fs.writeFile(path.join(tempDir, "php.exe"), "PHP");

    const descriptors: RuntimeDescriptor[] = [
      {
        id: "python-3.12.8",
        name: "Python",
        version: "3.12.8",
        category: "provisioned",
        status: "ready",
        installDir: tempDir,
        binDirs: ["."],
        executables: [{ name: "python", relativePath: "python.exe", type: "runtime" }],
        environmentVariables: { PYTHONUNBUFFERED: "1" },
      },
      {
        id: "bun-1.4.2",
        name: "Bun",
        version: "1.4.2",
        category: "provisioned",
        status: "ready",
        installDir: tempDir,
        binDirs: ["."],
        executables: [{ name: "bun", relativePath: "bun.exe", type: "runtime" }],
      },
      {
        id: "deno-2.9.7",
        name: "Deno",
        version: "2.9.7",
        category: "provisioned",
        status: "ready",
        installDir: tempDir,
        binDirs: ["."],
        executables: [{ name: "deno", relativePath: "deno.exe", type: "runtime" }],
      },
      {
        id: "php-8.3.35",
        name: "PHP",
        version: "8.3.35",
        category: "provisioned",
        status: "ready",
        installDir: tempDir,
        binDirs: ["."],
        executables: [{ name: "php", relativePath: "php.exe", type: "runtime" }],
      },
    ];

    for (const desc of descriptors) {
      const res = RuntimeEnvironmentBuilder.buildEnvironment(desc);
      assert.equal(res.status, "ready");
    }

    // Validação estrita de imutabilidade global do PATH do processo
    assert.equal(
      process.env.PATH,
      originalProcessPath,
      "GARANTIA ARQUITETURAL: process.env.PATH global NÃO pode sofrer mutação após construção dos ambientes"
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

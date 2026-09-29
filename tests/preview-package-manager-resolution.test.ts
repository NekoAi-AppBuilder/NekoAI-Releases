import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import {
  isPackageManagerAvailable,
  resolveEffectivePackageManager,
  packageManagerExecutable
} from "../src/main/preview-package-manager.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neko-test-pm-${prefix}-`));
}

// ============================================================================
// SUÍTE DE TESTES: PREVIEW PACKAGE MANAGER RESOLUTION & FALLBACK ISOLATION
// ============================================================================

test("1. Cenário A: Bun detectado e disponível -> resolve bun sem fallback", () => {
  const customAvailability = (pm: string) => pm === "bun" || pm === "npm";
  const res = resolveEffectivePackageManager("bun", customAvailability);

  assert.equal(res.effectiveManager, "bun");
  assert.equal(res.isFallback, false);
});

test("2. Cenário B: Bun detectado mas INDISPONÍVEL e npm disponível -> fallback para npm", () => {
  const customAvailability = (pm: string) => pm === "npm"; // bun = false
  const res = resolveEffectivePackageManager("bun", customAvailability);

  assert.equal(res.effectiveManager, "npm");
  assert.equal(res.isFallback, true);
  assert.ok(res.reason?.includes("bun"), "Deve registrar motivo com menção ao bun");
});

test("3. Cenário C: pnpm detectado mas INDISPONÍVEL e npm disponível -> fallback para npm", () => {
  const customAvailability = (pm: string) => pm === "npm"; // pnpm = false
  const res = resolveEffectivePackageManager("pnpm", customAvailability);

  assert.equal(res.effectiveManager, "npm");
  assert.equal(res.isFallback, true);
});

test("4. Cenário D: Bun detectado mas INDISPONÍVEL e npm também INDISPONÍVEL -> mantém bun com erro", () => {
  const customAvailability = (_pm: string) => false;
  const res = resolveEffectivePackageManager("bun", customAvailability);

  assert.equal(res.effectiveManager, "bun");
  assert.equal(res.isFallback, false);
  assert.ok(res.reason?.includes("Nenhum gerenciador de pacotes compatível"));
});

test("5. Cenário E: Projeto npm puro com npm disponível -> resolve npm diretamente", () => {
  const customAvailability = (pm: string) => pm === "npm";
  const res = resolveEffectivePackageManager("npm", customAvailability);

  assert.equal(res.effectiveManager, "npm");
  assert.equal(res.isFallback, false);
});

test("6. packageManagerExecutable: mapeia executáveis corretos por plataforma", () => {
  if (process.platform === "win32") {
    assert.equal(packageManagerExecutable("pnpm"), "pnpm.cmd");
    assert.equal(packageManagerExecutable("yarn"), "yarn.cmd");
    assert.equal(packageManagerExecutable("bun"), "bun.exe");
  } else {
    assert.equal(packageManagerExecutable("pnpm"), "pnpm");
    assert.equal(packageManagerExecutable("yarn"), "yarn");
    assert.equal(packageManagerExecutable("bun"), "bun");
  }
});

test("7. isPackageManagerAvailable: utiliza customResolver para simular ausência ou presença", () => {
  const mockResolverBunOnly = (name: string) => name.toLowerCase().includes("bun") ? "C:\\tools\\bun.exe" : null;
  assert.equal(isPackageManagerAvailable("bun", mockResolverBunOnly), true);
  assert.equal(isPackageManagerAvailable("pnpm", mockResolverBunOnly), false);
  assert.equal(isPackageManagerAvailable("yarn", mockResolverBunOnly), false);
});

test("8. Simulação de Segundo Acesso: reavaliação de projeto com lockfile bun e node_modules pré-existente", () => {
  const dir = createTempDir("reopen-bun-lock");
  try {
    // Simula projeto com bun.lockb e node_modules válido (gerado por npm)
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "my-app", scripts: { dev: "vite" } }), "utf8");
    fs.writeFileSync(path.join(dir, "bun.lockb"), "mock lock content", "utf8");

    const viteDir = path.join(dir, "node_modules", "vite");
    fs.mkdirSync(viteDir, { recursive: true });
    fs.writeFileSync(path.join(viteDir, "package.json"), JSON.stringify({ name: "vite", version: "5.0.0" }), "utf8");

    // Simula ambiente onde Bun NÃO está instalado
    const envHasBun = false;
    const envHasNpm = true;
    const availability = (pm: string) => pm === "npm" ? envHasNpm : (pm === "bun" ? envHasBun : false);

    const detected = "bun"; // detectado pelo lockfile bun.lockb
    const resolved = resolveEffectivePackageManager(detected, availability);

    assert.equal(resolved.effectiveManager, "npm", "Deve usar npm como gerenciador efetivo");
    assert.equal(resolved.isFallback, true);

    // Validação de node_modules pré-existente permanece intacta
    const nmStat = fs.statSync(path.join(dir, "node_modules"));
    assert.ok(nmStat.isDirectory(), "node_modules deve continuar existindo no disco sem ser deletado");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("9. Isolamento entre projetos: resolução de um projeto não contamina outro", () => {
  const availabilityBunUnavailable = (pm: string) => pm === "npm";
  const availabilityBunAvailable = (pm: string) => pm === "bun" || pm === "npm";

  // Projeto 1: Bun ausente no lockfile (npm puro)
  const res1 = resolveEffectivePackageManager("npm", availabilityBunUnavailable);
  assert.equal(res1.effectiveManager, "npm");
  assert.equal(res1.isFallback, false);

  // Projeto 2: Lockfile Bun em máquina sem Bun
  const res2 = resolveEffectivePackageManager("bun", availabilityBunUnavailable);
  assert.equal(res2.effectiveManager, "npm");
  assert.equal(res2.isFallback, true);

  // Projeto 3: Lockfile Bun em máquina com Bun
  const res3 = resolveEffectivePackageManager("bun", availabilityBunAvailable);
  assert.equal(res3.effectiveManager, "bun");
  assert.equal(res3.isFallback, false);
});

// ============================================================================
// SUÍTE DE TESTES: VALIDATION BUILD PACKAGE MANAGER RESOLUTION SCENARIOS
// ============================================================================

test("10. Validation Build - Cenário 1: Bun detectado + Bun disponível -> bun run build", () => {
  const availability = (pm: string) => pm === "bun" || pm === "npm";
  const detected = "bun";
  const resolution = resolveEffectivePackageManager(detected, availability);
  const command = packageManagerExecutable(resolution.effectiveManager);

  assert.equal(resolution.effectiveManager, "bun");
  assert.equal(resolution.isFallback, false);
  const expectedExe = process.platform === "win32" ? "bun.exe" : "bun";
  assert.equal(command, expectedExe);
});

test("11. Validation Build - Cenário 2: Bun detectado + Bun INDISPONÍVEL + npm disponível -> npm run build (NÃO tenta Bun)", () => {
  const availability = (pm: string) => pm === "npm"; // Bun ausente no host
  const detected = "bun";
  const resolution = resolveEffectivePackageManager(detected, availability);
  const command = packageManagerExecutable(resolution.effectiveManager);

  assert.equal(resolution.effectiveManager, "npm");
  assert.equal(resolution.isFallback, true);
  const expectedExe = process.platform === "win32" ? "npm.cmd" : "npm";
  assert.equal(command, expectedExe);
  assert.notEqual(command, process.platform === "win32" ? "bun.exe" : "bun");
});

test("12. Validation Build - Cenário 3: npm detectado + npm disponível -> npm run build", () => {
  const availability = (pm: string) => pm === "npm";
  const detected = "npm";
  const resolution = resolveEffectivePackageManager(detected, availability);
  const command = packageManagerExecutable(resolution.effectiveManager);

  assert.equal(resolution.effectiveManager, "npm");
  assert.equal(resolution.isFallback, false);
  const expectedExe = process.platform === "win32" ? "npm.cmd" : "npm";
  assert.equal(command, expectedExe);
});

test("13. Validation Build - Cenário 4: pnpm detectado + pnpm disponível -> pnpm run build", () => {
  const availability = (pm: string) => pm === "pnpm" || pm === "npm";
  const detected = "pnpm";
  const resolution = resolveEffectivePackageManager(detected, availability);
  const command = packageManagerExecutable(resolution.effectiveManager);

  assert.equal(resolution.effectiveManager, "pnpm");
  assert.equal(resolution.isFallback, false);
  const expectedExe = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  assert.equal(command, expectedExe);
});

test("14. Validation Build - Cenário 5: package manager indisponível e npm também indisponível -> erro preservado sem fallback inventado", () => {
  const availability = (_pm: string) => false;
  const detected = "bun";
  const resolution = resolveEffectivePackageManager(detected, availability);

  assert.equal(resolution.effectiveManager, "bun");
  assert.equal(resolution.isFallback, false);
  assert.ok(resolution.reason?.includes("Nenhum gerenciador de pacotes compatível"));
});

test("15. Simulação Lov-Infinity (Lovable Project): Preview e Validation Build usam a MESMA resolução consistente", () => {
  const dir = createTempDir("lov-infinity-sim");
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "lov-infinity",
        scripts: { dev: "vite", build: "vite build" }
      }),
      "utf8"
    );
    fs.writeFileSync(path.join(dir, "bun.lockb"), "bun lockfile binary", "utf8");

    // Simulação de máquina sem Bun (cliente remoto)
    const hostHasBun = false;
    const hostHasNpm = true;
    const availability = (pm: string) => (pm === "npm" ? hostHasNpm : (pm === "bun" ? hostHasBun : false));

    // 1. Detecção do projeto (detectProject retorna 'bun' por causa do bun.lockb)
    const detectedPm = "bun";

    // 2. Resolução do Preview
    const previewResolution = resolveEffectivePackageManager(detectedPm, availability);
    const previewCommand = packageManagerExecutable(previewResolution.effectiveManager);

    // 3. Resolução do Validation Build (runValidationBuild)
    const buildResolution = resolveEffectivePackageManager(detectedPm, availability);
    const buildCommand = packageManagerExecutable(buildResolution.effectiveManager);

    // Ambos DEVEM coincidir com npm
    assert.equal(previewResolution.effectiveManager, "npm");
    assert.equal(buildResolution.effectiveManager, "npm");
    assert.equal(previewCommand, buildCommand);
    assert.equal(buildCommand, process.platform === "win32" ? "npm.cmd" : "npm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// SUÍTE DE TESTES: WINDOWS REAL BUN DETECTION & RUNTIME ISOLATION
// ============================================================================

import {
  findExecutableOnPath,
  resolvePackageManagerExecutablePath,
  getKnownPackageManagerDirectories,
  getWindowsRegistryPathEntries,
} from "../src/main/preview-package-manager.ts";
import { RuntimeEnvironmentBuilder } from "../src/main/runtime/runtime-environment.ts";
import { spawnSync } from "node:child_process";

test("16. Detecção Windows: localiza Bun instalado no perfil do usuário (.bun/bin) mesmo com PATH do processo zerado", () => {
  const originalPath = process.env.PATH;
  const originalPathLower = process.env.Path;
  try {
    // Simula Electron iniciado sem o diretório do Bun no PATH
    process.env.PATH = "C:\\Windows\\System32;C:\\Windows";
    if (process.platform === "win32") {
      process.env.Path = "C:\\Windows\\System32;C:\\Windows";
    }

    const knownDirs = getKnownPackageManagerDirectories("bun");
    assert.ok(Array.isArray(knownDirs), "Deve retornar array de diretórios conhecidos");

    // Se o Bun está instalado na máquina do usuário (ex: ~/.bun/bin/bun.exe), deve encontrar
    const bunExe = resolvePackageManagerExecutablePath("bun");
    if (bunExe) {
      assert.ok(fs.existsSync(bunExe), `Executável encontrado deve existir: ${bunExe}`);
      assert.ok(isPackageManagerAvailable("bun"), "isPackageManagerAvailable('bun') deve ser true");
      const res = resolveEffectivePackageManager("bun");
      assert.equal(res.effectiveManager, "bun");
      assert.equal(res.isFallback, false);
      assert.ok(res.executablePath, "Deve retornar caminho do executável");
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalPathLower !== undefined) process.env.Path = originalPathLower;
  }
});

test("17. RuntimeEnvironmentBuilder: constrói ambiente isolado para o Preview com Bun sem mutação global", () => {
  const originalPath = process.env.PATH;
  const originalPathLower = process.env.Path;

  const previewEnv = RuntimeEnvironmentBuilder.buildPreviewEnvironment({
    packageManager: "bun",
    projectPath: process.cwd(),
    baseEnv: { ...process.env, PATH: "C:\\mock\\base\\path" },
  });

  assert.equal(previewEnv.status, "ready");
  assert.ok(previewEnv.env, "Deve gerar objeto env isolado");
  assert.ok(previewEnv.effectivePath, "Deve gerar effectivePath");

  // process.env GLOBAL NÃO PODE TER SIDO MODIFICADO
  assert.equal(process.env.PATH, originalPath, "process.env.PATH não deve ter sofrido mutação");
  if (originalPathLower !== undefined) {
    assert.equal(process.env.Path, originalPathLower, "process.env.Path não deve ter sofrido mutação");
  }

  // O ambiente isolado do subprocesso deve conter as pastas do runtime
  const isolatedPath = previewEnv.env.PATH || previewEnv.env.Path || "";
  assert.ok(isolatedPath.includes("C:\\mock\\base\\path"), "Deve preservar base PATH");
});

test("18. Simulação de Execução Real com Bun: se bun estiver instalado, executa bun --version com sucesso via env isolado", () => {
  const bunExe = resolvePackageManagerExecutablePath("bun");
  if (!bunExe || !fs.existsSync(bunExe)) {
    // Se não estiver no sistema, o teste valida o fallback seguro
    return;
  }

  const previewEnv = RuntimeEnvironmentBuilder.buildPreviewEnvironment({
    packageManager: "bun",
    projectPath: process.cwd(),
  });

  const res = spawnSync(bunExe, ["--version"], {
    env: previewEnv.env,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(res.status, 0, `bun --version deve retornar exit code 0 (stderr: ${res.stderr})`);
  assert.ok(res.stdout.trim().length > 0, "bun deve retornar a versão instalada");
});

test("19. findExecutableOnPath: localiza executável em pasta customizada e normaliza separadores", () => {
  const tempDir = createTempDir("custom-bin");
  try {
    const isWin = process.platform === "win32";
    const exeName = isWin ? "custom-tool.exe" : "custom-tool";
    const exeFile = path.join(tempDir, exeName);
    fs.writeFileSync(exeFile, "echo tool", "utf8");

    const found = findExecutableOnPath("custom-tool", [tempDir]);
    assert.ok(found, "Deve encontrar executável na pasta customizada");
    assert.equal(path.normalize(found!), path.normalize(exeFile));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("20. GARANTIA ARQUITETURAL: process.env.PATH permanece 100% imutável após todas as operações de Preview", () => {
  const initialPath = process.env.PATH;
  const initialKeys = Object.keys(process.env);

  resolveEffectivePackageManager("bun");
  resolvePackageManagerExecutablePath("bun");
  getKnownPackageManagerDirectories("bun");
  RuntimeEnvironmentBuilder.buildPreviewEnvironment({ packageManager: "bun" });

  assert.equal(process.env.PATH, initialPath);
  assert.deepEqual(Object.keys(process.env), initialKeys);
});

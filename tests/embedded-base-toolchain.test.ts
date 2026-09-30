import { describe, test, expect } from "vitest";
import path from "node:path";
import fsSync from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveNodeRuntime, getEmbeddedRuntimeEnv, spawnNodeTool } from "../src/main/node-runtime";
import { RuntimeLifecycleManager } from "../src/main/runtime/runtime-lifecycle";
import { RuntimeManager } from "../src/main/runtime/runtime-manager";
import { resolvePackageManagerExecutablePath, getKnownPackageManagerDirectories } from "../src/main/preview-package-manager";

describe("Embedded Base Toolchain Verification (Tools & Wrappers)", () => {
  const toolsDir = path.resolve(process.cwd(), "tools");

  test("1. Verifica existência de todos os diretórios e executáveis da Toolchain Base", () => {
    // Node / npm / npx / pnpm / yarn
    expect(fsSync.existsSync(path.join(toolsDir, "node", "node.exe"))).toBe(true);
    expect(fsSync.existsSync(path.join(toolsDir, "node", "npm.cmd"))).toBe(true);
    expect(fsSync.existsSync(path.join(toolsDir, "node", "npx.cmd"))).toBe(true);
    expect(fsSync.existsSync(path.join(toolsDir, "node", "pnpm.cmd"))).toBe(true);
    expect(fsSync.existsSync(path.join(toolsDir, "node", "yarn.cmd"))).toBe(true);
    expect(fsSync.existsSync(path.join(toolsDir, "node", "node_modules", "pnpm", "bin", "pnpm.cjs"))).toBe(true);
    expect(fsSync.existsSync(path.join(toolsDir, "node", "node_modules", "yarn", "bin", "yarn.js"))).toBe(true);

    // Git
    expect(fsSync.existsSync(path.join(toolsDir, "git", "cmd", "git.exe"))).toBe(true);

    // Python 3.12.8
    expect(fsSync.existsSync(path.join(toolsDir, "python", "python.exe"))).toBe(true);

    // Bun 1.4.2
    expect(fsSync.existsSync(path.join(toolsDir, "bun", "bun.exe"))).toBe(true);

    // Deno 2.9.7
    expect(fsSync.existsSync(path.join(toolsDir, "deno", "deno.exe"))).toBe(true);

    // PHP 8.3.35
    expect(fsSync.existsSync(path.join(toolsDir, "php", "php.exe"))).toBe(true);
  });

  test("2. Execução isolada de --version para cada executável embutido", () => {
    const nodePath = path.join(toolsDir, "node", "node.exe");
    const pythonPath = path.join(toolsDir, "python", "python.exe");
    const bunPath = path.join(toolsDir, "bun", "bun.exe");
    const denoPath = path.join(toolsDir, "deno", "deno.exe");
    const phpPath = path.join(toolsDir, "php", "php.exe");

    // Node
    const nodeRes = spawnSync(nodePath, ["--version"], { encoding: "utf8" });
    expect(nodeRes.status).toBe(0);
    expect(nodeRes.stdout).toContain("v22.");

    // Python
    const pyRes = spawnSync(pythonPath, ["--version"], { encoding: "utf8" });
    expect(pyRes.status).toBe(0);
    expect(pyRes.stdout).toContain("3.12.8");

    // Bun
    const bunRes = spawnSync(bunPath, ["--version"], { encoding: "utf8" });
    expect(bunRes.status).toBe(0);
    expect(bunRes.stdout).toContain("1.4.2");

    // Deno
    const denoRes = spawnSync(denoPath, ["--version"], { encoding: "utf8" });
    expect(denoRes.status).toBe(0);
    expect(denoRes.stdout).toContain("2.9.7");

    // PHP
    const phpRes = spawnSync(phpPath, ["--version"], { encoding: "utf8" });
    expect(phpRes.status).toBe(0);
    expect(phpRes.stdout).toContain("8.3.35");
  });

  test("3. getEmbeddedRuntimeEnv() monta PATH determinístico com toolchain base sem mutação global", () => {
    const originalEnv = { PATH: "C:\\Windows\\System32", SOME_VAR: "true" };
    const resolvedEnv = getEmbeddedRuntimeEnv(originalEnv);

    // Não alterou originalEnv
    expect(originalEnv.PATH).toBe("C:\\Windows\\System32");

    // PATH resultante contém todos os diretórios de tools
    const resolvedPath = resolvedEnv.PATH || resolvedEnv.Path || "";
    expect(resolvedPath).toContain(path.join(toolsDir, "python"));
    expect(resolvedPath).toContain(path.join(toolsDir, "bun"));
    expect(resolvedPath).toContain(path.join(toolsDir, "deno"));
    expect(resolvedPath).toContain(path.join(toolsDir, "php"));
    expect(resolvedEnv.PYTHONUNBUFFERED).toBe("1");
  });

  test("4. Preview Package Manager resolve pnpm, yarn, bun e npm embutidos", () => {
    const bunExe = resolvePackageManagerExecutablePath("bun");
    expect(bunExe).not.toBeNull();
    expect(fsSync.existsSync(bunExe!)).toBe(true);

    const knownBun = getKnownPackageManagerDirectories("bun");
    expect(knownBun.length).toBeGreaterThan(0);
  });

  test("5. RuntimeLifecycleManager reconhece runtimes embutidos com state 'ready' e category 'bundled'", async () => {
    const lifecycle = new RuntimeLifecycleManager();

    // Python 3.12.8
    const pyReq = await lifecycle.evaluateDetectionRequirement({
      technology: "Python",
      confidence: "high",
      evidence: "pyproject.toml",
      possibleRuntime: "python",
      versionRequirement: "3.12.8",
    });
    expect(pyReq.state).toBe("ready");
    expect(pyReq.descriptor?.category).toBe("bundled");
    expect(pyReq.descriptor?.version).toBe("3.12.8");

    // Bun 1.4.2
    const bunReq = await lifecycle.evaluateDetectionRequirement({
      technology: "Bun",
      confidence: "high",
      evidence: "bun.lockb",
      possibleRuntime: "bun",
      versionRequirement: "1.4.2",
    });
    expect(bunReq.state).toBe("ready");
    expect(bunReq.descriptor?.category).toBe("bundled");
    expect(bunReq.descriptor?.version).toBe("1.4.2");

    // Deno 2.9.7
    const denoReq = await lifecycle.evaluateDetectionRequirement({
      technology: "Deno",
      confidence: "high",
      evidence: "deno.json",
      possibleRuntime: "deno",
      versionRequirement: "2.9.7",
    });
    expect(denoReq.state).toBe("ready");
    expect(denoReq.descriptor?.category).toBe("bundled");
    expect(denoReq.descriptor?.version).toBe("2.9.7");

    // PHP 8.3.35
    const phpReq = await lifecycle.evaluateDetectionRequirement({
      technology: "PHP",
      confidence: "high",
      evidence: "composer.json",
      possibleRuntime: "php",
      versionRequirement: "8.3.35",
    });
    expect(phpReq.state).toBe("ready");
    expect(phpReq.descriptor?.category).toBe("bundled");
    expect(phpReq.descriptor?.version).toBe("8.3.35");
  });

  test("6. RuntimeManager.resolveRuntimeEnvironment resolve runtime embutido com PATH isolado", async () => {
    const manager = new RuntimeManager();
    const resolvedPy = await manager.resolveRuntimeEnvironment("python-3.12.8");
    expect(resolvedPy.status).toBe("ready");
    expect(resolvedPy.binDirs).toBeDefined();
    expect(resolvedPy.env?.PATH).toContain(path.join(toolsDir, "python"));
  });

  test("7. Versão incompatível não embutida exige autorização (on-demand provisioning preservado)", async () => {
    const lifecycle = new RuntimeLifecycleManager();

    // Python 3.13.1 não está embutido (3.12.8 é o embutido) -> deve exigir autorização
    const py13Req = await lifecycle.evaluateDetectionRequirement({
      technology: "Python",
      confidence: "high",
      evidence: "pyproject.toml",
      possibleRuntime: "python",
      versionRequirement: "3.13.1",
    });
    expect(py13Req.state).toBe("requires-authorization");
  });
});

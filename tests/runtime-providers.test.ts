import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PythonProvider,
  BunProvider,
  DenoProvider,
  PHPProvider,
} from "../src/main/runtime/providers";
import { RuntimeManager } from "../src/main/runtime/runtime-manager.ts";
import { RuntimeProvider, RuntimeDistribution } from "../src/main/runtime/runtime-types.ts";

// ============================================================================
// SUÍTE DE TESTES: RUNTIME PROVIDERS (METADADOS, VERIFICAÇÃO E COMPATIBILIDADE)
// ============================================================================

test("1. PythonProvider: especificação formal de distribuição e compatibilidade", () => {
  const provider = new PythonProvider();

  assert.equal(provider.id, "python");
  assert.equal(provider.name, "Python Runtime Provider");
  assert.deepEqual(provider.supportedVersions, ["3.12.8", "3.13.1"]);

  const versions = provider.getSupportedVersions();
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, "3.12.8");

  // Distribuição válida win32 x64
  const dist = provider.getDistribution("3.12.8", "win32", "x64");
  assert.ok(dist);
  assert.equal(dist.runtime, "python");
  assert.equal(dist.version, "3.12.8");
  assert.equal(dist.platform, "win32");
  assert.equal(dist.architecture, "x64");
  assert.ok(dist.url.startsWith("https://"));
  assert.equal(dist.status, "verified");
  assert.equal(dist.expectedSha256.length, 64);
  assert.equal(dist.archiveType, "zip");
  assert.deepEqual(dist.binDirs, ["."]);
  assert.equal(dist.executables[0].name, "python");
  assert.equal(dist.executables[0].relativePath, "python.exe");
  assert.equal(dist.environmentVariables?.PYTHONUNBUFFERED, "1");

  // Verificabilidade
  assert.equal(provider.isDistributionVerifiable("3.12.8", "win32", "x64"), true);

  // Incompatibilidade de plataforma ou versão
  assert.equal(provider.getDistribution("3.12.8", "linux", "x64"), undefined);
  assert.equal(provider.getDistribution("3.12.8", "darwin", "x64"), undefined);
  assert.equal(provider.getDistribution("9.9.9", "win32", "x64"), undefined);
});

test("2. BunProvider: especificação formal de distribuição e compatibilidade", () => {
  const provider = new BunProvider();

  assert.equal(provider.id, "bun");
  assert.equal(provider.name, "Bun Runtime Provider");
  assert.deepEqual(provider.supportedVersions, ["1.4.2"]);

  const dist = provider.getDistribution("1.4.2", "win32", "x64");
  assert.ok(dist);
  assert.equal(dist.runtime, "bun");
  assert.equal(dist.version, "1.4.2");
  assert.ok(dist.url.startsWith("https://"));
  assert.equal(dist.status, "verified");
  assert.equal(dist.expectedSha256.length, 64);
  assert.deepEqual(dist.binDirs, ["bun-windows-x64"]);
  assert.equal(dist.executables[0].name, "bun");
  assert.equal(dist.executables[0].relativePath, "bun-windows-x64/bun.exe");

  assert.equal(provider.isDistributionVerifiable("1.4.2", "win32", "x64"), true);
  assert.equal(provider.getDistribution("1.4.2", "linux", "x64"), undefined);
});

test("3. DenoProvider: especificação formal de distribuição e compatibilidade", () => {
  const provider = new DenoProvider();

  assert.equal(provider.id, "deno");
  assert.equal(provider.name, "Deno Runtime Provider");
  assert.deepEqual(provider.supportedVersions, ["2.9.7"]);

  const dist = provider.getDistribution("2.9.7", "win32", "x64");
  assert.ok(dist);
  assert.equal(dist.runtime, "deno");
  assert.equal(dist.version, "2.9.7");
  assert.ok(dist.url.startsWith("https://"));
  assert.equal(dist.status, "verified");
  assert.equal(dist.expectedSha256.length, 64);
  assert.deepEqual(dist.binDirs, ["."]);
  assert.equal(dist.executables[0].name, "deno");
  assert.equal(dist.executables[0].relativePath, "deno.exe");

  assert.equal(provider.isDistributionVerifiable("2.9.7", "win32", "x64"), true);
  assert.equal(provider.getDistribution("2.9.7", "win32", "arm64"), undefined);
});

test("4. PHPProvider: especificação formal de distribuição e compatibilidade (Non-Thread-Safe x64)", () => {
  const provider = new PHPProvider();

  assert.equal(provider.id, "php");
  assert.equal(provider.name, "PHP Runtime Provider");
  assert.deepEqual(provider.supportedVersions, ["8.2.34", "8.3.35"]);

  const dist = provider.getDistribution("8.3.35", "win32", "x64");
  assert.ok(dist);
  assert.equal(dist.runtime, "php");
  assert.equal(dist.version, "8.3.35");
  assert.ok(dist.url.startsWith("https://"));
  assert.equal(dist.status, "verified");
  assert.equal(dist.expectedSha256.length, 64);
  assert.deepEqual(dist.binDirs, ["."]);
  assert.equal(dist.executables[0].name, "php");
  assert.equal(dist.executables[0].relativePath, "php.exe");

  assert.equal(provider.isDistributionVerifiable("8.3.35", "win32", "x64"), true);
  assert.equal(provider.getDistribution("8.3.35", "darwin", "x64"), undefined);
});

test("5. Teste de Segurança: rejeição de distribuições inseguras, unverified ou sem SHA-256", () => {
  class MockUnverifiedProvider implements RuntimeProvider {
    public readonly id = "unverified-lang";
    public readonly name = "Unverified Provider";
    public readonly supportedVersions = ["1.0.0"];

    public getSupportedVersions() {
      return [{ version: "1.0.0" }];
    }

    public getDistribution(version: string, platform: any, architecture: any): RuntimeDistribution | undefined {
      if (version === "1.0.0") {
        return {
          runtime: "unverified-lang",
          version: "1.0.0",
          platform: "win32",
          architecture: "x64",
          url: "http://insecure-mirror.com/lang.zip",
          expectedSha256: "",
          status: "unverified",
          archiveType: "zip",
          binDirs: ["."],
          executables: [],
        };
      }
      return undefined;
    }

    public isDistributionVerifiable(version: string, platform: any, architecture: any): boolean {
      const dist = this.getDistribution(version, platform, architecture);
      return Boolean(dist && dist.status === "verified" && dist.expectedSha256 && dist.url.startsWith("https://"));
    }
  }

  const unverifiedProvider = new MockUnverifiedProvider();

  assert.equal(unverifiedProvider.isDistributionVerifiable("1.0.0", "win32", "x64"), false);
});

test("6. RuntimeManager: registro e consulta centralizada de RuntimeProviders", () => {
  const manager = new RuntimeManager();

  const providers = manager.listProviders();
  assert.equal(providers.length, 4, "Manager deve registrar os 4 providers padrão (Python, Bun, Deno, PHP)");

  const pythonProvider = manager.getProvider("python");
  assert.ok(pythonProvider);
  assert.equal(pythonProvider.id, "python");

  const phpProvider = manager.getProvider("php");
  assert.ok(phpProvider);
  assert.equal(phpProvider.id, "php");

  // Consulta de distribuição via Manager
  const pyDist = manager.getDistribution("python", "3.12.8", "win32", "x64");
  assert.ok(pyDist);
  assert.equal(pyDist.version, "3.12.8");
  assert.equal(pyDist.status, "verified");

  // Consulta para runtime inexistente no manager
  const unknownDist = manager.getDistribution("ruby", "3.0.0", "win32", "x64");
  assert.equal(unknownDist, undefined);
});

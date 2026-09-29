// src/main/runtime/providers/php-provider.ts
// Especificação formal e metadados do provedor oficial de runtime PHP para Windows.

import {
  RuntimeArchitecture,
  RuntimeDistribution,
  RuntimePlatform,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../runtime-types";

export class PHPProvider implements RuntimeProvider {
  public readonly id = "php";
  public readonly name = "PHP Runtime Provider";
  public readonly supportedVersions = ["8.2.34", "8.3.35"];

  private distributions: Record<string, RuntimeDistribution> = {
    "8.2.34:win32:x64": {
      runtime: "php",
      version: "8.2.34",
      platform: "win32",
      architecture: "x64",
      url: "https://windows.php.net/downloads/releases/php-8.2.34-nts-Win32-vs16-x64.zip",
      expectedSha256: "03249b5c9414c6dbe30276f4a7598bd9d2a7417ee81f709b06b99e9c4a2aff4f",
      status: "verified",
      sizeBytes: 33472978,
      archiveType: "zip",
      binDirs: ["."],
      executables: [
        { name: "php", relativePath: "php.exe", type: "runtime" },
        { name: "php-win", relativePath: "php-win.exe", type: "helper" },
        { name: "php-cgi", relativePath: "php-cgi.exe", type: "helper" },
      ],
      notes: "PHP 8.2.34 Non-Thread-Safe (NTS) x64 oficial de windows.php.net. Otimizado para execução CLI e subprocessos.",
    },
    "8.3.35:win32:x64": {
      runtime: "php",
      version: "8.3.35",
      platform: "win32",
      architecture: "x64",
      url: "https://windows.php.net/downloads/releases/php-8.3.35-nts-Win32-vs16-x64.zip",
      expectedSha256: "25a8e2ac9ff30f1d768d1447c09a600617fa6e6082729f6e95f008b59c91fe45",
      status: "verified",
      sizeBytes: 33873909,
      archiveType: "zip",
      binDirs: ["."],
      executables: [
        { name: "php", relativePath: "php.exe", type: "runtime" },
        { name: "php-win", relativePath: "php-win.exe", type: "helper" },
        { name: "php-cgi", relativePath: "php-cgi.exe", type: "helper" },
      ],
      notes: "PHP 8.3.35 Non-Thread-Safe (NTS) x64 oficial de windows.php.net. Otimizado para execução CLI e subprocessos.",
    },
  };

  public getSupportedVersions(): RuntimeVersionSpec[] {
    return [
      { version: "8.2.34", isLts: false, isStable: true, notes: "PHP 8.2.34 Non-Thread-Safe x64 (Compatibilidade legada)" },
      { version: "8.3.35", isLts: false, isStable: true, notes: "PHP 8.3.35 Non-Thread-Safe x64 (Versão estável homologada)" },
    ];
  }

  public getDistribution(
    version: string,
    platform: RuntimePlatform,
    architecture: RuntimeArchitecture
  ): RuntimeDistribution | undefined {
    const key = `${version}:${platform}:${architecture}`;
    const dist = this.distributions[key];

    if (!dist) return undefined;

    if (!dist.url.startsWith("https://") || dist.status !== "verified" || !dist.expectedSha256) {
      return undefined;
    }

    return dist;
  }

  public isDistributionVerifiable(
    version: string,
    platform: RuntimePlatform,
    architecture: RuntimeArchitecture
  ): boolean {
    const dist = this.getDistribution(version, platform, architecture);
    return Boolean(dist && dist.status === "verified" && dist.expectedSha256 && dist.url.startsWith("https://"));
  }
}

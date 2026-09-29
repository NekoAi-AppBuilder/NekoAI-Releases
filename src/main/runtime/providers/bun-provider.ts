// src/main/runtime/providers/bun-provider.ts
// Especificação formal e metadados do provedor oficial de runtime Bun para Windows.

import {
  RuntimeArchitecture,
  RuntimeDistribution,
  RuntimePlatform,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../runtime-types";

export class BunProvider implements RuntimeProvider {
  public readonly id = "bun";
  public readonly name = "Bun Runtime Provider";
  public readonly supportedVersions = ["1.4.2"];

  private distributions: Record<string, RuntimeDistribution> = {
    "1.4.2:win32:x64": {
      runtime: "bun",
      version: "1.4.2",
      platform: "win32",
      architecture: "x64",
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64.zip",
      expectedSha256: "ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405",
      status: "verified",
      sizeBytes: 39807510,
      archiveType: "zip",
      binDirs: ["bun-windows-x64"],
      executables: [
        { name: "bun", relativePath: "bun-windows-x64/bun.exe", type: "runtime" },
        { name: "bunx", relativePath: "bun-windows-x64/bun.exe", type: "cli" },
      ],
      notes: "Bun v1.4.2 Oficial para Windows (x64) via oven-sh/bun GitHub Releases.",
    },
  };

  public getSupportedVersions(): RuntimeVersionSpec[] {
    return [
      { version: "1.4.2", isLts: false, isStable: true, notes: "Bun 1.4.2 Windows x64 (Latest Release)" },
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

// src/main/runtime/providers/deno-provider.ts
// Especificação formal e metadados do provedor oficial de runtime Deno para Windows.

import {
  RuntimeArchitecture,
  RuntimeDistribution,
  RuntimePlatform,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../runtime-types";

export class DenoProvider implements RuntimeProvider {
  public readonly id = "deno";
  public readonly name = "Deno Runtime Provider";
  public readonly supportedVersions = ["2.9.7"];

  private distributions: Record<string, RuntimeDistribution> = {
    "2.9.7:win32:x64": {
      runtime: "deno",
      version: "2.9.7",
      platform: "win32",
      architecture: "x64",
      url: "https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip",
      expectedSha256: "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238",
      status: "verified",
      sizeBytes: 42630221,
      archiveType: "zip",
      binDirs: ["."],
      executables: [
        { name: "deno", relativePath: "deno.exe", type: "runtime" },
      ],
      notes: "Deno v2.9.7 Oficial para Windows (x86_64-pc-windows-msvc) via denoland/deno GitHub Releases.",
    },
  };

  public getSupportedVersions(): RuntimeVersionSpec[] {
    return [
      { version: "2.9.7", isLts: false, isStable: true, notes: "Deno 2.9.7 Windows x64 (Latest Release)" },
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

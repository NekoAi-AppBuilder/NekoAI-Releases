// src/main/runtime/providers/python-provider.ts
// Especificação formal e metadados do provedor oficial de runtime Python para Windows.

import {
  RuntimeArchitecture,
  RuntimeDistribution,
  RuntimePlatform,
  RuntimeProvider,
  RuntimeVersionSpec,
} from "../runtime-types";

export class PythonProvider implements RuntimeProvider {
  public readonly id = "python";
  public readonly name = "Python Runtime Provider";
  public readonly supportedVersions = ["3.12.8", "3.13.1"];

  private distributions: Record<string, RuntimeDistribution> = {
    "3.12.8:win32:x64": {
      runtime: "python",
      version: "3.12.8",
      platform: "win32",
      architecture: "x64",
      url: "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip",
      expectedSha256: "8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb",
      status: "verified",
      sizeBytes: 11094114,
      archiveType: "zip",
      binDirs: ["."],
      executables: [
        { name: "python", relativePath: "python.exe", type: "runtime" },
        { name: "pythonw", relativePath: "pythonw.exe", type: "helper" },
      ],
      environmentVariables: {
        PYTHONUNBUFFERED: "1",
      },
      notes: "Python 3.12.8 Embeddable Package oficial (x64). Resolução via ._pth sem necessidade de PYTHONHOME global.",
    },
    "3.13.1:win32:x64": {
      runtime: "python",
      version: "3.13.1",
      platform: "win32",
      architecture: "x64",
      url: "https://www.python.org/ftp/python/3.13.1/python-3.13.1-embed-amd64.zip",
      expectedSha256: "7b7923ff0183a8b8fca90f6047184b419b108cb437f75fc1c002f9d2f8bcec16",
      status: "verified",
      sizeBytes: 10847803,
      archiveType: "zip",
      binDirs: ["."],
      executables: [
        { name: "python", relativePath: "python.exe", type: "runtime" },
        { name: "pythonw", relativePath: "pythonw.exe", type: "helper" },
      ],
      environmentVariables: {
        PYTHONUNBUFFERED: "1",
      },
      notes: "Python 3.13.1 Embeddable Package oficial (x64). Resolução via ._pth sem necessidade de PYTHONHOME global.",
    },
  };

  public getSupportedVersions(): RuntimeVersionSpec[] {
    return [
      { version: "3.12.8", isLts: false, isStable: true, notes: "Python 3.12.8 (Embeddable Package - Alta compatibilidade de C-extensions/wheels)" },
      { version: "3.13.1", isLts: false, isStable: true, notes: "Python 3.13.1 (Embeddable Package)" },
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

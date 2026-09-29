// src/main/runtime/runtime-detector.ts
// Detecção estática de tecnologias e necessidades de runtime em projetos do NekoAI.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { TechnologyDetectionResult } from "./runtime-types";

export class RuntimeDetector {
  /**
   * Analisa a pasta de um projeto e retorna todas as tecnologias detectadas com seu nível de confiança e evidências.
   */
  public async detectProjectTechnologies(projectPath: string): Promise<TechnologyDetectionResult[]> {
    if (!projectPath || !fsSync.existsSync(projectPath)) {
      return [];
    }

    try {
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }

    const results: TechnologyDetectionResult[] = [];

    let entries: string[] = [];
    try {
      const items = await fs.readdir(projectPath, { withFileTypes: true });
      entries = items.map((i) => i.name);
    } catch {
      return [];
    }

    const entrySet = new Set(entries.map((e) => e.toLowerCase()));

    // 1. Node.js
    if (entrySet.has("package.json")) {
      results.push({
        technology: "Node.js",
        confidence: "high",
        evidence: "package.json",
        possibleRuntime: "node",
      });
    }

    // 2. Bun
    if (entrySet.has("bun.lockb") || entrySet.has("bun.lock")) {
      const lockFile = entrySet.has("bun.lockb") ? "bun.lockb" : "bun.lock";
      results.push({
        technology: "Bun",
        confidence: "high",
        evidence: lockFile,
        possibleRuntime: "bun",
      });
    }

    // 3. Deno
    if (entrySet.has("deno.json") || entrySet.has("deno.jsonc")) {
      const configFile = entrySet.has("deno.json") ? "deno.json" : "deno.jsonc";
      results.push({
        technology: "Deno",
        confidence: "high",
        evidence: configFile,
        possibleRuntime: "deno",
      });
    }

    // 4. Python
    if (entrySet.has("requirements.txt")) {
      results.push({
        technology: "Python",
        confidence: "high",
        evidence: "requirements.txt",
        possibleRuntime: "python",
      });
    } else if (entrySet.has("pyproject.toml")) {
      results.push({
        technology: "Python",
        confidence: "high",
        evidence: "pyproject.toml",
        possibleRuntime: "python",
      });
    } else if (entrySet.has("pipfile")) {
      results.push({
        technology: "Python",
        confidence: "high",
        evidence: "Pipfile",
        possibleRuntime: "python",
      });
    } else {
      const hasPyFile = entries.some((e) => e.toLowerCase().endsWith(".py"));
      if (hasPyFile) {
        results.push({
          technology: "Python",
          confidence: "medium",
          evidence: "script.py",
          possibleRuntime: "python",
        });
      }
    }

    // 5. PHP
    if (entrySet.has("composer.json")) {
      results.push({
        technology: "PHP",
        confidence: "high",
        evidence: "composer.json",
        possibleRuntime: "php",
      });
    } else if (entrySet.has("artisan")) {
      results.push({
        technology: "PHP",
        confidence: "high",
        evidence: "artisan",
        possibleRuntime: "php",
      });
    } else {
      const hasPhpFile = entries.some((e) => e.toLowerCase().endsWith(".php"));
      if (hasPhpFile) {
        results.push({
          technology: "PHP",
          confidence: "medium",
          evidence: "script.php",
          possibleRuntime: "php",
        });
      }
    }

    return results;
  }
}

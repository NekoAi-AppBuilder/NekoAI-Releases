import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface NodeRuntimeDescriptor {
  nodePath: string;
  npmPath: string;
  npxPath: string;
  binDir: string;
  isBundled: boolean;
}

export interface GitRuntimeDescriptor {
  gitPath: string;
  binDirs: string[];
  isBundled: boolean;
}

let cachedNodeRuntime: NodeRuntimeDescriptor | null = null;
let cachedGitRuntime: GitRuntimeDescriptor | null = null;

export function clearNodeRuntimeCache(): void {
  cachedNodeRuntime = null;
  cachedGitRuntime = null;
}

export function clearGitRuntimeCache(): void {
  cachedGitRuntime = null;
}

export function resolveExecutableFromPath(name: string): string | null {
  if (process.platform === "win32") {
    try {
      const res = spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => Boolean(l) && fs.existsSync(l));

        if (lines.length > 0) {
          const exeMatch = lines.find((l) => l.toLowerCase().endsWith(".exe"));
          if (exeMatch) return exeMatch;

          const cmdMatch = lines.find((l) => l.toLowerCase().endsWith(".cmd"));
          if (cmdMatch) return cmdMatch;

          const batMatch = lines.find((l) => l.toLowerCase().endsWith(".bat"));
          if (batMatch) return batMatch;

          for (const line of lines) {
            const potentialCmd = `${line}.cmd`;
            if (fs.existsSync(potentialCmd)) return potentialCmd;
            const potentialExe = `${line}.exe`;
            if (fs.existsSync(potentialExe)) return potentialExe;
          }

          return lines[0];
        }
      }
    } catch {}
  }

  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const ext of extensions) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, ext ? `${name}${ext}` : name);
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            return candidate;
          }
        } catch {}
      }
    }
  }
  return null;
}

export function resolveNodeRuntime(forceRefresh = false): NodeRuntimeDescriptor {
  if (cachedNodeRuntime && !forceRefresh) {
    return cachedNodeRuntime;
  }

  const isWin = process.platform === "win32";
  const nodeExe = isWin ? "node.exe" : "node";
  const npmCmd = isWin ? "npm.cmd" : "npm";
  const npxCmd = isWin ? "npx.cmd" : "npx";

  // 1. NEKO_NODE_PATH override for testing / custom setups
  if (process.env.NEKO_NODE_PATH && fs.existsSync(process.env.NEKO_NODE_PATH)) {
    const customBinDir = path.dirname(process.env.NEKO_NODE_PATH);
    const customNpm = path.join(customBinDir, npmCmd);
    const customNpx = path.join(customBinDir, npxCmd);
    cachedNodeRuntime = {
      nodePath: process.env.NEKO_NODE_PATH,
      npmPath: fs.existsSync(customNpm) ? customNpm : npmCmd,
      npxPath: fs.existsSync(customNpx) ? customNpx : npxCmd,
      binDir: customBinDir,
      isBundled: true,
    };
    console.log(`[Runtime] Node customizado (NEKO_NODE_PATH) encontrado: ${cachedNodeRuntime.nodePath}`);
    return cachedNodeRuntime;
  }

  const baseDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();

  const candidatePaths: string[] = [
    path.resolve(baseDir, "..", "..", "tools", "node"),
    path.resolve(baseDir, "..", "tools", "node"),
    path.resolve(process.cwd(), "tools", "node"),
  ];
  if (process.resourcesPath) {
    candidatePaths.push(path.join(process.resourcesPath, "tools", "node"));
  }

  for (const candidateDir of candidatePaths) {
    const candidateNode = path.join(candidateDir, nodeExe);
    if (fs.existsSync(candidateNode)) {
      const candidateNpm = path.join(candidateDir, npmCmd);
      const candidateNpx = path.join(candidateDir, npxCmd);

      const resolvedNpm = fs.existsSync(candidateNpm) ? candidateNpm : candidateNode;
      const resolvedNpx = fs.existsSync(candidateNpx) ? candidateNpx : candidateNode;

      cachedNodeRuntime = {
        nodePath: candidateNode,
        npmPath: resolvedNpm,
        npxPath: resolvedNpx,
        binDir: candidateDir,
        isBundled: true,
      };

      console.log(`[Runtime] Node embutido encontrado: ${cachedNodeRuntime.nodePath}`);
      console.log(`[Runtime] npm embutido encontrado: ${cachedNodeRuntime.npmPath}`);
      console.log(`[Runtime] npx embutido encontrado: ${cachedNodeRuntime.npxPath}`);
      return cachedNodeRuntime;
    }
  }

  // 3. System PATH fallback
  const systemNode = resolveExecutableFromPath("node");
  if (systemNode) {
    const sysBinDir = path.dirname(systemNode);
    const sysNpm = resolveExecutableFromPath("npm") || path.join(sysBinDir, npmCmd);
    const sysNpx = resolveExecutableFromPath("npx") || path.join(sysBinDir, npxCmd);

    cachedNodeRuntime = {
      nodePath: systemNode,
      npmPath: sysNpm,
      npxPath: sysNpx,
      binDir: sysBinDir,
      isBundled: false,
    };

    console.log(`[Runtime] Node do sistema encontrado: ${cachedNodeRuntime.nodePath}`);
    return cachedNodeRuntime;
  }

  // 4. Critical failure: Node runtime not found
  console.error("[Runtime] ERRO CRÍTICO: Runtime Node.js da NekoAI não encontrado.");
  throw new Error("Runtime Node.js da NekoAI não encontrado.");
}

export function resolveGitRuntime(forceRefresh = false): GitRuntimeDescriptor | null {
  if (cachedGitRuntime && !forceRefresh) {
    return cachedGitRuntime;
  }

  const isWin = process.platform === "win32";

  // 1. NEKO_GIT_PATH override for testing / custom setups
  if (process.env.NEKO_GIT_PATH && fs.existsSync(process.env.NEKO_GIT_PATH)) {
    const override = path.resolve(process.env.NEKO_GIT_PATH);
    const binDir = path.dirname(override);
    const rootDir = path.dirname(binDir);
    const mingwBin = path.join(rootDir, "mingw64", "bin");
    const usrBin = path.join(rootDir, "usr", "bin");
    const cmdDir = path.join(rootDir, "cmd");

    const binDirs: string[] = [];
    if (fs.existsSync(cmdDir)) binDirs.push(cmdDir);
    if (fs.existsSync(mingwBin)) binDirs.push(mingwBin);
    if (fs.existsSync(usrBin)) binDirs.push(usrBin);
    if (binDirs.length === 0 && fs.existsSync(binDir)) binDirs.push(binDir);

    cachedGitRuntime = {
      gitPath: override,
      binDirs,
      isBundled: true,
    };
    console.log(`[Runtime] Git customizado (NEKO_GIT_PATH) encontrado: ${cachedGitRuntime.gitPath}`);
    return cachedGitRuntime;
  }

  const candidateRelativePaths = isWin
    ? [
        path.join("tools", "git", "cmd", "git.exe"),
        path.join("tools", "git", "mingw64", "bin", "git.exe"),
        path.join("tools", "git", "git.exe"),
        path.join("tools", "git.exe")
      ]
    : [
        path.join("tools", "git", "bin", "git"),
        path.join("tools", "git", "git")
      ];

  const baseDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  const searchBases = [
    path.resolve(baseDir, "..", ".."),
    path.resolve(baseDir, ".."),
    process.cwd(),
  ];
  if (process.resourcesPath) {
    searchBases.push(process.resourcesPath);
  }

  for (const base of searchBases) {
    for (const rel of candidateRelativePaths) {
      const candidateGit = path.join(base, rel);
      if (fs.existsSync(candidateGit)) {
        const binDir = path.dirname(candidateGit);
        const rootDir = path.dirname(binDir);
        const mingwBin = path.join(rootDir, "mingw64", "bin");
        const usrBin = path.join(rootDir, "usr", "bin");
        const cmdDir = path.join(rootDir, "cmd");

        const binDirs: string[] = [];
        if (fs.existsSync(cmdDir)) binDirs.push(cmdDir);
        if (fs.existsSync(mingwBin)) binDirs.push(mingwBin);
        if (fs.existsSync(usrBin)) binDirs.push(usrBin);
        if (binDirs.length === 0) binDirs.push(binDir);

        cachedGitRuntime = {
          gitPath: candidateGit,
          binDirs,
          isBundled: true,
        };
        console.log(`[Runtime] Git embutido encontrado: ${cachedGitRuntime.gitPath}`);
        return cachedGitRuntime;
      }
    }
  }

  // 3. System PATH fallback
  const systemGit = resolveExecutableFromPath("git");
  if (systemGit) {
    const sysBinDir = path.dirname(systemGit);
    cachedGitRuntime = {
      gitPath: systemGit,
      binDirs: [sysBinDir],
      isBundled: false,
    };
    console.log(`[Runtime] Git do sistema encontrado: ${cachedGitRuntime.gitPath}`);
    return cachedGitRuntime;
  }

  return null;
}

export function getEmbeddedRuntimeEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  try {
    const binDirs: string[] = [];

    // 1. Node.js runtime
    try {
      const nodeRuntime = resolveNodeRuntime();
      if (nodeRuntime?.binDir && !binDirs.includes(nodeRuntime.binDir)) {
        binDirs.push(nodeRuntime.binDir);
      }
    } catch {}

    // 2. Git runtime
    try {
      const gitRuntime = resolveGitRuntime();
      if (gitRuntime?.binDirs) {
        for (const dir of gitRuntime.binDirs) {
          if (dir && !binDirs.includes(dir)) {
            binDirs.push(dir);
          }
        }
      }
    } catch {}

    if (binDirs.length > 0) {
      const currentPath = env.PATH || env.Path || "";
      const pathSegments = currentPath ? currentPath.split(path.delimiter).filter(Boolean) : [];

      const missing = binDirs.filter(
        (cand) => !pathSegments.some((seg) => seg.toLowerCase() === cand.toLowerCase())
      );

      if (missing.length > 0) {
        const newPath = [...missing, ...pathSegments].join(path.delimiter);
        env.PATH = newPath;
        if (process.platform === "win32") {
          env.Path = newPath;
        }
      }
    }
  } catch (err) {
    console.warn("[Runtime] Não foi possível resolver ambiente de runtimes embutidos:", err);
  }
  return env;
}

export function spawnNodeTool(
  toolName: string,
  args: string[],
  options: SpawnOptions = {}
): ChildProcess {
  const runtime = resolveNodeRuntime();
  const env = getEmbeddedRuntimeEnv(options.env || process.env);
  const spawnOpts: SpawnOptions = { ...options, env, windowsHide: true };

  const nameLower = toolName.toLowerCase();
  if (nameLower === "node" || nameLower.endsWith("node.exe") || nameLower.endsWith("/node")) {
    return spawn(runtime.nodePath, args, { ...spawnOpts, shell: false });
  }

  const isNpm = nameLower === "npm" || nameLower.endsWith("npm.cmd") || nameLower.endsWith("/npm");
  const isNpx = nameLower === "npx" || nameLower.endsWith("npx.cmd") || nameLower.endsWith("/npx");

  if (isNpm || isNpx) {
    const cliFileName = isNpm ? "npm-cli.js" : "npx-cli.js";
    const cliPath = path.join(runtime.binDir, "node_modules", "npm", "bin", cliFileName);
    if (fs.existsSync(cliPath)) {
      console.log(`[PreviewRuntime] Direct Node invocation (bypassing cmd.exe): ${runtime.nodePath} ${cliPath} ${args.join(" ")}`);
      return spawn(runtime.nodePath, [cliPath, ...args], { ...spawnOpts, shell: false });
    }
  }

  if (process.platform === "win32") {
    return spawn(toolName, args, { ...spawnOpts, shell: true });
  }

  return spawn(toolName, args, { ...spawnOpts, shell: false });
}

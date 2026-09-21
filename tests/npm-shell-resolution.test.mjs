import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

function resolveGitBashPathPure(
  platform,
  env,
  existsFn,
  resolveGitFn
) {
  if (platform !== "win32") return null;

  if (env.OPENCODE_GIT_BASH_PATH) {
    const override = path.resolve(env.OPENCODE_GIT_BASH_PATH);
    if (existsFn(override)) return override;
  }

  const gitPath = resolveGitFn();
  if (gitPath) {
    const gitDir = path.dirname(gitPath);
    const candidate1 = path.resolve(gitDir, "..", "bin", "bash.exe");
    if (existsFn(candidate1)) return candidate1;
    const candidate2 = path.resolve(gitDir, "..", "usr", "bin", "bash.exe");
    if (existsFn(candidate2)) return candidate2;
  }

  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LocalAppData || (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local") : "");

  const commonLocations = [
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    path.join(programFilesX86, "Git", "bin", "bash.exe"),
    path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
    ...(localAppData ? [
      path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
      path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe")
    ] : [])
  ];

  for (const candidate of commonLocations) {
    if (existsFn(candidate)) return candidate;
  }

  return null;
}

function configureOpenCodeShellEnvPure(
  platform,
  baseEnv,
  gitBashPath
) {
  const env = { ...baseEnv };
  if (platform !== "win32") return env;

  if (gitBashPath) {
    env.SHELL = gitBashPath;
    env.OPENCODE_GIT_BASH_PATH = gitBashPath;
  } else {
    const comSpec = baseEnv.ComSpec || "C:\\Windows\\system32\\cmd.exe";
    env.ComSpec = comSpec;
    env.COMSPEC = comSpec;
    env.SHELL = comSpec;
  }

  return env;
}

function packageManagerExecutablePure(packageManager, platform) {
  if (packageManager === "pnpm") return platform === "win32" ? "pnpm.cmd" : "pnpm";
  if (packageManager === "yarn") return platform === "win32" ? "yarn.cmd" : "yarn";
  if (packageManager === "bun") return platform === "win32" ? "bun.exe" : "bun";
  return platform === "win32" ? "npm.cmd" : "npm";
}

test("1. Windows + Git Bash disponível: deve selecionar Git Bash", () => {
  const mockEnv = {
    ProgramFiles: "C:\\Program Files",
    ComSpec: "C:\\Windows\\system32\\cmd.exe"
  };
  const mockBash = "C:\\Program Files\\Git\\bin\\bash.exe";

  const resolved = resolveGitBashPathPure(
    "win32",
    mockEnv,
    (p) => p === mockBash,
    () => "C:\\Program Files\\Git\\cmd\\git.exe"
  );

  assert.equal(resolved, mockBash);

  const env = configureOpenCodeShellEnvPure("win32", mockEnv, resolved);
  assert.equal(env.SHELL, mockBash);
  assert.equal(env.OPENCODE_GIT_BASH_PATH, mockBash);
  assert.notEqual(env.SHELL?.toLowerCase().endsWith(".ps1"), true);
});

test("2. Windows + Git Bash indisponível: deve usar fallback seguro para cmd.exe", () => {
  const mockEnv = {
    ComSpec: "C:\\Windows\\system32\\cmd.exe"
  };

  const resolved = resolveGitBashPathPure(
    "win32",
    mockEnv,
    () => false,
    () => null
  );

  assert.equal(resolved, null);

  const env = configureOpenCodeShellEnvPure("win32", mockEnv, resolved);
  assert.equal(env.SHELL, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(env.COMSPEC, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(env.OPENCODE_GIT_BASH_PATH, undefined);
  assert.notEqual(env.SHELL?.toLowerCase().endsWith(".ps1"), true);
});

test("3. packageManagerExecutable('npm'): deve retornar npm.cmd no Windows", () => {
  const exe = packageManagerExecutablePure("npm", "win32");
  assert.equal(exe, "npm.cmd");
});

test("4. nenhum resolvedor deve retornar npm.ps1", () => {
  const managers = ["npm", "pnpm", "yarn", "bun", ""];
  for (const pm of managers) {
    const exe = packageManagerExecutablePure(pm, "win32");
    assert.notEqual(exe, "npm.ps1");
    assert.equal(exe.endsWith(".ps1"), false);
  }
});

test("5. Não alterar o comportamento em sistemas não-Windows", () => {
  const linuxBash = resolveGitBashPathPure(
    "linux",
    {},
    () => true,
    () => "/usr/bin/git"
  );
  assert.equal(linuxBash, null);

  const linuxEnv = configureOpenCodeShellEnvPure("linux", { SHELL: "/bin/zsh" }, null);
  assert.equal(linuxEnv.SHELL, "/bin/zsh");
  assert.equal(linuxEnv.OPENCODE_GIT_BASH_PATH, undefined);

  assert.equal(packageManagerExecutablePure("npm", "linux"), "npm");
  assert.equal(packageManagerExecutablePure("pnpm", "linux"), "pnpm");
  assert.equal(packageManagerExecutablePure("yarn", "linux"), "yarn");
  assert.equal(packageManagerExecutablePure("bun", "linux"), "bun");

  assert.equal(packageManagerExecutablePure("npm", "darwin"), "npm");
});

test("6. Validação do ambiente real do sistema operacional", () => {
  if (process.platform === "win32") {
    const exe = packageManagerExecutablePure("npm", process.platform);
    assert.equal(exe, "npm.cmd");
    assert.notEqual(exe, "npm.ps1");

    const gitCmd = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (fs.existsSync(gitCmd)) {
      const realResolved = resolveGitBashPathPure(
        "win32",
        process.env,
        (p) => fs.existsSync(p),
        () => "C:\\Program Files\\Git\\cmd\\git.exe"
      );
      assert.equal(realResolved, gitCmd);
    }
  }
});

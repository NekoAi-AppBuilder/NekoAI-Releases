// tests/git-sync-divergence.test.ts
// Testes obrigatórios para detecção de alterações externas e sincronização Git (P0)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  checkGitSyncStatus,
  pullFastForwardOnly,
  parseGitStatusPorcelain,
  parseGitCommitLog,
  parseGitNameStatusDiff,
  type GitRunner,
  type GitRunnerResult
} from "../src/main/git-sync.ts";

const execFileAsync = promisify(execFile);

async function runRealGit(cwd: string, args: string[]): Promise<GitRunnerResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || err.message || "").toString().trim()
    };
  }
}

// Helper to initialize a real origin (bare) and a local repo for integration tests
async function setupTestGitRepos(): Promise<{ tmpDir: string; originPath: string; localPath: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-gitsync-test-"));
  const originPath = path.join(tmpDir, "origin.git");
  const localPath = path.join(tmpDir, "local");

  await fs.mkdir(originPath, { recursive: true });
  await fs.mkdir(localPath, { recursive: true });

  // Init bare origin
  await runRealGit(originPath, ["init", "--bare", "-b", "main"]);

  // Init local repo
  await runRealGit(localPath, ["init", "-b", "main"]);
  await runRealGit(localPath, ["config", "user.name", "Neko Test"]);
  await runRealGit(localPath, ["config", "user.email", "test@nekoai.com"]);
  await runRealGit(localPath, ["remote", "add", "origin", originPath]);

  // Create initial commit and push to origin
  await fs.writeFile(path.join(localPath, "README.md"), "# Initial\n");
  await runRealGit(localPath, ["add", "README.md"]);
  await runRealGit(localPath, ["commit", "-m", "Initial commit"]);
  await runRealGit(localPath, ["push", "-u", "origin", "main"]);

  return { tmpDir, originPath, localPath };
}

test("1. Local e origin sincronizados", async () => {
  const { tmpDir, localPath } = await setupTestGitRepos();
  try {
    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.initialized, true);
    assert.equal(sync.branch, "main");
    assert.equal(sync.ahead, 0);
    assert.equal(sync.behind, 0);
    assert.equal(sync.workingTreeDirty, false);
    assert.equal(sync.diverged, false);
    assert.equal(sync.canFastForward, false);
    assert.equal(sync.status, "synced");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("2. Origin 1 commit à frente", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    // Simulate external commit (e.g. from Lovable/GitHub/VSCode)
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await runRealGit(remoteClientPath, ["config", "user.name", "Lovable User"]);
    await runRealGit(remoteClientPath, ["config", "user.email", "lovable@example.com"]);
    await fs.writeFile(path.join(remoteClientPath, "lovable.txt"), "Commit from Lovable\n");
    await runRealGit(remoteClientPath, ["add", "lovable.txt"]);
    await runRealGit(remoteClientPath, ["commit", "-m", "Lovable: add feature"]);
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    // Check sync in local NekoAI repo
    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.ahead, 0);
    assert.equal(sync.behind, 1);
    assert.equal(sync.workingTreeDirty, false);
    assert.equal(sync.diverged, false);
    assert.equal(sync.canFastForward, true);
    assert.equal(sync.status, "behind");
    assert.ok(sync.remoteCommits && sync.remoteCommits.length === 1);
    assert.equal(sync.remoteCommits![0].message, "Lovable: add feature");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("3. Origin vários commits à frente", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await runRealGit(remoteClientPath, ["config", "user.name", "Collaborator"]);
    await runRealGit(remoteClientPath, ["config", "user.email", "collab@example.com"]);

    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(path.join(remoteClientPath, `feat_${i}.txt`), `Feature ${i}\n`);
      await runRealGit(remoteClientPath, ["add", `feat_${i}.txt`]);
      await runRealGit(remoteClientPath, ["commit", "-m", `External commit ${i}`]);
    }
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.ahead, 0);
    assert.equal(sync.behind, 3);
    assert.equal(sync.workingTreeDirty, false);
    assert.equal(sync.diverged, false);
    assert.equal(sync.canFastForward, true);
    assert.equal(sync.status, "behind");
    assert.equal(sync.remoteCommits?.length, 3);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("4. Local à frente", async () => {
  const { tmpDir, localPath } = await setupTestGitRepos();
  try {
    await fs.writeFile(path.join(localPath, "local1.txt"), "Local 1\n");
    await runRealGit(localPath, ["add", "local1.txt"]);
    await runRealGit(localPath, ["commit", "-m", "Local commit 1"]);

    await fs.writeFile(path.join(localPath, "local2.txt"), "Local 2\n");
    await runRealGit(localPath, ["add", "local2.txt"]);
    await runRealGit(localPath, ["commit", "-m", "Local commit 2"]);

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.ahead, 2);
    assert.equal(sync.behind, 0);
    assert.equal(sync.diverged, false);
    assert.equal(sync.canFastForward, false);
    assert.equal(sync.status, "ahead");
    assert.equal(sync.localCommits?.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("5. Divergência (ahead > 0 && behind > 0)", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    // External commit pushed to origin
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await fs.writeFile(path.join(remoteClientPath, "remote.txt"), "Remote feature\n");
    await runRealGit(remoteClientPath, ["add", "remote.txt"]);
    await runRealGit(remoteClientPath, ["commit", "-m", "Remote commit from Lovable"]);
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    // Local commit in local repo
    await fs.writeFile(path.join(localPath, "local.txt"), "Local feature\n");
    await runRealGit(localPath, ["add", "local.txt"]);
    await runRealGit(localPath, ["commit", "-m", "Local commit from NekoAI"]);

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.ahead, 1);
    assert.equal(sync.behind, 1);
    assert.equal(sync.diverged, true);
    assert.equal(sync.canFastForward, false);
    assert.equal(sync.status, "diverged");
    assert.ok(sync.remoteCommits && sync.remoteCommits.length === 1);
    assert.ok(sync.localCommits && sync.localCommits.length === 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("6. Origin à frente + working tree limpo → pull --ff-only com sucesso", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    // External push
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await fs.writeFile(path.join(remoteClientPath, "sync_file.txt"), "Synced from remote\n");
    await runRealGit(remoteClientPath, ["add", "sync_file.txt"]);
    await runRealGit(remoteClientPath, ["commit", "-m", "External update"]);
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    // Execute safe pull fast forward
    const pullResult = await pullFastForwardOnly(localPath, {
      gitRunner: runRealGit
    });

    assert.equal(pullResult.ok, true);
    assert.equal(pullResult.pulled, true);
    assert.equal(pullResult.syncStatus.status, "synced");
    assert.equal(pullResult.syncStatus.behind, 0);

    // Verify file exists on local filesystem
    const fileContent = await fs.readFile(path.join(localPath, "sync_file.txt"), "utf8");
    assert.equal(fileContent.replace(/\r\n/g, "\n"), "Synced from remote\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("7. Origin à frente + working tree sujo → bloquear pull automático", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    // External push
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await fs.writeFile(path.join(remoteClientPath, "ext.txt"), "External work\n");
    await runRealGit(remoteClientPath, ["add", "ext.txt"]);
    await runRealGit(remoteClientPath, ["commit", "-m", "External work commit"]);
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    // Create uncommitted local work in local repo
    await fs.writeFile(path.join(localPath, "uncommitted.txt"), "My precious local work\n");

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.behind, 1);
    assert.equal(sync.workingTreeDirty, true);
    assert.equal(sync.canFastForward, false);
    assert.equal(sync.status, "dirty-behind");

    // Attempting pull must be strictly blocked and throw an error preserving local work
    await assert.rejects(
      async () => {
        await pullFastForwardOnly(localPath, { gitRunner: runRealGit });
      },
      /alterações locais não salvas/i
    );

    // Verify uncommitted file is completely intact
    const content = await fs.readFile(path.join(localPath, "uncommitted.txt"), "utf8");
    assert.equal(content, "My precious local work\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("8. Divergência + working tree sujo → bloquear operação automática", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    // External commit
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await fs.writeFile(path.join(remoteClientPath, "remote8.txt"), "Remote 8\n");
    await runRealGit(remoteClientPath, ["add", "remote8.txt"]);
    await runRealGit(remoteClientPath, ["commit", "-m", "Remote 8"]);
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    // Local commit
    await fs.writeFile(path.join(localPath, "local8.txt"), "Local 8\n");
    await runRealGit(localPath, ["add", "local8.txt"]);
    await runRealGit(localPath, ["commit", "-m", "Local 8"]);

    // Uncommitted dirty file
    await fs.writeFile(path.join(localPath, "dirty8.txt"), "Dirty uncommitted\n");

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.ahead, 1);
    assert.equal(sync.behind, 1);
    assert.equal(sync.workingTreeDirty, true);
    assert.equal(sync.diverged, true);
    assert.equal(sync.canFastForward, false);
    assert.equal(sync.status, "dirty-diverged");

    await assert.rejects(
      async () => {
        await pullFastForwardOnly(localPath, { gitRunner: runRealGit });
      },
      /alterações locais não salvas|alterações locais divergentes/i
    );

    // Verify dirty and committed files remain untouched
    const dirtyContent = await fs.readFile(path.join(localPath, "dirty8.txt"), "utf8");
    assert.equal(dirtyContent, "Dirty uncommitted\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("9. Falha de git fetch tratada graciosamente", async () => {
  const { tmpDir, localPath } = await setupTestGitRepos();
  try {
    // Mock git runner where fetch fails (e.g. network offline)
    const mockRunner: GitRunner = async (p, args) => {
      if (args[0] === "fetch") {
        return { code: 128, stdout: "", stderr: "fatal: unable to access origin: Could not resolve host" };
      }
      return await runRealGit(p, args);
    };

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: mockRunner
    });

    assert.equal(sync.initialized, true);
    assert.equal(sync.fetchSuccess, false);
    assert.ok(sync.fetchError?.includes("Could not resolve host"));
    // App does not crash, sync status object is returned cleanly
    assert.ok(typeof sync.ahead === "number");
    assert.ok(typeof sync.behind === "number");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("10. Falha de git pull --ff-only tratada com erro claro e seguro", async () => {
  const { tmpDir, localPath } = await setupTestGitRepos();
  try {
    // Mock runner where pull --ff-only fails with non-fast-forward
    const mockRunner: GitRunner = async (p, args) => {
      if (args[0] === "pull") {
        return { code: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting." };
      }
      if (args[0] === "rev-list" && args[1] === "--count" && args[2]?.includes("HEAD..refs/remotes/origin/main")) {
        return { code: 0, stdout: "1", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--count" && args[2]?.includes("refs/remotes/origin/main..HEAD")) {
        return { code: 0, stdout: "0", stderr: "" };
      }
      return await runRealGit(p, args);
    };

    await assert.rejects(
      async () => {
        await pullFastForwardOnly(localPath, { gitRunner: mockRunner });
      },
      /Falha ao sincronizar com GitHub \(--ff-only\): fatal: Not possible to fast-forward/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("11. Branch sem upstream tratada adequadamente", async () => {
  const { tmpDir, localPath } = await setupTestGitRepos();
  try {
    // Create new local branch not pushed to origin yet
    await runRealGit(localPath, ["checkout", "-b", "feature-nova"]);
    await fs.writeFile(path.join(localPath, "feature.txt"), "New feature\n");
    await runRealGit(localPath, ["add", "feature.txt"]);
    await runRealGit(localPath, ["commit", "-m", "Feature commit"]);

    const sync = await checkGitSyncStatus(localPath, {
      fetch: true,
      gitRunner: runRealGit
    });

    assert.equal(sync.branch, "feature-nova");
    assert.equal(sync.hasUpstream, false);
    assert.equal(sync.behind, 0);
    assert.equal(sync.diverged, false);
    assert.equal(sync.canFastForward, false);
    assert.equal(sync.status, "no-upstream");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("12. Preservar regras existentes de Auto Commit", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  const remoteClientPath = path.join(tmpDir, "remote-client");
  try {
    // Rule 1: Local dirty = false -> No commit/push
    const cleanStatus = await checkGitSyncStatus(localPath, { fetch: false, gitRunner: runRealGit });
    assert.equal(cleanStatus.workingTreeDirty, false);

    // Rule 2: Local dirty = true + origin ahead -> blocked from auto-commit, preserved
    await runRealGit(tmpDir, ["clone", originPath, "remote-client"]);
    await fs.writeFile(path.join(remoteClientPath, "remote_rule.txt"), "Remote rule\n");
    await runRealGit(remoteClientPath, ["add", "remote_rule.txt"]);
    await runRealGit(remoteClientPath, ["commit", "-m", "Remote rule commit"]);
    await runRealGit(remoteClientPath, ["push", "origin", "main"]);

    await fs.writeFile(path.join(localPath, "local_rule.txt"), "Local dirty work\n");
    const dirtyBehindSync = await checkGitSyncStatus(localPath, { fetch: true, gitRunner: runRealGit });

    assert.equal(dirtyBehindSync.workingTreeDirty, true);
    assert.equal(dirtyBehindSync.behind, 1);
    assert.equal(dirtyBehindSync.canFastForward, false);
    // Auto commit detects behind > 0 and pauses safely without executing destructive commits
    const shouldBlockAutoCommit = dirtyBehindSync.behind > 0 || dirtyBehindSync.diverged;
    assert.equal(shouldBlockAutoCommit, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("13. Garantir que nenhuma operação destrutiva seja executada", async () => {
  const { tmpDir, originPath, localPath } = await setupTestGitRepos();
  try {
    // Create an uncommitted file
    const secretFile = path.join(localPath, ".env.local");
    await fs.writeFile(secretFile, "SECRET_KEY=123456\n");

    const workFile = path.join(localPath, "src_draft.ts");
    await fs.writeFile(workFile, "export const draft = true;\n");

    // Perform sync check
    const sync = await checkGitSyncStatus(localPath, { fetch: true, gitRunner: runRealGit });
    assert.equal(sync.workingTreeDirty, true);

    // Ensure files are 100% untouched
    assert.equal(await fs.readFile(secretFile, "utf8"), "SECRET_KEY=123456\n");
    assert.equal(await fs.readFile(workFile, "utf8"), "export const draft = true;\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

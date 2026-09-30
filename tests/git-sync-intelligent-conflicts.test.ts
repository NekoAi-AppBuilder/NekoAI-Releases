import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  trySmartCombine,
  parseConflictMarkers,
  checkGitSyncStatus,
  syncAndCombineProject,
  resolveConflictFile,
  finalizeConflictResolution,
  getConflictFiles,
  type GitConflictFile
} from "../src/main/git-sync";

describe("Git Intelligent Sync & Conflict Resolver", () => {
  describe("3-Way Smart Combine Algorithm (trySmartCombine)", () => {
    test("combines non-overlapping additions from both sides cleanly", () => {
      const base = "line 1\nline 2\nline 3";
      const local = "line 1\nline 1.5 - local add\nline 2\nline 3";
      const github = "line 1\nline 2\nline 2.5 - github add\nline 3";

      const result = trySmartCombine(local, github, base);
      assert.equal(result.canCombineSafely, true);
      assert.ok(result.combinedContent.includes("line 1.5 - local add"));
      assert.ok(result.combinedContent.includes("line 2.5 - github add"));
    });

    test("detects overlapping conflicts on identical lines and flags canCombineSafely: false", () => {
      const base = "const title = 'Old Title';";
      const local = "const title = 'Local Title';";
      const github = "const title = 'GitHub Title';";

      const result = trySmartCombine(local, github, base);
      assert.equal(result.canCombineSafely, false);
      assert.ok(result.diffHunks.length > 0);
      assert.equal(result.diffHunks[0].localContent.trim(), "const title = 'Local Title';");
      assert.equal(result.diffHunks[0].githubContent.trim(), "const title = 'GitHub Title';");
    });

    test("handles identical changes on both sides without conflict", () => {
      const base = "item = 1";
      const local = "item = 2";
      const github = "item = 2";

      const result = trySmartCombine(local, github, base);
      assert.equal(result.canCombineSafely, true);
      assert.equal(result.combinedContent.trim(), "item = 2");
    });
  });

  describe("Conflict Marker Parser (parseConflictMarkers)", () => {
    test("correctly parses standard git conflict markers", () => {
      const rawContent = [
        "function hello() {",
        "<<<<<<< HEAD",
        "  console.log('from local');",
        "=======",
        "  console.log('from github');",
        ">>>>>>> origin/main",
        "}"
      ].join("\n");

      const parsed = parseConflictMarkers(rawContent);
      assert.equal(parsed.hasConflict, true);
      assert.equal(parsed.localOnly.includes("from local"), true);
      assert.equal(parsed.localOnly.includes("from github"), false);
      assert.equal(parsed.githubOnly.includes("from github"), true);
      assert.equal(parsed.githubOnly.includes("from local"), false);
      assert.equal(parsed.hunks.length, 1);
      assert.equal(parsed.hunks[0].localContent.trim(), "console.log('from local');");
      assert.equal(parsed.hunks[0].githubContent.trim(), "console.log('from github');");
    });
  });

  describe("End-to-End Git Repository Integration", () => {
    let tmpBaseDir: string;
    let remoteRepoDir: string;
    let localRepoDir: string;

    const setupTestRepos = () => {
      tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "neko-test-gitsync-"));
      remoteRepoDir = path.join(tmpBaseDir, "remote.git");
      localRepoDir = path.join(tmpBaseDir, "local");

      // 1. Create bare remote repository
      fs.mkdirSync(remoteRepoDir, { recursive: true });
      execSync("git init --bare", { cwd: remoteRepoDir });
      execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteRepoDir });

      // 2. Clone to temporary repo to push initial commit
      const seedDir = path.join(tmpBaseDir, "seed");
      fs.mkdirSync(seedDir, { recursive: true });
      execSync("git init -b main", { cwd: seedDir });
      execSync('git config user.name "Tester"', { cwd: seedDir });
      execSync('git config user.email "test@nekoai.com"', { cwd: seedDir });

      fs.writeFileSync(path.join(seedDir, "README.md"), "# Project\nInitial content\n");
      fs.writeFileSync(path.join(seedDir, "file1.txt"), "common line 1\ncommon line 2\n");
      execSync("git add .", { cwd: seedDir });
      execSync('git commit -m "Initial commit"', { cwd: seedDir });
      execSync(`git remote add origin "${remoteRepoDir}"`, { cwd: seedDir });
      execSync("git push -u origin main", { cwd: seedDir });

      // 3. Clone to localRepoDir
      execSync(`git clone -b main "${remoteRepoDir}" "${localRepoDir}"`);
      execSync('git config user.name "Local Tester"', { cwd: localRepoDir });
      execSync('git config user.email "local@nekoai.com"', { cwd: localRepoDir });
    };

    const cleanupTestRepos = () => {
      try {
        if (fs.existsSync(tmpBaseDir)) {
          fs.rmSync(tmpBaseDir, { recursive: true, force: true });
        }
      } catch {}
    };

    test("Non-conflicting scenario: Remote has commit in file A, local has changes in file B -> Auto-combines cleanly", async () => {
      setupTestRepos();
      try {
        // External developer / Lovable pushes a new commit to remote (file A)
        const seedDir = path.join(tmpBaseDir, "seed");
        fs.writeFileSync(path.join(seedDir, "remote_file.txt"), "Created by Lovable / External\n");
        execSync("git add .", { cwd: seedDir });
        execSync('git commit -m "Add remote_file from Lovable"', { cwd: seedDir });
        execSync("git push origin main", { cwd: seedDir });

        // Local user has uncommitted changes in file B
        fs.writeFileSync(path.join(localRepoDir, "local_file.txt"), "Local uncommitted work in NekoAI\n");

        // Run sync and combine
        const result = await syncAndCombineProject(localRepoDir);

        assert.equal(result.ok, true, "Sync combine should succeed");
        assert.equal(result.hasConflicts, false, "Should not have conflicts");
        assert.ok(fs.existsSync(path.join(localRepoDir, "remote_file.txt")), "Remote file should exist locally");
        assert.ok(fs.existsSync(path.join(localRepoDir, "local_file.txt")), "Local uncommitted file should be preserved");

        // Verify status is now synced
        const syncStatus = await checkGitSyncStatus(localRepoDir);
        assert.equal(syncStatus.behind, 0);
      } finally {
        cleanupTestRepos();
      }
    });

    test("Conflicting scenario: Remote modified file1.txt, Local also modified file1.txt -> Detects conflict and resolves visually", async () => {
      setupTestRepos();
      try {
        // External developer / Lovable modifies file1.txt
        const seedDir = path.join(tmpBaseDir, "seed");
        fs.writeFileSync(path.join(seedDir, "file1.txt"), "common line 1\nModified by GitHub / Lovable\n");
        execSync("git add .", { cwd: seedDir });
        execSync('git commit -m "Update file1 on GitHub"', { cwd: seedDir });
        execSync("git push origin main", { cwd: seedDir });

        // Local user modifies file1.txt differently
        fs.writeFileSync(path.join(localRepoDir, "file1.txt"), "common line 1\nModified locally by NekoAI User\n");

        // Run sync and combine
        const combineResult = await syncAndCombineProject(localRepoDir);

        assert.equal(combineResult.ok, true);
        assert.equal(combineResult.hasConflicts, true, "Should flag hasConflicts: true");
        assert.ok(combineResult.conflictFiles && combineResult.conflictFiles.length > 0);

        const conflictFile = combineResult.conflictFiles[0];
        assert.equal(conflictFile.path, "file1.txt");
        assert.ok(conflictFile.localContent.includes("Modified locally by NekoAI User"));
        assert.ok(conflictFile.githubContent.includes("Modified by GitHub / Lovable"));

        // Test resolving with "local"
        const resolveLocalResult = await resolveConflictFile({
          projectPath: localRepoDir,
          filePath: "file1.txt",
          resolution: "local"
        });
        assert.equal(resolveLocalResult.ok, true);

        // Test finalizing sync
        const finalizeResult = await finalizeConflictResolution({
          projectPath: localRepoDir,
          message: "Merge resolution: kept local version"
        });
        assert.equal(finalizeResult.ok, true);

        // Verify working tree has local version
        const finalContent = fs.readFileSync(path.join(localRepoDir, "file1.txt"), "utf8");
        assert.ok(finalContent.includes("Modified locally by NekoAI User"));
      } finally {
        cleanupTestRepos();
      }
    });

    test("Conflict resolution with 'github': Replaces conflicting file with GitHub version", async () => {
      setupTestRepos();
      try {
        // Remote modifies file1.txt
        const seedDir = path.join(tmpBaseDir, "seed");
        fs.writeFileSync(path.join(seedDir, "file1.txt"), "GITHUB WINNER CONTENT\n");
        execSync("git add .", { cwd: seedDir });
        execSync('git commit -m "Remote overhaul"', { cwd: seedDir });
        execSync("git push origin main", { cwd: seedDir });

        // Local user has changes
        fs.writeFileSync(path.join(localRepoDir, "file1.txt"), "LOCAL CONTENT TO BE OVERRIDDEN\n");

        // Sync and combine
        const combineResult = await syncAndCombineProject(localRepoDir);
        assert.equal(combineResult.hasConflicts, true);

        // Resolve choosing GitHub
        const resolveResult = await resolveConflictFile({
          projectPath: localRepoDir,
          filePath: "file1.txt",
          resolution: "github"
        });
        assert.equal(resolveResult.ok, true);

        // Finalize
        const finalizeResult = await finalizeConflictResolution({ projectPath: localRepoDir });
        assert.equal(finalizeResult.ok, true);

        const finalContent = fs.readFileSync(path.join(localRepoDir, "file1.txt"), "utf8");
        assert.equal(finalContent.trim(), "GITHUB WINNER CONTENT");
      } finally {
        cleanupTestRepos();
      }
    });

    test("Safety guarantee: Local files are never deleted or wiped on sync failure", async () => {
      setupTestRepos();
      try {
        fs.writeFileSync(path.join(localRepoDir, "critical_work.txt"), "DO NOT DELETE THIS\n");

        const statusBefore = await checkGitSyncStatus(localRepoDir);
        assert.equal(statusBefore.workingTreeDirty, true);

        // Sync when nothing new on remote
        const result = await syncAndCombineProject(localRepoDir);
        assert.equal(result.ok, true);
        assert.equal(result.hasConflicts, false);

        // Check file is still there and untouched
        assert.ok(fs.existsSync(path.join(localRepoDir, "critical_work.txt")));
        const content = fs.readFileSync(path.join(localRepoDir, "critical_work.txt"), "utf8");
        assert.equal(content.trim(), "DO NOT DELETE THIS");
      } finally {
        cleanupTestRepos();
      }
    });
  });
});

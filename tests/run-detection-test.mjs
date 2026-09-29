import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeGithubRepo } from "../dist/main/vercel/vercel-types.js";
import { VercelManager } from "../dist/main/vercel/vercel-manager.js";

describe("Vercel Remote GitHub Project Detection", () => {
  describe("normalizeGithubRepo", () => {
    test("normalizes standard HTTPS git URL with .git", () => {
      assert.equal(
        normalizeGithubRepo("https://github.com/AndreCarmo97/consultoria-ml.git"),
        "andrecarmo97/consultoria-ml"
      );
    });

    test("normalizes HTTPS git URL without .git", () => {
      assert.equal(
        normalizeGithubRepo("https://github.com/AndreCarmo97/consultoria-ml"),
        "andrecarmo97/consultoria-ml"
      );
    });

    test("normalizes SSH git URL", () => {
      assert.equal(
        normalizeGithubRepo("git@github.com:AndreCarmo97/consultoria-ml.git"),
        "andrecarmo97/consultoria-ml"
      );
    });

    test("normalizes ssh:// URL", () => {
      assert.equal(
        normalizeGithubRepo("ssh://git@github.com/AndreCarmo97/consultoria-ml.git"),
        "andrecarmo97/consultoria-ml"
      );
    });

    test("normalizes plain owner/repo string", () => {
      assert.equal(
        normalizeGithubRepo("AndreCarmo97/consultoria-ml"),
        "andrecarmo97/consultoria-ml"
      );
    });

    test("normalizes lowercase and ignores trailing slashes", () => {
      assert.equal(
        normalizeGithubRepo("https://github.com/AndreCarmo97/CONSULTORIA-ML/"),
        "andrecarmo97/consultoria-ml"
      );
    });

    test("returns null for invalid inputs", () => {
      assert.equal(normalizeGithubRepo(null), null);
      assert.equal(normalizeGithubRepo(undefined), null);
      assert.equal(normalizeGithubRepo(""), null);
      assert.equal(normalizeGithubRepo("   "), null);
      assert.equal(normalizeGithubRepo("invalid-repo-name"), null);
    });
  });

  describe("VercelManager project detection", () => {
    const createMockCli = (projectsJson, whoami = "testuser") => {
      return {
        resolveCli: async () => ({ command: "vercel.cmd", prefix: [] }),
        runCli: async (_cli, args) => {
          if (args[0] === "whoami") {
            return { stdout: whoami, stderr: "" };
          }
          if (args[0] === "project" && args[1] === "ls" && args[2] === "--json") {
            return { stdout: JSON.stringify(projectsJson), stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        listProjectsJson: async () => projectsJson,
        terminate: () => {},
        shutdown: () => {},
      };
    };

    const createMockVault = () => {
      return {
        loadVault: async () => {},
        getDeployment: async () => null,
        saveDeployment: async () => {},
        removeDeployment: async () => {},
      };
    };

    test("detects matching Vercel project by GitHub remote (DETECTADO ≠ VINCULADO)", async () => {
      const projects = [
        {
          id: "prj_123",
          name: "consultoria-mlb",
          link: {
            type: "github",
            org: "AndreCarmo97",
            repo: "consultoria-ml",
          },
          updatedAt: 1700000000000,
        },
        {
          id: "prj_456",
          name: "outro-projeto",
          link: {
            type: "github",
            org: "AndreCarmo97",
            repo: "outro-repo",
          },
          updatedAt: 1600000000000,
        },
      ];

      const mockCli = createMockCli(projects);
      const mockVault = createMockVault();
      const manager = new VercelManager(mockVault, mockCli);

      manager.setGitStatusGetter(async () => ({
        linkedRepo: "AndreCarmo97/consultoria-ml",
        remote: "https://github.com/AndreCarmo97/consultoria-ml.git",
      }));

      await manager.initialize();
      await manager.setProject("C:\\workspace\\consultoria-mlb");

      const state = manager.getState();
      assert.equal(state.connection, "connected");
      assert.equal(state.username, "testuser");
      // CRITICAL: linked must remain false because .vercel/project.json does not exist locally
      assert.equal(state.linked, false, "Local project must not be marked as linked");
      assert.ok(state.detectedProject, "A detected project must be present");
      assert.equal(state.detectedProject?.name, "consultoria-mlb");
      assert.equal(state.detectedProject?.gitRepo, "AndreCarmo97/consultoria-ml");
    });

    test("does not match by project name if GitHub repo is different", async () => {
      const projects = [
        {
          id: "prj_999",
          name: "consultoria-mlb", // Same name
          link: {
            type: "github",
            org: "DifferentOrg",
            repo: "different-repo", // Different repo!
          },
          updatedAt: 1700000000000,
        },
      ];

      const mockCli = createMockCli(projects);
      const mockVault = createMockVault();
      const manager = new VercelManager(mockVault, mockCli);

      manager.setGitStatusGetter(async () => ({
        linkedRepo: "AndreCarmo97/consultoria-ml",
        remote: "https://github.com/AndreCarmo97/consultoria-ml.git",
      }));

      await manager.initialize();
      await manager.setProject("C:\\workspace\\consultoria-mlb");

      const state = manager.getState();
      assert.equal(state.detectedProject, null, "Must not match when repository is different");
      assert.equal(state.linked, false);
    });

    test("selects the most recently updated project when multiple match the same repo", async () => {
      const projects = [
        {
          id: "prj_old",
          name: "consultoria-old",
          link: {
            type: "github",
            org: "AndreCarmo97",
            repo: "consultoria-ml",
          },
          updatedAt: 1000,
        },
        {
          id: "prj_newest",
          name: "consultoria-mlb",
          link: {
            type: "github",
            org: "AndreCarmo97",
            repo: "consultoria-ml",
          },
          updatedAt: 5000,
        },
      ];

      const mockCli = createMockCli(projects);
      const mockVault = createMockVault();
      const manager = new VercelManager(mockVault, mockCli);

      manager.setGitStatusGetter(async () => ({
        linkedRepo: "AndreCarmo97/consultoria-ml",
        remote: "https://github.com/AndreCarmo97/consultoria-ml.git",
      }));

      await manager.initialize();
      await manager.setProject("C:\\workspace\\consultoria-mlb");

      const state = manager.getState();
      assert.equal(state.detectedProject?.name, "consultoria-mlb");
      assert.equal(state.detectedProject?.id, "prj_newest");
    });

    test("discards detection results if workspace changes mid-flight", async () => {
      let resolveList;
      let onCalled;
      const calledPromise = new Promise((r) => {
        onCalled = r;
      });
      let callCount = 0;

      const delayedCli = {
        resolveCli: async () => ({ command: "vercel.cmd", prefix: [] }),
        runCli: async () => ({ stdout: "testuser", stderr: "" }),
        listProjectsJson: async () => {
          callCount++;
          if (callCount === 1) {
            onCalled?.();
            return new Promise((res) => {
              resolveList = res;
            });
          }
          return [
            {
              id: "prj_2",
              name: "project2-remote",
              link: { type: "github", org: "AndreCarmo97", repo: "project2" },
            },
          ];
        },
        terminate: () => {},
        shutdown: () => {},
      };

      const mockVault = createMockVault();
      const manager = new VercelManager(mockVault, delayedCli);

      let currentRepo = "AndreCarmo97/consultoria-ml";
      manager.setGitStatusGetter(async () => ({
        linkedRepo: currentRepo,
        remote: `https://github.com/${currentRepo}.git`,
      }));

      await manager.initialize();
      const p1 = manager.setProject("C:\\workspace\\project1");

      // Wait until listProjectsJson is actively called
      await calledPromise;

      // Switch to project 2 before listProjectsJson finishes
      currentRepo = "AndreCarmo97/project2";
      const p2 = manager.setProject("C:\\workspace\\project2");

      resolveList([
        {
          id: "prj_1",
          name: "project1-remote",
          link: { type: "github", org: "AndreCarmo97", repo: "consultoria-ml" },
        },
      ]);

      await p1;
      await p2;

      // The detection for project 1 must not pollute project 2 state
      const state = manager.getState();
      assert.equal(state.projectPath, "C:\\workspace\\project2");
      assert.notEqual(state.detectedProject?.name, "project1-remote");
    });

    test("disconnect resets detectedProject to null", async () => {
      const projects = [
        {
          id: "prj_123",
          name: "consultoria-mlb",
          link: { type: "github", org: "AndreCarmo97", repo: "consultoria-ml" },
        },
      ];
      const mockCli = createMockCli(projects);
      const mockVault = createMockVault();
      const manager = new VercelManager(mockVault, mockCli);

      manager.setGitStatusGetter(async () => ({
        linkedRepo: "AndreCarmo97/consultoria-ml",
        remote: "https://github.com/AndreCarmo97/consultoria-ml.git",
      }));

      await manager.initialize();
      await manager.setProject("C:\\workspace\\consultoria-mlb");
      assert.ok(manager.getState().detectedProject);

      await manager.disconnect();
      assert.equal(manager.getState().detectedProject, null);
      assert.equal(manager.getState().connection, "disconnected");
    });
  });
});

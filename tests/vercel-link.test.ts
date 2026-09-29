import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VercelLinkIntentManager } from "../src/main/vercel/vercel-intent";
import { VercelManager } from "../src/main/vercel/vercel-manager";

describe("Vercel Use Detected Project & Link Flow", () => {
  describe("VercelLinkIntentManager", () => {
    test("creates and consumes a valid link intent (one-shot)", () => {
      const manager = new VercelLinkIntentManager();
      const intent = manager.createIntent({
        projectPath: "C:\\workspace\\consultoria-mlb",
        projectId: "prj_123",
        projectName: "consultoria-mlb",
        gitRepo: "AndreCarmo97/consultoria-ml",
        projectGeneration: 1,
        username: "testuser",
        ttlMs: 60_000,
      });

      assert.ok(intent.intentId);
      assert.equal(intent.state, "created");

      // 1st consumption -> valid
      const validation1 = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\consultoria-mlb",
        1,
        "testuser"
      );
      assert.equal(validation1.valid, true);
      assert.equal(validation1.intent?.projectName, "consultoria-mlb");

      // 2nd consumption -> rejected (one-shot)
      const validation2 = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\consultoria-mlb",
        1,
        "testuser"
      );
      assert.equal(validation2.valid, false);
      assert.equal(validation2.reason, "intenção já consumida (one-shot)");
    });

    test("rejects link intent when generation mismatches", () => {
      const manager = new VercelLinkIntentManager();
      const intent = manager.createIntent({
        projectPath: "C:\\workspace\\consultoria-mlb",
        projectId: "prj_123",
        projectName: "consultoria-mlb",
        gitRepo: "AndreCarmo97/consultoria-ml",
        projectGeneration: 1,
        username: "testuser",
      });

      const validation = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\consultoria-mlb",
        2, // Generation changed!
        "testuser"
      );
      assert.equal(validation.valid, false);
      assert.equal(validation.reason, "geração do projeto mudou");
    });

    test("rejects link intent when project path mismatches", () => {
      const manager = new VercelLinkIntentManager();
      const intent = manager.createIntent({
        projectPath: "C:\\workspace\\consultoria-mlb",
        projectId: "prj_123",
        projectName: "consultoria-mlb",
        gitRepo: "AndreCarmo97/consultoria-ml",
        projectGeneration: 1,
        username: "testuser",
      });

      const validation = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\other-project", // Different path!
        1,
        "testuser"
      );
      assert.equal(validation.valid, false);
      assert.equal(validation.reason, "projeto não corresponde à intenção");
    });

    test("rejects link intent when username mismatches", () => {
      const manager = new VercelLinkIntentManager();
      const intent = manager.createIntent({
        projectPath: "C:\\workspace\\consultoria-mlb",
        projectId: "prj_123",
        projectName: "consultoria-mlb",
        gitRepo: "AndreCarmo97/consultoria-ml",
        projectGeneration: 1,
        username: "testuser",
      });

      const validation = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\consultoria-mlb",
        1,
        "anotheruser" // Different account!
      );
      assert.equal(validation.valid, false);
      assert.equal(validation.reason, "conta Vercel mudou");
    });

    test("rejects expired link intent", async () => {
      const manager = new VercelLinkIntentManager();
      const intent = manager.createIntent({
        projectPath: "C:\\workspace\\consultoria-mlb",
        projectId: "prj_123",
        projectName: "consultoria-mlb",
        gitRepo: "AndreCarmo97/consultoria-ml",
        projectGeneration: 1,
        username: "testuser",
        ttlMs: 5, // 5ms TTL
      });

      await new Promise((r) => setTimeout(r, 20));

      const validation = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\consultoria-mlb",
        1,
        "testuser"
      );
      assert.equal(validation.valid, false);
      assert.equal(validation.reason, "intenção expirada");
    });

    test("invalidates link intent on path or global context change", () => {
      const manager = new VercelLinkIntentManager();
      const intent = manager.createIntent({
        projectPath: "C:\\workspace\\consultoria-mlb",
        projectId: "prj_123",
        projectName: "consultoria-mlb",
        gitRepo: "AndreCarmo97/consultoria-ml",
        projectGeneration: 1,
        username: "testuser",
      });

      manager.invalidateByPath("C:\\workspace\\consultoria-mlb", "test invalidate");

      const validation = manager.validateAndConsume(
        intent.intentId,
        "C:\\workspace\\consultoria-mlb",
        1,
        "testuser"
      );
      assert.equal(validation.valid, false);
      assert.equal(validation.reason, "intenção invalidada");
    });
  });

  describe("VercelManager linkDetectedProject", () => {
    test("links workspace to detected project using vercel link (WITHOUT project add and WITHOUT deploy)", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neko-vercel-link-test-"));
      const executedCommands: Array<{ args: string[]; cwd?: string }> = [];

      try {
        const mockCli = {
          resolveCli: async () => ({ command: "vercel.cmd", prefix: [] }),
          runCli: async (_cli: any, args: string[], cwd?: string) => {
            executedCommands.push({ args, cwd });
            if (args[0] === "whoami") {
              return { stdout: "testuser", stderr: "" };
            }
            if (args[0] === "link") {
              // Simulate Vercel CLI creating .vercel/project.json
              const vercelDir = path.join(cwd || "", ".vercel");
              await fs.mkdir(vercelDir, { recursive: true });
              await fs.writeFile(
                path.join(vercelDir, "project.json"),
                JSON.stringify({ projectId: "prj_123", orgId: "team_abc" })
              );
              return { stdout: "Linked to consultoria-mlb", stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
          listProjectsJson: async () => [
            {
              id: "prj_123",
              name: "consultoria-mlb",
              link: { type: "github", org: "AndreCarmo97", repo: "consultoria-ml" },
            },
          ],
          terminate: () => {},
          shutdown: () => {},
        } as any;

        const savedDeployments: any[] = [];
        const mockVault = {
          loadVault: async () => ({ version: 1, deployments: {} }),
          getDeployment: async () => null,
          saveDeployment: async (projectPath: string, deploymentUrl: string, projectName?: string, username?: string) => {
            savedDeployments.push({ projectPath, deploymentUrl, projectName, username });
          },
          removeDeployment: async () => {},
        } as any;

        const manager = new VercelManager(mockVault, mockCli);
        manager.setGitStatusGetter(async () => ({
          linkedRepo: "AndreCarmo97/consultoria-ml",
          remote: "https://github.com/AndreCarmo97/consultoria-ml.git",
        }));

        await manager.initialize();
        await manager.setProject(tempDir);

        // Before linking: detectedProject is present, linked is false
        const initialState = manager.getState();
        assert.equal(initialState.linked, false, "Must start unlinked");
        assert.ok(initialState.detectedProject, "Detected project must be found");
        assert.equal(initialState.detectedProject?.name, "consultoria-mlb");

        // Execute linkDetectedProject
        const linkedState = await manager.linkDetectedProject(tempDir, "consultoria-mlb");

        // Assert state transitions
        assert.equal(linkedState.linked, true, "Must transition to linked: true");
        assert.equal(linkedState.projectName, "consultoria-mlb");
        assert.equal(linkedState.deployment, "idle", "Deployment must remain idle (NO deploy)");
        assert.equal(linkedState.deploymentUrl, null, "No deployment URL before actual deploy");

        // Verify commands executed
        const hasProjectAdd = executedCommands.some((c) => c.args[0] === "project" && c.args[1] === "add");
        assert.equal(hasProjectAdd, false, "Must NEVER execute 'project add' for an existing project");

        const hasLinkCmd = executedCommands.some(
          (c) => c.args[0] === "link" && c.args.includes("--project") && c.args.includes("consultoria-mlb")
        );
        assert.equal(hasLinkCmd, true, "Must execute 'vercel link --yes --project <projectName>'");

        const hasDeploy = executedCommands.some((c) => c.args[0] === "deploy");
        assert.equal(hasDeploy, false, "Must NEVER execute 'deploy' during linking");

        // Verify .vercel/project.json exists
        const projectJsonPath = path.join(tempDir, ".vercel", "project.json");
        const jsonExists = await fs.access(projectJsonPath).then(() => true).catch(() => false);
        assert.equal(jsonExists, true, ".vercel/project.json must be created");

        // Verify .gitignore has .vercel
        const gitignoreContent = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
        assert.ok(gitignoreContent.includes(".vercel"), ".gitignore must contain .vercel");

        // Verify vault persisted
        assert.equal(savedDeployments.length, 1);
        assert.equal(savedDeployments[0].projectName, "consultoria-mlb");
        assert.equal(savedDeployments[0].username, "testuser");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});

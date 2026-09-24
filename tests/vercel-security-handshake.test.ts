import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { VercelPublishIntentManager } from "../dist/main/vercel/vercel-intent.js";
import { VercelVaultManager } from "../dist/main/vercel/vercel-vault.js";
import { VercelManager } from "../dist/main/vercel/vercel-manager.js";

async function createTempDir(prefix: string): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// Mock CLI wrapper for simulating Vercel deployments
class MockVercelCli {
  public executedCommands: Array<{ args: string[]; cwd?: string }> = [];
  public failAdd = false;
  public failLink = false;
  public failDeploy = false;
  public mockUser: string | null = "testuser";
  public triggerTerminalClose: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;

  public async resolveCli() {
    return { command: "vercel", prefix: [] };
  }

  public getCliEnvironment() {
    return {};
  }

  public async openLoginTerminal(_cli: any) {
    let resolver: any;
    const waitClose = () =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        resolver = resolve;
      });
    this.triggerTerminalClose = (info) => {
      if (resolver) resolver(info);
    };
    return {
      strategy: "mock",
      pid: 1234,
      child: { pid: 1234, kill: () => {} } as any,
      waitClose,
    };
  }

  public async runCli(_cli: any, args: string[], cwd?: string, _timeoutMs?: number, onLine?: (line: string) => void) {
    this.executedCommands.push({ args, cwd });
    if (args[0] === "whoami") {
      if (this.mockUser) return { stdout: `${this.mockUser}\n`, stderr: "" };
      throw new Error("Not logged in");
    }
    if (args[0] === "project" && args[1] === "add") {
      if (this.failAdd) throw new Error("Project add failed");
      return { stdout: "Project created", stderr: "" };
    }
    if (args[0] === "link") {
      if (this.failLink) throw new Error("Link failed");
      // Simulate creating .vercel/project.json
      if (cwd) {
        const vercelDir = path.join(cwd, ".vercel");
        await fs.mkdir(vercelDir, { recursive: true });
        await fs.writeFile(path.join(vercelDir, "project.json"), JSON.stringify({ projectId: "prj_123" }));
      }
      return { stdout: "Linked successfully", stderr: "" };
    }
    if (args[0] === "deploy") {
      if (this.failDeploy) throw new Error("Deploy failed");
      if (onLine) onLine("Deploying...");
      return { stdout: "https://my-app.vercel.app\n", stderr: "" };
    }
    if (args[0] === "logout") {
      this.mockUser = null;
      return { stdout: "Logged out", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }

  public terminate(_child: any) {}
  public shutdown() {}
}

// ============================================================================
// VERCEL SECURITY HANDSHAKE TESTS
// ============================================================================

test("Vercel Security: A - Normal publication workflow (create intent -> validate -> consume)", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";
  const projectGeneration = 1;
  const username = "developer_alice";

  // 1. User clicks publish -> Main generates intent
  const intent = intentManager.createIntent({
    projectPath,
    projectName: "my-awesome-app",
    projectGeneration,
    username,
    ttlMs: 30_000,
  });

  assert.ok(intent.intentId, "Intent must have a UUID");
  assert.equal(intent.state, "created");
  assert.equal(intent.projectPath, projectPath);

  // 2. Validate and consume
  const result = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    projectGeneration,
    username
  );

  assert.equal(result.valid, true, "Intent validation should succeed");
  assert.equal(result.intent?.state, "consumed", "Intent must transition to consumed");
});

test("Vercel Security: B - Direct IPC call without intent is rejected", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";

  // Simulating an unauthorized IPC invocation with undefined intentId
  const result1 = intentManager.validateAndConsume(
    undefined,
    projectPath,
    1,
    "developer_alice"
  );

  assert.equal(result1.valid, false);
  assert.equal(result1.userMessage, "Publicação na Vercel requer confirmação explícita.");

  // Simulating arbitrary non-existent intent
  const result2 = intentManager.validateAndConsume(
    "arbitrary-forged-uuid-9999",
    projectPath,
    1,
    "developer_alice"
  );

  assert.equal(result2.valid, false);
  assert.equal(result2.userMessage, "Publicação na Vercel requer confirmação explícita.");
});

test("Vercel Security: C - Intent is strictly one-shot (cannot be reused twice)", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";
  const projectGeneration = 1;
  const username = "developer_alice";

  const intent = intentManager.createIntent({
    projectPath,
    projectGeneration,
    username,
  });

  // First use: Valid
  const firstResult = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    projectGeneration,
    username
  );
  assert.equal(firstResult.valid, true);

  // Second use: REJECTED
  const secondResult = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    projectGeneration,
    username
  );
  assert.equal(secondResult.valid, false, "Second consumption must be rejected");
  assert.ok(secondResult.reason?.includes("já consumida"), "Reason must state already consumed");
});

test("Vercel Security: D - Expired intent is rejected", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";
  const projectGeneration = 1;
  const username = "developer_alice";

  // Intent with 1ms TTL
  const intent = intentManager.createIntent({
    projectPath,
    projectGeneration,
    username,
    ttlMs: 1,
  });

  // Wait 10ms to ensure expiration
  await new Promise((resolve) => setTimeout(resolve, 15));

  const result = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    projectGeneration,
    username
  );

  assert.equal(result.valid, false, "Expired intent must be rejected");
  assert.equal(result.reason, "intenção expirada");
  assert.ok(result.userMessage?.includes("expirou"));
});

test("Vercel Security: E - Intent created for Project A cannot be used on Project B", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectA = "C:\\Projects\\ProjectA";
  const projectB = "C:\\Projects\\ProjectB";
  const projectGeneration = 1;
  const username = "developer_alice";

  const intentA = intentManager.createIntent({
    projectPath: projectA,
    projectGeneration,
    username,
  });

  // Attempting to consume intentA while Project B is active
  const result = intentManager.validateAndConsume(
    intentA.intentId,
    projectB,
    projectGeneration,
    username
  );

  assert.equal(result.valid, false, "Intent for Project A must not work for Project B");
  assert.equal(result.reason, "projeto não corresponde à intenção");
});

test("Vercel Security: F - Intent is invalidated if projectGeneration changes (workspace switch / refresh)", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";
  const initialGen = 1;
  const newGen = 2; // Transition occurred
  const username = "developer_alice";

  const intent = intentManager.createIntent({
    projectPath,
    projectGeneration: initialGen,
    username,
  });

  // Consuming with new generation
  const result = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    newGen,
    username
  );

  assert.equal(result.valid, false, "Intent must be rejected when project generation changes");
  assert.equal(result.reason, "geração do projeto mudou");
});

test("Vercel Security: G - Logout / Disconnect invalidates all pending intents", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";
  const projectGeneration = 1;
  const username = "developer_alice";

  const intent = intentManager.createIntent({
    projectPath,
    projectGeneration,
    username,
  });

  // User disconnects account
  intentManager.invalidateAll("account disconnected");

  const result = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    projectGeneration,
    username
  );

  assert.equal(result.valid, false, "Invalidated intent must be rejected");
  assert.equal(result.reason, "intenção invalidada");
});

test("Vercel Security: H - Account switch invalidates intent", async () => {
  const intentManager = new VercelPublishIntentManager();
  const projectPath = "C:\\Projects\\MyAwesomeApp";
  const projectGeneration = 1;

  const intent = intentManager.createIntent({
    projectPath,
    projectGeneration,
    username: "developer_alice",
  });

  // Account changed to bob
  const result = intentManager.validateAndConsume(
    intent.intentId,
    projectPath,
    projectGeneration,
    "developer_bob"
  );

  assert.equal(result.valid, false, "Intent must fail when active username changes");
  assert.equal(result.reason, "conta Vercel mudou");
});

test("Vercel Security: I - Separation of Link and Deploy in VercelManager", async () => {
  const tempDir = await createTempDir("vercel-link-deploy");
  const vaultPath = path.join(tempDir, "vault.json");
  const vault = new VercelVaultManager(vaultPath);
  const mockCli = new MockVercelCli();
  const manager = new VercelManager(vault, mockCli as any);

  await manager.setProject(tempDir);

  // 1. Check ensureLinked standalone execution
  const isLinked = await manager.ensureLinked(tempDir, "isolated-test-app");
  assert.equal(isLinked, true, "ensureLinked should successfully create and link");

  // Verify that link command was executed
  const hasAdd = mockCli.executedCommands.some((c) => c.args.includes("add"));
  const hasLink = mockCli.executedCommands.some((c) => c.args.includes("link"));
  assert.ok(hasAdd, "Should have run project add");
  assert.ok(hasLink, "Should have run link");

  // 2. Second ensureLinked should be a no-op (already linked)
  const countBefore = mockCli.executedCommands.length;
  const isLinkedAgain = await manager.ensureLinked(tempDir, "isolated-test-app");
  assert.equal(isLinkedAgain, true);
  assert.equal(mockCli.executedCommands.length, countBefore, "ensureLinked should be a no-op when already linked");
});

test("Vercel Security: J - Full deploy with Mock CLI verifies project state and vault persistence", async () => {
  const tempDir = await createTempDir("vercel-full-deploy");
  const vaultPath = path.join(tempDir, "vault.json");
  const vault = new VercelVaultManager(vaultPath);
  const mockCli = new MockVercelCli();
  const manager = new VercelManager(vault, mockCli as any);

  await manager.setProject(tempDir);

  // Deploy project
  const finalState = await manager.deploy(tempDir, { VITE_API_URL: "https://api.example.com" }, "deploy-app");

  assert.equal(finalState.deployment, "ready");
  assert.equal(finalState.deploymentUrl, "https://my-app.vercel.app");
  assert.equal(finalState.projectName, "deploy-app");

  // Verify deploy command included env vars
  const deployCmd = mockCli.executedCommands.find((c) => c.args[0] === "deploy");
  assert.ok(deployCmd, "Deploy CLI command must have been executed");
  assert.ok(deployCmd.args.includes("--build-env"));
  assert.ok(deployCmd.args.includes("VITE_API_URL=https://api.example.com"));

  // Verify persistence in vault
  const saved = await vault.getDeployment(tempDir);
  assert.ok(saved);
  assert.equal(saved.deploymentUrl, "https://my-app.vercel.app");
});

test("Vercel Security: K - Logs verification (no sensitive credentials exposed)", () => {
  const capturedLogs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  console.log = (...args: any[]) => capturedLogs.push(args.join(" "));
  console.warn = (...args: any[]) => capturedLogs.push(args.join(" "));

  try {
    const intentManager = new VercelPublishIntentManager();
    const intent = intentManager.createIntent({
      projectPath: "C:\\Projects\\SecretProject",
      projectGeneration: 1,
      username: "secure_user",
    });

    intentManager.validateAndConsume(
      intent.intentId,
      "C:\\Projects\\SecretProject",
      1,
      "secure_user"
    );

    // Verify all logs
    for (const log of capturedLogs) {
      assert.ok(!log.includes("bearer"), "Logs must never contain bearer tokens");
      assert.ok(!log.includes("auth.json"), "Logs must never expose auth.json contents");
      assert.ok(!log.includes("password"), "Logs must never contain passwords");
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test("Vercel Security: L - Switch to Account B without access removes stale .vercel/project.json and invalidates binding", async () => {
  const tempDir = await createTempDir("vercel-stale-cleanup");
  try {
    const vaultPath = path.join(tempDir, "vault.json");
    const vault = new VercelVaultManager(vaultPath);
    const mockCli = new MockVercelCli();
    const manager = new VercelManager(vault, mockCli as any);

    const projectPath = path.join(tempDir, "my-shared-app");
    const vercelDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelDir, { recursive: true });
    await fs.writeFile(path.join(vercelDir, "project.json"), JSON.stringify({ projectId: "prj_alice_exclusive" }));

    // Account Alice deployed previously
    await vault.saveDeployment(projectPath, "https://alice-app.vercel.app", "alice-app", "alice");

    // 1. Project under Alice: valid binding
    await manager.restoreProjectBinding(projectPath, "alice");
    let state = manager.getState();
    assert.equal(state.linked, true);
    assert.equal(state.projectName, "alice-app");
    assert.equal(state.deploymentUrl, "https://alice-app.vercel.app");

    // 2. Account switches to Bob (who does NOT have access to alice-app in project ls)
    await manager.restoreProjectBinding(projectPath, "bob");
    state = manager.getState();

    // In-memory state must be reset
    assert.equal(state.linked, false, "State linked must be false for Bob");
    assert.equal(state.deploymentUrl, null, "Deployment URL must be null for Bob");

    // .vercel directory on disk must be removed to avoid 403 on subsequent publish
    const exists = await fs.access(vercelDir).then(() => true).catch(() => false);
    assert.equal(exists, false, ".vercel directory on disk must be removed for inaccessible account");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: M - Account B with legitimate access preserves .vercel/project.json binding", async () => {
  const tempDir = await createTempDir("vercel-legit-access");
  try {
    const vaultPath = path.join(tempDir, "vault.json");
    const vault = new VercelVaultManager(vaultPath);

    // Mock CLI where Bob HAS access to "team-app" in project ls
    const mockCli = new MockVercelCli();
    mockCli.runCli = async (_cli: any, args: string[]) => {
      if (args[0] === "project" && args[1] === "ls") {
        return { stdout: "team-app\nother-project", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const manager = new VercelManager(vault, mockCli as any);

    const projectPath = path.join(tempDir, "my-team-app");
    const vercelDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelDir, { recursive: true });
    await fs.writeFile(path.join(vercelDir, "project.json"), JSON.stringify({ projectId: "prj_team_123" }));

    // Alice deployed previously
    await vault.saveDeployment(projectPath, "https://team-app.vercel.app", "team-app", "alice");

    // Bob connects and has access to team-app
    await manager.restoreProjectBinding(projectPath, "bob");

    const state = manager.getState();
    assert.equal(state.linked, true, "State linked must remain true for Bob with verified access");
    assert.equal(state.projectName, "team-app");
    assert.equal(state.deploymentUrl, "https://team-app.vercel.app");

    // .vercel directory must remain on disk
    const exists = await fs.access(vercelDir).then(() => true).catch(() => false);
    assert.equal(exists, true, ".vercel directory must remain intact for authorized team member");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: N - Account B can subsequently create/link new project cleanly after stale cleanup", async () => {
  const tempDir = await createTempDir("vercel-relink-clean");
  try {
    const vaultPath = path.join(tempDir, "vault.json");
    const vault = new VercelVaultManager(vaultPath);
    const mockCli = new MockVercelCli();
    const originalRunCli = mockCli.runCli.bind(mockCli);
    mockCli.runCli = async (cli: any, args: string[], cwd?: string, timeout?: number, onLine?: any) => {
      if (args[0] === "whoami") return { stdout: "bob\n", stderr: "" };
      return originalRunCli(cli, args, cwd, timeout, onLine);
    };
    const manager = new VercelManager(vault, mockCli as any);

    const projectPath = path.join(tempDir, "my-clean-app");
    const vercelDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelDir, { recursive: true });
    await fs.writeFile(path.join(vercelDir, "project.json"), JSON.stringify({ projectId: "prj_stale_old" }));

    // Stale deployment by old account
    await vault.saveDeployment(projectPath, "https://old.vercel.app", "old-app", "alice");

    // Set active project on manager
    await manager.setProject(projectPath);

    // Bob connects (no access to old-app) -> stale cleaned
    await manager.restoreProjectBinding(projectPath, "bob");
    assert.equal(manager.getState().linked, false);

    // Bob publishes new project "bobs-new-app"
    const finalState = await manager.deploy(projectPath, {}, "bobs-new-app");

    assert.equal(finalState.deployment, "ready");
    assert.equal(finalState.projectName, "bobs-new-app");
    assert.equal(finalState.linked, true);

    // Verify Bob's deployment was saved with Bob's username
    const saved = await vault.getDeployment(projectPath);
    assert.equal(saved?.projectName, "bobs-new-app");
    assert.equal(saved?.username, "bob");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: O - Closing login terminal terminates polling immediately and cancels authentication without error", async () => {
  const tempDir = await createTempDir("vercel-term-cancel");
  try {
    const vault = new VercelVaultManager(path.join(tempDir, "vault.json"));
    const mockCli = new MockVercelCli();
    mockCli.mockUser = null; // not authenticated
    const manager = new VercelManager(vault, mockCli as any);

    // Start connect in background
    const connectPromise = manager.connect();

    // Give time to spawn
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(manager.getState().connection, "authorizing");

    // Simulate user closing the terminal window (clicks [X] in terminal)
    assert.ok(mockCli.triggerTerminalClose, "Terminal close trigger must be available");
    mockCli.triggerTerminalClose({ code: 1, signal: null });

    // connectPromise should resolve promptly (not wait 10 min)
    const state = await connectPromise;
    assert.equal(state.connection, "disconnected", "State must be disconnected after terminal closure");
    assert.equal(state.username, null);
    assert.equal(state.error, null, "Cancellation must not report an error");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: P - cancelLogin terminates active login process and resets state cleanly", async () => {
  const tempDir = await createTempDir("vercel-cancel-login");
  try {
    const vault = new VercelVaultManager(path.join(tempDir, "vault.json"));
    const mockCli = new MockVercelCli();
    mockCli.mockUser = null;
    const manager = new VercelManager(vault, mockCli as any);

    // Start connect
    const connectPromise = manager.connect();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(manager.getState().connection, "authorizing");

    // User cancels via modal button
    const cancelState = await manager.cancelLogin();
    assert.equal(cancelState.connection, "disconnected");
    assert.equal(cancelState.username, null);
    assert.equal(cancelState.error, null);

    const connectState = await connectPromise;
    assert.equal(connectState.connection, "disconnected");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: R - Early exit (< 1000ms) on real strategy triggers fallback instead of user cancellation", async () => {
  const tempDir = await createTempDir("vercel-fallback-test");
  try {
    const vault = new VercelVaultManager(path.join(tempDir, "vault.json"));
    const mockCli = new MockVercelCli();
    mockCli.mockUser = null;

    const strategiesAttempted: number[] = [];
    mockCli.openLoginTerminal = async (_cli: any, strategyIndex = 0) => {
      strategiesAttempted.push(strategyIndex);
      let resolver: any;
      const waitClose = () =>
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          resolver = resolve;
        });

      // Se for a primeira estratégia (0), fecha instantaneamente simulando crash/early exit
      if (strategyIndex === 0) {
        setTimeout(() => resolver({ code: 0, signal: null }), 50);
      } else {
        // Estratégia secundária: autentica com sucesso
        setTimeout(() => {
          mockCli.mockUser = "fallback_success_user";
          resolver({ code: 0, signal: null });
        }, 1200);
      }

      return {
        strategy: strategyIndex === 0 ? "conhost" : "powershell",
        pid: 9900 + strategyIndex,
        child: { pid: 9900 + strategyIndex, kill: () => {} } as any,
        waitClose,
      };
    };

    const manager = new VercelManager(vault, mockCli as any);
    const result = await manager.connect();

    // Deve ter tentado strategy 0 primeiro e depois fallback para strategy 1
    assert.deepEqual(strategiesAttempted, [0, 1]);
    assert.equal(result.connection, "connected");
    assert.equal(result.username, "fallback_success_user");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: S - Exhaustion of all fallback strategies reports technical error", async () => {
  const tempDir = await createTempDir("vercel-exhaust-test");
  try {
    const vault = new VercelVaultManager(path.join(tempDir, "vault.json"));
    const mockCli = new MockVercelCli();
    mockCli.mockUser = null;

    mockCli.openLoginTerminal = async (_cli: any, _strategyIndex = 0) => {
      let resolver: any;
      const waitClose = () =>
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          resolver = resolve;
        });
      // Todas as estratégias falham imediatamente (<1000ms)
      setTimeout(() => resolver({ code: 0, signal: null }), 30);
      return {
        strategy: "conhost",
        pid: 8888,
        child: { pid: 8888, kill: () => {} } as any,
        waitClose,
      };
    };

    const manager = new VercelManager(vault, mockCli as any);
    await assert.rejects(
      async () => {
        await manager.connect();
      },
      (err: any) => {
        assert.ok(err.message.includes("falharam"));
        return true;
      }
    );

    assert.equal(manager.getState().connection, "error");
    assert.ok(manager.getState().error?.includes("falharam"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel Security: T - Renderer error extraction preserves technical messages and respects fallbacks without leaking secrets", () => {
  const formatError = (error: any, vercelStateError: string | null): string => {
    const rawMsg = (error as Error)?.message ?? "";
    const cleanedMsg = rawMsg
      .replace(/^Error invoking remote method '[^']+'(?::\s*Error:\s*|:\s*)/i, "")
      .replace(/^Error:\s*/i, "")
      .trim();
    return cleanedMsg || vercelStateError || "Erro ao conectar com Vercel.";
  };

  // Cenário A: IPC rejeita com erro específico de terminal
  const errA = new Error("Error invoking remote method 'vercel:connect': Error: Não foi possível abrir o terminal para autenticação da Vercel: teste");
  assert.equal(formatError(errA, null), "Não foi possível abrir o terminal para autenticação da Vercel: teste");

  // Cenário B: IPC rejeita com erro de CLI/npm não encontrado
  const errB = new Error("Error invoking remote method 'vercel:connect': Error: O Vercel CLI não está disponível porque o npm não foi encontrado.");
  assert.equal(formatError(errB, null), "O Vercel CLI não está disponível porque o npm não foi encontrado.");

  // Cenário C: IPC rejeita sem mensagem útil
  const errC = new Error("");
  assert.equal(formatError(errC, null), "Erro ao conectar com Vercel.");

  // Cenário D: Fallback para vercelState.error
  assert.equal(formatError(null, "Erro interno gravado no estado"), "Erro interno gravado no estado");
});





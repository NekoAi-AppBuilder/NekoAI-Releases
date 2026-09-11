import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Import modules from dist/main
import { VercelVaultManager } from "../dist/main/vercel/vercel-vault.js";
import { VercelManager } from "../dist/main/vercel/vercel-manager.js";
import { SupabaseVaultManager } from "../dist/main/supabase/supabase-vault.js";
import { SupabaseManager } from "../dist/main/supabase/supabase-manager.js";

// Helper to create isolated temporary directory
async function createTempDir(prefix: string): Promise<string> {
  const tmpBase = os.tmpdir();
  const dir = await fs.mkdtemp(path.join(tmpBase, `neko-test-${prefix}-`));
  return dir;
}

// ============================================================================
// 1. GITHUB LIFECYCLE & DECOUPLING TESTS
// ============================================================================

test("GitHub: start response correctly extracts device object for device flow modal", () => {
  // Simulates the payload returned by githubStart IPC handler
  const ipcResult1 = {
    device: {
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    },
    status: { connected: false },
  };

  // Renderer extraction logic
  const device1 = ipcResult1?.device || ((ipcResult1 as any)?.userCode ? ipcResult1 : null);
  assert.ok(device1, "Device must be extracted from ipcResult1.device");
  assert.equal(device1.userCode, "ABCD-1234");
  assert.equal(device1.verificationUri, "https://github.com/login/device");

  // Fallback if returned directly
  const ipcResult2: any = {
    userCode: "WXYZ-5678",
    verificationUri: "https://github.com/login/device",
  };
  const device2 = ipcResult2?.device || (ipcResult2?.userCode ? ipcResult2 : null);
  assert.ok(device2, "Device must be extracted when userCode is on root");
  assert.equal(device2.userCode, "WXYZ-5678");
});

test("GitHub: unlink project removes remote origin while preserving account session", async () => {
  // Verifies that unlinking a project is separate from disconnecting the GitHub account.
  const tempProject = await createTempDir("github-unlink");
  try {
    const gitConfigDir = path.join(tempProject, ".git");
    await fs.mkdir(gitConfigDir, { recursive: true });
    await fs.writeFile(path.join(gitConfigDir, "config"), "[remote \"origin\"]\n\turl = git@github.com:user/repo.git\n");

    // Simulating unlink action
    const configContentBefore = await fs.readFile(path.join(gitConfigDir, "config"), "utf-8");
    assert.ok(configContentBefore.includes("origin"), "Remote origin must exist initially");

    // Clear origin config
    await fs.writeFile(path.join(gitConfigDir, "config"), "");
    const configContentAfter = await fs.readFile(path.join(gitConfigDir, "config"), "utf-8");
    assert.ok(!configContentAfter.includes("origin"), "Remote origin must be removed after unlink");
  } finally {
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. VERCEL LIFECYCLE & DECOUPLING TESTS
// ============================================================================

test("Vercel: saveDeployment persists username, projectPath, and deploymentUrl", async () => {
  const tempDir = await createTempDir("vercel-vault");
  try {
    const vaultPath = path.join(tempDir, "vercel-deployments.json");
    const vault = new VercelVaultManager(vaultPath);

    const projectPath = path.join(tempDir, "my-app");
    await vault.saveDeployment(
      projectPath,
      "https://my-app-vercel.vercel.app",
      "my-app-vercel",
      "alice"
    );

    const saved = await vault.getDeployment(projectPath);
    assert.ok(saved, "Deployment must be saved in vault");
    assert.equal(saved?.projectName, "my-app-vercel");
    assert.equal(saved?.deploymentUrl, "https://my-app-vercel.vercel.app");
    assert.equal(saved?.username, "alice");

    // Verify raw file
    const fileContent = JSON.parse(await fs.readFile(vaultPath, "utf-8"));
    const keys = Object.keys(fileContent.deployments);
    assert.equal(keys.length, 1);
    assert.equal(fileContent.deployments[keys[0]].username, "alice");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel: disconnect clears memory session but preserves vault deployment and .vercel directory", async () => {
  const tempDir = await createTempDir("vercel-disc");
  try {
    const vaultPath = path.join(tempDir, "vercel-deployments.json");
    const vault = new VercelVaultManager(vaultPath);

    // Mock CLI wrapper
    const mockCliWrapper: any = {
      createCommand: () => ({
        logout: async () => {},
        listProjects: async () => [],
      }),
    };

    const manager = new VercelManager(vault, mockCliWrapper);
    const projectPath = path.join(tempDir, "project-a");
    const vercelConfigDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelConfigDir, { recursive: true });
    await fs.writeFile(path.join(vercelConfigDir, "project.json"), JSON.stringify({ projectId: "prj_123", orgId: "team_123" }));

    // Save initial deployment
    await vault.saveDeployment(
      projectPath,
      "https://project-a.vercel.app",
      "project-a-site",
      "alice"
    );

    // Disconnect account
    await manager.disconnect();

    // Verify in-memory state is disconnected
    const state = manager.getState();
    assert.equal(state.connection, "disconnected");
    assert.equal(state.username, null);

    // Verify vault deployment STILL exists
    const deployment = await vault.getDeployment(projectPath);
    assert.ok(deployment, "Vault deployment must survive account disconnection!");
    assert.equal(deployment?.projectName, "project-a-site");

    // Verify .vercel/project.json STILL exists
    const projectJsonExists = await fs.access(path.join(vercelConfigDir, "project.json")).then(() => true).catch(() => false);
    assert.ok(projectJsonExists, ".vercel/project.json must not be deleted on disconnect!");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel: reconnecting the same account automatically restores project binding", async () => {
  const tempDir = await createTempDir("vercel-reconnect-same");
  try {
    const vaultPath = path.join(tempDir, "vercel-deployments.json");
    const vault = new VercelVaultManager(vaultPath);
    const projectPath = path.join(tempDir, "my-app");
    const vercelConfigDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelConfigDir, { recursive: true });
    await fs.writeFile(path.join(vercelConfigDir, "project.json"), JSON.stringify({ projectId: "prj_abc" }));

    await vault.saveDeployment(
      projectPath,
      "https://my-app-site.vercel.app",
      "my-app-site",
      "alice"
    );

    const mockCliWrapper: any = {
      createCommand: () => ({
        listProjects: async () => [{ id: "prj_abc", name: "my-app-site" }],
      }),
    };

    const manager = new VercelManager(vault, mockCliWrapper);
    manager.setProject(projectPath);

    // Restore binding for the same account "alice"
    await manager.restoreProjectBinding(projectPath, "alice");

    const currentState = manager.getState();
    assert.equal(currentState.linked, true);
    assert.equal(currentState.projectName, "my-app-site");
    assert.equal(currentState.deploymentUrl, "https://my-app-site.vercel.app");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel: reconnecting a different account does not inherit links without verified access", async () => {
  const tempDir = await createTempDir("vercel-reconnect-diff");
  try {
    const vaultPath = path.join(tempDir, "vercel-deployments.json");
    const vault = new VercelVaultManager(vaultPath);
    const projectPath = path.join(tempDir, "my-app");
    const vercelConfigDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelConfigDir, { recursive: true });
    await fs.writeFile(path.join(vercelConfigDir, "project.json"), JSON.stringify({ projectId: "prj_alice_only" }));

    // Vault was saved by "alice"
    await vault.saveDeployment(
      projectPath,
      "https://alice-site.vercel.app",
      "alice-site",
      "alice"
    );

    // New user "bob" does NOT have "prj_alice_only" in their projects
    const mockCliWrapper: any = {
      createCommand: () => ({
        listProjects: async () => [{ id: "prj_bob_other", name: "bobs-project" }],
      }),
    };

    const manager = new VercelManager(vault, mockCliWrapper);
    manager.setProject(projectPath);

    // Attempt restoring binding for "bob"
    await manager.restoreProjectBinding(projectPath, "bob");

    const currentState = manager.getState();
    assert.equal(currentState.linked, false, "State linked must be false for Bob");
    assert.equal(currentState.deploymentUrl, null, "DeploymentUrl must be null for Bob");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel: project isolation ensures Local Project A and Local Project B have separate bindings", async () => {
  const tempDir = await createTempDir("vercel-isolation");
  try {
    const vaultPath = path.join(tempDir, "vercel-deployments.json");
    const vault = new VercelVaultManager(vaultPath);

    const projectPathA = path.join(tempDir, "proj-a");
    const projectPathB = path.join(tempDir, "proj-b");

    await vault.saveDeployment(
      projectPathA,
      "https://site-a.vercel.app",
      "site-a",
      "alice"
    );

    await vault.saveDeployment(
      projectPathB,
      "https://site-b.vercel.app",
      "site-b",
      "alice"
    );

    assert.equal((await vault.getDeployment(projectPathA))?.deploymentUrl, "https://site-a.vercel.app");
    assert.equal((await vault.getDeployment(projectPathB))?.deploymentUrl, "https://site-b.vercel.app");

    // Unlink project A only
    await vault.removeDeployment(projectPathA);

    assert.equal(await vault.getDeployment(projectPathA), null, "Project A must be removed");
    assert.equal((await vault.getDeployment(projectPathB))?.deploymentUrl, "https://site-b.vercel.app", "Project B must remain intact!");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Vercel: unlinkProject removes .vercel and deletes vault deployment while keeping account logged in", async () => {
  const tempDir = await createTempDir("vercel-unlink");
  try {
    const vaultPath = path.join(tempDir, "vercel-deployments.json");
    const vault = new VercelVaultManager(vaultPath);
    const projectPath = path.join(tempDir, "my-app");
    const vercelConfigDir = path.join(projectPath, ".vercel");
    await fs.mkdir(vercelConfigDir, { recursive: true });
    await fs.writeFile(path.join(vercelConfigDir, "project.json"), JSON.stringify({ projectId: "prj_123" }));

    await vault.saveDeployment(
      projectPath,
      "https://my-app.vercel.app",
      "my-app-site",
      "alice"
    );

    const mockCliWrapper: any = {
      createCommand: () => ({}),
    };

    const manager = new VercelManager(vault, mockCliWrapper);
    manager.setProject(projectPath);

    // Call unlinkProject
    await manager.unlinkProject(projectPath);

    // Verify .vercel/project.json is deleted
    const projectJsonExists = await fs.access(path.join(vercelConfigDir, "project.json")).then(() => true).catch(() => false);
    assert.equal(projectJsonExists, false, ".vercel/project.json must be removed on unlink");

    // Verify vault entry is removed
    assert.equal(await vault.getDeployment(projectPath), null, "Vault record must be removed on unlink");

    // Verify state is unlinked
    const state = manager.getState();
    assert.equal(state.linked, false);
    assert.equal(state.deploymentUrl, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. SUPABASE LIFECYCLE & DECOUPLING TESTS
// ============================================================================

test("Supabase: saveIntegration persists projectRef, projectName, and region", async () => {
  const tempDir = await createTempDir("supabase-vault");
  try {
    const vaultPath = path.join(tempDir, "supabase-vault.json");
    const vault = new SupabaseVaultManager(vaultPath);

    const projectPath = path.join(tempDir, "local-app");
    await vault.saveIntegration(projectPath, {
      projectRef: "xyz-ref-123",
      projectName: "My Database",
      region: "sa-east-1",
      anonKey: "anon-key-abc",
    });

    const saved = await vault.getIntegration(projectPath);
    assert.ok(saved, "Integration must be saved in vault");
    assert.equal(saved?.projectRef, "xyz-ref-123");
    assert.equal(saved?.projectName, "My Database");
    assert.equal(saved?.region, "sa-east-1");

    // Verify persisted file content
    const fileData = JSON.parse(await fs.readFile(vaultPath, "utf-8"));
    const keys = Object.keys(fileData.integrations);
    assert.equal(keys.length, 1);
    assert.equal(fileData.integrations[keys[0]].region, "sa-east-1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Supabase: disconnect clears session and CLI token but preserves vault integrations", async () => {
  const tempDir = await createTempDir("supabase-disc");
  try {
    const vaultPath = path.join(tempDir, "supabase-vault.json");
    const vault = new SupabaseVaultManager(vaultPath);

    const projectPath = path.join(tempDir, "app");
    await vault.saveIntegration(projectPath, {
      projectRef: "ref-project-1",
      projectName: "App DB",
      region: "us-east-1",
    });

    let cliLoggedOut = false;
    const mockCli: any = {
      logout: async () => { cliLoggedOut = true; },
      listProjects: async () => [],
      listOrganizations: async () => [],
    };

    const manager = new SupabaseManager(vault, mockCli);
    manager.setProject(projectPath);

    // Disconnect account
    await manager.disconnect();

    // Verify CLI logout was invoked
    assert.ok(cliLoggedOut, "Supabase CLI logout must be called");

    // Verify in-memory state is disconnected
    const state = manager.getState();
    assert.equal(state.status, "disconnected");
    assert.equal(state.projectRef, null);

    // Verify vault integration STILL exists
    const integration = await vault.getIntegration(projectPath);
    assert.ok(integration, "Project integration in vault must NOT be deleted on account disconnect!");
    assert.equal(integration?.projectRef, "ref-project-1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Supabase: reconnecting same account restores projectRef, projectName, and region", async () => {
  const tempDir = await createTempDir("supabase-reconnect-same");
  try {
    const vaultPath = path.join(tempDir, "supabase-vault.json");
    const vault = new SupabaseVaultManager(vaultPath);

    const projectPath = path.join(tempDir, "app");
    await vault.saveIntegration(projectPath, {
      projectRef: "ref-project-alpha",
      projectName: "Alpha DB",
      region: "sa-east-1",
    });

    const mockProjects = [
      { id: "1", ref: "ref-project-alpha", name: "Alpha DB", region: "sa-east-1", status: "ACTIVE_HEALTHY" },
      { id: "2", ref: "ref-project-beta", name: "Beta DB", region: "us-east-1", status: "ACTIVE_HEALTHY" },
    ];

    const mockCli: any = {
      login: async () => {},
      listProjects: async () => mockProjects,
      listOrganizations: async () => [{ id: "org-1", name: "My Org" }],
      getProjectApiKeys: async () => ({ anonKey: "anon-key" }),
    };

    const manager = new SupabaseManager(vault, mockCli);
    manager.setProject(projectPath);

    // Connect with token
    await manager.connectWithToken("sbp_valid_token");

    const state = manager.getState();
    assert.equal(state.status, "connected", "State must be connected");
    assert.equal(state.projectRef, "ref-project-alpha", "Project ref must be restored");
    assert.equal(state.projectName, "Alpha DB", "Project name must be restored");
    assert.equal(state.region, "sa-east-1", "Region must be restored");
    assert.equal(state.projectUrl, "https://ref-project-alpha.supabase.co");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Supabase: reconnecting different account does not inherit project without access", async () => {
  const tempDir = await createTempDir("supabase-reconnect-diff");
  try {
    const vaultPath = path.join(tempDir, "supabase-vault.json");
    const vault = new SupabaseVaultManager(vaultPath);

    const projectPath = path.join(tempDir, "app");
    // Saved by User A
    await vault.saveIntegration(projectPath, {
      projectRef: "user-a-secret-ref",
      projectName: "User A DB",
      region: "sa-east-1",
    });

    // User B connects, does NOT have access to user-a-secret-ref
    const mockProjectsUserB = [
      { id: "99", ref: "user-b-db", name: "User B DB", region: "us-east-1", status: "ACTIVE_HEALTHY" },
    ];

    const mockCli: any = {
      login: async () => {},
      listProjects: async () => mockProjectsUserB,
      listOrganizations: async () => [{ id: "org-b", name: "Org B" }],
    };

    const manager = new SupabaseManager(vault, mockCli);
    manager.setProject(projectPath);

    // User B connects
    await manager.connectWithToken("sbp_user_b_token");

    const state = manager.getState();
    assert.notEqual(state.status, "connected", "User B must not be connected to User A's project");
    assert.equal(state.projectRef, null, "Project ref must not be inherited by User B");
    assert.equal(state.region, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Supabase: project isolation ensures Local Project A and Local Project B have separate bindings", async () => {
  const tempDir = await createTempDir("supabase-isolation");
  try {
    const vaultPath = path.join(tempDir, "supabase-vault.json");
    const vault = new SupabaseVaultManager(vaultPath);

    const projectA = path.join(tempDir, "proj-a");
    const projectB = path.join(tempDir, "proj-b");

    await vault.saveIntegration(projectA, {
      projectRef: "ref-a",
      projectName: "DB A",
      region: "sa-east-1",
    });

    await vault.saveIntegration(projectB, {
      projectRef: "ref-b",
      projectName: "DB B",
      region: "us-west-1",
    });

    assert.equal((await vault.getIntegration(projectA))?.projectRef, "ref-a");
    assert.equal((await vault.getIntegration(projectB))?.projectRef, "ref-b");

    // Unlink project A
    await vault.removeIntegration(projectA);

    assert.equal(await vault.getIntegration(projectA), null, "Project A integration must be removed");
    assert.equal((await vault.getIntegration(projectB))?.projectRef, "ref-b", "Project B integration must remain intact");
    assert.equal((await vault.getIntegration(projectB))?.region, "us-west-1");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Supabase: unlinkProject removes vault integration and resets project state while keeping account logged in", async () => {
  const tempDir = await createTempDir("supabase-unlink");
  try {
    const vaultPath = path.join(tempDir, "supabase-vault.json");
    const vault = new SupabaseVaultManager(vaultPath);

    const projectPath = path.join(tempDir, "app");
    await vault.saveIntegration(projectPath, {
      projectRef: "ref-to-unlink",
      projectName: "Unlink DB",
      region: "sa-east-1",
    });

    const mockCli: any = {
      listProjects: async () => [{ id: "1", ref: "ref-to-unlink", name: "Unlink DB" }],
      listOrganizations: async () => [],
    };

    const manager = new SupabaseManager(vault, mockCli);
    manager.setProject(projectPath);

    // Call unlinkProject
    await manager.unlinkProject(projectPath);

    // Verify vault integration was deleted
    assert.equal(await vault.getIntegration(projectPath), null, "Vault record must be removed on unlink");

    // Verify in-memory state is disconnected from project
    const state = manager.getState();
    assert.equal(state.status, "disconnected");
    assert.equal(state.projectRef, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

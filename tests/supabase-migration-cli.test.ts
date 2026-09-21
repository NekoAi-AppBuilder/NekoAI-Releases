import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MigrationManager } from '../src/main/supabase/migration-manager';

const mockRunCli = vi.fn();
vi.mock('../src/main/supabase/supabase-manager', () => ({
  supabaseManager: { cli: { runCli: (...args: any[]) => mockRunCli(...args) } }
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined)
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

describe('MigrationManager - CLI Execution', () => {
  let manager: MigrationManager;
  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MigrationManager();
  });

  test('TESTE 1: PENDING -> REJECTED', async () => {
    let proposalId: string | null = null;
    manager.on('migration-asked', (req) => { proposalId = req.id; });
    const p = manager.proposeMigration({ sessionId: 's1', projectRef: 'p1', name: 'm1', sql: 'create table t1();' });
    expect(proposalId).not.toBeNull();
    manager.cancelProposal(proposalId!);
    await expect(p).resolves.toMatchObject({ status: 'CANCELLED', success: false });
  });

  test('TESTE 2: PENDING -> APPROVED -> MCP tool success -> SUCCESS', async () => {
    let proposalId: string | null = null;
    manager.on('migration-asked', (req) => { proposalId = req.id; });
    let completedPayload = null;
    manager.on('migration-completed', (p) => { completedPayload = p; });

    const p = manager.proposeMigration({ sessionId: 's2', projectRef: 'proj_x', name: 'm2', sql: 'create table t2();' });
    await manager.replyProposal(proposalId!, true);
    manager.notifyToolExecuting(proposalId!);
    await manager.notifyToolCompleted(proposalId!, true);
    
    const res = await p;
    expect(res.success).toBe(true);
    expect(res.status).toBe('SUCCESS');
    expect(completedPayload).not.toBeNull();
    expect(res.appliedFilename).toBeDefined();
  });

  test('TESTE 3: MCP tool failure -> FAILED com erro compreensível', async () => {
    let proposalId: string | null = null;
    manager.on('migration-asked', (req) => { proposalId = req.id; });
    let failedPayload = null;
    manager.on('migration-failed', (p) => { failedPayload = p; });

    const p = manager.proposeMigration({ sessionId: 's3', projectRef: 'p3', name: 'm3', sql: 'create table t3();' });
    await manager.replyProposal(proposalId!, true);
    manager.notifyToolExecuting(proposalId!);
    await manager.notifyToolCompleted(proposalId!, false, "Unauthorized - You must login first");

    const res = await p;
    expect(res.success).toBe(false);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain("Unauthorized - You must login first");
    expect(failedPayload).not.toBeNull();
  });
});

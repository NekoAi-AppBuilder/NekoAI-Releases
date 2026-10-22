const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceRegistry } = require('../dist/main/workspaces/workspace-registry.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-workspaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  fs.mkdirSync(a); fs.mkdirSync(b);
  return { root, a, b, registry: new WorkspaceRegistry() };
}

test('opening B preserves A and its session ownership', t => {
  const { a, b, registry: r } = fixture(t);
  const A = r.open(a); r.bindSession(A, 'session-A');
  const B = r.open(b); r.bindSession(B, 'session-B');
  assert.equal(r.list().length, 2);
  assert.equal(r.assertSession(A, 'session-A').projectPath, fs.realpathSync.native(a));
  assert.throws(() => r.assertSession(B, 'session-A'), /não pertence/);
  assert.throws(() => r.bindSession(B, 'session-A'), /outro projeto/);
});

test('equivalent paths reuse a live instance', t => {
  const { a, registry: r } = fixture(t);
  const A = r.open(a);
  assert.equal(r.open(path.join(a, '.')).workspaceId, A.workspaceId);
  assert.equal(r.open(a + path.sep).workspaceId, A.workspaceId);
  if (process.platform === 'win32') assert.equal(r.open(a.toUpperCase()).workspaceId, A.workspaceId);
});

test('same folder names in different directories stay isolated', t => {
  const { a, b, registry: r } = fixture(t);
  const first = path.join(a, 'same'), second = path.join(b, 'same');
  fs.mkdirSync(first); fs.mkdirSync(second);
  assert.notEqual(r.open(first).workspaceId, r.open(second).workspaceId);
});

test('closing B does not close A or release its sessions', t => {
  const { a, b, registry: r } = fixture(t); const A = r.open(a), B = r.open(b);
  r.bindSession(A, 'session-A'); r.bindSession(B, 'session-B'); r.close(B);
  assert.equal(r.list().length, 1); r.assertSession(A, 'session-A');
  assert.throws(() => r.assertLive(B));
});

test('reopening creates a new identity and rejects stale leases and sessions', t => {
  const { a, registry: r } = fixture(t); const old = r.open(a);
  r.bindSession(old, 'old-session'); r.close(old); const reopened = r.open(a);
  assert.notEqual(old.workspaceId, reopened.workspaceId);
  assert.equal(reopened.generation, old.generation + 1);
  assert.throws(() => r.assertLive(old));
  assert.throws(() => r.assertSession(reopened, 'old-session'));
});

test('asynchronous contexts do not leak between concurrent projects', async t => {
  const { a, b, registry: r } = fixture(t); const A = r.open(a), B = r.open(b);
  const run = (lease, delay) => r.run(lease, async () => {
    const before = r.current().workspaceId;
    await new Promise(resolve => setTimeout(resolve, delay));
    return [before, r.current().workspaceId];
  });
  const [resultA, resultB] = await Promise.all([run(A, 20), run(B, 5)]);
  assert.deepEqual(resultA, [A.workspaceId, A.workspaceId]);
  assert.deepEqual(resultB, [B.workspaceId, B.workspaceId]);
  assert.throws(() => r.current(), /sem workspace/);
});

test('late async work cannot resolve a workspace after closing', async t => {
  const { a, registry: r } = fixture(t); const A = r.open(a);
  let resume; const barrier = new Promise(resolve => { resume = resolve; });
  const operation = r.run(A, async () => { await barrier; return r.current(); });
  r.close(A); r.open(a); resume();
  await assert.rejects(operation, /encerrado/);
});

test('public snapshots cannot mutate registry ownership', t => {
  const { a, registry: r } = fixture(t); const A = r.open(a);
  assert(Object.isFrozen(A)); assert(Object.isFrozen(A.sessionIds));
  assert.throws(() => A.sessionIds.push('injected'));
  assert.throws(() => r.assertSession(A, 'injected'));
  assert.throws(() => r.bindSession(A, '   '));
});

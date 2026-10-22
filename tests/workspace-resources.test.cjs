const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WorkspaceRegistry } = require('../dist/main/workspaces/workspace-registry.js');
const { WorkspaceResources } = require('../dist/main/workspaces/workspace-resources.js');
const { stopChildProcessTree } = require('../dist/main/workspaces/stop-child-process.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new WorkspaceRegistry();
  const a = path.join(root, 'A'), b = path.join(root, 'B'); fs.mkdirSync(a); fs.mkdirSync(b);
  return { registry, pool: new WorkspaceResources(registry), A: registry.open(a), B: registry.open(b) };
}

test('close A releases only A handles in dependency order', async t => {
  const { pool, A, B } = fixture(t); const released = [];
  for (const lease of [A, B]) for (const kind of ['engine','preview-process','preview-server','watcher','event-stream']) {
    pool.track(lease, kind, {}, () => released.push([lease.workspaceId, kind]));
  }
  await pool.close(A);
  assert.deepEqual(released.map(x => x[1]), ['event-stream','watcher','preview-server','preview-process','engine']);
  assert(released.every(x => x[0] === A.workspaceId));
  assert.equal(pool.describe(A).state, 'closed'); assert.equal(pool.describe(B).resources.length, 5);
});

test('concurrent closing and repeated closing dispose once', async t => {
  const { pool, A } = fixture(t); let count = 0;
  pool.track(A, 'engine', {}, async () => { count++; await new Promise(r => setTimeout(r, 10)); });
  const first = pool.close(A), second = pool.close(A); assert.equal(first, second);
  await Promise.all([first, second]); await pool.close(A); assert.equal(count, 1);
});

test('failed disposal retains its handle and still closes remaining resources', async t => {
  const { pool, A } = fixture(t); let attempts = 0, previews = 0;
  pool.track(A, 'event-stream', {}, () => { if (++attempts === 1) throw Error('fixture failure'); });
  pool.track(A, 'preview-process', {}, () => { previews++; });
  await assert.rejects(pool.close(A), AggregateError);
  assert.deepEqual(pool.describe(A).resources, ['event-stream']); assert.equal(previews, 1);
  await pool.close(A); assert.equal(attempts, 2); assert.equal(previews, 1);
});

test('late exit of old handle cannot remove its replacement', async t => {
  const { pool, A } = fixture(t); const old = {}, replacement = {};
  pool.track(A, 'engine', old, () => {}); await pool.release(A, 'engine', old);
  pool.track(A, 'engine', replacement, () => {});
  assert.equal(pool.forget(A, 'engine', old), false);
  assert.deepEqual(pool.describe(A).resources, ['engine']);
});

test('live handle cannot be silently replaced or registered while closing', async t => {
  const { pool, A } = fixture(t); let resume;
  pool.track(A, 'engine', {}, () => new Promise(r => { resume = r; }));
  assert.throws(() => pool.track(A, 'engine', {}, () => {}), /anterior/);
  const closing = pool.close(A); await Promise.resolve();
  assert.throws(() => pool.track(A, 'watcher', {}, () => {}), /encerrado/);
  resume(); await closing;
});

test('closing captured resources remains possible after registry invalidation', async t => {
  const { pool, registry, A } = fixture(t); let closed = false;
  pool.track(A, 'engine', {}, () => { closed = true; }); registry.close(A);
  await pool.close(A); assert(closed); pool.retire(A);
});

test('retire requires resources closed and identity invalidated', async t => {
  const { pool, registry, A } = fixture(t); pool.track(A, 'engine', {}, () => {});
  assert.throws(() => pool.retire(A)); await pool.close(A); assert.throws(() => pool.retire(A));
  registry.close(A); pool.retire(A); assert.deepEqual(pool.describe(A).resources, []);
});

test('resource callbacks keep their captured workspace after B becomes selected', async t => {
  const { pool, A, B } = fixture(t); let selected = A; const closed = [];
  const capturedA = { project: A.workspaceId }, capturedB = { project: B.workspaceId };
  pool.track(A, 'watcher', capturedA, () => closed.push(capturedA.project));
  pool.track(B, 'watcher', capturedB, () => closed.push(capturedB.project)); selected = B;
  await pool.close(A); assert.equal(selected, B); assert.deepEqual(closed, [A.workspaceId]);
});

async function stopFixtureProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

async function child(t, label) {
  const processRef = spawn(process.execPath, ['-e', `process.on('disconnect',()=>process.exit());setTimeout(()=>process.exit(),30000).unref();process.send({ready:true});process.on('message',m=>{if(m==='ping')process.send({pong:true});});setInterval(()=>{},1000);`], { windowsHide:true, stdio:['ignore','ignore','ignore','ipc'] });
  t.after(async () => { await stopFixtureProcess(processRef); });
  await once(processRef, 'message'); return processRef;
}

test('real child processes: stopping A leaves B alive and responsive', { timeout: 15000 }, async t => {
  const { pool, A, B } = fixture(t); const a = await child(t,'A'), b = await child(t,'B');
  pool.track(A, 'engine', a, () => stopFixtureProcess(a));
  pool.track(B, 'engine', b, () => stopFixtureProcess(b));
  await pool.close(A); assert(a.exitCode !== null || a.signalCode !== null);
  const pong = once(b, 'message'); b.send('ping'); assert.equal((await pong)[0].pong, true);
  assert.equal(b.exitCode, null); await pool.close(B);
});

test('Windows/native process-tree helper can be disposed repeatedly', { timeout: 15000, skip: process.env.NEKO_TEST_SKIP_WINDOWS_TASKKILL === '1' ? 'taskkill returned code 1 in this restricted test environment; direct child isolation tested separately' : false }, async t => {
  const proc = await child(t,'done'); await stopChildProcessTree(proc); await stopChildProcessTree(proc);
});

test('same process handle cannot be owned by two projects', async t => {
  const { pool, A, B } = fixture(t); const process = {};
  pool.track(A, 'engine', process, () => {});
  assert.throws(() => pool.track(B, 'engine', process, () => {}), /outro workspace/);
  assert.throws(() => pool.track(A, 'preview-process', process, () => {}), /outro workspace/);
  await pool.close(A);
  pool.track(B, 'engine', process, () => {});
});

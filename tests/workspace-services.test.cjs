const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceRegistry } = require('../dist/main/workspaces/workspace-registry.js');
const { WorkspaceServices } = require('../dist/main/workspaces/workspace-services.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-services-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new WorkspaceRegistry();
  const a = path.join(root, 'A'), b = path.join(root, 'B'); fs.mkdirSync(a); fs.mkdirSync(b);
  const A = registry.open(a), B = registry.open(b);
  registry.bindSession(A, 'session-A'); registry.bindSession(B, 'session-B');
  return { registry, services: new WorkspaceServices(registry), A, B };
}

async function server(t, label, delay = 0) {
  const server = http.createServer((req, res) => setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ label, directory: req.headers['x-opencode-directory'], url: req.url, authorization: req.headers.authorization }));
  }, delay));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('concurrent HTTP requests retain separate engine, directory and session targets', async t => {
  const { services, A, B, registry } = fixture(t);
  const first = services.attach(A, await server(t, 'engine-A', 15));
  const second = services.attach(B, await server(t, 'engine-B'));
  let selected = A; const promiseA = services.request(first, '/session/session-A/message'); selected = B;
  const [replyA, replyB] = await Promise.all([promiseA, services.request(second, '/session/session-B/message')]);
  const a = await replyA.json(), b = await replyB.json();
  assert.equal(selected.workspaceId, B.workspaceId);
  assert.equal(a.label, 'engine-A'); assert.equal(b.label, 'engine-B');
  assert.equal(decodeURIComponent(a.directory), A.projectPath);
  assert.equal(decodeURIComponent(b.directory), B.projectPath);
  assert.equal(registry.forSession('session-A').workspaceId, A.workspaceId);
});

test('late response is rejected if workspace closes while request runs', async t => {
  const { services, registry, A } = fixture(t);
  const target = services.attach(A, await server(t, 'engine-A', 25));
  const pending = services.request(target, '/session/session-A/message');
  registry.close(A); await assert.rejects(pending, /encerrado/);
});

test('engine restart invalidates a captured target without invalidating conversation', t => {
  const { services, registry, A } = fixture(t);
  const old = services.attach(A, 'http://127.0.0.1:51001');
  const current = services.attach(A, 'http://127.0.0.1:51002');
  assert.throws(() => services.assertCurrent(old), /reiniciado/);
  services.assertCurrent(current); registry.assertSession(A, 'session-A');
});

test('detaching one engine leaves another available', t => {
  const { services, A, B } = fixture(t);
  services.attach(A, 'http://127.0.0.1:51001'); const second = services.attach(B, 'http://127.0.0.1:51002');
  services.detach(A); assert.throws(() => services.capture(A)); services.assertCurrent(second);
});

test('external or credential-bearing service addresses are refused', t => {
  const { services, A } = fixture(t);
  for (const url of ['https://example.com', 'http://example.com', 'http://user:secret@localhost:1234', 'file:///tmp/a', 'http://localhost:1234/path', 'http://localhost:1234/?token=x']) {
    assert.throws(() => services.attach(A, url));
  }
});

test('one engine cannot be bound to two projects', t => {
  const { services, A, B } = fixture(t); services.attach(A, 'http://127.0.0.1:51001');
  assert.throws(() => services.attach(B, 'http://127.0.0.1:51001'), /outro workspace/);
});

test('forged target cannot override project directory or host', t => {
  const { services, A } = fixture(t); const target = services.attach(A, 'http://127.0.0.1:51001');
  assert.throws(() => services.assertCurrent({ ...target, engineUrl: 'http://example.com' }));
  assert.throws(() => services.headers({ ...target, projectPath: 'other' }));
  assert(Object.isFrozen(target));
});

test('HTTP headers cannot redirect project context supplied by caller', async t => {
  const { services, A } = fixture(t); const target = services.attach(A, await server(t, 'engine-A'));
  const response = await services.request(target, '/session', { headers: { 'x-opencode-directory': 'wrong-project', Authorization: 'test-credential' } });
  const data = await response.json(); assert.equal(decodeURIComponent(data.directory), A.projectPath); assert.equal(data.authorization, 'test-credential');
});

test('absolute and protocol-relative request URLs never reach transport', async t => {
  const { services, A } = fixture(t); const target = services.attach(A, 'http://127.0.0.1:51001'); let calls = 0;
  for (const endpoint of ['https://example.com', '//example.com', '/\\example.com']) {
    await assert.rejects(services.request(target, endpoint, {}, async () => { calls++; return new Response(); }));
  }
  assert.equal(calls, 0);
});

test('async result is refused when same project engine restarts mid-operation', async t => {
  const { services, A } = fixture(t); services.attach(A, 'http://127.0.0.1:51001');
  let resume; const barrier = new Promise(resolve => { resume = resolve; });
  const pending = services.use(A, async () => { await barrier; return 'old result'; });
  services.attach(A, 'http://127.0.0.1:51002'); resume();
  await assert.rejects(pending, /reiniciado/);
});

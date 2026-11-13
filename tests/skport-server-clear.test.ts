import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startSkportServer } from '../scripts/skport-server.ts';

const roles = [{ key: 'synthetic-role', label: '合成角色', serverLabel: '合成服別' }];
const roster = { document: { format: 'skport-offline-research' as const, schemaVersion: 1 as const, gameData: { code: 0 as const, data: { chars: [] } } }, retrievedAt: '2026-11-13T00:00:00.000Z', serverUnverified: true as const, summary: { count: 0, fields: [] } };
class FakeClient {
  authenticated = false;
  cleared = 0;
  wait: Promise<void> | undefined;
  entered!: () => void;
  started = new Promise<void>(resolve => { this.entered = resolve; });
  async exchangeCode(_code: string) { this.entered(); if (this.wait) await this.wait; this.authenticated = true; return roles; }
  getBindings() { return this.authenticated ? roles : []; }
  async readRoster(_key: string) { return roster; }
  clear() { this.cleared++; this.authenticated = false; }
}
interface State { csrf: string; authenticated: boolean; roles: typeof roles }
async function fixture(t: TestContext, options: { clock?: () => number; ttl?: number } = {}) {
  const clients: FakeClient[] = [];
  const service = await startSkportServer({ port: 0, clock: options.clock, sessionTtlMs: options.ttl, clientFactory: () => {
    const client = new FakeClient(); clients.push(client); return client;
  } });
  t.after(() => service.close());
  const headers = { 'X-Local-Research': '1', Origin: service.origin };
  const bootstrap = await fetch(`${service.origin}/api/session`, { headers });
  const initial = await bootstrap.json() as State;
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  function post(path: string, data: unknown, identity = { cookie, csrf: initial.csrf }) {
    return fetch(`${service.origin}${path}`, { method: 'POST', headers: { ...headers, Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }
  async function login() {
    const response = await post('/api/login', { code: 'synthetic-code' });
    assert.equal(response.status, 200);
    const state = await response.json() as State;
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: state.csrf };
  }
  async function session(identityCookie: string) {
    const response = await fetch(`${service.origin}/api/session`, { headers: { ...headers, Cookie: identityCookie } });
    assert.equal(response.status, 200); return await response.json() as State;
  }
  return { ...service, headers, initial, cookie, client: clients[0], post, login, session };
}

test('登入已輪換但新 cookie 尚未使用，舊 cookie 與原 CSRF 仍能撤銷 successor', async t => {
  const f = await fixture(t);
  const next = await f.login();
  const response = await f.post('/api/clear', {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cleared: true });
  assert.match(response.headers.get('set-cookie')!, /Max-Age=0/u);
  assert.equal(f.client.cleared, 1);
  assert.equal((await f.post('/api/roster', { roleKey: roles[0].key, confirmedTw: true }, next)).status, 401);
  assert.equal((await f.session(next.cookie)).authenticated, false);
});

test('撤銷連結不授予舊 cookie 讀取 session、roster 或重新登入的權限', async t => {
  const f = await fixture(t);
  const next = await f.login();
  assert.equal((await f.post('/api/roster', { roleKey: roles[0].key, confirmedTw: true })).status, 401);
  assert.equal((await f.post('/api/login', { code: 'synthetic-second' })).status, 401);
  const stale = await f.session(f.cookie);
  assert.equal(stale.authenticated, false); assert.deepEqual(stale.roles, []);
  assert.equal((await f.session(next.cookie)).authenticated, true);
});

test('舊 cookie 只有原 CSRF 能撤銷，錯誤或 successor CSRF 不會清除連線', async t => {
  const f = await fixture(t);
  const next = await f.login();
  for (const csrf of ['wrong-synthetic-csrf', next.csrf]) {
    assert.equal((await f.post('/api/clear', {}, { cookie: f.cookie, csrf })).status, 403);
    assert.equal(f.client.cleared, 0);
  }
  assert.equal((await f.post('/api/roster', { roleKey: roles[0].key, confirmedTw: true }, next)).status, 200);
  assert.equal((await f.post('/api/clear', {}, next)).status, 200);
  assert.equal((await f.post('/api/clear', {})).status, 401);
});

test('撤銷連結在原工作階段期限與 15 分鐘上限的較早者到期', async t => {
  for (const [ttl, loginDelay, afterLogin] of [[10_000, 5_000, 5_001], [3_600_000, 0, 900_001]]) {
    let now = 1_794_546_000_000;
    const f = await fixture(t, { clock: () => now, ttl });
    now += loginDelay;
    const next = await f.login();
    now += afterLogin;
    assert.equal((await f.post('/api/clear', {})).status, 401);
    assert.equal(f.client.cleared, 0);
    assert.equal((await f.post('/api/roster', { roleKey: roles[0].key, confirmedTw: true }, next)).status, 200);
  }
});

test('清除登入中的工作階段後，晚到的登入結果不能建立 successor', async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.client.wait = new Promise<void>(resolve => { release = resolve; });
  const pending = f.post('/api/login', { code: 'synthetic-code' });
  await f.client.started;
  assert.equal((await f.post('/api/clear', {})).status, 200);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(f.client.authenticated, false);
  assert.equal((await f.session(f.cookie)).authenticated, false);
});

test('clear 讀取 body 期間登入完成輪換，仍以舊 cookie 撤銷 successor', async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.client.wait = new Promise<void>(resolve => { release = resolve; });
  const login = f.post('/api/login', { code: 'synthetic-code' });
  await f.client.started;
  let ready!: () => void;
  const accepted = new Promise<void>(resolve => { ready = resolve; });
  let finish!: () => void;
  const cleared = new Promise<number | undefined>((resolveStatus, reject) => {
    const request = httpRequest(`${f.origin}/api/clear`, { method: 'POST', headers: {
      ...f.headers, Cookie: f.cookie, 'X-CSRF-Token': f.initial.csrf, 'Content-Type': 'application/json', 'Content-Length': '2', Expect: '100-continue',
    } }, response => { response.resume(); response.once('end', () => resolveStatus(response.statusCode)); });
    request.on('error', reject);
    request.once('continue', () => { request.write('{'); ready(); });
    finish = () => request.end('}'); request.flushHeaders();
  });
  await accepted;
  release();
  const response = await login;
  assert.equal(response.status, 200);
  const state = await response.json() as State;
  const next = { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: state.csrf };
  finish();
  assert.equal(await cleared, 200);
  assert.equal((await f.post('/api/roster', { roleKey: roles[0].key, confirmedTw: true }, next)).status, 401);
});

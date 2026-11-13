import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startSkportServer } from '../scripts/skport-server.ts';

const roles = [{ key: 'synthetic-review-role', label: '合成角色', serverLabel: '服別未驗證' }];
const roster = { document: { format: 'skport-offline-research' as const, schemaVersion: 1 as const, gameData: { code: 0 as const, data: { chars: [] } } }, retrievedAt: '2026-11-13T00:00:00.000Z', serverUnverified: true as const, summary: { count: 0, fields: [] } };
class ReviewClient {
  exchanges = 0;
  reads = 0;
  clears = 0;
  connected = false;
  pending: Promise<void> | undefined;
  async exchangeCode(_code: string) { this.exchanges++; await this.pending; this.connected = true; return roles; }
  getBindings() { return this.connected ? roles.map(role => ({ ...role })) : []; }
  async readRoster(_key: string) { this.reads++; return roster; }
  clear() { this.clears++; this.connected = false; }
}

async function fixture(t: TestContext, options: { clock?: () => number; ttl?: number } = {}) {
  const clients: ReviewClient[] = [];
  const service = await startSkportServer({ port: 0, clock: options.clock, sessionTtlMs: options.ttl, clientFactory: () => { const client = new ReviewClient(); clients.push(client); return client; } });
  t.after(() => service.close());
  const initial = await fetch(service.origin + '/api/session', { headers: { 'X-Local-Research': '1' } });
  const state = await initial.json() as { csrf: string };
  const cookie = initial.headers.get('set-cookie')!.split(';')[0];
  const headers = { Origin: service.origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Local-Research': '1', 'X-CSRF-Token': state.csrf };
  const post = (path: string, value: unknown, override: Record<string, string> = {}) => fetch(service.origin + path, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(value) });

  async function delayed(path: string) {
    const marker = randomUUID();
    // The server's handler runs before this observer. Resolving here proves the
    // request entered its body wait; no wall-clock sleep is used as evidence.
    const entered = new Promise<void>(resolve => {
      const observe = (req: IncomingMessage) => {
        if (req.headers['x-review-id'] === marker) { service.server.off('request', observe); resolve(); }
      };
      service.server.on('request', observe);
      t.after(() => service.server.off('request', observe));
    });
    let finishResponse!: (status: number) => void;
    const response = new Promise<number>(resolve => { finishResponse = resolve; });
    const req = request(service.origin + path, { method: 'POST', headers: { ...headers, 'X-Review-ID': marker } }, res => { res.resume(); res.on('end', () => finishResponse(res.statusCode!)); });
    req.on('error', () => finishResponse(0));
    t.after(() => req.destroy());
    req.write('{');
    await entered;
    return { finish: (value: Record<string, unknown>) => { req.end(JSON.stringify(value).slice(1)); return response; } };
  }
  return { ...service, client: clients[0], headers, post, delayed };
}

test('延遲 body 的舊 clear 仍撤銷同次登入，晚到的新 cookie 不得恢復連線', async t => {
  const f = await fixture(t);
  const oldClear = await f.delayed('/api/clear');
  const login = await f.post('/api/login', { code: 'synthetic-code' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  await login.json();
  const clears = f.client.clears;
  // 舊 cookie 只保留帶原 CSRF 的撤銷權，避免登入回應尚未抵達時清除失效。
  assert.equal(await oldClear.finish({}), 200);
  assert.equal(f.client.clears, clears + 1);
  const current = await fetch(f.origin + '/api/session', { headers: { 'X-Local-Research': '1', Cookie: cookie } });
  assert.equal((await current.json() as { authenticated: boolean }).authenticated, false);
});

test('延遲 body 的舊 roster 不可沿用登入前的 Cookie 與 CSRF', async t => {
  const f = await fixture(t);
  const oldRead = await f.delayed('/api/roster');
  const login = await f.post('/api/login', { code: 'synthetic-code' });
  assert.equal(login.status, 200); await login.json();
  assert.equal(await oldRead.finish({ roleKey: roles[0].key, confirmedTw: true }), 401);
  assert.equal(f.client.reads, 0);
});

test('兩個 body 都已開始的登入請求仍只允許一個交換', async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.client.pending = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const first = await f.delayed('/api/login');
  const second = await f.delayed('/api/login');
  const resultA = first.finish({ code: 'synthetic-first' });
  const resultB = second.finish({ code: 'synthetic-second' });
  assert.equal(await Promise.race([resultA, resultB]), 409);
  assert.equal(f.client.exchanges, 1);
  release();
  assert.deepEqual((await Promise.all([resultA, resultB])).sort(), [200, 409]);
});

test('清除已成功後才傳完 body 的登入不得再開始交換', async t => {
  const f = await fixture(t);
  const oldLogin = await f.delayed('/api/login');
  const clear = await f.post('/api/clear', {});
  assert.equal(clear.status, 200); await clear.json();
  assert.equal(await oldLogin.finish({ code: 'synthetic-code' }), 401);
  assert.equal(f.client.exchanges, 0);
});

test('body 傳送期間 session 到期時不得交換 code', async t => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now, ttl: 1000 });
  const oldLogin = await f.delayed('/api/login');
  now += 1001;
  assert.equal(await oldLogin.finish({ code: 'synthetic-code' }), 401);
  assert.equal(f.client.exchanges, 0);
});

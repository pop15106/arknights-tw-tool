import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startSkportServer } from '../scripts/skport-server.ts';
import { SkportClientError, type SkportDiagnostic } from '../scripts/skport-client.ts';

const roles = [{ key: 'synthetic-role', label: '合成角色', serverLabel: '合成服別' }];
const result = { document: { format: 'skport-offline-research' as const, schemaVersion: 1 as const, gameData: { code: 0 as const, data: { chars: [{ charId: 'char_test', level: 10 }] } } }, retrievedAt: '2026-11-13T00:00:00.000Z', serverUnverified: true as const, summary: { count: 1, fields: ['level'] } };
class FakeClient {
  cleared = 0;
  exchanges = 0;
  reads = 0;
  fail = false;
  rosterError: Error | undefined;
  wait: Promise<void> | null = null;
  async exchangeCode(_code: string) { this.exchanges++; if (this.wait) await this.wait; if (this.fail) throw new Error('synthetic-secret-do-not-echo'); return roles; }
  getBindings() { return roles.map(role => ({ ...role })); }
  async readRoster(_key: string) { this.reads++; if (this.rosterError) throw this.rosterError; return result; }
  clear() { this.cleared++; }
}
async function fixture(t: TestContext, options: { client?: FakeClient; clock?: () => number; ttl?: number } = {}) {
  const client = options.client ?? new FakeClient();
  const service = await startSkportServer({ port: 0, clientFactory: () => client, clock: options.clock, sessionTtlMs: options.ttl });
  t.after(() => service.close());
  const headers = { 'X-Local-Research': '1', Origin: service.origin };
  const bootstrap = await fetch(`${service.origin}/api/session`, { headers });
  const initial = await bootstrap.json() as { csrf: string };
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const post = (path: string, data: unknown, overrides: Record<string, string> = {}) => fetch(`${service.origin}${path}`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': initial.csrf, 'Content-Type': 'application/json', ...overrides }, body: JSON.stringify(data) });
  return { ...service, client, headers, initial, cookie, post, bootstrap };
}

test('本機 API 拒絕跨來源、外部 Host、缺自訂標頭及跨站 Fetch-Site', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { ...f.headers, Origin: 'https://example.test' }, { ...f.headers, 'Sec-Fetch-Site': 'cross-site' }, { ...f.headers, 'Sec-Fetch-Site': 'same-site' }]) {
    const response = await fetch(`${f.origin}/api/session`, { headers });
    assert.equal(response.status, 403, JSON.stringify(headers)); assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  // Native fetch may normalize Host. Send the actual hostile Host with node:http.
  const hostileHostStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
    const req = httpRequest(`${f.origin}/api/session`, { headers: { ...f.headers, Host: 'attacker.test' } }, res => { res.resume(); res.once('end', () => resolveStatus(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(`${f.origin}/api/login`, { method: 'OPTIONS', headers: f.headers })).status, 405);
  assert.equal(f.client.exchanges, 0);
});

test('工作階段 Cookie 及 CSRF 綁定；登入成功輪換，舊 Cookie 失效', async t => {
  const f = await fixture(t);
  const setCookie = f.bootstrap.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly/u); assert.match(setCookie, /SameSite=Strict/u); assert.doesNotMatch(setCookie, /Domain=/u);
  assert.equal((await f.post('/api/login', { code: 'synthetic-code' }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal(f.client.exchanges, 0);
  const response = await f.post('/api/login', { code: 'synthetic-code' });
  assert.equal(response.status, 200);
  const data = await response.json() as { csrf: string; authenticated: boolean };
  assert.equal(data.authenticated, true); assert.notEqual(data.csrf, f.initial.csrf);
  assert.notEqual(response.headers.get('set-cookie')!.split(';')[0], f.cookie);
  assert.equal((await f.post('/api/roster', { roleKey: 'synthetic-role', confirmedTw: true })).status, 401);
});

test('未登入不可讀取；角色與服別確認必要；僅返回研究結果', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/roster', { roleKey: 'synthetic-role', confirmedTw: true })).status, 401);
  const login = await f.post('/api/login', { code: 'synthetic-code' });
  const data = await login.json() as { csrf: string };
  const overrides = { Cookie: login.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': data.csrf };
  assert.equal((await f.post('/api/roster', { roleKey: 'synthetic-role' }, overrides)).status, 400);
  const response = await f.post('/api/roster', { roleKey: 'synthetic-role', confirmedTw: true }, overrides);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
  assert.equal(f.client.reads, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('輸入白名單、大小與內容型別拒絕；不支援帳密與任意代理', async t => {
  const f = await fixture(t);
  for (const input of [{ password: 'synthetic-only' }, { code: '' }, { code: 'a', url: 'https://example.test' }, null, []]) assert.equal((await f.post('/api/login', input)).status, 400);
  assert.equal((await f.post('/api/login', { code: 'x'.repeat(9000) })).status, 413);
  assert.equal((await f.post('/api/login', { code: 'synthetic-code' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/api/proxy', {})).status, 404);
  assert.equal((await fetch(`${f.origin}/scripts/skport-server.ts`)).status, 404);
  assert.equal(f.client.exchanges, 0);
});

test('失敗不回顯原始例外或 code；登入重試受限', async t => {
  const client = new FakeClient(); client.fail = true;
  const f = await fixture(t, { client });
  for (let i = 0; i < 5; i++) {
    const response = await f.post('/api/login', { code: 'synthetic-secret-code' });
    assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /synthetic-secret/u);
  }
  assert.equal((await f.post('/api/login', { code: 'synthetic-secret-code' })).status, 429);
  assert.equal(client.exchanges, 5);
});

test('期限到即清除；清除動作使 Cookie 失效', async t => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now, ttl: 10_000 });
  now += 10_001;
  assert.equal((await f.post('/api/login', { code: 'synthetic-code' })).status, 401);
  assert.equal(f.client.cleared, 1);
  const g = await fixture(t);
  const clear = await g.post('/api/clear', {});
  assert.equal(clear.status, 200); assert.match(clear.headers.get('set-cookie')!, /Max-Age=0/u);
  assert.equal(g.client.cleared, 1);
  assert.equal((await g.post('/api/login', { code: 'synthetic-code' })).status, 401);
});

test('同一 session 不重入；清除中止的登入不能復活 session', async t => {
  const client = new FakeClient();
  let release!: () => void;
  client.wait = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { client });
  const first = f.post('/api/login', { code: 'synthetic-first' });
  // Wait for the fake upstream call, not for elapsed wall time.
  for (let i = 0; i < 100 && client.exchanges === 0; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(client.exchanges, 1);
  assert.equal((await f.post('/api/login', { code: 'synthetic-second' })).status, 409);
  assert.equal((await f.post('/api/clear', {})).status, 200);
  release();
  assert.equal((await first).status, 401); assert.equal(client.exchanges, 1);
});

async function rosterFailure(t: TestContext, error: SkportClientError): Promise<Response> {
  const client = new FakeClient(); client.rosterError = error;
  const f = await fixture(t, { client });
  const login = await f.post('/api/login', { code: 'synthetic-code' });
  assert.equal(login.status, 200);
  const state = await login.json() as { csrf: string };
  return f.post('/api/roster', { roleKey: 'synthetic-role', confirmedTw: true }, {
    Cookie: login.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': state.csrf,
  });
}

test('roster 502 只回傳白名單 diagnostic 的欄位位置與型別', async t => {
  const diagnostic = { field: 'data.chars[0].level', expected: 'nonnegative integer within limit', actual: 'string' };
  const error = new SkportClientError('invalid_response', 'roster', diagnostic);
  const response = await rosterFailure(t, error);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'invalid_response', stage: 'roster', message: error.message, diagnostic } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('沒有 diagnostic 的 roster 錯誤維持既有通用 envelope', async t => {
  for (const code of ['invalid_response', 'upstream_network'] as const) {
    const error = new SkportClientError(code, 'roster');
    const response = await rosterFailure(t, error);
    assert.equal(response.status, 502);
    const body = await response.json() as { error: Record<string, unknown> };
    assert.deepEqual(body, { error: { code, stage: 'roster', message: error.message } });
    assert.equal(Object.hasOwn(body.error, 'diagnostic'), false);
  }
});

test('diagnostic 未知詞彙及額外原始值不會經 roster 回應外漏', async t => {
  const secret = 'SYNTHETIC_PRIVATE_VALUE_NOT_REAL';
  const allowed = { field: 'data.chars[0].level', expected: 'integer', actual: 'string' };
  for (const diagnostic of [
    { ...allowed, field: `data.chars[0].${secret}` },
    { ...allowed, expected: secret },
    { ...allowed, actual: secret },
  ]) {
    const response = await rosterFailure(t, new SkportClientError('invalid_response', 'roster', diagnostic));
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_VALUE_NOT_REAL/);
    assert.equal(Object.hasOwn(JSON.parse(text).error, 'diagnostic'), false);
  }
  const extra = { ...allowed, value: secret, rawResponse: { accountToken: secret }, message: secret } as SkportDiagnostic;
  const response = await rosterFailure(t, new SkportClientError('invalid_response', 'roster', extra));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_VALUE_NOT_REAL|rawResponse|accountToken/);
  assert.deepEqual(JSON.parse(text).error.diagnostic, allowed);
});

test('audit 對應每次 API request ID、保留安全診斷且不含登入或角色秘密', async () => {
  const events: Record<string, unknown>[] = [];
  const code = 'SYNTHETIC_AUDIT_LOGIN_CODE_NOT_REAL';
  const roleId = 'SYNTHETIC_AUDIT_ROLE_ID_NOT_REAL';
  const rawValue = 'SYNTHETIC_AUDIT_RAW_VALUE_NOT_REAL';
  const diagnostic = { field: 'data.chars[0].level', expected: 'integer', actual: 'string' };
  const client = new FakeClient();
  client.getBindings = () => [{ key: roleId, label: '合成角色', serverLabel: '合成服別' }];
  client.rosterError = new SkportClientError('invalid_response', 'roster', { ...diagnostic, value: rawValue } as SkportDiagnostic);
  const service = await startSkportServer({ port: 0, clientFactory: () => client, audit: async event => { events.push(structuredClone(event)); } });
  const secrets = [code, roleId, rawValue];
  const requests: { requestId: string; operation: string; method: string; status: number }[] = [];
  function track(response: Response, operation: string, method: string, status: number) {
    assert.equal(response.status, status);
    const requestId = response.headers.get('X-Audit-Request-Id');
    assert.ok(requestId);
    requests.push({ requestId, operation, method, status });
  }
  try {
    const headers = { 'X-Local-Research': '1', Origin: service.origin };
    const bootstrap = await fetch(`${service.origin}/api/session`, { headers });
    track(bootstrap, 'session', 'GET', 200);
    const initial = await bootstrap.json() as { csrf: string };
    const initialCookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    secrets.push(initial.csrf, initialCookie, initialCookie.slice(initialCookie.indexOf('=') + 1));
    const post = (path: string, data: unknown, cookie: string, csrf: string) => fetch(`${service.origin}${path}`, {
      method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    const login = await post('/api/login', { code }, initialCookie, initial.csrf);
    track(login, 'login', 'POST', 200);
    const connected = await login.json() as { csrf: string; roles: typeof roles };
    assert.equal(connected.roles[0].key, roleId);
    const connectedCookie = login.headers.get('set-cookie')!.split(';')[0];
    secrets.push(connected.csrf, connectedCookie, connectedCookie.slice(connectedCookie.indexOf('=') + 1));
    const roster = await post('/api/roster', { roleKey: roleId, confirmedTw: true }, connectedCookie, connected.csrf);
    track(roster, 'roster', 'POST', 502);
    assert.deepEqual((await roster.json() as { error: { diagnostic: SkportDiagnostic } }).error.diagnostic, diagnostic);
    const clear = await post('/api/clear', {}, connectedCookie, connected.csrf);
    track(clear, 'clear', 'POST', 200);
    assert.deepEqual(await clear.json(), { cleared: true });
  } finally {
    await service.close();
  }
  assert.deepEqual(events.map(event => event.event), ['service_start', 'http_request', 'http_request', 'http_request', 'http_request', 'service_stop']);
  assert.equal(new Set(requests.map(request => request.requestId)).size, requests.length);
  const httpEvents = events.filter(event => event.event === 'http_request');
  for (const request of requests) {
    const matches = httpEvents.filter(event => event.requestId === request.requestId);
    assert.equal(matches.length, 1);
    const event = matches[0];
    for (const key of ['operation', 'method', 'status'] as const) assert.equal(event[key], request[key]);
    assert.equal(event.outcome, request.status >= 400 ? 'failure' : 'success');
    assert.ok(typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0);
  }
  const failure = httpEvents.find(event => event.operation === 'roster')!;
  assert.equal(failure.code, 'invalid_response');
  assert.equal(failure.stage, 'roster');
  assert.deepEqual(failure.diagnostic, diagnostic);
  const serialized = JSON.stringify(events);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'audit must exclude synthetic input and session values');
  assert.equal(client.exchanges, 1);
  assert.equal(client.reads, 1);
  assert.equal(client.cleared, 1);
});

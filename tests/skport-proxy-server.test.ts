import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startSkportServer } from '../scripts/skport-server.ts';
import type { SkportLoginProxy } from '../scripts/skport-proxy.ts';

type ProxyInput = Parameters<SkportLoginProxy['forward']>[0];
const COOKIE_PATH = '/api/sdk/web/cookie_store/account_token';
const PASSWORD_PATH = '/api/sdk/account/user/auth/v1/token_by_email_password';
const syntheticLogin = { email: 'synthetic@example.invalid', password: 'synthetic-only' };
class FakeProxy {
  calls: ProxyInput[] = [];
  clears = 0;
  pending: Promise<void> | undefined;
  onForward: (() => void) | undefined;
  failure: Error | undefined;
  result = { status: 200, data: { code: 0, data: { content: 'synthetic-response' } } };
  async forward(input: ProxyInput) {
    this.calls.push(input); this.onForward?.(); await this.pending;
    if (this.failure) throw this.failure;
    return this.result;
  }
  clear() { this.clears++; }
}
class FakeClient {
  clears = 0;
  async exchangeCode(_code: string) { return []; }
  getBindings() { return []; }
  async readRoster(_key: string) { return { document: { format: 'skport-offline-research' as const, schemaVersion: 1 as const, gameData: { code: 0 as const, data: { chars: [] } } }, retrievedAt: '2026-11-13T00:00:00.000Z', serverUnverified: true as const, summary: { count: 0, fields: [] } }; }
  clear() { this.clears++; }
}
interface Reply { status: number; text: string; headers: IncomingMessage['headers'] }
function raw(origin: string, path: string, method: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture(t: TestContext, options: { clock?: () => number; ttl?: number } = {}) {
  const proxies: FakeProxy[] = [], clients: FakeClient[] = [];
  const service = await startSkportServer({ port: 0, clock: options.clock, sessionTtlMs: options.ttl,
    clientFactory: () => { const client = new FakeClient(); clients.push(client); return client; },
    proxyFactory: () => { const proxy = new FakeProxy(); proxies.push(proxy); return proxy; },
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= service.close();
  t.after(close);
  const bootstrap = await fetch(service.origin + '/api/session', { headers: { 'X-Local-Research': '1' } });
  const state = await bootstrap.json() as { csrf: string };
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const controlHeaders = { Origin: service.origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Local-Research': '1', 'X-CSRF-Token': state.csrf };
  const sdkHeaders: Record<string, string> = { Origin: service.origin, Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
  const control = (path: string, value: unknown = {}, overrides: Record<string, string> = {}) => fetch(service.origin + path, { method: 'POST', headers: { ...controlHeaders, ...overrides }, body: JSON.stringify(value) });
  const sdk = (path = COOKIE_PATH, method = 'GET', input?: unknown, overrides: Record<string, string> = {}) => raw(service.origin, path, method, { ...sdkHeaders, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...overrides }, input === undefined ? undefined : JSON.stringify(input));
  async function start() { const reply = await control('/api/sdk-start'); assert.equal(reply.status, 200); assert.deepEqual(await reply.json(), { proxyReady: true }); return proxies.at(-1)!; }
  async function delayedSdk(path = PASSWORD_PATH) {
    const marker = randomUUID();
    const entered = new Promise<void>(resolve => {
      const observe = (req: IncomingMessage) => { if (req.headers['x-review-id'] === marker) { service.server.off('request', observe); resolve(); } };
      service.server.on('request', observe); t.after(() => service.server.off('request', observe));
    });
    let finishResponse!: (reply: Reply) => void;
    const response = new Promise<Reply>(resolve => { finishResponse = resolve; });
    const req = httpRequest(service.origin + path, { method: 'POST', headers: { ...sdkHeaders, 'Content-Type': 'application/json', 'X-Review-ID': marker } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => finishResponse({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', () => finishResponse({ status: 0, text: '', headers: {} }));
    t.after(() => req.destroy()); req.write('{'); await entered;
    return { finish: (input: Record<string, unknown>) => { req.end(JSON.stringify(input).slice(1)); return response; } };
  }
  return { ...service, close, proxies, clients, controlHeaders, sdkHeaders, control, sdk, start, delayedSdk };
}

test('SDK 代理預設未啟用；開始與停止仍要求既有 CSRF 保護', async t => {
  const f = await fixture(t);
  assert.equal(f.proxies.length, 0);
  assert.equal((await f.sdk()).status, 403);
  for (const path of ['/api/sdk-start', '/api/sdk-stop']) {
    assert.equal((await f.control(path, {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await raw(f.origin, path, 'POST', { ...f.sdkHeaders, 'Content-Type': 'application/json' }, '{}')).status, 403);
  }
  assert.equal(f.proxies.length, 0);
  const proxy = await f.start();
  assert.equal((await f.sdk()).status, 200);
  const stopped = await f.control('/api/sdk-stop');
  assert.equal(stopped.status, 200); assert.deepEqual(await stopped.json(), { proxyReady: false });
  assert.equal(proxy.clears, 1); assert.equal((await f.sdk()).status, 403);
});

test('SDK 不需自訂 CSRF header；GET query、POST JSON、無 body DELETE 與業務狀態保留', async t => {
  const f = await fixture(t), proxy = await f.start();
  const path = '/api/sdk/account/user/oauth2/v1/grant_info?token=synthetic-token&appCode=synthetic-app';
  const { Origin: _origin, ...getHeaders } = f.sdkHeaders;
  const get = await raw(f.origin, path, 'GET', getHeaders);
  assert.equal(get.status, 200);
  assert.equal(proxy.calls[0].path, path.slice('/api/sdk'.length));
  assert.equal(proxy.calls[0].method, 'GET'); assert.equal(proxy.calls[0].body, undefined);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.equal(get.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.sdk(PASSWORD_PATH, 'POST', syntheticLogin, { 'X-AppCode': 'synthetic-app', Authorization: 'synthetic-untrusted', 'X-Forwarded-Host': 'attacker.invalid' })).status, 200);
  assert.deepEqual(proxy.calls[1].body, syntheticLogin);
  assert.equal(proxy.calls[1].headers['x-appcode'], 'synthetic-app');
  for (const blocked of ['cookie', 'origin', 'authorization', 'x-forwarded-host', 'x-csrf-token']) assert.equal(proxy.calls[1].headers[blocked], undefined);
  assert.equal((await f.sdk(COOKIE_PATH, 'DELETE')).status, 200);
  assert.equal(proxy.calls[2].body, undefined);
  proxy.result = { status: 401, data: { code: 10002, data: { content: 'synthetic-business-result' } } };
  const failure = await f.sdk();
  assert.equal(failure.status, 401); assert.equal(JSON.parse(failure.text).code, 10002);
});

test('SDK 拒絕缺少或跨站 metadata、導航、外部 Origin、無效 Cookie 及外部 Host', async t => {
  const f = await fixture(t), proxy = await f.start();
  const variants: Array<[Record<string, string>, number]> = [];
  for (const key of ['Sec-Fetch-Site', 'Sec-Fetch-Dest']) { const headers = { ...f.sdkHeaders }; delete headers[key]; variants.push([headers, 403]); }
  for (const site of ['cross-site', 'same-site', 'none']) variants.push([{ ...f.sdkHeaders, 'Sec-Fetch-Site': site }, 403]);
  for (const dest of ['document', 'iframe', 'image']) variants.push([{ ...f.sdkHeaders, 'Sec-Fetch-Dest': dest }, 403]);
  variants.push([{ ...f.sdkHeaders, Origin: 'https://attacker.invalid' }, 403], [{ ...f.sdkHeaders, Host: 'attacker.invalid' }, 403]);
  const noCookie = { ...f.sdkHeaders }; delete noCookie.Cookie;
  variants.push([noCookie, 401], [{ ...f.sdkHeaders, Cookie: 'skport_local=synthetic-invalid' }, 401]);
  for (const [headers, status] of variants) assert.equal((await raw(f.origin, COOKIE_PATH, 'GET', headers)).status, status);
  for (const method of ['POST', 'DELETE']) {
    const headers: Record<string, string> = { ...f.sdkHeaders, 'Content-Type': 'application/json' }; delete headers.Origin;
    assert.equal((await raw(f.origin, COOKIE_PATH, method, headers, method === 'POST' ? '{}' : undefined)).status, 403);
  }
  for (const method of ['OPTIONS', 'PUT', 'PATCH', 'HEAD']) assert.equal((await raw(f.origin, COOKIE_PATH, method, f.sdkHeaders)).status, 405);
  assert.equal(proxy.calls.length, 0);
});

test('SDK POST 拒絕非 JSON、額外欄位、壞 JSON 與超量 body；GET／DELETE 拒絕 body', async t => {
  const f = await fixture(t), proxy = await f.start();
  assert.equal((await raw(f.origin, PASSWORD_PATH, 'POST', { ...f.sdkHeaders, 'Content-Type': 'text/plain' }, '{}')).status, 415);
  for (const value of [null, [], { unexpectedProxyTarget: 'https://attacker.invalid' }]) assert.equal((await f.sdk(PASSWORD_PATH, 'POST', value)).status, 400);
  assert.equal((await raw(f.origin, PASSWORD_PATH, 'POST', { ...f.sdkHeaders, 'Content-Type': 'application/json' }, '{')).status, 400);
  assert.equal((await f.sdk(PASSWORD_PATH, 'POST', { password: 'x'.repeat(9000) })).status, 413);
  for (const method of ['GET', 'DELETE']) assert.equal((await raw(f.origin, COOKIE_PATH, method, { ...f.sdkHeaders, 'Content-Type': 'application/json', 'Content-Length': '2' }, '{}')).status, 400);
  assert.equal(proxy.calls.length, 0);
});

test('本機清除、TTL 到期與服務關閉皆清除 proxy', async t => {
  const clear = await fixture(t), clearProxy = await clear.start();
  assert.equal((await clear.control('/api/clear')).status, 200);
  assert.equal(clearProxy.clears, 1); assert.equal((await clear.sdk()).status, 401);
  let now = Date.now();
  const expired = await fixture(t, { clock: () => now, ttl: 1000 }), expiredProxy = await expired.start();
  now += 1001;
  assert.equal((await expired.sdk()).status, 401); assert.equal(expiredProxy.clears, 1);
  const closed = await fixture(t), closedProxy = await closed.start();
  await closed.close(); assert.equal(closedProxy.clears, 1);
});

test('延遲 SDK body 在 clear／stop 後不得轉送，重新開始不得接收上一輪請求', async t => {
  for (const mode of ['clear', 'restart'] as const) {
    const f = await fixture(t), oldProxy = await f.start(), pending = await f.delayedSdk();
    const stopped = await f.control(mode === 'clear' ? '/api/clear' : '/api/sdk-stop');
    assert.equal(stopped.status, 200); await stopped.json();
    const newProxy = mode === 'restart' ? await f.start() : undefined;
    const reply = await pending.finish(syntheticLogin);
    assert.equal(reply.status, 401); assert.equal(oldProxy.calls.length, 0); assert.equal(newProxy?.calls.length ?? 0, 0);
  }
});

test('body 傳送期間 TTL 到期不得轉送 SDK 登入', async t => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now, ttl: 1000 }), proxy = await f.start(), pending = await f.delayedSdk();
  now += 1001;
  assert.equal((await pending.finish(syntheticLogin)).status, 401); assert.equal(proxy.calls.length, 0);
});

test('在途 SDK 回應在 clear／重新開始／TTL／登入輪換後不可洩出或復活', async t => {
  for (const mode of ['clear', 'restart', 'ttl', 'rotation'] as const) {
    let now = Date.now();
    const f = await fixture(t, { clock: () => now, ttl: 1000 }), proxy = await f.start();
    let release!: () => void;
    proxy.pending = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const entered = new Promise<void>(resolve => { proxy.onForward = resolve; });
    const pending = f.sdk(); await entered;
    let currentProxy: FakeProxy | undefined;
    if (mode === 'ttl') now += 1001;
    else if (mode === 'rotation') {
      const login = await f.control('/api/login', { code: 'synthetic-code' });
      assert.equal(login.status, 200);
      const state = await login.json() as { csrf: string };
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await f.control('/api/sdk-start', {}, { Cookie: cookie, 'X-CSRF-Token': state.csrf })).status, 409);
    } else {
      assert.equal((await f.control(mode === 'clear' ? '/api/clear' : '/api/sdk-stop')).status, 200);
      if (mode === 'restart') currentProxy = await f.start();
    }
    release();
    const reply = await pending;
    assert.equal(reply.status, 401); assert.doesNotMatch(reply.text, /synthetic-response/);
    if (currentProxy) { assert.equal(currentProxy.clears, 0); assert.equal((await f.sdk()).status, 200); }
  }
});

test('不同本機 session 的 proxy 與控制用 CSRF 相互隔離', async t => {
  const f = await fixture(t), first = await f.start();
  const bootstrap = await fetch(f.origin + '/api/session', { headers: { 'X-Local-Research': '1' } });
  const state = await bootstrap.json() as { csrf: string }, cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await f.sdk(COOKIE_PATH, 'GET', undefined, { Cookie: cookie })).status, 403);
  assert.equal((await f.control('/api/sdk-start', {}, { Cookie: cookie })).status, 403);
  assert.equal((await f.control('/api/sdk-start', {}, { Cookie: cookie, 'X-CSRF-Token': state.csrf })).status, 200);
  const second = f.proxies.at(-1)!; assert.notEqual(second, first);
  assert.equal((await f.sdk()).status, 200);
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 0);
  assert.equal((await f.sdk(COOKIE_PATH, 'GET', undefined, { Cookie: cookie })).status, 200);
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 1);
});

test('SDK 代理例外不回顯合成秘密；密碼登入有獨立次數限制', async t => {
  const f = await fixture(t), proxy = await f.start();
  proxy.failure = new Error('SYNTHETIC_SECRET https://attacker.invalid/private');
  const failure = await f.sdk();
  assert.equal(failure.status, 500); assert.doesNotMatch(failure.text, /SYNTHETIC_SECRET|attacker\.invalid/);
  proxy.failure = undefined;
  for (let i = 0; i < 5; i++) assert.equal((await f.sdk(PASSWORD_PATH, 'POST', syntheticLogin)).status, 200);
  assert.equal((await f.sdk(PASSWORD_PATH, 'POST', syntheticLogin)).status, 429);
  assert.equal(proxy.calls.filter(call => call.path === PASSWORD_PATH.slice('/api/sdk'.length)).length, 5);
});

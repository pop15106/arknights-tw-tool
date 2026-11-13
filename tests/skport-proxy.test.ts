import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { SkportLoginProxy, SkportProxyError, type SkportLoginProxyOptions, type SkportProxyInput } from '../scripts/skport-proxy.ts';

const APP_CODE = '6eb76d4e13aa36e6';
const LOGIN = '/account/user/auth/v1/token_by_email_password';
const BASIC = '/account/user/info/v1/basic';
const GRANT = '/account/user/oauth2/v2/grant';
const STORE = '/web/cookie_store/account_token';
type Call = { url: string; init: RequestInit; headers: Record<string, string> };
function reply(data: unknown = { status: 0, data: { token: 'synthetic-token' } }, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'set-cookie': 'DO_NOT_FORWARD=synthetic; Secure; HttpOnly' } });
}
function setup(handler: (call: Call) => Response | Promise<Response> = () => reply(), options: Omit<SkportLoginProxyOptions, 'fetch'> = {}) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { proxy: new SkportLoginProxy({ fetch: fetcher, ...options }), calls };
}
function login(extra: Partial<SkportProxyInput> = {}): SkportProxyInput {
  return { path: LOGIN, method: 'POST', headers: { 'content-type': 'application/json', 'x-appcode': APP_CODE, 'x-language': 'zh-tw' }, body: { email: 'synthetic@example.invalid', password: 'synthetic-password' }, ...extra };
}
function errorCode(code: string) { return (error: unknown) => error instanceof SkportProxyError && error.code === code; }
function store(method = 'GET', body?: unknown): SkportProxyInput { return { path: STORE, method, headers: {}, ...(body === undefined ? {} : { body }) }; }

test('只轉送三個固定 account 路由，使用實際 query/body，Cookie/Origin/Referer 不外送', async () => {
  const { proxy, calls } = setup();
  const result = await proxy.forward(login({ headers: {
    'content-type': 'application/json; charset=utf-8', 'x-appcode': APP_CODE, 'x-language': 'zh-tw',
    'X-DeviceId': 'synthetic-device', 'X-DeviceModel': 'Chrome', 'X-DeviceType': '7', 'X-OSVer': 'Windows',
    Cookie: 'LOCAL_SESSION_SECRET', Origin: 'http://127.0.0.1:5187', Referer: 'http://127.0.0.1:5187/skport',
    Authorization: 'DO_NOT_SEND', Host: 'untrusted.invalid', 'X-Forwarded-For': 'DO_NOT_SEND',
  } }));
  assert.deepEqual(result, { status: 200, data: { status: 0, data: { token: 'synthetic-token' } } });
  assert.deepEqual(Object.keys(result), ['status', 'data']);
  assert.equal(calls[0].url, 'https://as.gryphline.com/user/auth/v1/token_by_email_password');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { email: 'synthetic@example.invalid', password: 'synthetic-password' });
  await proxy.forward({ path: BASIC + '?token=' + encodeURIComponent('synthetic+/=&?token'), method: 'GET', headers: {} });
  assert.equal(new URL(calls[1].url).searchParams.get('token'), 'synthetic+/=&?token');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[1].headers['content-type'], undefined);
  await proxy.forward({ path: GRANT, method: 'POST', headers: {}, body: { token: 'synthetic-token', appCode: APP_CODE, type: 0 } });
  assert.equal(calls[2].url, 'https://as.gryphline.com/user/oauth2/v2/grant');
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.headers['x-appcode'], APP_CODE);
    assert.equal(call.headers.accept, 'application/json');
    for (const key of ['cookie', 'origin', 'referer', 'authorization', 'host', 'x-forwarded-for']) assert.equal(call.headers[key], undefined);
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('記憶體 cookie-store 契約、session 隔離、DELETE 不呼叫上游且不永久關閉', async () => {
  const { proxy, calls } = setup();
  const other = setup();
  assert.deepEqual(await proxy.forward(store()), { status: 200, data: { code: 0, data: { content: null } } });
  assert.deepEqual(await proxy.forward(store('POST', { content: 'synthetic-store-token' })), { status: 200, data: { code: 0, data: { content: null } } });
  const read = await proxy.forward(store());
  assert.deepEqual(read.data, { code: 0, data: { content: 'synthetic-store-token' } });
  (read.data as { data: { content: string } }).data.content = 'mutated-copy';
  assert.deepEqual((await proxy.forward(store())).data, { code: 0, data: { content: 'synthetic-store-token' } });
  assert.deepEqual((await other.proxy.forward(store())).data, { code: 0, data: { content: null } });
  await proxy.forward(store('DELETE'));
  assert.deepEqual((await proxy.forward(store())).data, { code: 0, data: { content: null } });
  await proxy.forward(store('POST', { content: 'next-token' }));
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(proxy), '{}');
  assert.doesNotMatch(inspect(proxy), /synthetic-store-token|next-token/);
});

test('路由、method、query 與 body schema 拒絕不受限代理及額外帳號操作', async () => {
  const invalid: SkportProxyInput[] = [
    login({ path: 'https://evil.invalid/' }), login({ path: '//evil.invalid/' }),
    login({ path: '/account/user/auth/v1/../v1/token_by_email_password' }), login({ path: '/account/user/auth/v1/%74oken_by_email_password' }),
    login({ path: '/account/user/auth/v1/register' }), login({ path: '/account/user/info/v1/update_agreement_version' }),
    login({ path: LOGIN + '?token=SECRET' }), login({ path: LOGIN + '#fragment' }), login({ method: 'GET' }),
    login({ body: { email: 'synthetic@example.invalid', password: 'synthetic-password', callback: 'https://evil.invalid' } }),
    login({ body: { email: 'synthetic@example.invalid' } }), login({ body: [] }), login({ body: null }),
    login({ body: { email: 'synthetic@example.invalid', password: '' } }),
    login({ body: { email: 'synthetic@example.invalid', password: 'x'.repeat(129) } }),
    { path: BASIC, method: 'GET', headers: {} },
    { path: BASIC + '?token=x&token=y', method: 'GET', headers: {} },
    { path: BASIC + '?token=x&uid=y', method: 'GET', headers: {} },
    { path: BASIC + '?token=x', method: 'GET', headers: {}, body: { token: 'x' } },
    { path: GRANT, method: 'POST', headers: {}, body: { token: 'x', appCode: 'other-app', type: 0 } },
    { path: GRANT, method: 'POST', headers: {}, body: { token: 'x', appCode: APP_CODE, type: 1 } },
    store('PUT'), store('POST', { content: 'token', extra: 1 }), store('POST', { content: null }),
    { ...store(), path: STORE + '?key=another' }, store('DELETE', {}),
    login({ headers: { 'content-type': 'text/plain' } }), login({ headers: { 'x-appcode': 'other-app' } }),
    login({ headers: { 'x-language': 'zh-tw\r\nInjected: secret' } }),
    login({ headers: { 'X-Language': 'zh-tw', 'x-language': 'en-us' } }),
  ];
  const { proxy, calls } = setup();
  for (const input of invalid) await assert.rejects(proxy.forward(input), error => error instanceof SkportProxyError && error.status >= 400 && error.status < 500);
  assert.equal(calls.length, 0);
});

test('保留 SDK 的 bounded captcha map；拒絕額外結構、特殊屬性與超量 request', async () => {
  const { proxy, calls } = setup();
  const challenge = { challenge: 'synthetic-challenge', lot_number: 'synthetic-lot', captcha_output: 'synthetic-result' };
  await proxy.forward(login({ body: { email: 'synthetic@example.invalid', password: 'synthetic-password', captcha: challenge } }));
  assert.deepEqual(JSON.parse(calls[0].init.body as string).captcha, challenge);
  for (const value of [null, [], {}, { nested: {} }, { constructor: 'bad' }, { key: '\n' }]) {
    await assert.rejects(proxy.forward(login({ body: { email: 'synthetic@example.invalid', password: 'synthetic-password', captcha: value } })), errorCode('invalid_request'));
  }
  const large = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`field_${i}`, 'x'.repeat(8192)]));
  await assert.rejects(proxy.forward(login({ body: { email: 'synthetic@example.invalid', password: 'synthetic-password', captcha: large } })), errorCode('request_too_large'));
  assert.equal(calls.length, 1);
});

test('合法官方 JSON envelope 保留業務狀態與 HTTP status，絕不回傳上游 headers', async () => {
  const { proxy } = setup(() => reply({ status: 3, msg: 'synthetic-expired', data: null }, 401));
  assert.deepEqual(await proxy.forward(login()), { status: 401, data: { status: 3, msg: 'synthetic-expired', data: null } });
});

test('非 2xx 的 message/msg JSON 不需要業務 status，保留原 HTTP 失敗', async () => {
  for (const [status, data] of [
    [400, { message: 'synthetic invalid request' }],
    [503, { msg: 'synthetic unavailable' }],
    [400, { status: 0, data: null }],
  ] as const) {
    const { proxy } = setup(() => reply(data, status));
    const result = await proxy.forward({ path: BASIC + '?token=synthetic-invalid', method: 'GET', headers: {} });
    assert.deepEqual(result, { status, data });
    assert.equal(Object.hasOwn(result, 'headers'), false);
  }
  for (const [status, data] of [[200, { message: 'not a success envelope' }], [400, { error: 'not an SDK error envelope' }]] as const) {
    const { proxy } = setup(() => reply(data, status));
    await assert.rejects(proxy.forward(login()), errorCode('invalid_response'));
  }
});

test('HTML、redirect、非 envelope、壞 JSON/UTF-8 皆是安全固定錯誤', async () => {
  const responses = [
    () => new Response('<html>SECRET_PASSWORD</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('SECRET_PASSWORD', { status: 302, headers: { location: 'https://evil.invalid/SECRET' } }),
    () => reply({ code: 0, secret: 'SECRET_PASSWORD' }), () => reply([]),
    () => new Response('SECRET_PASSWORD', { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([255, 255]), { headers: { 'content-type': 'application/json' } }),
    () => { const response = reply(); Object.defineProperty(response, 'url', { value: 'https://evil.invalid/SECRET' }); return response; },
  ];
  for (const response of responses) {
    const { proxy } = setup(response);
    await assert.rejects(proxy.forward(login()), error => {
      assert.ok(error instanceof SkportProxyError);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /SECRET|evil\.invalid/);
      return true;
    });
  }
});

test('transport 原始錯誤與偽裝成 SkportProxyError 的訊息都不洩漏憑證', async () => {
  for (const failure of [new Error('SECRET_EMAIL SECRET_PASSWORD SECRET_TOKEN'), Object.assign(new SkportProxyError('upstream_network'), { message: 'SECRET_TOKEN', cause: 'SECRET_PASSWORD' })]) {
    const { proxy } = setup(() => { throw failure; });
    await assert.rejects(proxy.forward(login()), error => {
      assert.ok(error instanceof SkportProxyError);
      assert.equal(error.code, 'upstream_network');
      assert.doesNotMatch(String(error) + JSON.stringify(error), /SECRET/);
      assert.equal((error as Error & { cause?: unknown }).cause, undefined);
      return true;
    });
  }
});

test('response 限額涵蓋宣告大小與實際串流，header 早退會取消 body', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const { proxy, calls } = setup(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2000))); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '2000' } : {}) } }), { maxResponseBytes: 128 });
    await assert.rejects(proxy.forward(login()), errorCode('response_too_large'));
    assert.equal(cancelled, true);
    assert.equal(calls[0].init.signal!.aborted, true);
  }
  let cancelled = false;
  const { proxy } = setup(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(proxy.forward(login()), errorCode('invalid_response'));
  assert.equal(cancelled, true);
});

test('fetch 與 body stalled 都受逾時限制，舊 fetch 晚到仍取消 body', async () => {
  let release: ((value: Response) => void) | undefined;
  const { proxy } = setup(() => new Promise<Response>(resolve => { release = resolve; }), { timeoutMs: 10 });
  await assert.rejects(proxy.forward(login()), errorCode('upstream_timeout'));
  let cancelled = false;
  release!(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  const stalled = setup(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); } }), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 10 });
  await assert.rejects(stalled.proxy.forward(login()), errorCode('upstream_timeout'));
});

test('clear 永久關閉 instance、中止在途請求，晚回應與 store 操作不復活 session', async () => {
  let release: ((value: Response) => void) | undefined;
  const { proxy, calls } = setup(() => new Promise<Response>(resolve => { release = resolve; }));
  await proxy.forward(store('POST', { content: 'PRIVATE_TOKEN' }));
  const pending = proxy.forward(login());
  const rejected = assert.rejects(pending, errorCode('session_closed'));
  proxy.clear();
  release!(reply({ status: 0, data: { token: 'LATE_TOKEN' } }));
  await rejected;
  assert.equal(calls[0].init.signal!.aborted, true);
  for (const input of [store(), store('POST', { content: 'NEW_TOKEN' }), login()]) await assert.rejects(proxy.forward(input), errorCode('session_closed'));
  assert.doesNotMatch(inspect(proxy) + JSON.stringify(proxy), /PRIVATE_TOKEN|LATE_TOKEN|NEW_TOKEN/);
  const next = setup();
  assert.deepEqual((await next.proxy.forward(store())).data, { code: 0, data: { content: null } });
  const writing = next.proxy.forward(store('POST', { content: 'PENDING_TOKEN' }));
  next.proxy.clear();
  await assert.rejects(writing, errorCode('session_closed'));
});

test('建構參數有效範圍固定，無效設定不啟動 transport', () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 60001 }, { maxResponseBytes: 127 }, { maxResponseBytes: 4 * 1024 * 1024 + 1 }]) assert.throws(() => new SkportLoginProxy(options), errorCode('invalid_configuration'));
});

test('每個 instance 至多四個上游在途請求，完成後才重新開放容量', async () => {
  const releases: ((value: Response) => void)[] = [];
  const { proxy, calls } = setup(() => new Promise<Response>(resolve => { releases.push(resolve); }));
  const pending = Array.from({ length: 4 }, () => proxy.forward(login()));
  await assert.rejects(proxy.forward(login()), errorCode('upstream_busy'));
  assert.equal(calls.length, 4);
  assert.deepEqual((await proxy.forward(store())).data, { code: 0, data: { content: null } });
  for (const release of releases) release(reply());
  await Promise.all(pending);
  const next = proxy.forward(login());
  assert.equal(calls.length, 5);
  releases[4](reply());
  await next;
});

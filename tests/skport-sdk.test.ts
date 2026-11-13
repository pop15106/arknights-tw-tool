import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeWithOfficialSdk, clearOfficialSdkSession } from '../src/skport/sdk.ts';

type Sdk = NonNullable<Window['GL_WEB_SDK']>;
type AuthCallback = Parameters<Sdk['user']['auth']>[1];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}
function fakeSdk() {
  let account = '', web = '';
  const authEntered = deferred<void>(), clearEntered = deferred<void>();
  const state = { authCalls: 0, clearCalls: 0, callback: undefined as AuthCallback | undefined, clear: () => Promise.resolve() as Promise<unknown> | void };
  const sdk: Sdk = {
    hostConfig: {
      account: { setHost(value) { account = value; }, getHost() { return account; } },
      webApi: { setHost(value) { web = value; }, getHost() { return web; } },
    },
    user: {
      API: { clearToken() { state.clearCalls++; clearEntered.resolve(); return state.clear(); } },
      auth(options, callback) {
        assert.deepEqual(options, { oauth: { appCode: '6eb76d4e13aa36e6', grantType: 0 }, thirdPartyInfo: false });
        state.authCalls++; state.callback = callback; authEntered.resolve();
      },
    },
  };
  return { sdk, state, authEntered: authEntered.promise, clearEntered: clearEntered.promise };
}
function browser(t: TestContext, sdk?: Sdk) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const scripts: Array<{ src: string; referrerPolicy: string; onerror?: () => void }> = [];
  const appended = deferred<void>();
  let timerId = 0;
  const view = {
    location: { origin: 'http://127.0.0.1:5187' }, GL_WEB_SDK: sdk,
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  } as unknown as Window;
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(view, key, { get() { throw new Error('Mock storage must not be read'); } });
  const documentMock = {
    createElement(tag: string) { assert.equal(tag, 'script'); return { src: '', referrerPolicy: '' }; },
    head: { appendChild(script: typeof scripts[number]) {
      assert.deepEqual(view._GL_ACCOUNT_SDK_INIT_OPTIONS, { language: 'zh-tw', devOptions: { accountServerHost: 'http://127.0.0.1:5187/api/sdk/account', webApiServerHost: 'http://127.0.0.1:5187/api/sdk/web' } });
      scripts.push(script); appended.resolve();
    } },
  };
  Object.defineProperty(documentMock, 'cookie', { get() { throw new Error('Mock Cookie must not be read'); } });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: view });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: documentMock });
  t.after(() => {
    timers.clear();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  });
  return { view, scripts, timers, appended: appended.promise };
}
const cancelled = (error: unknown) => error instanceof Error && /取消|abort/iu.test(error.message + error.name);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('SDK 載入前設定本機 host；載入中取消後即使 script 晚到也不開啟 auth', async t => {
  const { sdk, state } = fakeSdk();
  const page = browser(t);
  const controller = new AbortController();
  let exchanges = 0;
  const operation = authorizeWithOfficialSdk(async () => { exchanges++; }, controller.signal);
  const rejected = assert.rejects(operation, cancelled);
  await page.appended;
  assert.equal(page.scripts.length, 1);
  assert.equal(page.scripts[0].src, 'https://web-api.gryphline.com/static/gl_web_sdk/sdk.entry.js');
  controller.abort(); await rejected;
  page.view.GL_WEB_SDK = sdk;
  for (const callback of page.view._GL_WEB_SDK_CALLBACK_QUEUE ?? []) callback();
  await flush();
  assert.equal(state.authCalls, 0); assert.equal(exchanges, 0);
});

test('SDK clearToken 等待期間取消，不會在晚完成後開啟 auth', async t => {
  const { sdk, state, clearEntered } = fakeSdk();
  const clearing = deferred<void>(); state.clear = () => clearing.promise;
  browser(t, sdk);
  const controller = new AbortController();
  const operation = authorizeWithOfficialSdk(async () => { assert.fail('No code exchange after abort'); }, controller.signal);
  const rejected = assert.rejects(operation, cancelled);
  await clearEntered; controller.abort(); await rejected;
  clearing.resolve(); await flush();
  assert.equal(state.authCalls, 0);
});

test('auth 開始後取消會拒絕，晚到 callback 不得交換 code', async t => {
  const { sdk, state, authEntered } = fakeSdk(); browser(t, sdk);
  const controller = new AbortController();
  const codes: string[] = [];
  const operation = authorizeWithOfficialSdk(async code => { codes.push(code); }, controller.signal);
  const rejected = assert.rejects(operation, cancelled);
  await authEntered; controller.abort(); await rejected;
  state.callback!(0, { oauthInfo: { code: 'synthetic-late-code' } });
  await flush(); assert.deepEqual(codes, []);
});

test('正常 callback 只交換 code 一次並等待交換完成，不讀取完整 SDK 結果', async t => {
  const { sdk, state, authEntered } = fakeSdk(); browser(t, sdk);
  const exchange = deferred<void>(), controller = new AbortController(), codes: string[] = [];
  const operation = authorizeWithOfficialSdk(async code => { codes.push(code); await exchange.promise; }, controller.signal);
  await authEntered;
  const result = { oauthInfo: { code: 'synthetic-code' } };
  Object.defineProperty(result, 'accountInfo', { enumerable: true, get() { throw new Error('Full SDK result must not be inspected'); } });
  Object.defineProperty(result.oauthInfo, 'token', { enumerable: true, get() { throw new Error('Unneeded SDK token must not be inspected'); } });
  state.callback!(0, result); state.callback!(0, { oauthInfo: { code: 'synthetic-duplicate-code' } });
  let completed = false; void operation.then(() => { completed = true; });
  await flush(); assert.deepEqual(codes, ['synthetic-code']); assert.equal(completed, false);
  exchange.resolve(); assert.equal(await operation, 'connected');
  assert.equal(sdk.hostConfig.account.getHost(), 'http://127.0.0.1:5187/api/sdk/account');
  assert.equal(sdk.hostConfig.webApi.getHost(), 'http://127.0.0.1:5187/api/sdk/web');
});

test('官方取消 callback 回傳 cancelled，沒有 code 交換', async t => {
  const { sdk, state, authEntered } = fakeSdk(); browser(t, sdk);
  const controller = new AbortController();
  const operation = authorizeWithOfficialSdk(async () => { assert.fail('Cancelled login must not exchange'); }, controller.signal);
  await authEntered; state.callback!(2);
  assert.equal(await operation, 'cancelled');
});

test('已取消的登入不呼叫 SDK auth 或 clearToken', async t => {
  const { sdk, state } = fakeSdk(); browser(t, sdk);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(authorizeWithOfficialSdk(async () => { assert.fail('No exchange'); }, controller.signal), cancelled);
  assert.equal(state.authCalls, 0); assert.equal(state.clearCalls, 0);
});

test('清除 SDK 的同步與非同步錯誤不向呼叫者或 console 洩漏', async t => {
  const { sdk, state } = fakeSdk(); browser(t, sdk);
  const log: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { log.push(args); });
  t.mock.method(console, 'error', (...args: unknown[]) => { log.push(args); });
  state.clear = () => { throw new Error('SYNTHETIC_PRIVATE_ERROR'); };
  await assert.doesNotReject(clearOfficialSdkSession());
  state.clear = () => Promise.reject(new Error('SYNTHETIC_PRIVATE_REJECTION'));
  await assert.doesNotReject(clearOfficialSdkSession());
  assert.equal(state.clearCalls, 2); assert.deepEqual(log, []);
});

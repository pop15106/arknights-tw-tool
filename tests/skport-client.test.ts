import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { SkportClient, SkportClientError, type SkportClientOptions } from '../scripts/skport-client.ts';

const NOW = 1_794_546_000_000;
type Call = { url: URL; init: RequestInit; headers: Record<string, string> };
type Handler = (call: Call, index: number) => Response | Promise<Response>;
function response(data: unknown, code = 0, status = 200, timestamp: unknown = 1_794_546_000): Response {
  return new Response(JSON.stringify({ code, data, timestamp }), { status, headers: { 'content-type': 'application/json' } });
}
function binding(uid = 'synthetic-game', extra: Record<string, unknown> = {}) {
  return { list: [{ appCode: 'endfield', bindingList: [{ uid: 'foreign-game', nickname: '其他遊戲' }] }, { appCode: 'arknights', bindingList: [{ uid, nickName: '合成角色', channelName: '合成渠道', ...extra }] }] };
}
function setup(handler?: Handler, options: Omit<SkportClientOptions, 'fetch' | 'clock'> = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), init, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    calls.push(call);
    if (handler) return handler(call, calls.length);
    switch (call.url.pathname) {
      case '/web/v1/user/auth/generate_cred_by_code': return response({ cred: 'synthetic-cred', token: 'synthetic-sign-key' });
      case '/web/v2/user': return response({ user: { basicUser: { id: 'synthetic-user', email: 'PRIVATE_EMAIL' } } });
      case '/api/v1/game/player/binding': return response(binding());
      case '/api/v1/game/player/info': return response({ chars: [{ charId: 'char_test', level: 1 }] });
      default: throw new Error('unexpected route');
    }
  }) as typeof globalThis.fetch;
  return { client: new SkportClient({ fetch: fetcher, clock: () => NOW, ...options }), calls };
}
function authReply(call: Call): Response | undefined {
  if (call.url.pathname.endsWith('generate_cred_by_code')) return response({ cred: 'synthetic-cred', token: 'synthetic-sign-key' });
  if (call.url.pathname === '/web/v2/user') return response({ user: { basicUser: { id: 'synthetic-user' } } });
  if (call.url.pathname.endsWith('/binding')) return response(binding());
}
function errorCode(code: string) { return (error: unknown) => error instanceof SkportClientError && error.code === code; }

test('固定合成簽章向量、主機與路由白名單、禁止重新導向與攜帶 Cookie', async () => {
  const { client, calls } = setup();
  const roles = await client.exchangeCode('synthetic-auth-code');
  assert.equal(calls.length, 3);
  const exchange = calls[0];
  assert.deepEqual(JSON.parse(exchange.init.body as string), { kind: 1, code: 'synthetic-auth-code' });
  assert.equal(exchange.headers.sign, undefined);
  assert.equal(exchange.headers.cred, undefined);
  assert.equal(calls[2].headers.sign, 'c90979c9f91b820b0045ef954f8424de');
  assert.equal(calls[2].url.search, '?uid=synthetic-user');
  assert.equal(roles.length, 1);
  assert.match(roles[0].serverLabel, /服別未驗證/);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://zonai.skport.com');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers['sk-language'], 'zh_Hant');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('角色只屬於本次帳號，公開結果不含 UID；清除或換登入後舊 key 失效', async () => {
  const { client, calls } = setup();
  await assert.rejects(client.readRoster('synthetic-game'), errorCode('not_authenticated'));
  const [role] = await client.exchangeCode('first-code');
  assert.deepEqual(Object.keys(role).sort(), ['key', 'label', 'serverLabel']);
  assert.doesNotMatch(JSON.stringify(role), /synthetic-game|synthetic-user|foreign-game/);
  role.label = '改動呼叫者副本';
  assert.equal(client.getBindings()[0].label, '合成角色');
  await assert.rejects(client.readRoster('synthetic-game'), errorCode('invalid_role'));
  await assert.rejects(client.readRoster('https://not-allowed.invalid/path'), errorCode('invalid_role'));
  assert.equal(calls.length, 3);
  await client.readRoster(role.key);
  assert.equal(calls[3].url.search, '?uid=synthetic-game&userId=synthetic-user');
  assert.equal(calls[3].headers['x-transformed'], 'base64');
  const [nextRole] = await client.exchangeCode('second-code');
  assert.notEqual(nextRole.key, role.key);
  await assert.rejects(client.readRoster(role.key), errorCode('invalid_role'));
  client.clear();
  assert.deepEqual(client.getBindings(), []);
  assert.equal(JSON.stringify(client), '{}');
  await assert.rejects(client.readRoster(nextRole.key), errorCode('not_authenticated'));
});

test('JSON/base64 只投影必要 chars，保留零/null，剔除 PII 與全部非白名單欄位', async () => {
  const raw = { chars: [{ charId: 'char_test', level: 0, evolvePhase: null, favorPercent: 100, mainSkillLvl: 7, potentialRank: 0, defaultSkillId: '', defaultEquipId: null, skills: [{ id: 'skill_test', specializeLevel: 0, credential: 'PRIVATE_CHILD' }], equip: [{ id: 'module_test', level: 3, locked: false, token: 'PRIVATE_MODULE' }], uid: 'PRIVATE_UID', email: 'PRIVATE_EMAIL', gainTime: 123, raw: 'PRIVATE_RAW' }], assistChars: [{ charId: 'assist_only' }], token: 'PRIVATE_TOKEN', charInfoMap: { x: { name: 'PRIVATE_NAME' } } };
  for (const encoded of [false, true]) {
    const { client } = setup(call => authReply(call) ?? response(encoded ? { content: Buffer.from(JSON.stringify(raw)).toString('base64') } : raw));
    const [role] = await client.exchangeCode('code');
    const result = await client.readRoster(role.key);
    assert.equal(result.retrievedAt, new Date(NOW).toISOString());
    assert.equal(result.serverUnverified, true);
    assert.equal(result.summary.count, 1);
    assert.equal(result.document.format, 'skport-offline-research');
    assert.equal(result.document.gameData.data.chars[0].level, 0);
    assert.equal(result.document.gameData.data.chars[0].evolvePhase, null);
    assert.deepEqual(result.document.gameData.data.chars[0].equip, [{ id: 'module_test', level: 3, locked: false }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|assist_only|charInfoMap|gainTime|cred/);
  }
});

test('沒有本作角色回傳空列表；重複或壞 binding 拒絕，禁止推定繁中服', async () => {
  const { client } = setup(call => call.url.pathname.endsWith('/binding') ? response({ list: [{ appCode: 'endfield', bindingList: [] }] }) : authReply(call)!);
  assert.deepEqual(await client.exchangeCode('code'), []);
  await assert.rejects(client.readRoster('foreign-game'), errorCode('invalid_role'));
  for (const bad of [{ list: {} }, { list: [{ appCode: 'arknights', bindingList: [{ uid: 'x' }, { uid: 'x' }] }] }, { list: [{ appCode: 'arknights', bindingList: [{ uid: 'bad\r\nheader' }] }] }]) {
    const { client: invalid } = setup(call => call.url.pathname.endsWith('/binding') ? response(bad) : authReply(call)!);
    await assert.rejects(invalid.exchangeCode('code'), errorCode('invalid_response'));
    assert.deepEqual(invalid.getBindings(), []);
  }
});

test('10000 只更新簽章 key 一次，再以新 key 重試；10003 只校時重試一次', async () => {
  for (const failureCode of [10000, 10003]) {
    let rosterCalls = 0;
    const { client, calls } = setup(call => {
      const auth = authReply(call); if (auth) return auth;
      if (call.url.pathname.endsWith('/refresh')) return response({ token: 'new-synthetic-key' }, 0, 200, 1_794_546_010);
      if (++rosterCalls === 1) return response(null, failureCode, 401, 1_794_546_010);
      return response({ chars: [] });
    });
    const [role] = await client.exchangeCode('code');
    await client.readRoster(role.key);
    assert.equal(rosterCalls, 2);
    assert.equal(calls.filter(call => call.url.pathname.endsWith('/refresh')).length, failureCode === 10000 ? 1 : 0);
    const final = calls.at(-1)!;
    assert.equal(final.headers.timestamp, '1794546010');
    const headers = { platform: '3', timestamp: final.headers.timestamp, dId: '', vName: '1.0.0' };
    const key = failureCode === 10000 ? 'new-synthetic-key' : 'synthetic-sign-key';
    const signed = final.url.pathname + final.url.search.slice(1) + final.headers.timestamp + JSON.stringify(headers);
    const expected = createHash('md5').update(createHmac('sha256', key).update(signed).digest('hex')).digest('hex');
    assert.equal(final.headers.sign, expected);
  }
});

test('憑證過期、重試仍失敗或 refresh 過期皆清除登入，不無限重試', async () => {
  for (const kind of ['expired', 'retry', 'refresh'] as const) {
    let rosterCount = 0;
    const { client, calls } = setup(call => {
      const auth = authReply(call); if (auth) return auth;
      if (call.url.pathname.endsWith('/refresh')) return response(null, 10002, 401);
      rosterCount++;
      return response(null, kind === 'expired' ? 10002 : kind === 'refresh' ? 10000 : 10003, 401);
    });
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), errorCode('credential_expired'));
    assert.ok(rosterCount <= 2);
    assert.ok(calls.length <= 5);
    assert.deepEqual(client.getBindings(), []);
    await assert.rejects(client.readRoster(role.key), errorCode('not_authenticated'));
  }
});

test('上游失敗、raw message、重導向與 HTTP 錯誤皆不洩漏秘密或 URL', async () => {
  for (const action of [
    () => { throw new Error('SECRET_CODE SECRET_CRED https://private.invalid/SECRET'); },
    () => new Response(JSON.stringify({ code: 9, message: 'SECRET_CODE', data: 'SECRET_CRED' }), { status: 200 }),
    () => new Response('SECRET_CODE', { status: 302, headers: { location: 'https://private.invalid/SECRET' } }),
    () => new Response('SECRET_CODE', { status: 500 }),
    () => new Response('SECRET_CODE', { status: 200 }),
  ]) {
    const { client } = setup(() => action());
    await assert.rejects(client.exchangeCode('SECRET_CODE'), error => {
      assert.ok(error instanceof SkportClientError);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /SECRET|private\.invalid/);
      return true;
    });
    assert.deepEqual(client.getBindings(), []);
  }
  const { client, calls } = setup();
  await assert.rejects(client.exchangeCode('bad\r\nheader'), errorCode('invalid_code'));
  assert.equal(calls.length, 0);
});

test('回應 Content-Length、串流實際大小與逾時有界', async () => {
  for (const includeLength of [false, true]) {
    const { client } = setup(() => new Response('x'.repeat(2000), { headers: includeLength ? { 'content-length': '2000' } : {} }), { maxResponseBytes: 128 });
    await assert.rejects(client.exchangeCode('code'), errorCode('response_too_large'));
  }
  const { client } = setup(() => new Promise<Response>(() => {}), { timeoutMs: 10 });
  await assert.rejects(client.exchangeCode('code'), errorCode('upstream_timeout'));
  const stalled = setup(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })), { timeoutMs: 10 });
  await assert.rejects(stalled.client.exchangeCode('code'), errorCode('upstream_timeout'));
});

test('在讀取 body 前拒絕 HTTP 或 Content-Length 時也中止下載', async () => {
  for (const mode of ['http', 'size'] as const) {
    let cancelled = false;
    const { client, calls } = setup(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
      cancel() { cancelled = true; },
    }), mode === 'http' ? { status: 503 } : { headers: { 'content-length': '2000' } }), { maxResponseBytes: 128 });
    await assert.rejects(client.exchangeCode('code'), errorCode(mode === 'http' ? 'upstream_http' : 'response_too_large'));
    assert.equal(cancelled, true);
    assert.equal(calls[0].init.signal!.aborted, true);
  }
});

test('壞 JSON/base64/字元型別、只有助戰或超量資料不當作持有庫', async () => {
  const variants = [
    { assistChars: [] }, { chars: {} }, { content: '@@@@' }, { content: Buffer.from('not json').toString('base64') },
    { content: Buffer.from([255, 255]).toString('base64') }, { chars: [{ charId: 'x', level: 'SECRET' }] },
    { chars: [{ charId: 'x' }, { charId: 'x' }] }, { chars: [{ charId: 'x', skills: [{ id: 's' }, { id: 's' }] }] },
    { chars: Array.from({ length: 2001 }, (_, i) => ({ charId: `char_${i}` })) },
  ];
  for (const data of variants) {
    const { client } = setup(call => authReply(call) ?? response(data));
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), errorCode('invalid_response'));
  }
});

test('clear 中止在途請求；舊登入完成不得復活 session 或清掉新登入', async () => {
  let release: ((value: Response) => void) | undefined;
  let first = true;
  const { client } = setup(call => {
    if (first) { first = false; return new Promise<Response>(resolve => { release = resolve; }); }
    return authReply(call)!;
  });
  const pending = client.exchangeCode('first');
  client.clear();
  const rejection = assert.rejects(pending, errorCode('session_changed'));
  const roles = await client.exchangeCode('second');
  release!(response({ cred: 'OLD_SECRET', token: 'OLD_SECRET' }));
  await rejection;
  assert.deepEqual(client.getBindings(), roles);
});

test('建構參數與時鐘錯誤不產生網路請求', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 60001 }, { maxResponseBytes: 1 }, { maxResponseBytes: 17 * 1024 * 1024 }]) assert.throws(() => new SkportClient(options), errorCode('invalid_configuration'));
  const client = new SkportClient({ clock: () => NaN, fetch: (() => { throw new Error('must not call'); }) as typeof globalThis.fetch });
  await assert.rejects(client.exchangeCode('code'), errorCode('invalid_configuration'));
});

test('content 為 null 或空字串時使用原 chars，但仍拒絕缺少或無效的持有清單', async () => {
  for (const content of [null, '']) {
    const { client } = setup(call => authReply(call) ?? response({ content, chars: [{ charId: 'char_test', level: 1 }] }));
    const [role] = await client.exchangeCode('code');
    assert.deepEqual((await client.readRoster(role.key)).document.gameData.data.chars, [{ charId: 'char_test', level: 1 }]);
    for (const data of [{ content }, { content, chars: {} }]) {
      const invalid = setup(call => authReply(call) ?? response(data));
      const [invalidRole] = await invalid.client.exchangeCode('code');
      await assert.rejects(invalid.client.readRoster(invalidRole.key), error => {
        assert.ok(error instanceof SkportClientError);
        assert.equal(error.diagnostic?.field, 'data.chars');
        return true;
      });
    }
  }
});

test('其他 content 型別即使帶有合法 chars 仍嚴格拒絕，非空編碼內容優先驗證', async () => {
  const variants: { content: unknown; actual: string; expected?: string }[] = [
    { content: false, actual: 'boolean' },
    { content: true, actual: 'boolean' },
    { content: 0, actual: 'integer' },
    { content: 1, actual: 'integer' },
    { content: [], actual: 'array' },
    { content: { PRIVATE_KEY: 'PRIVATE_VALUE' }, actual: 'object' },
    { content: ' ', actual: 'string' },
    { content: 'PRIVATE_INVALID_BASE64@@', actual: 'string' },
    { content: Buffer.from('PRIVATE_INVALID_JSON').toString('base64'), actual: 'string', expected: 'UTF-8 JSON' },
  ];
  for (const { content, actual, expected = 'base64 string within limit' } of variants) {
    const { client } = setup(call => authReply(call) ?? response({ content, chars: [{ charId: 'char_test' }] }));
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.equal(error.code, 'invalid_response');
      assert.deepEqual(error.diagnostic, { field: 'data.content', expected, actual });
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
  const { client } = setup(call => authReply(call) ?? response({ content: Buffer.from(JSON.stringify({ chars: [{ charId: 'encoded_char' }] })).toString('base64'), chars: [{ charId: 'plain_char' }] }));
  const [role] = await client.exchangeCode('code');
  assert.deepEqual((await client.readRoster(role.key)).document.gameData.data.chars, [{ charId: 'encoded_char' }]);
});

test('roster 診斷覆蓋資料、幹員、子項、數值與 ID guard，僅保留固定欄位與型別', async () => {
  const scalar = ['level', 'evolvePhase', 'favorPercent', 'mainSkillLvl', 'potentialRank'];
  const variants: { data: unknown; field: string; expected: string; actual: string }[] = [
    { data: null, field: 'data', expected: 'object', actual: 'null' },
    { data: [], field: 'data', expected: 'object', actual: 'array' },
    { data: {}, field: 'data.chars', expected: 'array within limit', actual: 'missing' },
    { data: { chars: {} }, field: 'data.chars', expected: 'array within limit', actual: 'object' },
    { data: { chars: Array(2001).fill(null) }, field: 'data.chars', expected: 'array within limit', actual: 'array' },
    { data: { chars: [null] }, field: 'data.chars[0]', expected: 'object', actual: 'null' },
    { data: { chars: [{}] }, field: 'data.chars[0].charId', expected: 'identifier', actual: 'missing' },
    { data: { chars: [{ charId: 'PRIVATE CHAR' }] }, field: 'data.chars[0].charId', expected: 'identifier', actual: 'string' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR' }, { charId: 'PRIVATE_CHAR' }] }, field: 'data.chars[1].charId', expected: 'unique identifier', actual: 'string' },
    ...scalar.map(key => ({ data: { chars: [{ charId: 'PRIVATE_CHAR', [key]: 'PRIVATE_VALUE' }] }, field: `data.chars[0].${key}`, expected: 'nonnegative integer within limit', actual: 'string' })),
    { data: { chars: [{ charId: 'PRIVATE_CHAR', favorPercent: 12.5 }] }, field: 'data.chars[0].favorPercent', expected: 'nonnegative integer within limit', actual: 'number' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', level: -1 }] }, field: 'data.chars[0].level', expected: 'nonnegative integer within limit', actual: 'integer' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', defaultSkillId: 123 }] }, field: 'data.chars[0].defaultSkillId', expected: 'identifier', actual: 'integer' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', defaultEquipId: { PRIVATE_KEY: true } }] }, field: 'data.chars[0].defaultEquipId', expected: 'identifier', actual: 'object' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', skills: {} }] }, field: 'data.chars[0].skills', expected: 'array within limit', actual: 'object' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', equip: Array(21).fill(null) }] }, field: 'data.chars[0].equip', expected: 'array within limit', actual: 'array' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', skills: [null] }] }, field: 'data.chars[0].skills[0]', expected: 'object', actual: 'null' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', skills: [{}] }] }, field: 'data.chars[0].skills[0].id', expected: 'identifier', actual: 'missing' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', equip: [{ id: 'PRIVATE ID' }] }] }, field: 'data.chars[0].equip[0].id', expected: 'identifier', actual: 'string' },
    ...['skills', 'equip'].map(key => ({ data: { chars: [{ charId: 'PRIVATE_CHAR', [key]: [{ id: 'PRIVATE_ID' }, { id: 'PRIVATE_ID' }] }] }, field: `data.chars[0].${key}[1].id`, expected: 'unique identifier', actual: 'string' })),
    { data: { chars: [{ charId: 'PRIVATE_CHAR', skills: [{ id: 'PRIVATE_SKILL', specializeLevel: 'PRIVATE_VALUE' }] }] }, field: 'data.chars[0].skills[0].specializeLevel', expected: 'nonnegative integer within limit', actual: 'string' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', equip: [{ id: 'PRIVATE_EQUIP', level: 1.5 }] }] }, field: 'data.chars[0].equip[0].level', expected: 'nonnegative integer within limit', actual: 'number' },
    { data: { chars: [{ charId: 'PRIVATE_CHAR', equip: [{ id: 'PRIVATE_EQUIP', locked: 0 }] }] }, field: 'data.chars[0].equip[0].locked', expected: 'boolean', actual: 'integer' },
  ];
  for (const { data, field, expected, actual } of variants) {
    const { client } = setup(call => authReply(call) ?? response(data));
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.stage, 'roster');
      assert.deepEqual(error.diagnostic, { field, expected, actual });
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
});

test('roster 診斷區分 wire JSON/code、base64 與解碼 JSON；不猜測額外 envelope 層級', async () => {
  const variants: { make: () => Response; field: string; expected: string; actual: string }[] = [
    { make: () => new Response('PRIVATE_INVALID_JSON'), field: 'response', expected: 'JSON object', actual: 'string' },
    { make: () => new Response(null), field: 'response', expected: 'JSON object', actual: 'missing' },
    { make: () => new Response('[]'), field: 'response', expected: 'object', actual: 'array' },
    { make: () => new Response(JSON.stringify({ code: 'PRIVATE_CODE' })), field: 'response.code', expected: 'integer', actual: 'string' },
    { make: () => new Response('{}'), field: 'response.code', expected: 'integer', actual: 'missing' },
    { make: () => response({ content: { PRIVATE_KEY: true } }), field: 'data.content', expected: 'base64 string within limit', actual: 'object' },
    { make: () => response({ content: 'PRIVATE_BASE64@@' }), field: 'data.content', expected: 'base64 string within limit', actual: 'string' },
    { make: () => response({ content: Buffer.from('PRIVATE_JSON').toString('base64') }), field: 'data.content', expected: 'UTF-8 JSON', actual: 'string' },
    { make: () => response({ content: Buffer.from([255, 255]).toString('base64') }), field: 'data.content', expected: 'UTF-8 JSON', actual: 'string' },
    { make: () => response({ content: Buffer.from('[]').toString('base64') }), field: 'data.content', expected: 'object', actual: 'array' },
    { make: () => response({ content: Buffer.from('{"code":0,"data":{"chars":[]}}').toString('base64') }), field: 'data.chars', expected: 'array within limit', actual: 'missing' },
  ];
  for (const { make, field, expected, actual } of variants) {
    const { client } = setup(call => authReply(call) ?? make());
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.deepEqual(error.diagnostic, { field, expected, actual });
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
  for (const withLength of [false, true]) {
    const { client } = setup(call => authReply(call) ?? new Response('PRIVATE'.repeat(300), { headers: withLength ? { 'content-length': '2100' } : {} }), { maxResponseBytes: 1024 });
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.equal(error.code, 'response_too_large');
      assert.deepEqual(error.diagnostic, { field: 'response', expected: 'JSON within limit', actual: 'string' });
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
});

test('診斷建構器拒絕自由文字、動態鍵與越界索引，並凍結安全副本', () => {
  const valid = { field: 'data.chars[0].equip[0].locked', expected: 'boolean', actual: 'integer', extra: 'PRIVATE_VALUE' };
  const safe = new SkportClientError('invalid_response', 'roster', valid);
  assert.deepEqual(safe.diagnostic, { field: valid.field, expected: 'boolean', actual: 'integer' });
  assert.equal(Object.isFrozen(safe.diagnostic), true);
  valid.field = 'PRIVATE_FIELD';
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE/);
  for (const candidate of [
    { field: 'data.PRIVATE_KEY', expected: 'object', actual: 'object' },
    { field: 'data.chars[PRIVATE_ID].level', expected: 'integer', actual: 'integer' },
    { field: 'data.chars[2000].level', expected: 'integer', actual: 'integer' },
    { field: 'data.chars[0].skills[20].id', expected: 'identifier', actual: 'string' },
    { field: 'data.chars[0].skills[0].locked', expected: 'boolean', actual: 'integer' },
    { field: 'data', expected: 'PRIVATE_EXPECTED', actual: 'object' },
    { field: 'data', expected: 'object', actual: 'PRIVATE_VALUE' },
  ]) {
    const error = new SkportClientError('invalid_response', 'roster', candidate);
    assert.equal(error.diagnostic, undefined);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
  }
  assert.equal(new SkportClientError('invalid_response', 'exchange', { field: 'data', expected: 'object', actual: 'string' }).diagnostic, undefined);
});

test('只有 identifier 實際空字串會顯示固定 empty string 診斷，其他 ID 仍嚴格驗證', async () => {
  for (const [data, field] of [
    [{ chars: [{ charId: '' }] }, 'data.chars[0].charId'],
    [{ chars: [{ charId: 'char_test', skills: [{ id: '' }] }] }, 'data.chars[0].skills[0].id'],
    [{ chars: [{ charId: 'char_test', equip: [{ id: '' }] }] }, 'data.chars[0].equip[0].id'],
  ] as const) {
    const { client } = setup(call => authReply(call) ?? response(data));
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.deepEqual(error.diagnostic, { field, expected: 'identifier', actual: 'empty string' });
      return true;
    });
  }
  const diagnostic = { field: 'data.chars[0].skills[0].id', expected: 'identifier', actual: 'empty string' };
  assert.deepEqual(new SkportClientError('invalid_response', 'roster', diagnostic).diagnostic, diagnostic);
});

test('技能與預設技能 ID 保留尾端數字括號並可精確匹配', async () => {
  const skills = [
    { id: 'skcom_atk_up[2]', specializeLevel: 0 },
    { id: 'skcom_heal_up[3]', specializeLevel: 1 },
    { id: 'skcom_charge_cost[3]', specializeLevel: 2 },
    { id: 'skill_plain', specializeLevel: 3 },
  ];
  const raw = { chars: [{ charId: 'char_test', defaultSkillId: 'skcom_heal_up[3]', skills }] };
  for (const encoded of [false, true]) {
    const { client } = setup(call => authReply(call) ?? response(encoded ? { content: Buffer.from(JSON.stringify(raw)).toString('base64') } : raw));
    const [role] = await client.exchangeCode('code');
    const result = await client.readRoster(role.key);
    assert.deepEqual(result.document.gameData.data, raw);
    const character = result.document.gameData.data.chars[0];
    assert.equal(character.skills?.find(skill => skill.id === character.defaultSkillId)?.specializeLevel, 1);
    assert.deepEqual(Object.keys(result.summary).sort(), ['count', 'fields']);
  }
  for (const id of ['a'.repeat(200), `${'a'.repeat(197)}[2]`]) {
    const { client } = setup(call => authReply(call) ?? response({ chars: [{ charId: 'char_test', defaultSkillId: id, skills: [{ id }] }] }));
    const [role] = await client.exchangeCode('code');
    const character = (await client.readRoster(role.key)).document.gameData.data.chars[0];
    assert.equal(character.defaultSkillId, id); assert.equal(character.skills?.[0].id, id);
  }
});

test('技能 ID 拒絕 malformed 括號、HTML、空白及超過 200 字元，診斷不含原值', async () => {
  const ids = [
    'skill[', 'skill]', 'skill[]', 'skill[-1]', 'skill[1.5]', 'skill[2][3]', 'skill[2]suffix', '[2]',
    'skill[PRIVATE]', '<script>PRIVATE</script>', 'PRIVATE skill[2]', 'skill\t[2]', 'skill[２]', `${'a'.repeat(198)}[2]`,
  ];
  for (const id of ids) for (const target of ['skill', 'default'] as const) {
    const data = { chars: [{ charId: 'char_test', ...(target === 'skill' ? { skills: [{ id }] } : { defaultSkillId: id }) }] };
    const field = target === 'skill' ? 'data.chars[0].skills[0].id' : 'data.chars[0].defaultSkillId';
    const { client } = setup(call => authReply(call) ?? response(data));
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.equal(error.code, 'invalid_response');
      assert.deepEqual(error.diagnostic, { field, expected: 'identifier', actual: 'string' });
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE|<script>/);
      return true;
    });
  }
});

test('尾端括號語法僅允許技能，幹員與模組 ID 的限制不變', async () => {
  for (const [data, field] of [
    [{ chars: [{ charId: 'char_test[2]' }] }, 'data.chars[0].charId'],
    [{ chars: [{ charId: 'char_test', defaultEquipId: 'module_test[2]' }] }, 'data.chars[0].defaultEquipId'],
    [{ chars: [{ charId: 'char_test', equip: [{ id: 'module_test[2]' }] }] }, 'data.chars[0].equip[0].id'],
  ] as const) {
    const { client } = setup(call => authReply(call) ?? response(data));
    const [role] = await client.exchangeCode('code');
    await assert.rejects(client.readRoster(role.key), error => {
      assert.ok(error instanceof SkportClientError);
      assert.deepEqual(error.diagnostic, { field, expected: 'identifier', actual: 'string' });
      return true;
    });
  }
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startGameDataServer } from '../scripts/game-data-server.ts';
import type { Dataset } from '../src/domain/model.ts';

const dataset: Dataset = {
  metadata: { id: 'synthetic-public-data', version: 'synthetic-v1', product: 'arknights', server: 'tw', namespace: 'personal', validFrom: '2026-11-13T00:00:00.000Z', acquiredAt: '2026-11-13T00:00:00.000Z', source: 'synthetic fixture', licenseStatus: 'self-authored', checksum: 'synthetic-checksum' },
  operators: [{ id: 'char_synthetic', displayName: '合成幹員', aliases: [], rarity: 3, profession: '先鋒', branch: '合成分支', faction: '合成陣營', skills: [], modules: [], availability: 'unknown' }],
};
const snapshot = {
  dataset,
  stages: [{ id: 'stage-a', name: '合成甲' }, { id: 'stage-b', name: '合成乙' }, { id: 'stage-c', name: '合成乙二' }],
  events: [{ id: 'event-a', name: '活動甲' }, { id: 'event-b', name: '活動乙' }],
  status: { version: 'synthetic-v1', sourceUpdatedAt: '2026-11-12T00:00:00.000Z', syncedAt: '2026-11-13T00:00:00.000Z', counts: { operators: 1, stages: 3, events: 2 }, sourceKind: 'public-mirror' as const, sourceUrl: 'https://example.test/public-data' },
};
type Snapshot = typeof snapshot;
async function fixture(t: TestContext, options: { load?: () => Promise<Snapshot | null>; sync?: () => Promise<Snapshot> } = {}) {
  let syncCalls = 0;
  const service = await startGameDataServer({ port: 0, load: options.load ?? (async () => snapshot), sync: async () => { syncCalls++; return options.sync ? options.sync() : snapshot; } });
  t.after(() => service.close());
  const syncHeaders = { Origin: service.origin, 'X-Game-Data-Sync': '1', 'Sec-Fetch-Site': 'same-origin' };
  return { ...service, syncHeaders, syncCalls: () => syncCalls };
}
async function rawRequest(origin: string, path: string, headers: Record<string, string>, method = 'GET', body?: string) {
  return new Promise<{ status: number | undefined; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('公開資料 API 回傳 status、完整 Dataset 與預設分頁，不允許 CORS', async t => {
  const f = await fixture(t);
  for (const [path, expected] of [
    ['status', snapshot.status], ['operators', dataset],
    ['stages', { items: snapshot.stages, total: 3, offset: 0, limit: 100, version: 'synthetic-v1' }],
    ['events', { items: snapshot.events, total: 2, offset: 0, limit: 100, version: 'synthetic-v1' }],
  ] as const) {
    const response = await fetch(`${f.origin}/api/game-data/${path}`);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(f.syncCalls(), 0);
});

test('status 會帶出模組補表版本，供設定頁顯示', async t => {
  const moduleSource = { version: 'c'.repeat(40), sourceUrl: 'https://example.test/modules', sourceUpdatedAt: '2026-11-12T00:00:00.000Z' };
  const f = await fixture(t, { load: async () => ({ ...snapshot, status: { ...snapshot.status, moduleSource } }) as Snapshot });
  assert.deepEqual((await (await fetch(`${f.origin}/api/game-data/status`)).json() as { moduleSource: unknown }).moduleSource, moduleSource);
});

test('尚無快取回 503；讀取不會暗中同步或請求外網', async t => {
  const f = await fixture(t, { load: async () => null });
  for (const path of ['status', 'operators', 'stages', 'events']) {
    const response = await fetch(`${f.origin}/api/game-data/${path}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'DATA_UNAVAILABLE');
  }
  assert.equal(f.syncCalls(), 0);
});

test('分頁在篩選後計算 total；查詢有界且拒絕未知及重複參數', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/api/game-data/stages?q=${encodeURIComponent('合成乙')}&offset=1&limit=1`);
  assert.deepEqual(await response.json(), { items: [snapshot.stages[2]], total: 2, offset: 1, limit: 1, version: 'synthetic-v1' });
  const events = await fetch(`${f.origin}/api/game-data/events?q=event-b&limit=1000&offset=0`);
  assert.deepEqual(await events.json(), { items: [snapshot.events[1]], total: 1, offset: 0, limit: 1000, version: 'synthetic-v1' });
  for (const query of ['limit=0', 'limit=1001', 'limit=1.5', 'limit=1e2', 'offset=-1', 'offset=9007199254740992', 'limit=1&limit=2', 'q=a&q=b', 'url=https://example.test', `q=${'x'.repeat(101)}`]) {
    assert.equal((await fetch(`${f.origin}/api/game-data/stages?${query}`)).status, 400, query);
  }
  // 查詢只比對值，不比對屬性名稱。
  const byKey = await fetch(`${f.origin}/api/game-data/stages?q=name`);
  assert.equal((await byKey.json() as { total: number }).total, 0);
  assert.equal((await fetch(`${f.origin}/api/game-data/operators?url=https://example.test`)).status, 400);
  assert.equal((await fetch(`${f.origin}/api/game-data/status?token=synthetic-secret`)).status, 400);
});

test('所有路由驗證 Host；只接受 127.0.0.1 的連接埠（Vite 換埠時仍可用）', async t => {
  const f = await fixture(t);
  for (const host of ['attacker.test', 'localhost:5188', '127.0.0.1.attacker.test:5173', '127.0.0.1', '127.0.0.1:5173.evil']) {
    assert.equal((await rawRequest(f.origin, '/api/game-data/status', { Host: host })).status, 403);
  }
  for (const host of ['127.0.0.1:5173', '127.0.0.1:4173', '127.0.0.1:5174']) {
    assert.equal((await rawRequest(f.origin, '/api/game-data/status', { Host: host })).status, 200);
  }
  assert.equal((await fetch(`${f.origin}/api/game-data/status`, { headers: { Authorization: 'Bearer SYNTHETIC_SECRET' } })).status, 400);
  assert.equal((await fetch(`${f.origin}/api/game-data/status`, { method: 'OPTIONS' })).status, 405);
  assert.equal((await fetch(`${f.origin}/private-file`)).status, 404);
});

test('同步只允許明確標頭及精確 Origin；Fetch-Site 可省略但不可跨站', async t => {
  const f = await fixture(t);
  const invalidHeaders: Record<string, string>[] = [
    {}, { 'X-Game-Data-Sync': '1' }, { Origin: f.origin },
    { ...f.syncHeaders, Origin: 'https://attacker.test' }, { ...f.syncHeaders, Origin: 'null' },
    { ...f.syncHeaders, Origin: `${f.origin}.attacker.test` },
    { ...f.syncHeaders, 'Sec-Fetch-Site': 'cross-site' }, { ...f.syncHeaders, 'Sec-Fetch-Site': 'none' },
  ];
  for (const headers of invalidHeaders) assert.equal((await fetch(`${f.origin}/api/game-data/sync`, { method: 'POST', headers })).status, 403);
  assert.equal(f.syncCalls(), 0);
  for (const headers of [f.syncHeaders, { Origin: 'http://127.0.0.1:5173', 'X-Game-Data-Sync': '1', 'Sec-Fetch-Site': 'same-site' }, { Origin: 'http://127.0.0.1:4173', 'X-Game-Data-Sync': '1', 'Sec-Fetch-Site': 'same-site' }, { Origin: f.origin, 'X-Game-Data-Sync': '1' }]) {
    const response = await fetch(`${f.origin}/api/game-data/sync`, { method: 'POST', headers });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot.status);
  }
  assert.equal(f.syncCalls(), 4);
});

test('同步不接受 body、Content-Type、chunked、URL 參數或錯誤 method', async t => {
  const f = await fixture(t);
  const base = { ...f.syncHeaders, 'Content-Length': '0' };
  assert.equal((await rawRequest(f.origin, '/api/game-data/sync', { ...base, 'Content-Type': 'application/json' }, 'POST')).status, 415);
  assert.equal((await rawRequest(f.origin, '/api/game-data/sync', { ...f.syncHeaders, 'Content-Length': '2' }, 'POST', '{}')).status, 400);
  assert.equal((await rawRequest(f.origin, '/api/game-data/sync', { ...f.syncHeaders, 'Transfer-Encoding': 'chunked' }, 'POST', '{}')).status, 400);
  assert.equal((await rawRequest(f.origin, '/api/game-data/sync?url=https://example.test', base, 'POST')).status, 400);
  assert.equal((await fetch(`${f.origin}/api/game-data/sync`)).status, 405);
  assert.equal((await fetch(`${f.origin}/api/game-data/status`, { method: 'POST', headers: f.syncHeaders })).status, 405);
  assert.equal(f.syncCalls(), 0);
});

test('同步失敗回固定 502 且仍能讀舊快取；讀取例外與 lastError 不洩漏路徑', async t => {
  const secret = 'SYNTHETIC_PRIVATE_PATH_AND_SECRET';
  const f = await fixture(t, { sync: async () => { throw new Error(secret); } });
  const failed = await fetch(`${f.origin}/api/game-data/sync`, { method: 'POST', headers: f.syncHeaders });
  assert.equal(failed.status, 502);
  const text = await failed.text(); assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_PATH_AND_SECRET/);
  assert.equal(JSON.parse(text).error.code, 'SYNC_FAILED');
  assert.deepEqual(await (await fetch(`${f.origin}/api/game-data/operators`)).json(), dataset);
  const g = await fixture(t, { load: async () => { throw new Error(secret); } });
  const broken = await fetch(`${g.origin}/api/game-data/status`);
  assert.equal(broken.status, 500); assert.equal((await broken.text()).includes(secret), false);
  const h = await fixture(t, { load: async () => ({ ...snapshot, status: { ...snapshot.status, lastError: secret } }) });
  const stale = await fetch(`${h.origin}/api/game-data/status`);
  assert.equal(stale.status, 200); assert.equal((await stale.text()).includes(secret), false);
});

test('立繪同步：背景執行、可查進度，只接受本機頁面的同步請求', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = await startGameDataServer({ port: 0, load: async () => snapshot, sync: async () => snapshot, notifier: null, syncPortraits: async progress => { progress(1, 2); await gate; progress(2, 2); return { downloaded: 1, skipped: 0, missing: 1, failed: 0 }; } });
  t.after(() => service.close());
  const headers = { Origin: service.origin, 'X-Game-Data-Sync': '1', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await rawRequest(service.origin, '/api/game-data/portraits', { ...headers, Origin: 'https://evil.example' }, 'POST')).status, 403);
  const started = await rawRequest(service.origin, '/api/game-data/portraits', headers, 'POST');
  assert.equal(started.status, 202);
  const running = JSON.parse((await rawRequest(service.origin, '/api/game-data/portraits-status', {})).body);
  assert.equal(running.running, true); assert.equal(running.done, 1);
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  const finished = JSON.parse((await rawRequest(service.origin, '/api/game-data/portraits-status', {})).body);
  assert.equal(finished.running, false); assert.deepEqual(finished.result, { downloaded: 1, skipped: 0, missing: 1, failed: 0 });
});

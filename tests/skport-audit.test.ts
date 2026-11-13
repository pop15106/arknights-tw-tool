import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkportAuditWriter } from '../scripts/skport-audit.ts';

async function temporary(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'skport-audit-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
const clock = () => Date.parse('2026-11-13T12:00:00.000Z');
async function rows(path: string) { return (await fs.readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

test('audit 只保存白名單安全值，時間與版本不接受外部覆寫', async t => {
  const writer = createSkportAuditWriter({ directory: await temporary(t), clock });
  await writer.write({ event: 'http_request', requestId: 'c9f020af-dc3c-4135-a536-933f5dfc830c', operation: 'roster', method: 'POST', outcome: 'failure', status: 502, durationMs: 23, code: 'invalid_response', stage: 'roster', count: 120,
    timestamp: 'secret-time', schemaVersion: 99, password: 'secret-password', token: 'secret-token', url: 'secret-url', body: { cred: 'secret-cred' }, error: new Error('secret-error') });
  await writer.flush();
  assert.deepEqual(await rows(writer.path), [{ schemaVersion: 1, timestamp: '2026-11-13T12:00:00.000Z', event: 'http_request', operation: 'roster', method: 'POST', outcome: 'failure', code: 'invalid_response', stage: 'roster', requestId: 'c9f020af-dc3c-4135-a536-933f5dfc830c', status: 502, durationMs: 23, count: 120 }]);
  assert.equal((await fs.readFile(writer.path, 'utf8')).includes('secret'), false);
});

test('audit 移除未知列舉、非法數值與非 UUID，且不執行 getter', async t => {
  const writer = createSkportAuditWriter({ directory: await temporary(t), clock });
  const event = { event: 'service_start', requestId: 'secret-id', operation: 'secret-op', method: 'SECRET', outcome: 'secret-outcome', code: 'secret-code', stage: 'secret-stage', status: 999, durationMs: -1, count: 2001 };
  Object.defineProperty(event, 'body', { get() { throw new Error('不得讀取'); } });
  await writer.write(event);
  assert.deepEqual(await rows(writer.path), [{ schemaVersion: 1, timestamp: '2026-11-13T12:00:00.000Z', event: 'service_start' }]);
});

test('audit diagnostic 只保留已有 client sanitizer 接受的欄位位置與型別', async t => {
  const writer = createSkportAuditWriter({ directory: await temporary(t), clock });
  const safe = { field: 'data.chars[0].level', expected: 'nonnegative integer within limit', actual: 'string' };
  await writer.write({ event: 'http_request', diagnostic: { ...safe, value: 'secret-token', authorization: 'secret-credential' } });
  for (const diagnostic of [{ ...safe, field: 'secret-field' }, { ...safe, expected: 'secret-expected' }, { ...safe, actual: 'secret-value' }]) await writer.write({ event: 'http_request', diagnostic });
  const result = await rows(writer.path);
  assert.deepEqual(result[0].diagnostic, safe); assert.ok(result.slice(1).every(row => !('diagnostic' in row)));
  assert.equal((await fs.readFile(writer.path, 'utf8')).includes('secret'), false);
});

test('audit 並行呼叫依 write 順序輸出，呼叫後改動物件不會改紀錄', async t => {
  const writer = createSkportAuditWriter({ directory: await temporary(t), clock });
  const promises = Array.from({ length: 40 }, (_, count) => {
    const event = { event: 'http_request', count }; const pending = writer.write(event); event.count = 999; return pending;
  });
  await Promise.all(promises); await writer.flush();
  assert.deepEqual((await rows(writer.path)).map(row => row.count), Array.from({ length: 40 }, (_, count) => count));
});

test('audit 輪替只保留 active 與兩個備份，各檔及合計均有上限', async t => {
  const directory = await temporary(t), maxBytes = 256;
  const writer = createSkportAuditWriter({ directory, maxBytes, clock });
  await Promise.all(Array.from({ length: 20 }, (_, count) => writer.write({ event: 'http_request', count })));
  await writer.flush();
  const files = (await fs.readdir(directory)).sort();
  assert.deepEqual(files, ['skport-audit.jsonl', 'skport-audit.jsonl.1', 'skport-audit.jsonl.2']);
  let total = 0; const retained: number[] = [];
  for (const name of [...files].reverse()) { const stat = await fs.stat(join(directory, name)); assert.ok(stat.size <= maxBytes); total += stat.size; retained.push(...(await rows(join(directory, name))).map(row => row.count)); }
  assert.ok(total <= maxBytes * 3); assert.equal(retained.at(-1), 19);
  assert.deepEqual(retained, [...retained].sort((a, b) => a - b)); assert.ok(retained.length < 20);
});

test('audit 建立與後續 IO 錯誤明確 reject，不把完整系統錯誤寫入', async t => {
  const directory = await temporary(t), occupied = join(directory, 'occupied'); await fs.writeFile(occupied, 'sentinel');
  const bad = createSkportAuditWriter({ directory: occupied, clock });
  await assert.rejects(bad.flush(), /無法建立或寫入/); await assert.rejects(bad.write({ event: 'service_start' }), /無法建立或寫入/);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'sentinel');
  const writer = createSkportAuditWriter({ directory: join(directory, 'active'), clock }); await writer.flush();
  await fs.unlink(writer.path); await fs.mkdir(writer.path);
  await assert.rejects(writer.write({ event: 'service_start' }), /無法建立或寫入/); await assert.rejects(writer.flush(), /無法建立或寫入/);
  assert.deepEqual(await fs.readdir(writer.path), []);
});

test('audit 拒絕目錄 junction 與連結檔案，不寫到外部目錄', async t => {
  const root = await temporary(t), external = join(root, 'outside'), linked = join(root, 'linked'); await fs.mkdir(external);
  try { await fs.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('此環境不能建立測試 junction'); return; } throw error; }
  const writer = createSkportAuditWriter({ directory: linked, clock });
  await assert.rejects(writer.flush(), /無法建立或寫入/); assert.deepEqual(await fs.readdir(external), []);
});

test('audit 拒絕既有 hard link，保護被連結的原檔', async t => {
  const root = await temporary(t), directory = join(root, 'logs'), target = join(root, 'outside.txt'); await fs.mkdir(directory); await fs.writeFile(target, 'sentinel');
  try { await fs.link(target, join(directory, 'skport-audit.jsonl')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('此環境不能建立測試 hard link'); return; } throw error; }
  const writer = createSkportAuditWriter({ directory, clock }); await assert.rejects(writer.flush(), /無法建立或寫入/);
  assert.equal(await fs.readFile(target, 'utf8'), 'sentinel');
});

test('audit 拒絕過大單筆與無效事件，但不污染其他有效紀錄', async t => {
  const writer = createSkportAuditWriter({ directory: await temporary(t), clock, maxBytes: 128 });
  await assert.rejects(writer.write({ event: 'secret-event' }), /無效/);
  await assert.rejects(writer.write({ event: 'http_request', requestId: 'c9f020af-dc3c-4135-a536-933f5dfc830c', operation: 'roster', outcome: 'failure' }), /超出/);
  await writer.write({ event: 'service_stop' }); assert.equal((await rows(writer.path)).length, 1);
});

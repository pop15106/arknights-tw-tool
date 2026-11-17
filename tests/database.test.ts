import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createEmptyState, known, sealDataset, type ImportDocument } from '../src/domain/model.ts';
import { applyImport, previewImport } from '../src/domain/import.ts';
import { loadState, openDatabase, overwriteRepaired, readRawState, repairUnknownFields, saveState } from '../src/storage/database.ts';
import { createBackup, parseBackup } from '../src/storage/backup.ts';

async function setup() {
  const factory = new IDBFactory();
  const db = await openDatabase(`test-${crypto.randomUUID()}`, factory);
  const dataset = await sealDataset({ metadata: { id: 'demo-empty', version: '1', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: '2026-11-13T00:00:00.000Z', acquiredAt: '2026-11-13T00:00:00.000Z', source: '自製', licenseStatus: 'self-authored' }, operators: [] });
  return { db, factory, state: createEmptyState(dataset) };
}

test('IndexedDB 首存、關閉重開、單次更新與舊分頁衝突', async () => {
  const { db, state, factory } = await setup();
  assert.equal(await loadState(db), null);
  await saveState(db, state, -1);
  const name = db.name;
  db.close();
  const reopened = await openDatabase(name, factory);
  assert.deepEqual(await loadState(reopened), state);
  const updated = { ...state, revision: 1 };
  await saveState(reopened, updated, 0);
  assert.deepEqual(await parseBackup(await createBackup(updated)), updated);
  await assert.rejects(saveState(reopened, { ...updated, settings: { ...updated.settings, analysis: { ...updated.settings.analysis, goal: '舊分頁嘗試覆蓋' } } }, 0), /其他分頁/);
  assert.deepEqual(await loadState(reopened), updated);
  reopened.close();
});

test('並行交易只接受一筆相同預期修訂，不能最後寫入者覆蓋', async () => {
  const { db, state, factory } = await setup();
  await saveState(db, state, -1);
  const second = await openDatabase(db.name, factory);
  const outcomes = await Promise.allSettled([saveState(db, { ...state, revision: 1 }, 0), saveState(second, { ...state, revision: 1 }, 0)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await loadState(db))?.revision, 1);
  db.close(); second.close();
});

test('容量錯誤與交易中止保留已存資料；重試可成功', async () => {
  const { db, state } = await setup();
  await saveState(db, state, -1);
  const originalPut = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function () { throw new DOMException('測試容量不足', 'QuotaExceededError'); };
    await assert.rejects(saveState(db, { ...state, revision: 1 }, 0), /容量不足/);
  } finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await loadState(db), state);
  await saveState(db, { ...state, revision: 1 }, 0);
  assert.equal((await loadState(db))?.revision, 1);
  db.close();
});

test('升級被其他連線阻擋時明確失敗，不延後偷偷建庫', async () => {
  let request: IDBOpenDBRequest;
  let aborted = false;
  const factory = { open() { request = { transaction: { abort() { aborted = true; } } } as unknown as IDBOpenDBRequest; queueMicrotask(() => request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent)); return request; } } as unknown as IDBFactory;
  await assert.rejects(openDatabase('blocked-test', factory), /阻擋/);
  request!.onupgradeneeded?.call(request!, new Event('upgradeneeded') as IDBVersionChangeEvent);
  assert.equal(aborted, true);
});

test('put 已排入交易後真正 abort，仍不能留下部分新資料', async () => {
  const { db, state } = await setup();
  await saveState(db, state, -1);
  const originalPut = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = function (value, key) { const request = originalPut.call(this, value, key); this.transaction.abort(); return request; };
    await assert.rejects(saveState(db, { ...state, revision: 1 }, 0), /交易失敗/);
  } finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await loadState(db), state);
  db.close();
});

test('未知舊格式留在資料庫，讀取與覆寫皆拒絕', async () => {
  const { db, state } = await setup();
  const legacy = { schemaVersion: 0, original: '必須保留' };
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(legacy, 'active'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  await assert.rejects(loadState(db), /未允許|版本|必要欄位/);
  await assert.rejects(saveState(db, state, -1), /未允許|版本|必要欄位/);
  const unchanged = await new Promise(resolve => { const request = db.transaction('state').objectStore('state').get('active'); request.onsuccess = () => resolve(request.result); });
  assert.deepEqual(unchanged, legacy);
  db.close();
});

test('較新的 IndexedDB schema 不降級、不重建', async () => {
  const factory = new IDBFactory();
  const name = `future-${crypto.randomUUID()}`;
  const future = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open(name, 2); request.onupgradeneeded = () => request.result.createObjectStore('future'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  future.close();
  await assert.rejects(openDatabase(name, factory), /版本較新/);
  const preserved = await new Promise<IDBDatabase>(resolve => { const request = factory.open(name); request.onsuccess = () => resolve(request.result); });
  assert.equal(preserved.version, 2);
  assert.ok(preserved.objectStoreNames.contains('future'));
  preserved.close();
});

test('其他版本留下的未知欄位：可備份原樣、移除後通過驗證，其餘內容保留', async () => {
  const { db, state } = await setup();
  const foreign = { ...structuredClone(state), pendingReviews: [{ id: 'x' }], settings: { ...structuredClone(state.settings), analysis: { ...state.settings.analysis, goal: '保留這段' }, pendingReviews: {} } };
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(foreign, 'active'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  await assert.rejects(loadState(db), /未允許欄位：pendingReviews/);
  const raw = await readRawState(db);
  assert.ok(raw && typeof raw === 'object' && 'pendingReviews' in raw);
  const { state: repaired, removed } = await repairUnknownFields(raw);
  assert.deepEqual(removed, ['pendingReviews']);
  assert.equal(repaired.settings.analysis.goal, '保留這段');
  await overwriteRepaired(db, repaired, raw);
  const loaded = await loadState(db);
  assert.equal(loaded?.settings.analysis.goal, '保留這段');
  assert.ok(!('pendingReviews' in (loaded as object)));
  db.close();
});

test('修復只處理未知欄位；缺少必要欄位時不猜測、直接拒絕', async () => {
  const { state } = await setup();
  const broken = structuredClone(state) as unknown as Record<string, unknown>;
  delete broken.roster;
  await assert.rejects(repairUnknownFields(broken), /缺少必要欄位：roster/);
});

test('其他版本留下「稍後審閱」的衝突：補記為保留現有值，幹員庫不變', async () => {
  const date = '2026-11-13T00:00:00.000Z';
  const dataset = await sealDataset({ metadata: { id: 'demo-set', version: '1', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: date, acquiredAt: date, source: '自製', licenseStatus: 'self-authored' }, operators: [{ id: 'demo-1', displayName: '測試幹員', aliases: [], rarity: 6, profession: '先鋒', branch: '虛構分支', faction: '測試', skills: [{ id: 'demo-s1', name: '技能' }], modules: [], availability: 'unknown' }] });
  const input: ImportDocument = { format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: 'demo', dataset, candidates: [{ operatorId: 'demo-1', fields: { level: known(50, '測試', { importedAt: date, observedAt: date }) } }], completeness: 'partial', source: '測試', adapterVersion: '1', createdAt: date };
  const empty = createEmptyState(dataset);
  const first = applyImport(empty, await previewImport(empty, input), {});
  const change = structuredClone(input); change.candidates[0].fields.level = known(70, '測試', { importedAt: date, observedAt: date });
  const preview = await previewImport(first, change);
  assert.equal(preview.conflicts.length, 1);
  const second = applyImport(first, preview, { [preview.conflicts[0].id]: 'keep' });
  // 模擬其他版本：衝突沒做決定、改放在 pendingReviews。
  const raw = structuredClone(second) as unknown as Record<string, unknown> & { batches: { decisions: Record<string, string> }[] };
  raw.batches[1].decisions = {}; raw.pendingReviews = [preview.conflicts[0].id];
  const { state, removed, undecided } = await repairUnknownFields(raw);
  assert.deepEqual(removed, ['pendingReviews']); assert.equal(undecided, 1);
  assert.equal(state.batches[1].decisions[preview.conflicts[0].id], 'keep');
  assert.deepEqual(state.roster, second.roster);
});

test('Codex 回饋：同名欄位只刪驗證器指出的位置，正常設定不受影響', async () => {
  const { state } = await setup();
  const raw = structuredClone(state) as unknown as { settings: { base: Record<string, unknown>; analysis: Record<string, unknown> } };
  raw.settings.analysis.onlineSlots = ['09:00'];
  raw.settings.base.onlineSlots = ['08:00'];
  const { state: repaired, removed } = await repairUnknownFields(raw);
  assert.deepEqual(removed, ['onlineSlots']);
  assert.deepEqual(repaired.settings.base.onlineSlots, ['08:00']);
});

test('Codex 回饋：原本就壞掉的校驗值不會因為順便移除欄位而被蓋過', async () => {
  const { state } = await setup();
  const raw = { ...structuredClone(state), pendingReviews: [] } as unknown as { dataset: { metadata: { checksum: string } } };
  raw.dataset.metadata.checksum = `sha256:${'1'.repeat(64)}`;
  await assert.rejects(repairUnknownFields(raw), /校驗值不符/);
});

test('Codex 回饋：修復寫入前資料已被其他分頁改動時取消，不蓋掉新資料', async () => {
  const { db, state } = await setup();
  const put = (value: unknown) => new Promise<void>((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, 'active'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  const raw = { ...structuredClone(state), pendingReviews: [] };
  await put(raw);
  const { state: repaired } = await repairUnknownFields(raw);
  const newer = { ...structuredClone(state), revision: 5 };
  await put(newer);
  await assert.rejects(overwriteRepaired(db, repaired, raw), /其他分頁/);
  assert.equal((await loadState(db))?.revision, 5);
  db.close();
});

test('Codex 回饋：大量未決定衝突（600 筆匯入紀錄各一筆）也能一次修完', async () => {
  const date = '2026-11-13T00:00:00.000Z';
  const dataset = await sealDataset({ metadata: { id: 'demo-set', version: '1', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: date, acquiredAt: date, source: '自製', licenseStatus: 'self-authored' }, operators: [{ id: 'demo-1', displayName: '測試幹員', aliases: [], rarity: 6, profession: '先鋒', branch: '虛構分支', faction: '測試', skills: [{ id: 'demo-s1', name: '技能' }], modules: [], availability: 'unknown' }] });
  const input: ImportDocument = { format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: 'demo', dataset, candidates: [{ operatorId: 'demo-1', fields: { level: known(50, '測試', { importedAt: date, observedAt: date }) } }], completeness: 'partial', source: '測試', adapterVersion: '1', createdAt: date };
  const empty = createEmptyState(dataset);
  const first = applyImport(empty, await previewImport(empty, input), {});
  const change = structuredClone(input); change.candidates[0].fields.level = known(70, '測試', { importedAt: date, observedAt: date });
  const preview = await previewImport(first, change);
  const second = applyImport(first, preview, { [preview.conflicts[0].id]: 'keep' });
  const template = second.batches[1];
  const copies = Array.from({ length: 600 }, (_, index) => ({ ...structuredClone(template), id: `batch-copy-${index}`, decisions: {} }));
  const raw = { ...structuredClone(second), pendingReviews: [], batches: [...structuredClone(second.batches), ...copies] };
  const { state, removed, undecided } = await repairUnknownFields(raw);
  assert.deepEqual(removed, ['pendingReviews']); assert.equal(undecided, 600);
  assert.ok(state.batches.every(item => item.conflicts.every(conflict => item.decisions[conflict.id])));
});

test('Codex 回饋：錯誤指向驗證器的暫時物件時直接停止，不會無限迴圈', async () => {
  const date = '2026-11-13T00:00:00.000Z';
  const dataset = await sealDataset({ metadata: { id: 'demo-set', version: '1', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: date, acquiredAt: date, source: '自製', licenseStatus: 'self-authored' }, operators: [{ id: 'demo-1', displayName: '測試幹員', aliases: [], rarity: 6, profession: '先鋒', branch: '虛構分支', faction: '測試', skills: [{ id: 'demo-s1', name: '技能' }], modules: [], availability: 'unknown' }] });
  const input: ImportDocument = { format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: 'demo', dataset, candidates: [{ operatorId: 'demo-1', fields: { level: known(50, '測試', { importedAt: date, observedAt: date }) } }], completeness: 'partial', source: '測試', adapterVersion: '1', createdAt: date };
  const empty = createEmptyState(dataset);
  const first = applyImport(empty, await previewImport(empty, input), {});
  const change = structuredClone(input); change.candidates[0].fields.level = known(70, '測試', { importedAt: date, observedAt: date });
  const preview = await previewImport(first, change);
  const second = applyImport(first, preview, { [preview.conflicts[0].id]: 'keep' });
  const raw = structuredClone(second) as unknown as { batches: { conflicts: { field: string }[] }[] };
  raw.batches[1].conflicts[0].field = 'futureField';
  await assert.rejects(repairUnknownFields(raw), /未允許欄位：futureField/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createEmptyState, sealDataset } from '../src/domain/model.ts';
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
  await overwriteRepaired(db, repaired);
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

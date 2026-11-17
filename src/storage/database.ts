import { canonical, FieldError, hashValue, validateAppState, verifyDatasetChecksum, type AppState } from '../domain/model.ts';
import { createBackup } from './backup.ts';

const STORE_NAME = 'state';
const ACTIVE_KEY = 'active';
function storageError(error: unknown): Error {
  if (error instanceof Error && /其他分頁|修訂|不同命名空間|設定檔|未允許|版本|校驗|格式|欄位|超過/.test(error.message)) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'QuotaExceededError') return new Error('本機儲存容量不足，原資料仍保留；請先下載備份並釋放空間後重試。');
  if (name === 'VersionError') return new Error('本機資料庫版本較新，請使用相容版本；未清除既有資料。');
  if (name === 'InvalidStateError') return new Error('儲存連線已關閉，請重新整理後再試；畫面中的未存變更尚未保存。');
  if (name === 'SecurityError') return new Error('此瀏覽環境禁止本機儲存；請改用可儲存的 Safari 網站環境。');
  return new Error('本機儲存交易失敗，原資料未清除；請重新讀取並保留備份。');
}

export function openDatabase(name = 'arknights-tw-personal', factory?: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const availableFactory = factory ?? globalThis.indexedDB;
    if (!availableFactory) { reject(new Error('此環境不支援 IndexedDB，資料尚未保存。')); return; }
    let settled = false;
    let request: IDBOpenDBRequest;
    try { request = availableFactory.open(name, 1); } catch (error) { reject(storageError(error)); return; }
    request.onblocked = () => { settled = true; reject(new Error('本機資料庫升級被其他分頁阻擋；請關閉本工具的其他分頁後重試。未清除原資料。')); };
    request.onupgradeneeded = () => {
      // 被阻擋的要求已回報失敗，後續放行時也不得偷偷建立或升級。
      if (settled) { request.transaction?.abort(); return; }
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => { settled = true; reject(storageError(request.error)); };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      if (!db.objectStoreNames.contains(STORE_NAME)) { db.close(); reject(new Error('本機資料庫格式不相容；請保留資料並使用相容版本。')); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export async function loadState(db: IDBDatabase): Promise<AppState | null> {
  const value = await new Promise<unknown>((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_KEY);
      let result: unknown;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(storageError(transaction.error));
      transaction.onerror = () => reject(storageError(transaction.error));
    } catch (error) { reject(storageError(error)); }
  });
  if (value === undefined) return null;
  const state = validateAppState(value);
  await verifyDatasetChecksum(state.dataset);
  if (state.undo) await verifyDatasetChecksum(state.undo.dataset);
  return structuredClone(state);
}

/** 讀出資料庫原始內容（不驗證），只用於修復前下載原樣備份。 */
export function readRawState(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(ACTIVE_KEY);
      let result: unknown;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(storageError(transaction.error));
    } catch (error) { reject(storageError(error)); }
  });
}

const isPlain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const checksumOk = async (dataset: unknown) => isPlain(dataset) && isPlain(dataset.metadata) && await hashValue(dataset.operators) === dataset.metadata.checksum;

/**
 * 其他版本寫入了本版不認得的內容時，逐項修到通過驗證為止：
 * - 未允許欄位：只刪除驗證器指出的那個物件上的那個欄位（不會誤刪同名的正常欄位）。
 * - 匯入紀錄缺少衝突決定（其他版本可「稍後審閱」）：該衝突當時沒有改動幹員庫，補記為「保留現有值」。
 * 其他錯誤（缺必要欄位、格式錯、原本就壞掉的校驗值）一律停止，不猜測修補。
 */
export async function repairUnknownFields(raw: unknown): Promise<{ state: AppState; removed: string[]; undecided: number }> {
  const value = structuredClone(raw);
  const removed: string[] = [];
  let undecided = 0;
  // 修復前的校驗值必須本來就正確；修復只允許因移除欄位而重算。
  const rawOk = isPlain(raw) ? [await checksumOk(raw.dataset), !isPlain(raw.undo) || await checksumOk(raw.undo.dataset)] : [false, false];
  const batches = isPlain(value) && Array.isArray(value.batches) ? value.batches : [];
  const touched = new WeakMap<object, Set<string>>();
  // 每一輪都修好一個沒修過的位置（重複就停止），所以必定結束；不設固定次數上限。
  for (;;) {
    try { validateAppState(value); break; }
    catch (error) {
      if (!(error instanceof FieldError)) throw error;
      // 同一位置修過還是錯（例如驗證器檢查的是暫時物件），表示無法安全修復。
      const seen = touched.get(error.target) ?? new Set<string>();
      if (seen.has(error.key)) throw error;
      seen.add(error.key); touched.set(error.target, seen);
      if (error.kind === 'unknown') { delete error.target[error.key]; removed.push(error.key); continue; }
      const batch = batches.find(item => isPlain(item) && item.decisions === error.target);
      if (isPlain(batch) && batch.kind === 'import' && Array.isArray(batch.conflicts) && batch.conflicts.some(conflict => isPlain(conflict) && conflict.id === error.key)) {
        // 驗證器確認是「匯入紀錄缺衝突決定」後，所有匯入紀錄的未決定衝突一次補齊，避免每補一筆就重驗整份資料。
        for (const item of batches) {
          if (!isPlain(item) || item.kind !== 'import' || !isPlain(item.decisions) || !Array.isArray(item.conflicts)) continue;
          const decisions = item.decisions;
          for (const conflict of item.conflicts) if (isPlain(conflict) && typeof conflict.id === 'string' && !Object.hasOwn(decisions, conflict.id)) { decisions[conflict.id] = 'keep'; undecided++; }
        }
        continue;
      }
      throw error;
    }
  }
  const state = validateAppState(value);
  const datasets = [state.dataset, state.undo?.dataset];
  for (const [index, dataset] of datasets.entries()) {
    if (!dataset || await checksumOk(dataset)) continue;
    if (!rawOk[index] || !removed.length) throw new Error('資料集校驗值不符，未修改原資料。');
    dataset.metadata.checksum = await hashValue(dataset.operators);
  }
  return { state, removed: [...new Set(removed)], undecided };
}

/** 用修復後的資料覆寫目前內容。寫入前確認資料庫仍是修復時讀到的原樣，避免蓋掉其他分頁的新改動。 */
export async function overwriteRepaired(db: IDBDatabase, repaired: AppState, original: unknown): Promise<void> {
  const state = structuredClone(validateAppState(repaired));
  await createBackup(state);
  const expected = canonical(original);
  return new Promise((resolve, reject) => {
    let failure: unknown;
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(ACTIVE_KEY);
      request.onsuccess = () => {
        if (canonical(request.result) !== expected) { failure = new Error('其他分頁已更新資料，已取消修復。請重新讀取後再試。'); transaction.abort(); return; }
        store.put(state, ACTIVE_KEY);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(storageError(failure ?? transaction.error));
    } catch (error) { reject(storageError(error)); }
  });
}

export async function saveState(db: IDBDatabase, stateValue: AppState, expectedRevision: number): Promise<void> {
  const state = structuredClone(validateAppState(stateValue));
  if (!Number.isInteger(expectedRevision) || expectedRevision < -1 || state.revision !== expectedRevision + 1) throw new Error('修訂版本不連續；請重新讀取後再存檔。');
  // 在開啟交易前驗證完整可匯出的 envelope 與容量，避免可存卻不能備份。
  // 非同步雜湊也必須先完成，否則 IndexedDB 交易可能提前結束。
  await createBackup(state);
  return new Promise((resolve, reject) => {
    let failure: unknown;
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(ACTIVE_KEY);
      request.onsuccess = () => {
        try {
          const existing = request.result === undefined ? null : validateAppState(request.result);
          if ((existing?.revision ?? -1) !== expectedRevision) throw new Error('其他分頁已更新資料，已取消此次寫入。請重新載入並重新預覽。');
          if (existing && existing.dataset.metadata.namespace !== state.dataset.metadata.namespace) throw new Error('不能在同一資料庫寫入不同命名空間。');
          if (existing && existing.profileId !== state.profileId) throw new Error('設定檔不同，請先確認備份復原並沿用目前本機設定檔 ID。');
          store.put(state, ACTIVE_KEY);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(storageError(failure ?? transaction.error));
      transaction.onerror = () => { failure ??= transaction.error; };
    } catch (error) { reject(storageError(error)); }
  });
}

export interface PersistenceStatus { supported: boolean; persisted: boolean; usage?: number; quota?: number }
export async function queryPersistence(): Promise<PersistenceStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { supported: false, persisted: false };
  const manager = navigator.storage;
  const persisted = typeof manager.persisted === 'function' ? await manager.persisted() : false;
  const estimate = typeof manager.estimate === 'function' ? await manager.estimate() : {};
  return { supported: typeof manager.persist === 'function', persisted, ...(estimate.usage !== undefined ? { usage: estimate.usage } : {}), ...(estimate.quota !== undefined ? { quota: estimate.quota } : {}) };
}
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') return false;
  return navigator.storage.persist();
}

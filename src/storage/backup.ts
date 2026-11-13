import { MAX_BACKUP_BYTES, hashValue, object, parseJson, validateAppState, verifyDatasetChecksum, type AppState } from '../domain/model.ts';

export async function createBackup(state: AppState): Promise<string> {
  validateAppState(state);
  await verifyDatasetChecksum(state.dataset);
  if (state.undo) await verifyDatasetChecksum(state.undo.dataset);
  const snapshot = structuredClone(state);
  const output = JSON.stringify({ format: 'arknights-roster-backup', formatVersion: 1, exportedAt: new Date().toISOString(), checksum: await hashValue(snapshot), state: snapshot });
  if (new TextEncoder().encode(output).byteLength > MAX_BACKUP_BYTES) throw new Error('備份超過 20 MB，請先處理批次紀錄容量；原資料未修改。');
  return output;
}

export async function parseBackup(text: string): Promise<AppState> {
  const envelope = object(parseJson(text, MAX_BACKUP_BYTES), ['format', 'formatVersion', 'exportedAt', 'checksum', 'state']);
  if (envelope.format !== 'arknights-roster-backup') throw new Error('不是本工具的備份格式。');
  if (envelope.formatVersion !== 1) throw new Error('備份版本不支援；請保留原檔，勿覆蓋原資料。尚無可靠舊格式可供自動遷移。');
  if (typeof envelope.exportedAt !== 'string' || !Number.isFinite(Date.parse(envelope.exportedAt))) throw new Error('備份日期無效。');
  const state = validateAppState(envelope.state);
  if (await hashValue(state) !== envelope.checksum) throw new Error('備份校驗失敗，檔案可能已被修改或損壞；原資料未修改。');
  await verifyDatasetChecksum(state.dataset);
  if (state.undo) await verifyDatasetChecksum(state.undo.dataset);
  return structuredClone(state);
}

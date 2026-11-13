import { MAX_IMPORT_BYTES, parseJson, validateDataset, validateImportDocument, verifyDatasetChecksum, type Dataset, type ImportDocument } from '../domain/model.ts';
import { convertSkportOffline } from './skport.ts';

export async function prepareLocalImportText(text: string, options: { dataset: Dataset; confirmedTw: boolean; importedAt: string; fetcher?: typeof fetch }): Promise<ImportDocument> {
  const value = parseJson(text, MAX_IMPORT_BYTES);
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'skport-offline-research') return validateImportDocument(value);
  if (options.dataset.metadata.namespace !== 'personal') throw new Error('這是 SKPORT 個人資料；請先切換至個人工作區，再重新選取檔案。');
  if (!options.confirmedTw) throw new Error('請先勾選確認這份資料來自《明日方舟》本作繁中服。');
  const dataset = await loadReferenceDataset(options.fetcher);
  const result = await convertSkportOffline(value, { dataset, confirmation: { product: 'arknights', server: 'tw', confirmedByUser: true }, importedAt: options.importedAt });
  return result.document;
}

// 只下載本機公開圖鑑，不傳送帳號檔案，也不寫入養成紀錄。
export async function loadReferenceDataset(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Dataset> {
  let response: Response;
  try { response = await fetcher('/api/game-data/operators', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: signal ?? AbortSignal.timeout(20_000) }); }
  catch { throw new Error('無法連線至遊戲資料服務，請先啟動 npm run game-data 並同步繁中資料。'); }
  if (!response.ok) throw new Error('遊戲資料服務尚未就緒，請先在設定同步繁中遊戲資料。');
  if (Number(response.headers.get('content-length') ?? 0) > MAX_IMPORT_BYTES) throw new Error('遊戲資料包超出容量限制。');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('遊戲資料服務沒有回傳資料。');
  const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_IMPORT_BYTES) throw new Error('遊戲資料包超出容量限制。'); chunks.push(part.value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const dataset = validateDataset(parseJson(new TextDecoder().decode(bytes), MAX_IMPORT_BYTES));
  await verifyDatasetChecksum(dataset);
  if (dataset.metadata.id !== 'arknights-tw-public-catalog' || dataset.metadata.namespace !== 'personal') throw new Error('遊戲資料服務回傳非預期的圖鑑。');
  return dataset;
}

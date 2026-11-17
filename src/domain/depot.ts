/* ------------------------------------------------------------------ */
/* 倉庫匯入：MAA「倉庫辨識」結果。接受三種寫法，全部轉成 { 物品ID: 數量 }： */
/* 1. MAA 核心回呼的 data：{"2001":18000,"31043":317}（官方文件明載）      */
/* 2. 整個回呼 details：{"done":true,"data":"{...}"}                       */
/* 3. 企鵝物流刷圖規劃格式：{"@type":"@penguin-statistics/depot","items":[{"id","have"}]} */
/* ------------------------------------------------------------------ */
export interface DepotImport { items: Record<string, number>; unknown: string[]; format: string }
const ID = /^[A-Za-z0-9_]{1,40}$/u;

export function parseDepot(text: string, knownItems: ReadonlySet<string>): DepotImport {
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('檔案過大，上限 2 MB。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('不是有效的 JSON。'); }
  let format = 'MAA 倉庫辨識（物品 ID：數量）';
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { data?: unknown }).data === 'string') {
    try { value = JSON.parse((value as { data: string }).data); format = 'MAA 倉庫辨識回呼'; } catch { throw new Error('data 欄位不是有效的 JSON。'); }
  }
  const raw: Record<string, unknown> = {};
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    format = '企鵝物流刷圖規劃格式';
    for (const item of (value as { items: Record<string, unknown>[] }).items) if (typeof item?.id === 'string') raw[item.id] = item.have;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(raw, value);
  else throw new Error('無法辨識的倉庫格式。');
  const items: Record<string, number> = {}, unknown: string[] = [];
  for (const [id, count] of Object.entries(raw)) {
    if (!ID.test(id) || typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 10_000_000) continue;
    if (!knownItems.has(id)) { unknown.push(id); continue; }
    items[id] = count;
  }
  if (!Object.keys(items).length) throw new Error('沒有可匯入的材料數量（物品 ID 都不認得或數量格式不符）。');
  return { items, unknown, format };
}

// 企鵝物流（penguin-stats.io）掉落統計：只保留目前仍有效的統計，數值格式嚴格驗證。
export interface DropRates {
  /** 統計所屬伺服器；企鵝物流沒有台服時使用陸服（CN）作參考。 */
  server: string;
  source: { name: string; url: string; fetchedAt: string; note: string };
  /** 關卡 ID → 物品 ID → { 掉落總數, 樣本次數 }。 */
  stages: Record<string, Record<string, { quantity: number; times: number }>>;
}

export const PENGUIN_MATRIX_API = (server: string) => `https://penguin-stats.io/PenguinStats/api/v2/result/matrix?server=${encodeURIComponent(server)}`;
const ID = /^[A-Za-z0-9_#-]{1,64}$/u;

/** 解析企鵝物流 result/matrix 回應：只收目前有效（end 為空）的統計。 */
export function parsePenguinMatrix(body: unknown, server: string, fetchedAt: string): DropRates {
  const matrix = (body as { matrix?: unknown })?.matrix;
  if (!Array.isArray(matrix) || !matrix.length) throw new Error('掉落統計格式不符。');
  const stages: DropRates['stages'] = {};
  for (const row of matrix as Record<string, unknown>[]) {
    const { stageId, itemId, quantity, times, end } = row ?? {};
    if (typeof stageId !== 'string' || typeof itemId !== 'string' || !ID.test(stageId) || !ID.test(itemId)) continue;
    if (!Number.isInteger(quantity) || !Number.isInteger(times) || (quantity as number) < 0 || (times as number) <= 0) continue;
    if (end !== null && end !== undefined && Number(end) <= Date.parse(fetchedAt)) continue;
    (stages[stageId] ??= {})[itemId] = { quantity: quantity as number, times: times as number };
  }
  if (!Object.keys(stages).length) throw new Error('掉落統計沒有有效資料。');
  return { server, source: { name: '企鵝物流數據統計', url: 'https://penguin-stats.io/', fetchedAt, note: `企鵝物流只支援陸、美、日、韓服，沒有台服；使用${server === 'CN' ? '陸服' : server}數據作參考。常駐關卡掉落機制各服相同，活動關卡與台服開放時間可能不同` }, stages };
}

export function validateDropRates(value: unknown): DropRates {
  const data = value as DropRates;
  if (!data || typeof data.server !== 'string' || typeof data.source?.fetchedAt !== 'string' || !data.stages || typeof data.stages !== 'object') throw new Error('掉落統計檔案格式不符。');
  for (const [stageId, items] of Object.entries(data.stages)) {
    if (!ID.test(stageId) || !items || typeof items !== 'object') throw new Error('掉落統計關卡格式不符。');
    for (const [itemId, entry] of Object.entries(items)) if (!ID.test(itemId) || !Number.isInteger(entry?.quantity) || !Number.isInteger(entry?.times) || entry.times <= 0) throw new Error('掉落統計數值格式不符。');
  }
  return data;
}

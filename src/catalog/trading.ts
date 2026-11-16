// 貿易站赤金訂單參數。遊戲資料表沒有訂單時間與報酬，數據取自 PRTS wiki「罗德岛基建/贸易站」。
// 「更新遊戲資料」時會向 PRTS 同步；同步失敗或格式不符時沿用上次結果，再沒有則用下方內建值。
export interface GoldOrder { gold: number; lmd: number; seconds: number }
export interface TradingSource { name: string; url: string; fetchedAt: string; revision?: number; editedAt?: string; note: string }
export interface TradingParams {
  orders: GoldOrder[];
  /** 各等級貿易站的訂單出現機率（對應 orders 順序），未計入改變訂單品質的技能。 */
  probability: number[][];
  /** 各等級訂單上限。 */
  limits: number[];
  source: TradingSource;
}

export const PRTS_TRADING_TITLE = '罗德岛基建/贸易站';
export const PRTS_TRADING_URL = `https://prts.wiki/w/${encodeURIComponent(PRTS_TRADING_TITLE).replace('%2F', '/')}`;
export const PRTS_TRADING_API = `https://prts.wiki/api.php?action=query&prop=revisions&titles=${encodeURIComponent(PRTS_TRADING_TITLE)}&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main&format=json&formatversion=2`;
const NOTE = '陸服社群資料，台服尚未逐項核對';

/** 內建值：2026-11-16 讀取 PRTS（頁面版本 448466，2026-11-07 編輯）。 */
export const DEFAULT_TRADING: TradingParams = {
  orders: [
    { gold: 2, lmd: 1000, seconds: 2 * 3600 + 24 * 60 },
    { gold: 3, lmd: 1500, seconds: 3 * 3600 + 30 * 60 },
    { gold: 4, lmd: 2000, seconds: 4 * 3600 + 36 * 60 },
  ],
  probability: [[1, 0, 0], [0.6, 0.4, 0], [0.3, 0.5, 0.2]],
  limits: [6, 8, 10],
  source: { name: 'PRTS wiki（內建）', url: PRTS_TRADING_URL, fetchedAt: '2026-11-16T00:00:00.000Z', revision: 448466, editedAt: '2026-11-07T02:33:32Z', note: NOTE },
};

/** 某等級貿易站一筆訂單的期望值。 */
export function expectedOrder(level: number, params: TradingParams = DEFAULT_TRADING): { seconds: number; lmd: number; gold: number } {
  const probability = params.probability[level - 1] ?? params.probability[params.probability.length - 1];
  return params.orders.reduce((sum, order, index) => ({
    seconds: sum.seconds + order.seconds * (probability[index] ?? 0),
    lmd: sum.lmd + order.lmd * (probability[index] ?? 0),
    gold: sum.gold + order.gold * (probability[index] ?? 0),
  }), { seconds: 0, lmd: 0, gold: 0 });
}

/** 檢查參數合理性；任何一項不符就拒絕，避免把錯誤數據拿去計算。 */
export function validateTradingParams(value: unknown): TradingParams {
  const params = value as TradingParams;
  const ok = !!params && Array.isArray(params.orders) && params.orders.length >= 1 && params.orders.length <= 6
    && params.orders.every(order => Number.isInteger(order.gold) && order.gold > 0 && order.gold <= 10 && Number.isFinite(order.lmd) && order.lmd > 0 && order.lmd <= 100000 && Number.isFinite(order.seconds) && order.seconds >= 600 && order.seconds <= 86400)
    && Array.isArray(params.probability) && params.probability.length >= 1 && params.probability.length <= 5
    && params.probability.every(row => Array.isArray(row) && row.length === params.orders.length && row.every(p => Number.isFinite(p) && p >= 0 && p <= 1) && Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 0.001)
    && Array.isArray(params.limits) && params.limits.length === params.probability.length && params.limits.every(n => Number.isInteger(n) && n > 0 && n <= 100)
    && !!params.source && typeof params.source.url === 'string' && params.source.url.startsWith('https://prts.wiki/') && typeof params.source.fetchedAt === 'string' && Number.isFinite(Date.parse(params.source.fetchedAt));
  if (!ok) throw new Error('貿易站訂單數據格式不符。');
  return params;
}

const duration = (text: string) => { const m = text.match(/^(\d{1,2}):(\d{2}):(\d{2})$/u); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN; };

/** 解析 PRTS 貿易站頁面的 wikitext：赤金訂單表、生成機率表與各等級訂單上限。 */
export function parseTradingWikitext(text: string, meta: { fetchedAt: string; revision?: number; editedAt?: string }): TradingParams {
  const orders: GoldOrder[] = [];
  for (const match of text.matchAll(/\{\{材料消耗\|赤金\|(\d+)\}\}\s*\|\|\s*\{\{道具图标\|龙门币\|(\d+)(?:\|[^}]*)?\}\}\s*\|\|\s*(\d{1,2}:\d{2}:\d{2})/gu)) {
    orders.push({ gold: Number(match[1]), lmd: Number(match[2]), seconds: duration(match[3]) });
  }
  const section = text.split(/===\s*贵金属订单的生成概率\s*===/u)[1]?.split(/\n\|\}/u)[0] ?? '';
  const rows = [...section.matchAll(/\{\{材料消耗\|赤金\|(\d+)\}\}((?:\s*\|\|\s*(?:\d+(?:\.\d+)?%|—|-))+)/gu)].map(match => ({
    gold: Number(match[1]), cells: match[2].split('||').map(cell => cell.trim()).filter(Boolean).map(cell => cell.endsWith('%') ? Number(cell.slice(0, -1)) / 100 : 0),
  }));
  const levels = rows[0]?.cells.length ?? 0;
  const probability = Array.from({ length: levels }, (_, level) => orders.map(order => rows.find(row => row.gold === order.gold)?.cells[level] ?? 0));
  const limits = [...text.matchAll(/订单上限：'''\s*(\d+)/gu)].map(match => Number(match[1]));
  return validateTradingParams({ orders, probability, limits: limits.slice(0, levels), source: { name: 'PRTS wiki', url: PRTS_TRADING_URL, ...meta, note: NOTE } });
}

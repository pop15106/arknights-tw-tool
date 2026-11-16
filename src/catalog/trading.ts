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
  /** 3 級貿易站受訂單品質技能影響後的機率（PRTS 為技能達到峰值後的觀測值）。 */
  quality: { alpha: number[]; beta: number[]; alphaAlpha: number[]; alphaBeta: number[] };
  /** 特殊訂單：佩佩（特別獨占訂單）與可露希爾（特別訂單）。 */
  special: { pepe: GoldOrder; closure: GoldOrder };
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
  quality: { alpha: [0.15, 0.3, 0.55], beta: [0.05, 0.1, 0.85], alphaAlpha: [0.13, 0.22, 0.65], alphaBeta: [0.05, 0.1, 0.85] },
  special: { pepe: { gold: 0, lmd: 1000, seconds: 4 * 3600 + 30 * 60 }, closure: { gold: 2, lmd: 1200, seconds: 2 * 3600 + 24 * 60 } },
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
    && !!params.quality && (['alpha', 'beta', 'alphaAlpha', 'alphaBeta'] as const).every(key => Array.isArray(params.quality[key]) && params.quality[key].length === params.orders.length && Math.abs(params.quality[key].reduce((a, b) => a + b, 0) - 1) < 0.011)
    && !!params.special && [params.special.pepe, params.special.closure].every(order => order && Number.isFinite(order.gold) && order.gold >= 0 && order.lmd > 0 && order.seconds >= 600 && order.seconds <= 86400)
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
  // 訂單品質表：常規／α級／β級三欄，只取每格開頭的百分比。
  const qualitySection = text.split(/====\s*贵金属订单生成概率分布受技能的影响\s*====/u)[1]?.split(/===\s*特殊订单/u)[0] ?? '';
  const qualityRows = [...qualitySection.matchAll(/\{\{材料消耗\|赤金\|(\d+)\}\}\s*\|\|\s*(\d+)%\s*\|\|\s*(\d+)%(?:\{\{[^}]*\}\})?\s*\|\|\s*(\d+)%/gu)].map(match => ({ gold: Number(match[1]), alpha: Number(match[3]) / 100, beta: Number(match[4]) / 100 }));
  const column = (key: 'alpha' | 'beta') => orders.map(order => qualityRows.find(row => row.gold === order.gold)?.[key] ?? NaN);
  const observed = (label: RegExp) => { const line = qualitySection.split('\n').find(item => label.test(item)) ?? ''; return orders.map(order => Number(line.match(new RegExp(`(\\d+)%\\s*${order.gold}赤金`, 'u'))?.[1]) / 100); };
  const quality = { alpha: column('alpha'), beta: column('beta'), alphaAlpha: observed(/α级与α级同时进驻/u), alphaBeta: observed(/α级与β级同时进驻/u) };
  const specialOrder = (name: string): GoldOrder => {
    const row = text.split(/\n\|-/u).find(item => item.includes(name)) ?? '';
    return { seconds: duration(row.match(/订单时长：(\d{1,2}:\d{2}:\d{2})/u)?.[1] ?? ''), gold: Number(row.match(/赤金交付数：(\d+)/u)?.[1]), lmd: Number(row.match(/交付报酬：(\d+)龙门币/u)?.[1]) };
  };
  const special = { pepe: specialOrder('cc.tra.pepe'), closure: specialOrder('cc.tra.closure') };
  return validateTradingParams({ orders, probability, limits: limits.slice(0, levels), quality, special, source: { name: 'PRTS wiki', url: PRTS_TRADING_URL, ...meta, note: NOTE } });
}

export interface OrderMods { alpha: number; beta: number; pepe: boolean; closure: boolean; twoGold: boolean; breach: boolean; breachBonus: number; invest: number }
export const NO_MODS: OrderMods = { alpha: 0, beta: 0, pepe: false, closure: false, twoGold: false, breach: false, breachBonus: 0, invest: 0 };

/**
 * 一筆訂單的期望值（已套用訂單技能）。優先級依 PRTS：特別獨占訂單 > 可露希爾特別訂單 > 赤金交付數固定 2 > 違約／投資。
 * fixedTime 為 true 時訂單時間不受訂單效率影響（佩佩）。
 */
export function orderModel(level: number, mods: OrderMods, params: TradingParams = DEFAULT_TRADING): { seconds: number; lmd: number; gold: number; fixedTime: boolean; notes: string[] } {
  const notes: string[] = [];
  if (mods.pepe) return { ...params.special.pepe, fixedTime: true, notes: ['所有訂單變為特別獨佔訂單（不受訂單效率影響）'] };
  if (mods.closure) return { ...params.special.closure, fixedTime: false, notes: ['所有訂單變為可露希爾特別訂單'] };
  let probability = params.probability[level - 1] ?? params.probability[params.probability.length - 1];
  if (mods.alpha || mods.beta) {
    if (level !== params.probability.length) notes.push('訂單品質技能只有 3 級貿易站的數據，此等級未計入');
    else {
      const q = params.quality;
      probability = mods.alpha && mods.beta ? q.alphaBeta : mods.beta ? q.beta : mods.alpha >= 2 ? q.alphaAlpha : q.alpha;
      if (mods.beta >= 2) notes.push('兩名 β 級品質技能同時進駐沒有觀測數據，暫以單一 β 級計算（估計）');
      if (mods.alpha + mods.beta > 2) notes.push('三名品質技能同時進駐沒有觀測數據（估計）');
      notes.push(`訂單品質為技能累積工作達峰值（α 3 小時、β 5 小時）後的分布`);
    }
  }
  let seconds = 0, lmd = 0, gold = 0;
  params.orders.forEach((order, index) => {
    const p = probability[index] ?? 0;
    if (!p) return;
    let g = order.gold, money = order.lmd;
    if (mods.twoGold) { money = money / g * 2; g = 2; }
    else if (mods.breach && g < 4) { g += mods.breachBonus; money += 500 * mods.breachBonus; }
    else if (mods.invest && g > 3) money += mods.invest;
    seconds += order.seconds * p; lmd += money * p; gold += g * p;
  });
  if (mods.twoGold) notes.push('赤金交付數固定為 2，龍門幣同步為 1000');
  if (mods.breach) notes.push(mods.breachBonus ? `少於 4 赤金的訂單視為違約訂單，交付數 +${mods.breachBonus}` : '少於 4 赤金的訂單視為違約訂單（無交付數加成）');
  if (mods.invest && !mods.twoGold) notes.push(`4 赤金訂單龍門幣 +${mods.invest}`);
  return { seconds, lmd, gold, fixedTime: false, notes };
}

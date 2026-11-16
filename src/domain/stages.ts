import type { DropRates } from '../catalog/drops.ts';

/* ------------------------------------------------------------------ */
/* 關卡與活動：活動時間、活動關卡對應、材料掉落來源。                      */
/* ------------------------------------------------------------------ */
export interface StageDrop { id: string; type: string; dropType: string; occurrence: string }
export interface Stage { id: string; code: string; name: string; type: string; zoneId: string; apCost: number | null; dangerLevel?: string; drops: StageDrop[] }
export interface GameEvent { id: string; name: string; type: string; startTime: string | null; endTime: string | null; rewardEndTime: string | null; hasStage: boolean; isRerun: boolean }

/** 遊戲內的掉落機率等級（遊戲只給等級，不給數字）。 */
export const OCCURRENCE: Record<string, { label: string; rank: number }> = {
  ALWAYS: { label: '固定', rank: 0 }, ALMOST: { label: '大概率', rank: 1 }, USUAL: { label: '概率', rank: 2 }, OFTEN: { label: '小概率', rank: 3 }, SOMETIMES: { label: '罕見', rank: 4 },
};
export const DROP_TYPE: Record<string, string> = { NORMAL: '常規', ADDITIONAL: '額外', SPECIAL: '特殊', ONCE: '首次', COMPLETE: '首通', CONDITION_DROP: '條件' };
/** 常駐關卡：主線、支線、資源收集（後者依星期開放）。 */
const PERMANENT = new Set(['MAIN', 'SUB', 'DAILY']);

export type EventPhase = 'ongoing' | 'upcoming' | 'reward' | 'ended';
export function eventPhase(event: GameEvent, now: number): EventPhase {
  const start = event.startTime ? Date.parse(event.startTime) : NaN, end = event.endTime ? Date.parse(event.endTime) : NaN, reward = event.rewardEndTime ? Date.parse(event.rewardEndTime) : NaN;
  if (start > now) return 'upcoming';
  if (end >= now) return 'ongoing';
  if (reward >= now) return 'reward';
  return 'ended';
}

/** 活動關卡：關卡所屬區域 ID 以活動 ID 開頭（例如 act4mainss → act4mainss_zone1）。 */
export function stagesOfEvent(event: GameEvent, stages: readonly Stage[]): Stage[] {
  return stages.filter(stage => stage.zoneId === event.id || stage.zoneId.startsWith(`${event.id}_`));
}

export interface MaterialSource {
  stage: Stage; drop: StageDrop; event?: GameEvent;
  /** 企鵝物流：每次掉落數、理智／件、樣本數。 */
  rate?: number; apPerItem?: number; samples?: number;
}

/** 某材料目前可以去哪裡刷：常駐關卡＋進行中活動的關卡；有企鵝物流數據時依理智／件排序。 */
export function materialSources(itemId: string, stages: readonly Stage[], events: readonly GameEvent[], now: number, drops?: DropRates | null, minSamples = 100): MaterialSource[] {
  const ongoing = events.filter(event => event.hasStage && eventPhase(event, now) === 'ongoing');
  const eventOf = new Map<string, GameEvent>();
  for (const event of ongoing) for (const stage of stagesOfEvent(event, stages)) eventOf.set(stage.id, event);
  const list: MaterialSource[] = [];
  for (const stage of stages) {
    if (!PERMANENT.has(stage.type) && !eventOf.has(stage.id)) continue;
    if (!stage.apCost || stage.id.endsWith('#f#')) continue;
    const drop = stage.drops.find(item => item.id === itemId && item.dropType !== 'ONCE' && item.dropType !== 'COMPLETE');
    if (!drop) continue;
    const stat = drops?.stages[stage.id]?.[itemId];
    const rate = stat && stat.times >= minSamples ? stat.quantity / stat.times : undefined;
    list.push({ stage, drop, ...(eventOf.get(stage.id) ? { event: eventOf.get(stage.id) } : {}), ...(rate !== undefined ? { rate, apPerItem: rate > 0 ? stage.apCost / rate : Infinity, samples: stat!.times } : {}) });
  }
  // 同一關卡的標準／磨難／簡單環境（easy_、tough_）合併，保留理智／件最低者，沒有掉率時保留標準環境。
  const merged = new Map<string, MaterialSource>();
  const better = (a: MaterialSource, b: MaterialSource) => (a.apPerItem ?? Infinity) < (b.apPerItem ?? Infinity) || ((a.apPerItem ?? Infinity) === (b.apPerItem ?? Infinity) && a.stage.id.startsWith('main_') && !b.stage.id.startsWith('main_'));
  for (const item of list) { const key = `${item.stage.zoneId}:${item.stage.code}`; const current = merged.get(key); if (!current || better(item, current)) merged.set(key, item); }
  return [...merged.values()].sort((a, b) => (a.apPerItem ?? Infinity) - (b.apPerItem ?? Infinity) || (OCCURRENCE[a.drop.occurrence]?.rank ?? 9) - (OCCURRENCE[b.drop.occurrence]?.rank ?? 9) || (a.stage.apCost ?? 0) - (b.stage.apCost ?? 0));
}

/** 預估理智：缺口 × 最佳關卡的理智／件（只在有掉率時）。 */
export function sanityEstimate(shortage: number, best: MaterialSource | undefined): number | undefined {
  return best?.apPerItem !== undefined && Number.isFinite(best.apPerItem) ? Math.ceil(shortage * best.apPerItem) : undefined;
}

export type Acquire = { kind: 'stage'; source: MaterialSource; apPerItem: number } | { kind: 'craft'; apPerItem: number; parts: { id: string; count: number }[] };
/**
 * 取得一件材料最省理智的方式：直接刷（理智／件最低的關卡）或加工站合成（各材料取得成本加總，遞迴）。
 * 只在有掉率時比較；合成的龍門幣與副產品不計入理智。
 */
export function bestAcquire(itemId: string, stages: readonly Stage[], events: readonly GameEvent[], now: number, drops: DropRates | null | undefined, recipes: Record<string, { costs: { id: string; count: number }[] }>, memo = new Map<string, Acquire | null>(), depth = 0): Acquire | null {
  if (memo.has(itemId)) return memo.get(itemId)!;
  memo.set(itemId, null);
  const source = materialSources(itemId, stages, events, now, drops)[0];
  let best: Acquire | null = source?.apPerItem !== undefined && Number.isFinite(source.apPerItem) ? { kind: 'stage', source, apPerItem: source.apPerItem } : null;
  const recipe = recipes[itemId];
  if (recipe && depth < 5) {
    const parts = recipe.costs.map(part => ({ part, acquire: bestAcquire(part.id, stages, events, now, drops, recipes, memo, depth + 1) }));
    if (parts.every(item => item.acquire)) {
      const apPerItem = parts.reduce((sum, item) => sum + item.part.count * item.acquire!.apPerItem, 0);
      if (!best || apPerItem < best.apPerItem) best = { kind: 'craft', apPerItem, parts: recipe.costs };
    }
  }
  memo.set(itemId, best);
  return best;
}

/* ------------------------------------------------------------------ */
/* 理智規劃：線性規劃一次決定整個缺口要刷哪些關卡、各幾次、哪些用合成。     */
/* 關卡一次會掉多種材料，合併計算比逐項挑最佳關卡更省；合成不計副產品。      */
/* ------------------------------------------------------------------ */
export interface FarmingPlan { runs: { stage: Stage; event?: GameEvent; runs: number; sanity: number; yields: { id: string; amount: number }[] }[]; crafts: { id: string; count: number }[]; sanity: number; craftLmd: number; unmet: string[] }
export async function farmingPlan(need: Record<string, number>, stages: readonly Stage[], events: readonly GameEvent[], now: number, drops: DropRates, recipes: Record<string, { costs: { id: string; count: number }[]; gold: number }>, minSamples = 100): Promise<FarmingPlan> {
  const { solveMin } = await import('./lp.ts');
  // 需要考慮的材料：缺口＋可合成材料的原料（遞迴）。
  const universe = new Set<string>();
  const visit = (id: string, depth: number) => { if (universe.has(id) || depth > 6) return; universe.add(id); for (const part of recipes[id]?.costs ?? []) visit(part.id, depth + 1); };
  for (const id of Object.keys(need)) if (need[id] > 0) visit(id, 0);
  const ongoing = new Map<string, GameEvent>();
  for (const event of events.filter(item => item.hasStage && eventPhase(item, now) === 'ongoing')) for (const stage of stagesOfEvent(event, stages)) ongoing.set(stage.id, event);
  const candidates = stages.filter(stage => (PERMANENT.has(stage.type) || ongoing.has(stage.id)) && stage.apCost && !stage.id.endsWith('#f#') && !/^easy_/u.test(stage.id)).map(stage => {
    const stat = drops.stages[stage.id] ?? {};
    const rates = Object.entries(stat).filter(([id, entry]) => universe.has(id) && entry.times >= minSamples && entry.quantity > 0).map(([id, entry]) => ({ id, rate: entry.quantity / entry.times }));
    return { stage, rates };
  }).filter(item => item.rates.length);
  const crafts = [...universe].filter(id => recipes[id]);
  const obtainable = new Set([...candidates.flatMap(item => item.rates.map(rate => rate.id)), ...crafts]);
  const unmet = Object.keys(need).filter(id => need[id] > 0 && !obtainable.has(id));
  const items = [...universe].filter(id => obtainable.has(id));
  const index = new Map(items.map((id, position) => [id, position]));
  // 每種材料加一個「無法取得」的補差變數，成本極高：保證可解，並找出真正取不到的材料。
  const n = candidates.length + crafts.length + items.length;
  const PENALTY = 1e6;
  const A = items.map(() => new Array(n).fill(0));
  candidates.forEach((item, j) => { for (const rate of item.rates) if (index.has(rate.id)) A[index.get(rate.id)!][j] += rate.rate; });
  crafts.forEach((id, k) => { const j = candidates.length + k; A[index.get(id)!][j] += 1; for (const part of recipes[id].costs) if (index.has(part.id)) A[index.get(part.id)!][j] -= part.count; });
  const b = items.map(id => need[id] ?? 0);
  items.forEach((_, i) => { A[i][candidates.length + crafts.length + i] = 1; });
  const c = [...candidates.map(item => item.stage.apCost ?? 0), ...crafts.map(() => 0), ...items.map(() => PENALTY)];
  const result = solveMin(c, A, b);
  if (result.status !== 'optimal') return { runs: [], crafts: [], sanity: 0, craftLmd: 0, unmet: [...unmet, ...items.filter(id => (need[id] ?? 0) > 0)] };
  for (const [i, id] of items.entries()) if (result.x[candidates.length + crafts.length + i] > 1e-6 && !unmet.includes(id)) unmet.push(id);
  const runs = candidates.map((item, j) => ({ item, x: result.x[j] })).filter(entry => entry.x > 1e-6)
    .map(({ item, x }) => { const count = Math.ceil(x - 1e-6); return { stage: item.stage, ...(ongoing.get(item.stage.id) ? { event: ongoing.get(item.stage.id) } : {}), runs: count, sanity: count * (item.stage.apCost ?? 0), yields: item.rates.filter(rate => (need[rate.id] ?? 0) > 0 || crafts.some(id => recipes[id].costs.some(part => part.id === rate.id))).map(rate => ({ id: rate.id, amount: Math.round(rate.rate * count * 10) / 10 })).sort((p, q) => q.amount - p.amount) }; })
    .sort((p, q) => q.sanity - p.sanity);
  // 同一關的標準／磨難環境合併成一列（次數與產出相加）。
  const merged = new Map<string, FarmingPlan['runs'][number]>();
  for (const run of runs) {
    const key = `${run.stage.zoneId}:${run.stage.code}`, current = merged.get(key);
    if (!current) { merged.set(key, { ...run, yields: run.yields.map(item => ({ ...item })) }); continue; }
    current.runs += run.runs; current.sanity += run.sanity;
    for (const item of run.yields) { const found = current.yields.find(entry => entry.id === item.id); if (found) found.amount = Math.round((found.amount + item.amount) * 10) / 10; else current.yields.push({ ...item }); }
  }
  runs.splice(0, runs.length, ...[...merged.values()].sort((p, q) => q.sanity - p.sanity));
  const craftList = crafts.map((id, k) => ({ id, count: Math.ceil(result.x[candidates.length + k] - 1e-6) })).filter(item => item.count > 0);
  return { runs, crafts: craftList, sanity: runs.reduce((sum, item) => sum + item.sanity, 0), craftLmd: craftList.reduce((sum, item) => sum + item.count * recipes[item.id].gold, 0), unmet };
}

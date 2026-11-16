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

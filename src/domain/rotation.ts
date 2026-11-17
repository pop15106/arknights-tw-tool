import type { BaseCatalog } from '../catalog/base.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';
import { evaluateBase, moodRates, optimizeBase, ROOM_OF, type BaseObjective, type ObjectiveWeights } from './base.ts';

/* ------------------------------------------------------------------ */
/* 多班輪替：一天分成 K 班，每班依當下心情排除「撐不完這班」的幹員再最佳化。 */
/* 跑兩輪讓第一班也考慮到前一天最後一班的心情（接近穩定狀態）。            */
/* 休息中的幹員假設在宿舍以「基礎＋氛圍」恢復（不含宿舍技能，偏保守）。      */
/* ------------------------------------------------------------------ */
export interface RotationShift {
  index: number;
  /** 從第一班開始算的小時數。 */
  startHour: number;
  assignments: Record<string, string[]>;
  products: Record<string, 'gold' | 'record'>;
  objective: BaseObjective;
  /** 本班上班者的開班心情與本班消耗。 */
  workers: { operatorId: string; facilityId: string; moodStart: number; consumed: number }[];
  /** 本班需要休息（心情未滿且沒上班）的人數。 */
  resting: number;
}
export interface RotationResult { shifts: RotationShift[]; hours: number; dormRate: number; dormCapacity: number; warnings: string[] }

export async function planRotation(base: Settings['base'], catalog: BaseCatalog, roster: readonly OwnedOperator[], definitions: ReadonlyMap<string, OperatorDefinition>, options: { shifts: number; timeBudgetMs?: number; weights?: Partial<ObjectiveWeights>; onProgress?: (done: number, total: number) => void }): Promise<RotationResult> {
  const K = Math.max(1, Math.min(4, Math.round(options.shifts))), hours = 24 / K;
  const maxMood = (id: string) => catalog.mood?.maxByOperator?.[id] ?? catalog.mood?.max ?? 24;
  const characterOf = (id: string) => catalog.meta?.[id]?.character ?? id;
  const owned = roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false));
  const dorms = base.facilities.filter(facility => facility.type === 'dormitory');
  const dormRate = Math.max(0, ...dorms.map(facility => (catalog.mood?.dormRecover?.[facility.level - 1] ?? 0) + 0.0004 * Math.min(facility.atmosphere ?? facility.level * 1000, facility.level * 1000)));
  const dormCapacity = dorms.reduce((sum, facility) => sum + (catalog.rooms.find(room => room.id === 'DORMITORY')?.phases[facility.level - 1]?.maxStationedNum ?? 0), 0);
  // 還沒上過班的人，以設施最高基礎消耗估計這班會用掉多少心情。
  const baseGuess = Math.max(1, ...base.facilities.filter(facility => facility.type !== 'dormitory').map(facility => catalog.mood?.costPerHour[ROOM_OF[facility.type]]?.[facility.level - 1] ?? 0));
  const moods = new Map<string, number>(), lastRate = new Map<string, number>();
  const moodOf = (id: string) => moods.get(characterOf(id)) ?? maxMood(id);
  const shifts: RotationShift[] = [];
  const warnings: string[] = [];
  let previous: Record<string, string[]> | undefined;
  let products: Record<string, 'gold' | 'record'> | undefined;
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = 0; index < K; index++) {
      const need = (id: string) => (lastRate.get(characterOf(id)) ?? baseGuess) * hours;
      const banned = new Set<string>();
      let available: OwnedOperator[] = [], result!: ReturnType<typeof optimizeBase>, rates: ReturnType<typeof moodRates> = [];
      // 依估計排除撐不完這班的人；最佳化後若有人被排進消耗更高的位置而撐不完，排除後重算（最多 3 次）。
      for (let attempt = 0; attempt < 3; attempt++) {
        available = owned.filter(row => !banned.has(characterOf(row.operatorId)) && moodOf(row.operatorId) >= need(row.operatorId) - 1e-6);
        const ids = new Set(available.map(row => row.operatorId));
        const facilities = base.facilities.map(facility => products?.[facility.id] ? { ...facility, product: products[facility.id] } : facility);
        const start = previous ? Object.fromEntries(Object.entries(previous).map(([id, list]) => [id, list.filter(item => ids.has(item))])) : undefined;
        result = optimizeBase({ ...base, facilities }, catalog, available, definitions, { timeBudgetMs: options.timeBudgetMs ?? 2500, weights: options.weights, ...(start ? { start } : {}), lockProducts: !!products });
        products ??= result.products;
        const finalFacilities = facilities.map(facility => products![facility.id] ? { ...facility, product: products![facility.id] } : facility);
        rates = moodRates(evaluateBase({ ...base, facilities: finalFacilities, assignments: result.assignments }, catalog, available, definitions), catalog);
        const short = rates.filter(item => Math.max(0, item.rate) * hours > moodOf(item.operatorId) + 1e-6);
        if (!short.length) break;
        for (const item of short) { banned.add(characterOf(item.operatorId)); lastRate.set(characterOf(item.operatorId), Math.max(0, item.rate)); }
      }
      const working = new Set(rates.map(item => characterOf(item.operatorId)));
      const workers = rates.map(item => ({ operatorId: item.operatorId, facilityId: item.facilityId, moodStart: Math.round(moodOf(item.operatorId) * 100) / 100, consumed: Math.round(Math.max(0, item.rate) * hours * 100) / 100 }));
      // 上班者扣心情；其他人在宿舍恢復到上限。
      for (const item of rates) { const key = characterOf(item.operatorId); moods.set(key, Math.max(0, moodOf(item.operatorId) - Math.max(0, item.rate) * hours)); lastRate.set(key, Math.max(0, item.rate)); }
      // 宿舍容量有限：心情最低的人優先進宿舍恢復，超出容量的人視為不恢復（保守）。
      const tiredRows = owned.filter(row => { const key = characterOf(row.operatorId); return !working.has(key) && moods.has(key) && moods.get(key)! < maxMood(row.operatorId); })
        .filter((row, position, list) => list.findIndex(item => characterOf(item.operatorId) === characterOf(row.operatorId)) === position)
        .sort((a, b) => moods.get(characterOf(a.operatorId))! - moods.get(characterOf(b.operatorId))!);
      const resting = tiredRows.length;
      for (const row of tiredRows.slice(0, dormCapacity || tiredRows.length)) { const key = characterOf(row.operatorId); moods.set(key, Math.min(maxMood(row.operatorId), moods.get(key)! + dormRate * hours)); }
      previous = result.assignments;
      options.onProgress?.(cycle * K + index + 1, 2 * K);
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cycle === 1) shifts.push({ index, startHour: index * hours, assignments: result.assignments, products: { ...products }, objective: result.objective, workers, resting });
    }
  }
  const tired = new Set<string>();
  for (const shift of shifts) for (const worker of shift.workers) if (worker.consumed > worker.moodStart + 1e-6) tired.add(definitions.get(worker.operatorId)?.displayName ?? worker.operatorId);
  if (tired.size) warnings.push(`以下幹員在班中可能心情歸零：${[...tired].join('、')}。`);
  const maxResting = Math.max(0, ...shifts.map(shift => shift.resting));
  if (dormCapacity && maxResting > dormCapacity) warnings.push(`同一時間最多 ${maxResting} 人心情未滿，宿舍只有 ${dormCapacity} 個位置：已讓心情最低的 ${dormCapacity} 人優先休息，其餘視為不恢復（保守估計）。`);
  if (!dormRate) warnings.push('沒有設定宿舍，無法估算恢復。');
  return { shifts, hours, dormRate: Math.round(dormRate * 100) / 100, dormCapacity, warnings };
}

/* ------------------------------------------------------------------ */
/* 匯出 MAA 自定義基建換班（resource/custom_infrast/*.json）。           */
/* 格式依 MAA 官方文件「基建排班協定」；宿舍交給 MAA 預設演算法安排休息者。 */
/* ------------------------------------------------------------------ */
const MAA_ROOM: Partial<Record<string, string>> = { control: 'control', manufacturing: 'manufacture', trading: 'trading', power: 'power', meeting: 'meeting', office: 'hire', workshop: 'processing' };
export interface MaaExportOptions { title: string; firstStart: string; drones?: { room: 'trading' | 'manufacture'; index: number } }
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function exportMaaSchedule(base: Settings['base'], rotation: RotationResult, definitions: ReadonlyMap<string, OperatorDefinition>, options: MaaExportOptions): object {
  const [h, m] = options.firstStart.split(':').map(Number);
  const first = ((Number.isFinite(h) ? h : 8) * 60 + (Number.isFinite(m) ? m : 0)) % 1440;
  const name = (id: string) => definitions.get(id)?.displayName ?? id;
  return {
    title: options.title,
    description: `由幹員檔案室產生：一天 ${rotation.shifts.length} 班、每班 ${rotation.hours} 小時。宿舍由 MAA 預設演算法安排休息者；訓練室不在 MAA 換班範圍內。`,
    plans: rotation.shifts.map(shift => {
      const start = (first + shift.startHour * 60) % 1440, end = (start + rotation.hours * 60 - 1) % 1440;
      const period = end >= start ? [[hhmm(start), hhmm(end)]] : [[hhmm(start), '23:59'], ['00:00', hhmm(end)]];
      const rooms: Record<string, object[]> = {};
      for (const facility of base.facilities) {
        const key = MAA_ROOM[facility.type];
        if (!key) continue;
        const operators = (shift.assignments[facility.id] ?? []).map(name);
        const product = facility.type === 'manufacturing' ? (shift.products[facility.id] ?? facility.product) : undefined;
        (rooms[key] ??= []).push(operators.length ? { operators, ...(product ? { product: product === 'record' ? 'Battle Record' : 'Pure Gold' } : {}) } : { skip: true });
      }
      return {
        name: `第 ${shift.index + 1} 班（${hhmm(start)} 起）`, period, duration: rotation.hours * 60,
        ...(options.drones ? { drones: { enable: true, room: options.drones.room, index: options.drones.index, order: 'pre' } } : {}),
        rooms,
      };
    }),
  };
}

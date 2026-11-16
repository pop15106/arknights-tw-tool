import type { Cost, GrowthCatalog } from '../catalog/growth.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';

/* ------------------------------------------------------------------ */
/* 養成成本：只用遊戲資料表的數值；目前狀態未知時以最低值計算並標示。      */
/* ------------------------------------------------------------------ */
export interface GrowthState { elite: number; level: number; skillLevel: number; masteries: Record<string, number>; modules: Record<string, number> }
export type GrowthPlan = NonNullable<Settings['growth']>['plans'][number];
export const LMD_ITEM = '4001';

export interface GrowthCost {
  lmd: number;
  exp: number;
  items: Record<string, number>;
  steps: { label: string; lmd: number; exp: number; items: Cost[] }[];
  notes: string[];
  /** 補足前提後實際計算的目標。 */
  target?: GrowthState;
}

const knownNumber = (row: OwnedOperator | undefined, field: string) => { const entry = row?.fields[field]; return entry?.status === 'known' && typeof entry.value === 'number' ? entry.value : undefined; };

/** 從幹員庫讀目前狀態；未知欄位以最低值代替，並列在 unknown。 */
export function currentState(row: OwnedOperator | undefined, definition: OperatorDefinition): { state: GrowthState; unknown: string[] } {
  const unknown: string[] = [];
  const read = (field: string, label: string, fallback: number) => { const value = knownNumber(row, field); if (value === undefined) { unknown.push(label); return fallback; } return value; };
  const state: GrowthState = {
    elite: read('elite', '精英階段', 0), level: read('level', '等級', 1), skillLevel: read('skillLevel', '技能等級', 1),
    masteries: Object.fromEntries(definition.skills.map((skill, index) => [skill.id, read(`mastery:${skill.id}`, `技能 ${index + 1} 專精`, 0)])),
    modules: Object.fromEntries(definition.modules.filter(module => module.levels?.length).map(module => [module.id, read(`moduleLevel:${module.id}`, `${module.name}等級`, 0)])),
  };
  return { state, unknown };
}

/** 目標的前提：專精需精英二與技能 7、技能 5 以上需精英一、模組需精英二且達解鎖等級。回傳補足前提後的目標。 */
export function normalizeTarget(target: GrowthState, definition: OperatorDefinition, catalog: GrowthCatalog, operatorId: string): { target: GrowthState; notes: string[] } {
  const notes: string[] = [];
  const next: GrowthState = { ...target, masteries: { ...target.masteries }, modules: { ...target.modules } };
  const op = catalog.operators[operatorId];
  const maxElite = Math.max(0, (op?.phases.length ?? 1) - 1);
  const raise = (elite: number, level: number, why: string) => {
    if (next.elite > elite || (next.elite === elite && next.level >= level)) return;
    if (next.elite < elite) { next.elite = elite; next.level = level; } else next.level = Math.max(next.level, level);
    notes.push(why);
  };
  if (Object.values(next.masteries).some(value => value > 0)) { if (next.skillLevel < 7) { next.skillLevel = 7; notes.push('專精需技能等級 7，已一併計入'); } raise(2, 1, '專精需精英二，已一併計入'); }
  if (next.skillLevel > 4) raise(1, 1, '技能等級 5 以上需精英一，已一併計入');
  for (const module of definition.modules) {
    if ((next.modules[module.id] ?? 0) <= 0) continue;
    raise(module.unlock?.elite ?? 2, module.unlock?.level ?? 1, `${module.name}需精英 ${module.unlock?.elite ?? 2}・等級 ${module.unlock?.level ?? 1}，已一併計入`);
  }
  next.elite = Math.min(next.elite, maxElite);
  next.level = Math.min(Math.max(1, next.level), op?.phases[next.elite]?.maxLevel ?? next.level);
  return { target: next, notes };
}

export function growthCost(catalog: GrowthCatalog, definition: OperatorDefinition, from: GrowthState, rawTarget: GrowthState): GrowthCost {
  const op = catalog.operators[definition.id];
  const result: GrowthCost = { lmd: 0, exp: 0, items: {}, steps: [], notes: [] };
  if (!op) { result.notes.push('遊戲資料沒有此幹員的養成成本。'); return result; }
  const { target, notes } = normalizeTarget(rawTarget, definition, catalog, definition.id);
  result.notes.push(...notes); result.target = target;
  const step = (label: string, lmd: number, exp: number, items: Cost[]) => {
    const materials = items.filter(item => item.id !== LMD_ITEM);
    const lmdItem = items.filter(item => item.id === LMD_ITEM).reduce((sum, item) => sum + item.count, 0);
    if (!lmd && !exp && !lmdItem && !materials.length) return;
    result.steps.push({ label, lmd: lmd + lmdItem, exp, items: materials });
    result.lmd += lmd + lmdItem; result.exp += exp;
    for (const item of materials) result.items[item.id] = (result.items[item.id] ?? 0) + item.count;
  };
  // 等級與精英化：逐階段加總每級經驗與龍門幣（資料表 index＝目前等級－1）。
  if (target.elite > from.elite || (target.elite === from.elite && target.level > from.level)) {
    for (let elite = from.elite; elite <= target.elite; elite++) {
      if (elite > from.elite) step(`精英 ${elite}`, catalog.evolveGold[op.rarity - 1]?.[elite - 1] ?? 0, 0, op.phases[elite]?.evolveCost ?? []);
      const start = elite === from.elite ? from.level : 1, end = elite === target.elite ? target.level : op.phases[elite]?.maxLevel ?? start;
      let exp = 0, gold = 0;
      for (let level = start; level < end; level++) { exp += catalog.expMap[elite]?.[level - 1] ?? 0; gold += catalog.goldMap[elite]?.[level - 1] ?? 0; }
      step(`精英 ${elite} 等級 ${start}→${end}`, gold, exp, []);
    }
  }
  for (let level = from.skillLevel; level < target.skillLevel; level++) step(`技能等級 ${level}→${level + 1}`, 0, 0, op.skillUp[level - 1] ?? []);
  definition.skills.forEach((skill, index) => {
    const steps = op.masteries[skill.id] ?? [];
    for (let level = from.masteries[skill.id] ?? 0; level < (target.masteries[skill.id] ?? 0); level++) step(`技能 ${index + 1}「${skill.name}」專精 ${level + 1}`, 0, 0, steps[level]?.cost ?? []);
  });
  for (const module of definition.modules) {
    for (let level = from.modules[module.id] ?? 0; level < (target.modules[module.id] ?? 0); level++) {
      const costs = module.levels?.find(item => item.level === level + 1)?.costs ?? [];
      step(`${module.name} ${level + 1} 級`, 0, 0, costs.map(item => ({ id: item.id, count: item.count })));
    }
  }
  return result;
}

/** 把精英材料展開成加工站可合成的低階材料（直到 minRarity 以下），並加上合成的龍門幣。 */
export function expandRecipes(catalog: GrowthCatalog, items: Record<string, number>, minRarity = 3): { items: Record<string, number>; lmd: number; crafted: Record<string, number> } {
  const out: Record<string, number> = {}, crafted: Record<string, number> = {};
  let lmd = 0;
  const add = (id: string, count: number, depth: number) => {
    const recipe = catalog.recipes[id], rarity = catalog.items[id]?.rarity ?? 0;
    if (!recipe || rarity <= minRarity || depth > 5) { out[id] = (out[id] ?? 0) + count; return; }
    crafted[id] = (crafted[id] ?? 0) + count; lmd += recipe.gold * count;
    for (const part of recipe.costs) add(part.id, part.count * count, depth + 1);
  };
  for (const [id, count] of Object.entries(items)) add(id, count, 0);
  return { items: out, lmd, crafted };
}

/** 經驗換算成作戰記錄張數（由大到小湊，最後一張可能溢出）。 */
export function expToRecords(catalog: GrowthCatalog, exp: number): { id: string; count: number }[] {
  const cards = Object.entries(catalog.expItems).sort((a, b) => b[1] - a[1]);
  if (!cards.length || exp <= 0) return [];
  const [topId, topExp] = cards[0];
  return [{ id: topId, count: Math.ceil(exp / topExp) }];
}

export function emptyTarget(definition: OperatorDefinition): GrowthState {
  return { elite: 0, level: 1, skillLevel: 1, masteries: Object.fromEntries(definition.skills.map(skill => [skill.id, 0])), modules: Object.fromEntries(definition.modules.map(module => [module.id, 0])) };
}

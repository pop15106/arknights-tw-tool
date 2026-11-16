import type { GrowthCatalog } from '../catalog/growth.ts';
import type { OperatorDefinition, OwnedOperator, Settings } from './model.ts';
import { currentState, expandRecipes, growthCost } from './growth.ts';

/* ------------------------------------------------------------------ */
/* 帳號體檢：只統計幹員庫已知的欄位；未知的另外計數，不當作未完成。        */
/* ------------------------------------------------------------------ */
export interface Checkup {
  owned: number;
  byRarity: Record<number, { owned: number; elite2: number }>;
  byProfession: { profession: string; owned: number; elite2: number; maxed: number }[];
  elite2: number; skill7: number; mastery3: number; modules: number;
  unknown: { elite: number; level: number; skillLevel: number; mastery: number; module: number };
  /** 待辦：六星未精二、精二但技能未滿、模組條件已達但未開。 */
  todo: { kind: 'sixNotE2' | 'e2Skill' | 'moduleReady'; operatorId: string; detail: string }[];
  /** 養成計畫中材料已足夠（依手動庫存）的幹員。 */
  ready: { operatorId: string; lmd: number }[];
}

const known = (row: OwnedOperator | undefined, field: string) => { const entry = row?.fields[field]; return entry?.status === 'known' ? entry.value : undefined; };

export function accountCheckup(definitions: readonly OperatorDefinition[], roster: readonly OwnedOperator[], growth?: GrowthCatalog | null, settings?: Settings['growth']): Checkup {
  const byId = new Map(definitions.map(def => [def.id, def]));
  const owned = roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false) && byId.has(row.operatorId));
  const result: Checkup = { owned: owned.length, byRarity: {}, byProfession: [], elite2: 0, skill7: 0, mastery3: 0, modules: 0, unknown: { elite: 0, level: 0, skillLevel: 0, mastery: 0, module: 0 }, todo: [], ready: [] };
  const professions = new Map<string, { owned: number; elite2: number; maxed: number }>();
  for (const row of owned) {
    const def = byId.get(row.operatorId)!;
    const elite = known(row, 'elite'), level = known(row, 'level'), skillLevel = known(row, 'skillLevel');
    if (elite === undefined) result.unknown.elite++;
    if (level === undefined) result.unknown.level++;
    if (skillLevel === undefined) result.unknown.skillLevel++;
    const rarity = result.byRarity[def.rarity] ??= { owned: 0, elite2: 0 };
    rarity.owned++;
    const profession = professions.get(def.profession) ?? { owned: 0, elite2: 0, maxed: 0 };
    profession.owned++;
    const maxLevel = growth?.operators[def.id]?.phases.at(-1)?.maxLevel;
    if (elite === 2) { result.elite2++; rarity.elite2++; profession.elite2++; }
    if (elite === (growth?.operators[def.id]?.phases.length ?? 3) - 1 && maxLevel !== undefined && level === maxLevel) profession.maxed++;
    if (skillLevel === 7) result.skill7++;
    for (const skill of def.skills) { const mastery = known(row, `mastery:${skill.id}`); if (mastery === undefined) result.unknown.mastery++; else if (mastery === 3) result.mastery3++; }
    for (const module of def.modules.filter(item => item.levels?.length)) { const value = known(row, `moduleLevel:${module.id}`); if (value === undefined) result.unknown.module++; else if (typeof value === 'number' && value >= 1) result.modules++; }
    if (def.rarity === 6 && typeof elite === 'number' && elite < 2) result.todo.push({ kind: 'sixNotE2', operatorId: def.id, detail: `目前精${elite}` });
    if (elite === 2 && typeof skillLevel === 'number' && skillLevel < 7) result.todo.push({ kind: 'e2Skill', operatorId: def.id, detail: `技能等級 ${skillLevel}` });
    if (typeof elite === 'number' && typeof level === 'number') for (const module of def.modules) {
      if (!module.levels?.length || !module.unlock) continue;
      const moduleLevel = known(row, `moduleLevel:${module.id}`);
      if (moduleLevel === 0 && (elite > module.unlock.elite || (elite === module.unlock.elite && level >= module.unlock.level))) result.todo.push({ kind: 'moduleReady', operatorId: def.id, detail: module.name });
    }
    professions.set(def.profession, profession);
  }
  result.byProfession = [...professions].map(([profession, value]) => ({ profession, ...value })).sort((a, b) => b.owned - a.owned);
  if (growth && settings?.plans.length) {
    const inventory = settings.inventory ?? {};
    for (const plan of settings.plans) {
      const def = byId.get(plan.operatorId);
      if (!def) continue;
      const cost = growthCost(growth, def, currentState(roster.find(row => row.operatorId === def.id), def).state, plan.target);
      const items = settings.expand ? expandRecipes(growth, cost.items).items : cost.items;
      if (Object.keys(items).length && Object.entries(items).every(([id, count]) => (inventory[id] ?? 0) >= count)) result.ready.push({ operatorId: def.id, lmd: cost.lmd });
    }
  }
  return result;
}

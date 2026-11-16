// 由 character_table、gamedata_const、item_table、building_data 投影出養成成本需要的欄位。
type Row = Record<string, any>;

export interface Cost { id: string; count: number }
export interface GrowthOperator {
  rarity: number;
  /** 各精英階段的等級上限與「升到此階段」的材料（精英 0 為空）。 */
  phases: { maxLevel: number; evolveCost: Cost[] }[];
  /** 技能等級 1→2 … 6→7 的材料。 */
  skillUp: Cost[][];
  /** 技能 ID → 專精 1～3 的材料與所需秒數。 */
  masteries: Record<string, { cost: Cost[]; seconds: number }[]>;
}
export interface GrowthItem { name: string; rarity: number; sortId: number; type: string }
export interface GrowthCatalog {
  version: string;
  source: string;
  /** 各精英階段每級升級所需經驗與龍門幣（index＝目前等級－1）。 */
  expMap: number[][];
  goldMap: number[][];
  /** 星級（1～6）→ 精英一、精英二的龍門幣。 */
  evolveGold: number[][];
  operators: Record<string, GrowthOperator>;
  items: Record<string, GrowthItem>;
  /** 經驗卡：物品 ID → 經驗值。 */
  expItems: Record<string, number>;
  /** 加工站合成：成品 ID → 材料與龍門幣（只收錄精英材料，用於「展開合成」）。 */
  recipes: Record<string, { costs: Cost[]; gold: number; mood: number }>;
}

const tier = (value: unknown) => Number(String(value ?? '').replace(/\D/gu, '')) || 0;
const costs = (list: unknown): Cost[] => Array.isArray(list) ? list.filter((item: Row) => typeof item?.id === 'string' && Number(item.count) > 0).map((item: Row) => ({ id: item.id, count: Number(item.count) })) : [];
const values = (row: unknown): number[] => Array.isArray((row as Row)?.values) ? (row as Row).values.map((value: unknown) => Number(value)).filter((value: number) => value >= 0) : [];

export function buildGrowthCatalog(tables: { characters: Row; skills?: Row; constants?: Row; items?: Row; building?: Row }, operatorIds: readonly string[], version: string, source: string, extraItems: readonly string[] = []): GrowthCatalog | undefined {
  const constants = tables.constants;
  if (!constants?.characterExpMap || !constants?.characterUpgradeCostMap || !constants?.evolveGoldCost) return undefined;
  const operators: Record<string, GrowthOperator> = {};
  const usedItems = new Set<string>();
  const use = (list: Cost[]) => { for (const item of list) usedItems.add(item.id); return list; };
  for (const id of operatorIds) {
    const char = tables.characters[id];
    if (!char || !Array.isArray(char.phases)) continue;
    const masteries: GrowthOperator['masteries'] = {};
    for (const skill of Array.isArray(char.skills) ? char.skills : []) {
      if (typeof skill?.skillId !== 'string' || !Array.isArray(skill.levelUpCostCond) || !skill.levelUpCostCond.length) continue;
      masteries[skill.skillId] = skill.levelUpCostCond.map((cond: Row) => ({ cost: use(costs(cond.levelUpCost)), seconds: Number(cond.lvlUpTime) || 0 }));
    }
    operators[id] = {
      rarity: tier(char.rarity),
      phases: char.phases.map((phase: Row) => ({ maxLevel: Number(phase.maxLevel) || 0, evolveCost: use(costs(phase.evolveCost)) })),
      skillUp: (Array.isArray(char.allSkillLvlup) ? char.allSkillLvlup : []).map((step: Row) => use(costs(step.lvlUpCost))),
      masteries,
    };
  }
  const itemRows = (tables.items?.items ?? {}) as Row;
  const recipes: GrowthCatalog['recipes'] = {};
  for (const row of Object.values(tables.building?.workshopFormulas ?? {}) as Row[]) {
    if (row.formulaType !== 'F_EVOLVE' || typeof row.itemId !== 'string' || recipes[row.itemId]) continue;
    recipes[row.itemId] = { costs: use(costs(row.costs)), gold: Number(row.goldCost) || 0, mood: (Number(row.apCost) || 0) / 360000 };
    usedItems.add(row.itemId);
  }
  const expItems = Object.fromEntries(Object.entries((tables.items?.expItems ?? {}) as Row).filter(([, row]) => Number(row?.gainExp) > 0).map(([itemId, row]) => [itemId, Number(row.gainExp)]));
  for (const itemId of Object.keys(expItems)) usedItems.add(itemId);
  usedItems.add('4001');
  for (const itemId of extraItems) usedItems.add(itemId);
  // 模組升級材料（模組數據塊等）在模組表，名稱一併收錄。
  for (const itemId of Object.keys(itemRows)) if (/^mod_/u.test(itemId)) usedItems.add(itemId);
  const items = Object.fromEntries([...usedItems].filter(itemId => itemRows[itemId]).map(itemId => {
    const row = itemRows[itemId];
    return [itemId, { name: String(row.name ?? itemId), rarity: tier(row.rarity), sortId: Number(row.sortId) || 0, type: String(row.itemType ?? '') }];
  }));
  return {
    version, source,
    expMap: (constants.characterExpMap as unknown[]).map(values),
    goldMap: (constants.characterUpgradeCostMap as unknown[]).map(values),
    evolveGold: (constants.evolveGoldCost as unknown[]).map(row => ((row as Row)?.values ?? []).map((value: unknown) => Number(value))),
    operators, items, expItems, recipes,
  };
}

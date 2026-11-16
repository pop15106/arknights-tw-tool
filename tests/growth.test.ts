import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrowthCatalog } from '../src/catalog/growth.ts';
import { currentState, expandRecipes, growthCost, emptyTarget, type GrowthState } from '../src/domain/growth.ts';
import type { OperatorDefinition } from '../src/domain/model.ts';

const tables = {
  characters: { char_x: { rarity: 'TIER_5', phases: [{ maxLevel: 3 }, { maxLevel: 3, evolveCost: [{ id: 'a', count: 2, type: 'MATERIAL' }] }, { maxLevel: 2, evolveCost: [{ id: 'chip', count: 1, type: 'MATERIAL' }] }],
    allSkillLvlup: [1, 2, 3, 4, 5, 6].map(step => ({ lvlUpCost: [{ id: 'book', count: step, type: 'MATERIAL' }] })),
    skills: [{ skillId: 's1', levelUpCostCond: [1, 2, 3].map(level => ({ lvlUpTime: 3600 * level, levelUpCost: [{ id: 'b', count: level, type: 'MATERIAL' }] })) }] } },
  constants: { characterExpMap: [{ values: [10, 20, -1] }, { values: [30, 40, -1] }, { values: [50, -1] }], characterUpgradeCostMap: [{ values: [1, 2, -1] }, { values: [3, 4, -1] }, { values: [5, -1] }], evolveGoldCost: [0, 1, 2, 3].map(() => ({ values: [-1, -1] })).concat([{ values: [100, 1000] }, { values: [200, 2000] }]) },
  items: { items: { a: { name: 'A', rarity: 'TIER_4' }, b: { name: 'B', rarity: 'TIER_3' }, c: { name: 'C', rarity: 'TIER_2' }, book: { name: '技巧概要', rarity: 'TIER_3' }, chip: { name: '晶片', rarity: 'TIER_5' }, '4001': { name: '龍門幣', rarity: 'TIER_4' }, '2004': { name: '高級作戰記錄', rarity: 'TIER_5' } }, expItems: { '2004': { gainExp: 2000 } } },
  building: { workshopFormulas: { 1: { formulaType: 'F_EVOLVE', itemId: 'a', goldCost: 300, apCost: 1440000, costs: [{ id: 'b', count: 3 }] } } },
};
const definition = { id: 'char_x', displayName: 'X', aliases: [], rarity: 5, profession: '近衛', branch: '', faction: '', skills: [{ id: 's1', name: '技能一' }], availability: 'available',
  modules: [{ id: 'm1', name: 'X 模組', kind: 'X', type: 'advanced', unlock: { elite: 2, level: 2 }, levels: [1, 2, 3].map(level => ({ level, attributes: [], effects: [], costs: [{ id: '4001', name: '龍門幣', count: 1000 * level }, { id: 'c', name: 'C', count: level }] })) }] } as unknown as OperatorDefinition;

test('養成成本：等級、精英化、技能、專精、模組與前提', () => {
  const catalog = buildGrowthCatalog(tables as never, ['char_x'], 'v', 'test')!;
  assert.equal(catalog.operators.char_x.rarity, 5);
  const from: GrowthState = emptyTarget(definition);
  // 精英 0 等級 1→3（10+20 經驗、1+2 龍門幣），5 星精英一 100＋A×2，等級 1→3（30+40、3+4）
  const e1 = growthCost(catalog, definition, from, { ...from, elite: 1, level: 3 });
  assert.equal(e1.exp, 100); assert.equal(e1.lmd, 3 + 100 + 7); assert.deepEqual(e1.items, { a: 2 });
  // 專精 1 → 自動補技能 7 與精英二（精英二 1000＋晶片）
  const m1 = growthCost(catalog, definition, from, { ...from, masteries: { s1: 1 } });
  assert.ok(m1.notes.some(note => /技能等級 7/.test(note)));
  assert.equal(m1.items.book, 1 + 2 + 3 + 4 + 5 + 6);
  assert.equal(m1.items.chip, 1); assert.equal(m1.items.b, 1);
  // 模組 3 級：需精英二等級 2；模組龍門幣 1000+2000+3000 計入龍門幣
  const mod = growthCost(catalog, definition, { ...from, elite: 2, level: 2, skillLevel: 7 }, { ...from, elite: 2, level: 2, skillLevel: 7, modules: { m1: 3 } });
  assert.equal(mod.lmd, 6000); assert.deepEqual(mod.items, { c: 6 });
  // 目標低於現況不計
  assert.equal(growthCost(catalog, definition, { ...from, elite: 2, level: 2 }, { ...from, elite: 1, level: 3 }).exp, 0);
});

test('展開合成與目前狀態讀取', () => {
  const catalog = buildGrowthCatalog(tables as never, ['char_x'], 'v', 'test')!;
  const expanded = expandRecipes(catalog, { a: 2, chip: 1 });
  assert.deepEqual(expanded.items, { b: 6, chip: 1 });
  assert.equal(expanded.lmd, 600);
  const { state, unknown } = currentState({ operatorId: 'char_x', fields: { elite: { status: 'known', value: 1 } } } as never, definition);
  assert.equal(state.elite, 1); assert.equal(state.level, 1);
  assert.ok(unknown.includes('等級'));
});

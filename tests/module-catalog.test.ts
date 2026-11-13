import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModules } from '../src/catalog/modules.ts';

const condition = { phase: 'PHASE_2', level: 60 };
const talent = (overrides: Record<string, unknown> = {}) => ({ talentIndex: 0, name: '合成天賦', description: null, upgradeDescription: '攻擊力+{atk:0%}', unlockCondition: condition, requiredPotentialRank: 0, isHideTalent: false, blackboard: [{ key: 'atk', value: 0.2 }], ...overrides });
function tables() {
  const advanced = { charId: 'char_test', uniEquipName: '合成模組', type: 'ADVANCED', typeName1: 'SUM', typeName2: 'X', uniEquipDesc: '<@ba.kw>模組背景</>', unlockEvolvePhase: 'PHASE_2', unlockLevel: 60,
    missionList: ['mission_test'], unlockFavors: { '1': 0, '2': 2732, '3': 10070 }, itemCost: { '1': [{ id: 'item_test', count: 2 }], '2': [{ id: 'item_missing', count: 3 }] } };
  return { equipDict: { module_original: { charId: 'char_test', uniEquipName: '原始證章', type: 'INITIAL', typeName1: 'ORIGINAL', unlockLevel: 0 }, module_advanced: advanced,
    module_patch: { ...advanced, charId: 'char_test', tmplId: 'char_patch' } }, missionList: { mission_test: { desc: '完成<@ba.kw>合成任務</>' } } };
}
function battle() {
  return { module_advanced: { phases: [1, 2, 3].map(equipLevel => ({ equipLevel, attributeBlackboard: [{ key: 'atk', value: equipLevel * 10 }, { key: 'new_stat', value: 0.25 }],
    parts: [{ target: 'TRAIT', isToken: false, overrideTraitDataBundle: { candidates: [{ additionalDescription: '合成特性+{value}', overrideDescripton: null, unlockCondition: condition, requiredPotentialRank: 0, blackboard: [{ key: 'value', value: equipLevel }] }] } },
      { target: 'TALENT_DATA_ONLY', isToken: false, addOrOverrideTalentDataBundle: { candidates: [talent(), talent({ requiredPotentialRank: 5, blackboard: [{ key: 'atk', value: 0.3 }] }), talent({ isHideTalent: true })] } }],
  })) } };
}
const items = { items: { item_test: { name: '合成材料' } } };
const favor = { favorFrames: [{ level: 0, data: { favorPoint: 0, percent: 0 } }, { level: 2732, data: { favorPoint: 2732, percent: 50 } }, { level: 10070, data: { favorPoint: 10070, percent: 100 } }] };

test('原始與進階模組全部保留，轉職按 tmplId 歸屬並附背景與任務', () => {
  const result = buildModules('char_test', tables(), battle(), items, favor);
  assert.deepEqual(result.map(module => module.id), ['module_advanced', 'module_original']);
  const original = result.find(module => module.type === 'original')!;
  assert.equal(original.levels, undefined); assert.equal(original.unlock, undefined);
  const advanced = result.find(module => module.type === 'advanced')!;
  assert.deepEqual(advanced.unlock, { elite: 2, level: 60 }); assert.equal(advanced.kind, 'SUM-X');
  assert.equal(advanced.description, '模組背景'); assert.deepEqual(advanced.missions, [{ id: 'mission_test', description: '完成合成任務' }]);
  assert.deepEqual(buildModules('char_patch', tables()).map(module => module.id), ['module_patch']);
});

test('各級屬性與效果保留潛能版本，null description 使用 upgradeDescription 並排除隱藏天賦', () => {
  const levels = buildModules('char_test', tables(), battle(), items, favor)[0].levels!;
  assert.deepEqual(levels.map(level => level.level), [1, 2, 3]);
  assert.deepEqual(levels[0].attributes, [{ key: 'atk', label: '攻擊力', value: 10 }, { key: 'new_stat', label: 'new_stat', value: 0.25 }]);
  assert.equal(levels[0].effects.length, 3);
  assert.deepEqual(levels[0].effects.map(effect => [effect.kind, effect.description, effect.potential]), [['trait', '合成特性+1', 1], ['talent', '攻擊力+20%', 1], ['talent', '攻擊力+30%', 6]]);
  assert.ok(levels[0].effects.every(effect => effect.elite === 2 && effect.level === 60));
  assert.deepEqual(levels[0].costs, [{ id: 'item_test', name: '合成材料', count: 2 }]);
  assert.equal(levels[1].costs[0].name, 'item_missing');
});

test('信賴只從 favor 表精確換算，不將原始點數當百分比或插值', () => {
  assert.deepEqual(buildModules('char_test', tables(), battle(), items, favor)[0].levels!.map(level => level.trust), [0, 50, 100]);
  assert.ok(buildModules('char_test', tables(), battle())[0].levels!.every(level => level.trust === undefined));
  const source = tables(); source.equipDict.module_advanced.unlockFavors['2'] = 2733;
  assert.equal(buildModules('char_test', source, battle(), items, favor)[0].levels![1].trust, undefined);
  const ambiguous = { favorFrames: [...favor.favorFrames, { level: 2732, data: { favorPoint: 2732, percent: 51 } }] };
  assert.equal(buildModules('char_test', tables(), battle(), items, ambiguous)[0].levels![1].trust, undefined);
});

test('同候選可回退至 description，全空文字不能繼承前級或其他潛能的效果', () => {
  const source = battle();
  const candidates = source.module_advanced.phases[1].parts[1].addOrOverrideTalentDataBundle!.candidates;
  candidates[0] = talent({ upgradeDescription: null, description: '攻擊力+{atk:0%}', blackboard: [{ key: 'atk', value: 0.4 }] });
  candidates[1] = talent({ upgradeDescription: null, description: null, requiredPotentialRank: 5 });
  const effects = buildModules('char_test', tables(), source)[0].levels![1].effects;
  assert.ok(effects.some(effect => effect.kind === 'talent' && effect.description === '攻擊力+40%' && effect.potential === 1));
  assert.ok(!effects.some(effect => effect.potential === 6));
});

test('召喚物、遊戲與地圖標籤、型態索引保留來源限制，不改成通用效果', () => {
  const source = battle(), part = source.module_advanced.phases[0].parts[1];
  Object.assign(part, { isToken: true, validInGameTag: 'roguelike', validInMapTag: 'rogue_yan' });
  part.addOrOverrideTalentDataBundle!.candidates = [talent({ validModeIndices: [0, 2] })];
  const effect = buildModules('char_test', tables(), source)[0].levels![0].effects.find(effect => effect.kind === 'talent')!;
  assert.equal(effect.isToken, true); assert.equal(effect.target, 'TALENT_DATA_ONLY');
  assert.equal(effect.validInGameTag, 'roguelike'); assert.equal(effect.validInMapTag, 'rogue_yan');
  assert.deepEqual(effect.validModeIndices, [0, 2]);
});

test('缺少戰鬥表或效果全文不編造能力，候選 null 與純文字標記可安全處理', () => {
  assert.equal(buildModules('char_test', tables())[0].levels, undefined);
  const source = battle();
  source.module_advanced.phases[0].parts = [{ target: 'TALENT_DATA_ONLY', isToken: false, addOrOverrideTalentDataBundle: { candidates: [talent({ upgradeDescription: null, description: null })] } }] as never;
  assert.deepEqual(buildModules('char_test', tables(), source)[0].levels![0].effects, []);
  source.module_advanced.phases[0].parts = [{ overrideTraitDataBundle: { candidates: null }, addOrOverrideTalentDataBundle: { candidates: null } }] as never;
  assert.deepEqual(buildModules('char_test', tables(), source)[0].levels![0].effects, []);
  source.module_advanced.phases[0].parts = [{ addOrOverrideTalentDataBundle: { candidates: [talent({ upgradeDescription: '<script>bad()</script>{missing}' })] } }] as never;
  assert.equal(buildModules('char_test', tables(), source)[0].levels![0].effects[0].description, 'bad()〔數值待核對〕');
});

test('解析器拒絕壞級別、非法屬性值及材料數量，且不改動輸入', () => {
  const data = tables(), source = battle(); const snapshot = structuredClone({ data, source });
  buildModules('char_test', data, source, items, favor);
  assert.deepEqual({ data, source }, snapshot);
  source.module_advanced.phases[0].equipLevel = 4;
  assert.throws(() => buildModules('char_test', data, source), /模組|級別|等級/);
  source.module_advanced.phases[0].equipLevel = 1; source.module_advanced.phases[0].attributeBlackboard[0].value = Infinity;
  assert.throws(() => buildModules('char_test', data, source), /屬性|數值/);
  data.equipDict.module_advanced.itemCost['1'][0].count = -1;
  assert.throws(() => buildModules('char_test', data, battle()), /材料|數量/);
});

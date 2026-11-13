import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, known, sealDataset, validateDataset, validateRoster, verifyDatasetChecksum, type OperatorDefinition } from '../src/domain/model.ts';
import { createBackup, parseBackup } from '../src/storage/backup.ts';

const date = '2026-11-13T00:00:00.000Z';
function definition() {
  return { id: 'char_test', displayName: '合成測試幹員', aliases: [], rarity: 6 as const, profession: '測試職業', branch: '測試分支', faction: '測試陣營', skills: [{ id: 'skill_test', name: '合成技能' }], modules: [{ id: 'module_test', name: '合成模組', kind: 'X' }], availability: 'unknown' as const };
}
function fixture(op: unknown = definition()) {
  return { metadata: { id: 'catalog-test', version: '1', product: 'arknights' as const, server: 'tw' as const, namespace: 'personal' as const, validFrom: date, acquiredAt: date, source: '自製合成測試資料', licenseStatus: 'self-authored' as const, checksum: `sha256:${'0'.repeat(64)}` }, operators: [op] };
}
const level = { level: 1, description: '合成技能說明' };
const talent = { name: '合成天賦', description: '合成天賦說明', elite: 0, level: 1, potential: 1 };

test('舊 v1 定義不需要新欄位；新圖像、技能說明與天賦版本保留於校驗與備份', async () => {
  const legacy = fixture();
  assert.equal(validateDataset(legacy), legacy);
  const op = { ...definition(), portrait: '/assets/operators/char_test.png',
    skills: [{ id: 'skill_test', name: '合成技能', levels: [{ ...level, description: '第一行\n第二行' }, { level: 10, description: '專精三級說明' }] }],
    talents: [talent, { ...talent, elite: 2, level: 90, potential: 6, description: '另一適用條件版本' }],
  };
  const dataset = await sealDataset({ ...fixture(op), operators: [op as OperatorDefinition] });
  await verifyDatasetChecksum(dataset);
  const state = createEmptyState(dataset);
  const restored = await parseBackup(await createBackup(state));
  assert.deepEqual(restored.dataset.operators[0], op);
  const changed = structuredClone(dataset); changed.operators[0].skills[0].levels![0].description = '已改變';
  await assert.rejects(verifyDatasetChecksum(changed), /校驗值/);
});

test('只有技能 ID 接受尾端數字括號，總長上限仍為 101', () => {
  for (const id of ['skcom_atk_up[2]', 'skcom_heal_up[3]', 'skcom_charge_cost[3]', `${'a'.repeat(98)}[2]`, 'a'.repeat(101)]) {
    const dataset = validateDataset(fixture({ ...definition(), skills: [{ id, name: '合成技能' }] }));
    assert.equal(dataset.operators[0].skills[0].id, id);
    assert.doesNotThrow(() => validateRoster([{ operatorId: 'char_test', fields: { equippedSkill: known(id, '合成資料', { importedAt: date }), [`mastery:${id}`]: known(2, '合成資料', { importedAt: date }) } }], dataset));
  }
  for (const id of ['', '[2]', '_skill[2]', 'skill[]', 'skill[-1]', 'skill[1.5]', 'skill[2][3]', 'skill[2]x', 'skill [2]', 'skill[２]', `${'a'.repeat(99)}[2]`, '<script>']) {
    assert.throws(() => validateDataset(fixture({ ...definition(), skills: [{ id, name: '合成技能' }] })), /ID|格式/);
  }
  for (const op of [{ ...definition(), id: 'char_test[2]' }, { ...definition(), modules: [{ id: 'module[2]', name: '模組', kind: 'X' }] }]) assert.throws(() => validateDataset(fixture(op)), /ID|格式/);
  assert.throws(() => validateDataset({ ...fixture(), metadata: { ...fixture().metadata, id: 'catalog[2]' } }), /ID|格式/);
});

test('portrait 只接受固定本機 PNG 路徑，不接受來源網域或路徑穿越', () => {
  for (const portrait of ['/assets/operators/char_test.png', '/assets/operators/Char-1.2.png']) assert.doesNotThrow(() => validateDataset(fixture({ ...definition(), portrait })));
  for (const portrait of ['https://example.test/a.png', '//example.test/a.png', '/assets/operators/../a.png', '/assets/operators/a/../../b.png', '/assets/operators/%2e%2e/a.png', '/assets/operators/..\\a.png', '/assets/operators/a.png?x=1', '/assets/operators/a.png#x', '/assets/operators/a.svg', 'data:image/png;base64,AAAA', null, 1, '']) {
    assert.throws(() => validateDataset(fixture({ ...definition(), portrait })), /圖像|路徑|格式/);
  }
});

test('技能說明最多十級、級別唯一且為 1 至 10 整數；文字最多 6000 字元', () => {
  const withLevels = (levels: unknown) => fixture({ ...definition(), skills: [{ id: 'skill_test', name: '合成技能', levels }] });
  assert.doesNotThrow(() => validateDataset(withLevels(Array.from({ length: 10 }, (_, index) => ({ level: index + 1, description: '甲'.repeat(6000) })))));
  assert.doesNotThrow(() => validateDataset(withLevels([])));
  for (const levels of [null, {}, Array(11).fill(level), [level, level], ...[0, 11, 1.5, '1'].map(value => [{ ...level, level: value }]), ...[null, 1, '', '甲'.repeat(6001), '控制\u0000字元'].map(description => [{ ...level, description }])]) {
    assert.throws(() => validateDataset(withLevels(levels)), /技能|文字|格式|範圍|重複/);
  }
});

test('天賦保留相同名稱的多條件版本，限制數量及精英、等級、潛能範圍', () => {
  assert.doesNotThrow(() => validateDataset(fixture({ ...definition(), talents: Array.from({ length: 30 }, (_, index) => ({ ...talent, elite: index % 3, description: '甲'.repeat(6000) })) })));
  assert.doesNotThrow(() => validateDataset(fixture({ ...definition(), talents: [] })));
  const invalid = [null, {}, Array(31).fill(talent)];
  for (const [field, values] of Object.entries({ elite: [-1, 3, 1.5, '1'], level: [0, 91, 1.5, '1'], potential: [0, 7, 1.5, '1'], description: [null, 1, '', '甲'.repeat(6001)], name: ['', null] })) {
    for (const value of values) invalid.push([{ ...talent, [field]: value }]);
  }
  for (const talents of invalid) assert.throws(() => validateDataset(fixture({ ...definition(), talents })), /天賦|文字|格式|範圍/);
});

test('新可選欄位仍拒絕 undefined、缺少子欄位與額外欄位', () => {
  const badDefinitions = [
    { ...definition(), portrait: undefined }, { ...definition(), talents: undefined }, { ...definition(), arbitrary: true },
    { ...definition(), skills: [{ id: 'skill_test', name: '技能', levels: undefined }] },
    { ...definition(), skills: [{ id: 'skill_test', name: '技能', extra: true }] },
    { ...definition(), skills: [{ id: 'skill_test', name: '技能', levels: [{ level: 1 }] }] },
    { ...definition(), skills: [{ id: 'skill_test', name: '技能', levels: [{ ...level, html: true }] }] },
    { ...definition(), talents: [{ ...talent, extra: true }] },
    { ...definition(), talents: [{ name: '天賦', description: '說明', elite: 0, level: 1 }] },
  ];
  for (const op of badDefinitions) assert.throws(() => validateDataset(fixture(op)), /undefined|必要|未允許/);
});

function moduleDetail() {
  return { id: 'module_test', name: '合成模組', kind: 'X', type: 'advanced' as const, description: '模組背景\n第二行',
    unlock: { elite: 2 as const, level: 60 }, missions: [{ id: 'mission_test', description: '合成解鎖任務' }],
    levels: [{ level: 1 as const, trust: 100, attributes: [{ key: 'atk', label: '攻擊力', value: 40.5 }],
      effects: [{ kind: 'talent' as const, name: '合成天賦', description: '攻擊力提高', elite: 2 as const, level: 60, potential: 1 as const }],
      costs: [{ id: 'item_test', name: '合成材料', count: 4 }] }],
  };
}
const withModule = (module: unknown) => fixture({ ...definition(), modules: [module] });

test('模組新欄位為可選且完整納入校驗與備份，原始模組 ID 保持可引用', async () => {
  assert.doesNotThrow(() => validateDataset(fixture()));
  const op = { ...definition(), modules: [{ id: 'module_original', name: '原始證章', kind: 'ORIGINAL', type: 'original' as const }, moduleDetail()] };
  const dataset = await sealDataset({ ...fixture(op), operators: [op] });
  const state = createEmptyState(dataset);
  state.roster = [{ operatorId: op.id, fields: { equippedModule: known('module_original', '合成資料', { importedAt: date }) } }];
  assert.deepEqual((await parseBackup(await createBackup(state))).dataset, dataset);
  const changed = structuredClone(dataset); changed.operators[0].modules[1].levels![0].effects[0].description = '改變說明';
  await assert.rejects(verifyDatasetChecksum(changed), /校驗/);
});

test('模組巢狀白名單拒絕額外、缺少、undefined 與非物件欄位', () => {
  const module = moduleDetail(), level = module.levels[0];
  const bad = [
    { ...module, arbitrary: true }, { ...module, type: undefined }, { ...module, description: null }, { ...module, unlock: { elite: 2 } },
    { ...module, unlock: { ...module.unlock, extra: true } }, { ...module, missions: [{ id: 'mission_test' }] },
    { ...module, missions: [{ ...module.missions[0], extra: true }] }, { ...module, levels: [{ ...level, extra: true }] },
    { ...module, levels: [{ ...level, attributes: [{ key: 'atk', value: 4 }] }] },
    { ...module, levels: [{ ...level, effects: [{ ...level.effects[0], extra: true }] }] },
    { ...module, levels: [{ ...level, costs: [{ ...level.costs[0], extra: true }] }] },
    ...['missions', 'levels'].flatMap(field => [null, {}, undefined].map(value => ({ ...module, [field]: value }))),
  ];
  for (const input of bad) assert.throws(() => validateDataset(withModule(input)), /undefined|必要|未允許|文字|物件|陣列/);
});

test('模組等級與條件嚴格限制，拒絕重複等級與原始模組升級', () => {
  const module = moduleDetail(), level = module.levels[0];
  const bad = [
    { ...module, type: 'future' }, { ...module, type: 'original' }, { ...module, levels: [level, level] }, { ...module, levels: Array(4).fill(level) },
    ...[0, 4, 1.5, '1'].map(value => ({ ...module, levels: [{ ...level, level: value }] })),
    ...[-1, 201, 1.5, '100'].map(trust => ({ ...module, levels: [{ ...level, trust }] })),
    ...[0, 91, '60'].map(value => ({ ...module, unlock: { elite: 2, level: value } })),
    ...[-1, 3, 1.5].map(elite => ({ ...module, unlock: { elite, level: 60 } })),
    ...[0, 7, 1.5].map(potential => ({ ...module, levels: [{ ...level, effects: [{ ...level.effects[0], potential }] }] })),
    { ...module, levels: [{ ...level, effects: [{ ...level.effects[0], kind: 'unknown' }] }] },
  ];
  for (const input of bad) assert.throws(() => validateDataset(withModule(input)), /模組|範圍|重複|支援|原始/);
});

test('模組數值不接受非有限數、非法材料數量或重複材料與任務 ID', () => {
  const module = moduleDetail(), level = module.levels[0];
  for (const value of [NaN, Infinity, -Infinity, '40']) assert.throws(() => validateDataset(withModule({ ...module, levels: [{ ...level, attributes: [{ ...level.attributes[0], value }] }] })));
  for (const count of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateDataset(withModule({ ...module, levels: [{ ...level, costs: [{ ...level.costs[0], count }] }] })));
  assert.throws(() => validateDataset(withModule({ ...module, missions: [module.missions[0], module.missions[0]] })), /重複/);
  assert.throws(() => validateDataset(withModule({ ...module, levels: [{ ...level, costs: [level.costs[0], level.costs[0]] }] })), /重複/);
  assert.throws(() => validateDataset(withModule({ ...module, levels: [{ ...level, attributes: [level.attributes[0], level.attributes[0]] }] })), /重複/);
  assert.throws(() => validateDataset(withModule({ ...module, description: '甲'.repeat(6001) })), /文字/);
});

test('模組效果來源限制可保存，但拒絕壞標籤、布林或重複型態索引', async () => {
  const module = moduleDetail(), level = module.levels[0];
  const effect = { ...level.effects[0], target: 'TALENT_DATA_ONLY', isToken: true, validInGameTag: 'roguelike', validInMapTag: 'rogue_yan', validModeIndices: [0, 2] };
  const op = { ...definition(), modules: [{ ...module, levels: [{ ...level, effects: [effect] }] }] };
  const dataset = await sealDataset({ ...fixture(op), operators: [op] });
  assert.deepEqual((await parseBackup(await createBackup(createEmptyState(dataset)))).dataset.operators[0].modules[0].levels![0].effects[0], effect);
  for (const invalid of [{ isToken: 'true' }, { target: '' }, { validInGameTag: null }, { validInMapTag: undefined },
    { validModeIndices: [0, 0] }, { validModeIndices: [-1] }, { validModeIndices: [1.5] }, { validModeIndices: ['1'] }, { validModeIndices: null }]) {
    assert.throws(() => validateDataset(withModule({ ...module, levels: [{ ...level, effects: [{ ...effect, ...invalid }] }] })));
  }
});

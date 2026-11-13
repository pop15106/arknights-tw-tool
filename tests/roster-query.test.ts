import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldKeys, known, unknown, type Evidence, type OperatorDefinition, type OwnedOperator } from '../src/domain/model.ts';
import { missingCount, queryRoster, unverifiedCount, type RosterQuery } from '../src/domain/roster-query.ts';

const date = '2026-11-13T00:00:00.000Z';
const value = (number: number, options: Parameters<typeof known>[2] = {}) => known(number, '合成列表測試', { importedAt: date, ...options });
const absent = () => unknown('合成列表測試', date);
const notApplicable = (): Evidence => ({ ...absent(), status: 'not-applicable' });

function entry(id: string, overrides: Partial<OperatorDefinition> = {}, fields: Record<string, Evidence> = {}) {
  const definition: OperatorDefinition = {
    id, displayName: id, aliases: [], rarity: 6, profession: '術師', branch: '合成分支', faction: '合成陣營',
    skills: [{ id: 'skill_test', name: '合成技能' }], modules: [{ id: 'module_test', name: '合成模組', kind: 'X' }], availability: 'unknown', ...overrides,
  };
  const row: OwnedOperator = { operatorId: id, fields: {
    ...Object.fromEntries(fieldKeys(definition).map(key => [key, notApplicable()])), elite: value(0), level: value(1), ...fields,
  } };
  return { row, definition, marker: id };
}
const ids = (items: ReturnType<typeof entry>[], options: RosterQuery = {}) => queryRoster(items, options).map(item => item.row.operatorId);

test('名稱、別名及穩定 ID 搜尋忽略大小寫與首尾空白，空搜尋保留全部', () => {
  const items = [entry('char_beta', { displayName: '合成 Beta', aliases: ['BlueBird'] }), entry('char_alpha', { displayName: '合成 Alpha' })];
  assert.deepEqual(ids(items, { search: '  ALPHA  ' }), ['char_alpha']);
  assert.deepEqual(ids(items, { search: ' blueBIRD ' }), ['char_beta']);
  assert.deepEqual(ids(items, { search: 'CHAR_BETA' }), ['char_beta']);
  assert.deepEqual(ids(items, { search: '  \t\n' }), ['char_alpha', 'char_beta']);
  assert.deepEqual(ids(items, { search: '不存在' }), []);
});

test('星級 1 至 6 及職業各自篩選，all 不限條件', () => {
  const items = ([1, 2, 3, 4, 5, 6] as const).map(rarity => entry(`char_${rarity}`, { rarity, profession: rarity % 2 ? '術師' : '醫療' }));
  for (const rarity of [1, 2, 3, 4, 5, 6] as const) assert.deepEqual(ids(items, { rarity }), [`char_${rarity}`]);
  assert.deepEqual(ids(items, { profession: '醫療' }), ['char_2', 'char_4', 'char_6']);
  assert.equal(ids(items, { profession: 'all', rarity: 'all' }).length, 6);
  assert.deepEqual(ids(items, { profession: '不存在' }), []);
});

test('精英零、各階段、未知與不適用分開，缺少欄位屬未知', () => {
  const missing = entry('char_missing'); delete missing.row.fields.elite;
  const items = [entry('char_0'), entry('char_1', {}, { elite: value(1) }), entry('char_2', {}, { elite: value(2) }),
    entry('char_unknown', {}, { elite: absent() }), entry('char_na', {}, { elite: notApplicable() }), missing];
  for (const elite of [0, 1, 2] as const) assert.deepEqual(ids(items, { elite }), [`char_${elite}`]);
  assert.deepEqual(ids(items, { elite: 'unknown' }), ['char_missing', 'char_unknown']);
  assert.equal(ids(items, { elite: 'all' }).length, 6);
});

test('缺值依定義全部欄位計算，未知與缺欄位都納入，不適用不算缺值', () => {
  const complete = entry('char_complete');
  const missing = entry('char_missing', {}, { 'mastery:skill_test': absent() });
  delete missing.row.fields.level; delete missing.row.fields['moduleAvailable:module_test'];
  assert.equal(missingCount(complete.row, complete.definition), 0);
  assert.equal(missingCount(missing.row, missing.definition), 3);
  assert.deepEqual(ids([complete, missing], { status: 'unknown' }), ['char_missing']);
  assert.equal(ids([complete, missing], { status: 'all' }).length, 2);
});

test('待核對只包含未人工確認且信心低於 0.8 的已知來源值', () => {
  const low = entry('char_low', {}, { level: value(40, { confidence: 0.79 }), 'mastery:skill_test': value(0, { confidence: 0 }) });
  const items = [low, entry('char_boundary', {}, { level: value(40, { confidence: 0.8 }) }),
    entry('char_confirmed', {}, { level: value(40, { confidence: 0.2, manuallyConfirmed: true }) }),
    entry('char_no_confidence', {}, { level: value(40) }), entry('char_unknown', {}, { level: { ...absent(), confidence: 0.1 } }),
    entry('char_na', {}, { level: { ...notApplicable(), confidence: 0.1 } })];
  assert.equal(unverifiedCount(low.row, low.definition), 2);
  for (const item of items.slice(1)) assert.equal(unverifiedCount(item.row, item.definition), 0);
  assert.deepEqual(ids(items, { status: 'unverified' }), ['char_low']);
});

test('搜尋、職業、星級、精英及資料狀態同時取交集', () => {
  const items = [entry('char_match', { aliases: ['Target'] }, { elite: value(2), level: absent() }),
    entry('char_wrong_elite', { aliases: ['Target'] }, { elite: value(1), level: absent() }),
    entry('char_wrong_rarity', { aliases: ['Target'], rarity: 5 }, { elite: value(2), level: absent() }),
    entry('char_wrong_profession', { aliases: ['Target'], profession: '醫療' }, { elite: value(2), level: absent() }),
    entry('char_complete', { aliases: ['Target'] }, { elite: value(2) }), entry('char_wrong_search', {}, { elite: value(2), level: absent() })];
  assert.deepEqual(ids(items, { search: ' target ', profession: '術師', rarity: 6, elite: 2, status: 'unknown' }), ['char_match']);
});

test('預設以穩定 ID 排序，名稱遞增與稀有度遞減均以 ID 破同', () => {
  const items = [entry('char_c', { displayName: 'Beta', rarity: 6 }), entry('char_b', { displayName: 'Alpha', rarity: 4 }), entry('char_a', { displayName: 'Alpha', rarity: 6 })];
  assert.deepEqual(ids(items), ['char_a', 'char_b', 'char_c']);
  assert.deepEqual(ids(items, { sort: 'id' }), ['char_a', 'char_b', 'char_c']);
  assert.deepEqual(ids(items, { sort: 'name' }), ['char_a', 'char_b', 'char_c']);
  assert.deepEqual(ids(items, { sort: 'rarity' }), ['char_a', 'char_c', 'char_b']);
});

test('養成排序先精英降序、同精英內等級降序，各層未知置後，最後以 ID 破同', () => {
  const missing = entry('char_g', {}, { level: value(90) }); delete missing.row.fields.elite;
  const items = [entry('char_h', {}, { elite: absent(), level: absent() }), entry('char_f'), missing,
    entry('char_d', {}, { elite: value(2), level: absent() }), entry('char_b', {}, { elite: value(2), level: value(90) }),
    entry('char_e', {}, { elite: value(1), level: value(80) }), entry('char_c', {}, { elite: value(2), level: value(1) }),
    entry('char_i', {}, { elite: notApplicable(), level: value(40) }), entry('char_a', {}, { elite: value(2), level: value(90) })];
  assert.deepEqual(ids(items, { sort: 'level' }), ['char_a', 'char_b', 'char_c', 'char_d', 'char_e', 'char_f', 'char_g', 'char_i', 'char_h']);
});

test('查詢不改動原陣列、定義或證據；回傳新陣列並保留項目型別與參照', () => {
  const items = [entry('char_b', {}, { level: value(40, { confidence: 0.6 }) }), entry('char_a')];
  const snapshot = structuredClone(items);
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(items);
  for (const sort of ['id', 'name', 'rarity', 'level'] as const) {
    const result = queryRoster(items as readonly (typeof items)[number][], { sort });
    assert.notEqual(result, items);
    for (const item of result) { assert.equal(item, items.find(original => original.marker === item.marker)); assert.equal(typeof item.marker, 'string'); }
  }
  assert.deepEqual(items, snapshot);
  assert.deepEqual(queryRoster([], { status: 'unknown', sort: 'level' }), []);
});

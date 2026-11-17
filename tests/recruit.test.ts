import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecruitCatalog } from '../src/catalog/recruit.ts';
import { recruitCombos } from '../src/domain/recruit.ts';

const gacha = {
  gachaTags: ['近衛幹員', '狙擊幹員', '近戰位', '遠程位', '高級資深幹員', '資深幹員', '輸出', '支援機械', '新手', '控場'].map((tagName, tagId) => ({ tagId: tagId + 1, tagName })),
  recruitDetail: '說明\n★\n<@rc.eml>Castle-3</>\n--------------------\n★★★\n芬 / <@rc.eml>安德切爾</>\n--------------------\n★★★★\n角峰\n--------------------\n★★★★★\n<@rc.eml>因陀羅</>\n--------------------\n★★★★★★\n能天使',
};
const characters = {
  char_286_cast3: { name: 'Castle-3', profession: 'WARRIOR', position: 'MELEE', tagList: ['支援機械'] },
  char_123_fang: { name: '芬', profession: 'PIONEER', position: 'MELEE', tagList: ['費用回復'] },
  char_x_andr: { name: '安德切爾', profession: 'SNIPER', position: 'RANGED', tagList: ['輸出'] },
  char_x_kak: { name: '角峰', profession: 'TANK', position: 'MELEE', tagList: ['防護'] },
  char_x_indra: { name: '因陀羅', profession: 'WARRIOR', position: 'MELEE', tagList: ['輸出', '控場'] },
  char_103_angel: { name: '能天使', profession: 'SNIPER', position: 'RANGED', tagList: ['輸出'] },
};

test('公招：解析可招募名單與標籤，計算組合與保底', () => {
  const catalog = buildRecruitCatalog(gacha, characters)!;
  assert.deepEqual(catalog.operators.map(op => [op.name, op.rarity, op.recruitOnly]), [['Castle-3', 1, true], ['芬', 3, false], ['安德切爾', 3, true], ['角峰', 4, false], ['因陀羅', 5, true], ['能天使', 6, false]]);
  assert.deepEqual(catalog.operators.find(op => op.name === '能天使')!.tags, ['狙擊幹員', '遠程位', '輸出', '高級資深幹員']);
  const combos = recruitCombos(catalog, ['輸出', '控場', '狙擊幹員']);
  const find = (...tags: string[]) => combos.find(item => item.tags.length === tags.length && tags.every(tag => item.tags.includes(tag)));
  assert.deepEqual(find('控場')?.operators.map(op => op.name), ['因陀羅']);
  assert.equal(find('控場')?.min, 5, '控場只有因陀羅 → 保底 5 星');
  assert.deepEqual(find('狙擊幹員', '輸出')?.operators.map(op => op.name), ['安德切爾'], '沒選高級資深幹員時不出六星');
  assert.equal(combos[0].min, 5);
  assert.ok(recruitCombos(catalog, ['高級資深幹員']).some(item => item.operators.some(op => op.name === '能天使')));
  assert.equal(recruitCombos(catalog, ['支援機械']).length, 0, '長時間招募不出一星');
  assert.equal(recruitCombos(catalog, ['支援機械'], { longTime: false })[0].min, 1);
});

test('帳號體檢：統計已知欄位、未知另計、待辦清單', async () => {
  const { accountCheckup } = await import('../src/domain/checkup.ts');
  const def = (id: string, rarity: number, modules: unknown[] = []) => ({ id, displayName: id, aliases: [], rarity, profession: '近衛', branch: '', faction: '', availability: 'available', skills: [{ id: `${id}_s1`, name: 's1' }], modules }) as never;
  const k = (value: unknown) => ({ status: 'known', value });
  const defs = [def('a', 6), def('b', 6, [{ id: 'm', name: '模組', kind: 'X', unlock: { elite: 2, level: 60 }, levels: [{ level: 1, attributes: [], effects: [], costs: [] }] }]), def('c', 5)];
  const roster = [
    { operatorId: 'a', fields: { elite: k(1), level: k(50), skillLevel: k(7) } },
    { operatorId: 'b', fields: { elite: k(2), level: k(70), skillLevel: k(6), 'mastery:b_s1': k(3), 'moduleLevel:m': k(0) } },
    { operatorId: 'c', fields: { owned: k(false) } },
  ] as never;
  const result = accountCheckup(defs, roster);
  assert.equal(result.owned, 2);
  assert.equal(result.elite2, 1); assert.equal(result.mastery3, 1); assert.equal(result.unknown.mastery, 1);
  assert.deepEqual(result.todo.map(item => item.kind).sort(), ['e2Skill', 'moduleReady', 'sixNotE2']);
});

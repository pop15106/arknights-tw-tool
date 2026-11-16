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

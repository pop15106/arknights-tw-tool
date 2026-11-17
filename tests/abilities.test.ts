import test from 'node:test';
import assert from 'node:assert/strict';
import { abilitySummary, masteryGain, parseAbilityText, type AbilitySource } from '../src/domain/abilities.ts';
import { rankMastery, skillMentions } from '../src/domain/masteryAdvice.ts';
import type { OperatorDefinition, OwnedOperator } from '../src/domain/model.ts';

const skill: AbilitySource = { kind: '技能', name: '測試', skillIndex: 2 };
const keys = (text: string, source = skill) => parseAbilityText(text, source).map(item => item.key);

test('能力解析：常見技能說明抽出正確標籤', () => {
  assert.deepEqual(new Set(keys('攻擊力+120%，攻擊造成法術傷害，同時攻擊至多3個敵人')), new Set(['arts', 'atkBuff', 'burst', 'aoe']));
  const aoe = parseAbilityText('同時攻擊至多3個敵人', skill).find(item => item.key === 'aoe');
  assert.equal(aoe?.count, 3);
  assert.ok(keys('使目標暈眩2秒').includes('stun'));
  assert.ok(keys('攻擊間隔大幅度縮短').includes('aspdBuff'));
  assert.equal(parseAbilityText('攻擊間隔大幅度縮短', skill).find(item => item.key === 'aspdBuff')?.value, 50);
  assert.ok(keys('攻擊範圍內所有友方幹員攻擊力+10%', { kind: '天賦', name: '鼓舞' }).includes('allyBuff'));
});

test('能力解析：隱匿要分清楚是「自己隱匿」還是「看穿隱匿」', () => {
  assert.ok(keys('部署後獲得隱匿').includes('camouflage'));
  assert.ok(!keys('部署後獲得隱匿').includes('reveal'));
  assert.ok(keys('攻擊範圍內的敵人隱匿失效').includes('reveal'));
});

test('能力摘要：同一能力合併出處', () => {
  const list = [...parseAbilityText('造成法術傷害', skill), ...parseAbilityText('攻擊造成法術傷害', { kind: '天賦', name: '咒' })];
  const arts = abilitySummary(list).find(item => item.key === 'arts');
  assert.deepEqual(arts?.sources, ['技能 3「測試」', '天賦「咒」']);
});

test('專精收益：比較 7 級與專精 3 的數值', () => {
  const levels = Array.from({ length: 10 }, (_, index) => ({ level: index + 1, description: `攻擊力+${100 + index * 10}%，持續20秒` }));
  const gain = masteryGain({ id: 'skchr_x_1', name: 'x', levels });
  assert.ok(gain);
  assert.deepEqual(gain.changes, ['攻擊力：160% → 190%']);
  assert.ok(gain.score > 0);
  const added = masteryGain({ id: 'skchr_x_2', name: 'y', levels: [...levels.slice(0, 9), { level: 10, description: '攻擊力+190%，持續20秒，暈眩1秒' }] });
  assert.ok(added?.changes.some(text => text.startsWith('新增')));
  assert.equal(masteryGain({ id: 'skchr_x_3', name: 'z', levels: levels.slice(0, 7) }), null);
});

test('社群提到的技能：辨識常見寫法，不誤判技力', () => {
  assert.deepEqual(skillMentions('3技能清場很強'), [2]);
  assert.deepEqual(skillMentions('推薦S2，技能1也可以'), [1, 0]);
  assert.deepEqual(skillMentions('技力回復快'), []);
});

test('專精排行：只列已精二、還沒專精 3 的技能', () => {
  const definition = { id: 'char_x', displayName: '測試員', skills: [
    { id: 'sk1', name: '一', levels: [{ level: 7, description: '攻擊力+100%' }, { level: 10, description: '攻擊力+150%' }] },
    { id: 'sk2', name: '二', levels: [{ level: 7, description: '暈眩2秒' }, { level: 10, description: '暈眩3秒' }] },
  ] } as unknown as OperatorDefinition;
  const known = (value: unknown) => ({ status: 'known', value });
  const row = (elite: number, m1: number) => ({ operatorId: 'char_x', fields: { owned: known(true), elite: known(elite), 'mastery:sk1': known(m1) } }) as unknown as OwnedOperator;
  const growth = { items: {}, operators: { char_x: { masteries: {}, skillMeta: {} } } } as never;
  const context = { growth, analyses: [] };
  const ranked = rankMastery([definition], [row(2, 3)], context, '全部');
  assert.deepEqual(ranked.map(item => item.advice.skillId), ['sk2']);
  assert.equal(rankMastery([definition], [row(1, 0)], context, '全部').length, 0);
});

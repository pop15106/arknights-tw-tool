import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSynergies } from '../src/domain/synergy.ts';
import type { OperatorDefinition } from '../src/domain/model.ts';

const op = (id: string, displayName: string, profession: string, talents: [string, string][] = [], skills: [string, string][] = []) => ({ id, displayName, aliases: [], rarity: 6, profession, branch: profession === '先鋒' ? '尖兵' : '', faction: '', availability: 'available', modules: [],
  talents: talents.map(([name, description]) => ({ name, description, elite: 2, level: 1, potential: 1 })), skills: skills.map(([name, description], index) => ({ id: `s${index}`, name, levels: [{ level: 10, description }] })) }) as unknown as OperatorDefinition;

test('相性：陣營／職業光環、需求人數、模式限定、敵人類型排除、對敵減益', () => {
  const defs = [
    op('a', '甲', '近衛', [['光環', '編入隊伍時，所有【深海獵人】幹員的生命值+20%'], ['獵殺', '對【海怪】敵人造成的傷害提升20%']]),
    op('b', '乙', '先鋒', [['衝鋒', '編入隊伍時所有【先鋒】職業幹員的部署費用-1，【尖兵】分支職業幹員部署費用額外-1']]),
    op('c', '丙', '特種', [['小隊', '編隊中有4名【萊歐斯小隊】幹員時，所有【萊歐斯小隊】幹員攻擊速度+25']]),
    op('d', '丁', '術師', [['回憶', '在【傀影與猩紅孤鑽】中，攻擊速度+10']], [['破甲', '攻擊使目標防禦力-30%，持續5秒'], ['自傷', '自身防禦力-50%，攻擊力+100%']]),
    op('e', '戊', '先鋒'), op('f', '己', '近衛'),
  ];
  const groups: Record<string, string[]> = { f: ['深海獵人'], e: ['萊歐斯小隊'] };
  const { links, debuffs } = analyzeSynergies(defs, id => groups[id] ?? [], new Set(['a', 'b', 'c', 'd', 'e', 'f']));
  const find = (provider: string, value: string) => links.find(link => link.providerId === provider && link.target.value === value);
  assert.deepEqual(find('a', '深海獵人')?.beneficiaries, ['f']);
  assert.equal(find('a', '深海獵人')?.trigger, 'squad');
  assert.ok(!links.some(link => link.target.value === '海怪'), '敵人類型不是相性');
  assert.deepEqual(find('b', '先鋒')?.beneficiaries, ['e']);
  assert.equal(find('b', '尖兵')?.target.kind, 'branch');
  assert.equal(find('c', '萊歐斯小隊')?.minCount, 4);
  assert.ok(!links.some(link => link.providerId === 'd'), '只寫模式名稱、沒有我方對象的不算相性');
  assert.deepEqual(debuffs.map(item => [item.providerId, item.status]), [['d', '防禦力降低']], '作用在自身的減益不算');
});

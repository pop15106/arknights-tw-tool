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

test('編隊建議：依職責補位、職業上限、指定必帶、缺口回報', async () => {
  const { buildSquad, TEMPLATES } = await import('../src/domain/squad.ts');
  const info = (id: string, profession: string, tags: string[], progress: number, position = 'RANGED') => ({ id, definition: { id, profession } as never, tags, position, progress, summary: id, unknown: false });
  const infos = [
    info('v1', '先鋒', ['費用回復'], 300, 'MELEE'), info('v2', '先鋒', ['費用回復'], 200, 'MELEE'),
    info('t1', '重裝', ['防護'], 250, 'MELEE'), info('h1', '醫療', ['治療'], 280),
    info('s1', '狙擊', ['輸出'], 400), info('s2', '狙擊', ['輸出', '群攻'], 350), info('s3', '狙擊', ['輸出'], 390), info('s4', '狙擊', ['輸出'], 380), info('s5', '狙擊', ['輸出'], 370),
    info('c1', '術師', ['輸出', '減速'], 100),
  ];
  const result = buildSquad(infos, TEMPLATES.general.roles, { locked: ['c1'] });
  assert.equal(result.picks[0].id, 'c1');
  assert.ok(result.picks.some(pick => pick.id === 'v1') && result.picks.some(pick => pick.id === 'v2'));
  assert.ok(result.picks.filter(pick => pick.id.startsWith('s')).length <= 4, '同職業最多 4 名');
  assert.deepEqual(result.missing.map(item => [item.role, item.got]), [['防護（阻擋）', 1], ['治療', 1]]);
});

test('依關卡推薦：飛行、高防禦、高法抗、法術攻擊、數量、領袖與建議等級', async () => {
  const { analyzeStage, stageEnemyList, parseDangerLevel } = await import('../src/domain/stagePlan.ts');
  const { parseLevelEnemies } = await import('../src/catalog/enemies.ts');
  const raw = parseLevelEnemies({ enemyDbRefs: [{ id: 'enemy_a', level: 1 }, { id: 'enemy_b', level: 0 }], waves: [{ fragments: [{ actions: [{ actionType: 'SPAWN', key: 'enemy_a', count: 20 }, { actionType: 'SPAWN', key: 'enemy_b', count: 12 }, { actionType: 'STORY', key: 'x', count: 1 }] }] }] });
  assert.deepEqual(raw, [{ id: 'enemy_a', level: 1, count: 20 }, { id: 'enemy_b', level: 0, count: 12 }]);
  const enemies = stageEnemyList(raw, {
    enemy_a: { name: '飛蟲', rank: 'NORMAL', damage: ['MAGIC'], abilities: [], levels: [{ hp: 1, atk: 1, def: 0, res: 0, motion: 'FLY' }, { hp: 2, atk: 1, def: 900, res: 0, motion: 'FLY' }] },
    enemy_b: { name: '首領', rank: 'BOSS', damage: ['PHYSIC'], abilities: ['隱匿'], levels: [{ hp: 50000, atk: 1, def: 0, res: 60, motion: 'WALK' }] },
  });
  assert.equal(enemies[0].stats.def, 900, '依關卡指定等級取數值');
  const info = (id: string, profession: string, tags: string[], position: string, progress: number) => ({ id, definition: { id, profession, rarity: 6 } as never, tags, position, progress, summary: id, unknown: false });
  const threats = analyzeStage(enemies, [info('s', '狙擊', ['輸出'], 'RANGED', 300), info('c', '術師', ['輸出', '群攻'], 'RANGED', 200), info('m', '醫療', ['治療'], 'RANGED', 100), info('g', '近衛', ['輸出', '爆發'], 'MELEE', 250)],
    [{ providerId: 'g', status: '法術抗性降低', source: { kind: '技能', name: 'x', description: '' } }]);
  assert.deepEqual(threats.map(threat => threat.key), ['fly', 'def', 'res', 'magic', 'crowd', 'boss', 'stealth']);
  assert.deepEqual(threats[0].candidates.map(item => item.id), ['s', 'c'], '飛行只推遠程輸出');
  assert.deepEqual(threats[1].candidates.map(item => item.id), ['c']);
  assert.deepEqual(threats[2].candidates.map(item => item.id), ['s', 'g']);
  assert.match(threats[2].candidates[1].reason, /法術抗性降低/);
  assert.deepEqual(parseDangerLevel('精英2 LV.1'), { elite: 2, level: 1 });
  assert.equal(parseDangerLevel('-'), undefined);
});

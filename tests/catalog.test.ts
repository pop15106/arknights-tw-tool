import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGameData, renderGameText } from '../src/catalog/build.ts';

const date = '2026-11-13T00:00:00.000Z';
const source = { commit: 'a'.repeat(40), sourceUpdatedAt: date, syncedAt: date };
function tables() {
  const char = { name: '測試幹員', rarity: 'TIER_6', profession: 'CASTER', subProfessionId: 'corecaster', nationId: 'rhodes', isNotObtainable: false,
    skills: [{ skillId: 'skcom_magic[3]' }], talents: [{ candidates: [{ name: '測試天賦', description: '攻擊力+{atk:0%}', blackboard: { atk: 0.12 }, unlockCondition: { phase: 'PHASE_2', level: 1 }, requiredPotentialRank: 4 }] }] };
  return { characters: { char_test: char, token_test: { ...char, isNotObtainable: true } }, patches: { patchChars: { char_patch: { ...char, name: '測試轉職' } } },
    skills: { 'skcom_magic[3]': { levels: [{ name: '戰術詠唱', description: '<@ba.vup>攻擊力+{atk:0%}</>，持續{duration}秒', blackboard: { atk: 0.3, duration: 10 } }] } },
    modules: { equipDict: { uniequip_test: { charId: 'char_test', uniEquipName: '測試證章', typeName1: 'ORIGINAL' }, uniequip_patch: { charId: 'char_test', tmplId: 'char_patch', uniEquipName: '轉職模組', typeName1: 'X' } }, subProfDict: { corecaster: { subProfessionName: '中堅術師' } } },
    stages: { stages: { main_test: { stageId: 'main_test', code: '0-1', name: '測試關卡', apCost: 6, stageType: 'MAIN', zoneId: 'main_0' } } },
    activities: { basicInfo: { event_test: { id: 'event_test', name: '測試活動', startTime: 1, endTime: 2, type: 'ACTIVITY' } } } };
}

test('繁中資料按 ID 合併轉職、技能、天賦與模組，輸出固定來源版本', async () => {
  const result = await buildGameData(tables(), source);
  assert.equal(result.dataset.operators.length, 2);
  const op = result.dataset.operators.find(x => x.id === 'char_test')!;
  assert.equal(op.displayName, '測試幹員');
  assert.equal(op.rarity, 6);
  assert.equal(op.profession, '術師');
  assert.equal(op.branch, '中堅術師');
  assert.equal(op.portrait, '/assets/operators/char_test.png');
  assert.equal(op.skills[0].levels?.[0].description, '攻擊力+30%，持續10秒');
  assert.equal(op.talents?.[0].description, '攻擊力+12%');
  assert.equal(op.talents?.[0].potential, 5);
  assert.deepEqual(op.modules.map(x => x.id), ['uniequip_test']);
  assert.deepEqual(result.dataset.operators.find(x => x.id === 'char_patch')!.modules.map(x => x.id), ['uniequip_patch']);
  assert.equal(result.dataset.metadata.licenseStatus, 'unknown');
  assert.equal(result.status.sourceKind, 'public-mirror');
  assert.deepEqual(result.status.counts, { operators: 2, stages: 1, events: 1 });
});

test('缺少穩定技能定義與不支援星級不產生看似成功的資料包', async () => {
  const missing = tables(); missing.skills = {} as never;
  await assert.rejects(buildGameData(missing, source), /技能/);
  const invalid = tables(); invalid.characters.char_test.rarity = 'TIER_99';
  await assert.rejects(buildGameData(invalid, source), /稀有度/);
});

test('遊戲文字只產生純文字，處理百分比與負值；未知參數明示待核對', () => {
  assert.equal(renderGameText('<@ba.vup>{atk:0%}</> / {-cost} / {missing}', { atk: 1.25, cost: 3 }), '125% / -3 / 〔數值待核對〕');
  assert.equal(renderGameText('<script>bad()</script><img src=x>文字', {}), 'bad()文字');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseCatalog, plainGameText } from '../src/catalog/base.ts';
import { candidatesFor, evaluateBase, parseSkill, recommendBase, slotResult, trainingAdvice, baseStatistics, unlockState, type Facility } from '../src/domain/base.ts';
import { createDemoBaseCatalog, createDemoDataset, createDemoImport } from '../src/demo.ts';
import { createEmptyState, known, unknown, validateAppState, type OwnedOperator } from '../src/domain/model.ts';
import { applyImport, previewImport } from '../src/domain/import.ts';

const row = (fields: Record<string, ReturnType<typeof known> | ReturnType<typeof unknown>>, operatorId = 'demo-1'): OwnedOperator => ({ operatorId, fields });

test('遊戲標記轉為純文字', () => {
  assert.equal(plainGameText('進駐製造站時，生產力<@cc.vup>+15%</>'), '進駐製造站時，生產力+15%');
  assert.equal(plainGameText('每<@cc.vup>5</>點<$cc.bd_b1><@cc.rem>人間煙火</></>'), '每5點人間煙火');
});

test('白名單句型解析；任一子句不支援即整個技能不計入', () => {
  assert.deepEqual(parseSkill({ roomType: 'MANUFACTURE', description: '進駐製造站時，生產力+15%' }), { supported: true, effects: [{ kind: 'productivity', value: 15 }] });
  assert.deepEqual(parseSkill({ roomType: 'MANUFACTURE', description: '進駐製造站時，貴金屬類配方的生產力+30%' }).effects, [{ kind: 'productivity', value: 30, product: 'gold' }]);
  assert.deepEqual(parseSkill({ roomType: 'MANUFACTURE', description: '進駐製造站時，生產力-5%，倉庫容量上限+16，心情每小時消耗-0.25' }).effects,
    [{ kind: 'productivity', value: -5 }, { kind: 'capacity', value: 16 }, { kind: 'moodCost', value: -0.25 }]);
  assert.deepEqual(parseSkill({ roomType: 'TRADING', description: '進駐貿易站時，訂單獲取效率+20%，且訂單上限+4' }).effects, [{ kind: 'order', value: 20 }, { kind: 'orderLimit', value: 4 }]);
  assert.deepEqual(parseSkill({ roomType: 'DORMITORY', description: '進駐宿舍時，該宿舍內所有幹員的心情每小時恢復+0.2（同種效果取最高）' }).effects, [{ kind: 'moodRecoverAll', value: 0.2 }]);
  for (const description of [
    '進駐製造站時，當前製造站內其他幹員提供的生產力全部歸零（不包含根據設施數量提供加成的生產力），每個發電站為當前製造站+5%的生產力',
    '進駐製造站後，生產力首小時+15%，此後每小時+2%，最終達到+25%',
    '進駐製造站時，每2個工程機器人+1%生產力',
    '進駐控制中樞時，所有製造站生產力+2%（同種效果取最高）',
  ]) assert.equal(parseSkill({ roomType: description.includes('控制中樞') ? 'CONTROL' : 'MANUFACTURE', description }).supported, false, description);
  // 房間不符也不計入
  assert.equal(parseSkill({ roomType: 'TRADING', description: '進駐製造站時，生產力+15%' }).supported, false);
});

test('解鎖判斷只用已知值；未知不推論', () => {
  assert.equal(unlockState({ elite: 1, level: 30 }, row({ elite: known(2, 't'), level: known(1, 't') })), 'ready');
  assert.equal(unlockState({ elite: 1, level: 30 }, row({ elite: known(1, 't'), level: known(29, 't') })), 'locked');
  assert.equal(unlockState({ elite: 1, level: 30 }, row({ elite: known(1, 't'), level: unknown('t') })), 'unknown');
  assert.equal(unlockState({ elite: 0, level: 1 }, row({ elite: unknown('t') })), 'unknown');
  const catalog = createDemoBaseCatalog();
  const slot = catalog.operators['demo-8'][0];
  assert.equal(slotResult(slot, row({ elite: known(1, 't'), level: known(60, 't') }, 'demo-8'), catalog).active?.id, 'demo-manu-2');
  const partial = slotResult(slot, row({ elite: known(1, 't'), level: unknown('t') }, 'demo-8'), catalog);
  assert.equal(partial.active?.id, 'demo-manu-1'); assert.equal(partial.maybeUpgraded?.id, 'demo-manu-2');
});

async function demoState() {
  const dataset = await createDemoDataset(), empty = createEmptyState(dataset);
  const preview = await previewImport(empty, createDemoImport(dataset));
  return applyImport(empty, preview, Object.fromEntries(preview.conflicts.map(item => [item.id, 'incoming'])));
}

test('配置評估：基礎加成、產品條件、未計入技能、容量與電力', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 'm1', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'p1', type: 'power', level: 1 }, { id: 't1', type: 'trading', level: 1 }];
  const evaluation = evaluateBase({ facilities, onlineSlots: [], assignments: { m1: ['demo-1', 'demo-3', 'demo-4'], t1: ['demo-2', 'demo-7'] } }, catalog, state.roster, definitions);
  const manu = evaluation.facilities[0];
  assert.equal(manu.totals.basic, 3);
  assert.equal(manu.capacity, 3);
  // demo-1 精英 2 → 流水線β +25；demo-3 精煉（赤金）+30；demo-4 歸檔是作戰記錄，不適用赤金
  assert.equal(manu.totals.productivity, 55);
  assert.ok(manu.notApplicable.some(item => item.skill.id === 'demo-record'));
  assert.ok(manu.unsupported.some(item => item.skill.id === 'demo-combo'));
  const trade = evaluation.facilities[2];
  assert.match(trade.issues.join(), /超過此等級上限 1 人/);
  assert.equal(evaluation.electricity.produced, 60); assert.equal(evaluation.electricity.consumed, 70);
  assert.match(evaluation.issues.join(), /電力不足/);
});

test('一人兩房、超過座數與未選產品都會提示', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 'c1', type: 'control', level: 1 }, { id: 'c2', type: 'control', level: 1 }, { id: 'm1', type: 'manufacturing', level: 1 }];
  const evaluation = evaluateBase({ facilities, onlineSlots: [], assignments: { c1: ['demo-1'], m1: ['demo-1'] } }, catalog, state.roster, definitions);
  assert.match(evaluation.issues.join(), /同時被安排/);
  assert.match(evaluation.issues.join(), /控制中樞最多 1 座/);
  assert.match(evaluation.facilities[2].issues.join(), /選擇製造產品/);
});

test('候選名單：已確認技能依數值排序，排除已安排的人', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const list = candidatesFor({ id: 'm1', type: 'manufacturing', level: 3, product: 'gold' }, catalog, state.roster, definitions, new Set(['demo-3']));
  assert.ok(!list.some(item => item.operatorId === 'demo-3'));
  assert.equal(list[0].state, 'ready');
  for (let i = 1; i < list.length; i++) if (list[i].state === list[i - 1].state) assert.ok(list[i].score <= list[i - 1].score);
});

test('設定保存進駐名單；格式錯誤或重複會被拒絕', async () => {
  const state = await demoState();
  const ok = { ...state, settings: { ...state.settings, base: { facilities: [{ id: 'm1', type: 'manufacturing' as const, level: 1, product: 'gold' as const }], onlineSlots: [], assignments: { m1: ['demo-1'] } } } };
  assert.doesNotThrow(() => validateAppState(ok));
  assert.throws(() => validateAppState({ ...ok, settings: { ...ok.settings, base: { ...ok.settings.base, assignments: { m1: ['demo-1', 'demo-1'] } } } }), /重複/);
  assert.throws(() => validateAppState({ ...ok, settings: { ...ok.settings, base: { ...ok.settings.base, assignments: { nope: ['demo-1'] } } } }), /未允許欄位/);
});

test('由原始 building_data 投影：只保留需要欄位與已知幹員', () => {
  const raw = {
    rooms: Object.fromEntries(['CONTROL', 'POWER', 'MANUFACTURE', 'TRADING', 'DORMITORY', 'MEETING', 'HIRE', 'TRAINING', 'WORKSHOP'].map(id => [id, { name: `<@x>${id}</>`, maxCount: 2, phases: [{ maxStationedNum: 1, electricity: -10, extra: 'ignored' }] }])),
    buffs: { 'b[000]': { buffName: '測試', roomType: 'MANUFACTURE', description: '進駐製造站時，生產力<@cc.vup>+15%</>' } },
    chars: { char_1: { buffChar: [{ buffData: [{ buffId: 'b[000]', cond: { phase: 'PHASE_1', level: 30 } }] }, { buffData: [] }] }, char_unused: { buffChar: [] } },
    manufactData: { basicSpeedBuff: 0.01 }, tradingData: { basicSpeedBuff: 0.01 },
  };
  const catalog = buildBaseCatalog(raw, ['char_1'], 'v', 's');
  assert.deepEqual(catalog.operators, { char_1: [[{ buffId: 'b[000]', elite: 1, level: 30 }]] });
  assert.equal(catalog.skills['b[000]'].description, '進駐製造站時，生產力+15%');
  assert.equal(catalog.rooms[0].name, 'CONTROL');
  assert.deepEqual(catalog.basicSpeedPercent, { MANUFACTURE: 1, TRADING: 1 });
  assert.throws(() => buildBaseCatalog({ ...raw, rooms: {} }, [], 'v', 's'), /設施/);
});

test('推薦配置：全域依分數分配、不重複、不超過容量，控制中樞不推薦', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 'm1', type: 'manufacturing', level: 2, product: 'gold' }, { id: 'm2', type: 'manufacturing', level: 1, product: 'record' }, { id: 't', type: 'trading', level: 1 }];
  const rec = recommendBase({ facilities, onlineSlots: [] }, catalog, state.roster, definitions);
  const all = Object.values(rec.assignments).flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(rec.assignments.c, []);
  assert.ok(rec.facilities[0].note?.includes('不推薦'));
  assert.ok(rec.assignments.m1.length <= 2 && rec.assignments.m2.length <= 1 && rec.assignments.t.length <= 1);
  assert.ok(rec.assignments.m1.includes('demo-3'), '赤金技能應排進赤金製造站');
  assert.deepEqual(rec.assignments.m2, ['demo-4'], '作戰記錄技能應排進作戰記錄製造站');
  assert.deepEqual(rec.assignments.t, ['demo-2'], '貿易站選訂單效率最高者');
  // 推薦結果可直接通過評估，沒有一人兩房
  const evaluation = evaluateBase({ facilities, onlineSlots: [], assignments: rec.assignments }, catalog, state.roster, definitions);
  assert.ok(!evaluation.issues.some(issue => issue.includes('同時被安排')));
});

test('推薦配置：同一間宿舍只放一位「全宿舍恢復」技能（取最高不疊加）', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  catalog.operators['demo-6'] = [[{ buffId: 'demo-dorm', elite: 0, level: 1 }]];
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const rec = recommendBase({ facilities: [{ id: 'd1', type: 'dormitory', level: 1 }, { id: 'd2', type: 'dormitory', level: 1 }], onlineSlots: [] }, catalog, state.roster, definitions);
  assert.deepEqual(rec.assignments.d1.length, 1); assert.deepEqual(rec.assignments.d2.length, 1);
});

test('練卡建議：列出確定未解鎖的下一版本與可計算增益，未知不硬給', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const { entries, domains } = trainingAdvice(catalog, state.roster, definitions, { ownedOnly: true });
  for (const entry of entries) { assert.ok(entry.owned); assert.ok(entry.requirement.elite >= (entry.current?.elite ?? 0)); }
  const sorted = entries.filter(e => e.gain !== undefined);
  for (let i = 1; i < sorted.length; i++) assert.ok((sorted[i].gain ?? 0) <= (sorted[i - 1].gain ?? 0));
  assert.ok(domains.some(d => d.room === 'MANUFACTURE'));
  // 精英未知的幹員不出現在建議（避免硬推）
  const row = state.roster.find(r => r.operatorId === 'demo-8')!;
  const unknownRow = { ...row, fields: { ...row.fields, elite: unknown('t') } };
  const result = trainingAdvice(catalog, [unknownRow], definitions, { ownedOnly: true });
  assert.equal(result.entries.length, 0);
});

test('基建統計：赤金與經驗依配方秒數與已計入生產力計算，換班依最先耗盡心情者', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 'g', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'r', type: 'manufacturing', level: 3, product: 'record' }, { id: 'd', type: 'dormitory', level: 1 }];
  const evaluation = evaluateBase({ facilities, onlineSlots: [], assignments: { g: ['demo-3'], r: ['demo-4'], d: ['demo-5'] } }, catalog, state.roster, definitions);
  const stats = baseStatistics(evaluation, catalog);
  assert.ok(stats.available);
  // 赤金：+1 基礎 +30 精煉 → 86400×1.31÷4320 = 26.2 條／日
  assert.equal(stats.goldPerDay, 26.2);
  // 記錄（3 級→III，1000 經驗、10800 秒）：+1 +30 → 86400×1.31÷10800 = 10.48 件 → 10480 經驗
  assert.equal(stats.expPerDay, 10480);
  // 宿舍不消耗心情，不列入；其餘基礎 1/時 → 24 小時 → 每天一班
  assert.ok(stats.shifts.every(s => s.label.startsWith('製造站')));
  assert.equal(stats.shifts[0].hours, 24);
  // 心情可撐 24 小時，但赤金倉庫約 24.73 小時、記錄倉庫約 12.6 小時會滿 → 依倉庫取兩班制
  assert.equal(stats.suggestion?.shifts, 2); assert.match(stats.suggestion!.text, /倉庫/);
  // 倉庫：容量 54 ÷ 重量 2 = 27 條；26.2 條／日 → 約 24.73 小時
  assert.equal(stats.manufacture.find(m => m.product === 'gold')?.storageItems, 27);
});

test('換班建議：心情消耗越快，班數越多；技能的心情消耗調整會計入', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  catalog.skills['demo-tired'] = { id: 'demo-tired', name: '示範・加班', roomType: 'MANUFACTURE', description: '進駐製造站時，生產力+30%，心情每小時消耗+1' };
  catalog.operators['demo-3'] = [[{ buffId: 'demo-tired', elite: 0, level: 1 }]];
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const evaluation = evaluateBase({ facilities: [{ id: 'g', type: 'manufacturing', level: 3, product: 'gold' }], onlineSlots: [], assignments: { g: ['demo-3'] } }, catalog, state.roster, definitions);
  const stats = baseStatistics(evaluation, catalog);
  assert.equal(stats.shifts[0].hours, 12); assert.equal(stats.shifts[0].rate, 2);
  assert.match(stats.suggestion!.text, /^兩班制，每 12 小時換班；最先累的人約 12 小時/);
});

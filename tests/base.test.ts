import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseCatalog, plainGameText } from '../src/catalog/base.ts';
import { candidatesFor, evaluateBase, parseSkill, recommendBase, slotResult, trainingAdvice, baseStatistics, optimizeBase, baseObjective, compareLayout, layoutFacilities, LAYOUTS, simulateShift, unlockState, type Facility } from '../src/domain/base.ts';
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
    '進駐製造站時，當前製造站內其他幹員提供的生產力全部歸零（不包含根據設施數量提供加成的生產力），每有1個標準化類技能為當前製造站+5%的生產力',
    '進駐製造站時，如果有2台以上作業平台進駐在發電站，則生產力+2%',
    '進駐控制中樞時，提升線索板上某條線索的價值',
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
  assert.equal(stats.suggestion?.shifts, 2); assert.match(stats.suggestion!.text, /倉庫或訂單/);
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

test('龍門幣：依訂單效率與各等級訂單期望值換算，並算出貿易站消耗的赤金', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const evaluation = evaluateBase({ facilities: [{ id: 't', type: 'trading', level: 3 }], onlineSlots: [], assignments: { t: ['demo-2'] } }, catalog, state.roster, definitions);
  const stats = baseStatistics(evaluation, catalog);
  // 3 級：期望時間 0.3×8640+0.5×12600+0.2×16560 = 12204 秒；期望 1450 龍門幣、2.9 赤金
  // 效率 +1 基礎 +30 議價 = 31% → 86400×1.31÷12204 = 9.2742 筆／日
  assert.equal(stats.trading[0].efficiency, 31);
  assert.equal(stats.trading[0].ordersPerDay, 9.27);
  assert.equal(stats.lmdPerDay, Math.round(86400 * 1.31 / 12204 * 1450));
  assert.equal(stats.goldConsumedPerDay, Math.round(86400 * 1.31 / 12204 * 2.9 * 100) / 100);
  // 常規訂單每條赤金固定換 500 龍門幣
  assert.ok(Math.abs(stats.lmdPerDay - stats.goldConsumedPerDay * 500) < 5);
});

test('搭配技能：解析四種寫法；陣營條件保留無條件部分', () => {
  assert.deepEqual(parseSkill({ roomType: 'TRADING', description: '當與德克薩斯在同一個貿易站時，心情每小時消耗-0.1，訂單上限+4' }),
    { supported: true, effects: [], conditional: { partner: '德克薩斯', effects: [{ kind: 'moodCost', value: -0.1 }, { kind: 'orderLimit', value: 4 }] } });
  assert.deepEqual(parseSkill({ roomType: 'TRADING', description: '進駐貿易站時，訂單獲得效率+20%；當與能天使在同一個貿易站時，訂單獲得效率額外+25%' }),
    { supported: true, effects: [{ kind: 'order', value: 20 }], conditional: { partner: '能天使', effects: [{ kind: 'order', value: 25 }] } });
  assert.equal(parseSkill({ roomType: 'MANUFACTURE', description: '進駐製造站時，當與溫米在同一個製造站時，貴金屬類配方的生產力+15%' }).conditional?.partner, '溫米');
  const faction = parseSkill({ roomType: 'MANUFACTURE', description: '進駐製造站時，作戰記錄類配方的生產力+30%，當與烏薩斯學生自治團幹員在同一個製造站時，作戰記錄類配方的生產力額外+10%' });
  assert.deepEqual(faction.effects, [{ kind: 'productivity', value: 30, product: 'record' }]); assert.equal(faction.conditional, undefined); assert.match(faction.ignoredCondition!, /烏薩斯/);
});

function comboCatalog() {
  const catalog = createDemoBaseCatalog();
  catalog.skills['c-a'] = { id: 'c-a', name: '示範・恩怨', roomType: 'TRADING', description: '當與示範・青禾在同一個貿易站時，心情每小時消耗+0.3，訂單獲取效率+65%' };
  catalog.skills['c-b'] = { id: 'c-b', name: '示範・醉翁', roomType: 'TRADING', description: '當與示範・霧航在同一個貿易站時，心情每小時消耗-0.1，訂單上限+4' };
  catalog.operators['demo-2'] = [[{ buffId: 'c-a', elite: 0, level: 1 }]];
  catalog.operators['demo-7'] = [[{ buffId: 'c-b', elite: 0, level: 1 }]];
  catalog.operators['demo-8'] = [[{ buffId: 'demo-trade', elite: 0, level: 1 }]];
  return catalog;
}

test('搭配技能：搭檔同房才計入，否則列為搭配未成立；心情調整進入換班計算', async () => {
  const state = await demoState(), catalog = comboCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 't', type: 'trading', level: 3 }];
  const alone = evaluateBase({ facilities, onlineSlots: [], assignments: { t: ['demo-2'] } }, catalog, state.roster, definitions).facilities[0];
  assert.equal(alone.totals.order, 0); assert.equal(alone.comboMissing[0]?.partner, '示範・青禾');
  const together = evaluateBase({ facilities, onlineSlots: [], assignments: { t: ['demo-2', 'demo-7'] } }, catalog, state.roster, definitions);
  assert.equal(together.facilities[0].totals.order, 65); assert.equal(together.facilities[0].comboMissing.length, 0);
  const stats = baseStatistics(together, catalog);
  assert.equal(stats.shifts[0].rate, 1.3, '恩怨的心情消耗 +0.3 計入');
});

test('推薦配置：搭檔組合整組排進同一座設施', async () => {
  const state = await demoState(), catalog = comboCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const rec = recommendBase({ facilities: [{ id: 't', type: 'trading', level: 3 }, { id: 't2', type: 'trading', level: 1 }], onlineSlots: [] }, catalog, state.roster, definitions);
  assert.ok(rec.assignments.t.includes('demo-2') && rec.assignments.t.includes('demo-7'), JSON.stringify(rec.assignments));
});

test('陣營：同設施、全基建（含上限）與控制中樞跨設施加成依目前配置計算；隱藏標籤不計', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.meta = { 'demo-1': { groups: ['甲團'] }, 'demo-2': { groups: ['甲團'] }, 'demo-4': { groups: ['甲團'] }, 'demo-7': { groups: ['乙團'] } };
  catalog.skills['g-room'] = { id: 'g-room', name: '示範・同伴', roomType: 'TRADING', description: '進駐貿易站時，同個貿易站中每有1名甲團幹員，當前貿易站訂單獲取效率+20%' };
  catalog.skills['g-base'] = { id: 'g-base', name: '示範・人脈', roomType: 'MANUFACTURE', description: '進駐製造站時，基建內（不包含副手及活動室使用者）每有1名甲團幹員（最多2名），貴金屬類配方的生產力+3%' };
  catalog.skills['g-ctrl'] = { id: 'g-ctrl', name: '示範・指揮', roomType: 'CONTROL', description: '進駐控制中樞時，自身心情每小時消耗+0.5；每個進駐在貿易站的乙團幹員，訂單獲得效率+5%' };
  catalog.skills['g-tag'] = { id: 'g-tag', name: '示範・旗手', roomType: 'CONTROL', description: '進駐控制中樞時，每個進駐在製造站的騎士幹員生產力+7%' };
  catalog.operators['demo-2'] = [[{ buffId: 'g-room', elite: 0, level: 1 }]];
  catalog.operators['demo-3'] = [[{ buffId: 'g-base', elite: 0, level: 1 }]];
  catalog.operators['demo-5'] = [[{ buffId: 'g-ctrl', elite: 0, level: 1 }]];
  catalog.operators['demo-6'] = [[{ buffId: 'g-tag', elite: 0, level: 1 }]];
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 't', type: 'trading', level: 3 }, { id: 'm', type: 'manufacturing', level: 3, product: 'gold' }];
  const ev = evaluateBase({ facilities, onlineSlots: [], assignments: { c: ['demo-5', 'demo-6'], t: ['demo-2', 'demo-1', 'demo-7'], m: ['demo-3', 'demo-4'] } }, catalog, state.roster, definitions);
  const [control, trade, manu] = ev.facilities;
  assert.equal(trade.totals.order, 40 + 20 + 5, '同站甲團 2 名×20（含自身）＋demo-7 原有長單 +20＋中樞對乙團 1 名 +5');
  assert.equal(trade.remote[0].value, 5);
  assert.equal(manu.totals.productivity, 6, '基建內甲團 3 名但上限 2 名 → +6');
  assert.ok(control.unsupported.some(item => item.skill.id === 'g-tag'), '騎士是隱藏標籤，沒有成員資料 → 未計入');
});

test('同一角色的不同形態不能同時進駐，推薦也只排一處', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.meta = { 'demo-8': { groups: [], character: 'demo-1' }, 'demo-1': { groups: [] } };
  const ev = evaluateBase({ facilities: [{ id: 'a', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'b', type: 'manufacturing', level: 3, product: 'gold' }], onlineSlots: [], assignments: { a: ['demo-1'], b: ['demo-8'] } }, catalog, state.roster, definitions);
  assert.match(ev.issues.join(), /不同形態是同一位幹員/);
  const rec = recommendBase({ facilities: [{ id: 'a', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'b', type: 'manufacturing', level: 3, product: 'gold' }], onlineSlots: [] }, catalog, state.roster, definitions);
  const all = Object.values(rec.assignments).flat();
  assert.ok(!(all.includes('demo-1') && all.includes('demo-8')));
});

test('訂單技能：台服原文可解析，並進入龍門幣與赤金消耗計算', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.skills['q-b'] = { id: 'q-b', name: '裁縫·β', roomType: 'TRADING', description: '進駐貿易站時，提升當前貿易站高品質貴金屬訂單的出現機率（工作時長影響機率），心情每小時消耗-0.25' };
  catalog.operators['demo-2'] = [[{ buffId: 'q-b', elite: 0, level: 1 }]];
  assert.deepEqual(parseSkill(catalog.skills['q-b']).effects, [{ kind: 'orderMod', mod: 'qualityBeta' }, { kind: 'moodCost', value: -0.25 }]);
  const ev = evaluateBase({ facilities: [{ id: 't', type: 'trading', level: 3 }], onlineSlots: [], assignments: { t: ['demo-2'] } }, catalog, state.roster, definitions);
  const stats = baseStatistics(ev, catalog);
  // 效率 +1%：86400×1.01÷(0.05×8640+0.1×12600+0.85×16560) 筆 × 1900
  const seconds = 0.05 * 8640 + 0.1 * 12600 + 0.85 * 16560;
  assert.equal(stats.lmdPerDay, Math.round(86400 * 1.01 / seconds * 1900));
  assert.equal(stats.shifts[0].rate, 0.75);
});

test('人間煙火：依產生來源加總（分心情高低），再套用到依數量加成的技能（取較低值）', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.meta = { 'demo-3': { groups: ['歲'] }, 'demo-6': { groups: ['歲'] } };
  catalog.skills['s-ling'] = { id: 's-ling', name: '山河遠闊', roomType: 'CONTROL', description: '進駐控制中樞時，當自身心情大於12時，人間煙火+15；當自身心情處於12以下時，感知資訊+10' };
  catalog.skills['s-chong'] = { id: 's-chong', name: '知我為我', roomType: 'CONTROL', description: '進駐控制中樞時，自身心情每小時消耗+0.5；每個歲幹員進駐在宿舍和活動室以外的設施則人間煙火+5（最多5名）' };
  catalog.skills['s-shu'] = { id: 's-shu', name: '稻禾厚', roomType: 'MANUFACTURE', description: '進駐製造站時，每3點人間煙火+1%生產力' };
  catalog.skills['s-wu'] = { id: 's-wu', name: '願者上鉤', roomType: 'TRADING', description: '進駐貿易站時，宿舍內每有1名幹員則人間煙火+1，同時每有1點人間煙火，則訂單獲取效率+1%' };
  catalog.operators['demo-1'] = [[{ buffId: 's-ling', elite: 0, level: 1 }]];
  catalog.operators['demo-2'] = [[{ buffId: 's-chong', elite: 0, level: 1 }]];
  catalog.operators['demo-3'] = [[{ buffId: 's-shu', elite: 0, level: 1 }]];
  catalog.operators['demo-4'] = [[{ buffId: 's-wu', elite: 0, level: 1 }]];
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 'm', type: 'manufacturing', level: 3, product: 'gold' }, { id: 't', type: 'trading', level: 3 }, { id: 'd', type: 'dormitory', level: 5 }];
  const ev = evaluateBase({ facilities, onlineSlots: [], assignments: { c: ['demo-1', 'demo-2', 'demo-6'], m: ['demo-3'], t: ['demo-4'], d: ['demo-5', 'demo-7'] } }, catalog, state.roster, definitions);
  // 心情高：令 15＋重岳（歲 2 名在宿舍外）10＋烏有（宿舍 2 人）2 = 27；心情低：無令 = 12
  assert.deepEqual([ev.resources[0].high, ev.resources[0].low, ev.resources[0].used], [27, 12, 12]);
  const manu = ev.facilities[1], trade = ev.facilities[2];
  assert.equal(manu.totals.productivity, 4, '黍：floor(12/3)×1%');
  assert.equal(trade.totals.order, 12, '烏有：12 點 ×1%');
  assert.equal(parseSkill(catalog.skills['s-ling']).ignoredCondition, '心情 12 以下時的感知資訊');
});

test('整體最佳化：結果不比起點差、不重複排人、不超過容量；赤金不足時龍門幣按供應打折', async () => {
  const state = await demoState(), catalog = comboCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 't', type: 'trading', level: 3 }, { id: 'm', type: 'manufacturing', level: 2, product: 'gold' }, { id: 'p', type: 'power', level: 1 }];
  const result = optimizeBase({ facilities, onlineSlots: [] }, catalog, state.roster, definitions, { timeBudgetMs: 3000 });
  assert.ok(result.objective.total >= result.start.total);
  const all = Object.values(result.assignments).flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(result.assignments.m.length <= 2 && result.assignments.p.length <= 1 && result.assignments.t.length <= 3);
  // 只有貿易站、沒有赤金來源 → 赤金供應 0，耗赤金的訂單收益歸零
  const noGold = evaluateBase({ facilities: [{ id: 't', type: 'trading', level: 3 }], onlineSlots: [], assignments: { t: ['demo-2', 'demo-7'] } }, catalog, state.roster, definitions);
  const objective = baseObjective(noGold, catalog);
  assert.equal(objective.goldFactor, 0); assert.equal(objective.trading, -100);
});

test('權重：整體效益依各產出權重加總，權重為 0 時不計該項', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const ev = evaluateBase({ facilities: [{ id: 'g', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'r', type: 'manufacturing', level: 3, product: 'record' }], onlineSlots: [], assignments: { g: ['demo-3'], r: ['demo-4'] } }, catalog, state.roster, definitions);
  const equal = baseObjective(ev, catalog);
  assert.equal(equal.gold, 31); assert.equal(equal.record, 31); assert.equal(equal.total, 62);
  assert.equal(baseObjective(ev, catalog, { gold: 0, record: 2, trading: 1, power: 1 }).total, 62);
  assert.equal(baseObjective(ev, catalog, { gold: 3, record: 0, trading: 1, power: 1 }).total, 93);
});

test('布局比較：每種布局建立正確設施數量，並各自最佳化、回報電力', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const count = (id: string, type: string) => layoutFacilities(LAYOUTS.find(item => item.id === id)!).filter(f => f.type === type).length;
  assert.deepEqual([count('243', 'trading'), count('243', 'manufacturing'), count('243', 'power')], [2, 4, 3]);
  assert.deepEqual([count('153', 'trading'), count('153', 'manufacturing'), count('153', 'power')], [1, 5, 3]);
  assert.deepEqual([count('252', 'trading'), count('252', 'manufacturing'), count('252', 'power')], [2, 5, 2]);
  const result = compareLayout(LAYOUTS[0], catalog, state.roster, definitions, { timeBudgetMs: 1500 });
  const all = Object.values(result.assignments).flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(result.electricity.produced > 0);
});

test('控制中樞：全域加成取最高、赤金限定加成相加；心情恢復補滿空位並延長工作時間', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.skills['g1'] = { id: 'g1', name: '示範・統籌', roomType: 'CONTROL', description: '進駐控制中樞時，所有製造站生產力+2%（同種效果取最高）' };
  catalog.skills['g2'] = { id: 'g2', name: '示範・統籌β', roomType: 'CONTROL', description: '進駐控制中樞時，所有製造站生產力+5%（同種效果取最高）' };
  catalog.skills['g3'] = { id: 'g3', name: '示範・鍍金', roomType: 'CONTROL', description: '進駐控制中樞時，所有生產貴金屬類配方的製造站生產力+3%' };
  catalog.skills['mood'] = { id: 'mood', name: '示範・下午茶', roomType: 'CONTROL', description: '進駐控制中樞時，控制中樞內所有幹員的心情每小時恢復+0.05' };
  catalog.operators['demo-5'] = [[{ buffId: 'g1', elite: 0, level: 1 }]];
  catalog.operators['demo-6'] = [[{ buffId: 'g2', elite: 0, level: 1 }]];
  catalog.operators['demo-7'] = [[{ buffId: 'g3', elite: 0, level: 1 }]];
  catalog.operators['demo-8'] = [[{ buffId: 'mood', elite: 0, level: 1 }]];
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 'g', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'r', type: 'manufacturing', level: 3, product: 'record' }];
  const ev = evaluateBase({ facilities, onlineSlots: [], assignments: { c: ['demo-5', 'demo-6', 'demo-7', 'demo-8'], g: ['demo-3'], r: ['demo-4'] } }, catalog, state.roster, definitions);
  assert.equal(ev.facilities[1].totals.productivity, 30 + 5 + 3, '赤金站：精煉 30＋取最高 5＋赤金限定 3');
  assert.equal(ev.facilities[2].totals.productivity, 30 + 5, '記錄站：歸檔 30＋取最高 5');
  assert.equal(baseStatistics(ev, catalog).shifts.find(item => item.label.startsWith('控制'))?.rate, 0.95, '中樞 1 人恢復 0.05 → 每人 0.95/時');
  const opt = optimizeBase({ facilities, onlineSlots: [] }, catalog, state.roster, definitions, { timeBudgetMs: 2000 });
  assert.ok(opt.assignments.c.includes('demo-6'), '最佳化會把加成最高的中樞技能排進去');
  assert.ok(opt.moodFilled.includes('demo-8') || opt.assignments.c.includes('demo-8'));
});

test('功能設施：會客室（含只有自己時）、辦公室（含宿舍等級）、訓練室（依職業與專精）、加工站（依類別）', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const add = (id: string, roomType: string, description: string, operator: string) => { catalog.skills[id] = { id, name: id, roomType, description }; catalog.operators[operator] = [[{ buffId: id, elite: 0, level: 1 }]]; };
  add('m1', 'MEETING', '進駐會客室時，線索蒐集速度提升20%，且更容易獲得黑鋼國際線索', 'demo-1');
  add('m2', 'MEETING', '進駐會客室時，如果會客室內只有自身處於工作狀態時，線索蒐集速度提升30%，心情每小時消耗+1', 'demo-2');
  add('h1', 'HIRE', '進駐人力辦公室時，人脈資源的聯絡速度+20%，每間宿舍每級額外+1%人脈資源的聯絡速度', 'demo-3');
  add('t1', 'TRAINING', '進駐訓練室協助位時，重裝幹員的專精技能訓練速度+30%，如果本次訓練專精技能至3級，則訓練速度額外+45%', 'demo-4');
  add('w1', 'WORKSHOP', '進駐加工站加工精英材料時，副產品的產出機率提升70%', 'demo-5');
  assert.deepEqual(parseSkill(catalog.skills.m1).effects.at(-1), { kind: 'qualitative', text: '更容易獲得黑鋼國際線索' });
  assert.equal(parseSkill(catalog.skills.w1).effects[0].kind === 'byproduct' && (parseSkill(catalog.skills.w1).effects[0] as { category: string }).category, 'elite');
  const facilities: Facility[] = [{ id: 'me', type: 'meeting', level: 3 }, { id: 'of', type: 'office', level: 3 }, { id: 'tr', type: 'training', level: 3 }, { id: 'ws', type: 'workshop', level: 3 }, { id: 'd1', type: 'dormitory', level: 5 }, { id: 'd2', type: 'dormitory', level: 3 }];
  const run = (extra: Partial<{ training: { profession?: string; mastery?: 1 | 2 | 3 }; workshop: 'elite' | 'skill' | 'base' | 'any' }>, meeting = ['demo-1', 'demo-2']) =>
    evaluateBase({ facilities, onlineSlots: [], assignments: { me: meeting, of: ['demo-3'], tr: ['demo-4'], ws: ['demo-5'] }, ...extra } as never, catalog, state.roster, definitions).facilities;
  let [me, of, tr, ws] = run({});
  assert.equal(me.totals.clue, 20, '兩人同房，只有自己時的技能不生效');
  assert.equal(of.totals.contact, 20 + 8, '宿舍等級 5＋3 = 8');
  assert.equal(tr.totals.training, 0, '未設定職業時不計職業限定加成');
  assert.equal(ws.totals.byproduct, 0);
  [me, of, tr, ws] = run({ training: { profession: '重裝', mastery: 3 }, workshop: 'elite' }, ['demo-2']);
  assert.equal(me.totals.clue, 30); assert.equal(tr.totals.training, 75); assert.equal(ws.totals.byproduct, 70);
});

test('通用資源：產生→轉化→依數量／門檻加成，含招募位與全基建等級上限', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const add = (id: string, roomType: string, description: string, operator: string) => { catalog.skills[id] = { id, name: id, roomType, description }; catalog.operators[operator] = [[{ buffId: id, elite: 0, level: 1 }]]; };
  add('sense', 'MANUFACTURE', '進駐製造站時，宿舍內每有1名幹員則感知資訊+1，同時每1點感知資訊轉化為1點思維鏈環', 'demo-1');
  add('chain', 'MANUFACTURE', '進駐製造站時，每1點思維鏈環+1%生產力', 'demo-3');
  add('robot', 'MANUFACTURE', '進駐製造站時，基建內除活動室外每間設施每級+1個工程機器人，上限64個', 'demo-4');
  add('robotUse', 'MANUFACTURE', '進駐製造站時，每8個工程機器人+5%生產力', 'demo-5');
  add('recruit', 'HIRE', '進駐人力辦公室時，每個招募位（不包含初始招募位）+15點無聲共鳴', 'demo-6');
  add('song', 'TRADING', '進駐貿易站時，每2點無聲共鳴+1%訂單效率', 'demo-7');
  add('drink', 'MEETING', '進駐會客室時，線索蒐集速度提升5%，同時每1點情報儲備額外提升5%', 'demo-8');
  const parsed = parseSkill(catalog.skills.sense).effects;
  assert.deepEqual(parsed.map(e => e.kind), ['resource', 'convert']);
  const facilities: Facility[] = [{ id: 'm1', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'm2', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'of', type: 'office', level: 3 }, { id: 't', type: 'trading', level: 3 }, { id: 'me', type: 'meeting', level: 3 }, { id: 'd', type: 'dormitory', level: 5 }];
  const ev = evaluateBase({ facilities, onlineSlots: [], recruitSlots: 2, assignments: { m1: ['demo-1', 'demo-3', 'demo-4'], m2: ['demo-5'], of: ['demo-6'], t: ['demo-7'], me: ['demo-8'], d: ['demo-2'] } } as never, catalog, state.roster, definitions);
  const pool = (name: string) => ev.resources.find(r => r.name === name)?.used;
  assert.equal(pool('思維鏈環'), 1, '宿舍 1 人 → 感知資訊 1 → 轉化為思維鏈環 1');
  assert.equal(pool('感知資訊'), 0, '轉化後扣除');
  assert.equal(pool('工程機器人'), 3 + 3 + 3 + 3 + 3 + 5, '設施等級合計 20（未達上限 64）');
  assert.equal(pool('無聲共鳴'), 30, '2 個招募位 × 15');
  const [m1, m2, , trade, meeting] = ev.facilities;
  assert.equal(m1.totals.productivity, 1, '思維鏈環 1 點 → +1%');
  assert.equal(m2.totals.productivity, 10, '工程機器人 20 個 → floor(20/8)=2 → +10%');
  assert.equal(trade.totals.order, 15, '無聲共鳴 30 → floor(30/2) → +15%');
  assert.equal(meeting.totals.clue, 5, '沒有情報儲備時只有基礎 5%');
});

test('心情條件：落差、心情門檻、除自身以外工作中人數依目前心情計算；心情 0 視為停工', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const add = (id: string, roomType: string, description: string, operator: string) => { catalog.skills[id] = { id, name: id, roomType, description }; catalog.operators[operator] = [[{ buffId: id, elite: 0, level: 1 }]]; };
  add('drop', 'MANUFACTURE', '進駐製造站時，生產力+30%，自身每有4點心情落差，生產力-5%', 'demo-3');
  add('low', 'MANUFACTURE', '進駐製造站時，當自身心情落差大於12時，生產力+10%，倉庫容量+6', 'demo-4');
  add('others', 'TRADING', '進駐貿易站時，貿易站內除自身以外每名處於工作狀態的幹員+15%訂單獲取效率', 'demo-2');
  const facilities: Facility[] = [{ id: 'm', type: 'manufacturing', level: 3, product: 'gold' }, { id: 't', type: 'trading', level: 3 }];
  const base = { facilities, onlineSlots: [], assignments: { m: ['demo-3', 'demo-4'], t: ['demo-2', 'demo-1', 'demo-7'] } };
  const full = evaluateBase(base, catalog, state.roster, definitions);
  assert.equal(full.facilities[0].totals.productivity, 30, '滿心情：無落差、未達門檻');
  assert.equal(full.facilities[1].totals.order, 30 + 20, '其他工作中 2 名 ×15＋demo-7 長單 20');
  const tired = evaluateBase(base, catalog, state.roster, definitions, { 'demo-3': 10, 'demo-4': 8, 'demo-1': 0 });
  assert.equal(tired.facilities[0].totals.productivity, 30 - 15 + 10, '落差 14 → floor(14/4)=3 → −15；demo-4 落差 16 > 12 → +10');
  assert.equal(tired.facilities[1].operators.length, 2, 'demo-1 心情 0 停工');
  assert.equal(tired.facilities[1].totals.order, 15 + 20);
});

test('班次模擬：心情逐步下降、歸零時間、整班平均產量與宿舍休息可行性', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.skills['tired'] = { id: 'tired', name: '示範・加班', roomType: 'MANUFACTURE', description: '進駐製造站時，生產力+30%，心情每小時消耗+1' };
  catalog.operators['demo-3'] = [[{ buffId: 'tired', elite: 0, level: 1 }]];
  const facilities: Facility[] = [{ id: 'm', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'd', type: 'dormitory', level: 5 }];
  const sim = simulateShift({ facilities, onlineSlots: [], assignments: { m: ['demo-3'], d: [] } }, catalog, state.roster, definitions, { hours: 16, step: 0.5 });
  assert.equal(sim.zeroAt[0]?.hours, 12, '每小時消耗 2 → 12 小時歸零');
  assert.ok(sim.average.goldPerDay < sim.start.goldPerDay, '歸零後停工，整班平均低於開班時');
  assert.equal(Math.round(sim.average.goldPerDay / sim.start.goldPerDay * 100), 75, '16 小時中工作 12 小時');
  // 宿舍 5 級：2.0＋0.0004×5000＝4.0／時；消耗 24 → 6 小時；兩班輪替可休息 16 小時以上
  assert.equal(sim.rest?.dormRate, 4); assert.equal(sim.rest?.restHours, 6); assert.ok(sim.rest?.feasible);
});

test('宿舍：單人恢復取最高、全宿舍恢復同一人疊加後取最高（招募位、發電站、宿舍等級）、休息以最快宿舍計', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const add = (id: string, description: string, operator: string) => { catalog.skills[id] = { id, name: id, roomType: 'DORMITORY', description }; catalog.operators[operator] = [[{ buffId: id, elite: 0, level: 1 }]]; };
  add('single', '進駐宿舍時，使該宿舍內除自身以外心情未滿的某個幹員每小時恢復+0.7（同種效果取最高）；同時自身心情每小時恢復+0.1', 'demo-1');
  add('recruit', '進駐宿舍時，該宿舍內所有幹員心情每小時恢復+0.15，同時每個招募位（不包含初始招募位）額外+0.05恢復效果（疊加後的最終值同種效果取最高）', 'demo-2');
  add('plants', '進駐宿舍時，該宿舍內所有幹員的心情每小時恢復+0.1，同時每有1間發電站，則恢復效果額外+0.05（疊加後的最終值同種效果取最高）', 'demo-3');
  assert.deepEqual(parseSkill(catalog.skills.single).effects.map(e => e.kind), ['dormSingle', 'moodRecoverSelf']);
  const facilities: Facility[] = [{ id: 'd1', type: 'dormitory', level: 5 }, { id: 'd2', type: 'dormitory', level: 1 }, { id: 'p1', type: 'power', level: 1 }, { id: 'p2', type: 'power', level: 1 }, { id: 'm', type: 'manufacturing', level: 3, product: 'gold' }];
  const base = { facilities, onlineSlots: [], recruitSlots: 3, assignments: { d1: ['demo-1', 'demo-2', 'demo-3'], d2: [], m: ['demo-4'] } };
  const dorm = evaluateBase(base as never, catalog, state.roster, definitions).facilities[0];
  assert.equal(dorm.totals.dormSingle, 0.7);
  assert.equal(dorm.totals.moodRecoverAll, 0.3, 'demo-2：0.15＋3×0.05＝0.30；demo-3：0.1＋2×0.05＝0.20 → 取最高 0.30');
  const sim = simulateShift(base as never, catalog, state.roster, definitions, { hours: 12 });
  assert.equal(sim.rest?.dormRate, 2 + 2 + 0.3 + 0.7, '5 級宿舍：基礎 2.0＋氛圍 2.0＋全體 0.3＋單人 0.7');
});

test('第 4 階段：產品條件、他人在場、同房陣營、設施數量／等級（含上限）、時間爬升、所有宿舍恢復', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.meta = { 'demo-8': { groups: ['乙團'] } };
  const add = (id: string, roomType: string, description: string, operator: string) => { catalog.skills[id] = { id, name: id, roomType, description }; catalog.operators[operator] = [[{ buffId: id, elite: 0, level: 1 }]]; };
  add('rec', 'MANUFACTURE', '進駐製造站時，生產作戰記錄類配方時，倉庫容量上限+12', 'demo-1');
  add('pres', 'MANUFACTURE', '進駐製造站時，若示範・霧航在貿易站，則作戰記錄類配方的生產力+35%', 'demo-3');
  add('ramp', 'MANUFACTURE', '進駐製造站後，生產力首小時+20%，此後每小時+1%，最終達到+25%', 'demo-4');
  add('lvl', 'TRADING', '進駐貿易站時，訂單獲取效率+25%，會客室每級額外提供5%獲取效率，最多提供40%效率', 'demo-2');
  add('grp', 'TRADING', '進駐貿易站時，訂單獲得效率+30%；目前貿易站內存在乙團幹員時，訂單獲得效率額外+10%', 'demo-7');
  add('dorm', 'CONTROL', '進駐控制中樞時，所有宿舍內所有幹員的心情每小時恢復+0.05（同種效果取最高）', 'demo-5');
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 'r', type: 'manufacturing', level: 3, product: 'record' }, { id: 'g', type: 'manufacturing', level: 3, product: 'gold' }, { id: 't', type: 'trading', level: 3 }, { id: 'me', type: 'meeting', level: 3 }, { id: 'd', type: 'dormitory', level: 5 }];
  const base = { facilities, onlineSlots: [], assignments: { c: ['demo-5'], r: ['demo-1', 'demo-3'], g: ['demo-4'], t: ['demo-2', 'demo-7', 'demo-8'], me: [], d: [] } };
  const ev = evaluateBase(base, catalog, state.roster, definitions);
  const [, record, gold, trade] = ev.facilities;
  assert.equal(record.totals.productivity, 35, '霧航（demo-2）在貿易站 → 作戰記錄 +35');
  assert.equal(gold.totals.productivity, Math.round((20 + 21 + 22 + 23 + 24 + 25 * 7) / 12 * 100) / 100, '時間爬升以 12 小時平均計');
  assert.equal(trade.totals.order, 25 + 15 + 30 + 10, '會客室 3 級 ×5＝15（未達上限 40）；同站有乙團 → +10');
  assert.equal(evaluateBase(base, catalog, state.roster, definitions, undefined, 0).facilities[2].totals.productivity, 20, '開班第 0 小時為首小時值');
  assert.equal(evaluateBase(base, catalog, state.roster, definitions, undefined, 10).facilities[2].totals.productivity, 25, '第 10 小時已達上限');
  const stats = baseStatistics(ev, catalog);
  assert.equal(stats.manufacture.find(item => item.product === 'record')?.storageItems, Math.floor((54 + 12) / 5), '生產作戰記錄時倉庫 +12');
  const sim = simulateShift(base, catalog, state.roster, definitions, { hours: 12 });
  assert.equal(sim.rest?.dormRate, 2 + 2 + 0.05, '宿舍：基礎 2.0＋氛圍 2.0＋所有宿舍恢復 0.05');
});

test('其他幹員加成歸零：只留持有者本人與依設施數量的加成', () => {
  const zero = parseSkill({ roomType: 'MANUFACTURE', description: '進駐製造站時，當前製造站內其他幹員提供的生產力全部歸零（不包含根據設施數量提供加成的生產力），每個發電站為當前製造站+5%的生產力' });
  assert.equal(zero.supported, true);
  assert.deepEqual(zero.effects[0], { kind: 'zeroOthers', stat: 'productivity' });
  const wulian = parseSkill({ roomType: 'TRADING', description: '進駐貿易站時，當前貿易站內其他幹員提供的訂單獲取效率全部歸零，且每人為自身+45%訂單獲取效率，同時全體心情每小時消耗+0.25' });
  assert.equal(wulian.supported, true);
  assert.equal(wulian.effects.length, 3);
});

test('消除心情消耗、訂單上限與赤金生產線句型', () => {
  const p = (roomType: string, description: string) => parseSkill({ roomType, description });
  assert.deepEqual(p('MANUFACTURE', '進駐製造站時，消除當前製造站內所有幹員自身心情消耗的影響').effects, [{ kind: 'moodNeutral', scope: 'room' }]);
  assert.deepEqual(p('CONTROL', '進駐控制中樞時，消除當前控制中樞內所有歲幹員自身心情消耗的影響').effects, [{ kind: 'moodNeutral', scope: 'room', group: '歲' }]);
  assert.deepEqual(p('CONTROL', '當與豐川祥子一起進駐控制中樞時，消除自身心情消耗的影響').effects, [{ kind: 'ifPresent', name: '豐川祥子', where: 'CONTROL', effect: { kind: 'moodNeutral', scope: 'self' } }]);
  assert.deepEqual(p('TRADING', '進駐貿易站時，當前貿易站每級+1個訂單上限').effects, [{ kind: 'scaleBy', by: 'roomLevel', per: 1, effect: { kind: 'orderLimit', value: 1 } }]);
  assert.deepEqual(p('TRADING', '進駐貿易站時，訂單取得效率+20%，且訂單上限-2（訂單最少為1）').effects, [{ kind: 'order', value: 20 }, { kind: 'orderLimit', value: -2 }]);
  assert.deepEqual(p('TRADING', '進駐貿易站時，當前貿易站內幹員提升的每5個訂單上限，提供25%訂單取得效率，最多提供100%效率').effects, [{ kind: 'perOrderLimit', per: 5, value: 25, max: 100 }]);
  assert.deepEqual(p('TRADING', '進駐貿易站時，每有1條赤金生產線，則當前貿易站訂單獲取效率+5%').effects, [{ kind: 'perGoldLines', per: 1, effect: { kind: 'order', value: 5 } }]);
  assert.deepEqual(p('TRADING', '進駐貿易站時，訂單獲取效率+5%，每有2條赤金生產線，則為當前貿易站額外提供2條赤金生產線').effects, [{ kind: 'order', value: 5 }, { kind: 'perGoldLines', per: 2, effect: { kind: 'goldLine', value: 2 } }]);
  // 依當下訂單數變動：可計算但標示估計
  const gap = p('TRADING', '進駐貿易站時，當前訂單數與訂單上限每差1筆訂單，則訂單獲取效率+4%');
  assert.deepEqual(gap.effects, [{ kind: 'orderCount', mode: 'perGap', value: 4 }]);
  assert.ok(gap.estimate);
});

test('中樞同伴條件、訓練陣營、宿舍目標條件與疊加型加成', () => {
  const p = (roomType: string, description: string) => parseSkill({ roomType, description });
  assert.deepEqual(p('CONTROL', '當與龍門近衛局幹員進駐控制中樞一起工作時，所有製造站生產力+3%（同種效果取最高）').effects, [{ kind: 'ifGroupInRoom', group: '龍門近衛局', effect: { kind: 'global', target: 'MANUFACTURE', value: 3, maxOnly: true } }]);
  assert.deepEqual(p('CONTROL', '當與阿進駐控制中樞一起工作時，控制中樞內所有幹員心情每小時恢復+0.25').effects, [{ kind: 'ifPresent', name: '阿', where: 'CONTROL', effect: { kind: 'moodRoom', value: -0.25 } }]);
  assert.deepEqual(p('MANUFACTURE', '進駐製造站時，目前製造站內所有幹員心情每小時消耗-0.1').effects, [{ kind: 'moodRoom', value: -0.1 }]);
  assert.deepEqual(p('TRAINING', '進駐訓練室協助位時，基建內（不包含副手及活動室使用者）每名薩米幹員為目前幹員的專精技能訓練速度+10%（最多生效3名）').effects, [{ kind: 'perGroup', scope: 'base', group: '薩米', max: 3, per: { kind: 'training', value: 10 } }]);
  const branch = p('TRAINING', '進駐訓練室協助位時，近衛幹員的專精技能訓練速度+30%，如果訓練位幹員分支為鬥士，則訓練速度額外+45%');
  assert.deepEqual(branch.effects, [{ kind: 'training', value: 30, professions: ['近衛'] }]);
  assert.ok(branch.ignoredCondition?.includes('鬥士'));
  const dorm = p('DORMITORY', '進駐宿舍時，該宿舍內所有幹員的心情每小時恢復+0.15，如果目標是萊歐斯小隊幹員，則恢復效果額外+0.15（同種效果取最高）');
  assert.deepEqual(dorm.effects, [{ kind: 'moodRecoverAll', value: 0.15 }]);
  assert.deepEqual(p('TRADING', '進駐貿易站時，當前貿易站內幹員提供的每5%訂單獲取效率，額外提供5%效率，最多提供25%效率').effects, [{ kind: 'perRoomStat', stat: 'order', per: 5, value: 5, max: 25, others: false }]);
  assert.deepEqual(p('TRAINING', '進駐訓練室協助近衛幹員訓練專精技能至3級時，心情每小時消耗+1').effects, [{ kind: 'whenTraining', professions: ['近衛'], atMastery: 3, effect: { kind: 'moodCost', value: 1 } }]);
  assert.deepEqual(p('HIRE', '進駐人力辦公室時，每個招募位（不包含初始招募位）+10%人脈資源的聯絡速度').effects, [{ kind: 'scaleBy', by: 'recruitSlots', per: 1, effect: { kind: 'contact', value: 10 } }]);
});

test('名詞表：技能類別、作業平台、深海獵人特殊加成、指定幹員所在設施', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.meta = { 'demo-3': { groups: ['作業平台'] }, 'demo-4': { groups: ['深海獵人'] }, 'demo-6': { groups: ['深海獵人'] } };
  catalog.skillCategories = { 標準化類: ['標準化·α'], 萊茵科技類: ['萊茵科技·α'] };
  catalog.terms = { 'cc.c.abyssal2_1': { name: '特殊加成', description: '每有1個深海獵人幹員進駐製造站，則控制中樞給每個進駐深海獵人的製造站提供5%生產力，最多給單個製造站提供45%生產力' } };
  const add = (id: string, name: string, roomType: string, description: string, operator: string, terms?: string[]) => { catalog.skills[id] = { id, name, roomType, description, ...(terms ? { terms } : {}) }; catalog.operators[operator] = [[{ buffId: id, elite: 0, level: 1 }]]; };
  add('std', '標準化·α', 'MANUFACTURE', '進駐製造站時，生產力+15%', 'demo-1');
  add('rhine', '萊茵科技·α', 'MANUFACTURE', '進駐製造站時，生產力+15%', 'demo-2');
  add('cat', '意識協議', 'MANUFACTURE', '進駐製造站時，當前製造站內每個標準化類技能為自身+5%的生產力', 'demo-5');
  add('plat', '機械精通', 'MANUFACTURE', '進駐製造站時，每有1台作業平台進駐發電站，貴金屬類配方的生產力+10%', 'demo-7');
  add('abyss', '集群狩獵·α', 'CONTROL', '進駐控制中樞時，控制中樞內所有幹員的心情每小時恢復+0.05；基建內（不包含副手及活動室使用者）深海獵人幹員獲得特殊加成（與部分技能有特殊疊加規則）', 'demo-8', ['cc.c.abyssal2_1']);
  const facilities: Facility[] = [{ id: 'c', type: 'control', level: 5 }, { id: 'm1', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'm2', type: 'manufacturing', level: 3, product: 'gold' }, { id: 'p', type: 'power', level: 3 }];
  const ev = evaluateBase({ facilities, onlineSlots: [], assignments: { c: ['demo-8'], m1: ['demo-1', 'demo-2', 'demo-5'], m2: ['demo-4', 'demo-6', 'demo-7'], p: ['demo-3'] } }, catalog, state.roster, definitions);
  const [, m1, m2] = ev.facilities;
  assert.equal(m1.totals.productivity, 15 + 15 + 5, '只有 1 個標準化類技能');
  // 意識相容：萊茵科技類也算作標準化類
  add('alias', '意識相容', 'MANUFACTURE', '進駐製造站時，當前製造站內所有萊茵科技類、紅松騎士團類技能也全都視作標準化類技能', 'demo-3');
  const ev2 = evaluateBase({ facilities, onlineSlots: [], assignments: { c: ['demo-8'], m1: ['demo-1', 'demo-2', 'demo-5', 'demo-3'], m2: [], p: [] } }, catalog, state.roster, definitions);
  assert.equal(ev2.facilities[1].totals.productivity, 15 + 15 + 10);
  // 作業平台 1 台在發電站 +10；深海獵人 2 名進駐製造站 → 有深海獵人的製造站 +10
  assert.equal(m2.totals.productivity, 10 + 10);
  assert.ok(m2.remote.some(item => item.value === 10 && /深海獵人 2 名/.test(item.text)));
});

test('加工站：依選定配方計算心情與副產品', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.workshop = [{ id: 'w1', itemId: 'x', name: '異鐵組', type: 'F_EVOLVE', mood: 2, gold: 200, byproductRate: 0.1, level: 1 }, { id: 'w2', itemId: 'y', name: '提純源岩', type: 'F_EVOLVE', mood: 4, gold: 300, byproductRate: 0.1, level: 1 }];
  catalog.skills.ws = { id: 'ws', name: 'ws', roomType: 'WORKSHOP', description: '進駐加工站加工精英材料時，副產品的產出機率提升60%，同時心情消耗為4以上的配方全部-2心情消耗' };
  catalog.operators['demo-1'] = [[{ buffId: 'ws', elite: 0, level: 1 }]];
  const run = (workshopFormula: string) => evaluateBase({ facilities: [{ id: 'w', type: 'workshop', level: 3 }], onlineSlots: [], assignments: { w: ['demo-1'] }, workshopFormula }, catalog, state.roster, definitions).facilities[0].workshop!;
  const iron = run('w1'), rock = run('w2');
  assert.equal(iron.mood, 2, '心情 2 的配方不符合「4 以上」');
  assert.equal(iron.rate, 0.16);
  assert.equal(rock.mood, 2);
  assert.equal(rock.efficiency, Math.round(((1.16 / 2) / (1.1 / 4) - 1) * 10000) / 100);
  assert.deepEqual(parseSkill({ roomType: 'WORKSHOP', description: '進駐加工站加工異鐵組材料時，副產品的產出機率提升90%' }).effects, [{ kind: 'byproduct', value: 90, category: 'other', target: { equals: '異鐵組' } }]);
  assert.equal(parseSkill({ roomType: 'WORKSHOP', description: '進駐加工站加工任意類材料時，每2次加工沒有產出副產品，則恢復自身一次心情，恢復量為對應配方所需消耗的心情（加工結束後統一結算）' }).effects[0].kind, 'refundOnMiss');
});

test('巡線框架：依無人機上限，未設定時取技能上限', async () => {
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  catalog.skills.line = { id: 'line', name: '巡線框架', roomType: 'POWER', description: '進駐發電站時，每10架無人機上限+1%無人機充能速度（最多+25%）' };
  catalog.operators['demo-1'] = [[{ buffId: 'line', elite: 0, level: 1 }]];
  const drone = (droneCap?: number) => evaluateBase({ facilities: [{ id: 'p', type: 'power', level: 3 }], onlineSlots: [], assignments: { p: ['demo-1'] }, ...(droneCap === undefined ? {} : { droneCap }) }, catalog, state.roster, definitions).facilities[0].totals.drone;
  assert.equal(drone(), 25);
  assert.equal(drone(200), 20);
});

test('多班輪替與 MAA 匯出格式', async () => {
  const { planRotation, exportMaaSchedule } = await import('../src/domain/rotation.ts');
  const state = await demoState(), catalog = createDemoBaseCatalog();
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const facilities: Facility[] = [{ id: 'm', type: 'manufacturing', level: 3, product: 'gold' }, { id: 't', type: 'trading', level: 3 }, { id: 'd', type: 'dormitory', level: 3 }, { id: 'tr', type: 'training', level: 3 }];
  const base = { facilities, onlineSlots: [] };
  const rotation = await planRotation(base, catalog, state.roster, definitions, { shifts: 3, timeBudgetMs: 50 });
  assert.equal(rotation.shifts.length, 3);
  assert.equal(rotation.hours, 8);
  for (const shift of rotation.shifts) for (const worker of shift.workers) assert.ok(worker.consumed <= worker.moodStart + 1e-6, '每班的人都撐得完');
  const json = exportMaaSchedule(base, rotation, definitions, { title: '測試', firstStart: '20:00', drones: { room: 'trading', index: 1 } }) as { plans: { period: string[][]; duration: number; rooms: Record<string, unknown[]> }[] };
  assert.equal(json.plans.length, 3);
  assert.deepEqual(json.plans[0].period, [['20:00', '23:59'], ['00:00', '03:59']], '跨日拆成兩段');
  assert.deepEqual(json.plans[1].period, [['04:00', '11:59']]);
  assert.equal(json.plans[0].duration, 480);
  assert.ok(json.plans[0].rooms.manufacture && json.plans[0].rooms.trading);
  assert.ok(!('dormitory' in json.plans[0].rooms) && !('training' in json.plans[0].rooms), '宿舍交給 MAA、訓練室不支援');
});

test('無人機用途：每架＝設施 3 分鐘產出，依赤金收支建議', async () => {
  const { droneOptions } = await import('../src/domain/base.ts');
  const catalog = { drones: { recoverSeconds: 360, reduceSeconds: { MANUFACTURE: 180, TRADING: 180 }, powerBasicPercent: 5 } } as never;
  const evaluation = { facilities: [{ facility: { type: 'power' }, totals: { drone: 15 } }] } as never;
  const stats = { available: true, goldPerDay: 50, goldConsumedPerDay: 40, manufacture: [{ facilityId: 'm', label: '製造站 1', product: 'gold', goldPerDay: 48, expPerDay: 0 }], trading: [{ facilityId: 't', label: '貿易站 1', lmdPerDay: 48000, goldPerDay: 48 }] } as never;
  const result = droneOptions(evaluation, catalog, stats)!;
  assert.equal(result.perDay, 288, '240 架 ×（1＋20%）');
  assert.equal(result.options[0].perDrone.gold, 0.1, '48 條／日 × 180 秒 ÷ 86400');
  assert.equal(result.options[1].perDrone.lmd, 100);
  assert.match(result.recommendation, /貿易站 1/, '赤金有剩 → 給貿易站');
});

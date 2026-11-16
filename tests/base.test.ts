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

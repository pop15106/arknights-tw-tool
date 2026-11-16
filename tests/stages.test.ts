import test from 'node:test';
import assert from 'node:assert/strict';
import { eventPhase, materialSources, sanityEstimate, stagesOfEvent, type GameEvent, type Stage } from '../src/domain/stages.ts';
import { parsePenguinMatrix, validateDropRates } from '../src/catalog/drops.ts';

const now = Date.parse('2026-11-10T00:00:00Z');
const event = (id: string, start: string, end: string, reward = end): GameEvent => ({ id, name: id, type: 'X', startTime: start, endTime: end, rewardEndTime: reward, hasStage: true, isRerun: false });
const drop = (id: string, occurrence: string, dropType = 'NORMAL') => ({ id, type: 'MATERIAL', dropType, occurrence });
const stages: Stage[] = [
  { id: 'main_01-07', code: '1-7', name: '暴君', type: 'MAIN', zoneId: 'main_1', apCost: 6, drops: [drop('30012', 'ALWAYS'), drop('30011', 'SOMETIMES', 'ADDITIONAL')] },
  { id: 'main_04-06', code: '4-6', name: 'x', type: 'MAIN', zoneId: 'main_4', apCost: 18, drops: [drop('30012', 'OFTEN')] },
  { id: 'act9_01', code: 'AC-1', name: 'y', type: 'ACTIVITY', zoneId: 'act9_zone1', apCost: 15, drops: [drop('30012', 'ALMOST')] },
  { id: 'act8_01', code: 'OL-1', name: 'z', type: 'ACTIVITY', zoneId: 'act8_zone1', apCost: 15, drops: [drop('30012', 'ALWAYS')] },
  { id: 'tower_1', code: 'T', name: 't', type: 'CLIMB_TOWER', zoneId: 'tower', apCost: 0, drops: [drop('30012', 'ALWAYS')] },
];
const events = [event('act9', '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z'), event('act8', '2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', '2026-10-22T00:00:00Z'), event('act10', '2026-12-01T00:00:00Z', '2026-12-15T00:00:00Z')];

test('活動狀態與活動關卡對應', () => {
  assert.deepEqual(events.map(item => eventPhase(item, now)), ['ongoing', 'ended', 'upcoming']);
  assert.deepEqual(stagesOfEvent(events[0], stages).map(stage => stage.code), ['AC-1']);
});

test('材料來源：常駐＋進行中活動；無掉率時依機率等級，有掉率時依理智／件', () => {
  assert.deepEqual(materialSources('30012', stages, events, now).map(item => item.stage.code), ['1-7', 'AC-1', '4-6']);
  const drops = parsePenguinMatrix({ matrix: [
    { stageId: 'main_01-07', itemId: '30012', quantity: 1000, times: 1000, start: 0, end: null },
    { stageId: 'main_04-06', itemId: '30012', quantity: 1500, times: 1000, start: 0, end: null },
    { stageId: 'act9_01', itemId: '30012', quantity: 50, times: 50, start: 0, end: null },
    { stageId: 'old', itemId: '30012', quantity: 1, times: 1, start: 0, end: 1 },
    { stageId: 'bad id!', itemId: '30012', quantity: 1, times: 1 },
  ] }, 'CN', '2026-11-10T00:00:00Z');
  assert.equal(validateDropRates(JSON.parse(JSON.stringify(drops))).server, 'CN');
  assert.ok(!drops.stages.old && !drops.stages['bad id!']);
  const sources = materialSources('30012', stages, events, now, drops);
  assert.deepEqual(sources.map(item => [item.stage.code, item.apPerItem]), [['1-7', 6], ['4-6', 12], ['AC-1', undefined]], '樣本不足 100 的活動關卡不給掉率');
  assert.equal(sanityEstimate(10, sources[0]), 60);
  assert.throws(() => parsePenguinMatrix({ matrix: [] }, 'CN', '2026-11-10T00:00:00Z'));
});

test('取得方式：直接刷與合成取理智較低者', async () => {
  const { bestAcquire } = await import('../src/domain/stages.ts');
  const drops = parsePenguinMatrix({ matrix: [
    { stageId: 'main_01-07', itemId: '30012', quantity: 1000, times: 1000, end: null },
    { stageId: 'main_04-06', itemId: '30013', quantity: 50, times: 1000, end: null },
  ] }, 'CN', '2026-11-10T00:00:00Z');
  const extra: Stage[] = [...stages, { id: 'main_04-06x', code: '4-6x', name: 'x', type: 'MAIN', zoneId: 'main_4', apCost: 18, drops: [drop('30013', 'SOMETIMES', 'ADDITIONAL')] }];
  extra[1] = { ...extra[1], drops: [...extra[1].drops, drop('30013', 'SOMETIMES', 'ADDITIONAL')] };
  // 直接刷 30013：18 ÷ 0.05 = 360；合成 30013 = 3 × 30012（每件 6 理智）= 18
  const way = bestAcquire('30013', extra, events, now, drops, { '30013': { costs: [{ id: '30012', count: 3 }] } });
  assert.equal(way?.kind, 'craft'); assert.equal(way?.apPerItem, 18);
});

test('理智規劃：一關多掉落合併計算、合成、無法取得的材料', async () => {
  const { farmingPlan } = await import('../src/domain/stages.ts');
  const list: Stage[] = [
    { id: 'main_a', code: 'A', name: 'a', type: 'MAIN', zoneId: 'z', apCost: 10, drops: [] },
    { id: 'main_b', code: 'B', name: 'b', type: 'MAIN', zoneId: 'z', apCost: 6, drops: [] },
    { id: 'main_c', code: 'C', name: 'c', type: 'MAIN', zoneId: 'z', apCost: 6, drops: [] },
  ];
  const drops = parsePenguinMatrix({ matrix: [
    { stageId: 'main_a', itemId: 'x', quantity: 1000, times: 1000, end: null }, { stageId: 'main_a', itemId: 'y', quantity: 1000, times: 1000, end: null },
    { stageId: 'main_b', itemId: 'x', quantity: 1000, times: 1000, end: null }, { stageId: 'main_c', itemId: 'y', quantity: 1000, times: 1000, end: null },
  ] }, 'CN', '2026-11-10T00:00:00Z');
  const plan = await farmingPlan({ x: 5, y: 5, chip: 2 }, list, [], now, drops, {});
  assert.equal(plan.sanity, 50, '刷 A 五次（50）比 B、C 各五次（60）省');
  assert.deepEqual(plan.unmet, ['chip']);
  const crafted = await farmingPlan({ z: 2 }, list, [], now, drops, { z: { costs: [{ id: 'x', count: 3 }], gold: 100 } });
  assert.deepEqual(crafted.crafts, [{ id: 'z', count: 2 }]);
  assert.equal(crafted.sanity, 36); assert.equal(crafted.craftLmd, 200);
});

test('台服未來活動預估：依近期兩服時間差中位數推估', async () => {
  const { forecastTwEvents } = await import('../src/domain/stages.ts');
  const day = 86400;
  const cn = [1, 2, 3, 4].map(index => ({ id: `act${index}`, name: `CN${index}`, type: 'X', startTime: index * 30 * day, endTime: index * 30 * day + 14 * day, hasStage: true, isRerun: false }));
  cn.push({ id: 'act5', name: '新活動', type: 'X', startTime: 150 * day, endTime: 164 * day, hasStage: true, isRerun: false });
  const tw = [1, 2, 3, 4].map(index => ({ id: `act${index}`, name: `TW${index}`, type: 'X', startTime: new Date((index * 30 + 180 + index) * day * 1000).toISOString(), endTime: null, rewardEndTime: null, hasStage: true, isRerun: false }));
  const result = forecastTwEvents(tw, cn, 0)!;
  assert.deepEqual(result.rangeDays, [181, 184]);
  assert.equal(result.offsetDays, 183);
  assert.equal(result.forecasts[0].event.id, 'act5');
  assert.equal(result.forecasts[0].predicted, (150 + 183) * day * 1000);
});

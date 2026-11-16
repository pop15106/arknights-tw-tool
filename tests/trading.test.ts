import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TRADING, expectedOrder, parseTradingWikitext, validateTradingParams } from '../src/catalog/trading.ts';
import { createGameDataStore } from '../scripts/game-data-sync.ts';
import { sealDataset } from '../src/domain/model.ts';
import { CATALOG_REVISION, MODULE_DATA_COMMIT } from '../src/catalog/build.ts';

// 依 PRTS「罗德岛基建/贸易站」頁面的表格結構節錄（CC BY-NC-SA，出處 prts.wiki）。
const WIKITEXT = `==谈判策略与订单==
{| class="wikitable"
!订单类型
|-
|1
|{{材料消耗|赤金|2}}||{{道具图标|龙门币|1000|50px}}||2:24:00
|-
|2
|{{材料消耗|赤金|3}}||{{道具图标|龙门币|1500|50px}}||3:30:00
|-
|3
|{{材料消耗|赤金|4}}||{{道具图标|龙门币|2000|50px}}||4:36:00
|-
|{{材料消耗|源石碎片|2}}||{{道具图标|合成玉|20|50px}}||2:00:00
|}
===贵金属订单的生成概率===
{| class="wikitable" style="text-align:center"
!width=100px|1
|-
|{{材料消耗|赤金|2}}||100%||60%||30%
|-
|{{材料消耗|赤金|3}}||—||40%||50%
|-
|{{材料消耗|赤金|4}}||—||—||20%
|}
====贵金属订单生成概率分布受技能的影响====
|{{材料消耗|赤金|2}}||30%||15%{{color|#FF6237|(-15%)}}||5%{{color|#FF6237|(-25%)}}
|-
|{{材料消耗|赤金|3}}||50%||30%{{color|#FF6237|(-20%)}}||10%{{color|#FF6237|(-40%)}}
|-
|{{材料消耗|赤金|4}}||20%||55%{{color|#00B0FF|(+35%)}}||85%{{color|#00B0FF|(+65%)}}
|}
* α级与α级同时进驻时存在效果叠加：累积工作达到峰值时，观测订单质量分布为：65% 4赤金、22% 3赤金、13% 2赤金。
* α级与β级同时进驻时存在效果叠加：由菲亚梅塔支持巫恋组007工作时，观测订单质量分布为：85% 4赤金、10% 3赤金、5% 2赤金。
===特殊订单===
{| class="wikitable"
|-
| {{术语|cc.tra.pepe|特别独占订单}}
| 订单时长：4:30:00（不受任何订单获取效率的影响）<br>赤金交付数：0<br>交付报酬：1000龙门币
|-
| 特别订单（{{术语|cc.tra.closure|可露希尔特别订单}}）
| 订单时长：2:24:00<br>赤金交付数：2<br>交付报酬：1200龙门币
|}
|rowspan=2|'''进驻人员上限：'''1<br>'''订单上限：'''6
|rowspan=2|'''进驻人员上限：'''2<br>'''订单上限：'''8
|rowspan=2|'''进驻人员上限：'''3<br>'''订单上限：'''10`;
const meta = { fetchedAt: '2026-11-16T00:00:00.000Z', revision: 448466, editedAt: '2026-11-07T02:33:32Z' };

test('解析 PRTS 貿易站頁面：訂單表、生成機率（不含技能影響表）、訂單上限', () => {
  const params = parseTradingWikitext(WIKITEXT, meta);
  assert.deepEqual(params.orders, DEFAULT_TRADING.orders);
  assert.deepEqual(params.probability, DEFAULT_TRADING.probability);
  assert.deepEqual(params.limits, [6, 8, 10]);
  assert.deepEqual(params.quality, DEFAULT_TRADING.quality);
  assert.deepEqual(params.special, DEFAULT_TRADING.special);
  assert.equal(params.source.revision, 448466);
  // 源石訂單不混入赤金訂單
  assert.equal(params.orders.length, 3);
});

test('格式改變或數值不合理時拒絕，不拿錯誤數據計算', () => {
  assert.throws(() => parseTradingWikitext(WIKITEXT.replace('|1\n|{{材料消耗|赤金|2}}', '|1\n|{{材料消耗|赤金|9}}').replace('||100%||60%||30%', '||100%||60%||90%'), meta), /格式不符/);
  assert.throws(() => parseTradingWikitext(WIKITEXT.replace(/===贵金属订单的生成概率===[\s\S]*$/u, ''), meta), /格式不符/);
  assert.throws(() => parseTradingWikitext('完全不同的頁面', meta), /格式不符/);
  assert.throws(() => validateTradingParams({ ...DEFAULT_TRADING, source: { ...DEFAULT_TRADING.source, url: 'https://evil.test/' } }), /格式不符/);
});

test('期望值：3 級貿易站平均 12204 秒、1450 龍門幣、2.9 赤金', () => {
  const order = expectedOrder(3);
  assert.equal(Math.round(order.seconds), 12204); assert.equal(Math.round(order.lmd), 1450); assert.equal(Math.round(order.gold * 10) / 10, 2.9);
});

test('同步：成功時保存 PRTS 結果；PRTS 失敗不影響主資料同步並保留上次結果', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ark-trading-'));
  const version = 'a'.repeat(40), date = '2026-11-13T00:00:00.000Z';
  let prtsMode: 'ok' | 'fail' | 'bad' = 'ok';
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.startsWith('https://prts.wiki/')) {
      if (prtsMode === 'fail') throw new Error('network');
      const content = prtsMode === 'bad' ? '格式已改版' : WIKITEXT;
      return new Response(JSON.stringify({ query: { pages: [{ revisions: [{ revid: 448466, timestamp: meta.editedAt, slots: { main: { content } } }] }] } }));
    }
    return new Response(JSON.stringify({ sha: version, commit: { committer: { date } } }));
  };
  const build = async () => {
    const dataset = await sealDataset({ metadata: { id: 'sync-test', version, product: 'arknights', server: 'tw', namespace: 'personal', validFrom: date, acquiredAt: date, source: '合成測試', licenseStatus: 'self-authored' }, operators: [] });
    return { dataset, stages: [{ id: 's' }], events: [{ id: 'e' }], status: { catalogRevision: CATALOG_REVISION, moduleSource: { version: MODULE_DATA_COMMIT, sourceUrl: 'https://example.invalid', sourceUpdatedAt: date }, version, sourceUpdatedAt: date, syncedAt: date, counts: { operators: 0, stages: 1, events: 1 }, sourceKind: 'public-mirror' as const, sourceUrl: 'https://example.invalid' } };
  };
  const store = createGameDataStore({ cacheDirectory: dir, assetDirectory: path.join(dir, 'assets'), fetcher, build });
  try {
    assert.equal(await store.loadTrading(), null);
    await store.sync();
    assert.equal((await store.loadTrading())?.source.revision, 448466);
    prtsMode = 'fail';
    await assert.doesNotReject(store.sync());
    assert.equal((await store.loadTrading())?.source.revision, 448466, 'PRTS 失敗時保留上次結果');
    prtsMode = 'bad';
    await assert.doesNotReject(store.sync());
    assert.deepEqual((await store.loadTrading())?.orders, DEFAULT_TRADING.orders, '格式不符時不覆蓋');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('訂單模型：品質、特殊訂單、交付數固定、違約與投資依 PRTS 數據', async () => {
  const { orderModel, NO_MODS } = await import('../src/catalog/trading.ts');
  const base = orderModel(3, NO_MODS);
  assert.equal(Math.round(base.lmd), 1450);
  // β 級：5%／10%／85% → 0.05×1000＋0.1×1500＋0.85×2000 = 1900
  assert.equal(Math.round(orderModel(3, { ...NO_MODS, beta: 1 }).lmd), 1900);
  assert.equal(Math.round(orderModel(3, { ...NO_MODS, alpha: 2 }).lmd), Math.round(0.13 * 1000 + 0.22 * 1500 + 0.65 * 2000));
  assert.match(orderModel(3, { ...NO_MODS, beta: 2 }).notes.join(), /估計/);
  assert.match(orderModel(2, { ...NO_MODS, beta: 1 }).notes.join(), /未計入/, '只有 3 級有品質數據');
  const pepe = orderModel(3, { ...NO_MODS, pepe: true, closure: true });
  assert.deepEqual([pepe.seconds, pepe.gold, pepe.lmd, pepe.fixedTime], [16200, 0, 1000, true], '佩佩優先於可露希爾');
  assert.deepEqual([orderModel(3, { ...NO_MODS, closure: true }).lmd, orderModel(3, { ...NO_MODS, closure: true }).gold], [1200, 2]);
  const two = orderModel(3, { ...NO_MODS, twoGold: true });
  assert.equal(two.gold, 2); assert.equal(two.lmd, 1000); assert.equal(Math.round(two.seconds), 12204, '時間沿用原訂單');
  // 違約 β：2→4 赤金 2000、3→5 赤金 2500，4 赤金不變 2000
  const breach = orderModel(3, { ...NO_MODS, breach: true, breachBonus: 2 });
  assert.equal(Math.round(breach.lmd), Math.round(0.3 * 2000 + 0.5 * 2500 + 0.2 * 2000));
  assert.equal(Math.round(breach.gold * 10) / 10, Math.round((0.3 * 4 + 0.5 * 5 + 0.2 * 4) * 10) / 10);
  assert.equal(Math.round(orderModel(3, { ...NO_MODS, invest: 500 }).lmd), 1450 + 0.2 * 500);
});

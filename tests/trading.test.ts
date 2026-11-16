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
|{{材料消耗|赤金|2}}||30%||15%||5%
|rowspan=2|'''进驻人员上限：'''1<br>'''订单上限：'''6
|rowspan=2|'''进驻人员上限：'''2<br>'''订单上限：'''8
|rowspan=2|'''进驻人员上限：'''3<br>'''订单上限：'''10`;
const meta = { fetchedAt: '2026-11-16T00:00:00.000Z', revision: 448466, editedAt: '2026-11-07T02:33:32Z' };

test('解析 PRTS 貿易站頁面：訂單表、生成機率（不含技能影響表）、訂單上限', () => {
  const params = parseTradingWikitext(WIKITEXT, meta);
  assert.deepEqual(params.orders, DEFAULT_TRADING.orders);
  assert.deepEqual(params.probability, DEFAULT_TRADING.probability);
  assert.deepEqual(params.limits, [6, 8, 10]);
  assert.equal(params.source.revision, 448466);
  // 源石訂單不混入赤金訂單
  assert.equal(params.orders.length, 3);
});

test('格式改變或數值不合理時拒絕，不拿錯誤數據計算', () => {
  assert.throws(() => parseTradingWikitext(WIKITEXT.replace('||30%', '||90%'), meta), /格式不符/);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGameDataStore } from '../scripts/game-data-sync.ts';
import { sealDataset } from '../src/domain/model.ts';
import { CATALOG_REVISION, MODULE_DATA_COMMIT, type GameDataSnapshot } from '../src/catalog/build.ts';

const date='2026-11-13T00:00:00.000Z';
async function fixture(version: string): Promise<GameDataSnapshot> {
  const dataset=await sealDataset({metadata:{id:'sync-test',version,product:'arknights',server:'tw',namespace:'personal',validFrom:date,acquiredAt:date,source:'合成測試',licenseStatus:'self-authored'},operators:[]});
  return {dataset,stages:[{id:'stage'}],events:[{id:'event'}],status:{catalogRevision:CATALOG_REVISION,moduleSource:{version:MODULE_DATA_COMMIT,sourceUrl:'https://example.invalid/modules',sourceUpdatedAt:date},version,sourceUpdatedAt:date,syncedAt:date,counts:{operators:0,stages:1,events:1},sourceKind:'public-mirror',sourceUrl:'https://example.invalid'}};
}
test('更新失敗保留前版指標；並發同步共用同一工作',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ark-catalog-'));
  let fail=false, requests=0;
  const version='a'.repeat(40);
  // PRTS 貿易站數據、企鵝物流掉落統計與陸服活動表是額外的盡力同步，不計入主資料的請求次數。
  const fetcher:typeof fetch=async input=>{if(!/^https:\/\/(prts\.wiki|penguin-stats\.io|raw\.githubusercontent\.com\/Kengxxiao)\//.test(String(input)))requests++;if(fail)throw new Error('upstream private diagnostic');return new Response(JSON.stringify({sha:version,commit:{committer:{date}}}),{status:200});};
  const store=createGameDataStore({cacheDirectory:dir,assetDirectory:path.join(dir,'assets'),fetcher,build:async()=>fixture(version)});
  try {
    await store.seed({} as never,{commit:version,sourceUpdatedAt:date,syncedAt:date});
    const before=await readFile(path.join(dir,'current.json'),'utf8');
    fail=true;
    await assert.rejects(store.sync(),/更新失敗/);
    assert.equal((await store.load())?.status.version,version);
    assert.equal(await readFile(path.join(dir,'current.json'),'utf8'),before);
    fail=false;requests=0;
    const [a,b]=await Promise.all([store.sync(),store.sync()]);
    assert.equal(a.status.version,b.status.version);
    assert.equal(requests,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('不支援的版本不能用於檔案路徑，且不替換有效快取',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ark-catalog-'));
  const store=createGameDataStore({cacheDirectory:dir,assetDirectory:path.join(dir,'assets'),fetcher:async()=>new Response(JSON.stringify({sha:'../escape',commit:{committer:{date}}}))});
  try{await assert.rejects(store.sync(),/更新失敗/);assert.equal(await store.load(),null);}finally{await rm(dir,{recursive:true,force:true});}
});

test('REL-01：指標損壞、快照缺檔或校驗不符時改用可驗證舊版，且仍可重新同步修復', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ark-catalog-repair-'));
  const older = 'a'.repeat(40), newer = 'b'.repeat(40), later = '2026-11-14T00:00:00.000Z';
  const store = createGameDataStore({ cacheDirectory: dir, assetDirectory: path.join(dir, 'assets'),
    fetcher: async () => new Response(JSON.stringify({ sha: newer, commit: { committer: { date } } })),
    build: async (_tables, source) => { const value = await fixture(source.commit); value.status.syncedAt = source.syncedAt; return value; } });
  const pointer = path.join(dir, 'current.json');
  try {
    await store.seed({} as never, { commit: older, sourceUpdatedAt: date, syncedAt: date });
    await store.seed({} as never, { commit: newer, sourceUpdatedAt: date, syncedAt: later });
    const good = await readFile(pointer, 'utf8');
    const snapshotFile = path.join(dir, 'snapshots', `${newer}-${JSON.parse(good).sha256}.json`);

    await writeFile(pointer, '{不是 JSON');
    let loaded = await store.load();
    assert.equal(loaded?.status.version, newer); assert.match(loaded!.status.lastError!, /損壞/);

    await writeFile(pointer, 'null');
    assert.equal((await store.load())?.status.version, newer);

    await writeFile(snapshotFile, (await readFile(snapshotFile, 'utf8')).replace('合成測試', '竄改測試'));
    await writeFile(pointer, good);
    loaded = await store.load();
    assert.equal(loaded?.status.version, older, '校驗不符的最新快照不得使用，改用上一個可驗證版本');

    await rm(path.join(dir, 'snapshots'), { recursive: true });
    await assert.rejects(store.load(), /沒有可用舊版/);
    const repaired = await store.sync();
    assert.equal(repaired.status.version, newer);
    const reloaded = await store.load();
    assert.equal(reloaded?.status.version, newer); assert.equal(reloaded?.status.lastError, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('相同上游版本但舊解析版本仍補抓效果與信賴表，失敗保留舊快取', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ark-catalog-upgrade-'));
  const version = 'a'.repeat(40); let old = true, fail = true; const urls: string[] = [];
  const store = createGameDataStore({ cacheDirectory: dir, assetDirectory: path.join(dir, 'assets'),
    fetcher: async input => { const url = String(input); urls.push(url); if (fail && url.endsWith('battle_equip_table.json')) throw new Error('合成來源失敗'); return new Response(JSON.stringify(url.includes('/commits/') ? { sha: version, commit: { committer: { date } } } : {})); },
    build: async tables => { const value = await fixture(version); if (old) { delete value.status.catalogRevision; delete value.status.moduleSource; } else { assert.ok(tables.battleEquip); assert.ok(tables.favor); assert.ok(tables.items); } return value; },
  });
  try {
    await store.seed({} as never, { commit: version, sourceUpdatedAt: date, syncedAt: date }); old = false;
    const before = await readFile(path.join(dir, 'current.json'), 'utf8');
    await assert.rejects(store.sync(), /更新失敗/);
    assert.equal(await readFile(path.join(dir, 'current.json'), 'utf8'), before);
    fail = false; urls.length = 0;
    const updated = await store.sync();
    assert.equal(updated.status.catalogRevision, CATALOG_REVISION);
    assert.ok(urls.some(url => url.includes(MODULE_DATA_COMMIT) && url.endsWith('battle_equip_table.json')));
    assert.ok(urls.some(url => url.includes(MODULE_DATA_COMMIT) && url.endsWith('favor_table.json')));
    assert.equal(updated.status.moduleSource?.version, MODULE_DATA_COMMIT);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

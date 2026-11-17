import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isStale, parseCommunity, rankCommunityPicks } from '../src/catalog/community.ts';
import { startGameDataServer } from '../scripts/game-data-server.ts';

const bundled = async () => JSON.parse(await readFile(new URL('../data/community/rogue.json', import.meta.url), 'utf8'));

test('repo 內附的社群評價通過驗證，五個主題都有資料與出處', async () => {
  const data = parseCommunity(await bundled());
  assert.deepEqual(Object.keys(data.themes).sort(), ['rogue_1', 'rogue_2', 'rogue_3', 'rogue_4', 'rogue_5']);
  for (const theme of Object.values(data.themes)) {
    assert.ok(Object.keys(theme.picks).length > 10);
    for (const picks of Object.values(theme.picks)) for (const pick of picks) assert.match(pick.url, /^https:\/\/(forum\.gamer\.com\.tw|www\.bilibili\.com|prts\.wiki)\//u);
  }
});

test('同步內容驗證：拒絕不明網址、未知來源與異常欄位', async () => {
  const good = await bundled();
  const withUrl = (url: string) => { const copy = structuredClone(good); const first = Object.values(copy.themes.rogue_1.picks)[0] as { url: string }[]; first[0].url = url; return copy; };
  assert.throws(() => parseCommunity(withUrl('https://evil.example/x')), /只接受/);
  assert.throws(() => parseCommunity(withUrl('javascript:alert(1)')), /網址/);
  assert.throws(() => parseCommunity(withUrl('http://forum.gamer.com.tw/C.php')), /只接受/);
  const badSource = structuredClone(good); (Object.values(badSource.themes.rogue_1.picks)[0] as { source: string }[])[0].source = 'nga';
  assert.throws(() => parseCommunity(badSource), /評價項目/);
  assert.throws(() => parseCommunity({ ...good, format: 'other' }), /格式/);
});

test('排序：推薦來源數優先；全部是不推薦的幹員不列入推薦排行', () => {
  const theme = { counters: [], picks: {
    char_a: [{ source: 'bahamut', stance: 'recommend', reason: 'r', url: 'https://prts.wiki/w/a' }],
    char_b: [{ source: 'bahamut', stance: 'recommend', reason: 'r', url: 'https://prts.wiki/w/a' }, { source: 'bilibili', stance: 'situational', reason: 'r', url: 'https://prts.wiki/w/a' }],
    char_c: [{ source: 'bilibili', stance: 'avoid', reason: 'r', url: 'https://prts.wiki/w/a' }],
  } } as Parameters<typeof rankCommunityPicks>[0];
  assert.deepEqual(rankCommunityPicks(theme).map(item => item.operatorId), ['char_b', 'char_a']);
  assert.equal(isStale('2022-01-01', Date.parse('2026-11-17')), true);
  assert.equal(isStale('2026-01-01', Date.parse('2026-11-17')), false);
});

test('本機服務：讀取社群評價；同步只接受本機頁面明確請求', async t => {
  const data = parseCommunity(await bundled());
  let synced = 0;
  const service = await startGameDataServer({ port: 0, load: async () => null, notifier: null, loadCommunity: async () => data, syncCommunity: async () => { synced++; return data; } });
  t.after(() => service.close());
  assert.equal((await (await fetch(`${service.origin}/api/game-data/community`)).json()).updatedAt, data.updatedAt);
  assert.equal((await fetch(`${service.origin}/api/game-data/community-sync`, { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Game-Data-Sync': '1' } })).status, 403);
  assert.equal((await fetch(`${service.origin}/api/game-data/community-sync`, { method: 'POST', headers: { Origin: service.origin, 'X-Game-Data-Sync': '1' } })).status, 200);
  assert.equal(synced, 1);
});

test('資料讀取：已同步的較新版本優先；同步檔損壞時退回 repo 內附版本', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createGameDataStore } = await import('../scripts/game-data-sync.ts');
  const dir = await mkdtemp(`${tmpdir()}/community-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createGameDataStore({ cacheDirectory: dir, assetDirectory: dir });
  const good = await bundled();
  await writeFile(`${dir}/community.json`, JSON.stringify({ ...good, updatedAt: '2099-01-01' }));
  assert.equal((await store.loadCommunity()).updatedAt, '2099-01-01');
  await writeFile(`${dir}/community.json`, '{"format":"broken"}');
  assert.equal((await store.loadCommunity()).updatedAt, good.updatedAt);
});

test('Codex 回饋：主題 ID 不必等關卡分析；與主題名稱同順序且社群資料都有對應', async () => {
  const { IS_THEMES, IS_THEME_IDS } = await import('../src/domain/review.ts');
  assert.equal(IS_THEME_IDS.length, IS_THEMES.length);
  const data = parseCommunity(await bundled());
  for (const id of IS_THEME_IDS) assert.ok(data.themes[id], `${id} 應有社群資料`);
  // 回饋：天馬光環（治療）屬於重裝臨光，不是耀騎士臨光。
  assert.ok(data.themes.rogue_1.picks.char_148_nearl?.some(pick => pick.reason.includes('天馬光環')));
  assert.ok(!data.themes.rogue_1.picks.char_1014_nearl2?.some(pick => pick.reason.includes('天馬光環')));
});

test('Codex 回饋延伸：原文沒逐字出現幹員名的條目標示「依暱稱判讀」；奶羊歸純燼艾雅法拉', async () => {
  const data = parseCommunity(await bundled());
  const all = Object.values(data.themes).flatMap(theme => Object.values(theme.picks).flat());
  assert.ok(all.filter(pick => pick.inferred).length >= 20);
  assert.ok(data.themes.rogue_3.picks.char_1016_agoat2?.some(pick => pick.reason.startsWith('奶羊')));
  assert.ok(!data.themes.rogue_3.picks.char_128_plosis?.some(pick => pick.reason.startsWith('奶羊')));
});

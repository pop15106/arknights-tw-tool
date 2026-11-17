import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBuzz, countMentions, parseBahamut, parseBilibili, THEME_NAME_OPERATORS } from '../scripts/buzz.ts';
import { buzzPicks } from '../src/catalog/buzz.ts';
import { startGameDataServer } from '../scripts/game-data-server.ts';
import { createEmptyState, sealDataset, validateAppState } from '../src/domain/model.ts';

const bahamutRow = (sn: number, title: string, brief: string) => `<tr class="b-list__row b-list-item"><td class="b-list__main"><a href="C.php?bsn=33651&snA=${sn}&tnum=5"><p class="b-list__main__title">【心得】${title}</p><p class="b-list__brief">${brief}</p></a></td><td class="b-list__time"><p class="b-list__time__edittime"><a title="觀看最新回覆文章" href="C.php?bsn=33651&snA=${sn}&last=1">06-11 21:36</a></p></td></tr>`;
const names = new Map([['維什戴爾', 'char_wis'], ['濁心斯卡蒂', 'char_skadi2'], ['斯卡蒂', 'char_skadi'], ['年', 'char_nian'], ['水月', 'char_mizuki'], ['维什戴尔', 'char_wis']]);

test('巴哈搜尋頁：取標題、摘要、最新回覆時間與文章連結', () => {
  const posts = parseBahamut(`<table>${bahamutRow(1, '<span class="search-highlight">水月</span>開局', '維什戴爾很穩')}</table>`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '【心得】水月開局');
  assert.equal(posts[0].url, 'https://forum.gamer.com.tw/C.php?bsn=33651&snA=1');
  assert.equal(posts[0].date, '最新回覆 06-11 21:36');
});

test('B 站搜尋頁：只擷取字面字串，不執行腳本；標題缺少時標示', () => {
  const html = `window.__pinia=(function(a,b){return {result:[{bvid:"BV1aaaaaaaaa",title:"n18\\u6c34\\u6708 维什戴尔开局",description:"x",tag:"肉鸽",pubdate:1746544232},{bvid:"BV1bbbbbbbbb",title:as,description:"维什戴尔",tag:"",pubdate:1746544232}]}})()`;
  const posts = parseBilibili(html);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, 'n18水月 维什戴尔开局');
  assert.match(posts[1].title, /標題未能擷取/);
  assert.equal(posts[0].date, '2025-05-06');
});

test('提到次數：長名稱優先、單字名稱與主題同名的幹員不計、同篇多次只算一篇', () => {
  const mentions = countMentions([{ text: '濁心斯卡蒂和維什戴爾，維什戴爾很強，打水月要年' }, { text: '维什戴尔' }], names, THEME_NAME_OPERATORS);
  const byId = Object.fromEntries(mentions.map(item => [item.operatorId, item]));
  assert.deepEqual(byId.char_wis, { operatorId: 'char_wis', count: 3, posts: 2 });
  assert.equal(byId.char_skadi2.count, 1);
  assert.equal(byId.char_skadi, undefined, '「濁心斯卡蒂」不重複算進「斯卡蒂」');
  assert.equal(byId.char_nian, undefined); assert.equal(byId.char_mizuki, undefined);
  assert.deepEqual(buzzPicks({ posts: [], errors: [], mentions }).map(item => item.operatorId), ['char_wis']);
});

test('抓取：一個來源失敗不影響另一個，並記錄錯誤', async () => {
  const fetchImpl = (async (input: string | URL) => String(input).includes('gamer.com.tw')
    ? new Response(`<table>${bahamutRow(2, '開局', '維什戴爾、維什戴爾')}${bahamutRow(3, '心得', '維什戴爾')}</table>`)
    : new Response('blocked', { status: 412 })) as typeof fetch;
  const data = await collectBuzz({ fetch: fetchImpl, names, delayMs: 0, now: () => new Date('2026-11-17T00:00:00Z') });
  assert.equal(data.themes.rogue_1.posts.length, 2);
  assert.deepEqual(data.themes.rogue_1.errors, ['B 站搜尋失敗']);
  assert.equal(data.themes.rogue_1.mentions[0].operatorId, 'char_wis');
});

test('本機服務與設定：背景抓取只接受本機請求；設定值驗證', async t => {
  let calls = 0;
  const data = { fetchedAt: '2026-11-17T00:00:00.000Z', themes: {} };
  const service = await startGameDataServer({ port: 0, load: async () => null, notifier: null, loadBuzz: async () => data, syncBuzz: async () => { calls++; return data; } });
  t.after(() => service.close());
  assert.deepEqual((await (await fetch(`${service.origin}/api/game-data/buzz`)).json()), { running: false, data });
  assert.equal((await fetch(`${service.origin}/api/game-data/buzz-sync`, { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Game-Data-Sync': '1' } })).status, 403);
  assert.equal((await fetch(`${service.origin}/api/game-data/buzz-sync`, { method: 'POST', headers: { Origin: service.origin, 'X-Game-Data-Sync': '1' } })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  const dataset = await sealDataset({ metadata: { id: 'demo-empty', version: '1', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: '2026-11-13T00:00:00.000Z', acquiredAt: '2026-11-13T00:00:00.000Z', source: '自製', licenseStatus: 'self-authored' }, operators: [] });
  const state = createEmptyState(dataset);
  assert.doesNotThrow(() => validateAppState({ ...state, settings: { ...state.settings, communityBuzz: 'recommend' } }));
  assert.throws(() => validateAppState({ ...state, settings: { ...state.settings, communityBuzz: 'always' } }), /不支援/);
});

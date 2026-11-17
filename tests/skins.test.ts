import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkinCatalog, skinFileName, skinPortraitId, SKIN_ID } from '../src/catalog/skins.ts';
import { createEmptyState, sealDataset, validateAppState } from '../src/domain/model.ts';
import { startGameDataServer } from '../scripts/game-data-server.ts';

test('時裝清單只收有名稱的時裝；檔名規則與台服 skin_table 一致', () => {
  const catalog = buildSkinCatalog({ charSkins: {
    'char_002_amiya#1': { skinId: 'char_002_amiya#1', charId: 'char_002_amiya', displaySkin: { skinName: null, skinGroupName: '默認服裝' } },
    'char_002_amiya@winter#1': { skinId: 'char_002_amiya@winter#1', charId: 'char_002_amiya', displaySkin: { skinName: '報童', skinGroupName: '忒斯特收藏/I' } },
    'char_1001_amiya2@sale#16': { skinId: 'char_1001_amiya2@sale#16', charId: 'char_002_amiya', displaySkin: { skinName: '於萬千宇宙之中', skinGroupName: '' } },
    'bad': { skinId: '../evil', charId: 'char_002_amiya', displaySkin: { skinName: 'x' } },
  } });
  assert.deepEqual(catalog, { char_002_amiya: [{ id: 'char_002_amiya@winter#1', name: '報童', group: '忒斯特收藏/I' }], char_1001_amiya2: [{ id: 'char_1001_amiya2@sale#16', name: '於萬千宇宙之中', group: '' }] });
  assert.equal(skinPortraitId('char_002_amiya@winter#1'), 'char_002_amiya_winter#1');
  assert.equal(skinFileName('char_002_amiya@winter#1'), 'char_002_amiya_winter-1.png');
  assert.ok(!SKIN_ID.test('char_002_amiya#1'));
});

test('服裝設定：只接受該幹員自己的時裝 ID', async () => {
  const dataset = await sealDataset({ metadata: { id: 'demo-empty', version: '1', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: '2026-11-13T00:00:00.000Z', acquiredAt: '2026-11-13T00:00:00.000Z', source: '自製', licenseStatus: 'self-authored' }, operators: [] });
  const state = createEmptyState(dataset);
  assert.doesNotThrow(() => validateAppState({ ...state, settings: { ...state.settings, skins: { char_002_amiya: 'char_002_amiya@winter#1' } } }));
  assert.throws(() => validateAppState({ ...state, settings: { ...state.settings, skins: { char_002_amiya: 'char_003_kalts@x#1' } } }), /服裝設定/);
  assert.throws(() => validateAppState({ ...state, settings: { ...state.settings, skins: { char_002_amiya: 'javascript:alert(1)' } } }), /服裝設定/);
});

test('本機服務：時裝清單可讀；下載單套立繪需本機頁面明確請求且 ID 合法', async t => {
  const requested: string[] = [];
  const service = await startGameDataServer({ port: 0, load: async () => null, notifier: null, loadSkins: async () => ({ char_002_amiya: [{ id: 'char_002_amiya@winter#1', name: '報童', group: '' }] }), skinPortrait: async id => { requested.push(id); return `/assets/operators/${skinFileName(id)}`; } });
  t.after(() => service.close());
  assert.equal((await (await fetch(`${service.origin}/api/game-data/skins`)).json()).char_002_amiya[0].name, '報童');
  const headers = { Origin: service.origin, 'X-Game-Data-Sync': '1' };
  const ok = await fetch(`${service.origin}/api/game-data/skin-portrait?id=${encodeURIComponent('char_002_amiya@winter#1')}`, { method: 'POST', headers });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { path: '/assets/operators/char_002_amiya_winter-1.png' });
  assert.equal((await fetch(`${service.origin}/api/game-data/skin-portrait?id=${encodeURIComponent('../../x')}`, { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(`${service.origin}/api/game-data/skin-portrait?id=${encodeURIComponent('char_002_amiya@winter#1')}`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.deepEqual(requested, ['char_002_amiya@winter#1']);
});

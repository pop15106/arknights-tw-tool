import test from 'node:test';
import assert from 'node:assert/strict';
import { chibiFile, GUIDE_CAST, GUIDE_HOST, GUIDE_STEPS, voiceFile } from '../src/catalog/guide.ts';
import { startGameDataServer } from '../scripts/game-data-server.ts';

test('導覽資料：角色不重複、步驟都對應到角色；檔名只用預覽伺服器接受的字元', () => {
  const ids = GUIDE_CAST.map(item => item.charId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(GUIDE_HOST));
  for (const step of GUIDE_STEPS) assert.ok(ids.includes(step.charId), step.title);
  for (const id of ids) {
    assert.match(chibiFile(id), /^[A-Za-z0-9_.-]+\.webm$/u);
    assert.match(voiceFile(id, 'voice_cn', 'CN_001'), /^[A-Za-z0-9_.-]+\.mp3$/u);
  }
});

test('本機服務：導覽素材背景下載只接受本機請求與合法語言', async t => {
  const langs: string[] = [];
  const manifest = { lang: 'voice' as const, syncedAt: '2026-11-17T00:00:00.000Z', chibi: {}, lines: {} };
  const service = await startGameDataServer({ port: 0, load: async () => null, notifier: null, loadGuide: async () => manifest, syncGuide: async lang => { langs.push(lang); return manifest; } });
  t.after(() => service.close());
  assert.deepEqual(await (await fetch(`${service.origin}/api/game-data/guide`)).json(), { running: false, data: manifest });
  const headers = { Origin: service.origin, 'X-Game-Data-Sync': '1' };
  assert.equal((await fetch(`${service.origin}/api/game-data/guide-sync?lang=voice_xx`, { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(`${service.origin}/api/game-data/guide-sync?lang=voice_cn`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${service.origin}/api/game-data/guide-sync?lang=voice_cn`, { method: 'POST', headers })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(langs, ['voice_cn']);
});

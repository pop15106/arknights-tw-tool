import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedLoad, clearGameDataCache, peekCache } from '../src/ui/gameData.ts';

test('遊戲資料快取：同一份只讀一次；失敗不快取', async () => {
  clearGameDataCache();
  let calls = 0;
  const load = () => cachedLoad('t1', async () => { calls++; return { v: calls }; });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(a, b); assert.equal(calls, 1);
  assert.deepEqual(await load(), { v: 1 }); assert.equal(calls, 1);
  await assert.rejects(cachedLoad('t2', async () => { throw new Error('x'); }));
  assert.equal(peekCache('t2'), undefined);
  assert.deepEqual(await cachedLoad('t2', async () => 'ok'), 'ok');
});

test('遊戲資料快取：清除前就開始的讀取，完成後不會把舊資料寫回', async () => {
  clearGameDataCache();
  let release!: (value: string) => void;
  const old = cachedLoad('t3', () => new Promise<string>(resolve => { release = resolve; }));
  clearGameDataCache(); // 例如在設定頁更新了遊戲資料
  const fresh = await cachedLoad('t3', async () => 'new');
  release('old'); await old;
  assert.equal(fresh, 'new');
  assert.equal(peekCache('t3'), 'new', '舊的讀取完成後不能蓋掉新資料');
  // 單一 key 清除也一樣
  let releaseKey!: (value: string) => void;
  const oldKey = cachedLoad('t4', () => new Promise<string>(resolve => { releaseKey = resolve; }));
  clearGameDataCache('t4');
  releaseKey('old'); await oldKey;
  assert.equal(peekCache('t4'), undefined);
});

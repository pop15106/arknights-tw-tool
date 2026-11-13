import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildGameData, DATA_REPO, CATALOG_REVISION, MODULE_DATA_REPO, MODULE_DATA_COMMIT, type GameDataSnapshot, type GameDataTables } from '../src/catalog/build.ts';
import { validateDataset, verifyDatasetChecksum } from '../src/domain/model.ts';
export type { GameDataSnapshot } from '../src/catalog/build.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = { characters: 'character_table.json', patches: 'char_patch_table.json', skills: 'skill_table.json', modules: 'uniequip_table.json', stages: 'stage_table.json', activities: 'activity_table.json', items: 'item_table.json' } as const;
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
type Source = { commit: string; sourceUpdatedAt: string; syncedAt: string };

export function createGameDataStore(options: {
  cacheDirectory?: string; assetDirectory?: string; fetcher?: typeof fetch;
  build?: typeof buildGameData;
} = {}) {
  const cache = options.cacheDirectory ?? path.join(project, '.local/game-data');
  const assets = options.assetDirectory ?? path.join(project, 'public/assets/operators');
  const fetcher = options.fetcher ?? fetch;
  const build = options.build ?? buildGameData;
  let active: Promise<GameDataSnapshot> | undefined;
  let lastError: string | undefined;
  async function bytes(url: string, limit: number): Promise<Buffer> {
    const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(45_000), headers: { Accept: url.endsWith('.png') ? 'image/png' : 'application/json', 'User-Agent': 'Local-Arknights-Catalog/1' } });
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('公開來源回應失敗或過大。'); }
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > limit) throw new Error('公開來源回應超過容量限制。'); chunks.push(chunk.value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async function load(): Promise<GameDataSnapshot | null> {
    let pointer: { version: string; sha256: string };
    try { pointer = JSON.parse(await readFile(path.join(cache, 'current.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('遊戲資料快取無效，請重新同步。'); }
    if (!validVersion(pointer.version) || !/^[a-f0-9]{64}$/u.test(pointer.sha256)) throw new Error('遊戲資料版本無效。');
    const raw = await readFile(path.join(cache, 'snapshots', `${pointer.version}-${pointer.sha256}.json`));
    if (createHash('sha256').update(raw).digest('hex') !== pointer.sha256) throw new Error('遊戲資料快取校驗失敗。');
    const snapshot = JSON.parse(raw.toString('utf8')) as GameDataSnapshot;
    validateDataset(snapshot.dataset); await verifyDatasetChecksum(snapshot.dataset);
    if (snapshot.status.version !== pointer.version || !Array.isArray(snapshot.stages) || !Array.isArray(snapshot.events)) throw new Error('遊戲資料快取格式錯誤。');
    if (lastError) snapshot.status.lastError = lastError;
    return snapshot;
  }
  async function images(snapshot: GameDataSnapshot): Promise<void> {
    await mkdir(assets, { recursive: true });
    const queue = [...snapshot.dataset.operators];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const operator = queue.shift()!;
        if (!/^char_[A-Za-z0-9_.-]+$/u.test(operator.id) || operator.id.includes('..')) throw new Error('幹員圖片 ID 無效。');
        const target = path.join(assets, `${operator.id}.png`);
        try { const present = await readFile(target); if (present.subarray(0,8).equals(PNG)) continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const image = await bytes(`https://ak-tw.hg-cdn.com/arknights/game/assets/char/portrait/${encodeURIComponent(operator.id)}.png`, 2 * 1024 * 1024);
        if (!image.subarray(0,8).equals(PNG)) throw new Error('官方圖片來源未回傳 PNG。');
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, image, { flag: 'wx' }); await rename(temporary, target);
      }
    }));
  }
  async function publish(tables: GameDataTables, source: Source): Promise<GameDataSnapshot> {
    if (!validVersion(source.commit)) throw new Error('遊戲資料版本無效。');
    const snapshot = await build(tables, source);
    await images(snapshot);
    await mkdir(path.join(cache, 'snapshots'), { recursive: true });
    const raw = JSON.stringify(snapshot);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const target = path.join(cache, 'snapshots', `${source.commit}-${sha256}.json`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, raw, { flag: 'wx' }); await rename(temporary, target);
    const pointerTemp = path.join(cache, `current.${crypto.randomUUID()}.tmp`);
    await writeFile(pointerTemp, JSON.stringify({ version: source.commit, sha256 }), { flag: 'wx' });
    // 只有完整資料與全部圖片成功後才切換指標；先前版本保持可用。
    await rename(pointerTemp, path.join(cache, 'current.json'));
    lastError = undefined;
    return snapshot;
  }
  async function update(): Promise<GameDataSnapshot> {
    try {
      const commit = JSON.parse((await bytes(`https://api.github.com/repos/${DATA_REPO}/commits/main`, 2 * 1024 * 1024)).toString('utf8'));
      if (!validVersion(commit.sha) || !Number.isFinite(Date.parse(commit.commit?.committer?.date))) throw new Error('來源版本無效。');
      const previous = await load();
      if (previous && previous.status.version === commit.sha && previous.status.catalogRevision === CATALOG_REVISION && previous.status.moduleSource?.version === MODULE_DATA_COMMIT) { await images(previous); lastError = undefined; delete previous.status.lastError; return previous; }
      const tables = {} as GameDataTables;
      for (const [key, filename] of Object.entries(TABLES)) tables[key as keyof GameDataTables] = JSON.parse((await bytes(`https://raw.githubusercontent.com/${DATA_REPO}/${commit.sha}/${filename}`, 24 * 1024 * 1024)).toString('utf8'));
      for (const [key, filename] of Object.entries({ battleEquip: 'battle_equip_table.json', favor: 'favor_table.json' })) tables[key as 'battleEquip' | 'favor'] = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/${filename}`, 24 * 1024 * 1024)).toString('utf8'));
      return await publish(tables, { commit: commit.sha, sourceUpdatedAt: commit.commit.committer.date, syncedAt: new Date().toISOString() });
    } catch { lastError = '遊戲資料更新失敗；上一版資料已保留。'; throw new Error(lastError); }
  }
  function sync(): Promise<GameDataSnapshot> {
    if (!active) active = update().finally(() => { active = undefined; });
    return active;
  }
  return { load, sync, seed: publish };
}

const defaultStore = createGameDataStore();
export const loadGameData = defaultStore.load;
export const syncGameData = defaultStore.sync;
export const seedGameData = defaultStore.seed;

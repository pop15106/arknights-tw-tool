import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildGameData, DATA_REPO, CATALOG_REVISION, MODULE_DATA_REPO, MODULE_DATA_COMMIT, type GameDataSnapshot, type GameDataTables } from '../src/catalog/build.ts';
import { validateDataset, verifyDatasetChecksum } from '../src/domain/model.ts';
import { parseTradingWikitext, PRTS_TRADING_API, validateTradingParams, type TradingParams } from '../src/catalog/trading.ts';
export type { GameDataSnapshot } from '../src/catalog/build.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = { characters: 'character_table.json', patches: 'char_patch_table.json', skills: 'skill_table.json', modules: 'uniequip_table.json', stages: 'stage_table.json', activities: 'activity_table.json', items: 'item_table.json', building: 'building_data.json', constants: 'gamedata_const.json' } as const;
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
  let recovered = false;
  const fileExists = (file: string) => access(file).then(() => true, () => false);
  async function bytes(url: string, limit: number): Promise<Buffer> {
    const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(45_000), headers: { Accept: url.endsWith('.png') ? 'image/png' : 'application/json', 'User-Agent': 'Local-Arknights-Catalog/1' } });
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('公開來源回應失敗或過大。'); }
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > limit) throw new Error('公開來源回應超過容量限制。'); chunks.push(chunk.value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async function readSnapshot(version: string, sha256: string): Promise<GameDataSnapshot> {
    if (!validVersion(version) || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('遊戲資料版本無效。');
    const raw = await readFile(path.join(cache, 'snapshots', `${version}-${sha256}.json`));
    if (createHash('sha256').update(raw).digest('hex') !== sha256) throw new Error('遊戲資料快取校驗失敗。');
    const snapshot = JSON.parse(raw.toString('utf8')) as GameDataSnapshot;
    validateDataset(snapshot.dataset); await verifyDatasetChecksum(snapshot.dataset);
    if (snapshot.status?.version !== version || !Array.isArray(snapshot.stages) || !Array.isArray(snapshot.events)) throw new Error('遊戲資料快取格式錯誤。');
    return snapshot;
  }
  // 指標損壞或指向缺檔／校驗不符的快照時，改用仍可完整驗證的最新快照，不要求使用者手動刪目錄。
  async function fallbackSnapshot(): Promise<GameDataSnapshot | null> {
    let names: string[];
    try { names = await readdir(path.join(cache, 'snapshots')); } catch { return null; }
    let best: GameDataSnapshot | null = null;
    for (const name of names) {
      const match = /^([a-f0-9]{40})-([a-f0-9]{64})\.json$/u.exec(name);
      if (!match) continue;
      try {
        const snapshot = await readSnapshot(match[1], match[2]);
        if (!best || Date.parse(snapshot.status.syncedAt) > Date.parse(best.status.syncedAt)) best = snapshot;
      } catch { /* 略過無法驗證的快照 */ }
    }
    return best;
  }
  async function load(): Promise<GameDataSnapshot | null> {
    let snapshot: GameDataSnapshot | null;
    try {
      const pointer: unknown = JSON.parse(await readFile(path.join(cache, 'current.json'), 'utf8'));
      if (!pointer || typeof pointer !== 'object') throw new Error('遊戲資料快取指標格式錯誤。');
      const { version, sha256 } = pointer as Record<string, unknown>;
      snapshot = await readSnapshot(version as string, sha256 as string);
    } catch (error) {
      snapshot = await fallbackSnapshot();
      if (!snapshot) {
        if (!(await fileExists(path.join(cache, 'current.json')))) return null;
        throw new Error('遊戲資料快取損壞且沒有可用舊版，請按「更新遊戲資料」重新同步。');
      }
      snapshot.status.lastError = '遊戲資料快取指標損壞，已改用仍通過校驗的上一版；重新同步即可修復。';
      recovered = true;
      return snapshot;
    }
    recovered = false;
    if (lastError) snapshot.status.lastError = lastError;
    return snapshot;
  }
  // PRTS 貿易站數據另存一檔：與遊戲資料版本無關，可單獨更新；失敗不影響主資料同步。
  const tradingFile = path.join(cache, 'prts-trading.json');
  async function loadTrading(): Promise<TradingParams | null> {
    try { return validateTradingParams(JSON.parse(await readFile(tradingFile, 'utf8'))); } catch { return null; }
  }
  async function refreshTrading(): Promise<TradingParams> {
    const body = JSON.parse((await bytes(PRTS_TRADING_API, 2 * 1024 * 1024)).toString('utf8'));
    const revision = body?.query?.pages?.[0]?.revisions?.[0];
    const content = revision?.slots?.main?.content;
    if (typeof content !== 'string') throw new Error('PRTS 回應缺少頁面內容。');
    const params = parseTradingWikitext(content, { fetchedAt: new Date().toISOString(), ...(Number.isInteger(revision.revid) ? { revision: revision.revid } : {}), ...(typeof revision.timestamp === 'string' ? { editedAt: revision.timestamp } : {}) });
    await mkdir(cache, { recursive: true });
    const temporary = `${tradingFile}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(params), { flag: 'wx' }); await rename(temporary, tradingFile);
    return params;
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
      // 快取損壞不能阻止重新同步；改用備援快照時一律重建以修好指標。
      const previous = await load().catch(() => null);
      if (previous && !recovered && previous.status.version === commit.sha && previous.status.catalogRevision === CATALOG_REVISION && previous.status.moduleSource?.version === MODULE_DATA_COMMIT) { await images(previous); await refreshTrading().catch(() => undefined); lastError = undefined; delete previous.status.lastError; return previous; }
      const tables = {} as GameDataTables;
      for (const [key, filename] of Object.entries(TABLES)) tables[key as keyof GameDataTables] = JSON.parse((await bytes(`https://raw.githubusercontent.com/${DATA_REPO}/${commit.sha}/${filename}`, 24 * 1024 * 1024)).toString('utf8'));
      for (const [key, filename] of Object.entries({ battleEquip: 'battle_equip_table.json', favor: 'favor_table.json', teams: 'handbook_team_table.json' })) tables[key as 'battleEquip' | 'favor' | 'teams'] = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/${filename}`, 24 * 1024 * 1024)).toString('utf8'));
      const published = await publish(tables, { commit: commit.sha, sourceUpdatedAt: commit.commit.committer.date, syncedAt: new Date().toISOString() });
      await refreshTrading().catch(() => undefined);
      return published;
    } catch { lastError = '遊戲資料更新失敗；上一版資料已保留。'; throw new Error(lastError); }
  }
  function sync(): Promise<GameDataSnapshot> {
    if (!active) active = update().finally(() => { active = undefined; });
    return active;
  }
  return { load, sync, seed: publish, loadTrading, refreshTrading };
}

const defaultStore = createGameDataStore();
export const loadGameData = defaultStore.load;
export const syncGameData = defaultStore.sync;
export const seedGameData = defaultStore.seed;
export const loadTradingData = defaultStore.loadTrading;

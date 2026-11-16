import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildGameData, DATA_REPO, CATALOG_REVISION, MODULE_DATA_REPO, MODULE_DATA_COMMIT, type GameDataSnapshot, type GameDataTables } from '../src/catalog/build.ts';
import { validateDataset, verifyDatasetChecksum } from '../src/domain/model.ts';
import { parseTradingWikitext, PRTS_TRADING_API, validateTradingParams, type TradingParams } from '../src/catalog/trading.ts';
import { parseLevelEnemies } from '../src/catalog/enemies.ts';
import { analyzeRogueTheme, MODE_THEME_ID, type RogueAnalysis } from '../src/catalog/rogue.ts';
import { parsePenguinMatrix, PENGUIN_MATRIX_API, validateDropRates, type DropRates } from '../src/catalog/drops.ts';
export type { GameDataSnapshot } from '../src/catalog/build.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = { characters: 'character_table.json', patches: 'char_patch_table.json', skills: 'skill_table.json', modules: 'uniequip_table.json', stages: 'stage_table.json', activities: 'activity_table.json', items: 'item_table.json', building: 'building_data.json', constants: 'gamedata_const.json', gacha: 'gacha_table.json' } as const;
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
  // 企鵝物流掉落統計另存一檔：企鵝物流只支援 CN／US／JP／KR，沒有台服，使用樣本最多的陸服作參考；失敗保留舊檔，不影響主資料。
  const dropsFile = path.join(cache, 'penguin-drops.json');
  async function loadDrops(): Promise<DropRates | null> {
    try { return validateDropRates(JSON.parse(await readFile(dropsFile, 'utf8'))); } catch { return null; }
  }
  async function refreshDrops(): Promise<DropRates> {
    let drops: DropRates | undefined;
    for (const server of ['CN']) {
      try { drops = parsePenguinMatrix(JSON.parse((await bytes(PENGUIN_MATRIX_API(server), 24 * 1024 * 1024)).toString('utf8')), server, new Date().toISOString()); break; } catch { /* 試下一個伺服器 */ }
    }
    if (!drops) throw new Error('企鵝物流掉落統計無法取得。');
    await mkdir(cache, { recursive: true });
    const temporary = `${dropsFile}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(drops), { flag: 'wx' }); await rename(temporary, dropsFile);
    return drops;
  }
  // 關卡敵人：依需要下載單一關卡檔（固定版本），只保存敵人與數量的摘要。
  const levelDir = path.join(cache, 'levels');
  async function stageEnemies(stageId: string): Promise<{ stageId: string; levelId: string; enemies: { id: string; level: number; count: number }[] } | null> {
    if (!/^[A-Za-z0-9_#-]{1,64}$/u.test(stageId)) return null;
    const snapshot = await load();
    const stage = snapshot?.stages.find(item => item.id === stageId) as { levelId?: string } | undefined;
    const levelId = stage?.levelId;
    if (!levelId || !/^[A-Za-z0-9_/-]{1,120}$/u.test(levelId) || levelId.includes('..')) return null;
    const file = path.join(levelDir, `${levelId.toLowerCase().replaceAll('/', '__')}.json`);
    try { const cached = JSON.parse(await readFile(file, 'utf8')); if (Array.isArray(cached?.enemies)) return { stageId, levelId, enemies: cached.enemies }; } catch { /* 沒有快取 */ }
    const enemies = parseLevelEnemies(JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/levels/${levelId.toLowerCase()}.json`, 8 * 1024 * 1024)).toString('utf8')));
    await mkdir(levelDir, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ enemies }), { flag: 'wx' }); await rename(temporary, file);
    return { stageId, levelId, enemies };
  }
  // 陸服活動時間表（Kengxxiao/ArknightsGameData 公開鏡像）：只保存活動基本資訊，供台服未來活動預估；失敗保留舊檔。
  const cnEventsFile = path.join(cache, 'cn-events.json');
  async function loadCnEvents(): Promise<{ fetchedAt: string; source: string; events: unknown[] } | null> {
    try { const value = JSON.parse(await readFile(cnEventsFile, 'utf8')); return Array.isArray(value?.events) ? value : null; } catch { return null; }
  }
  async function refreshCnEvents(): Promise<void> {
    const table = JSON.parse((await bytes('https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/activity_table.json', 40 * 1024 * 1024)).toString('utf8'));
    const events = Object.entries((table?.basicInfo ?? {}) as Record<string, Record<string, unknown>>).filter(([id, row]) => /^[A-Za-z0-9_]{1,40}$/u.test(id) && Number.isFinite(row?.startTime))
      .map(([id, row]) => ({ id, name: String(row.name ?? id).slice(0, 60), type: String(row.type ?? ''), startTime: Number(row.startTime), endTime: Number(row.endTime) || 0, hasStage: row.hasStage === true, isRerun: row.isReplicate === true }));
    if (events.length < 50) throw new Error('陸服活動表資料不足。');
    await mkdir(cache, { recursive: true });
    const temporary = `${cnEventsFile}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'Kengxxiao/ArknightsGameData zh_CN activity_table', events }), { flag: 'wx' }); await rename(temporary, cnEventsFile);
  }
  // 集成戰略主題分析：下載該主題所有關卡檔（固定版本、本機快取），彙整敵人、首領與地塊。
  async function rogueAnalysis(themeId: string): Promise<RogueAnalysis | null> {
    if (!MODE_THEME_ID.test(themeId)) return null;
    const snapshot = await load();
    const theme = snapshot?.rogue?.find(item => item.id === themeId);
    if (!theme || !snapshot?.enemies) return null;
    const file = path.join(cache, `rogue-${themeId}-${snapshot.status.version.slice(0, 12)}-${CATALOG_REVISION}.json`);
    try { const cached = JSON.parse(await readFile(file, 'utf8')); if (cached?.id === themeId) return cached; } catch { /* 沒有快取 */ }
    const levels = new Map<string, unknown>();
    const queue = [...theme.stages];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const stage = queue.shift()!;
        const key = stage.levelId.toLowerCase();
        try { levels.set(key, JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/levels/${key}.json`, 8 * 1024 * 1024)).toString('utf8'))); } catch { /* 個別關卡缺檔時略過，分析會標出實際分析的關卡數 */ }
      }
    }));
    const analysis = analyzeRogueTheme(theme, levels, snapshot.enemies);
    await mkdir(cache, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(analysis), { flag: 'wx' }); await rename(temporary, file);
    return analysis;
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
      if (previous && !recovered && previous.status.version === commit.sha && previous.status.catalogRevision === CATALOG_REVISION && previous.status.moduleSource?.version === MODULE_DATA_COMMIT) { await images(previous); await refreshTrading().catch(() => undefined); await refreshDrops().catch(() => undefined); await refreshCnEvents().catch(() => undefined); lastError = undefined; delete previous.status.lastError; return previous; }
      const tables = {} as GameDataTables;
      for (const [key, filename] of Object.entries(TABLES)) tables[key as keyof GameDataTables] = JSON.parse((await bytes(`https://raw.githubusercontent.com/${DATA_REPO}/${commit.sha}/${filename}`, 24 * 1024 * 1024)).toString('utf8'));
      for (const [key, filename] of Object.entries({ battleEquip: 'battle_equip_table.json', favor: 'favor_table.json', teams: 'handbook_team_table.json' })) tables[key as 'battleEquip' | 'favor' | 'teams'] = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/${filename}`, 24 * 1024 * 1024)).toString('utf8'));
      // 敵人圖鑑與資料庫（依關卡推薦用）：同一固定版本；資料庫較大，只在建置時投影成精簡摘要。
      tables.tower = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/climb_tower_table.json`, 16 * 1024 * 1024)).toString('utf8'));
      tables.sandbox = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/sandbox_perm_table.json`, 24 * 1024 * 1024)).toString('utf8'));
      tables.rogue = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/roguelike_topic_table.json`, 40 * 1024 * 1024)).toString('utf8'));
      tables.enemyHandbook = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/excel/enemy_handbook_table.json`, 24 * 1024 * 1024)).toString('utf8'));
      tables.enemyDatabase = JSON.parse((await bytes(`https://raw.githubusercontent.com/${MODULE_DATA_REPO}/${MODULE_DATA_COMMIT}/tw/gamedata/levels/enemydata/enemy_database.json`, 32 * 1024 * 1024)).toString('utf8'));
      const published = await publish(tables, { commit: commit.sha, sourceUpdatedAt: commit.commit.committer.date, syncedAt: new Date().toISOString() });
      await refreshTrading().catch(() => undefined); await refreshDrops().catch(() => undefined); await refreshCnEvents().catch(() => undefined);
      return published;
    } catch { lastError = '遊戲資料更新失敗；上一版資料已保留。'; throw new Error(lastError); }
  }
  function sync(): Promise<GameDataSnapshot> {
    if (!active) active = update().finally(() => { active = undefined; });
    return active;
  }
  return { load, sync, seed: publish, loadTrading, refreshTrading, loadDrops, refreshDrops, stageEnemies, loadCnEvents, refreshCnEvents, rogueAnalysis };
}

const defaultStore = createGameDataStore();
export const loadGameData = defaultStore.load;
export const syncGameData = defaultStore.sync;
export const seedGameData = defaultStore.seed;
export const loadTradingData = defaultStore.loadTrading;
export const loadDropsData = defaultStore.loadDrops;
export const stageEnemiesData = defaultStore.stageEnemies;
export const loadCnEventsData = defaultStore.loadCnEvents;
export const rogueAnalysisData = defaultStore.rogueAnalysis;

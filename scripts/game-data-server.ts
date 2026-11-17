import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameDataSnapshot } from './game-data-sync.ts';
import type { TradingParams } from '../src/catalog/trading.ts';
import { createNotifier, NotifyError, type Notifier } from './notify.ts';

const DEFAULT_PORT = 5188;
// 只接受 127.0.0.1 的任意連接埠（例如 5173 被占用時改用 5174）；外部網域與 DNS 重新綁定仍會被擋下。
const LOOPBACK_HOST = /^127\.0\.0\.1:\d{2,5}$/u;
const isLoopbackHost = (value: string | undefined) => !!value && LOOPBACK_HOST.test(value);
const isLoopbackOrigin = (value: string | undefined) => !!value && value.startsWith('http://') && isLoopbackHost(value.slice('http://'.length));
interface ServerOptions {
  port?: number;
  load?: () => Promise<GameDataSnapshot | null>;
  sync?: () => Promise<GameDataSnapshot>;
  loadTrading?: () => Promise<TradingParams | null>;
  stageEnemies?: (stageId: string) => Promise<{ stageId: string; levelId: string; enemies: { id: string; level: number; count: number }[] } | null>;
  rogueAnalysis?: (theme: string) => Promise<import('../src/catalog/rogue.ts').RogueAnalysis | null>;
  loadCnEvents?: () => Promise<{ fetchedAt: string; source: string; events: unknown[] } | null>;
  loadDrops?: () => Promise<import('../src/catalog/drops.ts').DropRates | null>;
  /** 換班推播；測試時注入假的發送端，正式執行才讀本機設定。 */
  notifier?: Notifier | null;
}
class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  const content = JSON.stringify(value);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(content);
}
// 只比對字串值，不比對屬性名稱，避免 q=id 之類查詢命中全部資料。
function containsText(value: unknown, q: string, depth = 0): boolean {
  if (typeof value === 'string') return value.includes(q);
  if (depth > 8 || !value || typeof value !== 'object') return false;
  return Object.values(value).some(item => containsText(item, q, depth + 1));
}
function publicStatus(snapshot: GameDataSnapshot) {
  const status = snapshot.status;
  return {
    version: status.version, sourceUpdatedAt: status.sourceUpdatedAt, syncedAt: status.syncedAt,
    counts: { operators: status.counts.operators, stages: status.counts.stages, events: status.counts.events },
    sourceKind: status.sourceKind, sourceUrl: status.sourceUrl,
    ...(status.moduleSource ? { moduleSource: { version: status.moduleSource.version, sourceUrl: status.moduleSource.sourceUrl, sourceUpdatedAt: status.moduleSource.sourceUpdatedAt } } : {}),
    ...(status.lastError ? { lastError: '最近一次同步失敗；目前保留先前資料。' } : {}),
  };
}
function queryNumber(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const input = params.get(key);
  if (input === null) return fallback;
  const value = Number(input);
  if (!/^\d+$/u.test(input) || !Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, 'QUERY', '查詢參數無效。');
  return value;
}

export async function startGameDataServer(options: ServerOptions = {}) {
  // 延後載入正式服務，讓注入的測試不會讀取網路或本機快取。
  const load = options.load ?? (async () => (await import('./game-data-sync.ts')).loadGameData());
  const sync = options.sync ?? (async () => (await import('./game-data-sync.ts')).syncGameData());
  const loadTrading = options.loadTrading ?? (options.load ? async () => null : async () => (await import('./game-data-sync.ts')).loadTradingData());
  const stageEnemies = options.stageEnemies ?? (options.load ? async () => null : async (stageId: string) => (await import('./game-data-sync.ts')).stageEnemiesData(stageId));
  const rogueAnalysis = options.rogueAnalysis ?? (options.load ? async () => null : async (theme: string) => (await import('./game-data-sync.ts')).rogueAnalysisData(theme));
  const loadCnEvents = options.loadCnEvents ?? (options.load ? async () => null : async () => (await import('./game-data-sync.ts')).loadCnEventsData());
  const loadDrops = options.loadDrops ?? (options.load ? async () => null : async () => (await import('./game-data-sync.ts')).loadDropsData());
  const notifier = options.notifier !== undefined ? options.notifier : options.load ? null : createNotifier();
  const stopNotifier = notifier?.start();
  let origin = '', host = '';
  const paths = new Set(['status', 'operators', 'stages', 'events', 'base', 'growth', 'drops', 'stage-enemies', 'enemies', 'recruit', 'cn-events', 'rogue', 'rogue-analysis', 'sync'].map(name => `/api/game-data/${name}`));
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    try {
      if (req.headers.host !== host && !isLoopbackHost(req.headers.host)) throw new ApiError(403, 'HOST', '只接受本機資料服務的網址。');
      if (req.headers.authorization !== undefined) throw new ApiError(400, 'CREDENTIALS', '公開資料服務不接受帳號憑證。');
      const raw = req.url ?? '';
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('#') || raw.length > 2048) throw new ApiError(400, 'PATH', '網址格式無效。');
      const url = new URL(raw, origin);
      if (url.pathname.startsWith('/api/notify/')) {
        if (!notifier) throw new ApiError(404, 'NOT_FOUND', '找不到此資料功能。');
        if (url.search) throw new ApiError(400, 'QUERY', '查詢參數無效。');
        try { await notifier.handle(req, res, url.pathname, value => value === origin || isLoopbackOrigin(value), json); }
        catch (error) { if (error instanceof NotifyError) throw new ApiError(error.status, 'NOTIFY', error.message); throw error; }
        return;
      }
      if (!paths.has(url.pathname)) throw new ApiError(404, 'NOT_FOUND', '找不到此資料功能。');
      const isSync = url.pathname === '/api/game-data/sync';
      if (req.method !== (isSync ? 'POST' : 'GET')) throw new ApiError(405, 'METHOD', '不支援此請求方法。');
      const isList = url.pathname === '/api/game-data/stages' || url.pathname === '/api/game-data/events';
      const allowedQuery = isList ? ['limit', 'offset', 'q'] : url.pathname === '/api/game-data/stage-enemies' ? ['id'] : url.pathname === '/api/game-data/rogue-analysis' ? ['theme'] : [];
      for (const key of url.searchParams.keys()) {
        if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError(400, 'QUERY', '查詢參數無效。');
      }
      if (isSync) {
        if (req.headers['x-game-data-sync'] !== '1' || !(req.headers.origin === origin || isLoopbackOrigin(req.headers.origin))
          || (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'same-site'].includes(String(req.headers['sec-fetch-site'])))) {
          throw new ApiError(403, 'ORIGIN', '同步只接受本機頁面明確發出的請求。');
        }
        if (req.headers['content-type'] !== undefined) throw new ApiError(415, 'CONTENT_TYPE', '同步請求不接受 Content-Type 或內容。');
        if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new ApiError(400, 'BODY', '同步請求不接受內容。');
        let updated: GameDataSnapshot;
        try { updated = await sync(); } catch { throw new ApiError(502, 'SYNC_FAILED', '公開資料同步失敗；先前快取仍可使用。'); }
        json(res, 200, publicStatus(updated)); return;
      }
      const limit = isList ? queryNumber(url.searchParams, 'limit', 100, 1, 1000) : 100;
      const offset = isList ? queryNumber(url.searchParams, 'offset', 0, 0, Number.MAX_SAFE_INTEGER) : 0;
      const q = url.searchParams.get('q') ?? '';
      if (q.length > 100) throw new ApiError(400, 'QUERY', '查詢文字不可超過 100 字。');
      const snapshot = await load();
      if (!snapshot) throw new ApiError(503, 'DATA_UNAVAILABLE', '尚未同步公開遊戲資料。');
      if (url.pathname === '/api/game-data/status') { json(res, 200, publicStatus(snapshot)); return; }
      if (url.pathname === '/api/game-data/operators') { json(res, 200, snapshot.dataset); return; }
      if (url.pathname === '/api/game-data/rogue') {
        if (!snapshot.rogue) throw new ApiError(503, 'ROGUE_UNAVAILABLE', '目前的遊戲資料沒有集成戰略資料，請到設定按「更新遊戲資料」。');
        json(res, 200, snapshot.rogue.map(theme => ({ id: theme.id, name: theme.name, mode: theme.mode ?? 'roguelike', stages: theme.stages.length, relics: theme.relics.length }))); return;
      }
      if (url.pathname === '/api/game-data/rogue-analysis') {
        const theme = url.searchParams.get('theme') ?? '';
        if (!/^(?:rogue_\d{1,2}|tower_[a-z]{1,3}_\d{1,3}|sandbox_\d{1,2})$/u.test(theme)) throw new ApiError(400, 'QUERY', '主題 ID 無效。');
        let analysis: Awaited<ReturnType<typeof rogueAnalysis>>;
        try { analysis = await rogueAnalysis(theme); } catch { throw new ApiError(502, 'ROGUE_FAILED', '主題關卡下載失敗，請稍後再試。'); }
        if (!analysis) throw new ApiError(404, 'ROGUE_NOT_FOUND', '找不到此主題的資料。');
        json(res, 200, analysis); return;
      }
      if (url.pathname === '/api/game-data/cn-events') {
        const cn = await loadCnEvents().catch(() => null);
        if (!cn) throw new ApiError(503, 'CN_EVENTS_UNAVAILABLE', '尚未同步陸服活動時間表；在設定按「更新遊戲資料」時會一併取得。');
        json(res, 200, cn); return;
      }
      if (url.pathname === '/api/game-data/recruit') {
        if (!snapshot.recruit) throw new ApiError(503, 'RECRUIT_UNAVAILABLE', '目前的遊戲資料沒有公開招募資料，請到設定按「更新遊戲資料」。');
        json(res, 200, snapshot.recruit); return;
      }
      if (url.pathname === '/api/game-data/enemies') {
        if (!snapshot.enemies) throw new ApiError(503, 'ENEMIES_UNAVAILABLE', '目前的遊戲資料沒有敵人資料，請到設定按「更新遊戲資料」。');
        json(res, 200, snapshot.enemies); return;
      }
      if (url.pathname === '/api/game-data/stage-enemies') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^[A-Za-z0-9_#-]{1,64}$/u.test(id)) throw new ApiError(400, 'QUERY', '關卡 ID 無效。');
        let detail: Awaited<ReturnType<typeof stageEnemies>>;
        try { detail = await stageEnemies(id); } catch { throw new ApiError(502, 'LEVEL_FAILED', '關卡檔下載失敗，請稍後再試。'); }
        if (!detail) throw new ApiError(404, 'LEVEL_NOT_FOUND', '找不到此關卡的敵人資料。');
        json(res, 200, detail); return;
      }
      if (url.pathname === '/api/game-data/drops') {
        const drops = await loadDrops().catch(() => null);
        if (!drops) throw new ApiError(503, 'DROPS_UNAVAILABLE', '尚未同步企鵝物流掉落統計；在設定按「更新遊戲資料」時會一併取得。');
        json(res, 200, drops); return;
      }
      if (url.pathname === '/api/game-data/growth') {
        if (!snapshot.growth) throw new ApiError(503, 'GROWTH_UNAVAILABLE', '目前的遊戲資料沒有養成成本資料，請到設定按「更新遊戲資料」。');
        json(res, 200, snapshot.growth); return;
      }
      if (url.pathname === '/api/game-data/base') {
        if (!snapshot.base) throw new ApiError(503, 'BASE_UNAVAILABLE', '目前的遊戲資料沒有基建資料，請到設定按「更新遊戲資料」。');
        const trading = await loadTrading().catch(() => null);
        json(res, 200, trading ? { ...snapshot.base, trading } : snapshot.base); return;
      }
      const rows = url.pathname === '/api/game-data/stages' ? snapshot.stages : snapshot.events;
      const filtered = q ? rows.filter(row => containsText(row, q)) : rows;
      json(res, 200, { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit, version: snapshot.status.version });
    } catch (error) {
      if (error instanceof ApiError) json(res, error.status, { error: { code: error.code, message: error.message } });
      else json(res, 500, { error: { code: 'LOCAL_ERROR', message: '本機資料服務暫時無法完成請求。' } });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('無法啟動本機資料服務。')); return; }
      host = `127.0.0.1:${address.port}`; origin = `http://${host}`; resolveListen();
    });
  });
  let closing: Promise<void> | undefined;
  return { server, origin, close: () => closing ??= new Promise<void>((resolveClose, reject) => {
    stopNotifier?.();
    server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections();
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const service = await startGameDataServer();
    console.info(`公開遊戲資料服務：${service.origin}（僅本機）`);
    const stop = () => { void service.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 只輸出錯誤代碼與對應說明，不輸出可能含路徑的完整堆疊。
    const reason = code === 'EADDRINUSE' ? '5188 已被其他程式使用；若已有另一個 npm run game-data 視窗在執行，直接沿用即可。'
      : code === 'EACCES' ? '系統不允許使用 5188（Windows 可能因 Hyper-V／WSL 保留了這段連接埠）。'
      : '請確認 5188 未被使用。';
    console.error(`公開遊戲資料服務啟動失敗（${code ?? '未知錯誤'}）：${reason}`); process.exitCode = 1;
  }
}

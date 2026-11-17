// 一鍵啟動：遊戲資料服務＋網頁，同一個視窗、一次 Ctrl+C 全部關閉。
//   npm start           開發模式（改程式碼會即時更新）
//   npm run start:fast  先建置（程式碼沒變就略過），以建置結果開啟，頁面載入最快
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { startGameDataServer } from './game-data-server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const noOpen = process.argv.includes('--no-open');
const started = Date.now();

async function newest(dir: string): Promise<number> {
  let latest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? await newest(full) : (await stat(full)).mtimeMs);
  }
  return latest;
}

/** 資料服務：已有人在 5188 執行（例如另一個視窗）就沿用。 */
async function ensureGameData(): Promise<{ close: () => Promise<void> } | null> {
  try {
    const service = await startGameDataServer();
    console.info(`✓ 遊戲資料服務：${service.origin}`);
    return service;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    const alive = await fetch('http://127.0.0.1:5188/api/game-data/status').then(response => response.status < 500).catch(() => false);
    if (!alive) throw new Error('5188 已被其他程式佔用，且不是本工具的資料服務。');
    console.info('✓ 沿用已在執行的遊戲資料服務（5188）');
    return null;
  }
}

async function main() {
  const service = await ensureGameData();
  let close: () => Promise<void>;
  let url: string;
  if (fast) {
    const dist = path.join(root, 'dist', 'index.html');
    const builtAt = await stat(dist).then(info => info.mtimeMs).catch(() => 0);
    const sourceAt = Math.max(await newest(path.join(root, 'src')), (await stat(path.join(root, 'index.html'))).mtimeMs);
    if (sourceAt > builtAt) { console.info('… 程式碼有更新，重新建置中'); await build({ root, logLevel: 'warn' }); }
    else console.info('✓ 建置結果是最新的，略過建置');
    // 與開發模式同一個網址（5173），書籤不用換。
    const server = await preview({ root, preview: { port: 5173, strictPort: true, open: !noOpen } });
    url = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5173/';
    close = () => new Promise<void>(resolve => server.httpServer.close(() => resolve()));
  } else {
    const server = await createServer({ root, server: { open: !noOpen } });
    await server.listen();
    url = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5173/';
    close = () => server.close();
  }
  console.info(`✓ 網頁：${url}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
  console.info('  按 Ctrl+C 結束');
  const stop = () => { void Promise.allSettled([close(), service?.close()]).then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

main().catch(error => {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(`啟動失敗：${code === 'EADDRINUSE' ? '連接埠已被使用，請先關閉其他啟動視窗。' : error instanceof Error ? error.message : '未知錯誤'}`);
  process.exit(1);
});

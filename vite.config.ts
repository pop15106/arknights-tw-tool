import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// 幹員肖像在「更新遊戲資料」時才下載到 public/assets/operators。
// 建置版（npm run start:fast／preview）只提供建置當下的 dist，之後下載的圖片會 404；
// 這裡讓預覽伺服器直接讀 public 資料夾，更新資料後不用重新建置就看得到。
const PORTRAIT = /^\/([A-Za-z0-9_.-]+\.png)(?:\?.*)?$/u;
const GUIDE_FILE = /^\/([A-Za-z0-9_.-]+\.(webm|mp3))(?:\?.*)?$/u;
function serveFrom(directory: string, pattern: RegExp, types: Record<string, string>) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    const match = pattern.exec(req.url ?? '');
    const name = match?.[1];
    if (!name || name.includes('..') || (req.method !== 'GET' && req.method !== 'HEAD')) { next(); return; }
    readFile(path.join(directory, name)).then(data => {
      res.writeHead(200, { 'Content-Type': types[name.split('.').pop()!] ?? 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    }, () => next());
  };
}
function livePortraits(): Plugin {
  const root = import.meta.dirname;
  return {
    name: 'live-operator-portraits',
    configurePreviewServer(server) {
      server.middlewares.use('/assets/operators', serveFrom(path.resolve(root, 'public/assets/operators'), PORTRAIT, { png: 'image/png' }));
      // 導覽素材（Q 版小人動畫、語音）同樣在建置後才下載。
      server.middlewares.use('/assets/guide', serveFrom(path.resolve(root, 'public/assets/guide'), GUIDE_FILE, { webm: 'video/webm', mp3: 'audio/mpeg' }));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [livePortraits()],
  server: { host: '127.0.0.1', strictPort: true, port: 5173, proxy: { '/api/game-data': 'http://127.0.0.1:5188', '/api/notify': 'http://127.0.0.1:5188' } },
  preview: { host: '127.0.0.1', strictPort: true, port: 4173, proxy: { '/api/game-data': 'http://127.0.0.1:5188', '/api/notify': 'http://127.0.0.1:5188' } },
  build: { target: 'safari17', rolldownOptions: { input: ['index.html', 'skport.html'] } },
});

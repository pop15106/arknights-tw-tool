import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// 幹員肖像在「更新遊戲資料」時才下載到 public/assets/operators。
// 建置版（npm run start:fast／preview）只提供建置當下的 dist，之後下載的圖片會 404；
// 這裡讓預覽伺服器直接讀 public 資料夾，更新資料後不用重新建置就看得到。
const PORTRAIT = /^\/([A-Za-z0-9_.-]+\.png)(?:\?.*)?$/u;
function livePortraits(): Plugin {
  const directory = path.resolve(import.meta.dirname, 'public/assets/operators');
  return {
    name: 'live-operator-portraits',
    configurePreviewServer(server) {
      server.middlewares.use('/assets/operators', (req, res, next) => {
        const name = PORTRAIT.exec(req.url ?? '')?.[1];
        if (!name || name.includes('..') || (req.method !== 'GET' && req.method !== 'HEAD')) { next(); return; }
        readFile(path.join(directory, name)).then(image => {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          res.end(req.method === 'HEAD' ? undefined : image);
        }, () => next());
      });
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

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', strictPort: true, port: 5173, proxy: { '/api/game-data': 'http://127.0.0.1:5188' } },
  preview: { host: '127.0.0.1', strictPort: true, port: 4173, proxy: { '/api/game-data': 'http://127.0.0.1:5188' } },
  build: { target: 'safari17', rolldownOptions: { input: ['index.html', 'skport.html'] } },
});

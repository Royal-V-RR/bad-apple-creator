import { defineConfig } from 'vite';
import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The source video lives in the repository root. It is served at /reference/badapple.mp4 in dev and copied into
// dist/reference at build time, so the 8 MB file is stored once. It is only fetched when "Compare" is used.
const source = resolve('badapple.mp4');
const referenceVideo = () => ({
  name: 'reference-video',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0].endsWith('/reference/badapple.mp4') && existsSync(source)) { res.setHeader('Content-Type', 'video/mp4'); createReadStream(source).pipe(res); } else next();
    });
  },
  closeBundle() {
    if (!existsSync(source)) return;
    mkdirSync(resolve('dist/reference'), { recursive: true });
    copyFileSync(source, resolve('dist/reference/badapple.mp4'));
  },
});

// base './' keeps every asset path relative, so the build works from a GitHub Pages project subpath.
export default defineConfig({ base: './', plugins: [referenceVideo()], build: { target: 'es2022', chunkSizeWarningLimit: 600 }, worker: { format: 'es' } });

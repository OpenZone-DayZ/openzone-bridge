// The admin site (design 2026-09-20, section 7): built from here into
// web/dist, which the bridge serves from admin-web.js and the single
// executable carries. Relative asset paths, so a reverse proxy may serve
// the page under any prefix; the dev server proxies the api and the
// sign-in routes to a running bridge.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin': 'http://127.0.0.1:8788',
      '/auth': 'http://127.0.0.1:8788',
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});

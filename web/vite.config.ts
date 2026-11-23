import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(webRoot, '..');

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(webRoot, 'src'),
      '@friday': resolve(repoRoot, 'src'),
    },
  },
  build: {
    outDir: resolve(repoRoot, 'dist/web'),
    emptyOutDir: false,
    sourcemap: false,
    assetsDir: 'assets',
    modulePreload: {
      polyfill: false,
    },
    rollupOptions: {
      input: {
        main: resolve(webRoot, 'index.html'),
        mindmap: resolve(webRoot, 'mindmap.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3210',
        changeOrigin: true,
      },
      '/im': {
        target: 'http://127.0.0.1:3210',
        changeOrigin: true,
      },
    },
  },
});

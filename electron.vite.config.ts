import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { outDir: 'dist/main' } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      {
        // The dev server needs its HMR websocket; the packaged app must not be able
        // to reach local services from the renderer.
        name: 'production-csp',
        transformIndexHtml(html, context) {
          return context.server ? html : html.replace(' ws://localhost:* http://localhost:*', '');
        },
      },
    ],
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    build: { outDir: 'dist/renderer' },
  },
});

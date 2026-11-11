import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwind()],
  // The shared package is built as CommonJS for the server; the web reads its TypeScript source (types and constants).
  resolve: { alias: { '@ccgs/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4310',
      '/socket.io': { target: 'http://127.0.0.1:4310', ws: true },
    },
  },
});

// Research dashboard of the flight-data platform: a separate Vite app (not part of the passenger bundle).
//   npm run fd:dashboard → http://localhost:5174 (API proxied to the fd server on :8790)
//   npm run fd:build     → flightdata/dist, served by the fd server itself
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.join(import.meta.dirname, 'dashboard'),
  base: './',
  plugins: [react()],
  build: { outDir: path.join(import.meta.dirname, 'dist'), emptyOutDir: true },
  server: { port: 5174, open: false, proxy: { '/fd-api': 'http://127.0.0.1:8790' } },
  preview: { port: 5174, proxy: { '/fd-api': 'http://127.0.0.1:8790' } },
});

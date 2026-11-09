// Simplified airport maps (FCO, FRA, …): a separate Vite app, independent of the CDG Navigator passenger bundle.
//   npm run maps:dev   → http://localhost:5175/#/fra  (or #/fco)
//   npm run maps:build → airportmaps/dist (static; open with `npm run maps:preview`)
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.join(import.meta.dirname, 'app'),
  base: './',
  plugins: [react()],
  build: { outDir: path.join(import.meta.dirname, 'dist'), emptyOutDir: true },
  server: { port: 5175, open: false, fs: { allow: [import.meta.dirname] } },
  preview: { port: 5175 },
});

// Builds the unpacked extension into extension/dist (load it in chrome://extensions → "Load unpacked").
//   npm run ext:build            production build
//   npm run ext:build -- --dev   with source maps, not minified
//   npm run ext:build -- --test  browser-test build in extension/dist-test: also runs on http://127.0.0.1 fixture pages,
//                                open shadow root (inspectable), local server access granted up front. Never distribute.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { computePin, ENGINE_FILES, ROOT } from './pin.ts';
import { BUNDLE_INFO } from '../src/core/bundle-info.ts';

const root = path.join(import.meta.dirname, '..');
const test = process.argv.includes('--test');
const out = path.join(root, test ? 'dist-test' : 'dist');
const dev = process.argv.includes('--dev') || test;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = {
  bundle: true, minify: !dev, sourcemap: dev ? ('inline' as const) : false, target: 'chrome116', legalComments: 'none' as const,
  loader: { '.css': 'text' as const, '.json': 'json' as const },
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), __TEST_BUILD__: JSON.stringify(test) },
  jsx: 'automatic' as const, logLevel: 'warning' as const,
};
// R-01: the bundle must be built from this tree's airport models and shared router, with an up-to-date pin
const pin = computePin();
if (pin.mapsHash !== BUNDLE_INFO.mapsHash || pin.contractHash !== BUNDLE_INFO.contractHash) throw new Error('extension/src/core/bundle-info.ts is stale (airport models, router or flight-data contract changed): run `npx tsx extension/scripts/pin.ts`, review, commit.');
const bg = await build({ ...common, metafile: true, entryPoints: [path.join(root, 'src', 'background.ts')], outfile: path.join(out, 'background.js'), format: 'esm' });
const inputs = Object.keys(bg.metafile!.inputs).map((p) => path.relative(ROOT, path.resolve(p)).split(path.sep).join('/'));
for (const need of [...ENGINE_FILES.filter((x) => x.endsWith('route.ts')), ...Object.keys(pin.files).filter((x) => x.endsWith('.json'))]) if (!inputs.includes(need)) throw new Error(`the background bundle does not include ${need} from this tree`);
const routers = inputs.filter((p) => /(^|\/)route\.ts$/.test(p));
if (routers.length !== 1) throw new Error(`expected exactly one router in the bundle, found: ${routers.join(', ')}`);
fs.writeFileSync(path.join(out, 'bundle-info.json'), JSON.stringify(BUNDLE_INFO, null, 2));
await build({ ...common, entryPoints: [path.join(root, 'src', 'content.tsx')], outfile: path.join(out, 'content.js'), format: 'iife' });
// popup / tab page: ES modules with code splitting, so the OCR glue (tesseract.js) is a separate chunk loaded only in
// the screenshot mode; the content script never includes it
await build({ ...common, entryPoints: [path.join(root, 'src', 'popup.tsx')], outdir: out, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]', format: 'esm', splitting: true });
for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(out, f));
// Screenshot mode: the OCR engine is packaged (MV3 forbids remotely hosted code; nothing is downloaded at run time):
// tesseract.js worker script, the SIMD + LSTM-only WebAssembly core (Chrome ≥ 116 always has WebAssembly SIMD) and
// the English LSTM model (tessdata_best integer, gzip). Licences: Apache-2.0.
const nm = path.join(ROOT, 'node_modules');
const OCR_FILES: [string, string][] = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.js', 'tesseract-core-simd-lstm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];
fs.mkdirSync(path.join(out, 'ocr'), { recursive: true });
for (const [from, to] of OCR_FILES) {
  const src = path.join(nm, from);
  if (!fs.existsSync(src)) throw new Error(`OCR file missing: ${from} (run npm install; tesseract.js and @tesseract.js-data/eng are dependencies)`);
  fs.copyFileSync(src, path.join(out, 'ocr', to));
}
fs.writeFileSync(path.join(out, 'ocr', 'LICENSES.txt'), ['tesseract.js (Apache-2.0)', 'tesseract.js-core / Tesseract OCR (Apache-2.0)', '@tesseract.js-data/eng: tessdata_best English model (Apache-2.0)', '', fs.readFileSync(path.join(nm, 'tesseract.js-core', 'LICENSE'), 'utf8')].join('\n'));
if (test) {
  const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  mf.name += ' [TEST BUILD]';
  mf.content_scripts[0].matches.push('http://127.0.0.1/*');
  mf.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(mf, null, 2));
}

const kb = (f: string) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} kB`;
const dirKb = (d: string) => `${(fs.readdirSync(path.join(out, d)).reduce((n, f) => n + fs.statSync(path.join(out, d, f)).size, 0) / 1024).toFixed(0)} kB`;
console.log(`extension built in ${out}: background.js ${kb('background.js')}, content.js ${kb('content.js')}, popup.js ${kb('popup.js')}, chunks/ ${dirKb('chunks')}, ocr/ ${dirKb('ocr')}`);

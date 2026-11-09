// Runs the PACKAGED OCR of the screenshot mode (test build, extension page, same worker / core / model / preprocessing
// as for a traveller) on every synthetic fixture image and records the words it found, so unit tests can check the
// parser on real OCR output without running OCR each time. Also records timing and the browser's memory.
//   npm run ext:build -- --test
//   node extension/scripts/screenshot-ocr.mjs [--puppeteer <path>] [--browser <msedge.exe>] [--psm 3] [--only <substring>] [--out <dir>]
// Output: tests/fixtures/extension/screenshots/ocr/<image>.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const repo = path.join(import.meta.dirname, '..', '..');
const ext = path.join(repo, 'extension', 'dist-test');
const fx = path.join(repo, 'tests', 'fixtures', 'extension', 'screenshots');
const outDir = arg('out', path.join(fx, 'ocr'));
const psm = arg('psm', undefined);
const scaleArg = arg('scale', undefined);
const gammaArg = arg('gamma', undefined);
const scaleFor = (img) => scaleArg === undefined ? undefined : scaleArg.startsWith('w') ? Math.min(3, Math.max(1, Number(scaleArg.slice(1)) / img.width)) : Number(scaleArg);
const only = arg('only', '');
const ppPath = arg('puppeteer', path.join(repo, '..', 'fra-fco-mapping', 'node_modules', 'puppeteer-core'));
const browserPath = arg('browser', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const puppeteer = (await import(pathToFileURL(path.join(ppPath, 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).href)).default;
const manifest = JSON.parse(fs.readFileSync(path.join(fx, 'manifest.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

// --mem: memory of THIS browser (its process and its child processes; Windows), private bytes, sampled during each OCR.
// Sampling costs CPU: timings are taken from runs without --mem.
const memMB = () => !process.argv.includes('--mem') ? Promise.resolve(NaN) : new Promise((ok) => execFile('powershell', ['-NoProfile', '-Command',
  `$b = ${browser.process().pid}; $ids = @($b) + @((Get-CimInstance Win32_Process -Filter "ParentProcessId=$b").ProcessId); (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB`],
  { encoding: 'utf8' }, (e, out) => ok(e ? NaN : Number(String(out).trim()))));

const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdgx-ocr-')),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--no-default-browser-check'] });
const rows = [];
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const id = new URL(sw.url()).host;
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`chrome-extension://${id}/popup.html?view=tab`);
  await p.waitForFunction(() => !!window.__cdgxShot, { timeout: 10000 });
  const idle = await memMB();
  console.log(`Shape Detection API TextDetector in this browser: ${await p.evaluate(() => typeof window.TextDetector)}`);
  for (const img of manifest.images) {
    if (only && !img.file.includes(only)) continue;
    const dataUrl = `data:image/${img.file.endsWith(".jpg") ? "jpeg" : "png"};base64,${fs.readFileSync(path.join(fx, img.file)).toString('base64')}`;
    let peak = 0;
    let sampling = true;
    const sampler = (async () => { while (sampling) { const m = await memMB(); if (m > peak) peak = m; await new Promise((ok) => setTimeout(ok, 300)); } })();
    const r = await p.evaluate((u, s, k, g) => window.__cdgxShot.read(u, s, k, g), dataUrl, psm, scaleFor(img), gammaArg === undefined ? undefined : Number(gammaArg));
    sampling = false; await sampler;
    const after = await memMB();
    fs.writeFileSync(path.join(outDir, img.file.replace(/\.(png|jpg)$/, '.json')), JSON.stringify({ image: img.file, engine: 'tesseract.js 7 / tesseract-core-simd-lstm / eng 4.0.0_best_int', psm: psm ?? 'default (3)', scale: r.scale, input: [r.inputWidth, r.inputHeight], ocr: [r.width, r.height], ms: Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, Math.round(v)])), words: r.words.map((w) => ({ ...w, conf: Math.round(w.conf * 10) / 10 })) }, null, 0));
    rows.push({ image: img.file, scale: r.scale, ms: Math.round(r.ms.total), init: Math.round(r.ms.init), recognize: Math.round(r.ms.recognize), words: r.words.length, peakMB: Math.round(peak), afterMB: Math.round(after) });
    console.log(`${img.file.padEnd(42)} ×${r.scale}  ${String(Math.round(r.ms.total)).padStart(5)} ms (init ${Math.round(r.ms.init)}, recognise ${Math.round(r.ms.recognize)})  ${r.words.length} words  browser ${Math.round(peak)} MB peak / ${Math.round(after)} MB after`);
  }
  console.log(`browser idle (extension page open, no OCR): ${Math.round(idle)} MB; errors: ${errors.length ? errors.join(' | ') : 'none'}`);
} finally { await browser.close(); }
fs.writeFileSync(path.join(outDir, '_timing.json'), JSON.stringify(rows, null, 1));

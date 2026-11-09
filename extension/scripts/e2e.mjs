// Browser check of the real extension (test build) in Microsoft Edge or Chromium, against a LOCAL fixture page that
// mimics Skyscanner itinerary cards (the live site is never automated). Uses puppeteer-core (a devDependency; --puppeteer
// still accepts another copy):
//   npm run ext:build -- --test
//   node extension/scripts/e2e.mjs [--browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"] [--puppeteer <path to puppeteer-core>] [--shots <dir>] [--os-clipboard]
// History comes from the flight-data server in .env (FD_PORT, ADMIN_TOKEN); the token is read here and never printed.
// Also the screenshot mode (synthetic images from tests/fixtures/extension/screenshots): paste, file upload, editing,
// missing fields, mode switching, same verdict as the page reading; --os-clipboard adds a real Windows clipboard paste
// (replaces the clipboard content; opens a visible Edge window for a few seconds).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const repo = path.join(import.meta.dirname, '..', '..');
const ext = path.join(repo, 'extension', 'dist-test');
const browserPath = arg('browser', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const shots = arg('shots', path.join(os.tmpdir(), 'cdgx-e2e'));
fs.mkdirSync(shots, { recursive: true });
const ppPath = arg('puppeteer', null);
const puppeteer = (await import(ppPath ? pathToFileURL(path.join(ppPath, 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).href : 'puppeteer-core')).default;

// --env: the .env of the checkout that runs the flight-data server. Default: this checkout's .env; in a worktree
// (.claude/worktrees/<name>, which has none of its own) the main checkout's .env three levels up.
const envFile = arg('env', [path.join(repo, '.env'), path.join(repo, '..', '..', '..', '.env')].find((p) => fs.existsSync(p)) ?? path.join(repo, '.env'));
const env = !fs.existsSync(envFile) ? {} : Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const serverUrl = `http://127.0.0.1:${env.FD_PORT || 8790}`;

// Fixture page: each text fixture as one "card", lines as nested blocks (as a rendered page would give innerText).
const fx = (f) => fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'extension', f), 'utf8').replace(/^\uFEFF/, '');
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const card = (id, f) => `<article id="${id}" class="card"><div class="inner">${fx(f).trim().split(/\r?\n/).map((l) => `<div><span>${esc(l)}</span></div>`).join('')}</div></article>`;
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture results</title><style>body{font:14px sans-serif;margin:20px;background:#eef}.card{background:#fff;margin:12px 0;padding:10px;border-radius:8px;width:520px}#noise{padding:10px}</style></head><body>
<div id="noise">${fx('noise.txt').split(/\r?\n/).map((l) => `<p>${esc(l)}</p>`).join('')}</div>
${card('details', 'details-one-stop.txt')}${card('cardview', 'card-one-stop.txt')}${card('ret', 'details-return.txt')}${card('ath', 'details-unsupported.txt')}${card('direct', 'details-direct.txt')}${card('night', 'details-overnight-self-transfer.txt')}${card('change', 'details-airport-change.txt')}${card('tlv', 'details-to-tlv.txt')}${card('lhr35', 'details-lhr-t3-t5.txt')}${card('lhrly', 'details-lhr-elal.txt')}${card('lhrself', 'details-lhr-self-transfer.txt')}</body></html>`;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(page); });
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const pageUrl = `http://127.0.0.1:${srv.address().port}/results`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdgx-prof-')),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--no-default-browser-check'] });
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 }).catch(() => null);
  check('extension loaded (service worker running)', !!swTarget, swTarget?.url() ?? 'no service worker: the browser may not allow --load-extension');
  if (!swTarget) throw new Error('extension not loaded');
  const extId = new URL(swTarget.url()).host;
  // settings are written from an extension page (puppeteer's worker context has no `chrome`)
  const setup = await browser.newPage();
  await setup.goto(`chrome-extension://${extId}/popup.html`);
  await setup.evaluate((u, t) => chrome.storage.local.set({ serverUrl: u, token: t }), serverUrl, env.ADMIN_TOKEN || env.FD_ADMIN_TOKEN || '');
  await setup.close();

  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(pageUrl, { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('cdgx-host')?.shadowRoot?.querySelector('.cx-fab'), { timeout: 10000 });
  check('"Analyze connection" button injected', true);
  const sh = (sel) => p.evaluate((s) => !!document.getElementById('cdgx-host').shadowRoot.querySelector(s), sel);
  const shText = () => p.evaluate(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-drawer')?.innerText ?? '');
  const analyse = async (id) => {
    await p.evaluate(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-close')?.click());
    await p.waitForFunction(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-fab'), { timeout: 5000 });
    await p.evaluate(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-fab').click());
    await p.waitForFunction(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-hint'), { timeout: 5000 });
    await p.hover(`#${id} .inner div:nth-child(3) span`);
    await p.click(`#${id} .inner div:nth-child(3) span`);
    await p.waitForFunction(() => { const d = document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-drawer'); return d && !/Analysing/.test(d.innerText); }, { timeout: 120000 }).catch(async (e) => { throw new Error(`${e.message}; drawer: ${(await shText()).slice(0, 300)}; hint: ${await p.evaluate(() => document.getElementById("cdgx-host").shadowRoot.innerHTML.slice(0, 300))}`); });   // CDG with the ticket type unknown takes ~7–12 s of routing plus the history lookup
    return shText();
  };

  let t = await analyse('details');
  check('details card → CDG connection analysed', /Connection at CDG/.test(t) && /AF1621/.test(t) && /AF1240/.test(t), t.split('\n').slice(0, 2).join(' | '));
  check('scheduled connection shown (1 h 35 min)', /1 h 35 min/.test(t));
  check('history fetched from the local flight-data server', !/Historical data:/.test(t), (/Historical data:[^\n]*/.exec(t) ?? [''])[0]);
  check('provenance badges present', ['OBSERVED', 'ESTIMATED'].every((b) => t.toUpperCase().includes(b)));
  check('schematic map rendered', await sh('.cx-map svg.smap'));
  check('no "guaranteed/safe" wording', !/\b(safe|safely|guarantee|guaranteed)\b/i.test(t));
  check('compact view: one-line verdict, arrival / departure, one most likely route, needed vs moving, details folded',
    /((comfortable|tight|risky) on our estimates|Depends on the area|Not assessed)/i.test(t) && /ARRIVAL/i.test(t) && /DEPARTURE/i.test(t) && /(Most likely|Illustrative) route:/.test(t)
      && (t.match(/(Most likely|Illustrative) route:/g) ?? []).length === 1 && /Needed ~/.test(t) && /Moving/.test(t) && /More detail/.test(t) && !/Possible transfers/.test(t), (/[^\n]*on our estimates[^\n]*/i.exec(t) ?? [''])[0]);
  check('ticket type asked when the page does not say (R-10)', /Is this connection on one ticket\?/.test(t) && /Separate tickets \(self-transfer\)/.test(t));
  check('map marks the arrival and the departure', await sh('.cx-map svg .mark.from') && await sh('.cx-map svg .mark.to'));
  const pageVerdict = await p.evaluate(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-verdict')?.innerText ?? '');
  await p.screenshot({ path: path.join(shots, 'details-cdg.png') });

  t = await analyse('night');
  const line = (re) => (new RegExp(`[^\\n]*(${re})[^\\n]*`, 'i').exec(t) ?? [''])[0];
  check('overnight journey with a journey-level self-transfer label at FRA (00:30 → 02:40): both ticket types shown, worst plausible case leads (night bus routed)', /Connection at FRA/.test(t) && /One ticket \(protected\):/.test(t) && /Separate tickets \(self-transfer\):/.test(t) && !/^Looks comfortable/m.test(t) && /risky/i.test(t) && !/\b(safe|guaranteed)\b/i.test(t), line('Not assessed|on our estimates|Uncertain'));
  await p.screenshot({ path: path.join(shots, 'night-fra-self-transfer.png') });
  t = await analyse('change');
  check('change of airport (IST → SAW) → not assessed, out of scope', /change of airport/i.test(t) && !/(Most likely|Illustrative) route:/.test(t), line('change of airport'));
  await p.screenshot({ path: path.join(shots, 'airport-change.png') });
  t = await analyse('tlv');
  check('connection to Tel Aviv at MUC → Hall F / additional screening flagged', /Connection at MUC/.test(t) && /(Hall F|screening)/i.test(t), line('Hall F|screening'));
  await p.screenshot({ path: path.join(shots, 'muc-to-tlv.png') });

  // LHR (replaced IST 2026-11-02): terminal-level data only, so T5 shows as one terminal (no per-satellite percentage)
  t = await analyse('lhr35');
  check('LHR T3 → T5 (VS → BA): assessed, connections bus route, no per-satellite share for T5', /Connection at LHR/.test(t) && /(Most likely|Illustrative) route:/.test(t) && !/\b5[ABC]\b[^\n]{0,20}\d+ %/.test(t), line('route:'));
  await p.screenshot({ path: path.join(shots, 'lhr-t3-t5.png') });
  t = await analyse('lhrly');
  check('LHR T2 → T4 onto El Al to Tel Aviv: T4 departure, El Al screening and the unestablished T4 steps shown', /Connection at LHR/.test(t) && /El Al/i.test(t) && /(not established|screening)/i.test(t), line('El Al|screening'));
  await p.screenshot({ path: path.join(shots, 'lhr-elal.png') });
  t = await analyse('lhrself');
  check('LHR self-transfer T4 → T5: separate tickets, UK border / entry warning, check-in deadline', /Connection at LHR/.test(t) && /(Separate tickets|self-transfer)/i.test(t) && /(enters the country|UK border|ETA)/i.test(t), line('country|UK border|ETA'));
  await p.screenshot({ path: path.join(shots, 'lhr-self-transfer.png') });

  t = await analyse('cardview');
  check('results card → missing flight numbers reported', /Not in the itinerary/.test(t) && /flight number/.test(t));
  t = await analyse('ret');
  check('return itinerary → two connections (MUC, ZRH tabs)', await p.evaluate(() => [...document.getElementById('cdgx-host').shadowRoot.querySelectorAll('.cx-tabs button')].map((b) => b.textContent).join(',')) === 'MUC,ZRH');
  t = await analyse('ath');
  check('unsupported airport (ATH) explained', /ATH is not one of the supported/.test(t));
  t = await analyse('direct');
  check('direct flight → manual entry offered', /no change of plane/.test(t) && await sh('.cx-form'));
  await p.evaluate(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-close')?.click());
  await p.evaluate(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-fab').click());
  await p.click('#noise p:nth-child(3)');
  await p.waitForFunction(() => document.getElementById('cdgx-host').shadowRoot.querySelector('.cx-form'), { timeout: 5000 });
  check('non-itinerary click → manual entry offered', /does not look like an itinerary/.test(await shText()));

  // History server down (roadmap P1-9): a closed local port stands in for a stopped server (the live server is never
  // stopped by a test). The analysis must still complete, say the history is unavailable, and never show the token.
  const setServer = async (u) => { const s = await browser.newPage(); await s.goto(`chrome-extension://${extId}/popup.html`); await s.evaluate((x) => chrome.storage.local.set({ serverUrl: x }), u); await s.close(); };
  await setServer('http://127.0.0.1:9');
  t = await analyse('details');
  const tok = env.ADMIN_TOKEN || env.FD_ADMIN_TOKEN || '';
  check('server down → analysis still completes, "history unavailable" note, no prediction claimed, token never shown',
    /Connection at CDG/.test(t) && /Historical data:[^\n]*not reachable/i.test(t) && (!tok || !t.includes(tok)), (/Historical data:[^\n]*/.exec(t) ?? ['no note'])[0]);
  await p.screenshot({ path: path.join(shots, 'server-down.png') });
  await setServer(serverUrl);
  check('no page errors', errors.length === 0, errors.join('; '));

  // Popup page: manual entry → analysis
  const pop = await browser.newPage();
  await pop.setViewport({ width: 620, height: 900 });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForSelector('.cx-form');
  const inputs = await pop.$$('.cx-form fieldset input');
  const vals = ['AF1621', 'TLV', '2026-11-04', '12:05', 'AF1240', 'AMS', '2026-11-04', '13:40'];
  for (const [k, v] of vals.entries()) { await inputs[k].click(); if (/-/.test(v) && v.length === 10) { await inputs[k].evaluate((el, x) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, x); el.dispatchEvent(new Event('input', { bubbles: true })); }, v); } else if (/:/.test(v)) { await inputs[k].evaluate((el, x) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, x); el.dispatchEvent(new Event('input', { bubbles: true })); }, v); } else await inputs[k].type(v); }
  await pop.click('.cx-form button[type=submit]');
  await pop.waitForFunction(() => /Connection at CDG/.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
  const pt = await pop.evaluate(() => document.body.innerText);
  check('popup manual entry → analysis with map', /Connection at CDG/.test(pt) && /1 h 35 min/.test(pt) && !!(await pop.$('.cx-map svg')));
  await pop.screenshot({ path: path.join(shots, 'popup-manual.png'), fullPage: true });

  // ---- Screenshot mode (synthetic fixture images from tests/fixtures/extension/screenshots) ----
  const shotFile = (f) => path.join(repo, 'tests', 'fixtures', 'extension', 'screenshots', f);
  const setVal = (h, v) => h.evaluate((el, x) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, x); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const body = (pg) => pg.evaluate(() => document.body.innerText);
  /** Synthetic paste of an image (DataTransfer with a PNG file), or of text only. */
  const paste = (pg, f) => pg.evaluate(async (b64, isText) => {
    const dt = new DataTransfer();
    if (isText) dt.setData('text/plain', 'just some text');
    else dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, f ? fs.readFileSync(shotFile(f)).toString('base64') : '', !f);
  const waitConfirm = (pg) => pg.waitForFunction(() => document.querySelector('.cx-confirm') || /No itinerary was recognised|could not be read/.test(document.body.innerText), { timeout: 90000 });
  const confirmAll = async (pg) => { for (let k = 0; k < 30; k++) { const b = await pg.$('.cx-ok-btn'); if (!b) break; await b.click(); } };
  const sp = await browser.newPage();
  await sp.setViewport({ width: 620, height: 900 });
  sp.on('pageerror', (e) => errors.push(`screenshot page: ${e.message}`));
  await sp.goto(`chrome-extension://${extId}/popup.html`);
  await sp.waitForSelector('.cx-modes');
  check('popup offers the two input modes', /Read the Skyscanner page/.test(await body(sp)) && /Paste a screenshot/.test(await body(sp)));
  await sp.evaluate(() => [...document.querySelectorAll('.cx-modes button')].find((b) => /screenshot/.test(b.textContent)).click());
  await sp.waitForFunction(() => /Press Ctrl\+V/.test(document.body.innerText));
  await sp.reload();
  await sp.waitForFunction(() => /Press Ctrl\+V/.test(document.body.innerText), { timeout: 5000 }).catch(() => {});
  check('screenshot mode remembered after reopening', /Press Ctrl\+V/.test(await body(sp)));
  await paste(sp, null);
  await sp.waitForFunction(() => /holds text, not an image/.test(document.body.innerText), { timeout: 5000 }).catch(() => {});
  check('paste without an image → clear message', /holds text, not an image/.test(await body(sp)));

  const tRead = Date.now();
  await paste(sp, 'details-one-stop@1.5x.png');
  await waitConfirm(sp);
  const readMs = Date.now() - tRead;
  let st = await body(sp);
  const vals2 = await sp.$$eval('.cx-confirm input', (xs) => xs.map((x) => x.value));
  check('pasted details screenshot → confirmation view with the flights read', ['TLV', 'CDG', 'AF1621', '08:15', '12:05', 'AF1240', '13:40', 'AMS', '2026-11-04'].every((v) => vals2.includes(v)), `read in ${readMs} ms; ${vals2.filter(Boolean).join(' ')}`);
  await sp.screenshot({ path: path.join(shots, 'screenshot-confirm.png'), fullPage: true });
  await confirmAll(sp);
  const enabled = await sp.$eval('.cx-confirm button[type=submit]', (b) => !b.disabled);
  check('nothing left to confirm → analysis allowed', enabled);
  await sp.click('.cx-confirm button[type=submit]');
  await sp.waitForFunction(() => /Connection at CDG/.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
  st = await body(sp);
  const shotVerdict = await sp.evaluate(() => document.querySelector('.cx-verdict')?.innerText ?? '');
  check('screenshot → same engine and panel: CDG analysis, 1 h 35 min, map, provenance "confirmed by you"', /Connection at CDG/.test(st) && /1 h 35 min/.test(st) && !!(await sp.$('.cx-map svg')) && /read from your screenshot and confirmed by you/i.test(st));
  check('same verdict as reading the same itinerary from the page', !!pageVerdict && shotVerdict === pageVerdict, `page: ${pageVerdict} | screenshot: ${shotVerdict}`);
  await sp.screenshot({ path: path.join(shots, 'screenshot-result.png'), fullPage: true });
  await sp.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit details').click());
  await sp.waitForSelector('.cx-confirm', { timeout: 5000 }).catch(() => {});
  check('"Edit details" goes back to the confirmation view with the values', (await sp.$$eval('.cx-confirm input', (xs) => xs.map((x) => x.value))).includes('AF1240'));

  // file upload in the tab view; a results card (no connection times) blocks until they are filled in
  const tp = await browser.newPage();
  await tp.setViewport({ width: 900, height: 1000 });
  tp.on('pageerror', (e) => errors.push(`tab page: ${e.message}`));
  await tp.goto(`chrome-extension://${extId}/popup.html?view=tab&mode=screenshot`);
  await tp.waitForSelector('input[type=file]');
  await (await tp.$('input[type=file]')).uploadFile(shotFile('card-one-stop@1.5x.png'));
  await waitConfirm(tp);
  const sub = () => tp.$eval('.cx-confirm button[type=submit]', (b) => !b.disabled);
  check('file upload (tab view) → results card read; analysis blocked while the connection times are missing', !(await sub()) && /to fill in/.test(await body(tp)));
  const leg = async (i, label) => (await tp.$$(`.cx-leg-row`))[i].$(`input[aria-label="${label}"]`);
  await setVal(await leg(0, 'Arrives (time)'), '12:05');
  await setVal(await leg(1, 'Departs (time)'), '13:40');
  await setVal(await leg(0, 'Departs (date)'), '2026-11-04');
  await confirmAll(tp);
  const filled = await tp.$$eval('.cx-confirm input[type=date]', (xs) => xs.map((x) => x.value));
  check('times typed, one date entered → the other dates filled; analysis allowed', await sub() && filled.every((v) => v === '2026-11-04'), filled.join(','));
  await tp.click('.cx-confirm button[type=submit]');
  await tp.waitForFunction(() => /Connection at CDG/.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
  st = await body(tp);
  check('card screenshot + typed times → analysis, flight numbers reported missing', /Connection at CDG/.test(st) && /Not in the itinerary: arriving flight number, departing flight number/.test(st));
  await tp.screenshot({ path: path.join(shots, 'screenshot-card-tab.png'), fullPage: true });
  await tp.goto(`chrome-extension://${extId}/popup.html?view=tab&mode=screenshot`);
  await tp.waitForSelector('input[type=file]');
  await (await tp.$('input[type=file]')).uploadFile(shotFile('noise@1x.png'));
  await waitConfirm(tp);
  check('non-itinerary image → "No itinerary was recognised", nothing to analyse', /No itinerary was recognised/.test(await body(tp)) && !(await tp.$('.cx-confirm')));
  await tp.close();
  await sp.evaluate(() => [...document.querySelectorAll('.cx-link')].find((b) => /New analysis/.test(b.textContent))?.click());
  await sp.evaluate(() => [...document.querySelectorAll('.cx-modes button')].find((b) => /Skyscanner page/.test(b.textContent))?.click());
  await sp.waitForSelector('.cx-form fieldset input', { timeout: 5000 }).catch(() => {});
  check('switching back to "Read the Skyscanner page" → manual entry form', !!(await sp.$('.cx-form fieldset input')));
  check('no errors on the extension pages', errors.length === 0, errors.join('; '));

  // --os-clipboard: a REAL Windows clipboard paste (replaces the clipboard content with a fixture image; opens a
  // visible Edge window for a few seconds, because headless Edge does not use the system clipboard)
  if (process.argv.includes('--os-clipboard')) {
    const { execFileSync } = await import('node:child_process');
    const img = shotFile('details-to-tlv@1.5x.png');
    execFileSync('powershell', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [System.Drawing.Image]::FromFile('${img.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`]);
    const headed = await puppeteer.launch({ executablePath: browserPath, headless: false, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdgx-prof-')),
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--no-default-browser-check', '--window-size=900,900'] });
    try {
      const sw2 = await headed.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
      const hp = await headed.newPage();
      await hp.goto(`chrome-extension://${new URL(sw2.url()).host}/popup.html?view=tab&mode=screenshot`);
      await hp.waitForFunction(() => /Press Ctrl\+V/.test(document.body.innerText));
      await hp.bringToFront();
      await hp.click('.cx-drop');
      await hp.keyboard.down('Control'); await hp.keyboard.press('KeyV'); await hp.keyboard.up('Control');
      await waitConfirm(hp);
      const v = await hp.$$eval('.cx-confirm input', (xs) => xs.map((x) => x.value));
      check('real Windows clipboard (Set-Clipboard image) + Ctrl+V → itinerary read', ['CDG', 'MUC', 'TLV', 'LH2227', 'LH686', '08:30', '10:20'].every((x) => v.includes(x)), v.filter(Boolean).join(' '));
    } finally { await headed.close(); }
  }
} catch (e) {
  check('run completed', false, e.message);
} finally {
  await browser.close();
  srv.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);

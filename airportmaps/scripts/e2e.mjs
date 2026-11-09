// Headless browser check of the airport maps viewer (not part of npm test: needs a browser).
// Setup: npm i --no-save puppeteer-core@23; start the viewer (npm run maps:dev, or maps:build + maps:preview), then
//   node airportmaps/scripts/e2e.mjs <baseUrl> <screenshot dir> <iata,iata…> [browser path]
// e.g. node airportmaps/scripts/e2e.mjs http://localhost:5175/ %TEMP%/maps fco,fra
// Checks per airport, desktop 1440 px and mobile 390 px: map renders with size, every area has a label, clicking two
// areas draws a route and lists steps, the matrix has n×n cells with no missing route, a matrix click opens the route,
// the URL holds the pair, other tabs render; no console errors.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [base, out, list] = process.argv.slice(2);
const dataDir = new URL('../data/', import.meta.url);
const iatas = !list || list === 'all' ? fs.readdirSync(dataDir).filter((d) => fs.existsSync(new URL(`${d}/airport.json`, dataDir))).sort() : list.split(',');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.argv[5] ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [], results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(w, h, mobile, hash) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${w}px ${hash} console: ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`${w}px ${hash} pageerror: ${e.message}`));
  await p.goto(base + hash, { waitUntil: 'networkidle0' });
  return p;
}

for (const iata of iatas) {
  const model = JSON.parse(fs.readFileSync(new URL(`../data/${iata}/airport.json`, import.meta.url), 'utf8'));
  // matrix areas active on the model date (planned/closed areas drop out, as in the viewer)
  const live = (a) => !(a.status ?? []).some((p) => p.state !== 'active' && (!p.from || p.from <= model.asOf) && (!p.until || model.asOf <= p.until));
  const mx = model.areas.filter((a) => a.matrix && live(a));
  for (const [w, h, mobile] of [[1440, 950, false], [390, 844, true]]) {
    const tag = `${iata} ${w}px`;
    const p = await open(w, h, mobile, `#/${iata}`);
    await p.waitForSelector('svg.smap', { timeout: 30000 });
    const box = await p.$eval('svg.smap', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; });
    ok(`${tag}: map has size`, box[0] > 200 && box[1] > 150, box.map(Math.round).join('×'));
    const labels = await p.$$eval('svg.smap .alabel', (x) => x.length);
    ok(`${tag}: one label per area`, labels === model.areas.length, `${labels}/${model.areas.length}`);
    const gates = await p.$$eval('svg.smap .gate-dot', (x) => x.length);
    const nGates = model.gateGroups.reduce((n, g) => n + g.gates.length, 0);
    ok(`${tag}: gate dots`, gates === nGates, `${gates}/${nGates}`);
    await p.screenshot({ path: `${out}/${iata}-${w}-overview.png`, fullPage: mobile });
    // click two matrix areas on the map: first and last matrix areas
    const a = mx[0].id, b = mx.at(-1).id;
    const clickArea = async (id) => {
      const idx = model.areas.findIndex((x) => x.id === id);
      const el = (await p.$$('svg.smap .alabel'))[idx];
      // dispatch on the label itself: labels of small neighbouring areas may overlap at full-airport zoom
      await el.evaluate((e) => e.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await sleep(150);
    };
    await clickArea(a); await clickArea(b);
    await p.waitForSelector('.route .steps li', { timeout: 10000 }).catch(() => {});
    const steps = await p.$$eval('.route .steps li', (x) => x.length);
    ok(`${tag}: map clicks give a route ${a} → ${b}`, steps > 0, `${steps} steps`);
    const hash = await p.evaluate(() => location.hash);
    ok(`${tag}: URL holds the pair`, hash.includes(`from=${a}`) && hash.includes(`to=${b}`), hash);
    const drawn = await p.$$eval('svg.smap .rt-walk, svg.smap .rt-ride', (x) => x.length);
    ok(`${tag}: route drawn on map`, drawn > 0, `${drawn} segments`);
    await p.screenshot({ path: `${out}/${iata}-${w}-route-${a}-${b}.png`, fullPage: mobile });
    // matrix tab
    await p.$$eval('.tabs button', (bs) => bs.find((x) => x.textContent === 'Transfer matrix').click());
    await p.waitForSelector('table.mx', { timeout: 10000 });
    const cells = await p.$$eval('table.mx tbody td', (x) => x.length);
    ok(`${tag}: matrix ${mx.length}×${mx.length}`, cells === mx.length * mx.length, `${cells}`);
    const none = await p.$$eval('table.mx td.none', (x) => x.length);
    ok(`${tag}: no unroutable matrix cell`, none === 0, `${none}`);
    await p.screenshot({ path: `${out}/${iata}-${w}-matrix.png`, fullPage: true });
    const tds = await p.$$('table.mx tbody tr:nth-child(2) td:not(.diag)');
    if (tds.length) {
      await tds[0].click(); await sleep(200);
      const s2 = await p.$$eval('.route .steps li', (x) => x.length);
      ok(`${tag}: matrix click opens a route`, s2 > 0, `${s2} steps`);
    }
    // zoom in changes the viewBox, reset restores it
    const vb0 = await p.$eval('svg.smap', (e) => e.getAttribute('viewBox'));
    await p.click('button[aria-label="Zoom in"]'); await sleep(100);
    const vb1 = await p.$eval('svg.smap', (e) => e.getAttribute('viewBox'));
    await p.click('button[aria-label="Reset view"]'); await sleep(100);
    const vb2 = await p.$eval('svg.smap', (e) => e.getAttribute('viewBox'));
    ok(`${tag}: zoom and reset`, vb1 !== vb0 && vb2 === vb0, `${vb0} → ${vb1}`);
    // stacked levels are drawn as such
    const nStack = model.areas.filter((x) => x.stack && x.shape).length;
    const drawnStack = await p.$$eval('svg.smap .area.stacked', (x) => x.length);
    ok(`${tag}: stacked areas drawn`, drawnStack === nStack, `${drawnStack}/${nStack}`);
    // gate search: first gate of the first and of the last gated matrix area
    const gated = mx.filter((x) => model.gateGroups.some((g) => g.area === x.id));
    if (gated.length >= 2) {
      const g1 = model.gateGroups.find((g) => g.area === gated[0].id).gates[0];
      const g2 = model.gateGroups.find((g) => g.area === gated.at(-1).id).gates.at(-1);
      await p.evaluate(() => { location.hash = location.hash.split('?')[0]; });
      await sleep(150);
      await p.type('input[aria-label="Arrival gate"]', g1);
      await p.type('input[aria-label="Departure gate"]', g2);
      await p.$$eval('.tabs button', (bs) => bs.find((x) => x.textContent === 'Route').click());
      await sleep(300);
      const head = await p.$eval('.route h2', (e) => e.textContent).catch(() => '');
      const pins = await p.$$eval('svg.smap .gpin', (x) => x.length);
      ok(`${tag}: gate search ${g1} → ${g2}`, head.includes(`Gate ${g1}`) && head.includes(`Gate ${g2}`) && pins === 2, `${head} · ${pins} pins`);
      await p.screenshot({ path: `${out}/${iata}-${w}-gates.png`, fullPage: mobile });
    }
    // a dated status period: the banner shows it on a date inside the period
    const per = [...model.lines, ...model.areas].flatMap((x) => (x.status ?? []).map((s) => ({ x, s }))).find(({ s }) => s.from && s.state !== 'active');
    if (per) {
      const d = per.s.from;
      await p.evaluate((d) => { const [h, q = ''] = location.hash.split('?'); const sp = new URLSearchParams(q); sp.set('d', d); location.hash = `${h}?${sp}`; }, d);
      await sleep(300);
      const banner = await p.$eval('.statusbar', (e) => e.textContent).catch(() => '');
      ok(`${tag}: status banner on ${d}`, banner.includes(per.x.name), banner.slice(0, 120));
      await p.evaluate(() => { const [h, q = ''] = location.hash.split('?'); const sp = new URLSearchParams(q); sp.delete('d'); location.hash = `${h}?${sp}`; });
      await sleep(150);
    }
    // route panel separates movement from control allowances
    const split = await p.$eval('.route .split', (e) => e.textContent).catch(() => '');
    ok(`${tag}: movement / controls split shown`, split.startsWith('Movement'), split.slice(0, 80));
    // night: at 03:00 the matrix still renders n×n; lines whose published windows exclude 03:00 are listed as not running
    const tm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const inW = (t, w) => { const x = tm(t), f = tm(w.from), u = tm(w.until); return f === u || (f === 0 && u === 1440) || (f < u ? x >= f && x < u : x >= f || x < u); };
    const idleAt = (t) => model.lines.filter((l) => !l.notRouted && !(l.status ?? []).some((s) => s.state !== 'active' && (!s.from || s.from <= model.asOf) && (!s.until || model.asOf <= s.until))
      && l.service.filter((s) => !s.days?.length && !s.validFrom && !s.validUntil).length === l.service.length
      && !l.service.some((s) => !s.windows?.length || s.windows.some((w) => inW(t, w))));
    await p.evaluate(() => { const [h, q = ''] = location.hash.split('?'); const sp = new URLSearchParams(q); sp.set('t', '03:00'); location.hash = `${h}?${sp}`; });
    await sleep(300);
    await p.$$eval('.tabs button', (bs) => bs.find((x) => x.textContent === 'Transfer matrix').click());
    await sleep(200);
    const nCells = await p.$$eval('table.mx tbody td', (x) => x.length);
    ok(`${tag}: night matrix (03:00) renders`, nCells === mx.length * mx.length, `${nCells} cells, ${await p.$$eval('table.mx td.none', (x) => x.length)} without route`);
    const idle = idleAt('03:00');
    if (idle.length) {
      const ib = await p.$eval('.statusbar.idle', (e) => e.textContent).catch(() => '');
      ok(`${tag}: lines not running at 03:00 listed`, idle.every((l) => ib.includes(l.name)), ib.slice(0, 120));
    }
    await p.screenshot({ path: `${out}/${iata}-${w}-matrix-0300.png`, fullPage: true });
    await p.evaluate(() => { const [h, q = ''] = location.hash.split('?'); const sp = new URLSearchParams(q); sp.delete('t'); location.hash = `${h}?${sp}`; });
    await sleep(150);
    for (const t of ['Transport', 'Gates', 'Open questions', 'Sources']) {
      await p.$$eval('.tabs button', (bs, t) => bs.find((x) => x.textContent === t).click(), t);
      await sleep(100);
      const txt = await p.$eval('.panel', (e) => e.textContent.length);
      ok(`${tag}: tab ${t} renders`, txt > 40, `${txt} chars`);
    }
    await p.close();
  }
}
const idx = await open(1200, 800, false, '#/');
ok('index lists airports', (await idx.$$eval('.index li a', (x) => x.length)) >= iatas.length);
await browser.close();
console.log(results.join('\n'));
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
const fails = results.filter((r) => r.startsWith('FAIL')).length + errors.length;
console.log(fails ? `${fails} problem(s)` : 'ALL PASS');
process.exit(fails ? 1 : 0);

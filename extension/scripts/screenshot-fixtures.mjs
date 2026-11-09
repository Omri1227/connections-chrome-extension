// Generates SYNTHETIC screenshot fixtures for the screenshot input mode: Skyscanner-like itinerary layouts (results
// card, expanded details, booking summary) written here as HTML, modelled on the public look of those pages and on the
// text fixtures in tests/fixtures/extension/*.txt, rendered in headless Edge at several widths and device scale factors,
// plus cropped / partial variants and a non-itinerary image. Live Skyscanner is never fetched or automated.
//   node extension/scripts/screenshot-fixtures.mjs [--puppeteer <path to puppeteer-core>] [--browser <msedge.exe>]
// Output: tests/fixtures/extension/screenshots/<name>.png + manifest.json (ground truth of every visible field).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const repo = path.join(import.meta.dirname, '..', '..');
const out = path.join(repo, 'tests', 'fixtures', 'extension', 'screenshots');
const ppPath = arg('puppeteer', path.join(repo, '..', 'fra-fco-mapping', 'node_modules', 'puppeteer-core'));
const browserPath = arg('browser', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const puppeteer = (await import(pathToFileURL(path.join(ppPath, 'lib', 'esm', 'puppeteer', 'puppeteer-core.js')).href)).default;

// ---------- itineraries (each mirrors a text fixture where one exists) ----------
// leg: [airline, flight as shown, from, fromName, dep, depPlus, to, toName, arr, arrPlus, duration, operatedBy, depDate, arrDate]
const L = (a) => ({ airline: a[0], flight: a[1], from: a[2], fromName: a[3], dep: a[4], depPlus: a[5], to: a[6], toName: a[7], arr: a[8], arrPlus: a[9], dur: a[10], op: a[11], depDate: a[12], arrDate: a[13] });
const IT = {
  'one-stop': { text: 'details-one-stop.txt', journeys: [{ label: 'Outbound', date: 'Wed, 4 Nov 2026', title: 'Tel Aviv to Amsterdam', total: '7h 50m', arrives: 'Arrives Wed, 4 Nov 2026',
    legs: [L(['Air France', 'AF 1621', 'TLV', 'Tel Aviv Ben Gurion', '08:15', 0, 'CDG', 'Paris Charles de Gaulle', '12:05', 0, '4h 50m', null, '2026-11-04', '2026-11-04']),
      L(['Air France', 'AF 1240', 'CDG', 'Paris Charles de Gaulle', '13:40', 0, 'AMS', 'Amsterdam Schiphol', '15:05', 0, '1h 25m', 'HOP!', '2026-11-04', '2026-11-04'])],
    conns: [{ text: 'Connect in airport', dur: '1h 35m connection', self: false }] }], price: '€312', carriers: 'Air France', stopsText: '1 stop' },
  return: { text: 'details-return.txt', journeys: [
    { label: 'Outbound', date: 'Tue, 10 Nov 2026', legs: [L(['Lufthansa', 'LH 687', 'TLV', 'Tel Aviv Ben Gurion', '05:45', 0, 'MUC', 'Munich', '09:15', 0, '4h 30m', null, '2026-11-10', '2026-11-10']),
      L(['Lufthansa', 'LH 2416', 'MUC', 'Munich', '10:20', 0, 'CDG', 'Paris Charles de Gaulle', '11:50', 0, '1h 30m', null, '2026-11-10', '2026-11-10'])], conns: [{ text: 'Connect in airport', dur: '1h 05m', self: false }] },
    { label: 'Return', date: 'Sun, 15 Nov 2026', legs: [L(['SWISS', 'LX 633', 'CDG', 'Paris Charles de Gaulle', '09:30', 0, 'ZRH', 'Zurich', '10:50', 0, '1h 20m', 'Helvetic Airways', '2026-11-15', '2026-11-15']),
      L(['SWISS', 'LX 256', 'ZRH', 'Zurich', '11:40', 0, 'TLV', 'Tel Aviv Ben Gurion', '16:40', 0, '4h 00m', null, '2026-11-15', '2026-11-15'])], conns: [{ text: 'Connect in airport', dur: '50m', self: false }] }] },
  'overnight-self': { text: 'details-overnight-self-transfer.txt', journeys: [{ label: 'Outbound', date: 'Fri, 13 Nov', self: 'Self transfer', selfNote: "You'll need to collect and re-check your bags",
    legs: [L(['Lufthansa', 'LH 691', 'TLV', 'Tel Aviv Ben Gurion', '20:55', 0, 'FRA', 'Frankfurt am Main', '00:30', 1, '4h 35m', null, '2026-11-13', '2026-11-14']),
      L(['Turkish Airlines', 'TK 1588', 'FRA', 'Frankfurt am Main', '02:40', 0, 'IST', 'Istanbul', '06:45', 0, '3h 05m', null, '2026-11-14', '2026-11-14']),
      L(['Turkish Airlines', 'TK 1861', 'IST', 'Istanbul', '10:00', 0, 'LIS', 'Lisbon Humberto Delgado', '11:20', 0, '2h 20m', null, '2026-11-14', '2026-11-14'])],
    conns: [{ text: 'Change planes in Frankfurt', dur: '2h 10m', self: false }, { text: 'Connect in airport', dur: '3h 15m connection', self: false }] }] },
  'to-tlv': { text: 'details-to-tlv.txt', journeys: [{ label: 'Outbound', date: 'Wed, 18 Nov 2026', title: 'Paris to Tel Aviv',
    legs: [L(['Lufthansa', 'LH 2227', 'CDG', 'Paris Charles de Gaulle', '07:00', 0, 'MUC', 'Munich', '08:30', 0, '1h 30m', null, '2026-11-18', '2026-11-18']),
      L(['Lufthansa', 'LH 686', 'MUC', 'Munich', '10:20', 0, 'TLV', 'Tel Aviv Ben Gurion', '15:00', 0, '3h 40m', null, '2026-11-18', '2026-11-18'])],
    conns: [{ text: 'Connect in airport', dur: '1h 50m connection', self: false }] }] },
  'us-format': { text: 'details-us-format.txt', us: true, journeys: [{ label: 'Depart', date: 'Wed, Nov 4, 2026',
    legs: [L(['Air France', 'AF1621', 'TLV', 'Tel Aviv Ben Gurion', '08:15', 0, 'CDG', 'Paris Charles de Gaulle', '12:05', 0, '', null, '2026-11-04', '2026-11-04']),
      L(['Air France', 'AF0010', 'CDG', 'Paris Charles de Gaulle', '14:30', 0, 'JFK', 'New York John F. Kennedy', '16:45', 0, '', null, '2026-11-04', '2026-11-04'])],
    conns: [{ text: 'Connect in airport', dur: '2h 25m', self: false }] }] },
  'airport-change': { text: 'details-airport-change.txt', journeys: [{ label: 'Outbound', date: 'Thu, 19 Nov 2026', self: 'Self transfer',
    legs: [L(['Pegasus Airlines', 'PC 783', 'TLV', 'Tel Aviv Ben Gurion', '06:10', 0, 'IST', 'Istanbul', '08:15', 0, '2h 05m', null, '2026-11-19', '2026-11-19']),
      L(['Pegasus Airlines', 'PC 1171', 'SAW', 'Istanbul Sabiha Gokcen', '12:15', 0, 'LGW', 'London Gatwick', '14:05', 0, '2h 50m', null, '2026-11-19', '2026-11-19'])],
    conns: [{ text: 'Change airports', dur: '4h 00m', self: false }] }] },
};
// results cards: [airline label, dep, from, dur, stops label, stop codes, arr, arrPlus, to]
const CARDS = {
  'card-one-stop': { text: 'card-one-stop.txt', rows: [['Air France', '08:15', 'TLV', '7h 05m', '1 stop', 'CDG', '15:20', 0, 'AMS']], carriers: 'Air France, KLM', price: '€312' },
  'card-return': { text: 'card-return.txt', rows: [['Lufthansa', '06:10', 'TLV', '9h 40m', '1 stop', 'FRA', '14:50', 0, 'LIS'], ['EL AL', '17:30', 'LIS', '4h 05m', 'Direct', '', '22:35', 0, 'TLV']], carriers: 'Lufthansa, TAP Air Portugal', price: '£488 total' },
  'card-two-stops': { text: 'card-two-stops.txt', self: 'Self transfer', rows: [['Pegasus', '21:40', 'TLV', '14h 25m', '2 stops', 'IST, ZRH', '11:05', 1, 'BCN']], carriers: 'Pegasus Airlines, SWISS', price: '$401' },
};

const CSS = `
* { box-sizing: border-box; } body { margin: 0; padding: 16px; background: #eff3f8; font-family: 'Segoe UI', Arial, sans-serif; color: #161616; }
.card { display: flex; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(37,32,31,.3); overflow: hidden; }
.card .main { flex: 1; padding: 18px 20px 12px; } .card .side { width: 190px; border-left: 1px solid #e0e4e9; padding: 18px; display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; }
.chip { display: inline-block; background: #fff2e8; color: #b9430a; font-size: 12px; font-weight: 600; border-radius: 4px; padding: 2px 8px; margin-bottom: 8px; }
.row { display: grid; grid-template-columns: 110px 70px 1fr 80px; align-items: center; column-gap: 14px; margin: 6px 0 14px; }
.logo { display: flex; flex-direction: column; font-size: 12px; color: #545860; } .logo b { display: inline-block; width: 30px; height: 22px; border-radius: 4px; background: #0b1f66; color: #fff; font-size: 11px; text-align: center; line-height: 22px; margin-bottom: 2px; }
.pt .time { font-size: 20px; font-weight: 700; } .pt .time sup { font-size: 11px; color: #e70866; font-weight: 600; margin-left: 2px; } .pt .code { font-size: 13px; color: #545860; } .pt.r { text-align: right; }
.mid { text-align: center; font-size: 12px; color: #545860; } .bar { height: 2px; background: #c2c9cd; margin: 4px 10px; position: relative; } .bar i { position: absolute; left: 50%; top: -3px; width: 8px; height: 8px; border-radius: 4px; background: #e70866; border: 2px solid #fff; }
.stops .red { color: #e70866; } .stops .green { color: #00a698; }
.carriers { font-size: 12px; color: #545860; } .price { font-size: 22px; font-weight: 700; margin-bottom: 8px; } .btn { background: #0062e3; color: #fff; border-radius: 6px; text-align: center; padding: 8px; font-weight: 600; }
.det { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(37,32,31,.3); padding: 18px 22px; margin-bottom: 14px; }
.det header { display: flex; gap: 12px; align-items: baseline; } .det h2 { margin: 0; font-size: 18px; } .det .date { font-size: 15px; color: #545860; }
.det .title { font-size: 13px; color: #545860; margin: 2px 0 8px; } .det .banner { background: #fff2e8; border-radius: 6px; padding: 6px 10px; margin: 8px 0; font-size: 13px; } .det .banner b { color: #b9430a; }
.seg { display: grid; grid-template-columns: 74px 18px 1fr; column-gap: 10px; margin: 10px 0; }
.seg .t { font-size: 16px; font-weight: 700; } .seg .t sup { font-size: 10px; color: #e70866; margin-left: 1px; } .seg .d { font-size: 12px; color: #545860; }
.seg .rail { position: relative; } .seg .rail::before { content: ''; position: absolute; left: 7px; top: 8px; bottom: 8px; width: 2px; background: #c2c9cd; }
.seg .p { font-size: 15px; } .seg .p b { margin-right: 6px; } .seg .c { font-size: 13px; color: #545860; } .seg .c .lg { display: inline-block; width: 22px; height: 16px; background: #0b1f66; border-radius: 3px; vertical-align: -3px; margin-right: 6px; }
.seg > div { min-height: 22px; display: flex; align-items: center; }
.conn { border-top: 1px dashed #c2c9cd; border-bottom: 1px dashed #c2c9cd; padding: 7px 0 7px 102px; font-size: 13px; color: #161616; } .conn span { color: #545860; margin-left: 8px; }
.foot { font-size: 12px; color: #545860; margin-top: 6px; }
.bk { background: #fff; border-radius: 10px; border: 1px solid #dde1e6; padding: 16px 20px; margin-bottom: 12px; }
.bk h3 { margin: 0 0 10px; font-size: 16px; } .bk .hd { font-size: 13px; color: #545860; margin: 10px 0 4px; }
.bk .lr { display: grid; grid-template-columns: 90px 1fr 90px; align-items: center; column-gap: 16px; }
.bk .lr .time { font-size: 19px; font-weight: 700; } .bk .lr .code { font-size: 13px; color: #545860; } .bk .lr .r { text-align: right; }
.bk .cn { background: #f1f4f8; border-radius: 6px; font-size: 13px; padding: 6px 10px; margin: 10px 0; }
.noise { background: #fff; padding: 18px; border-radius: 10px; width: 640px; } .noise p { margin: 6px 0; } .noise .f { display: inline-block; border: 1px solid #c2c9cd; border-radius: 16px; padding: 3px 12px; margin: 4px; font-size: 13px; }
`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const us = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const sup = (n) => (n ? `<sup>+${n}</sup>` : '');

function detailsHtml(it) {
  const T = (hm) => (it.us ? us(hm) : hm);
  return it.journeys.map((j) => `<section class="det"><header><h2>${esc(j.label)}</h2><span class="date">${esc(j.date)}</span></header>
    ${j.title ? `<div class="title">${esc(j.title)}</div>` : ''}${j.self ? `<div class="banner"><b>${esc(j.self)}</b>${j.selfNote ? ` · ${esc(j.selfNote)}` : ''}</div>` : ''}
    ${j.legs.map((l, k) => `<div class="seg">
      <div class="t">${T(l.dep)}${sup(l.depPlus)}</div><div class="rail"></div><div class="p"><b>${l.from}</b>${esc(l.fromName)}</div>
      <div class="d">${esc(l.dur)}</div><div class="rail"></div><div class="c"><span class="lg"></span>${esc(l.airline)} ${esc(l.flight)}${l.op ? ` · Operated by ${esc(l.op)}` : ''}</div>
      <div class="t">${T(l.arr)}${sup(l.arrPlus)}</div><div class="rail"></div><div class="p"><b>${l.to}</b>${esc(l.toName)}</div></div>
      ${k < j.conns.length ? `<div class="conn">${esc(j.conns[k].text)}<span>${esc(j.conns[k].dur)}</span></div>` : ''}`).join('')}
    ${j.arrives ? `<div class="foot">${esc(j.arrives)} · Journey duration ${esc(j.total)}</div>` : ''}</section>`).join('');
}
function bookingHtml(it) {
  return `<div class="bk"><h3>Your trip</h3>${it.journeys.map((j) => `<div class="hd"><b>${esc(j.label)}</b> · ${esc(j.date)}</div>${j.legs.map((l, k) => `
    <div class="hd">${esc(l.airline)} · ${esc(l.flight.replace(' ', ''))}${l.op ? ` · operated by ${esc(l.op)}` : ''}</div>
    <div class="lr"><div><div class="time">${l.dep}${sup(l.depPlus)}</div><div class="code">${l.from}</div></div><div style="text-align:center;font-size:12px;color:#545860">${esc(l.dur)}<div class="bar"></div></div><div class="r"><div class="time">${l.arr}${sup(l.arrPlus)}</div><div class="code">${l.to}</div></div></div>
    ${k < j.conns.length ? `<div class="cn">${esc(j.conns[k].dur.replace(/ connection$/, ''))} connection · ${esc(j.conns[k].text)}</div>` : ''}`).join('')}`).join('')}</div>`;
}
function cardHtml(c) {
  return `<div class="card"><div class="main">${c.self ? `<span class="chip">${esc(c.self)}</span>` : ''}${c.rows.map((r) => `<div class="row">
    <div class="logo"><b>${esc(r[0].slice(0, 2).toUpperCase())}</b>${esc(r[0])}</div>
    <div class="pt"><div class="time">${r[1]}</div><div class="code">${r[2]}</div></div>
    <div class="mid"><div>${esc(r[3])}</div><div class="bar">${r[4] === 'Direct' ? '' : '<i></i>'}</div><div class="stops"><span class="${r[4] === 'Direct' ? 'green' : 'red'}">${esc(r[4])}</span> ${esc(r[5])}</div></div>
    <div class="pt r"><div class="time">${r[6]}${sup(r[7])}</div><div class="code">${r[8]}</div></div></div>`).join('')}
    <div class="carriers">${esc(c.carriers)}</div></div><div class="side"><div class="price">${esc(c.price)}</div><div class="btn">Select</div></div></div>`;
}
const noiseHtml = () => `<div class="noise"><h2>Explore everywhere</h2><p>Sign in to save searches and get price alerts</p><p><span class="f">Best</span><span class="f">Cheapest</span><span class="f">Fastest</span><span class="f">Filters</span></p><p>Stops · Departure times · Airlines</p><p>Help centre · Privacy policy · Cookie policy</p></div>`;

// ---------- ground truth ----------
const legTruth = (l) => ({ from: l.from, to: l.to, flightNumber: l.flight.replace(/\s/g, '').replace(/^([A-Z0-9]{2})0+/, '$1'), depTime: l.dep, arrTime: l.arr, depDate: l.depDate, arrDate: l.arrDate });
const truthOf = (it, opts = {}) => ({ journeys: it.journeys.slice(0, opts.journeys ?? 9).map((j) => ({ label: j.label, legs: j.legs.slice(0, opts.legs ?? 9).map(legTruth), selfTransfer: j.self ? true : null })) });
const cardTruth = (c) => ({ journeys: c.rows.map((r) => { const chain = [r[2], ...r[5].split(',').map((s) => s.trim()).filter(Boolean), r[8]]; return { label: '', legs: chain.slice(0, -1).map((a, k) => ({ from: a, to: chain[k + 1], flightNumber: null, depTime: k === 0 ? r[1] : null, arrTime: k === chain.length - 2 ? r[6] : null, depDate: null, arrDate: null })), selfTransfer: c.self ? true : null }; }) });

// ---------- variants ----------
// [name, html, width, dpr, crop (fraction of the element: {x,y,w,h}), truth, note]
const V = [];
const add = (name, html, width, dpr, truth, extra = {}) => V.push({ name, html, width, dpr, truth, ...extra });
for (const dpr of [1, 1.25, 1.5, 2]) add(`details-one-stop@${dpr}x`, detailsHtml(IT['one-stop']), 560, dpr, truthOf(IT['one-stop']), { text: IT['one-stop'].text });
add('details-one-stop-wide@1x', detailsHtml(IT['one-stop']), 860, 1, truthOf(IT['one-stop']), { text: IT['one-stop'].text });
add('details-return@1.25x', detailsHtml(IT.return), 560, 1.25, truthOf(IT.return), { text: IT.return.text });
add('details-return@1x', detailsHtml(IT.return), 640, 1, truthOf(IT.return), { text: IT.return.text });
add('details-overnight-self@1x', detailsHtml(IT['overnight-self']), 560, 1, truthOf(IT['overnight-self']), { text: IT['overnight-self'].text });
add('details-overnight-self@2x', detailsHtml(IT['overnight-self']), 560, 2, truthOf(IT['overnight-self']), { text: IT['overnight-self'].text });
add('details-to-tlv@1.5x', detailsHtml(IT['to-tlv']), 560, 1.5, truthOf(IT['to-tlv']), { text: IT['to-tlv'].text });
add('details-us-format@1x', detailsHtml(IT['us-format']), 600, 1, truthOf(IT['us-format']), { text: IT['us-format'].text });
add('details-airport-change@1.25x', detailsHtml(IT['airport-change']), 560, 1.25, truthOf(IT['airport-change']), { text: IT['airport-change'].text });
add('booking-one-stop@1x', bookingHtml(IT['one-stop']), 620, 1, truthOf(IT['one-stop']), { text: IT['one-stop'].text });
add('booking-return@2x', bookingHtml(IT.return), 620, 2, truthOf(IT.return), { text: IT.return.text });
for (const dpr of [1, 1.5]) add(`card-one-stop@${dpr}x`, cardHtml(CARDS['card-one-stop']), 820, dpr, cardTruth(CARDS['card-one-stop']), { text: CARDS['card-one-stop'].text });
add('card-return@1.25x', cardHtml(CARDS['card-return']), 820, 1.25, cardTruth(CARDS['card-return']), { text: CARDS['card-return'].text });
add('card-two-stops-self@1x', cardHtml(CARDS['card-two-stops']), 820, 1, cardTruth(CARDS['card-two-stops']), { text: CARDS['card-two-stops'].text });
add('card-one-stop-narrow@2x', cardHtml(CARDS['card-one-stop']), 640, 2, cardTruth(CARDS['card-one-stop']), { text: CARDS['card-one-stop'].text });
// cropped / partial
add('crop-details-one-stop-right@1x', detailsHtml(IT['one-stop']), 560, 1, truthOf(IT['one-stop']), { crop: { x: 0, y: 0, w: 0.55, h: 1 }, note: 'right part cut off (airport names truncated)' });
add('partial-details-one-stop-top@1.5x', detailsHtml(IT['one-stop']), 560, 1.5, truthOf(IT['one-stop'], { legs: 1 }), { crop: { x: 0, y: 0, w: 1, h: 0.48 }, note: 'only the first flight visible' });
add('crop-card-return-nologo@1x', cardHtml(CARDS['card-return']), 820, 1, cardTruth(CARDS['card-return']), { crop: { x: 0.15, y: 0, w: 0.85, h: 1 }, note: 'airline column cut off' });
add('partial-details-return-outbound@1x', detailsHtml(IT.return), 560, 1, truthOf(IT.return, { journeys: 1 }), { crop: { x: 0, y: 0, w: 1, h: 0.5 }, note: 'only the outbound journey visible' });
add('noise@1x', noiseHtml(), 700, 1, { journeys: [] }, { note: 'not an itinerary' });
// degraded captures: browser zoom 80 % (small text), JPEG compression, dark mode (inverted colours)
add('details-one-stop-zoom80@1x', detailsHtml(IT['one-stop']), 560, 0.8, truthOf(IT['one-stop']), { text: IT['one-stop'].text, note: 'browser zoom 80 %' });
add('card-return-zoom80@1x', cardHtml(CARDS['card-return']), 820, 0.8, cardTruth(CARDS['card-return']), { text: CARDS['card-return'].text, note: 'browser zoom 80 %' });
add('details-return-jpeg@1x', detailsHtml(IT.return), 640, 1, truthOf(IT.return), { text: IT.return.text, jpeg: 55, note: 'JPEG quality 55' });
add('details-to-tlv-dark@1.25x', detailsHtml(IT['to-tlv']), 560, 1.25, truthOf(IT['to-tlv']), { text: IT['to-tlv'].text, dark: true, note: 'dark mode (inverted colours)' });

fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdgx-fx-')), args: ['--no-first-run', '--no-default-browser-check', '--font-render-hinting=none'] });
const manifest = [];
try {
  const p = await browser.newPage();
  for (const v of V) {
    await p.setViewport({ width: v.width + 32, height: 900, deviceScaleFactor: v.dpr });
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body${v.dark ? ' style="filter: invert(1) hue-rotate(180deg)"' : ''}><div id="shot" style="width:${v.width}px">${v.html}</div></body></html>`, { waitUntil: 'load' });
    const el = await p.$('#shot');
    const b = await el.boundingBox();
    const c = v.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const clip = { x: b.x + b.width * c.x, y: b.y + b.height * c.y, width: b.width * c.w, height: b.height * c.h };
    const file = `${v.name}.${v.jpeg ? 'jpg' : 'png'}`;
    await p.screenshot({ path: path.join(out, file), clip, ...(v.jpeg ? { type: 'jpeg', quality: v.jpeg } : {}) });
    manifest.push({ file, synthetic: true, width: Math.round(clip.width * v.dpr), height: Math.round(clip.height * v.dpr), dpr: v.dpr, cssWidth: v.width, crop: v.crop ?? null, note: v.note ?? null, textFixture: v.text ?? null, truth: v.truth });
    console.log(`${file}  ${Math.round(clip.width * v.dpr)}×${Math.round(clip.height * v.dpr)}`);
  }
} finally { await browser.close(); }
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ about: 'SYNTHETIC renderings of Skyscanner-like itinerary layouts (not captures of the live site), generated by extension/scripts/screenshot-fixtures.mjs. truth = every field visible in the image.', images: manifest }, null, 1));

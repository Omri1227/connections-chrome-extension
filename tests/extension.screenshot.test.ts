// Screenshot input mode: layout reconstruction, OCR normalisation, draft extraction with per-field states, the
// confirmation rules, and the recorded OCR output of the synthetic fixture images (field accuracy, no silent errors,
// equivalence with the page-text parser). OCR itself is not run here (see extension.screenshot-ocr.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionsOf } from '../extension/src/core/analyze.ts';
import { parseSkyscannerText } from '../extension/src/core/skyscanner.ts';
import { score, type Truth } from '../extension/src/screenshot/accuracy.ts';
import { extractDraft, fillDates, problems, toItinerary } from '../extension/src/screenshot/extract.ts';
import { layoutText } from '../extension/src/screenshot/layout.ts';
import { normalizeWord, normalizeWords } from '../extension/src/screenshot/normalize.ts';
import { ocrScale, toGray } from '../extension/src/screenshot/preprocess.ts';
import type { Draft, OcrWord } from '../extension/src/screenshot/types.ts';

const TODAY = '2026-11-02';
const FX = path.join(import.meta.dirname, 'fixtures', 'extension');
const SHOTS = path.join(FX, 'screenshots');

/** Words laid out on a grid: rows of [x, text] with 20 px text, rows 40 px apart (row = y index). */
function grid(rows: [number, string][][], conf = 95): OcrWord[] {
  const out: OcrWord[] = [];
  rows.forEach((r, y) => { for (const [x, t] of r) { let cx = x; for (const part of t.split(' ')) { out.push({ text: part, conf, x0: cx, y0: y * 40, x1: cx + part.length * 10, y1: y * 40 + 20 }); cx += part.length * 10 + 6; } } });
  return out;
}

describe('layout: OCR words → text in reading order', () => {
  it('keeps a time and its airport on one row (two-column details layout), whatever the word order', () => {
    const w = grid([[[0, 'Outbound'], [120, 'Wed, 4 Nov 2026']], [[0, '08:15'], [120, 'TLV Tel Aviv']], [[0, '4h 50m'], [120, 'Air France AF 1621']], [[0, '12:05'], [120, 'CDG Paris']]]);
    const { text } = layoutText([...w].reverse());
    expect(text.split('\n').slice(0, 7)).toEqual(['Outbound', 'Wed, 4 Nov 2026', '08:15', 'TLV Tel Aviv', '4h 50m', 'Air France AF 1621', '12:05']);
  });
  it('reads a results-card row column by column so each time is followed by its airport', () => {
    const w = grid([[[0, 'Air France'], [200, '08:15'], [400, '7h 05m'], [700, '15:20'], [900, '€312']], [[200, 'TLV'], [380, '1 stop CDG'], [700, 'AMS']]]);
    const { text } = layoutText(w);
    expect(text.trim().split('\n')).toEqual(['Air France', '08:15', 'TLV', '7h 05m', '1 stop CDG', '15:20', 'AMS', '€312']);
    const it = parseSkyscannerText(text, TODAY);
    expect(it.journeys[0].legs.map((l) => `${l.from}-${l.to}`)).toEqual(['TLV-CDG', 'CDG-AMS']);
  });
  it('a tall box (button, logo) does not chain two card rows together; specks read as "." do not split a card row', () => {
    const w = grid([[[200, '08:15'], [400, '7h 05m'], [700, '15:20']], [[200, 'TLV'], [380, '1 stop CDG'], [700, 'AMS']]]);
    w.push({ text: '[Select', conf: 50, x0: 900, y0: 0, x1: 980, y1: 60 }, { text: '.', conf: 40, x0: 450, y0: 24, x1: 454, y1: 30 });
    const { text } = layoutText(w);
    expect(text.trim().split('\n').slice(0, 7)).toEqual(['08:15', 'TLV', '7h 05m', '1 stop CDG', '15:20', 'AMS', '[Select']);
  });
  it('a full-width line under a booking row (connection text) is not read into the row\'s columns', () => {
    const w = grid([[[0, '08:15'], [300, '4h 50m'], [600, '12:05']], [[0, 'TLV'], [600, 'CDG']], [[0, '1h 35m connection'], [300, 'Connect in airport']]]);
    expect(layoutText(w).text.trim().split('\n')).toEqual(['08:15', 'TLV', '4h 50m', '12:05', 'CDG', '1h 35m connection', 'Connect in airport']);
  });
  it('keeps a superscript "+1" with its time', () => {
    const w: OcrWord[] = [{ text: '00:30', conf: 95, x0: 0, y0: 0, x1: 50, y1: 20 }, { text: '+1', conf: 90, x0: 53, y0: -2, x1: 63, y1: 8 }, { text: 'FRA', conf: 95, x0: 120, y0: 0, x1: 150, y1: 20 }];
    expect(layoutText(w).text).toBe('00:30 +1\nFRA\n');
  });
});

describe('normalisation of OCR confusions (each correction is recorded)', () => {
  const w = (text: string) => normalizeWord({ text, conf: 95, x0: 0, y0: 0, x1: 1, y1: 1 });
  it('times', () => {
    expect(w('O8:15')).toMatchObject({ text: '08:15', corrected: 'O8:15' });
    expect(w('08.15')).toMatchObject({ text: '08:15', corrected: '08.15' });
    expect(w('11:05"')).toMatchObject({ text: '11:05', corrected: '11:05"' });   // unread superscript: day uncertain
    expect(w('00:30+1')).toEqual({ text: '00:30+1', conf: 95, x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(w('08:15,').corrected).toBeUndefined();
    expect(w('3.12').text).toBe('3.12');      // a price, not a time
    expect(w('25:10').text).toBe('25:10');    // not a clock time
  });
  it('airport codes only when the corrected code is a known airport', () => {
    expect(w('C0G').text).toBe('C0G');        // "COG" exists? only accepted when known
    expect(w('AM5')).toMatchObject({ text: 'AMS', corrected: 'AM5' });
    expect(w('105').text).toBe('105');        // digits only: never an airport
  });
  it('flight numbers', () => {
    expect(w('AF1O21')).toMatchObject({ text: 'AF1021', corrected: 'AF1O21' });
    const two = normalizeWords([{ text: 'AF', conf: 95, x0: 0, y0: 0, x1: 1, y1: 1 }, { text: '1O21', conf: 95, x0: 2, y0: 0, x1: 3, y1: 1 }]);
    expect(two[1]).toMatchObject({ text: '1021', corrected: '1O21' });
  });
});

describe('draft: per-field states', () => {
  const details = (conf: Record<string, number> = {}) => grid([
    [[0, 'Outbound'], [120, 'Wed, 4 Nov 2026']],
    [[0, '08:15'], [120, 'TLV Tel Aviv Ben Gurion']], [[0, '4h 50m'], [120, 'Air France AF 1621']], [[0, '12:05'], [120, 'CDG Paris Charles de Gaulle']],
    [[120, 'Connect in airport 1h 35m connection']],
    [[0, '13:40'], [120, 'CDG Paris Charles de Gaulle']], [[0, '1h 25m'], [120, 'Air France AF 1240']], [[0, '15:05'], [120, 'AMS Amsterdam Schiphol']],
  ]).map((x) => ({ ...x, conf: conf[x.text] ?? x.conf }));

  it('clear details → every crucial field read, nothing to confirm, connection time cross-checked', () => {
    const { draft } = extractDraft(details(), TODAY);
    expect(draft.journeys).toHaveLength(1);
    const [a, b] = draft.journeys[0].legs;
    expect([a.f.from.value, a.f.to.value, a.f.depTime.value, a.f.arrTime.value, a.f.flightNumber.value, a.f.depDate.value]).toEqual(['TLV', 'CDG', '08:15', '12:05', 'AF1621', '2026-11-04']);
    expect(a.f.airline).toMatchObject({ value: 'Air France', state: 'read' });
    expect(b.f.flightNumber.value).toBe('AF1240');
    expect(draft.crossChecked).toEqual(['Outbound, connection at CDG']);
    expect(problems(draft)).toEqual([]);
  });
  it('an unclear word makes its field "check" and blocks the analysis until confirmed', () => {
    const { draft } = extractDraft(details({ '1240': 41 }), TODAY);
    expect(draft.journeys[0].legs[1].f.flightNumber).toMatchObject({ value: 'AF1240', state: 'check' });
    expect(problems(draft)).toEqual([{ j: 0, leg: 1, field: 'flightNumber', text: 'confirm or correct' }]);
  });
  it('a time that contradicts the connection time shown is flagged on both sides', () => {
    const w = details().map((x) => (x.text === '13:40' ? { ...x, text: '13:46' } : x));
    const { draft } = extractDraft(w, TODAY);
    expect(draft.warnings.join(' ')).toMatch(/shows a 1h 35m connection, but the times read give 1h 41m/);
    expect(draft.journeys[0].legs[0].f.arrTime.state).toBe('check');
    expect(draft.journeys[0].legs[1].f.depTime.state).toBe('check');
  });
  it('an unclear time that matches the connection time shown is confirmed by it', () => {
    const { draft } = extractDraft(details({ '13:40': 60 }), TODAY);
    expect(draft.journeys[0].legs[1].f.depTime).toMatchObject({ state: 'read', why: 'matches the 1h 35m connection shown' });
  });
  it('dates without a year, or worked out from the clock, are to check', () => {
    const w = grid([[[0, 'Outbound'], [120, 'Fri, 13 Nov']], [[0, '20:55'], [120, 'TLV']], [[120, 'LH 691']], [[0, '00:30'], [120, 'FRA']], [[0, '02:40'], [120, 'FRA']], [[120, 'TK 1588']], [[0, '06:45'], [120, 'IST']]]);
    const { draft } = extractDraft(w, TODAY);
    const [a, b] = draft.journeys[0].legs;
    expect(a.f.depDate).toMatchObject({ value: '2026-11-13', state: 'check' });
    expect(a.f.arrDate).toMatchObject({ value: '2026-11-14', state: 'check' });
    expect(b.f.depDate.value).toBe('2026-11-14');
  });
  it('a results card: connection times missing → must be filled; dates and flight numbers missing do not block', () => {
    const w = grid([[[200, '08:15'], [400, '7h 05m'], [700, '15:20']], [[200, 'TLV'], [380, '1 stop CDG'], [700, 'AMS']]]);
    const { draft } = extractDraft(w, TODAY);
    const ps = problems(draft);
    expect(ps.map((p) => `${p.leg}:${p.field}`).sort()).toEqual(['0:arrTime', '1:depTime']);
    expect(draft.journeys[0].legs[0].f.flightNumber.state).toBe('missing');
  });
  it('a return card whose second row lost its codes: the readable row is kept, the other reported, nothing guessed', () => {
    const w = grid([[[200, '06:10'], [400, '9h 40m'], [700, '14:50']], [[200, 'TLV'], [380, '1 stop FRA'], [700, 'LIS']],
      [[200, '17:30'], [400, '4h 05m'], [700, '22:35']], [[0, 'Lufthansa, TAP Air Portugal']]]);
    const { draft } = extractDraft(w, TODAY);
    expect(draft.journeys.map((j) => j.legs.map((l) => `${l.f.from.value}-${l.f.to.value}`).join(' '))).toEqual(['TLV-FRA FRA-LIS']);
    expect(draft.warnings.join(' ')).toMatch(/Row 2 of the card \(17:30 → 22:35\) could not be read completely/);
    expect(draft.journeys[0].legs[0].f.from.state).toBe('read');
  });
  it('a time left over (layout not understood) → every value is to check, even those read clearly', () => {
    const w = grid([[[0, 'Outbound'], [120, 'Wed, 4 Nov 2026']], [[0, '08:15'], [120, 'TLV']], [[120, 'AF 1621']], [[0, '12:05'], [120, 'CDG']], [[0, '13:40'], [120, 'CDG']], [[120, 'AF 1240']], [[0, '15:05'], [120, 'AMS']], [[0, '19:20']]]);
    const { draft } = extractDraft(w, TODAY);
    expect(draft.warnings.join(' ')).toMatch(/time\(s\) 19:20 that could not be placed/);
    expect(draft.journeys[0].legs.flatMap((l) => Object.values(l.f)).every((f) => f.state !== 'read')).toBe(true);
  });
  it('no itinerary → no journeys and a clear warning', () => {
    const { draft } = extractDraft(grid([[[0, 'Explore everywhere']], [[0, 'Best Cheapest Fastest']]]), TODAY);
    expect(draft.journeys).toEqual([]);
    expect(draft.warnings.join(' ')).toMatch(/No itinerary was recognised/);
  });
  it('fillDates: one date entered fills the journey, day changes marked to check', () => {
    const w = grid([[[200, '21:40'], [400, '14h 25m'], [700, '11:05 +1']], [[200, 'TLV'], [380, '1 stop IST'], [700, 'BCN']]]);
    let d: Draft = extractDraft(w, TODAY).draft;
    const j = d.journeys[0];
    j.legs[0].f.arrTime = { value: '23:55', state: 'typed' };
    j.legs[1].f.depTime = { value: '01:10', state: 'typed' };
    j.legs[0].f.depDate = { value: '2026-11-20', state: 'typed' };
    const f = fillDates(j);
    expect(f.legs.map((l) => [l.f.depDate.value, l.f.arrDate.value])).toEqual([['2026-11-20', '2026-11-20'], ['2026-11-21', '2026-11-21']]);
    expect(f.legs[1].f.depDate.state).toBe('check');
    expect(f.legs[0].f.arrDate.state).toBe('typed');
  });
});

describe('preprocessing', () => {
  it('scales small snips up and huge screenshots down', () => {
    expect(ocrScale(560, 300)).toBe(3);
    expect(ocrScale(1200, 600)).toBe(2);
    expect(ocrScale(3840, 2160)).toBe(1);
    expect(ocrScale(8000, 4000)).toBeLessThan(0.62);
  });
  it('grey, and dark backgrounds inverted', () => {
    const px = new Uint8ClampedArray([10, 10, 10, 255, 20, 20, 20, 255]);
    expect(toGray(px).inverted).toBe(true);
    expect(px[0]).toBe(245);
    const g = new Uint8ClampedArray([136, 136, 136, 255, 255, 255, 255, 255]);
    toGray(g, 2);
    expect([g[0], g[4]]).toEqual([73, 255]);   // grey text darker, white stays white
  });
});

// ---------- recorded OCR output of the synthetic fixture images ----------
const manifest = JSON.parse(fs.readFileSync(path.join(SHOTS, 'manifest.json'), 'utf8')) as { images: { file: string; truth: Truth; textFixture: string | null; crop: unknown }[] };
const recorded = (f: string) => JSON.parse(fs.readFileSync(path.join(SHOTS, 'ocr', f.replace(/\.(png|jpg)$/, '.json')), 'utf8')) as { words: OcrWord[] };
// the display-only names (airline, operated-by) are not read by the analysis engine and are left out of the comparison
const noAirline = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'airline' || k === 'operatedBy' ? undefined : v)));

/** The traveller's confirmation, simulated: every value not marked 'read' is set to what the image shows (if it shows it). */
function confirmAsTraveller(d: Draft, t: Truth): Draft {
  return { ...d, journeys: d.journeys.map((j, ji) => ({ ...j, legs: j.legs.map((l, li) => {
    const tl = t.journeys[ji]?.legs[li];
    if (!tl) return l;
    const f = { ...l.f };
    for (const k of ['from', 'to', 'flightNumber', 'depTime', 'arrTime', 'depDate', 'arrDate'] as const) if (f[k].state !== 'read' && tl[k] !== null) f[k] = { value: tl[k], state: 'typed' };
    return { ...l, f };
  }) })) };
}

describe('recorded OCR of the synthetic screenshots', () => {
  for (const img of manifest.images) {
    it(`${img.file}: no silently wrong or invented value`, () => {
      const { draft } = extractDraft(recorded(img.file).words, TODAY);
      const s = score(draft, img.truth);
      expect(s.counts.silent, s.details.join('\n')).toBe(0);
      expect(s.counts.invented, s.details.join('\n')).toBe(0);
      if (!img.truth.journeys.length) expect(draft.journeys).toEqual([]);
    });
  }
  // equivalence with the page reading (same parser, same model): the uncropped renderings of the text fixtures, after
  // the confirmation step: values to check or missing are confirmed / typed from what the screenshot shows (the ground
  // truth); values marked as read are left untouched, so a silent misreading would make these tests fail
  for (const img of manifest.images.filter((i) => i.textFixture && !i.crop)) {
    it(`${img.file}: confirmed screenshot → the same connections as reading ${img.textFixture} from the page`, () => {
      const { draft } = extractDraft(recorded(img.file).words, TODAY);
      const page = connectionsOf(parseSkyscannerText(fs.readFileSync(path.join(FX, img.textFixture!), 'utf8').replace(/^﻿/, ''), TODAY));
      const shot = connectionsOf(toItinerary(confirmAsTraveller(draft, img.truth)));
      expect(noAirline(shot)).toEqual(noAirline(page));
    });
  }
});

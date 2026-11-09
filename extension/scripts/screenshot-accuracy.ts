// Accuracy report of the screenshot mode on the recorded OCR output of the synthetic fixtures
// (record first with extension/scripts/screenshot-ocr.mjs).
//   npx tsx extension/scripts/screenshot-accuracy.ts [--ocr <dir>] [--verbose]
// Per image: values read correctly (no check needed), correct but flagged for a check, wrong but flagged, wrong and NOT
// flagged ("silent", must be 0), missing, invented; and whether the confirmed reading gives the same connections as the
// page-text parser on the matching text fixture.
import fs from 'node:fs';
import path from 'node:path';
import { connectionsOf } from '../src/core/analyze.ts';
import { parseSkyscannerText } from '../src/core/skyscanner.ts';
import { score, SCORED, type Truth } from '../src/screenshot/accuracy.ts';
import { extractDraft, toItinerary } from '../src/screenshot/extract.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const verbose = process.argv.includes('--verbose');
const repo = path.join(import.meta.dirname, '..', '..');
const fx = path.join(repo, 'tests', 'fixtures', 'extension', 'screenshots');
const ocrDir = arg('ocr', path.join(fx, 'ocr'));
const TODAY = '2026-11-02';
const manifest = JSON.parse(fs.readFileSync(path.join(fx, 'manifest.json'), 'utf8')) as { images: { file: string; truth: Truth; textFixture: string | null }[] };
// canonical form without the display-only names (airline: never filled by the page parser; operated-by: attached to
// a neighbouring flight by the page parser in some layouts); the analysis engine reads neither
const strip = (x: unknown): string => JSON.stringify(x, (k, v) => (k === 'airline' || k === 'operatedBy' ? undefined : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

const tot: Record<string, number> = { read: 0, check: 0, wrongChecked: 0, silent: 0, missing: 0, invented: 0 };
const byField: Record<string, Record<string, number>> = {};
console.log('image'.padEnd(40), 'fields read  check  wrong✓  SILENT  missing  invented  legs  same-connections');
for (const img of manifest.images) {
  const f = path.join(ocrDir, img.file.replace(/\.(png|jpg)$/, '.json'));
  if (!fs.existsSync(f)) { console.log(img.file.padEnd(40), '(no OCR recording)'); continue; }
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  const { draft, text } = extractDraft(rec.words, TODAY);
  const s = score(draft, img.truth);
  const n = Object.values(s.counts).reduce((a, b) => a + b, 0) - s.counts.invented;
  for (const k of Object.keys(tot)) tot[k] += s.counts[k as keyof typeof s.counts];
  for (const k of SCORED) { byField[k] ??= {}; for (const [o, v] of Object.entries(s.byField[k])) byField[k][o] = (byField[k][o] ?? 0) + v; }
  let same = '';
  if (img.textFixture && img.truth.journeys.length) {
    const page = connectionsOf(parseSkyscannerText(fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'extension', img.textFixture), 'utf8').replace(/^﻿/, ''), TODAY));
    const shot = connectionsOf(toItinerary(draft));
    same = strip(page) === strip(shot) ? 'yes' : 'NO';
  }
  console.log(img.file.padEnd(40), String(n).padStart(6), String(s.counts.read).padStart(5), String(s.counts.check).padStart(6), String(s.counts.wrongChecked).padStart(7), String(s.counts.silent).padStart(7), String(s.counts.missing).padStart(8), String(s.counts.invented).padStart(9), `${s.legsFound}/${s.legsTruth}`.padStart(5), ` ${same}`);
  if (verbose || s.counts.silent || s.counts.invented) for (const d of s.details) console.log('   ', d);
  if (verbose) console.log(text.split('\n').map((l) => `      | ${l}`).join('\n'));
}
const all = Object.values(tot).reduce((a, b) => a + b, 0) - tot.invented;
console.log(`\nall visible fields: ${all}; read correctly without a check ${tot.read} (${Math.round((100 * tot.read) / all)} %), correct but to check ${tot.check}, wrong but flagged ${tot.wrongChecked}, SILENTLY WRONG ${tot.silent}, missing ${tot.missing}, invented ${tot.invented}`);
for (const [k, v] of Object.entries(byField)) { const n = Object.values(v).reduce((a, b) => a + b, 0) - (v.invented ?? 0); console.log(`  ${k.padEnd(13)} n=${String(n).padStart(3)}  read ${v.read}  check ${v.check}  wrong✓ ${v.wrongChecked}  silent ${v.silent}  missing ${v.missing}`); }

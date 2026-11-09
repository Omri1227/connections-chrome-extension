// OCR words → text in the reading order the Skyscanner text parser expects (core/skyscanner.ts works on the visible
// text of an itinerary, in DOM order). A screenshot has no DOM order, so it is rebuilt from the word boxes:
//   1. words on the same visual row (vertical overlap) form one line, left to right — this keeps "08:15  TLV Tel Aviv"
//      together in the two-column details layout, which the OCR engine itself often reads column by column;
//   2. a line is split into segments at wide gaps (separate boxes on the page), one segment per output line;
//   3. results-card rows ("08:15   7h 05m   15:20" over "TLV   1 stop CDG   AMS") are read column by column, so each
//      time is followed by its airport code, as in the page text.
// Pure (no browser APIs): unit-tested on recorded OCR output.
import { isKnownAirport } from '../core/airports.ts';
import type { OcrWord } from './types.ts';

export interface Span { start: number; end: number; word: OcrWord }
/** `cardRows`: character offset where each results-card row (one journey of a card) starts. */
export interface LaidOut { text: string; spans: Span[]; lines: OcrWord[][]; cardRows: number[] }

const h = (w: OcrWord) => Math.max(1, w.y1 - w.y0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const TIME = /^(?:[01]?\d|2[0-3]):[0-5]\d/;
const isCode = (t: string) => /^[A-Z]{3}[,.]?$/.test(t) && isKnownAirport(t.slice(0, 3));

/** Words grouped into visual rows (top to bottom), each row left to right. */
export function visualLines(words: OcrWord[]): OcrWord[][] {
  // Each row is matched on its CORE band (median top / bottom of its words), not the union of its boxes, so a tall box
  // (a button, a logo read as text, a two-line airline label) cannot chain two text rows together. Tall boxes are
  // placed last, into the row they overlap most, without moving its core.
  // words without a letter or digit (separators, specks read as "." or "|") carry nothing and would form rows of their own
  const all = words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
  const typical = median(all.map(h)) || 1;
  const tall = (w: OcrWord) => h(w) > typical * 1.8;
  const ws = [...all.filter((w) => !tall(w)).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1)), ...all.filter(tall)];
  const rows: { y0s: number[]; y1s: number[]; words: OcrWord[] }[] = [];
  const core = (r: (typeof rows)[number]) => ({ y0: median(r.y0s), y1: median(r.y1s) });
  for (const w of ws) {
    let best: (typeof rows)[number] | null = null, bestOv = 0;
    for (const r of rows) {
      const c = core(r);
      const ov = Math.min(w.y1, c.y1) - Math.max(w.y0, c.y0);
      const rel = ov / Math.max(1, Math.min(h(w), c.y1 - c.y0));
      if (rel >= 0.5 && rel > bestOv) { best = r; bestOv = rel; }
    }
    if (best) { best.words.push(w); if (!tall(w)) { best.y0s.push(w.y0); best.y1s.push(w.y1); } }
    else rows.push({ y0s: [w.y0], y1s: [w.y1], words: [w] });
  }
  const mid = (r: (typeof rows)[number]) => { const c = core(r); return c.y0 + c.y1; };
  return rows.sort((a, b) => mid(a) - mid(b)).map((r) => r.words.sort((a, b) => a.x0 - b.x0));
}

/** Splits one visual row into boxes at gaps wider than the row's text height. */
export function segments(line: OcrWord[]): OcrWord[][] {
  const lh = median(line.map(h));
  const out: OcrWord[][] = [];
  for (const w of line) {
    const last = out.at(-1);
    if (last && w.x0 - last.at(-1)!.x1 <= lh * 1.1) last.push(w); else out.push([w]);
  }
  return out;
}

const segX = (s: OcrWord[]) => ({ x0: Math.min(...s.map((w) => w.x0)), x1: Math.max(...s.map((w) => w.x1)) });
const hasTime = (s: OcrWord[]) => s.some((w) => TIME.test(w.text));

/**
 * Lays out OCR words as text. Returns the text and, for each word, its character range (used to give every parsed
 * field the confidence of the words it was read from).
 */
export function layoutText(words: OcrWord[]): LaidOut {
  const lines = visualLines(words);
  const segs = lines.map(segments);
  const blocks: OcrWord[][] = [];   // output lines, in order
  const bandStarts: number[] = [];  // index in `blocks` of the first line of each results-card row
  for (let k = 0; k < segs.length; k++) {
    const row = segs[k];
    const timeCols = row.filter(hasTime).length;
    const rowCodes = row.some((s) => s.some((w) => isCode(w.text)));
    if (timeCols >= 2 && !rowCodes) {
      // results-card band: this row of times, and the rows under it until the next row with a time
      const lh = median(lines[k].map(h));
      const band: OcrWord[][][] = [];
      let bottom = Math.max(...lines[k].map((w) => w.y1));
      for (let j = k + 1; j < segs.length && band.length < 3; j++) {
        const top = Math.min(...lines[j].map((w) => w.y0));
        // the band holds the rows of the same card row: split into boxes like the times above (a single full-width
        // line such as "1h 05m connection · Connect in airport" or a heading ends it)
        // it must hold the airports or the stops of that row (not, e.g., a connection line between two flights)
        const rowText = lines[j].map((w) => w.text).join(' ');
        if (segs[j].some(hasTime) || top - bottom > lh * 2.2 || segs[j].length < 2 || !(lines[j].some((w) => isCode(w.text)) || /\b\d\s+stops?\b|\bdirect\b|\bnon-?stop\b/i.test(rowText))) break;
        band.push(segs[j]);
        bottom = Math.max(...lines[j].map((w) => w.y1));
      }
      const cols = row.map((s) => ({ x: segX(s), items: [s] }));
      for (const r of band) for (const s of r) {
        const x = segX(s), cx = (x.x0 + x.x1) / 2;
        // the column whose box overlaps most, else the nearest centre
        let bi = 0, bv = -Infinity;
        cols.forEach((c, i) => { const ov = Math.min(x.x1, c.x.x1) - Math.max(x.x0, c.x.x0); const v = ov > 0 ? ov : -Math.abs(cx - (c.x.x0 + c.x.x1) / 2); if (v > bv) { bv = v; bi = i; } });
        cols[bi].items.push(s);
      }
      bandStarts.push(blocks.length);
      for (const c of cols) blocks.push(...c.items);
      k += band.length;
      continue;
    }
    blocks.push(...row);
  }
  let text = '';
  const spans: Span[] = [];
  const cardRows: number[] = [];
  for (const [bi, b] of blocks.entries()) {
    if (bandStarts.includes(bi)) cardRows.push(text.length);
    b.forEach((w, i) => { if (i) text += ' '; spans.push({ start: text.length, end: text.length + w.text.length, word: w }); text += w.text; });
    text += '\n';
  }
  return { text, spans, lines, cardRows };
}

/** The words whose characters overlap [start, end). */
export const wordsIn = (spans: Span[], start: number, end: number) => spans.filter((s) => s.start < end && s.end > start).map((s) => s.word);

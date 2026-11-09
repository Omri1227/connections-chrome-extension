// OCR words → a DRAFT itinerary with a state per field ('read' / 'check' / 'missing'). The itinerary itself is parsed
// by the same Skyscanner text parser as the direct page reading (core/skyscanner.ts), from the text rebuilt out of the
// word boxes (layout.ts), so both modes share one set of rules for times, "+1" days, airport codes, flight numbers,
// dates and self-transfer labels. This module only adds what OCR needs on top: how sure each value is.
//
// Rules (fail-safe):
//   - a value is 'read' only when every word it came from was recognised with confidence ≥ READ_CONF and needed no
//     correction; a value that occurs several times takes its LEAST certain occurrence;
//   - dates are 'read' only when the screenshot shows that very date with its year; dates worked out from the clock
//     times (next day), or without a year, are 'check';
//   - the connection time shown in the screenshot ("1h 35m connection") is compared with the times read: a mismatch
//     flags both times; a match confirms them;
//   - nothing is ever invented: a value not in the screenshot is 'missing' (the traveller types it, or the analysis
//     reports it as missing, as for a page reading).
import { normFlight } from '../core/flight.ts';
import { parseSkyscannerText, scheduledConnectionMinutes, tokenize } from '../core/skyscanner.ts';
import type { Itinerary, Journey, Leg } from '../core/types.ts';
import { layoutText, wordsIn, type Span } from './layout.ts';
import { normalizeWords } from './normalize.ts';
import type { Draft, DraftJourney, DraftLeg, Field, LegField, OcrWord } from './types.ts';

/** Minimum OCR confidence (0–100) of every word of a value for it to count as read without a check. */
export const READ_CONF = 75;

type Tok = ReturnType<typeof tokenize>[number];

/** Character length of the token starting at `i` (the tokenizer reports positions only). */
function tokLen(text: string, t: Tok): number {
  const rest = text.slice(t.i);
  const re = t.t === 'time' ? /^\d{1,2}:\d{2}(?:[  ]?[AaPp]\.?[Mm]\.?)?(?:[ \t]*\+[ \t]?\d)?/
    : t.t === 'airport' ? /^[A-Z]{3}/
    : t.t === 'flight' ? /^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?/
    : t.t === 'date' ? /^(?:\d{1,2}(?:st|nd|rd|th)?[ \t]+[A-Za-z]+\.?,?(?:[ \t]+\d{4})?|[A-Za-z]+\.?[ \t]+\d{1,2}(?:st|nd|rd|th)?,?(?:[ \t]+\d{4})?|\d{4}-\d{2}-\d{2})/
    : t.t === 'self' ? /^[^\n]{1,40}?(?:transfer|tickets|separately)/i
    : /^\S+/;
  return re.exec(rest)?.[0].length ?? 1;
}

interface Evidence { conf: number; corrected: string[]; n: number }
function evidence(text: string, spans: Span[], toks: Tok[]): Evidence {
  const ws = toks.flatMap((t) => wordsIn(spans, t.i, t.i + tokLen(text, t)));
  return { conf: ws.length ? Math.min(...ws.map((w) => w.conf)) : 0, corrected: [...new Set(ws.filter((w) => w.corrected).map((w) => `“${w.corrected}”`))], n: toks.length };
}

const pct = (c: number) => `${Math.round(c)} %`;
function fieldFrom(value: string | null, ev: Evidence | null, label: string): Field {
  if (value === null || value === '') return { value: null, state: 'missing', why: `${label} is not in the screenshot` };
  if (!ev || !ev.n) return { value, state: 'check', why: 'worked out, not read directly' };
  if (ev.corrected.length) return { value, state: 'check', why: `read as ${ev.corrected.join(', ')} and corrected` };
  if (ev.conf < READ_CONF) return { value, state: 'check', why: `unclear in the screenshot (OCR confidence ${pct(ev.conf)})` };
  return { value, state: 'read' };
}

const pad = (n: number) => String(n).padStart(2, '0');
const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const DUR = /\b(\d{1,2})\s?h(?:rs?)?(?:\s?(\d{1,2})\s?m(?:in)?)?\b|\b(\d{1,3})\s?m(?:in)?\b/g;

/** Reads the airline name in front of a flight number on the same line ("Air France AF 1621", "Air France · AF1621"). */
function airlineBefore(text: string, spans: Span[], at: number): { name: string; conf: number } | null {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const ws = wordsIn(spans, lineStart, at).filter((w) => !/^[·•|\-–—:]$/.test(w.text));
  const name: OcrWord[] = [];
  for (let k = ws.length - 1; k >= 0 && name.length < 4; k--) {
    const w = ws[k];
    if (!/^[A-Za-z][A-Za-z.!&'-]*$/.test(w.text) || w.conf < 50) break;
    name.unshift(w);
  }
  if (!name.length || name.every((w) => w.text.length <= 2)) return null;
  return { name: name.map((w) => w.text).join(' '), conf: Math.min(...name.map((w) => w.conf)) };
}

export interface Extraction { draft: Draft; text: string; parsed: Itinerary }

/** Builds the draft from OCR words. `today` (YYYY-MM-DD) resolves dates shown without a year, as for page text. */
export function extractDraft(words: OcrWord[], today: string): Extraction {
  const norm = normalizeWords(words);
  const { text, spans, cardRows } = layoutText(norm);
  let parsed = parseSkyscannerText(text, today);
  const rowWarnings: string[] = [];
  let scope: [number, number][] = [[0, text.length]];   // the text the journeys were read from
  // A results card with several rows (outbound + return): when the whole card does not give one journey per row (a
  // code unreadable in one row upsets the pairing of the others), each row is parsed on its own, so the readable rows
  // still come through and the unreadable one is reported, never guessed.
  const STOPS = /\b\d\s+stops?\b|\bdirect\b|\bnon-?stop\b/i;
  if (cardRows.length >= 2) {
    const cuts = [0, ...cardRows.slice(1), text.length];
    const parts = cuts.slice(0, -1).map((c, k) => text.slice(c, cuts[k + 1]));
    // results-card rows (each with "1 stop" / "Direct"; a row whose codes were all lost counts as unreadable), not the
    // per-flight rows of a booking summary (no stops label)
    const hasCode = (p: string) => tokenize(p).some((t) => t.t === 'airport');
    if (parts.some(hasCode) && parts.filter(hasCode).every((p) => STOPS.test(p)) && parsed.journeys.length < parts.length) {
      const rows = parts.map((p) => parseSkyscannerText(p, today));
      const journeys = rows.flatMap((r, k) => {
        if (!r.journeys.length) rowWarnings.push(`Row ${k + 1} of the card (${(parts[k].match(/\b\d{1,2}:\d{2}\b/g) ?? []).join(' → ')}) could not be read completely, so it is left out: paste a clearer screenshot of it to analyse it.`);
        return r.journeys.map((j) => ({ ...j, label: parts.length === 2 ? (k === 0 ? 'Outbound' : 'Return') : `Journey ${k + 1}` }));
      });
      if (journeys.length && journeys.length >= parsed.journeys.length) {
        parsed = { ...parsed, journeys, warnings: rows.flatMap((r) => r.warnings.filter((w) => !/No flight times/.test(w))) };
        scope = rows.flatMap((r, k) => (r.journeys.length ? [[cuts[k], cuts[k + 1]] as [number, number]] : []));
      }
      else rowWarnings.length = 0;
    }
  }
  const toks = tokenize(text);
  const of = <K extends Tok['t']>(k: K) => toks.filter((t) => t.t === k) as Extract<Tok, { t: K }>[];
  const times = of('time'), airports = of('airport'), flights = of('flight'), dates = of('date'), selfs = of('self');
  const warnings = [...parsed.warnings, ...rowWarnings];
  const crossChecked: string[] = [];

  const timeField = (v: string | null, label: string) => fieldFrom(v, v ? evidence(text, spans, times.filter((t) => t.hm === v)) : null, label);
  const apField = (v: string, label: string) => fieldFrom(v || null, v ? evidence(text, spans, airports.filter((t) => t.code === v)) : null, label);
  const flField = (v: string | null) => fieldFrom(v, v ? evidence(text, spans, flights.filter((t) => t.code === v)) : null, 'The flight number');
  const dateField = (v: string | null, label: string): Field => {
    if (!v) return { value: null, state: 'missing', why: `${label} is not in the screenshot` };
    const shown = dates.filter((d) => d.m === Number(v.slice(5, 7)) && d.d === Number(v.slice(8, 10)) && (d.y === null || d.y === Number(v.slice(0, 4))));
    if (!shown.length) return { value: v, state: 'check', why: 'worked out from the times (the day changes): check it' };
    if (shown.some((d) => d.y === null)) return { value: v, state: 'check', why: `the year is not shown; ${v.slice(0, 4)} is assumed` };
    return fieldFrom(v, evidence(text, spans, shown), label);
  };

  const journeys: DraftJourney[] = parsed.journeys.map((j) => {
    const legs: DraftLeg[] = j.legs.map((l) => {
      const fl = l.flightNumber ? flights.find((t) => t.code === l.flightNumber) : undefined;
      const air = fl ? airlineBefore(text, spans, fl.i) : null;
      const f: Record<LegField, Field> = {
        from: apField(l.from, 'The departure airport'), to: apField(l.to, 'The arrival airport'),
        depDate: dateField(l.depDate, 'The departure date'), depTime: timeField(l.depTime, 'The departure time'),
        arrDate: dateField(l.arrDate, 'The arrival date'), arrTime: timeField(l.arrTime, 'The arrival time'),
        flightNumber: flField(l.flightNumber),
        airline: air ? { value: air.name, state: air.conf >= READ_CONF ? 'read' : 'check', why: air.conf >= READ_CONF ? undefined : `unclear in the screenshot (OCR confidence ${pct(air.conf)})` } : { value: null, state: 'missing', why: 'The airline is not in the screenshot next to the flight number' },
      };
      return { f, altNumbers: l.altNumbers, operatedBy: l.operatedBy };
    });
    // ticket type per connection: a self-transfer label read from the screenshot, else unknown (the traveller chooses)
    const selfEv = evidence(text, spans, selfs.filter((t) => !t.neg));
    const selfTransferAt = j.selfTransferAt ?? legs.slice(1).map(() => null);
    const ticketState = selfTransferAt.map((s) => (s ? (selfEv.conf >= READ_CONF ? 'read' : 'check') : 'missing') as Field['state']);
    // the connection time shown in the screenshot vs the times read
    for (let k = 0; k + 1 < j.legs.length; k++) {
      const a = j.legs[k], d = j.legs[k + 1];
      if (!a.arrTime || !d.depTime) continue;
      const arrT = times.filter((t) => t.hm === a.arrTime), depT = times.filter((t) => t.hm === d.depTime);
      const pair = arrT.flatMap((x) => depT.filter((y) => y.i > x.i).map((y) => [x, y] as const)).sort((p, q) => p[1].i - p[0].i - (q[1].i - q[0].i))[0];
      if (!pair) continue;
      const shown = [...text.slice(pair[0].i + 5, pair[1].i).matchAll(DUR)].map((m) => (m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] ?? 0)));
      if (!shown.length) continue;
      const computed = scheduledConnectionMinutes(a, d) ?? ((minutesOf(d.depTime) - minutesOf(a.arrTime) + 1440) % 1440);
      const name = `${j.label}, connection at ${a.to}`;
      const fmt = (m: number) => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
      if (shown.includes(computed)) {
        crossChecked.push(name);
        for (const [leg, key] of [[legs[k], 'arrTime'], [legs[k + 1], 'depTime']] as const) {
          const fld = leg.f[key];
          const ev = evidence(text, spans, (key === 'arrTime' ? arrT : depT));
          if (fld.state === 'check' && ev.conf >= 40) leg.f[key] = { ...fld, state: 'read', why: `matches the ${fmt(computed)} connection shown` };
        }
      } else {
        warnings.push(`${name}: the screenshot shows a ${shown.map(fmt).join(' / ')} connection, but the times read give ${fmt(computed)}. Check both times.`);
        for (const [leg, key] of [[legs[k], 'arrTime'], [legs[k + 1], 'depTime']] as const) leg.f[key] = { ...leg.f[key], state: 'check', why: 'does not match the connection time shown' };
      }
    }
    return { label: j.label, legs, selfTransferAt, ticketState };
  });
  // Structural check: every time shown (in the part the itinerary was read from) must have found its place in it. A
  // time left over means the layout was not fully understood — values may be paired with the wrong flight even if each
  // was read clearly — so nothing counts as read: every value is to check.
  const placed = new Set(journeys.flatMap((j) => j.legs.flatMap((l) => [l.f.depTime.value, l.f.arrTime.value])));
  const leftover = [...new Set(times.filter((t) => scope.some(([a, b]) => t.i >= a && t.i < b) && !placed.has(t.hm)).map((t) => t.hm))];
  if (journeys.length && leftover.length) {
    warnings.push(`The screenshot shows time(s) ${leftover.join(', ')} that could not be placed in the itinerary: its layout was not fully understood, so every value is marked to check.`);
    for (const j of journeys) {
      for (const l of j.legs) for (const k of Object.keys(l.f) as LegField[]) if (l.f[k].state === 'read') l.f[k] = { ...l.f[k], state: 'check', why: 'the layout of the screenshot was not fully understood' };
      j.ticketState = j.ticketState.map((s) => (s === 'read' ? 'check' : s));
    }
  }
  if (!journeys.length) warnings.push('No itinerary was recognised in this image: it needs at least the departure and arrival times with their airport codes.');
  return { draft: { journeys, warnings: [...new Set(warnings)], crossChecked }, text, parsed };
}

// ---------- confirmation ----------

/** Fields that decide the analysis: a 'check' on one of them must be confirmed, a missing one filled, before analysing. */
export const CRUCIAL: readonly LegField[] = ['from', 'to', 'depDate', 'depTime', 'arrDate', 'arrTime', 'flightNumber'];

const IATA = /^[A-Z]{3}$/, HM = /^([01]\d|2[0-3]):[0-5]\d$/, ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface Problem { j: number; leg: number; field: LegField; text: string }

/**
 * What still blocks the analysis: unconfirmed 'check' values on crucial fields, invalid values, and missing airports or
 * connection times. Missing dates and flight numbers do not block: the analysis then reports them, as it does for a
 * page reading (no date → not assessed; no flight number → no history).
 */
export function problems(d: Draft): Problem[] {
  const out: Problem[] = [];
  d.journeys.forEach((j, ji) => j.legs.forEach((l, li) => {
    const p = (field: LegField, text: string) => out.push({ j: ji, leg: li, field, text });
    for (const k of CRUCIAL) if (l.f[k].state === 'check') p(k, 'confirm or correct');
    if (!l.f.from.value || !IATA.test(l.f.from.value)) p('from', 'a 3-letter airport code is needed');
    if (!l.f.to.value || !IATA.test(l.f.to.value)) p('to', 'a 3-letter airport code is needed');
    for (const k of ['depTime', 'arrTime'] as const) if (l.f[k].value && !HM.test(l.f[k].value!)) p(k, 'use HH:MM');
    for (const k of ['depDate', 'arrDate'] as const) if (l.f[k].value && !ISO.test(l.f[k].value!)) p(k, 'not a date');
    // times at each change of plane are needed to assess it
    if (li < j.legs.length - 1 && !l.f.arrTime.value) p('arrTime', 'needed for the connection');
    if (li > 0 && !l.f.depTime.value) p('depTime', 'needed for the connection');
  }));
  return out;
}

/** The confirmed draft as an itinerary for the analysis engine (the same model as a page reading or manual entry). */
export function toItinerary(d: Draft): Itinerary {
  const journeys: Journey[] = d.journeys.map((j) => ({
    label: j.label,
    legs: j.legs.map((l): Leg => {
      const v = (k: LegField) => l.f[k].value || null;
      const fn = v('flightNumber')?.toUpperCase().replace(/\s+/g, '') ?? null;
      return { flightNumber: fn ? normFlight(fn) ?? fn : null, altNumbers: l.altNumbers, airline: v('airline'), operatedBy: l.operatedBy, from: (v('from') ?? '').toUpperCase(), to: (v('to') ?? '').toUpperCase(), depDate: v('depDate'), depTime: v('depTime'), arrDate: v('arrDate'), arrTime: v('arrTime') };
    }),
    stopsOnly: [],
    selfTransfer: j.selfTransferAt.some((s) => s === true) ? true : null,
    selfTransferAt: j.selfTransferAt,
  }));
  return { site: 'screenshot', journeys, missing: [], warnings: d.warnings };
}

/**
 * Fills empty dates of a journey from one known date, with the same rules as the page parser (an arrival clock earlier
 * than the departure clock is the next day; so is a departure earlier than the previous arrival). Filled dates that
 * change the day are marked 'check'; same-day ones count as worked out from the traveller's own date.
 */
export function fillDates(j: DraftJourney): DraftJourney {
  const legs = j.legs.map((l) => ({ ...l, f: { ...l.f } }));
  const add = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const set = (l: DraftLeg, k: 'depDate' | 'arrDate', v: string, rolled: boolean) => {
    if (l.f[k].value) return;
    l.f[k] = rolled ? { value: v, state: 'check', why: 'worked out from the times (next day): check it' } : { value: v, state: 'typed', why: 'same day as the date entered' };
  };
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < legs.length; k++) {
    const l = legs[k], dep = l.f.depDate.value, arr = l.f.arrDate.value, dt = l.f.depTime.value, at = l.f.arrTime.value;
    if (dep && !arr) { const roll = !!(dt && at && minutesOf(at) < minutesOf(dt)); set(l, 'arrDate', roll ? add(dep, 1) : dep, roll); }
    const nx = legs[k + 1];
    if (nx && l.f.arrDate.value && !nx.f.depDate.value) { const roll = !!(at && nx.f.depTime.value && minutesOf(nx.f.depTime.value) < minutesOf(at)); set(nx, 'depDate', roll ? add(l.f.arrDate.value, 1) : l.f.arrDate.value, roll); }
    const pv = legs[k - 1];
    if (pv && l.f.depDate.value && !pv.f.arrDate.value) { const roll = !!(pv.f.arrTime.value && dt && minutesOf(dt) < minutesOf(pv.f.arrTime.value)); set(pv, 'arrDate', roll ? add(l.f.depDate.value, -1) : l.f.depDate.value, roll); }
    if (arr && !dep) { const roll = !!(dt && at && minutesOf(at) < minutesOf(dt)); set(l, 'depDate', roll ? add(arr, -1) : arr, roll); }
  }
  return { ...j, legs };
}

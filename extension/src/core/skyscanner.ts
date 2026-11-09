// Skyscanner itinerary extraction from the VISIBLE TEXT of the itinerary the traveller picked (innerText of the card or
// of the expanded details). Deliberately text-based: Skyscanner's class names are generated and change often, and the
// extension never calls Skyscanner's own APIs or reads anything the traveller did not point at.
//
// Layouts handled (fixtures in tests/fixtures/extension/):
//   - results card:  "08:15 TLV … 1 stop CDG … 15:20 AMS"   → legs with the stop airport; flight numbers and the
//     connection times are usually NOT shown there → reported in `missing` (the traveller can open the details or type them);
//   - details view:  dep time + airport, flight number, arr time + airport, "Connect in …", next leg …  → full legs;
//   - "Outbound" / "Return" headings split journeys; "Self transfer" marks a journey as self-transfer;
//   - dates "Wed, 5 Nov 2025", "5 Nov", "Nov 5, 2025", "2025-11-05"; times "08:15", "8:15 AM", "+1" day markers.
import { isKnownAirport } from './airports.ts';
import { connectionTiming } from './time.ts';
import type { Itinerary, Journey, Leg } from './types.ts';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Exact month names and abbreviations only (R-41): "separately", "Marabu" or "Royal Air Maroc" are not dates.
const MON = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?(?![A-Za-z])';
/** Aircraft designators shown next to flight numbers ("Airbus A320neo", "Embraer E190") are not flight numbers (R-27). */
const AIRCRAFT_BEFORE = /(?:airbus|boeing|embraer|bombardier|canadair|atr|aircraft|plane)[\s:]*$/i;
/** Three-letter words that are also airport codes but appear in page text for other reasons. */
const STOP_WORDS = new Set(['THE', 'AND', 'FOR', 'ALL', 'NEW', 'USD', 'EUR', 'GBP', 'ILS', 'CHF', 'TRY', 'GMT', 'UTC', 'CET', 'EET', 'BST', 'AIR', 'BAG', 'MIN', 'NON', 'ONE', 'TWO', 'VIA', 'TAX', 'FEE', 'APP', 'BUS', 'CAR', 'WAY', 'DAY', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'PER', 'TOP', 'BEST', 'OUT']);

type Tok =
  | { t: 'date'; i: number; y: number | null; m: number; d: number }
  | { t: 'time'; i: number; hm: string; plus: number }
  | { t: 'airport'; i: number; code: string }
  | { t: 'flight'; i: number; code: string }
  | { t: 'stops'; i: number; n: number }
  | { t: 'self'; i: number; neg: boolean }
  | { t: 'operated'; i: number; by: string }
  | { t: 'journey'; i: number; label: string };

const RE = new RegExp([
  // headings at the start of a line; "Depart(ure)" counts only when a date follows before the next time (see tokenize)
  `(?<jr>^[ \\t]*(?:Outbound flight|Return flight|Outbound|Return|Inbound|Departure|Depart)\\b)`,
  `(?<dmy>\\b(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+${MON},?(?:[ \\t]+(\\d{4}))?\\b)`,
  `(?<mdy>\\b${MON}[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:]),?(?:[ \\t]+(\\d{4}))?\\b)`,
  `(?<iso>\\b(\\d{4})-(\\d{2})-(\\d{2})\\b)`,
  // AM/PM only on the same line and not the start of a word ("15:20\nAMS" is 15:20 then AMS); "+1" on the same or the next line
  `(?<time>\\b(?:[01]?\\d|2[0-3]):[0-5]\\d(?:[ \\u202f]?[AaPp]\\.?[Mm]\\.?(?![A-Za-z]))?)(?:[ \\t]*(?:\\r?\\n[ \\t]*)?\\+[ \\t]?(?<plus>\\d)(?!\\d))?`,
  // self-transfer wordings (R-10); a negation in front ("not a self transfer") is recorded, not counted
  `(?<self>(?<neg>\\bnot\\s+(?:an?\\s+)?|\\bno\\s+)?(?:self[\\s-]?transfer|separate\\s+tickets|booked\\s+separately|book\\s+each\\s+flight\\s+separately))`,
  `(?<stops>\\b(?<sn>\\d)\\s+stops?\\b|\\bdirect\\b|\\bnon-?stop\\b)`,
  `(?<op>operated by\\s+(?<by>[^\\n,·|]+))`,
  // flight number: designator, 1–4 digits, optional suffix letter, then the end of the word (R-27)
  `(?<fl>\\b(?<fc>[A-Z][A-Z0-9]|[0-9][A-Z])\\s?(?<fn>\\d{1,4})(?<fs>[A-Z])?(?![A-Z\\d:]))`,
  `(?<ap>\\b[A-Z]{3}\\b)`,
].join('|'), 'gim');

function to24(s: string): string {
  const m = /^(\d{1,2}):(\d{2})\s?([AaPp])?/.exec(s.trim())!;
  let h = Number(m[1]);
  if (m[3]) { const pm = m[3].toLowerCase() === 'p'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(RE)) {
    const g = m.groups!, i = m.index!;
    if (g.jr) out.push({ t: 'journey', i, label: g.jr.trim().replace(/\s+flight$/i, '') });
    else if (g.dmy) { const p = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?(?:\s+(\d{4}))?/.exec(g.dmy)!; out.push({ t: 'date', i, d: Number(p[1]), m: MONTHS.indexOf(p[2].slice(0, 3).toLowerCase()) + 1, y: p[3] ? Number(p[3]) : null }); }
    else if (g.mdy) { const p = /([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?/.exec(g.mdy)!; out.push({ t: 'date', i, d: Number(p[2]), m: MONTHS.indexOf(p[1].slice(0, 3).toLowerCase()) + 1, y: p[3] ? Number(p[3]) : null }); }
    else if (g.iso) { const p = g.iso.split('-').map(Number); out.push({ t: 'date', i, y: p[0], m: p[1], d: p[2] }); }
    else if (g.time) out.push({ t: 'time', i, hm: to24(g.time), plus: g.plus ? Number(g.plus) : 0 });
    else if (g.self) out.push({ t: 'self', i, neg: !!g.neg });
    else if (g.stops) out.push({ t: 'stops', i, n: g.sn ? Number(g.sn) : 0 });
    else if (g.op) out.push({ t: 'operated', i, by: g.by.trim() });
    else if (g.fl) {
      // case-insensitive regex: only upper-case codes are flight numbers ("on 12" is not); aircraft types are not
      if (g.fc !== g.fc.toUpperCase() || !/[A-Z]/.test(g.fc) || (g.fs && g.fs !== g.fs.toUpperCase())) continue;
      if (AIRCRAFT_BEFORE.test(text.slice(Math.max(0, i - 16), i))) continue;
      out.push({ t: 'flight', i, code: `${g.fc}${Number(g.fn)}${g.fs ?? ''}` });   // "AF0010" → "AF10", as the data source stores it
    } else if (g.ap) {
      const c = g.ap;
      if (c === c.toUpperCase() && !STOP_WORDS.has(c) && isKnownAirport(c)) out.push({ t: 'airport', i, code: c });
    }
  }
  const dated = out.filter((t) => t.t !== 'date' || (t.m >= 1 && t.d >= 1 && t.d <= 31));
  // "Depart" / "Departure" is a journey heading only when a date follows before the next time (else a per-leg label)
  return dated.filter((t, k) => {
    if (t.t !== 'journey' || !/^depart/i.test(t.label)) return true;
    const next = dated.slice(k + 1).find((x) => x.t === 'date' || x.t === 'time');
    return next?.t === 'date';
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

/** A date without a year is the next occurrence on or after `today` − 2 days (searches are for future travel). */
function isoOf(t: Extract<Tok, { t: 'date' }>, today: string): string {
  if (t.y) return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
  const y0 = Number(today.slice(0, 4));
  for (const y of [y0, y0 + 1]) { const iso = `${y}-${pad(t.m)}-${pad(t.d)}`; if (iso >= addDays(today, -2)) return iso; }
  return `${y0 + 1}-${pad(t.m)}-${pad(t.d)}`;
}

interface Point { time: string; plus: number; airport: string; i: number }

/** Parses the visible text of one Skyscanner itinerary. `today` (YYYY-MM-DD) resolves dates shown without a year. */
export function parseSkyscannerText(text: string, today: string): Itinerary {
  const toks = tokenize(text.replace(/ /g, ' '));
  const missing: string[] = [], warnings: string[] = [];
  // Journeys: split at "Outbound"/"Return" headings when present.
  const heads = toks.filter((t) => t.t === 'journey') as Extract<Tok, { t: 'journey' }>[];
  const groups: { label: string; toks: Tok[] }[] = heads.length
    ? heads.map((h, k) => ({ label: h.label, toks: toks.filter((t) => t.i > h.i && (k + 1 >= heads.length || t.i < heads[k + 1].i)) }))
    : [{ label: 'Journey', toks }];
  if (heads.length && toks.some((t) => t.i < heads[0].i && t.t === 'time')) groups.unshift({ label: 'Journey', toks: toks.filter((t) => t.i < heads[0].i) });

  const journeys: Journey[] = [];
  for (const g of groups) journeys.push(...splitCards(g.label, g.toks).map(({ label, toks: jt }) => buildJourney(label, jt, today, warnings)));
  const real = journeys.filter((j) => j.legs.length);
  real.forEach((j, k) => { if (j.label === 'Journey') j.label = real.length > 1 ? `Journey ${k + 1}` : 'Journey'; });
  for (const j of real) for (const [k, l] of j.legs.entries()) {
    const name = `${j.label}, flight ${k + 1} (${l.from}→${l.to})`;
    if (!l.flightNumber) missing.push(`${name}: flight number`);
    if (!l.depTime && k > 0) missing.push(`${name}: departure time`);
    if (!l.arrTime && k < j.legs.length - 1) missing.push(`${name}: arrival time`);
    if (!l.depDate) missing.push(`${name}: date`);
  }
  if (!real.length) warnings.push('No flight times and airports were recognised in the selected part of the page.');
  return { site: 'skyscanner', journeys: real, missing: [...new Set(missing)], warnings };
}

/** Results cards without headings: "time airport … N stops A, B … time airport" repeated (outbound + return). */
function splitCards(label: string, toks: Tok[]): { label: string; toks: Tok[] }[] {
  const pts = points(toks);
  const stops = toks.filter((t) => t.t === 'stops');
  if (stops.length < 2 || pts.length !== stops.length * 2) return [{ label, toks }];
  return stops.map((_, k) => {
    const lo = k ? pts[2 * k].i : -Infinity, hi = k + 1 < stops.length ? pts[2 * k + 2].i : Infinity;
    return { label: k === 0 ? 'Outbound' : k === 1 && stops.length === 2 ? 'Return' : `Journey ${k + 1}`, toks: toks.filter((t) => t.i >= lo && t.i < hi) };
  });
}

/** A time followed by an airport before the next time (or, failing that, preceded by an unattached airport). */
function points(toks: Tok[]): Point[] {
  const out: Point[] = [];
  const used = new Set<number>();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'time') continue;
    let ap: Extract<Tok, { t: 'airport' }> | null = null;
    for (let j = k + 1; j < toks.length && toks[j].t !== 'time'; j++) {
      const x = toks[j];
      if (x.t === 'stops') break;
      if (x.t === 'airport' && !used.has(x.i)) { ap = x; break; }
    }
    if (!ap) for (let j = k - 1; j >= 0 && toks[j].t !== 'time'; j--) { const x = toks[j]; if (x.t === 'airport' && !used.has(x.i)) { ap = x; break; } }
    if (ap) { used.add(ap.i); out.push({ time: t.hm, plus: t.plus, airport: ap.code, i: t.i }); }
  }
  return out;
}

function buildJourney(label: string, toks: Tok[], today: string, warnings: string[]): Journey {
  const pts = points(toks);
  const selfToks = toks.filter((t) => t.t === 'self') as Extract<Tok, { t: 'self' }>[];
  const selfPos = selfToks.filter((t) => !t.neg);
  const selfTransfer = selfPos.length ? true : null;
  const dates = toks.filter((t) => t.t === 'date') as Extract<Tok, { t: 'date' }>[];
  const dateBefore = (i: number) => { const d = dates.filter((x) => x.i < i).at(-1); return d ? isoOf(d, today) : null; };
  const stopTok = toks.find((t) => t.t === 'stops') as Extract<Tok, { t: 'stops' }> | undefined;
  const flights = toks.filter((t) => t.t === 'flight') as Extract<Tok, { t: 'flight' }>[];
  const operated = toks.filter((t) => t.t === 'operated') as Extract<Tok, { t: 'operated' }>[];
  const legs: Leg[] = [];
  let stopsOnly: string[] = [];
  let selfTransferAt: (boolean | null)[] = [];

  const detailed = pts.length >= 4 || (pts.length === 2 && (!stopTok || stopTok.n === 0));
  if (detailed) {
    if (pts.length % 2) warnings.push(`${label}: an odd number of time/airport pairs was found; the last one is ignored.`);
    let prevEnd = -1;
    const used = new Set<number>();   // each printed flight number belongs to one leg only (R-27)
    const d0 = dateBefore(pts[0].i);  // the journey's date: "+N" day markers count from it
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const dep = pts[k], arr = pts[k + 1];
      const fl = flights.filter((f) => !used.has(f.i) && f.i > prevEnd && f.i < (pts[k + 2]?.i ?? Infinity) && (f.i < arr.i || !pts[k + 2] || f.i < pts[k + 2].i));
      const own = fl.filter((f) => f.i < arr.i);
      const pick = own.length ? own : fl.filter((f) => f.i > arr.i).slice(0, 1);
      for (const f of pick) used.add(f.i);
      const op = operated.find((o) => o.i > prevEnd && o.i < (pts[k + 2]?.i ?? Infinity));
      // departure day (R-06): a "+N" on the departure time counts from the journey's date; else a later date heading;
      // else the previous arrival's day (the next day when the clock is earlier than that arrival)
      const prev = legs.at(-1);
      const hdr = dateBefore(dep.i);
      let depDate: string | null;
      if (k === 0) depDate = dep.plus && d0 ? addDays(d0, dep.plus) : hdr;
      else if (dep.plus && d0) depDate = addDays(d0, dep.plus);
      else if (hdr && prev?.arrDate && hdr > prev.arrDate) depDate = hdr;
      else if (prev?.arrDate) depDate = prev.arrTime && minutes(dep.time) < minutes(prev.arrTime) ? addDays(prev.arrDate, 1) : prev.arrDate;
      else depDate = hdr;
      // arrival day: "+N" from the journey's date when that is not before the departure day, else from the departure day
      let arrDate: string | null = null;
      if (depDate) {
        if (arr.plus) {
          const j = d0 ? addDays(d0, arr.plus) : null, l = addDays(depDate, arr.plus);
          arrDate = j && j >= depDate ? j : l;
          if (j && j !== l && depDate !== d0) warnings.push(`${label}: the "+${arr.plus}" day marker of flight ${k / 2 + 1} can be read from the journey date or from that flight's departure; ${arrDate} is assumed. Check the dates.`);
        } else arrDate = minutes(arr.time) < minutes(dep.time) ? addDays(depDate, 1) : depDate;
      }
      legs.push({
        flightNumber: pick[0]?.code ?? null, altNumbers: [...new Set(pick.slice(1).map((f) => f.code))].filter((c) => c !== pick[0]?.code),
        airline: null, operatedBy: op?.by ?? null,
        from: dep.airport, to: arr.airport, depTime: dep.time, arrTime: arr.time, depDate, arrDate,
      });
      prevEnd = arr.i;
    }
    for (let k = 1; k < legs.length; k++) if (legs[k].from !== legs[k - 1].to) warnings.push(`${label}: flight ${k} arrives at ${legs[k - 1].to} but flight ${k + 1} leaves from ${legs[k].from} (change of airport).`);
    for (let k = 1; k < legs.length; k++) if (legs[k].flightNumber && legs[k].flightNumber === legs[k - 1].flightNumber) warnings.push(`${label}: flights ${k} and ${k + 1} show the same number ${legs[k].flightNumber}; check the flight numbers.`);
    // self-transfer per connection (R-10): a label inside the layover block (between the arrival and the next departure);
    // a label elsewhere (journey banner) settles it only when the journey has a single connection
    const conns = legs.length - 1;
    const inBlock = (c: number) => selfPos.some((t) => t.i > pts[2 * c + 1].i && t.i < pts[2 * c + 2].i);
    const elsewhere = selfPos.some((t) => !Array.from({ length: conns }, (_, c) => c).some((c) => t.i > pts[2 * c + 1].i && t.i < pts[2 * c + 2].i));
    selfTransferAt = Array.from({ length: conns }, (_, c) => (inBlock(c) || (elsewhere && conns === 1) ? true : null));
    if (elsewhere && conns > 1) warnings.push(`${label}: the page says this journey includes a self-transfer but not at which change of plane; both ticket types are shown for the connections without their own label.`);
  } else if (pts.length === 2) {
    // Results card: departure and final arrival only; the stop airports follow the "N stop(s)" marker.
    const [dep, arr] = pts;
    const after = stopTok ? toks.filter((t) => t.t === 'airport' && t.i > stopTok.i && t.i < arr.i) as Extract<Tok, { t: 'airport' }>[] : [];
    stopsOnly = [...new Set(after.map((a) => a.code))].filter((c) => c !== dep.airport && c !== arr.airport).slice(0, stopTok?.n ?? 0);
    if (stopTok && stopsOnly.length < stopTok.n) warnings.push(`${label}: ${stopTok.n} stop(s) shown but only ${stopsOnly.length} stop airport(s) recognised.`);
    const chain = [dep.airport, ...stopsOnly, arr.airport];
    const depDate = dateBefore(dep.i);
    for (let k = 0; k + 1 < chain.length; k++) legs.push({
      flightNumber: null, altNumbers: [], airline: null, operatedBy: null, from: chain[k], to: chain[k + 1],
      depTime: k === 0 ? dep.time : null, arrTime: k === chain.length - 2 ? arr.time : null,
      depDate: k === 0 ? depDate : null, arrDate: k === chain.length - 2 && depDate ? addDays(depDate, arr.plus) : null,
    });
    if (flights.length === legs.length) flights.forEach((f, k) => { legs[k].flightNumber = f.code; });
    const conns = legs.length - 1;
    selfTransferAt = Array.from({ length: conns }, () => (selfTransfer && conns === 1 ? true : null));
    if (selfTransfer && conns > 1) warnings.push(`${label}: the page says this journey includes a self-transfer but not at which change of plane; both ticket types are shown.`);
  }
  return { label, legs, stopsOnly, selfTransfer, selfTransferAt };
}

/** Scheduled minutes between landing on `inbound` and departure of `outbound` at the connecting airport (absolute
 *  instants in its time zone, R-28). null when a time or a date is missing (R-04: never a made-up date); negative values are
 *  returned as they are (the analysis refuses them). */
export function scheduledConnectionMinutes(inbound: Leg, outbound: Leg): number | null {
  return connectionTiming(inbound, outbound, inbound.to).minutes;
}

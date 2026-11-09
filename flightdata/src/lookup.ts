// Read-only historical lookup for the future Chrome extension (and any other client): given two connecting flight
// numbers and a date, what do earlier observations say about the arrival and departure terminal, gate area and gate?
// Separate from the passenger app; served at /fd-api/v1/flight and /fd-api/v1/connection (docs/FLIGHT_DATA_EXTENSION_API.md).
//
// Rules (LOOKUP_RULES):
//   - the history window is the last `lookbackDays` (30, owner decision 2026-11-02; `days=` may ask for 1–120). Raw rows
//     of licence-limited sources are kept only a few days; older flight-days exist only as MONTHLY counters, so the
//     window includes the counters of every calendar month it overlaps (up to ~2 months of counted flight-days);
//   - only flight-days strictly before the requested date are used (plus a same-day observation, reported separately);
//     for a date after tomorrow the window ends at tomorrow (the latest data that can exist, R-25);
//   - one flight-day = one vote, its last reported value; cancelled flight-days are excluded;
//   - no value is predicted from fewer than minSample flight-days with that field, and no percentage is shown then;
//   - a field the source rarely publishes for this airport and direction is 'not-published', not 'insufficient-data';
//   - confidence comes from the Wilson 95 % lower bound of the leading value's share; it is not a calibrated probability.
import { AIRPORTS } from './airports.ts';
import { gateArea, MARKETING_ONLY, ONE_PER_MOVEMENT, wilsonLower } from './analysis.ts';
import type { Db } from './db.ts';
import { normFlightNumber } from './normalize.ts';

export const LOOKUP_RULES = {
  lookbackDays: 30,        // owner decision 2026-11-02: the last 30 days (monthly counters: months overlapping the window)
  maxLookbackDays: 120,
  minSample: 5,            // fewer flight-days with the field → 'insufficient-data', counts only, no shares
  highMinSample: 10,
  highLower: 0.8,          // Wilson lower bound of the leading share
  mediumLower: 0.5,
  alternativeMinShare: 0.1,
  publishedMin: 0.2,       // share of the airport's flight-days (this direction) with the field below which it is 'not-published'
  publishedMinDays: 50,    // ... judged only from at least this many flight-days
};

type Direction = 'arrival' | 'departure';
export type FieldName = 'terminal' | 'gateArea' | 'gate';

export interface FieldAnswer {
  status: 'predicted' | 'insufficient-data' | 'not-published' | 'no-data';
  value: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  confidenceScore: number | null;      // Wilson 95 % lower bound of the leading share
  interval: [number, number] | null;   // Wilson 95 % interval of the leading share
  sample: number;                      // flight-days with this field known
  distribution: { value: string; n: number; share: number | null }[];
  alternatives: string[];              // other values with share ≥ alternativeMinShare
}

export interface FlightAnswer {
  flight: string; airport: string; direction: Direction; date: string;
  status: 'ok' | 'insufficient-data' | 'no-data' | 'airport-not-covered';
  terminal: FieldAnswer; gateArea: FieldAnswer; gate: FieldAnswer;
  sameDay: null | { terminal: string | null; gateArea: string | null; gate: string | null; status: string; observedAt: string; source: string };
  basis: { windowDays: number; flightDays: number; fromCounters: number; cancelled: number; period: { from: string | null; to: string | null }; sources: string[]; lastRefresh: string | null };
  notes: string[];
}

/** Same normalisation as the stored keys ("KL0461" → "KL461", R-26); anything else is only upper-cased. */
const norm = (s: string) => {
  const t = s.toUpperCase().replace(/[\s-]+/g, '').replace(/^([A-Z]{3}|[A-Z0-9]{2})0+(?=\d)/, '$1');   // "LY08001" → "LY8001"
  return normFlightNumber(t)?.number ?? t;
};
const addDaysIso = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (!n) return 0;
  const p = k / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

function answerField(counts: Map<string, number>, published: boolean | null): FieldAnswer {
  const R = LOOKUP_RULES;
  const sample = [...counts.values()].reduce((a, b) => a + b, 0);
  const enough = sample >= R.minSample;
  const distribution = [...counts].map(([value, n]) => ({ value, n, share: enough ? Number((n / sample).toFixed(3)) : null })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  const base: FieldAnswer = { status: 'no-data', value: null, confidence: null, confidenceScore: null, interval: null, sample, distribution, alternatives: [] };
  if (!sample) return { ...base, status: published === false ? 'not-published' : 'no-data' };
  if (!enough) return { ...base, status: published === false ? 'not-published' : 'insufficient-data' };
  const top = distribution[0];
  const lo = wilsonLower(top.n, sample), hi = wilsonUpper(top.n, sample);
  return {
    ...base, status: 'predicted', value: top.value,
    confidence: sample >= R.highMinSample && lo >= R.highLower ? 'high' : lo >= R.mediumLower ? 'medium' : 'low',
    confidenceScore: Number(lo.toFixed(3)), interval: [Number(lo.toFixed(3)), Number(hi.toFixed(3))],
    alternatives: distribution.slice(1).filter((d) => d.n / sample >= R.alternativeMinShare).map((d) => d.value),
  };
}

/** Whether the airport's source publishes terminal / gate for this direction at all (completed raw days + counters). */
async function publishedFields(db: Db, airport: string, direction: Direction, date: string) {
  // judged on the long window, whatever the prediction window: whether a source publishes a field is an airport property
  const R = { ...LOOKUP_RULES, lookbackDays: LOOKUP_RULES.maxLookbackDays };
  const raw = (await db.query<{ n: number; t: number; g: number }>(
    `WITH d AS (SELECT f.id, bool_or(o.terminal IS NOT NULL) t, bool_or(o.gate IS NOT NULL) g FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
                WHERE f.airport=$1 AND f.direction=$2 AND f.local_date < $3::date AND f.local_date >= $3::date - $4::int AND f.duplicate_of IS NULL GROUP BY f.id HAVING NOT ${MARKETING_ONLY})
     SELECT count(*)::int n, count(*) FILTER (WHERE t)::int t, count(*) FILTER (WHERE g)::int g FROM d`, [airport, direction, date, R.lookbackDays]))[0];
  const der = await db.query<{ field: string; known: number; n: number }>(
    `SELECT field, COALESCE(sum(n) FILTER (WHERE value <> ''), 0)::int known, sum(n)::int n FROM fd_derived_counts
     WHERE airport=$1 AND direction=$2 AND field IN ('terminal','gate') GROUP BY field`, [airport, direction]);
  const tot = (f: string, rawKnown: number) => { const d = der.find((x) => x.field === f); return { n: raw.n + (d?.n ?? 0), k: rawKnown + (d?.known ?? 0) }; };
  const judge = (x: { n: number; k: number }) => (x.n < R.publishedMinDays ? null : x.k / x.n >= R.publishedMin);
  return { terminal: judge(tot('terminal', raw.t)), gate: judge(tot('gate', raw.g)) };
}

/**
 * Historical answer for one flight number at one airport and direction. `date` is the local date at that airport.
 * `now` decides whether the counters of the date's own month may be used: only for live queries (date not in the
 * past), where every rolled-up flight-day is necessarily before the date.
 */
export async function lookupFlight(db: Db, q: { airport: string; flight: string; date: string; direction: Direction; now?: Date; lookbackDays?: number }): Promise<FlightAnswer> {
  const R = { ...LOOKUP_RULES, lookbackDays: Math.min(Math.max(Math.round(q.lookbackDays ?? LOOKUP_RULES.lookbackDays), 1), LOOKUP_RULES.maxLookbackDays) };
  const code = norm(q.flight), airport = q.airport.toUpperCase(), now = q.now ?? new Date();
  // R-25: the history window ends at the latest data that can exist (tomorrow at most), not at a far-future requested date
  const anchor = [q.date, addDaysIso(now.toISOString().slice(0, 10), 1)].sort()[0];
  const empty = answerField(new Map(), null);
  const out: FlightAnswer = {
    flight: code, airport, direction: q.direction, date: q.date, status: 'no-data', terminal: empty, gateArea: empty, gate: empty, sameDay: null,
    basis: { windowDays: R.lookbackDays, flightDays: 0, fromCounters: 0, cancelled: 0, period: { from: null, to: null }, sources: [], lastRefresh: null },
    notes: ['Values are the last terminal and gate the source published for each earlier flight-day, not independently confirmed positions.'],
  };
  const covered = (await db.query<{ n: number }>('SELECT count(*)::int n FROM fd_collection_runs WHERE airport=$1', [airport]))[0].n > 0;
  if (!AIRPORTS[airport] || !covered) { out.status = 'airport-not-covered'; out.notes.push(`${airport} is not collected.`); return out; }

  const ids = `SELECT f.id FROM fd_flights f WHERE f.airport=$1 AND f.direction=$2 AND (f.flight_key=$3 OR EXISTS (SELECT 1 FROM fd_flight_codes c WHERE c.flight_id=f.id AND c.code=$3))`;
  const days = await db.query<{ local_date: string; terminal: string | null; gate: string | null; status: string; sources: string[] }>(
    `${ONE_PER_MOVEMENT(`SELECT f.local_date, f.scheduled_utc, f.identity, f.duplicate_of,
       (array_agg(o.terminal ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.terminal IS NOT NULL))[1] AS terminal,
       (array_agg(o.gate ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.gate IS NOT NULL))[1] AS gate,
       (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status, array_agg(DISTINCT o.source_id) AS sources
     FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
     WHERE f.id IN (${ids}) AND f.local_date < $4::date AND f.local_date >= $4::date - $5::int
     GROUP BY f.id`, ', sources')} ORDER BY local_date`, [airport, q.direction, code, anchor, R.lookbackDays]);
  const live = q.date >= addDaysIso(now.toISOString().slice(0, 10), -2);
  const counters = await db.query<{ field: string; value: string; n: number; month: string; source_id: string }>(
    `SELECT field, value, sum(n)::int AS n, min(month)::text AS month, min(source_id) AS source_id FROM fd_derived_counts
     WHERE airport=$1 AND direction=$2 AND field IN ('terminal','gate','flight-days','cancelled')
       AND (flight_key=$3 OR flight_key IN (SELECT flight_key FROM fd_derived_counts WHERE field='code' AND value=$3 AND airport=$1 AND direction=$2))
       AND (month < date_trunc('month', $4::date) OR ($6::boolean AND month = date_trunc('month', $4::date)))
       AND month >= date_trunc('month', $4::date - $5::int)
     GROUP BY field, value`, [airport, q.direction, code, anchor, R.lookbackDays, live]);

  const usable = days.filter((d) => d.status !== 'cancelled');
  const tally = (values: (string | null)[], extra: { value: string; n: number }[] = []) => {
    const m = new Map<string, number>();
    for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    for (const e of extra) if (e.value) m.set(e.value, (m.get(e.value) ?? 0) + e.n);
    return m;
  };
  const cGate = counters.filter((c) => c.field === 'gate');
  const pub = await publishedFields(db, airport, q.direction, anchor);
  out.terminal = answerField(tally(usable.map((d) => d.terminal), counters.filter((c) => c.field === 'terminal')), pub.terminal);
  out.gate = answerField(tally(usable.map((d) => d.gate), cGate), pub.gate);
  out.gateArea = answerField(tally(usable.map((d) => gateArea(d.gate)), cGate.map((c) => ({ value: gateArea(c.value) ?? '', n: c.n }))), pub.gate);

  const counterDays = counters.find((c) => c.field === 'flight-days')?.n ?? 0;
  const counterCancelled = counters.find((c) => c.field === 'cancelled')?.n ?? 0;
  const firstMonth = counters.length ? counters.reduce((m, c) => (c.month < m ? c.month : m), counters[0].month) : null;
  out.basis = {
    windowDays: R.lookbackDays, flightDays: usable.length + counterDays - counterCancelled, fromCounters: counterDays - counterCancelled, cancelled: days.length - usable.length + counterCancelled,
    period: { from: [days[0]?.local_date, firstMonth].filter(Boolean).sort()[0] ?? null, to: days.at(-1)?.local_date ?? (firstMonth ? 'end of the latest counted month' : null) },
    sources: [...new Set([...days.flatMap((d) => d.sources), ...counters.map((c) => c.source_id)])].sort(),
    lastRefresh: null,
  };
  const refresh = (await db.query<{ t: Date | null }>(`SELECT max(finished_at) AS t FROM fd_collection_runs WHERE airport=$1 AND status IN ('success','partial','suspect')`, [airport]))[0]?.t;
  out.basis.lastRefresh = refresh ? new Date(refresh).toISOString() : null;

  const cur = (await db.query<{ terminal: string | null; gate: string | null; status: string; last_seen_at: Date; source_id: string }>(
    `SELECT o.terminal, o.gate, o.status, o.last_seen_at, o.source_id FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
     WHERE f.id IN (${ids}) AND f.local_date = $4::date ORDER BY o.last_seen_at DESC, o.id DESC LIMIT 1`, [airport, q.direction, code, q.date]))[0];
  if (cur) out.sameDay = { terminal: cur.terminal, gateArea: gateArea(cur.gate), gate: cur.gate, status: cur.status, observedAt: new Date(cur.last_seen_at).toISOString(), source: cur.source_id };

  const any = [out.terminal, out.gateArea, out.gate];
  out.status = any.some((f) => f.status === 'predicted') ? 'ok' : out.basis.flightDays || out.sameDay ? 'insufficient-data' : 'no-data';
  if (out.status === 'no-data') out.notes.push(`No earlier ${q.direction} of ${code} at ${airport} has been observed in the last ${R.lookbackDays} days.`);
  for (const [name, f] of [['terminal', out.terminal], ['gate', out.gate]] as const)
    if (f.status === 'not-published') out.notes.push(`The source rarely publishes ${name}s for ${airport} ${q.direction}s, so none is predicted.`);
  if (any.some((f) => f.status === 'insufficient-data')) out.notes.push(`Fewer than ${R.minSample} earlier flight-days with a value: counts are given, but no prediction and no percentages.`);
  if (out.basis.fromCounters) out.notes.push(`${out.basis.fromCounters} flight-days come from monthly counters (the source's licence limits raw retention; their dates are not kept).`);
  if (anchor < q.date) out.notes.push(`The requested date is after the latest collected data: the ${R.lookbackDays}-day history window ends on ${addDaysIso(anchor, -1)}.`);
  if (out.sameDay) out.notes.push('sameDay is what the source published for the requested date itself; it may still change.');
  return out;
}

/** Airports where the flight was seen in this direction (raw rows or counters), most flight-days first. */
async function airportsFor(db: Db, flight: string, direction: Direction): Promise<string[]> {
  const rows = await db.query<{ airport: string; n: number }>(
    `SELECT airport, sum(n)::int n FROM (
       SELECT f.airport, count(*) n FROM fd_flights f WHERE f.direction=$1 AND (f.flight_key=$2 OR EXISTS (SELECT 1 FROM fd_flight_codes c WHERE c.flight_id=f.id AND c.code=$2)) GROUP BY 1
       UNION ALL
       SELECT airport, sum(n) FROM fd_derived_counts WHERE direction=$1 AND field='flight-days' AND (flight_key=$2 OR flight_key IN (SELECT flight_key FROM fd_derived_counts WHERE field='code' AND value=$2 AND direction=$1)) GROUP BY 1
     ) x GROUP BY airport ORDER BY 2 DESC`, [direction, flight]);
  return rows.map((r) => r.airport);
}

export interface ConnectionAnswer {
  query: { arrivalFlight: string; departureFlight: string; date: string; departureDate: string; airport: string | null };
  status: 'ok' | 'insufficient-data' | 'no-data' | 'ambiguous-airport' | 'airport-not-covered';
  airport: string | null;
  airportCandidates: string[];
  arrival: FlightAnswer | null;
  departure: FlightAnswer | null;
  sameTerminalHistorically: boolean | null;   // both predicted terminals equal (no joint probability is claimed)
  notes: string[];
}

/**
 * Two connecting flights at one airport: the arriving flight on `date` and the departing flight on `departureDate`
 * (default: the same date; give the next day for overnight connections). Without `airport`, the connecting airport is
 * the single collected airport where the first flight has been seen arriving and the second departing.
 */
export async function lookupConnection(db: Db, q: { arrivalFlight: string; departureFlight: string; date: string; departureDate?: string; airport?: string; now?: Date; lookbackDays?: number }): Promise<ConnectionAnswer> {
  const arr = norm(q.arrivalFlight), dep = norm(q.departureFlight), depDate = q.departureDate ?? q.date;
  const out: ConnectionAnswer = { query: { arrivalFlight: arr, departureFlight: dep, date: q.date, departureDate: depDate, airport: q.airport?.toUpperCase() ?? null }, status: 'no-data', airport: null, airportCandidates: [], arrival: null, departure: null, sameTerminalHistorically: null, notes: [] };
  let airport = q.airport?.toUpperCase() ?? null;
  if (!airport) {
    const a = await airportsFor(db, arr, 'arrival'), d = new Set(await airportsFor(db, dep, 'departure'));
    out.airportCandidates = a.filter((x) => d.has(x));
    if (out.airportCandidates.length !== 1) {
      out.status = out.airportCandidates.length ? 'ambiguous-airport' : 'no-data';
      out.notes.push(out.airportCandidates.length ? 'Both flights connect at more than one collected airport: pass airport=.' : `No collected airport where ${arr} has been seen arriving and ${dep} departing.`);
      return out;
    }
    airport = out.airportCandidates[0];
  }
  out.airport = airport;
  out.arrival = await lookupFlight(db, { airport, flight: arr, date: q.date, direction: 'arrival', now: q.now, lookbackDays: q.lookbackDays });
  out.departure = await lookupFlight(db, { airport, flight: dep, date: depDate, direction: 'departure', now: q.now, lookbackDays: q.lookbackDays });
  const st = [out.arrival.status, out.departure.status];
  out.status = st.includes('airport-not-covered') ? 'airport-not-covered' : st.every((s) => s === 'ok') ? 'ok' : st.every((s) => s === 'no-data') ? 'no-data' : 'insufficient-data';
  const ta = out.arrival.terminal, td = out.departure.terminal;
  out.sameTerminalHistorically = ta.status === 'predicted' && td.status === 'predicted' ? ta.value === td.value : null;
  out.notes.push('Arrival and departure are looked up independently; no joint probability is claimed.');
  return out;
}

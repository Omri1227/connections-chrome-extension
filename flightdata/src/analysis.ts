// Derived statistics and the prediction boundary. Everything here is computed from stored observations on request;
// nothing is written back, so historical observations and derived predictions stay separate.
//
// Unit of counting: one flight-day (a physical movement on a local date). Its assignment is the LAST REPORTED value
// (the most recent non-empty terminal / gate any observation gave). That is what the source published last, not an
// independently confirmed actual position, and the API says so.
import type { Db } from './db.ts';

export interface Filters { airport: string; direction: 'arrival' | 'departure'; from?: string; to?: string; carrier?: string; flight?: string; other?: string }

/**
 * Gate area = the letter group a published gate starts with ("K45" → K, "A1A" → A, "C44,C43" → C, FRA "J" → J): the
 * pier, concourse or hall at all 8 airports (CDG 2E K/L/M, FRA A–E/H/J/Z, AMS B–H/M, ZRH A/B/D/E, IST A–F, MAD A–U).
 * Derived from the gate text only; purely numeric gates have no area. No physical claim beyond the letter is made.
 */
export const gateArea = (gate: string | null | undefined): string | null => (gate ? /^([A-Z]+)/.exec(gate)?.[1] ?? null : null);
export const GATE_AREA_SQL = (x: string) => `substring(${x} from '^([A-Z]+)')`;
export type Field = 'terminal' | 'gate' | 'gateArea';

/** SQL for one row per flight-day with its last reported terminal/gate and change counts, filtered. */
function flightDays(f: Filters, params: unknown[]): string {
  const w: string[] = ['f.airport = $1', 'f.direction = $2'];
  params.push(f.airport, f.direction);
  if (f.from) { params.push(f.from); w.push(`f.local_date >= $${params.length}`); }
  if (f.to) { params.push(f.to); w.push(`f.local_date <= $${params.length}`); }
  if (f.carrier) { params.push(f.carrier.toUpperCase()); w.push(`f.carrier = $${params.length}`); }
  if (f.flight) { params.push(f.flight.toUpperCase().replace(/\s+/g, '')); w.push(`(f.flight_key = $${params.length} OR EXISTS (SELECT 1 FROM fd_flight_codes c WHERE c.flight_id=f.id AND c.code=$${params.length}))`); }
  if (f.other) { params.push(f.other.toUpperCase()); w.push(`(CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END) = $${params.length}`); }
  return `
    SELECT f.id, f.flight_key, f.carrier, f.local_date, f.scheduled_utc, f.identity,
           CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END AS other,
           (array_agg(o.terminal ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.terminal IS NOT NULL))[1] AS terminal,
           (array_agg(o.gate ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.gate IS NOT NULL))[1] AS gate,
           (array_agg(o.stage ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS stage,
           (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status,
           count(DISTINCT o.terminal) AS terminals_seen, count(DISTINCT o.gate) AS gates_seen, count(o.id) AS observations,
           (SELECT count(*) FROM fd_sightings s WHERE s.flight_id = f.id)::int AS sightings,
           ${MARKETING_ONLY} AS marketing_only,
           f.duplicate_of, f.duplicate_reason, (SELECT d.flight_key FROM fd_flights d WHERE d.id = f.duplicate_of) AS duplicate_of_key,
           (array_agg(o.gate ORDER BY o.first_seen_at, o.id) FILTER (WHERE o.gate IS NOT NULL))[1] AS first_gate,
           CASE WHEN COALESCE(bool_or(o.stage = 'post-movement'), false) THEN 'final' ELSE 'latest' END AS gate_state,
           max(o.last_seen_at) AS last_seen_at
    FROM fd_flights f JOIN fd_observations o ON o.flight_id = f.id
    WHERE ${w.join(' AND ')}
    GROUP BY f.id`;
}

/**
 * A flight-day every observation of which the source flagged as a codeshare listing (role 'marketing') whose operator
 * row could not be linked. It is not a physical movement of its own (its operator is another row), so statistics
 * leave it out; it stays visible in the flight list and is still found by its own number.
 */
export const MARKETING_ONLY = `COALESCE(bool_and(o.role = 'marketing'), false)`;

/**
 * Condition on flightDays() rows for a physical movement of its own: not a codeshare listing, and not marked as the
 * same movement as another flight-day (store.ts markDuplicates; verified codeshare or same aircraft registration).
 * Physical counts and pooled statistics use only these rows; per-number lookups still see the others.
 */
export const PHYSICAL = 'NOT marketing_only AND duplicate_of IS NULL';

/**
 * Wraps a per-flight-day query (columns local_date, scheduled_utc, identity, …) so that a flight number found both on
 * its own listed flight-day and as a code of an operating flight at the same instant counts once, as the operating
 * one. Lookups by number match fd_flights.flight_key OR fd_flight_codes, so without this a codeshare that one
 * snapshot failed to link was counted twice for that date.
 */
export const ONE_PER_MOVEMENT = (sql: string, extraColumns = '') =>
  `SELECT local_date::text AS local_date, terminal, gate, status${extraColumns} FROM (SELECT DISTINCT ON (x.local_date, x.scheduled_utc) x.* FROM (${sql}) x
     ORDER BY x.local_date, x.scheduled_utc, (x.identity = 'operating') DESC, (x.duplicate_of IS NULL) DESC) y`;

/** One page of flight-days (latest first) and the total that match, so a capped page is never mistaken for the day. */
export async function listFlights(db: Db, f: Filters, limit = 200, offset = 0) {
  const p: unknown[] = [];
  const sql = `${flightDays(f, p)} ORDER BY f.scheduled_utc DESC LIMIT ${Math.min(limit, 1000) | 0} OFFSET ${Math.max(offset, 0) | 0}`;
  return db.query(sql, p);
}
export async function countFlights(db: Db, f: Filters): Promise<{ total: number; codeshareListings: number; duplicates: number }> {
  const p: unknown[] = [];
  const r = (await db.query<{ total: number; listings: number; duplicates: number }>(`WITH d AS (${flightDays(f, p)}) SELECT count(*)::int AS total, count(*) FILTER (WHERE marketing_only)::int AS listings,
    count(*) FILTER (WHERE duplicate_of IS NOT NULL AND NOT marketing_only)::int AS duplicates FROM d`, p))[0];
  return { total: r?.total ?? 0, codeshareListings: r?.listings ?? 0, duplicates: r?.duplicates ?? 0 };
}

export async function flightHistory(db: Db, id: number) {
  const flight = (await db.query('SELECT * FROM fd_flights WHERE id=$1', [id]))[0] ?? null;
  if (!flight) return null;
  const observations = await db.query('SELECT h.*, o.estimated_utc, o.actual_utc, o.status_raw, o.listed_as, o.role, o.seen_count, o.aircraft_type FROM fd_assignment_history h JOIN fd_observations o ON o.id=h.id WHERE h.flight_id=$1 ORDER BY h.first_seen_at, h.id', [id]);
  const codes = await db.query('SELECT code, role, source_id FROM fd_flight_codes WHERE flight_id=$1 ORDER BY role, code', [id]);
  const sightings = await db.query('SELECT s.run_id, r.slot, r.started_at, s.observation_id FROM fd_sightings s JOIN fd_collection_runs r ON r.id=s.run_id WHERE s.flight_id=$1 ORDER BY r.started_at', [id]);
  return { flight, observations, codes, sightings };
}

/** Monthly counters (fd_derived_counts) matching the same filters; months overlapping [from, to] are included. */
function derivedRows(f: Filters, field: Field, params: unknown[]): string {
  const w: string[] = ['d.airport = $1', 'd.direction = $2', `d.field = '${field === 'gateArea' ? 'gate' : field}'`];
  params.push(f.airport, f.direction);
  if (f.from) { params.push(f.from); w.push(`d.month >= date_trunc('month', $${params.length}::date)`); }
  if (f.to) { params.push(f.to); w.push(`d.month <= $${params.length}::date`); }
  if (f.carrier) { params.push(f.carrier.toUpperCase()); w.push(`d.carrier = $${params.length}`); }
  if (f.flight) { params.push(f.flight.toUpperCase().replace(/\s+/g, '')); w.push(`(d.flight_key = $${params.length} OR d.flight_key IN (SELECT c.flight_key FROM fd_derived_counts c WHERE c.field='code' AND c.value=$${params.length} AND c.airport=d.airport AND c.direction=d.direction))`); }
  if (f.other) { params.push(f.other.toUpperCase()); w.push(`d.other = $${params.length}`); }
  const value = field === 'gateArea' ? GATE_AREA_SQL(`NULLIF(d.value, '')`) : `NULLIF(d.value, '')`;
  return `SELECT d.carrier, NULLIF(d.other, '') AS other, d.flight_key, ${value} AS value, d.n FROM fd_derived_counts d WHERE ${w.join(' AND ')}`;
}

/**
 * Terminal (or gate) distribution grouped by airline, route or flight number, cancelled flights excluded. Combines
 * raw flight-days with the monthly counters of licence-limited sources (their raw rows are deleted after 7 days, so
 * nothing is counted twice); `derived` says how many flight-days of a group came from counters.
 */
export async function distribution(db: Db, f: Filters, field: Field, groupBy: 'carrier' | 'other' | 'flight_key' | 'none') {
  const p: unknown[] = [];
  const g = groupBy === 'none' ? `'all'` : groupBy;
  const col = field === 'gateArea' ? GATE_AREA_SQL('gate') : field;
  const raw = await db.query<{ grp: string; value: string | null; n: string }>(
    `WITH d AS (${flightDays(f, p)}) SELECT ${g} AS grp, ${col} AS value, count(*) AS n FROM d WHERE status <> 'cancelled' AND ${PHYSICAL} GROUP BY 1, 2`, p);
  const p2: unknown[] = [];
  const der = await db.query<{ grp: string; value: string | null; n: string }>(
    `WITH d AS (${derivedRows(f, field, p2)}) SELECT ${g} AS grp, value, sum(n) AS n FROM d GROUP BY 1, 2`, p2);
  const groups = new Map<string, { group: string; total: number; known: number; derived: number; values: { value: string; n: number; share: number }[]; missing: number }>();
  for (const [rows, isDerived] of [[raw, false], [der, true]] as const) for (const r of rows) {
    const k = r.grp ?? '(unknown)';
    const e = groups.get(k) ?? { group: k, total: 0, known: 0, derived: 0, values: [], missing: 0 };
    const n = Number(r.n);
    e.total += n;
    if (isDerived) e.derived += n;
    if (r.value === null) e.missing += n;
    else { e.known += n; const v = e.values.find((x) => x.value === r.value); if (v) v.n += n; else e.values.push({ value: r.value, n, share: 0 }); }
    groups.set(k, e);
  }
  for (const e of groups.values()) { e.values.sort((a, b) => b.n - a.n); for (const v of e.values) v.share = e.known ? v.n / e.known : 0; }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

/**
 * One line per airport and direction over everything collected (raw flight-days + monthly counters): flight-days,
 * share with a terminal / gate, the leading terminals, and the date range. Cancelled flights excluded.
 */
export async function summary(db: Db) {
  const raw = await db.query<{ airport: string; direction: string; terminal: string | null; gate: string | null; n: string; first: string; last: string }>(
    `WITH d AS (
       SELECT f.airport, f.direction, f.local_date,
         (array_agg(o.terminal ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.terminal IS NOT NULL))[1] AS terminal,
         (array_agg(o.gate ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.gate IS NOT NULL))[1] AS gate,
         (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status
       FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id WHERE f.duplicate_of IS NULL GROUP BY f.id HAVING NOT ${MARKETING_ONLY})
     SELECT airport, direction, terminal, (gate IS NOT NULL)::text AS gate, count(*) AS n, min(local_date)::text AS first, max(local_date)::text AS last
     FROM d WHERE status <> 'cancelled' GROUP BY 1, 2, 3, 4`);
  const der = await db.query<{ airport: string; direction: string; field: string; value: string; n: string; first: string; last: string }>(
    `SELECT airport, direction, field, CASE WHEN field='gate' THEN (value <> '')::text ELSE value END AS value, sum(n) AS n,
            min(month)::text AS first, (max(month) + interval '1 month' - interval '1 day')::date::text AS last
     FROM fd_derived_counts WHERE field IN ('terminal','gate') GROUP BY 1, 2, 3, 4`);
  type Line = { airport: string; direction: string; flightDays: number; derived: number; withTerminal: number; withGate: number; terminals: Map<string, number>; first: string | null; last: string | null };
  const lines = new Map<string, Line>();
  const line = (a: string, d: string) => { const k = `${a}|${d}`; if (!lines.has(k)) lines.set(k, { airport: a, direction: d, flightDays: 0, derived: 0, withTerminal: 0, withGate: 0, terminals: new Map(), first: null, last: null }); return lines.get(k)!; };
  const span = (l: Line, first: string, last: string) => { if (!l.first || first < l.first) l.first = first; if (!l.last || last > l.last) l.last = last; };
  for (const r of raw) {
    const l = line(r.airport, r.direction), n = Number(r.n);
    l.flightDays += n;
    if (r.terminal) { l.withTerminal += n; l.terminals.set(r.terminal, (l.terminals.get(r.terminal) ?? 0) + n); }
    if (r.gate === 'true') l.withGate += n;
    span(l, r.first, r.last);
  }
  for (const r of der) {
    const l = line(r.airport, r.direction), n = Number(r.n);
    if (r.field === 'terminal') {
      l.flightDays += n; l.derived += n;
      if (r.value) { l.withTerminal += n; l.terminals.set(r.value, (l.terminals.get(r.value) ?? 0) + n); }
    } else if (r.value === 'true') l.withGate += n;
    span(l, r.first, r.last);
  }
  return [...lines.values()].sort((a, b) => a.airport.localeCompare(b.airport) || a.direction.localeCompare(b.direction)).map((l) => ({
    ...l, terminals: [...l.terminals].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n, share: l.withTerminal ? n / l.withTerminal : 0 })),
  }));
}

/** Per local date: flight-days, and shares with terminal, gate, both, neither; plus change frequencies. */
export async function completeness(db: Db, f: Filters) {
  const p: unknown[] = [];
  const rows = await db.query(
    `WITH d AS (${flightDays(f, p)})
     SELECT local_date::text AS date, count(*) FILTER (WHERE ${PHYSICAL})::int AS flights,
       count(*) FILTER (WHERE status='cancelled' AND ${PHYSICAL})::int AS cancelled,
       count(*) FILTER (WHERE terminal IS NOT NULL AND ${PHYSICAL})::int AS with_terminal,
       count(*) FILTER (WHERE gate IS NOT NULL AND ${PHYSICAL})::int AS with_gate,
       count(*) FILTER (WHERE terminal IS NOT NULL AND gate IS NOT NULL AND ${PHYSICAL})::int AS with_both,
       count(*) FILTER (WHERE terminal IS NULL AND gate IS NULL AND ${PHYSICAL})::int AS with_neither,
       count(*) FILTER (WHERE terminals_seen > 1 AND ${PHYSICAL})::int AS terminal_changed,
       count(*) FILTER (WHERE gates_seen > 1 AND ${PHYSICAL})::int AS gate_changed,
       count(*) FILTER (WHERE identity='listed' AND ${PHYSICAL})::int AS listed_identity,
       count(*) FILTER (WHERE marketing_only)::int AS codeshare_listings,
       count(*) FILTER (WHERE duplicate_of IS NOT NULL AND NOT marketing_only)::int AS duplicates
     FROM d GROUP BY local_date ORDER BY local_date`, p);
  return rows;
}

export type LeadBucket = '<3h' | '3-12h' | '12-24h' | '>24h';
export const leadBucket = (hours: number): LeadBucket => (hours < 3 ? '<3h' : hours < 12 ? '3-12h' : hours < 24 ? '12-24h' : '>24h');

export interface GateTimeline {
  id: number; flight: string; date: string; scheduledUtc: string;
  initial: { gate: string; seenAt: string; leadHours: number } | null;   // first published gate, hours before schedule
  updates: { gate: string | null; seenAt: string }[];                     // every later change (null = gate withdrawn)
  latest: string | null;                                                  // last non-empty gate published
  state: 'final' | 'latest';  // final: the source was seen again after the movement, so the gate can no longer change
  firstSeenAfterMovement: boolean;                                        // no pre-movement snapshot at all
}

/**
 * How published gates evolve across snapshots, per physical, non-cancelled flight-day: the initial assignment (first
 * observation with a gate and how long before the scheduled time it was seen), later updates (each change, including a
 * gate being withdrawn), and the final known assignment. A gate is 'final' only when an observation after the movement
 * exists; otherwise it is the latest pre-movement value and may still change. Observations are append-only states, so
 * a change is a new observation and the old gate is kept (AMS 2026-10-30: KL807 departed from F3, seen once after
 * departure; 2026-11-01 07:00, 13 h ahead: E17).
 * The summary judges "initial gate kept" only on final flight-days first seen before the movement.
 */
export async function gateHistory(db: Db, f: Filters, opts: { examples?: number } = {}) {
  const p: unknown[] = [];
  const obs = await db.query<{ id: string; flight_key: string; local_date: string; scheduled_utc: Date; first_seen_at: Date; gate: string | null; stage: string }>(
    `WITH d AS (${flightDays(f, p)})
     SELECT d.id, d.flight_key, d.local_date::text AS local_date, d.scheduled_utc, o.first_seen_at, o.gate, o.stage
     FROM d JOIN fd_observations o ON o.flight_id = d.id WHERE ${PHYSICAL} AND d.status <> 'cancelled'
     ORDER BY d.id, o.first_seen_at, o.id`, p);
  const byFlight = new Map<string, typeof obs>();
  for (const o of obs) byFlight.set(o.id, [...(byFlight.get(o.id) ?? []), o]);
  const timelines: GateTimeline[] = [];
  for (const xs of byFlight.values()) {
    const sched = new Date(xs[0].scheduled_utc);
    const firstGate = xs.find((x) => x.gate !== null);
    const updates: GateTimeline['updates'] = [];
    let cur: string | null | undefined = firstGate?.gate;
    for (const x of firstGate ? xs.slice(xs.indexOf(firstGate) + 1) : []) {
      if (x.gate === cur) continue;
      // A gate withdrawn after the movement is the source tidying up, not a reassignment.
      if (x.gate === null && x.stage === 'post-movement') continue;
      updates.push({ gate: x.gate, seenAt: new Date(x.first_seen_at).toISOString() });
      cur = x.gate;
    }
    timelines.push({
      id: Number(xs[0].id), flight: xs[0].flight_key, date: xs[0].local_date, scheduledUtc: sched.toISOString(),
      initial: firstGate ? { gate: firstGate.gate!, seenAt: new Date(firstGate.first_seen_at).toISOString(), leadHours: Number(((sched.getTime() - new Date(firstGate.first_seen_at).getTime()) / 36e5).toFixed(1)) } : null,
      updates, latest: [...xs].reverse().find((x) => x.gate !== null)?.gate ?? null,
      state: xs.some((x) => x.stage === 'post-movement') ? 'final' : 'latest',
      firstSeenAfterMovement: xs[0].stage === 'post-movement',
    });
  }
  const withGate = timelines.filter((t) => t.initial);
  const judged = withGate.filter((t) => t.state === 'final' && !t.firstSeenAfterMovement);
  const kept = (xs: GateTimeline[]) => xs.filter((t) => t.initial!.gate === t.latest).length;
  const buckets: LeadBucket[] = ['<3h', '3-12h', '12-24h', '>24h'];
  return {
    summary: {
      flightDays: timelines.length, withGate: withGate.length,
      final: withGate.filter((t) => t.state === 'final').length,
      firstSeenAfterMovement: withGate.filter((t) => t.firstSeenAfterMovement).length,
      judged: judged.length, keptInitial: kept(judged),
      changed: withGate.filter((t) => t.updates.length > 0).length,
      changedTwiceOrMore: withGate.filter((t) => t.updates.length > 1).length,
      withdrawn: withGate.filter((t) => t.updates.some((u) => u.gate === null)).length,
      // Of final flight-days: how often the first published gate was still the gate at departure, by how early it
      // was first seen. This is what a gate shown N hours ahead is worth.
      byLead: buckets.map((b) => { const xs = judged.filter((t) => leadBucket(t.initial!.leadHours) === b); return { lead: b, n: xs.length, kept: kept(xs), share: xs.length ? Number((kept(xs) / xs.length).toFixed(3)) : null }; }),
    },
    changed: withGate.filter((t) => t.updates.length > 0).slice(0, opts.examples ?? 50),
  };
}

/** Wilson score lower bound (95 %) of a proportion. */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (!n) return 0;
  const p = k / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

export const PREDICTION_RULES = {
  lookbackDays: 120,
  minSample: 5,        // fewer flight-days with a terminal → no prediction is offered
  highMinSample: 10,
  highLower: 0.8,      // Wilson lower bound of the top share
  mediumLower: 0.5,
};

export interface Prediction {
  query: { airport: string; flight: string; date: string; direction: string };
  basis: 'current-flight-status' | 'historical-pattern' | 'none';
  current: null | { terminal: string | null; gate: string | null; status: string; observedAt: string; stage: string; source: string };
  historical: {
    sample: number;            // flight-days with a reported terminal
    totalFlightDays: number;
    range: { from: string | null; to: string | null };
    terminals: { value: string; n: number; share: number }[];
    gates: { value: string; n: number; share: number }[];
    mostLikelyTerminal: string | null;
    confidence: 'high' | 'medium' | 'low' | 'insufficient-sample';
    confidenceScore: number;   // Wilson lower bound of the top terminal's share; uncalibrated
  };
  lastRefresh: string | null;
  notes: string[];
}

/**
 * The integration boundary for CDG Navigator: what history (and, for the same date, current status) says about a
 * flight's terminal and gate. Historical patterns use flight-days strictly before the requested date. No prediction
 * is made from fewer than PREDICTION_RULES.minSample flight-days.
 */
export async function predict(db: Db, q: { airport: string; flight: string; date: string; direction: 'arrival' | 'departure'; now?: Date }): Promise<Prediction> {
  const code = q.flight.toUpperCase().replace(/\s+/g, '');
  const ids = `SELECT f.id FROM fd_flights f WHERE f.airport=$1 AND f.direction=$2 AND (f.flight_key=$3 OR EXISTS (SELECT 1 FROM fd_flight_codes c WHERE c.flight_id=f.id AND c.code=$3))`;
  const hist = await db.query<{ local_date: string; terminal: string | null; gate: string | null; status: string }>(
    `${ONE_PER_MOVEMENT(`SELECT f.local_date, f.scheduled_utc, f.identity, f.duplicate_of,
       (array_agg(o.terminal ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.terminal IS NOT NULL))[1] AS terminal,
       (array_agg(o.gate ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.gate IS NOT NULL))[1] AS gate,
       (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status
     FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
     WHERE f.id IN (${ids}) AND f.local_date < $4::date AND f.local_date >= $4::date - $5::int
     GROUP BY f.id`)} ORDER BY local_date`,
    [q.airport, q.direction, code, q.date, PREDICTION_RULES.lookbackDays]);
  const usable = hist.filter((h) => h.status !== 'cancelled');
  // Monthly counters of time-limited sources (raw rows already purged, so nothing is counted twice). For a past date
  // only months strictly before its month are used, so a backtest never sees later days of the same month; for a live
  // query (date not before the day before yesterday) the current month is used too: everything rolled up is days old.
  const live = q.date >= new Date((q.now ?? new Date()).getTime() - 2 * 864e5).toISOString().slice(0, 10);
  const derived = await db.query<{ field: string; value: string; n: number; month: string }>(
    `SELECT field, value, sum(n)::int AS n, min(month)::text AS month FROM fd_derived_counts
     WHERE airport=$1 AND direction=$2 AND field IN ('terminal','gate','flight-days','cancelled')
       AND (flight_key=$3 OR flight_key IN (SELECT flight_key FROM fd_derived_counts WHERE field='code' AND value=$3 AND airport=$1 AND direction=$2))
       AND (month < date_trunc('month', $4::date) OR ($6::boolean AND month = date_trunc('month', $4::date))) AND month >= date_trunc('month', $4::date - $5::int)
     GROUP BY field, value`, [q.airport, q.direction, code, q.date, PREDICTION_RULES.lookbackDays, live]);
  const count = (xs: (string | null)[], extra: { value: string; n: number }[] = []) => {
    const m = new Map<string, number>();
    for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1);
    for (const e of extra) if (e.value) m.set(e.value, (m.get(e.value) ?? 0) + e.n);
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    return [...m].map(([value, n]) => ({ value, n, share: tot ? n / tot : 0 })).sort((a, b) => b.n - a.n);
  };
  const terminals = count(usable.map((h) => h.terminal), derived.filter((d) => d.field === 'terminal'));
  const gates = count(usable.map((h) => h.gate), derived.filter((d) => d.field === 'gate'));
  const derivedDays = derived.find((d) => d.field === 'flight-days')?.n ?? 0;
  const derivedFrom = derived.length ? derived.reduce((m, d) => (d.month < m ? d.month : m), derived[0].month) : null;
  const sample = terminals.reduce((s, t) => s + t.n, 0);
  const top = terminals[0];
  const score = top ? wilsonLower(top.n, sample) : 0;
  const R = PREDICTION_RULES;
  const confidence = sample < R.minSample ? 'insufficient-sample' : sample >= R.highMinSample && score >= R.highLower ? 'high' : score >= R.mediumLower ? 'medium' : 'low';

  const cur = (await db.query<{ terminal: string | null; gate: string | null; status: string; last_seen_at: Date; stage: string; source_id: string }>(
    `SELECT o.terminal, o.gate, o.status, o.last_seen_at, o.stage, o.source_id FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
     WHERE f.id IN (${ids}) AND f.local_date = $4::date ORDER BY o.last_seen_at DESC, o.id DESC LIMIT 1`, [q.airport, q.direction, code, q.date]))[0];
  const refresh = (await db.query<{ t: Date | null }>(`SELECT max(finished_at) AS t FROM fd_collection_runs WHERE airport=$1 AND status IN ('success','partial','suspect')`, [q.airport]))[0]?.t ?? null;

  const notes = ['Assignments are the last values the source published, not independently confirmed positions.'];
  if (derivedDays) notes.push(`${derivedDays} flight-days come from monthly counters of a source whose licence limits raw retention (dates not kept).`);
  if (confidence === 'insufficient-sample') notes.push(`Fewer than ${R.minSample} earlier flight-days with a terminal: no historical prediction is offered.`);
  if (gates.length && gates[0].share < 0.5) notes.push('Gates vary between days; treat any gate as indicative only.');
  return {
    query: { airport: q.airport, flight: code, date: q.date, direction: q.direction },
    basis: cur ? 'current-flight-status' : confidence !== 'insufficient-sample' ? 'historical-pattern' : 'none',
    current: cur ? { terminal: cur.terminal, gate: cur.gate, status: cur.status, observedAt: new Date(cur.last_seen_at).toISOString(), stage: cur.stage, source: cur.source_id } : null,
    historical: {
      sample, totalFlightDays: hist.length + derivedDays,
      range: { from: [hist[0]?.local_date, derivedFrom].filter(Boolean).sort()[0] ?? null, to: hist.at(-1)?.local_date ?? (derivedFrom ? 'end of the month before the date' : null) },
      terminals, gates: gates.slice(0, 10),
      mostLikelyTerminal: confidence === 'insufficient-sample' ? null : top?.value ?? null,
      confidence, confidenceScore: Number(score.toFixed(3)),
    },
    lastRefresh: refresh ? new Date(refresh).toISOString() : null,
    notes,
  };
}

/** Collection health per airport: last successful run, recent run statuses, open problems. */
export async function health(db: Db) {
  return db.query(
    `SELECT a.iata, a.name, a.tz, a.enabled,
       (SELECT max(finished_at) FROM fd_collection_runs r WHERE r.airport=a.iata AND r.status='success') AS last_success,
       (SELECT max(started_at) FROM fd_collection_runs r WHERE r.airport=a.iata) AS last_run,
       (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) n FROM fd_collection_runs r WHERE r.airport=a.iata AND r.started_at > now() - interval '7 days' GROUP BY status) s) AS runs_7d,
       (SELECT count(*) FROM fd_flights f WHERE f.airport=a.iata)::int AS flights,
       (SELECT count(*) FROM fd_observations o JOIN fd_flights f ON f.id=o.flight_id WHERE f.airport=a.iata)::int AS observations
     FROM fd_airports a ORDER BY a.enabled DESC, a.iata`);
}

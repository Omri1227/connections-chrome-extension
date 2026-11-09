// Completeness checks that need no extra API units: the collected airports check each other. A departure from
// collected airport A to collected airport B must also be among B's arrivals from A, and the reverse. Both sides come
// from separate queries (another airport's board, other request windows), so a flight present on one side only points
// to a snapshot that missed it, a flight stored under another number, or a cancellation recorded on one side only.
// Errors the source makes on both sides alike are not found here; EUROCONTROL's daily airport totals
// (docs/FLIGHT_DATA_OPERATIONS.md §0.8) are the independent check for those, at aggregate level.
import type { Db } from './db.ts';

/** Arrival scheduled this long after the departure at most: every pair of the collected airports is under 6 h. */
const MAX_BLOCK_HOURS = 8;
const MIN_BLOCK_HOURS = 0.25;
const STORED = `('success','partial','suspect')`;

interface Leg { id: string; airport: string; flight_key: string; local_date: string; scheduled_utc: Date; other: string | null; codes: string[] | null; status: string | null; physical: boolean }
export interface PairResult {
  from: string; to: string;
  departures: number; matched: number;
  missingArrival: string[];      // physical departures A→B with no arrival at B (B arrivals collected for the dates)
  arrivals: number;
  missingDeparture: string[];    // physical arrivals at B from A with no departure at A (A departures collected)
  statusMismatch: string[];      // matched, but cancelled on one side only
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function legs(db: Db, direction: 'departure' | 'arrival', from: string, to: string, airports: string[]): Promise<Leg[]> {
  return db.query<Leg>(
    `SELECT f.id, f.airport, f.flight_key, f.local_date::text AS local_date, f.scheduled_utc,
            CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END AS other,
            (SELECT array_agg(c.code) FROM fd_flight_codes c WHERE c.flight_id=f.id) AS codes,
            (SELECT o.status FROM fd_observations o WHERE o.flight_id=f.id ORDER BY o.last_seen_at DESC, o.id DESC LIMIT 1) AS status,
            EXISTS (SELECT 1 FROM fd_observations o WHERE o.flight_id=f.id AND o.role <> 'marketing') AS physical
     FROM fd_flights f
     WHERE f.direction=$1 AND f.local_date BETWEEN $2::date AND $3::date AND f.duplicate_of IS NULL
       AND f.airport = ANY($4::text[]) AND (CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END) = ANY($4::text[])`,
    [direction, from, to, airports]);
}

/**
 * Every ordered pair of collected airports for departures on local date `date` (and arrivals on that local date).
 * A side is judged only when the other side was collected for the dates it needs (arrivals at B on `date` and the
 * next day; departures at A on the day before and `date`). Codeshare listings are not expected on the other side but
 * may be the match (a number stored as its own flight-day at one airport and as a code at the other).
 */
export async function crossAirportCheck(db: Db, q: { date: string; airports?: string[] }) {
  const airports = q.airports ?? (await db.query<{ iata: string }>('SELECT iata FROM fd_airports WHERE enabled ORDER BY iata')).map((r) => r.iata);
  const collected = new Set((await db.query<{ k: string }>(
    `SELECT DISTINCT airport || '|' || direction || '|' || target_date::text AS k FROM fd_collection_runs
     WHERE status IN ${STORED} AND target_date BETWEEN $1::date AND $2::date`, [addDays(q.date, -1), addDays(q.date, 1)])).map((r) => r.k));
  const has = (a: string, dir: string, d: string) => collected.has(`${a}|${dir}|${d}`);
  const deps = await legs(db, 'departure', addDays(q.date, -1), q.date, airports);
  const arrs = await legs(db, 'arrival', q.date, addDays(q.date, 1), airports);
  const numbers = (l: Leg) => new Set([l.flight_key, ...(l.codes ?? [])]);
  const gap = (d: Leg, a: Leg) => (new Date(a.scheduled_utc).getTime() - new Date(d.scheduled_utc).getTime()) / 36e5;
  const pairs = (d: Leg, a: Leg) => a.airport === d.other && a.other === d.airport && gap(d, a) >= MIN_BLOCK_HOURS && gap(d, a) <= MAX_BLOCK_HOURS
    && [...numbers(d)].some((n) => numbers(a).has(n));
  const label = (l: Leg) => `${l.flight_key} ${new Date(l.scheduled_utc).toISOString().slice(11, 16)}Z`;
  const out = new Map<string, PairResult>();
  const pair = (from: string, to: string) => {
    const k = `${from}>${to}`;
    if (!out.has(k)) out.set(k, { from, to, departures: 0, matched: 0, missingArrival: [], arrivals: 0, missingDeparture: [], statusMismatch: [] });
    return out.get(k)!;
  };
  const used = new Set<string>();
  for (const d of deps.filter((x) => x.local_date === q.date && x.physical)) {
    if (!d.other || !has(d.other, 'arrival', q.date) || !has(d.other, 'arrival', addDays(q.date, 1))) continue;
    const r = pair(d.airport, d.other);
    r.departures++;
    const a = arrs.find((x) => !used.has(x.id) && pairs(d, x));
    if (!a) { if (d.status !== 'cancelled') r.missingArrival.push(label(d)); continue; }
    used.add(a.id);
    r.matched++;
    if ((d.status === 'cancelled') !== (a.status === 'cancelled')) r.statusMismatch.push(`${label(d)} ${d.status}/${a.status}`);
  }
  const usedDep = new Set<string>();
  for (const a of arrs.filter((x) => x.local_date === q.date && x.physical)) {
    if (!a.other || !has(a.other, 'departure', addDays(q.date, -1)) || !has(a.other, 'departure', q.date)) continue;
    const r = pair(a.other, a.airport);
    r.arrivals++;
    const d = deps.find((x) => !usedDep.has(x.id) && pairs(x, a));
    if (d) { usedDep.add(d.id); continue; }
    if (a.status !== 'cancelled') r.missingDeparture.push(label(a));
  }
  const pairsOut = [...out.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const sum = (f: (p: PairResult) => number) => pairsOut.reduce((s, p) => s + f(p), 0);
  return {
    date: q.date,
    totals: {
      departures: sum((p) => p.departures), matched: sum((p) => p.matched), missingArrival: sum((p) => p.missingArrival.length),
      arrivals: sum((p) => p.arrivals), missingDeparture: sum((p) => p.missingDeparture.length), statusMismatch: sum((p) => p.statusMismatch.length),
    },
    pairs: pairsOut,
  };
}

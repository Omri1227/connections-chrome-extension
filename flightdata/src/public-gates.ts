// Public gate service, data side (owner decision D2, 2026-11-02): for every flight number, ONE value per airport and
// direction: the gate it used on the most flight-days in the last 30 days. Nothing else leaves the machine: no dates,
// no times, no terminals, no per-day rows, no other gates. docs/PUBLIC_GATE_SERVICE.md.
//
// Counting is the same as everywhere else (analysis.ts `distribution`): one flight-day = one vote, its last reported
// gate; cancelled flight-days, codeshare listings and duplicates excluded; raw flight-days plus the monthly counters
// of licence-limited sources (months overlapping the window, see lookup.ts). A flight needs at least MIN_DAYS
// flight-days with a gate; ties go to the alphabetically first gate (deterministic).
import { AIRPORTS } from './airports.ts';
import { distribution } from './analysis.ts';
import type { Db } from './db.ts';

const CODES_SQL = `SELECT DISTINCT c.code, f.flight_key FROM fd_flight_codes c JOIN fd_flights f ON f.id=c.flight_id
        WHERE f.airport=$1 AND f.direction=$2 AND f.local_date >= $3::date AND f.local_date <= $4::date AND c.code <> f.flight_key
       UNION
       SELECT DISTINCT value AS code, flight_key FROM fd_derived_counts
        WHERE airport=$1 AND direction=$2 AND field='code' AND month >= date_trunc('month', $3::date) AND month <= $4::date AND value <> flight_key`;

export const PUBLIC_RULES = { windowDays: 30, minDays: 5 };

/** Airports the public service may answer for: the eight product airports (owner decision 2026-11-02: LHR replaces
 *  IST), minus those whose source carries no gates. IST's history is kept in the database but is no longer a product
 *  airport. */
export const PUBLIC_GATE_AIRPORTS = ['AMS', 'CDG', 'FCO', 'FRA', 'MAD', 'MUC', 'ZRH'] as const;
/** Product airports with NO public gate output, and why. A gate value for them would be unsupported. */
export const NO_PUBLIC_GATES: Record<string, string> = {
  LHR: 'AeroDataBox publishes no Heathrow gates (0 % of flights, even live; probe 2026-11-02). Heathrow is supported at terminal level only.',
};

export interface PublicGate { airport: string; direction: 'arrival' | 'departure'; gate: string; gateDays: number; flightDays: number; operatedAs?: string }
export interface PublicSnapshot {
  version: 1;
  generatedAt: string;
  window: { days: number; from: string; to: string };
  minDays: number;
  notes: string[];
  /** Flight number (normalised, "LH400") → one entry per airport × direction where it has a most-used gate. */
  flights: Record<string, PublicGate[]>;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The most used gate of one distribution group, or null below the minimum. Ties: alphabetically first. */
export function topGate(values: { value: string; n: number }[], minDays = PUBLIC_RULES.minDays): { gate: string; gateDays: number; known: number } | null {
  const known = values.reduce((s, v) => s + v.n, 0);
  if (known < minDays || !values.length) return null;
  const best = [...values].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))[0];
  return { gate: best.value, gateDays: best.n, known };
}

/** Where the counts come from: the database itself, or the admin API of the running server (read-only). */
export interface GateSource {
  distribution(airport: string, direction: 'arrival' | 'departure', from: string, to: string): Promise<{ group: string; total: number; values: { value: string; n: number }[] }[]>;
  /** Codeshare number → operating flight key; null = not available from this source. */
  codes(airport: string, direction: 'arrival' | 'departure', from: string, to: string): Promise<{ code: string; flight_key: string }[] | null>;
}

export const dbSource = (db: Db): GateSource => ({
  distribution: (airport, direction, from, to) => distribution(db, { airport, direction, from, to }, 'gate', 'flight_key'),
  codes: (airport, direction, from, to) => db.query<{ code: string; flight_key: string }>(CODES_SQL, [airport, direction, from, to]),
});

/** Builds the snapshot (inside the server: dbSource(db); from outside: an HTTP source over the admin API). */
export async function buildPublicSnapshot(src: GateSource, opts: { now?: Date; windowDays?: number; minDays?: number; airports?: string[] } = {}): Promise<PublicSnapshot> {
  const now = opts.now ?? new Date();
  const days = opts.windowDays ?? PUBLIC_RULES.windowDays, minDays = opts.minDays ?? PUBLIC_RULES.minDays;
  const to = iso(new Date(now.getTime() - 864e5)), from = iso(new Date(now.getTime() - days * 864e5));
  const flights: Record<string, PublicGate[]> = {};
  let noCodes = false;
  const add = (k: string, g: PublicGate) => { (flights[k] ??= []).push(g); };
  const airports = (opts.airports ?? [...PUBLIC_GATE_AIRPORTS]).filter((a) => a in AIRPORTS && !(a in NO_PUBLIC_GATES));
  for (const airport of airports) for (const direction of ['arrival', 'departure'] as const) {
    const groups = await src.distribution(airport, direction, from, to);
    const best = new Map<string, PublicGate>();
    for (const g of groups) {
      const t = topGate(g.values, minDays);
      if (!t || g.group === '(unknown)') continue;
      const e: PublicGate = { airport, direction, gate: t.gate, gateDays: t.gateDays, flightDays: g.total };
      best.set(g.group, e); add(g.group, e);
    }
    // codeshare numbers (raw codes of the window + monthly counters) point at their operating flight's entry
    const codes = await src.codes(airport, direction, from, to);
    if (!codes) noCodes = true;
    for (const c of codes ?? []) {
      const e = best.get(c.flight_key);
      if (e && !best.has(c.code) && !flights[c.code]?.some((x) => x.airport === airport && x.direction === direction)) add(c.code, { ...e, operatedAs: c.flight_key });
    }
  }
  return {
    version: 1, generatedAt: now.toISOString(), window: { days, from, to }, minDays,
    notes: [
      `The gate each flight used on the most flight-days between ${from} and ${to} (at least ${minDays} flight-days with a gate). It is the last gate the data source published for each flight-day, not a guarantee of today's gate.`,
      'Older days of the window are counted from monthly totals, so the window can reach back to the start of the previous calendar month.',
      ...(noCodes ? ['Codeshare numbers are not included in this snapshot (built from the statistics API): use the operating flight number.'] : []),
      ...Object.entries(NO_PUBLIC_GATES).map(([a, why]) => `${a}: no gates are published. ${why}`),
    ],
    flights,
  };
}

/** What the public API answers for one flight number (optionally one airport / direction). */
export function publicAnswer(s: PublicSnapshot, q: { flight: string; airport?: string; direction?: string }) {
  const results = (s.flights[q.flight] ?? []).filter((e) => (!q.airport || e.airport === q.airport) && (!q.direction || e.direction === q.direction))
    .map(({ airport, direction, gate, flightDays, operatedAs }) => ({ airport, direction, gate, flightDays, ...(operatedAs ? { operatedAs } : {}) }));
  return { flight: q.flight, found: results.length > 0, results, window: s.window, updated: s.generatedAt, note: s.notes[0] };
}

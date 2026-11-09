// Persistence of normalised records: flight identity, append-only observations, sightings, codes, runs and findings.
import type { Db } from './db.ts';
import { contentHash, identityOf, stageOf } from './normalize.ts';
import { localDate } from './time.ts';
import type { AirportInfo, NormalizedFlight, SourceInfo } from './types.ts';
import { VERIFIED_CODESHARES, type VerifiedCodeshare } from './verified-codeshares.ts';

/** A schedule more than this far from an existing movement with the same number and date is a different leg. */
const SAME_LEG_HOURS = 4;

export async function upsertAirport(db: Db, a: AirportInfo, enabled: boolean) {
  await db.query(
    `INSERT INTO fd_airports (iata, icao, name, tz, country, terminals, gate_pattern, schedule, enabled, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (iata) DO UPDATE SET icao=$2, name=$3, tz=$4, country=$5, terminals=$6, gate_pattern=$7, schedule=$8, enabled=$9, updated_at=now()`,
    [a.iata, a.icao, a.name, a.tz, a.country, JSON.stringify(a.terminals), a.gatePattern ?? null, JSON.stringify(a.schedule), enabled]);
}

export async function upsertSource(db: Db, s: SourceInfo) {
  await db.query(
    `INSERT INTO fd_sources (id, name, kind, base_url, airports, terms_url, terms_summary, permission, retention, cost_note, capabilities, raw_retention_days, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (id) DO UPDATE SET name=$2, kind=$3, base_url=$4, airports=$5, terms_url=$6, terms_summary=$7, permission=$8,
       retention=$9, cost_note=$10, capabilities=$11, raw_retention_days=$12, updated_at=now()`,
    [s.id, s.name, s.kind, s.baseUrl, JSON.stringify(s.airports), s.termsUrl, s.termsSummary, s.permission, s.retention, s.costNote, JSON.stringify(s.capabilities), s.rawRetentionDays ?? null]);
}

export interface RunKey { airport: string; sourceId: string; direction: string; targetDate: string; slot: string; trigger: 'schedule' | 'manual' | 'backfill' | 'test' }
export const runKeyOf = (k: RunKey) => `${k.airport}|${k.sourceId}|${k.direction}|${k.targetDate}|${k.slot}`;

/**
 * Starts a run. Returns null when the same slot already has a running or finished (non-failed) run, which makes
 * scheduled ticks idempotent and prevents overlapping jobs even across processes (unique partial index).
 */
export async function startRun(db: Db, k: RunKey, now: Date): Promise<number | null> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO fd_collection_runs (run_key, airport, source_id, direction, target_date, slot, trigger, started_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running')
     ON CONFLICT (run_key) WHERE status NOT IN ('failed') DO NOTHING RETURNING id`,
    [runKeyOf(k), k.airport, k.sourceId, k.direction, k.targetDate, k.slot, k.trigger, now.toISOString()]);
  return rows.length ? Number(rows[0].id) : null;
}

/** Marks runs left 'running' by a crashed process (older than maxMinutes) as failed, so their slot can be retried. */
export async function reapStaleRuns(db: Db, now: Date, maxMinutes = 60): Promise<number> {
  const r = await db.query(
    `UPDATE fd_collection_runs SET status='failed', finished_at=$1, error=COALESCE(error,'') || 'abandoned: process stopped while running'
     WHERE status='running' AND started_at < $1::timestamptz - make_interval(mins => $2) RETURNING id`, [now.toISOString(), maxMinutes]);
  return r.length;
}

export interface StoreStats { flightsSeen: number; flightsNew: number; observationsNew: number; observationsUnchanged: number; withTerminal: number; withGate: number }

/**
 * Stores the records of one run in a single transaction: either everything is written or nothing (a failure leaves no
 * half-written run). Identical states extend the latest observation; a changed state adds a new one.
 */
export async function storeRecords(db: Db, runId: number, source: SourceInfo, airport: AirportInfo, records: NormalizedFlight[], observedAt: Date): Promise<StoreStats> {
  const at = observedAt.toISOString();
  const st: StoreStats = { flightsSeen: 0, flightsNew: 0, observationsNew: 0, observationsUnchanged: 0, withTerminal: 0, withGate: 0 };
  await db.tx(async (t) => {
    const seenFlights = new Set<number>();
    // Operating rows first, so a movement's observation comes from its operating listing, not a codeshare row; then by
    // schedule, so leg numbers follow the time of day whatever order the source answered in.
    const rank: Record<string, number> = { operating: 0, unknown: 1, marketing: 2 };
    for (const r of [...records].sort((a, b) => (rank[a.role] ?? 1) - (rank[b.role] ?? 1) || a.scheduledUtc.localeCompare(b.scheduledUtc))) {
      const { key, identity } = identityOf(r);
      const day = localDate(new Date(r.scheduledUtc), airport.tz);
      const flightId = await findOrCreateFlight(t, r, key, identity, day, at, st);
      if (seenFlights.has(flightId)) {
        // A second row for the same movement in one run (a codeshare listing): keep its code, not a second sighting.
        await addCode(t, flightId, r, source.id);
        continue;
      }
      seenFlights.add(flightId);
      await addCode(t, flightId, r, source.id);
      const hash = contentHash(r);
      const last = (await t.query<{ id: string; content_hash: string }>(
        'SELECT id, content_hash FROM fd_observations WHERE flight_id=$1 AND source_id=$2 ORDER BY last_seen_at DESC, id DESC LIMIT 1', [flightId, source.id]))[0];
      let obsId: number;
      if (last && last.content_hash === hash) {
        await t.query('UPDATE fd_observations SET last_seen_at=GREATEST(last_seen_at,$2), seen_count=seen_count+1 WHERE id=$1', [last.id, at]);
        obsId = Number(last.id);
        st.observationsUnchanged++;
      } else {
        const ins = await t.query<{ id: string }>(
          `INSERT INTO fd_observations (flight_id, source_id, first_run_id, first_seen_at, last_seen_at, content_hash, stage, status, status_raw,
             terminal, gate, stand, baggage_belt, scheduled_utc, estimated_utc, actual_utc, aircraft_type, listed_as, role, source_record_id, extra)
           VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
          [flightId, source.id, runId, at, hash, stageOf(r), r.status, r.statusRaw, r.terminal, r.gate, r.stand, r.baggageBelt,
            r.scheduledUtc, r.estimatedUtc, r.actualUtc, r.aircraftType, r.flightNumber, r.role, r.sourceRecordId, JSON.stringify(r.extra ?? {})]);
        obsId = Number(ins[0].id);
        st.observationsNew++;
      }
      await t.query('INSERT INTO fd_sightings (run_id, flight_id, observation_id) VALUES ($1,$2,$3) ON CONFLICT (run_id, flight_id) DO NOTHING', [runId, flightId, obsId]);
      await t.query('UPDATE fd_flights SET last_seen_at=GREATEST(last_seen_at,$2) WHERE id=$1', [flightId, at]);
      if (r.carrier) await t.query('INSERT INTO fd_airlines (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=COALESCE(fd_airlines.name, EXCLUDED.name)', [r.carrier, r.airlineName]);
      st.flightsSeen++;
      if (r.terminal) st.withTerminal++;
      if (r.gate) st.withGate++;
    }
  });
  return st;
}

async function findOrCreateFlight(t: Db, r: NormalizedFlight, key: string, identity: 'operating' | 'listed', day: string, at: string, st: StoreStats): Promise<number> {
  const rows = await t.query<{ id: string; leg: number; scheduled_utc: Date; identity: string }>(
    'SELECT id, leg, scheduled_utc, identity FROM fd_flights WHERE airport=$1 AND direction=$2 AND flight_key=$3 AND local_date=$4 ORDER BY leg',
    [r.airport, r.direction, key, day]);
  const sched = Date.parse(r.scheduledUtc);
  const match = rows.find((x) => Math.abs(new Date(x.scheduled_utc).getTime() - sched) <= SAME_LEG_HOURS * 36e5);
  if (match) {
    // A listed-only identity is upgraded once a source confirms the number is the operating flight.
    if (identity === 'operating' && match.identity === 'listed') await t.query("UPDATE fd_flights SET identity='operating' WHERE id=$1", [match.id]);
    return Number(match.id);
  }
  const leg = rows.length ? Math.max(...rows.map((x) => x.leg)) + 1 : 1;
  const ins = await t.query<{ id: string }>(
    `INSERT INTO fd_flights (airport, direction, flight_key, leg, local_date, carrier, identity, origin, destination, scheduled_utc, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
    [r.airport, r.direction, key, leg, day, carrierOf(key), identity, r.origin, r.destination, r.scheduledUtc, at]);
  st.flightsNew++;
  return Number(ins[0].id);
}

const carrierOf = (key: string) => /^([A-Z]{3}(?=\d)|[A-Z0-9]{2})/.exec(key)?.[1] ?? null;

async function addCode(t: Db, flightId: number, r: NormalizedFlight, sourceId: string) {
  const role = r.role === 'operating' ? 'operating' : r.role === 'marketing' ? 'marketing' : 'listed';
  await t.query('INSERT INTO fd_flight_codes (flight_id, code, role, source_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [flightId, r.flightNumber, role, sourceId]);
  for (const c of r.codeshares) if (c !== r.flightNumber) await t.query("INSERT INTO fd_flight_codes (flight_id, code, role, source_id) VALUES ($1,$2,'marketing',$3) ON CONFLICT DO NOTHING", [flightId, c, sourceId]);
}

export interface Superseded { id: number; flightKey: string; scheduledUtc: string; by: string; byId: number }

/**
 * Removes flight-days that a later run showed to be a codeshare listing of another movement: flight-day F is
 * superseded by G when both are at the same airport, direction and scheduled instant, G carries F's number as a
 * marketing code, and G was seen after F was last seen. That happens when one snapshot could not link a codeshare row
 * (e.g. the operator row was duplicated in that response) or marked a codeshare as an operator (AMS 2026-10-31:
 * KL209 and UX3001 "operating" in two runs, codes of CI74 in the next two). F's codes are moved to G, so lookups by
 * its number still find the movement; F's own observations duplicate G's and are deleted with it. Never merges on a
 * guess: same instant and a source-made code link are both required.
 */
export async function reconcileSuperseded(db: Db, q: { airport: string; direction?: string; dates?: string[]; dryRun?: boolean }): Promise<Superseded[]> {
  const p: unknown[] = [q.airport];
  let w = 'f.airport=$1';
  if (q.direction) { p.push(q.direction); w += ` AND f.direction=$${p.length}`; }
  if (q.dates?.length) { p.push(q.dates); w += ` AND f.local_date = ANY($${p.length}::date[])`; }
  return db.tx(async (t) => {
    const rows = await t.query<{ id: string; flight_key: string; scheduled_utc: Date; by: string; by_id: string }>(
      `SELECT DISTINCT ON (f.id) f.id, f.flight_key, f.scheduled_utc, g.flight_key AS by, g.id AS by_id
       FROM fd_flights f JOIN fd_flights g ON g.airport=f.airport AND g.direction=f.direction AND g.local_date=f.local_date
         AND g.scheduled_utc=f.scheduled_utc AND g.id<>f.id AND g.last_seen_at > f.last_seen_at
       WHERE ${w} AND EXISTS (SELECT 1 FROM fd_flight_codes c WHERE c.flight_id=g.id AND c.code=f.flight_key AND c.role='marketing')
       ORDER BY f.id, g.last_seen_at DESC, g.id`, p);
    // A flight-day that itself absorbs another one in this pass is kept (chains are resolved on the next pass).
    const absorbing = new Set(rows.map((r) => r.by_id));
    const out: Superseded[] = [];
    for (const r of rows) {
      if (absorbing.has(r.id)) continue;
      out.push({ id: Number(r.id), flightKey: r.flight_key, scheduledUtc: new Date(r.scheduled_utc).toISOString(), by: r.by, byId: Number(r.by_id) });
      if (q.dryRun) continue;
      await t.query(`INSERT INTO fd_flight_codes (flight_id, code, role, source_id)
                     SELECT $2, code, 'marketing', source_id FROM fd_flight_codes WHERE flight_id=$1 ON CONFLICT DO NOTHING`, [r.id, r.by_id]);
      await t.query('DELETE FROM fd_flights WHERE id=$1', [r.id]); // observations, codes and sightings cascade
    }
    return out;
  });
}

export interface DuplicateMark { id: number; flightKey: string; of: string; ofId: number; reason: 'verified-codeshare' | 'same-aircraft'; scheduledUtc: string }

/**
 * Marks flight-days that are the same physical movement as another flight-day at the same airport, direction and
 * scheduled instant (migration 005). Nothing is deleted: observations stay and the flight-day is still found by its
 * own number, but physical counts and pooled statistics skip it. Recomputed from scratch for the given dates, so a
 * mark disappears when its evidence does. Only two kinds of evidence count:
 *  - verified-codeshare: a hand-checked relationship for that date (verified-codeshares.ts);
 *  - same-aircraft: the latest observations give the same aircraft registration and the same other airport (one
 *    airframe cannot make two departures at one instant).
 * Matching time, gate, route and aircraft model without a registration is NOT enough (owner decision 2026-11-01):
 * such groups stay counted and are reported as gate-time-conflict findings. In a same-aircraft group the flight-day
 * kept is the one with most codes, then a 2-letter carrier code, then the lowest number; totals do not depend on it.
 * Codeshare listings (every observation 'marketing') are already outside physical counts; only a verified
 * relationship marks them, so they point to their operating flight.
 */
export async function markDuplicates(db: Db, q: { airport: string; direction: string; dates: string[]; verified?: VerifiedCodeshare[] }): Promise<DuplicateMark[]> {
  const verified = (q.verified ?? VERIFIED_CODESHARES).filter((v) => v.airport === q.airport && v.direction === q.direction && q.dates.includes(v.date));
  return db.tx(async (t) => {
    await t.query('UPDATE fd_flights SET duplicate_of=NULL, duplicate_reason=NULL WHERE airport=$1 AND direction=$2 AND local_date = ANY($3::date[]) AND duplicate_of IS NOT NULL',
      [q.airport, q.direction, q.dates]);
    type Row = { id: string; flight_key: string; carrier: string | null; local_date: string; scheduled_utc: Date; other: string | null; reg: string | null; codes: number; listing: boolean };
    const rows = await t.query<Row>(
      `SELECT f.id, f.flight_key, f.carrier, f.local_date::text AS local_date, f.scheduled_utc,
              CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END AS other,
              (SELECT o.extra->>'registration' FROM fd_observations o WHERE o.flight_id=f.id ORDER BY o.last_seen_at DESC, o.id DESC LIMIT 1) AS reg,
              (SELECT count(*) FROM fd_flight_codes c WHERE c.flight_id=f.id)::int AS codes,
              NOT EXISTS (SELECT 1 FROM fd_observations o WHERE o.flight_id=f.id AND o.role <> 'marketing') AS listing
       FROM fd_flights f WHERE f.airport=$1 AND f.direction=$2 AND f.local_date = ANY($3::date[])`, [q.airport, q.direction, q.dates]);
    const instant = (r: Row) => `${r.local_date}|${new Date(r.scheduled_utc).toISOString()}`;
    const out: DuplicateMark[] = [];
    const marked = new Set<string>();
    const mark = async (f: Row, g: Row, reason: DuplicateMark['reason']) => {
      await t.query('UPDATE fd_flights SET duplicate_of=$2, duplicate_reason=$3 WHERE id=$1', [f.id, g.id, reason]);
      marked.add(f.id);
      out.push({ id: Number(f.id), flightKey: f.flight_key, of: g.flight_key, ofId: Number(g.id), reason, scheduledUtc: new Date(f.scheduled_utc).toISOString() });
    };
    for (const v of verified) for (const g of rows.filter((r) => r.flight_key === v.operating && r.local_date === v.date))
      for (const f of rows.filter((r) => v.marketing.includes(r.flight_key) && r.id !== g.id && instant(r) === instant(g) && !marked.has(r.id))) await mark(f, g, 'verified-codeshare');
    const groups = new Map<string, Row[]>();
    for (const r of rows) if (r.reg && r.other && !r.listing && !marked.has(r.id)) { const k = `${instant(r)}|${r.other}|${r.reg}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
    const num = (k: string) => Number(/(\d+)$/.exec(k)?.[1] ?? Infinity);
    for (const xs of groups.values()) {
      if (xs.length < 2) continue;
      const [keep, ...rest] = [...xs].sort((a, b) => b.codes - a.codes || (a.carrier?.length === 2 ? 0 : 1) - (b.carrier?.length === 2 ? 0 : 1) || num(a.flight_key) - num(b.flight_key) || Number(a.id) - Number(b.id));
      for (const f of rest) await mark(f, keep, 'same-aircraft');
    }
    return out;
  });
}

export async function finishRun(db: Db, runId: number, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c}=$${i + 2}`).join(', ');
  await db.query(`UPDATE fd_collection_runs SET ${sets} WHERE id=$1`, [runId, ...cols.map((c) => { const v = fields[c]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; })]);
}

export async function addFinding(db: Db, f: { runId?: number | null; airport?: string; sourceId?: string; direction?: string; targetDate?: string; flightId?: number | null; kind: string; severity: 'info' | 'warning' | 'error'; detail?: unknown }) {
  await db.query('INSERT INTO fd_quality_findings (run_id, airport, source_id, direction, target_date, flight_id, kind, severity, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [f.runId ?? null, f.airport ?? null, f.sourceId ?? null, f.direction ?? null, f.targetDate ?? null, f.flightId ?? null, f.kind, f.severity, JSON.stringify(f.detail ?? {})]);
}

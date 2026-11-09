// Licence-driven retention: roll raw observations of time-limited sources into monthly counters, then delete them
// before the licence limit. Counters keep no dates and no per-day values (the month, the flight and how many
// flight-days showed each terminal/gate), which is the form of "derived work" those licences allow to be kept.
// Whether a given counter is a permitted derived work is a legal question the owner must confirm (docs: COST_MODEL §4).
import { MARKETING_ONLY } from './analysis.ts';
import type { Db } from './db.ts';

export interface RetentionResult { source: string; flightsRolled: number; observationsDeleted: number; rawSamplesDeleted: number }

/** Full database backups kept (backup.ts). Each one holds raw rows, so it shortens how long raw rows stay live. */
export const BACKUP_KEEP = 2;
/** Raw rows are rolled up this many days before the licence limit: 1 day margin + the backup rotation. */
export const DEFAULT_SAFETY_DAYS = 1 + BACKUP_KEEP;

/**
 * For every source with raw_retention_days: flight-days whose first observation from that source is older than
 * (limit − safety) days are rolled up and their raw rows deleted. The safety margin (1 day + BACKUP_KEEP days) keeps
 * every copy, backups included, inside the licence limit: for AeroDataBox (7 days) raw rows live 4 days and a backup
 * holding them at most 2 more. Idempotent: rolled flights are deleted, so they cannot be counted twice.
 */
export async function sweepRetention(db: Db, now: Date, opts: { safetyDays?: number; rawSampleDays?: number } = {}): Promise<RetentionResult[]> {
  const safety = opts.safetyDays ?? DEFAULT_SAFETY_DAYS;
  const out: RetentionResult[] = [];
  const sources = await db.query<{ id: string; raw_retention_days: number | null }>('SELECT id, raw_retention_days FROM fd_sources');
  for (const s of sources) {
    const res: RetentionResult = { source: s.id, flightsRolled: 0, observationsDeleted: 0, rawSamplesDeleted: 0 };
    if (s.raw_retention_days !== null) {
      const cutoffDays = Math.max(s.raw_retention_days - safety, 1);
      await db.tx(async (t) => {
        const due = await t.query<{ id: string }>(
          `SELECT f.id FROM fd_flights f WHERE EXISTS (SELECT 1 FROM fd_observations o WHERE o.flight_id=f.id AND o.source_id=$1)
             AND (SELECT min(o.first_seen_at) FROM fd_observations o WHERE o.flight_id=f.id AND o.source_id=$1) < $2::timestamptz - make_interval(days => $3)`,
          [s.id, now.toISOString(), cutoffDays]);
        if (!due.length) return;
        const ids = due.map((d) => Number(d.id));
        // One row per flight-day: last reported terminal/gate from this source.
        const days = await t.query<{ id: string; airport: string; direction: string; flight_key: string; carrier: string | null; other: string | null; month: string; terminal: string | null; gate: string | null; status: string; marketing_only: boolean; duplicate_of: string | null }>(
          `SELECT f.id, f.airport, f.direction, f.flight_key, f.carrier, CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END AS other,
                  date_trunc('month', f.local_date)::date::text AS month, ${MARKETING_ONLY} AS marketing_only, f.duplicate_of,
                  (array_agg(o.terminal ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.terminal IS NOT NULL))[1] AS terminal,
                  (array_agg(o.gate ORDER BY o.last_seen_at DESC, o.id DESC) FILTER (WHERE o.gate IS NOT NULL))[1] AS gate,
                  (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status
           FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id AND o.source_id=$1
           WHERE f.id = ANY($2::bigint[]) GROUP BY f.id`, [s.id, ids]);
        const codeRows = await t.query<{ flight_id: string; code: string; flight_key: string }>(
          `SELECT c.flight_id, c.code, f.flight_key FROM fd_flight_codes c JOIN fd_flights f ON f.id=c.flight_id WHERE c.source_id=$1 AND c.flight_id = ANY($2::bigint[]) AND c.code <> f.flight_key`, [s.id, ids]);
        for (const d of days) {
          const bump = async (field: string, value: string) => t.query(
            `INSERT INTO fd_derived_counts (source_id, airport, direction, flight_key, carrier, other, month, field, value, n) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
             ON CONFLICT (source_id, airport, direction, flight_key, other, month, field, value) DO UPDATE SET n = fd_derived_counts.n + 1`,
            [s.id, d.airport, d.direction, d.flight_key, d.carrier, d.other ?? '', d.month, d.marketing_only || d.duplicate_of !== null ? `listed:${field}` : field, value]);
          // An unlinked codeshare listing, or a flight-day marked as the same movement as another (migration 005),
          // goes to the 'listed:*' fields (migration 004): kept, but never a physical flight-day, so a movement and its
          // codeshare are not both counted.
          await bump('flight-days', 'all');
          for (const c of codeRows.filter((x) => String(x.flight_id) === String(d.id))) await bump('code', c.code);
          if (d.status === 'cancelled') { await bump('cancelled', 'all'); continue; }
          await bump('terminal', d.terminal ?? '');
          await bump('gate', d.gate ?? '');
        }
        const del = await t.query('DELETE FROM fd_observations WHERE source_id=$1 AND flight_id = ANY($2::bigint[]) RETURNING id', [s.id, ids]);
        await t.query('DELETE FROM fd_flight_codes WHERE source_id=$1 AND flight_id = ANY($2::bigint[])', [s.id, ids]);
        // A flight with no observations left from any source is removed (sightings cascade).
        await t.query('DELETE FROM fd_flights f WHERE f.id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM fd_observations o WHERE o.flight_id=f.id)', [ids]);
        await t.query('UPDATE fd_flights SET rolled_up=true WHERE id = ANY($1::bigint[])', [ids]);
        res.flightsRolled = days.length;
        res.observationsDeleted = del.length;
      });
    }
    const keepDays = Math.min(opts.rawSampleDays ?? 14, s.raw_retention_days !== null ? Math.max(s.raw_retention_days - safety, 1) : Infinity);
    const r = await db.query(`DELETE FROM fd_raw_samples rs USING fd_collection_runs r WHERE rs.run_id=r.id AND r.source_id=$1 AND rs.created_at < $2::timestamptz - make_interval(days => $3) RETURNING rs.id`,
      [s.id, now.toISOString(), keepDays]);
    res.rawSamplesDeleted = r.length;
    out.push(res);
  }
  return out;
}

/** Minimum flight-days in a (flight, month) counter before it is shown on its own in the dashboard. */
export const DISCLOSURE_MIN = 5;

// Operational health of the running collector: per assigned airport the last successful run, flights collected,
// terminal/gate coverage, every slot since activation (collected / late / partial / missed / pending), plus API-unit use,
// duplicate-run check, backups and database size. Read-only. Served at /fd-api/ops and printed by `npm run fd:health`.
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from './adapters/index.ts';
import { AIRPORTS } from './airports.ts';
import { GATE_AREA_SQL, MARKETING_ONLY } from './analysis.ts';
import { BACKUP_KEEP, listBackups, listCounterBackups, manualCopies, RAW_LIMIT_DAYS, RAW_ROLLUP_DAYS } from './backup.ts';
import type { Db } from './db.ts';
import { DEFAULT_SLOTS, nextSlot, unitsUsed } from './scheduler.ts';
import { addDays, localDate, zonedInstant } from './time.ts';

const STORED = `('success','partial','suspect')`;
/** A slot collected more than this after its time was caught up after a gap (PC asleep or off). */
export const LATE_MINUTES = 30;

export type SlotState = 'collected' | 'late' | 'partial' | 'missed' | 'pending';

export async function opsHealth(db: Db, o: { assignments: { airport: string; source: string }[]; env: Record<string, string | undefined>; now: Date; graceHours: number; dbDir?: string | null }) {
  const { now, graceHours } = o;
  const airports = [];
  for (const { airport: iata, source } of o.assignments) {
    const a = AIRPORTS[iata];
    if (!a) continue;
    const runs = await db.query<{ slot: string; target_date: string; direction: string; status: string; started_at: Date }>(
      `SELECT slot, target_date::text AS target_date, direction, status, started_at FROM fd_collection_runs
       WHERE airport=$1 AND source_id=$2 AND trigger='schedule' ORDER BY started_at`, [iata, source]);
    const first = runs[0]?.slot ?? null;
    // Every slot from the activation slot to now.
    const slots: { slot: string; at: string; state: SlotState; runsOk: number; runsExpected: number; delayMinutes: number | null }[] = [];
    if (first) {
      for (let d = first.slice(0, 10); d <= localDate(now, a.tz); d = addDays(d, 1)) for (const s of DEFAULT_SLOTS) {
        const key = `${d} ${s.at}`;
        if (key < first) continue;
        const at = zonedInstant(d, s.at, a.tz);
        if (at > now) continue;
        const mine = runs.filter((r) => r.slot === key);
        const ok = mine.filter((r) => r.status !== 'failed' && r.status !== 'running');
        const expected = s.dayOffsets.length * 2;
        const okKeys = new Set(ok.map((r) => `${r.target_date}|${r.direction}`)).size;
        const startedFirst = mine.length ? Math.min(...mine.map((r) => new Date(r.started_at).getTime())) : null;
        const delay = startedFirst === null ? null : Math.round((startedFirst - at.getTime()) / 60_000);
        const open = now.getTime() - at.getTime() < graceHours * 36e5;
        const state: SlotState = okKeys >= expected ? (delay !== null && delay > LATE_MINUTES ? 'late' : 'collected') : open ? 'pending' : okKeys ? 'partial' : 'missed';
        slots.push({ slot: key, at: at.toISOString(), state, runsOk: okKeys, runsExpected: expected, delayMinutes: delay });
      }
    }
    const last = (await db.query<{ t: Date | null }>(`SELECT max(finished_at) AS t FROM fd_collection_runs WHERE airport=$1 AND source_id=$2 AND status IN ${STORED}`, [iata, source]))[0]?.t ?? null;
    const failed24 = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM fd_collection_runs WHERE airport=$1 AND source_id=$2 AND status='failed' AND started_at > $3::timestamptz - interval '24 hours'`, [iata, source, now.toISOString()]))[0].n;
    // Coverage over the raw flight-days of the last 7 local days (last reported values, cancelled excluded).
    const cov = (await db.query<{ direction: string; n: number; t: number; g: number }>(
      `WITH d AS (
         SELECT f.direction,
           bool_or(o.terminal IS NOT NULL) AS t, bool_or(o.gate IS NOT NULL) AS g,
           (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status
         FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
         WHERE f.airport=$1 AND f.local_date >= $2::date AND f.duplicate_of IS NULL GROUP BY f.id, f.direction HAVING NOT ${MARKETING_ONLY})
       SELECT direction, count(*)::int AS n, count(*) FILTER (WHERE t)::int AS t, count(*) FILTER (WHERE g)::int AS g FROM d WHERE status <> 'cancelled' GROUP BY 1`,
      [iata, addDays(localDate(now, a.tz), -7)]));
    // Final coverage: only flight-days that were collected again after their local date ended (the 07:00 "yesterday"
    // run), i.e. the last values the source published. Gates at MAD/IST/ZRH appear only near departure, so a day still
    // in progress understates them (2026-10-31: MAD departures 30 % today vs 96 % for the completed day).
    const fin = (await db.query<{ direction: string; n: number; t: number; g: number; a: number; days: number }>(
      `WITH done AS (SELECT DISTINCT target_date FROM fd_collection_runs WHERE airport=$1 AND source_id=$2 AND status IN ${STORED} AND left(slot, 10) > target_date::text),
       d AS (
         SELECT f.direction, f.local_date,
           bool_or(o.terminal IS NOT NULL) AS t, bool_or(o.gate IS NOT NULL) AS g, bool_or(${GATE_AREA_SQL('o.gate')} IS NOT NULL) AS a,
           (array_agg(o.status ORDER BY o.last_seen_at DESC, o.id DESC))[1] AS status
         FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id
         WHERE f.airport=$1 AND f.local_date IN (SELECT target_date FROM done) AND f.duplicate_of IS NULL GROUP BY f.id, f.direction, f.local_date HAVING NOT ${MARKETING_ONLY})
       SELECT direction, count(*)::int AS n, count(*) FILTER (WHERE t)::int AS t, count(*) FILTER (WHERE g)::int AS g, count(*) FILTER (WHERE a)::int AS a, count(DISTINCT local_date)::int AS days
       FROM d WHERE status <> 'cancelled' GROUP BY 1`, [iata, source]));
    const total = (await db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM fd_flights WHERE airport=$1)::int + COALESCE((SELECT sum(n) FROM fd_derived_counts WHERE airport=$1 AND field='flight-days'), 0)::int AS n`, [iata]))[0].n;
    const count = (s: SlotState) => slots.filter((x) => x.state === s).length;
    airports.push({
      airport: iata, name: a.name, tz: a.tz, source, activeSince: first,
      lastSuccess: last ? new Date(last).toISOString() : null, nextSlot: nextSlot(a, DEFAULT_SLOTS, now)?.toISOString() ?? null,
      flightDaysTotal: total,
      coverage7d: Object.fromEntries(cov.map((c) => [c.direction, { flightDays: c.n, withTerminal: c.t, withGate: c.g }])),
      coverageFinal: Object.fromEntries(fin.map((c) => [c.direction, { days: c.days, flightDays: c.n, withTerminal: c.t, withGate: c.g, withGateArea: c.a }])),
      slots: { collected: count('collected'), late: count('late'), partial: count('partial'), missed: count('missed'), pending: count('pending') },
      problemSlots: slots.filter((x) => x.state === 'missed' || x.state === 'partial' || x.state === 'late').slice(-10),
      failedRuns24h: failed24,
    });
  }
  const budgets = (await Promise.all([...new Set(o.assignments.map((x) => x.source))].map((id) => (ADAPTERS[id] ? unitsUsed(db, ADAPTERS[id].info, o.env, now) : null)))).filter(Boolean);
  const duplicates = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT run_key FROM fd_collection_runs WHERE status <> 'failed' GROUP BY run_key HAVING count(*) > 1) x`))[0].n;
  const first = (await db.query<{ t: Date | null }>('SELECT min(started_at) AS t FROM fd_collection_runs'))[0]?.t ?? null;
  const rawOldest = (await db.query<{ t: Date | null }>('SELECT min(first_seen_at) AS t FROM fd_observations o JOIN fd_sources s ON s.id=o.source_id WHERE s.raw_retention_days IS NOT NULL'))[0]?.t ?? null;
  return {
    now: now.toISOString(), budgets, duplicateRuns: duplicates, backups: listBackups(), counterBackups: listCounterBackups(),
    manualCopies: o.dbDir ? manualCopies(path.dirname(o.dbDir), first ? new Date(first) : null, now) : [],
    retention: { rawLimitDays: RAW_LIMIT_DAYS, rawRollupDays: RAW_ROLLUP_DAYS, fullBackupsKept: BACKUP_KEEP, oldestRawRow: rawOldest ? new Date(rawOldest).toISOString() : null },
    databaseBytes: o.dbDir ? dirBytes(o.dbDir) : null, airports,
  };
}

function dirBytes(dir: string): number | null {
  try {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? (dirBytes(path.join(dir, e.name)) ?? 0) : fs.statSync(path.join(dir, e.name)).size;
    return n;
  } catch { return null; }
}

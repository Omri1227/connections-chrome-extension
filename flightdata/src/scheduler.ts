// Tick-based scheduling. A tick (run every 15–30 min by cron, or by the local loop) works out which collection slots
// are due at each airport in its own local time, and runs those not yet collected. Because slots are keyed by local
// date + time and stored with a unique index, ticks are idempotent: a restart, a late tick or two overlapping ticks
// never collect a slot twice, and a missed slot is caught up within the grace period.
import { collect, type RunSummary } from './collector.ts';
import type { Db } from './db.ts';
import { reapStaleRuns, runKeyOf } from './store.ts';
import { addDays, localDate, zonedInstant } from './time.ts';
import type { AirportInfo, Direction, FetchContext, SourceAdapter, SourceInfo } from './types.ts';

export interface SlotSpec { at: string; dayOffsets: number[] }

/**
 * Default plan: 07:00 collects today and yesterday (recovering late-evening flights and their last reported
 * assignment), 15:00 and 23:30 collect today. Yesterday is only requested from sources that serve past days.
 */
export const DEFAULT_SLOTS: SlotSpec[] = [
  { at: '07:00', dayOffsets: [0, -1] },
  { at: '15:00', dayOffsets: [0] },
  { at: '23:30', dayOffsets: [0] },
];

export interface DueSlot { slot: string; slotInstant: Date; targetDates: string[] }

/** Slots whose local time has passed within the last `graceHours` (DST-correct: each slot is resolved in the zone). */
export function dueSlots(airport: AirportInfo, slots: SlotSpec[], now: Date, graceHours = 6, pastDays = 1): DueSlot[] {
  const today = localDate(now, airport.tz);
  const out: DueSlot[] = [];
  for (const d of [addDays(today, -1), today]) {
    for (const s of slots) {
      const inst = zonedInstant(d, s.at, airport.tz);
      const age = now.getTime() - inst.getTime();
      if (age < 0 || age > graceHours * 36e5) continue;
      const targets = s.dayOffsets.filter((o) => o >= -pastDays).map((o) => addDays(d, o));
      out.push({ slot: `${d} ${s.at}`, slotInstant: inst, targetDates: targets });
    }
  }
  return out.sort((a, b) => a.slotInstant.getTime() - b.slotInstant.getTime());
}

export interface Assignment { airport: AirportInfo; adapter: SourceAdapter }

export interface TickResult { due: number; runs: RunSummary[]; notReady: { airport: string; source: string; reason: string }[]; reaped: number }

/**
 * Retry policy for failed slots (cost protection: before this, a failed run was restarted on every tick of the grace
 * period, which during a 6-h outage meant ~768 paid calls per airport). A failed slot is retried at most
 * `maxSlotAttempts` times per run, no sooner than `retryGapMinutes` after the previous failure.
 */
export const RETRY_POLICY = { maxSlotAttempts: 3, retryGapMinutes: 60, offlineRetryGapMinutes: 10 };

/**
 * "This computer is offline": the request never reached the source (no connection, no DNS), so it cost no units.
 * Seen after the PC wakes from standby, before Wi-Fi is back (2026-11-03/05/06: every airport of the tick failed with
 * "fetch failed" within a minute, then waited 60 min, by which time the PC was often asleep again). Such a failure
 * ends the tick for every airport, is retried after `offlineRetryGapMinutes`, and does not count against
 * `maxSlotAttempts`. A timeout is NOT offline: the request may have reached the source (and been billed).
 */
export const OFFLINE_ERROR = /\b(fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|ECONNREFUSED)\b/;
const OFFLINE_SQL = `'fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|ECONNREFUSED'`;
export const isOffline = (error: string | null | undefined) => !!error && OFFLINE_ERROR.test(error) && !/HTTP \d{3}/.test(error);

/** HTTP requests × units of a budgeted source over its rolling period. */
export async function unitsUsed(db: Db, info: SourceInfo, env: Record<string, string | undefined>, now: Date): Promise<{ source: string; used: number; budget: number; periodDays: number } | null> {
  const b = info.unitBudget;
  if (!b) return null;
  const r = await db.query<{ pages: string | null }>(
    `SELECT sum(pages_fetched) AS pages FROM fd_collection_runs WHERE source_id=$1 AND started_at > $2::timestamptz - make_interval(days => $3)`,
    [info.id, now.toISOString(), b.periodDays]);
  const budget = Number(env[b.envVar]) > 0 ? Number(env[b.envVar]) : b.defaultUnits;
  return { source: info.id, used: Number(r[0]?.pages ?? 0) * b.unitsPerRequest, budget, periodDays: b.periodDays };
}

/** Failed runs that count against the retry policy (a run reaped after a process crash is not a source failure). */
const SOURCE_FAILURE = `status='failed' AND COALESCE(error,'') NOT LIKE '%abandoned: process stopped%'`;

/** Source failures that count against maxSlotAttempts: an offline failure never reached the source. */
const COUNTED_FAILURE = `${SOURCE_FAILURE} AND NOT (COALESCE(error,'') ~ ${OFFLINE_SQL} AND COALESCE(error,'') !~ 'HTTP [0-9]{3}')`;

/** A slot whose last failed run ended less than retryGapMinutes (offline: offlineRetryGapMinutes) ago waits. */
async function slotWaiting(db: Db, airport: string, source: string, slot: string, now: Date): Promise<number | null> {
  const r = await db.query<{ finished_at: Date | null; error: string | null }>(
    `SELECT finished_at, error FROM fd_collection_runs WHERE airport=$1 AND source_id=$2 AND slot=$3 AND ${SOURCE_FAILURE} AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`, [airport, source, slot]);
  const last = r[0];
  if (!last?.finished_at) return null;
  const gap = isOffline(last.error) ? RETRY_POLICY.offlineRetryGapMinutes : RETRY_POLICY.retryGapMinutes;
  return now.getTime() - new Date(last.finished_at).getTime() < gap * 60_000 ? gap : null;
}

export async function tick(db: Db, assignments: Assignment[], ctx: FetchContext, opts: { slots?: SlotSpec[]; graceHours?: number } = {}): Promise<TickResult> {
  const now = ctx.now();
  const reaped = await reapStaleRuns(db, now);
  const res: TickResult = { due: 0, runs: [], notReady: [], reaped };
  const brokenSources = new Set<string>();   // auth / quota refusal seen in this tick: stop calling that source
  let offline = false;                       // this computer is offline: stop the whole tick (no source is reachable)
  for (const { airport, adapter } of assignments) {
    if (offline) { res.notReady.push({ airport: airport.iata, source: adapter.info.id, reason: `offline (no connection); retried after ${RETRY_POLICY.offlineRetryGapMinutes} min` }); continue; }
    const why = adapter.notReady(ctx.env);
    if (why) { res.notReady.push({ airport: airport.iata, source: adapter.info.id, reason: why }); continue; }
    if (brokenSources.has(adapter.info.id)) { res.notReady.push({ airport: airport.iata, source: adapter.info.id, reason: 'source refused a request in this tick (auth/quota); not called again until the next tick' }); continue; }
    const slots = opts.slots ?? DEFAULT_SLOTS;
    for (const due of dueSlots(airport, slots, now, opts.graceHours, adapter.info.capabilities.pastDays)) {
      const usage = await unitsUsed(db, adapter.info, ctx.env, now);
      if (usage && usage.used >= usage.budget) { res.notReady.push({ airport: airport.iata, source: adapter.info.id, reason: `unit budget reached (${usage.used} of ${usage.budget} units in ${usage.periodDays} days)` }); break; }
      const wait = await slotWaiting(db, airport.iata, adapter.info.id, due.slot, now);
      if (wait) { res.notReady.push({ airport: airport.iata, source: adapter.info.id, reason: `${due.slot}: waiting ${wait} min after a failed attempt` }); continue; }
      res.due++;
      let failed = false;
      for (const targetDate of due.targetDates)
        for (const direction of ['arrival', 'departure'] as Direction[]) {
          if (ctx.signal?.aborted) return res;
          if (failed) continue;   // one failure ends this slot for now; it is retried later under RETRY_POLICY
          const key = runKeyOf({ airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, slot: due.slot, trigger: 'schedule' });
          const prev = await db.query<{ n: string }>(`SELECT count(*) AS n FROM fd_collection_runs WHERE run_key=$1 AND ${COUNTED_FAILURE}`, [key]);
          if (Number(prev[0].n) >= RETRY_POLICY.maxSlotAttempts) continue;   // given up on this run: visible as failed in the dashboard
          const r = await collect(db, { airport, adapter, direction, targetDate, slot: due.slot, trigger: 'schedule' }, ctx);
          res.runs.push(r);
          if (r.status === 'failed') {
            failed = true;
            if (/HTTP (401|403|429)/.test(r.error ?? '')) brokenSources.add(adapter.info.id);
            if (isOffline(r.error)) offline = true;
          }
        }
      if (brokenSources.has(adapter.info.id) || offline) break;
    }
  }
  return res;
}

/** The next slot instant after `now` for an airport (for status displays). */
export function nextSlot(airport: AirportInfo, slots: SlotSpec[], now: Date): Date | null {
  const today = localDate(now, airport.tz);
  const cands = [today, addDays(today, 1)].flatMap((d) => slots.map((s) => zonedInstant(d, s.at, airport.tz))).filter((t) => t > now);
  return cands.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

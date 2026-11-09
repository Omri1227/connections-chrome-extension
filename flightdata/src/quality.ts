// Completeness and anomaly checks for one collection run, judged against the same source's own history rather than
// fixed universal thresholds. A low count is labelled with the evidence that separates an operational disruption
// (many cancellations, the other direction also low, all windows answered) from a collection failure (empty or failed
// windows, parse rejections, missing hours that are normally busy).
import type { Db } from './db.ts';
import { localParts } from './time.ts';
import type { AirportInfo, NormalizedFlight, WindowResult } from './types.ts';

export type RunStatus = 'success' | 'partial' | 'suspect' | 'failed';

export interface Baseline { runs: number; median: number; mad: number; hourMedians: number[] }

export interface Verdict {
  status: RunStatus;
  reasons: string[];
  evidence: Record<string, unknown>;
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Minimum earlier comparable runs before a count can be judged. */
export const MIN_BASELINE_RUNS = 5;

/**
 * History of comparable earlier runs: same airport, source, direction and slot time of day, target date at the same
 * offset from the slot date, finished as success or suspect, within the last `days` days.
 */
export async function baseline(db: Db, q: { airport: string; sourceId: string; direction: string; slotTime: string; dayOffset: number; before: Date; tz: string; days?: number }): Promise<Baseline> {
  const runs = await db.query<{ id: string; flights_seen: number; hours: number[] | null }>(
    `SELECT id, flights_seen, diagnostics->'hours' AS hours FROM fd_collection_runs
     WHERE airport=$1 AND source_id=$2 AND direction=$3 AND status IN ('success','suspect') AND trigger IN ('schedule','backfill')
       AND slot LIKE $4 AND (target_date - substr(slot,1,10)::date) = $5 AND started_at < $6 AND started_at > $6::timestamptz - make_interval(days => $7)
     ORDER BY started_at DESC LIMIT 28`,
    [q.airport, q.sourceId, q.direction, `% ${q.slotTime}`, q.dayOffset, q.before.toISOString(), q.days ?? 35]);
  const counts = runs.map((r) => r.flights_seen);
  const m = median(counts);
  // Each run stores its own local-hour histogram (diagnostics.hours), so the baseline survives licence-driven purges.
  const hourMedians = new Array(24).fill(0);
  const hist = runs.map((r) => r.hours).filter((h): h is number[] => Array.isArray(h) && h.length === 24);
  if (hist.length) for (let h = 0; h < 24; h++) hourMedians[h] = median(hist.map((x) => x[h]));
  return { runs: runs.length, median: m, mad: median(counts.map((c) => Math.abs(c - m))), hourMedians };
}

/** Flights per local hour of scheduled time. */
export function hourHistogram(records: { scheduledUtc: string }[], tz: string): number[] {
  const hours = new Array(24).fill(0);
  for (const r of records) hours[localParts(new Date(r.scheduledUtc), tz).hour]++;
  return hours;
}

export interface RunFacts {
  windows: WindowResult[];
  records: NormalizedFlight[];      // after validation and de-duplication
  rejected: number;
  rawRows: number;
  tz: string;
  otherDirectionRatio?: number | null; // the other direction's count / its own median in this slot, when known
}

export function judge(f: RunFacts, b: Baseline): Verdict {
  const reasons: string[] = [];
  const evidence: Record<string, unknown> = {};
  const failed = f.windows.filter((w) => !w.ok);
  const empty = f.windows.filter((w) => w.ok && w.rawCount === 0);
  evidence.windows = { expected: f.windows.length, failed: failed.map((w) => `${w.window.label}: ${w.error}`), empty: empty.map((w) => w.window.label) };
  if (!f.windows.length || failed.length === f.windows.length) return { status: 'failed', reasons: ['no window could be fetched'], evidence };
  if (failed.length) reasons.push(`${failed.length} of ${f.windows.length} windows failed`);
  // An empty answer is never accepted as "no flights" by itself: it is suspicious unless history says that window is quiet.
  for (const w of empty) {
    let usual = 0;
    for (let t = Date.parse(w.window.fromUtc); t < Date.parse(w.window.toUtc); t += 36e5) usual += b.hourMedians[localParts(new Date(t), f.tz).hour];
    if (b.runs >= MIN_BASELINE_RUNS && usual < 1) continue; // history shows this window is normally empty
    reasons.push(`window ${w.window.label} returned no flights${b.runs >= MIN_BASELINE_RUNS ? ` (usually ≈ ${Math.round(usual)})` : ''}`);
  }

  const n = f.records.length;
  evidence.count = n;
  evidence.baseline = { runs: b.runs, median: b.median, mad: b.mad };
  const rejectShare = f.rawRows ? f.rejected / f.rawRows : 0;
  evidence.rejectShare = Number(rejectShare.toFixed(3));
  if (rejectShare > 0.05) reasons.push(`${(rejectShare * 100).toFixed(1)} % of rows rejected by validation (possible format change)`);

  const cancelled = f.records.filter((r) => r.status === 'cancelled').length;
  evidence.cancelledShare = n ? Number((cancelled / n).toFixed(3)) : 0;

  if (b.runs >= MIN_BASELINE_RUNS) {
    // Robust low-count test: well below the source's own median, by a margin that scales with its usual variation.
    const spread = Math.max(1.4826 * b.mad, 0.1 * b.median);
    const low = n < b.median - 3 * spread;
    evidence.countRatio = b.median ? Number((n / b.median).toFixed(3)) : null;
    if (low) {
      const opsSignals = [(cancelled / Math.max(n, 1)) > 0.15, (f.otherDirectionRatio ?? 1) < 0.8, failed.length === 0 && empty.length === 0];
      evidence.lowCountInterpretation = opsSignals[0] && opsSignals[2] ? 'operational disruption more likely (many cancellations, all windows answered)'
        : !opsSignals[2] ? 'collection failure more likely (failed or empty windows)' : 'undetermined';
      reasons.push(`flight count ${n} is far below the usual ${b.median} (± ${spread.toFixed(0)})`);
    }
    // Hours that normally have flights but none now.
    const hours = new Array(24).fill(0);
    for (const r of f.records) hours[localParts(new Date(r.scheduledUtc), f.tz).hour]++;
    const gaps = hours.map((c, h) => (c === 0 && b.hourMedians[h] >= 3 ? h : -1)).filter((h) => h >= 0);
    if (gaps.length) { evidence.emptyBusyHours = gaps; reasons.push(`no flights in normally busy local hours ${gaps.join(', ')}`); }
  } else {
    evidence.baselineNote = `fewer than ${MIN_BASELINE_RUNS} comparable earlier runs: the count cannot be judged yet`;
  }

  const status: RunStatus = failed.length ? 'partial' : reasons.length ? 'suspect' : 'success';
  return { status, reasons, evidence };
}

export type GateConflictKind = 'probable-duplicate-operator' | 'shared-boarding-area' | 'unexplained';
export interface GateConflict { kind: GateConflictKind; scheduledUtc: string; gate: string; flights: string[]; others: (string | null)[] }

/**
 * Movements that share a scheduled instant and a gate. Codeshare listings linked to their operator are one movement
 * and never count here. What is left is classified, not corrected:
 * - probable-duplicate-operator: every movement goes to the same other airport on the same aircraft model, i.e. a
 *   codeshare the source flagged as an operator (AMS 2026-10-31 10:40 F4: KL209, CI74, UX3001 → TPE, A350-900);
 * - shared-boarding-area: the gate is a known shared designation (airport.sharedGates, e.g. AMS D6 bus gates);
 * - unexplained: anything else (a possible source error, or a gate shared in a way we have no evidence for).
 */
export function gateConflicts(records: NormalizedFlight[], airport: AirportInfo): GateConflict[] {
  const movements = new Map<string, NormalizedFlight>();
  for (const r of records) {
    if (!r.gate || r.status === 'cancelled') continue;
    const key = r.role === 'marketing' && r.operatingFlightNumber ? r.operatingFlightNumber : r.flightNumber;
    // Unlinked codeshare listings are not movements of their own: they are reported as unlinked elsewhere.
    if (r.role === 'marketing' && !r.operatingFlightNumber) continue;
    if (!movements.has(`${key}|${r.scheduledUtc}`) || r.role === 'operating') movements.set(`${key}|${r.scheduledUtc}`, r);
  }
  const groups = new Map<string, NormalizedFlight[]>();
  for (const r of movements.values()) { const k = `${r.scheduledUtc}|${r.gate}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const out: GateConflict[] = [];
  for (const xs of groups.values()) {
    if (xs.length < 2) continue;
    const other = (r: NormalizedFlight) => (r.direction === 'arrival' ? r.origin : r.destination);
    const sameTrip = new Set(xs.map(other)).size === 1 && other(xs[0]) !== null && new Set(xs.map((r) => r.aircraftType)).size === 1 && xs[0].aircraftType !== null;
    const kind: GateConflictKind = sameTrip ? 'probable-duplicate-operator' : airport.sharedGates?.[xs[0].gate!] ? 'shared-boarding-area' : 'unexplained';
    out.push({ kind, scheduledUtc: xs[0].scheduledUtc, gate: xs[0].gate!, flights: xs.map((r) => r.flightNumber).sort(), others: xs.map(other) });
  }
  return out.sort((a, b) => a.scheduledUtc.localeCompare(b.scheduledUtc) || a.gate.localeCompare(b.gate));
}

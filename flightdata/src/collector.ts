// One collection run: airport × source × direction × target local date. Fetch every window, validate, de-duplicate,
// store atomically, judge completeness, record findings and a summary. Never throws for source problems: they end up
// in the run row (status, error, warnings) so a failed run is visible, not silent.
import type { Db } from './db.ts';
import { dedupe, validate } from './normalize.ts';
import { baseline, gateConflicts, hourHistogram, judge, type RunStatus } from './quality.ts';
import { addFinding, finishRun, markDuplicates, reconcileSuperseded, startRun, storeRecords, type RunKey } from './store.ts';
import { localDate } from './time.ts';
import type { AirportInfo, Direction, FetchContext, NormalizedFlight, SourceAdapter, WindowResult } from './types.ts';

export interface CollectRequest {
  airport: AirportInfo;
  adapter: SourceAdapter;
  direction: Direction;
  targetDate: string;
  slot: string;                   // "YYYY-MM-DD HH:MM" local, or "manual:<iso>"
  trigger: RunKey['trigger'];
  keepRawSamples?: boolean;
}

export interface RunSummary {
  runId: number | null;
  key: string;
  status: RunStatus | 'skipped';
  flights: number;
  withTerminal: number;
  withGate: number;
  observationsNew: number;
  observationsUnchanged: number;
  rejected: number;
  reasons: string[];
  error: string | null;
}

export async function collect(db: Db, req: CollectRequest, ctx: FetchContext): Promise<RunSummary> {
  const { airport, adapter, direction, targetDate, slot, trigger } = req;
  const key: RunKey = { airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, slot, trigger };
  const label = `${airport.iata} ${adapter.info.id} ${direction} ${targetDate} @${slot}`;
  const base: RunSummary = { runId: null, key: label, status: 'skipped', flights: 0, withTerminal: 0, withGate: 0, observationsNew: 0, observationsUnchanged: 0, rejected: 0, reasons: [], error: null };
  const runId = await startRun(db, key, ctx.now());
  if (runId === null) return { ...base, reasons: ['slot already collected or running'] };
  ctx.log('run.start', { runId, run: label });

  try {
    const windows = adapter.windows(airport, direction, targetDate);
    const results: WindowResult[] = [];
    for (const w of windows) {
      if (ctx.signal?.aborted) break;
      const r = await adapter.fetchWindow(airport, w, ctx);
      results.push(r);
      ctx.log('run.window', { runId, window: w.label, ok: r.ok, http: r.httpStatus, rows: r.rawCount, kept: r.records.length, error: r.error });
      if (req.keepRawSamples !== false && (r.rawSample !== undefined || !r.ok))
        await db.query('INSERT INTO fd_raw_samples (run_id, window_label, http_status, bytes, sample) VALUES ($1,$2,$3,$4,$5)', [runId, w.label, r.httpStatus, r.bytes, JSON.stringify(r.rawSample ?? { error: r.error })]);
      // Circuit breaker: a window that still fails after its own retries means the source is down or refusing us;
      // the remaining windows are not requested (they would fail the same way and, on paid APIs, may cost units).
      if (!r.ok) { ctx.log('run.stop', { runId, after: w.label, skipped: windows.length - results.length }); break; }
    }

    // Validate; keep only records scheduled on the target local date (windows may overlap a day boundary).
    let rejected = 0;
    const kept: NormalizedFlight[] = [];
    const issues = results.flatMap((r) => r.issues);
    for (const r of results.flatMap((x) => x.records)) {
      const v = validate(r, airport);
      issues.push(...v.issues);
      if (!v.ok) { rejected++; continue; }
      kept.push(r);
    }
    const onDay = kept.filter((r) => localDate(new Date(r.scheduledUtc), airport.tz) === targetDate);
    const { records, duplicates } = dedupe(onDay);
    rejected += results.reduce((s, r) => s + r.issues.filter((i) => i.kind === 'rejected-row').length, 0);
    const rawRows = results.reduce((s, r) => s + r.rawCount, 0);

    const okWindows = results.filter((r) => r.ok);
    // Nothing stored from a run where every window failed: no partial "zero flights" day is written.
    const stats = okWindows.length ? await storeRecords(db, runId, adapter.info, airport, records, ctx.now())
      : { flightsSeen: 0, flightsNew: 0, observationsNew: 0, observationsUnchanged: 0, withTerminal: 0, withGate: 0 };
    // Flight-days an earlier snapshot stored separately but a later one links as a codeshare of another movement.
    const superseded = okWindows.length ? await reconcileSuperseded(db, { airport: airport.iata, direction, dates: [targetDate] }) : [];
    // Flight-days that are the same movement as another one (verified codeshare or same aircraft): marked, not deleted.
    const duplicates_ = okWindows.length ? await markDuplicates(db, { airport: airport.iata, direction, dates: [targetDate] }) : [];

    const slotTime = slot.startsWith('manual') ? '' : slot.slice(11);
    const dayOffset = slot.startsWith('manual') ? 0 : Math.round((Date.parse(targetDate) - Date.parse(slot.slice(0, 10))) / 864e5);
    const b = slotTime ? await baseline(db, { airport: airport.iata, sourceId: adapter.info.id, direction, slotTime, dayOffset, before: ctx.now(), tz: airport.tz })
      : { runs: 0, median: 0, mad: 0, hourMedians: new Array(24).fill(0) };
    const verdict = judge({ windows: results, records, rejected, rawRows, tz: airport.tz }, b);

    // Findings: one per kind with examples, not one per row (keeps the table small).
    const byKind = new Map<string, typeof issues>();
    for (const i of issues) byKind.set(`${i.kind}:${i.detail.replace(/".*?"|\(.*?\)/g, '…')}`, [...(byKind.get(`${i.kind}:${i.detail.replace(/".*?"|\(.*?\)/g, '…')}`) ?? []), i]);
    for (const [k, xs] of byKind) await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: xs[0].kind, severity: xs[0].kind === 'rejected-row' || xs[0].kind === 'format-change' ? 'warning' : 'info', detail: { pattern: k, count: xs.length, examples: xs.slice(0, 5).map((x) => x.sample ?? x.detail) } });
    if (superseded.length) await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: 'superseded-listing', severity: 'info', detail: { count: superseded.length, examples: superseded.slice(0, 10).map((x) => `${x.flightKey} → ${x.by}`) } });
    for (const reason of ['verified-codeshare', 'same-aircraft'] as const) {
      const xs = duplicates_.filter((d) => d.reason === reason);
      if (xs.length) await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: 'duplicate-flight-day', severity: 'info', detail: { pattern: reason, count: xs.length, examples: xs.slice(0, 10).map((x) => `${x.flightKey} = ${x.of}`) } });
    }
    const conflicts = gateConflicts(records, airport);
    for (const kind of ['probable-duplicate-operator', 'shared-boarding-area', 'unexplained'] as const) {
      const xs = conflicts.filter((c) => c.kind === kind);
      if (xs.length) await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: 'gate-time-conflict', severity: kind === 'shared-boarding-area' ? 'info' : 'warning', detail: { pattern: kind, count: xs.length, examples: xs.slice(0, 5) } });
    }
    if (duplicates) await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: 'duplicate-rows', severity: 'info', detail: { count: duplicates } });
    if (verdict.status !== 'success') await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: `run-${verdict.status}`, severity: verdict.status === 'failed' ? 'error' : 'warning', detail: { reasons: verdict.reasons, evidence: verdict.evidence } });

    await finishRun(db, runId, {
      finished_at: ctx.now().toISOString(), status: verdict.status,
      windows_expected: windows.length, windows_ok: okWindows.length,
      pages_fetched: results.reduce((s, r) => s + r.pages, 0), bytes_fetched: results.reduce((s, r) => s + r.bytes, 0),
      rows_raw: rawRows, rows_normalised: records.length, rows_rejected: rejected,
      flights_seen: stats.flightsSeen, flights_new: stats.flightsNew, observations_new: stats.observationsNew, observations_unchanged: stats.observationsUnchanged,
      with_terminal: stats.withTerminal, with_gate: stats.withGate,
      completeness: { status: verdict.status, reasons: verdict.reasons, evidence: verdict.evidence, duplicates },
      warnings: verdict.reasons, error: verdict.status === 'failed' ? results.map((r) => r.error).filter(Boolean).join('; ') || 'failed' : null,
      diagnostics: { hours: hourHistogram(records, airport.tz), windows: results.map((r) => ({ label: r.window.label, ok: r.ok, http: r.httpStatus, pages: r.pages, rows: r.rawCount, kept: r.records.length, bytes: r.bytes, error: r.error })) },
    });
    ctx.log('run.end', { runId, run: label, status: verdict.status, flights: stats.flightsSeen, terminal: stats.withTerminal, gate: stats.withGate, reasons: verdict.reasons });
    const windowErrors = results.map((r) => r.error).filter(Boolean).join('; ') || null;
    return { ...base, runId, status: verdict.status, flights: stats.flightsSeen, withTerminal: stats.withTerminal, withGate: stats.withGate, observationsNew: stats.observationsNew, observationsUnchanged: stats.observationsUnchanged, rejected, reasons: verdict.reasons, error: verdict.status === 'failed' ? windowErrors ?? 'failed' : null };
  } catch (e) {
    // Storage or programming error: the store transaction rolled back, so no partial data; the run is marked failed.
    const msg = (e as Error).message;
    await finishRun(db, runId, { finished_at: ctx.now().toISOString(), status: 'failed', error: msg.slice(0, 2000) });
    await addFinding(db, { runId, airport: airport.iata, sourceId: adapter.info.id, direction, targetDate, kind: 'run-failed', severity: 'error', detail: { error: msg } });
    ctx.log('run.error', { runId, run: label, error: msg });
    return { ...base, runId, status: 'failed', error: msg };
  }
}


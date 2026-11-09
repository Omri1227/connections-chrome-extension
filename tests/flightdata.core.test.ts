// Flight-data platform: time zones, normalisation, storage history, idempotency, codeshares, coverage and failures.
// No live sources: everything runs against in-memory PostgreSQL (PGlite) and scripted fixture adapters.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { localDate, zonedInstant, parseSourceTime, offsetMinutes } from '../flightdata/src/time.ts';
import { normFlightNumber, normStatus, normTerminal, validate, dedupe } from '../flightdata/src/normalize.ts';
import { fixtureAdapter, rec, dayWindows } from '../flightdata/src/adapters/fixture.ts';
import { collect } from '../flightdata/src/collector.ts';
import { upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { dueSlots, tick, DEFAULT_SLOTS } from '../flightdata/src/scheduler.ts';
import { judge } from '../flightdata/src/quality.ts';
import { predict, completeness, distribution, wilsonLower } from '../flightdata/src/analysis.ts';
import { politeGet } from '../flightdata/src/http.ts';
import type { FetchContext, NormalizedFlight } from '../flightdata/src/types.ts';

const CDG = AIRPORTS.CDG;
const ctxAt = (iso: string): FetchContext => ({ fetch: (() => { throw new Error('no network in tests'); }) as any, now: () => new Date(iso), env: {}, log: () => {} });

describe('time zones and daylight saving', () => {
  it('resolves local times on both sides of the Paris transitions', () => {
    expect(zonedInstant('2026-03-28', '07:00', 'Europe/Paris').toISOString()).toBe('2026-03-28T06:00:00.000Z'); // CET
    expect(zonedInstant('2026-03-29', '07:00', 'Europe/Paris').toISOString()).toBe('2026-03-29T05:00:00.000Z'); // CEST
    expect(zonedInstant('2026-10-25', '23:30', 'Europe/Paris').toISOString()).toBe('2026-10-25T22:30:00.000Z'); // back to CET
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(60);
  });
  it('maps a non-existent spring time forward and an ambiguous autumn time to its first occurrence', () => {
    expect(zonedInstant('2026-03-29', '02:30', 'Europe/Paris').toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(zonedInstant('2026-10-25', '02:30', 'Europe/Paris').toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('computes local dates across midnight in each zone', () => {
    expect(localDate(new Date('2026-10-29T23:30:00Z'), 'Europe/Paris')).toBe('2026-10-30');
    expect(localDate(new Date('2026-10-29T23:30:00Z'), 'Europe/London')).toBe('2026-10-29');
  });
  it('parses source times with offsets, in UTC, and as zone-local wall clock', () => {
    expect(parseSourceTime('2026-10-30T07:05:00+01:00', 'Europe/Paris')!.toISOString()).toBe('2026-10-30T06:05:00.000Z');
    expect(parseSourceTime('2026-10-30 06:05Z', 'Europe/Paris')!.toISOString()).toBe('2026-10-30T06:05:00.000Z');
    expect(parseSourceTime('2026-10-30 07:05', 'Europe/Paris')!.toISOString()).toBe('2026-10-30T06:05:00.000Z');
    expect(parseSourceTime('2026-10-30 07:05+0100', 'Europe/Paris')!.toISOString()).toBe('2026-10-30T06:05:00.000Z');
    expect(parseSourceTime('', 'Europe/Paris')).toBeNull();
    expect(parseSourceTime('soon', 'Europe/Paris')).toBeNull();
  });
  it('splits a 23-hour and a 25-hour day into windows that cover exactly the local day', () => {
    const spring = dayWindows(CDG, 'arrival', '2026-03-29', 12), autumn = dayWindows(CDG, 'arrival', '2026-10-25', 12);
    const span = (ws: typeof spring) => (Date.parse(ws.at(-1)!.toUtc) - Date.parse(ws[0].fromUtc)) / 36e5;
    expect(span(spring)).toBe(23);
    expect(span(autumn)).toBe(25);
    expect(autumn).toHaveLength(3);
  });
  it('schedules slots at local airport time through DST changes', () => {
    const s = dueSlots(CDG, DEFAULT_SLOTS, new Date('2026-03-29T05:10:00Z'));
    expect(s.map((x) => x.slot)).toEqual(['2026-03-29 07:00']);
    expect(s[0].targetDates).toEqual(['2026-03-29', '2026-03-28']);
    // 23:30 Paris on 2026-10-25 (CET) is 22:30 UTC; at 22:00 UTC it is not due yet.
    expect(dueSlots(CDG, DEFAULT_SLOTS, new Date('2026-10-25T22:00:00Z')).map((x) => x.slot)).not.toContain('2026-10-25 23:30');
    expect(dueSlots(CDG, DEFAULT_SLOTS, new Date('2026-10-25T22:31:00Z')).map((x) => x.slot)).toContain('2026-10-25 23:30');
    // A source without past days never asks for yesterday.
    expect(dueSlots(CDG, DEFAULT_SLOTS, new Date('2026-03-29T05:10:00Z'), 6, 0)[0].targetDates).toEqual(['2026-03-29']);
  });
});

describe('normalisation and validation', () => {
  it('normalises flight numbers, terminals and statuses', () => {
    expect(normFlightNumber('AF 0012')).toEqual({ number: 'AF12', carrier: 'AF' });
    expect(normFlightNumber('u2 4801')).toEqual({ number: 'U24801', carrier: 'U2' });
    expect(normFlightNumber('AFR123')).toEqual({ number: 'AFR123', carrier: 'AFR' });
    expect(normFlightNumber('1234')).toBeNull();
    expect(normTerminal('Terminal 2E')).toBe('2E');
    expect(normTerminal('T1')).toBe('1');
    expect(normTerminal('-')).toBeNull();
    expect(normStatus('Landed 07:12')).toBe('landed');
    expect(normStatus('Canceled')).toBe('cancelled');
    expect(normStatus('GateClosed')).toBe('gate-closed');
    expect(normStatus('Expected')).toBe('scheduled');
    expect(normStatus('Wibble')).toBe('unknown');
  });
  it('rejects records for the wrong airport or direction, keeps but reports unknown terminals and gate formats', () => {
    const wrong = validate(rec({ flightNumber: 'AF1', scheduledUtc: '2026-10-30T08:00:00Z', direction: 'departure', origin: 'ORY' }), CDG);
    expect(wrong.ok).toBe(false);
    const odd = validate(rec({ flightNumber: 'AF1', scheduledUtc: '2026-10-30T08:00:00Z', terminal: '2H', gate: 'Z99Z9' }), CDG);
    expect(odd.ok).toBe(true);
    expect(odd.issues.map((i) => i.kind)).toEqual(['unexpected-value', 'unexpected-value']);
  });
  it('drops exact duplicate rows, keeping the most informative', () => {
    const a = rec({ flightNumber: 'AF1', scheduledUtc: '2026-10-30T08:00:00Z' });
    const b = { ...a, gate: 'K31', terminal: '2E' };
    const d = dedupe([a, b]);
    expect(d.duplicates).toBe(1);
    expect(d.records[0].gate).toBe('K31');
  });
});

describe('storage, history and idempotency', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(':memory:'); await upsertAirport(db, CDG, true); });
  afterEach(async () => { await db.close(); });

  async function run(records: NormalizedFlight[], slot: string, nowIso: string, adapterOver = {}) {
    const ad = fixtureAdapter(() => ({ ok: true, records }), adapterOver);
    await upsertSource(db, ad.info);
    return collect(db, { airport: CDG, adapter: ad, direction: 'departure', targetDate: '2026-10-30', slot, trigger: 'schedule' }, ctxAt(nowIso));
  }
  const xx = (gate: string | null, status: NormalizedFlight['status'] = 'scheduled', extra: Partial<NormalizedFlight> = {}) =>
    rec({ flightNumber: 'XX123', carrier: 'XX', scheduledUtc: '2026-10-30T20:00:00Z', terminal: '2E', gate, status, role: 'operating', ...extra });

  it('keeps every gate change with its observation time (K31 → K42 → K42 last reported)', async () => {
    await run([xx('K31')], '2026-10-30 07:00', '2026-10-30T07:00:00Z');
    await run([xx('K42')], '2026-10-30 15:00', '2026-10-30T14:00:00Z');
    await run([xx('K42', 'departed', { actualUtc: '2026-10-30T20:10:00Z' })], '2026-10-30 23:30', '2026-10-30T22:30:00Z');
    const obs = await db.query('SELECT gate, stage, first_seen_at, last_seen_at, seen_count FROM fd_observations ORDER BY first_seen_at');
    expect(obs.map((o) => o.gate)).toEqual(['K31', 'K42', 'K42']);
    expect(obs.map((o) => o.stage)).toEqual(['pre-movement', 'pre-movement', 'post-movement']);
    const hist = await db.query('SELECT gate_changed FROM fd_assignment_history ORDER BY first_seen_at');
    expect(hist.map((h) => h.gate_changed)).toEqual([false, true, false]);
    expect((await db.query('SELECT count(*)::int n FROM fd_sightings'))[0].n).toBe(3);
  });

  it('deduplicates identical snapshots but records each run in sightings', async () => {
    await run([xx('K31')], '2026-10-30 07:00', '2026-10-30T07:00:00Z');
    await run([xx('K31')], '2026-10-30 15:00', '2026-10-30T14:00:00Z');
    const obs = await db.query('SELECT seen_count, first_seen_at, last_seen_at FROM fd_observations');
    expect(obs).toHaveLength(1);
    expect(obs[0].seen_count).toBe(2);
    expect(new Date(obs[0].last_seen_at).toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect((await db.query('SELECT count(*)::int n FROM fd_sightings'))[0].n).toBe(2);
  });

  it('an identical rerun of the same slot is skipped (idempotent), a failed slot can be retried', async () => {
    const first = await run([xx('K31')], '2026-10-30 07:00', '2026-10-30T07:00:00Z');
    const again = await run([xx('K31')], '2026-10-30 07:00', '2026-10-30T07:05:00Z');
    expect(first.status).not.toBe('skipped');
    expect(again.status).toBe('skipped');
    const failing = fixtureAdapter(() => ({ ok: false, status: 503, error: 'HTTP 503' }), { id: 'flaky' });
    await upsertSource(db, failing.info);
    const f1 = await collect(db, { airport: CDG, adapter: failing, direction: 'departure', targetDate: '2026-10-30', slot: '2026-10-30 07:00', trigger: 'schedule' }, ctxAt('2026-10-30T07:00:00Z'));
    expect(f1.status).toBe('failed');
    const ok = fixtureAdapter(() => ({ ok: true, records: [xx('K31')] }), { id: 'flaky' });
    const f2 = await collect(db, { airport: CDG, adapter: ok, direction: 'departure', targetDate: '2026-10-30', slot: '2026-10-30 07:00', trigger: 'schedule' }, ctxAt('2026-10-30T07:20:00Z'));
    // Retried: a new run collected the flight ('suspect' only because the morning window had no flights).
    expect(f2.runId).not.toBeNull();
    expect(f2.flights).toBe(1);
  });

  it('stores codeshare listings as one physical movement when the source links them, and never merges unlinked listings', async () => {
    const op = xx('K31', 'scheduled', { codeshares: ['DL8410'] });
    const mk = rec({ flightNumber: 'KL2009', carrier: 'KL', scheduledUtc: '2026-10-30T20:00:00Z', terminal: '2E', gate: 'K31', role: 'marketing', operatingFlightNumber: 'XX123' });
    const unlinked = rec({ flightNumber: 'AZ3311', carrier: 'AZ', scheduledUtc: '2026-10-30T20:00:00Z', terminal: '2E', gate: 'K31' });
    await run([mk, op, unlinked], '2026-10-30 07:00', '2026-10-30T07:00:00Z');
    const flights = await db.query('SELECT flight_key, identity FROM fd_flights ORDER BY flight_key');
    expect(flights).toEqual([{ flight_key: 'AZ3311', identity: 'listed' }, { flight_key: 'XX123', identity: 'operating' }]);
    const codes = await db.query("SELECT code FROM fd_flight_codes c JOIN fd_flights f ON f.id=c.flight_id WHERE f.flight_key='XX123' ORDER BY code");
    expect(codes.map((c) => c.code)).toEqual(['DL8410', 'KL2009', 'XX123']);
    const obs = await db.query('SELECT listed_as FROM fd_observations o JOIN fd_flights f ON f.id=o.flight_id WHERE f.flight_key=$1', ['XX123']);
    expect(obs.map((o) => o.listed_as)).toEqual(['XX123']);
  });

  it('keeps two movements with the same number on one date apart (legs)', async () => {
    await run([xx('K31'), rec({ flightNumber: 'XX123', carrier: 'XX', scheduledUtc: '2026-10-30T07:00:00Z', terminal: '2E', gate: 'K10', role: 'operating' })], '2026-10-30 07:00', '2026-10-30T06:00:00Z');
    expect((await db.query('SELECT leg FROM fd_flights ORDER BY scheduled_utc')).map((r) => r.leg)).toEqual([1, 2]);
  });

  it('never stores anything from a run whose windows all failed, and records why', async () => {
    const ad = fixtureAdapter(() => ({ ok: false, status: null, error: 'timeout after 30000 ms' }));
    await upsertSource(db, ad.info);
    const r = await collect(db, { airport: CDG, adapter: ad, direction: 'arrival', targetDate: '2026-10-30', slot: '2026-10-30 07:00', trigger: 'schedule' }, ctxAt('2026-10-30T07:00:00Z'));
    expect(r.status).toBe('failed');
    expect((await db.query('SELECT count(*)::int n FROM fd_flights'))[0].n).toBe(0);
    const run1 = (await db.query('SELECT status, error, windows_ok, windows_expected FROM fd_collection_runs'))[0];
    expect(run1).toMatchObject({ status: 'failed', windows_ok: 0, windows_expected: 2 });
    expect(run1.error).toMatch(/timeout/);
  });

  it('a partial run (one window failed) is marked partial and keeps what it got', async () => {
    const ad = fixtureAdapter((w) => (w.label.endsWith('#2') ? { ok: false, status: 500, error: 'HTTP 500' } : { ok: true, records: [xx('K1', 'scheduled', { scheduledUtc: '2026-10-30T08:00:00Z' })] }));
    await upsertSource(db, ad.info);
    const r = await collect(db, { airport: CDG, adapter: ad, direction: 'departure', targetDate: '2026-10-30', slot: '2026-10-30 07:00', trigger: 'schedule' }, ctxAt('2026-10-30T07:00:00Z'));
    expect(r.status).toBe('partial');
    expect(r.flights).toBe(1);
  });

  it('an empty answer is not accepted as a valid day with zero flights', async () => {
    const r = await run([], '2026-10-30 07:00', '2026-10-30T07:00:00Z');
    expect(r.status).toBe('suspect');
    expect(r.reasons.join(' ')).toMatch(/returned no flights/);
  });

  it('a storage error rolls back the whole run and marks it failed', async () => {
    const bad = rec({ flightNumber: 'XX9', scheduledUtc: '2026-10-30T09:00:00Z', terminal: '2E' });
    (bad as any).role = 'bogus'; // violates a CHECK constraint after a good row was written: forces a rollback
    const r = await run([xx('K31'), bad], '2026-10-30 07:00', '2026-10-30T07:00:00Z');
    expect(r.status).toBe('failed');
    expect((await db.query('SELECT count(*)::int n FROM fd_observations'))[0].n).toBe(0);
  });

  it('the scheduler tick collects due slots once, both directions, today and yesterday at 07:00', async () => {
    const ad = fixtureAdapter((w) => ({ ok: true, records: [rec({ flightNumber: 'AF1', direction: w.direction, scheduledUtc: new Date(Date.parse(w.fromUtc) + 36e5).toISOString(), terminal: '2E' })] }));
    await upsertSource(db, ad.info);
    const t1 = await tick(db, [{ airport: CDG, adapter: ad }], ctxAt('2026-10-30T06:05:00Z'));
    expect(t1.runs.map((r) => r.key.split(' ').slice(2, 4).join(' ')).sort()).toEqual(['arrival 2026-10-29', 'arrival 2026-10-30', 'departure 2026-10-29', 'departure 2026-10-30']);
    const t2 = await tick(db, [{ airport: CDG, adapter: ad }], ctxAt('2026-10-30T06:35:00Z'));
    expect(t2.runs.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('runs left "running" by a crashed process are reaped and their slot retried', async () => {
    await db.query(`INSERT INTO fd_sources (id,name,kind,base_url,terms_summary,permission,retention,cost_note,capabilities) VALUES ('fixture','f','fixture','x','x','test-only','x','x','{}')`);
    await db.query(`INSERT INTO fd_collection_runs (run_key, airport, source_id, direction, target_date, slot, trigger, started_at, status) VALUES ('CDG|fixture|departure|2026-10-30|2026-10-30 07:00','CDG','fixture','departure','2026-10-30','2026-10-30 07:00','schedule','2026-10-30T06:00:00Z','running')`);
    const ad = fixtureAdapter(() => ({ ok: true, records: [xx('K31')] }));
    const t = await tick(db, [{ airport: CDG, adapter: ad }], ctxAt('2026-10-30T08:30:00Z'));
    expect(t.reaped).toBe(1);
    const retried = t.runs.find((r) => r.key.includes('departure 2026-10-30'))!;
    expect(retried.runId).not.toBeNull();
    expect(retried.flights).toBe(1);
  });
});

describe('completeness judgement against history', () => {
  const win = (ok: boolean, rawCount = 10) => ({ window: { direction: 'arrival' as const, localDate: '2026-10-30', fromUtc: '2026-10-29T23:00:00Z', toUtc: '2026-10-30T11:00:00Z', label: 'w1' }, ok, httpStatus: ok ? 200 : 500, pages: 1, rawCount, records: [], issues: [], error: ok ? null : 'HTTP 500', bytes: 1 });
  const recs = (n: number, cancelled = 0) => Array.from({ length: n }, (_, i) => rec({ flightNumber: `AF${i + 1}`, scheduledUtc: '2026-10-30T08:00:00Z', status: i < cancelled ? 'cancelled' : 'scheduled' }));
  const hist = { runs: 10, median: 600, mad: 20, hourMedians: new Array(24).fill(0) };

  it('flags a collapse from hundreds of flights to 12 as suspect, not success', () => {
    const v = judge({ windows: [win(true)], records: recs(12), rejected: 0, rawRows: 12, tz: 'Europe/Paris' }, hist);
    expect(v.status).toBe('suspect');
    expect(v.reasons.join()).toMatch(/far below the usual 600/);
  });
  it('labels a low count with many cancellations as a likely disruption', () => {
    const v = judge({ windows: [win(true)], records: recs(300, 120), rejected: 0, rawRows: 300, tz: 'Europe/Paris' }, hist);
    expect(v.evidence.lowCountInterpretation).toMatch(/operational disruption/);
  });
  it('cannot judge counts without enough history, and says so', () => {
    const v = judge({ windows: [win(true)], records: recs(12), rejected: 0, rawRows: 12, tz: 'Europe/Paris' }, { runs: 2, median: 600, mad: 0, hourMedians: [] });
    expect(v.status).toBe('success');
    expect(String(v.evidence.baselineNote)).toMatch(/cannot be judged/);
  });
  it('treats a high validation-reject share as a possible format change', () => {
    const v = judge({ windows: [win(true)], records: recs(590), rejected: 60, rawRows: 650, tz: 'Europe/Paris' }, hist);
    expect(v.reasons.join()).toMatch(/possible format change/);
  });
});

describe('statistics and the prediction boundary', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(':memory:'); await upsertAirport(db, CDG, true); });
  afterEach(async () => { await db.close(); });

  async function day(date: string, terminal: string, gate: string, flight = 'AF1234') {
    const ad = fixtureAdapter(() => ({ ok: true, records: [rec({ flightNumber: flight, carrier: 'AF', scheduledUtc: `${date}T10:00:00Z`, terminal, gate, role: 'operating', destination: 'TLV', codeshares: ['DL1'] })] }));
    await upsertSource(db, ad.info);
    await collect(db, { airport: CDG, adapter: ad, direction: 'departure', targetDate: date, slot: `${date} 07:00`, trigger: 'schedule' }, ctxAt(`${date}T06:00:00Z`));
  }

  it('offers no prediction below the minimum sample', async () => {
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) await day(d, '2E', 'K31');
    const p = await predict(db, { airport: 'CDG', flight: 'AF1234', date: '2026-10-10', direction: 'departure' });
    expect(p.historical.confidence).toBe('insufficient-sample');
    expect(p.historical.mostLikelyTerminal).toBeNull();
    expect(p.basis).toBe('none');
  });

  it('predicts from history strictly before the date, by codeshare number too, and separates current status', async () => {
    const dates = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    for (const [i, d] of dates.entries()) await day(d, i === 3 ? '2F' : '2E', i % 2 ? 'K31' : 'K33');
    const p = await predict(db, { airport: 'CDG', flight: 'DL 1', date: '2026-10-12', direction: 'departure' });
    expect(p.historical.sample).toBe(11);
    expect(p.historical.mostLikelyTerminal).toBe('2E');
    expect(p.historical.terminals[0]).toMatchObject({ value: '2E', n: 10 });
    expect(p.basis).toBe('current-flight-status');
    expect(p.current?.terminal).toBe('2E');
    expect(['medium', 'high']).toContain(p.historical.confidence);
    expect(p.historical.range).toEqual({ from: '2026-10-01', to: '2026-10-11' });
  });

  it('computes distributions and completeness per day', async () => {
    await day('2026-10-01', '2E', 'K31');
    await day('2026-10-02', '2E', 'K31');
    const d = await distribution(db, { airport: 'CDG', direction: 'departure' }, 'terminal', 'carrier');
    expect(d[0]).toMatchObject({ group: 'AF', total: 2, known: 2 });
    const c = await completeness(db, { airport: 'CDG', direction: 'departure' });
    expect(c.map((r) => [r.date, r.flights, r.with_gate])).toEqual([['2026-10-01', 1, 1], ['2026-10-02', 1, 1]]);
  });

  it('wilson lower bound behaves', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(10, 10)).toBeGreaterThan(0.69);
    expect(wilsonLower(5, 10)).toBeLessThan(0.5);
  });
});

describe('polite HTTP', () => {
  const resp = (status: number, body = '{}', headers: Record<string, string> = {}) => new Response(body, { status, headers });
  it('retries transient errors with backoff and honours Retry-After', async () => {
    const waits: number[] = [];
    const seq = [resp(503), resp(429, '', { 'retry-after': '7' }), resp(200, '{"ok":1}')];
    const r = await politeGet((async () => seq.shift()!) as any, 'https://example.test/a', { sleep: async (ms) => { waits.push(ms); }, random: () => 0.5, minSpacingMs: 0, baseDelayMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(waits.filter((w) => w > 0)).toEqual([1000, 7000]);
  });
  it('does not retry final client errors such as 403', async () => {
    let n = 0;
    const r = await politeGet((async () => { n++; return resp(403); }) as any, 'https://example.test/b', { sleep: async () => {}, minSpacingMs: 0 });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
  });
  it('times out a hanging request and gives up after the bounded retries', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
    const r = await politeGet(hang, 'https://example.test/c', { timeoutMs: 20, retries: 2, sleep: async () => {}, minSpacingMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.error).toMatch(/timeout/);
  });
});

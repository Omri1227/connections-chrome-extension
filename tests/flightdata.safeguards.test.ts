// Cost and outage safeguards (added before activating the paid AeroDataBox plan on 2026-10-31): a failing source is
// not hammered, a spent quota stops calls, and statistics keep counting after raw rows are rolled into counters.
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { fixtureAdapter, rec } from '../flightdata/src/adapters/fixture.ts';
import { upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { tick, unitsUsed, RETRY_POLICY } from '../flightdata/src/scheduler.ts';
import { distribution, summary } from '../flightdata/src/analysis.ts';
import { politeGet } from '../flightdata/src/http.ts';
import { aerodatabox } from '../flightdata/src/adapters/aerodatabox.ts';
import type { FetchContext } from '../flightdata/src/types.ts';

const CDG = AIRPORTS.CDG, FRA = AIRPORTS.FRA;
const ctxAt = (iso: string): FetchContext => ({ fetch: (() => { throw new Error('no network in tests'); }) as any, now: () => new Date(iso), env: {}, log: () => {} });

describe('outage and quota safeguards', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(':memory:'); await upsertAirport(db, CDG, true); await upsertAirport(db, FRA, true); });

  it('a 6-hour outage costs a handful of calls, not one per window per tick', async () => {
    let calls = 0;
    const down = fixtureAdapter(() => { calls++; return { ok: false, status: 503, error: 'HTTP 503' }; });
    await upsertSource(db, down.info);
    // CDG 07:00 slot = 06:00Z (CET). Ticks every 15 minutes for the whole 6-hour grace window.
    for (let m = 0; m <= 360; m += 15) await tick(db, [{ airport: CDG, adapter: down }], ctxAt(new Date(Date.parse('2026-11-02T06:00:00Z') + m * 60_000).toISOString()));
    // Before the safeguards: 25 ticks × 4 runs × 2 windows = 200 window fetches (×4 HTTP attempts each).
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(Math.ceil(360 / RETRY_POLICY.retryGapMinutes) + 1);
  });

  it('stops a run after its first failed window (the second window is not requested)', async () => {
    const asked: string[] = [];
    const down = fixtureAdapter((w) => { asked.push(w.label); return { ok: false, status: 500, error: 'HTTP 500' }; });
    await upsertSource(db, down.info);
    const t = await tick(db, [{ airport: CDG, adapter: down }], ctxAt('2026-11-02T06:05:00Z'));
    expect(asked).toEqual(['arrival:2026-11-02#1']);
    expect(t.runs).toHaveLength(1);   // the slot's other runs wait for the retry policy
  });

  it('a quota refusal (HTTP 429) stops the source for every other airport in the same tick', async () => {
    let calls = 0;
    const spent = fixtureAdapter(() => { calls++; return { ok: false, status: 429, error: 'HTTP 429' }; });
    await upsertSource(db, spent.info);
    const t = await tick(db, [{ airport: CDG, adapter: spent }, { airport: FRA, adapter: spent }], ctxAt('2026-11-02T06:05:00Z'));
    expect(calls).toBe(1);
    expect(t.notReady.some((n) => n.airport === 'FRA' && /refused/.test(n.reason))).toBe(true);
  });

  it('offline (no connection, e.g. just after waking from standby) ends the tick for every airport and is retried after 10 min, not 60', async () => {
    let calls = 0, online = false;
    const src = fixtureAdapter(() => { calls++; return online ? { ok: true, records: [] } : { ok: false, status: null, error: 'fetch failed' }; });
    await upsertSource(db, src.info);
    const both = [{ airport: CDG, adapter: src }, { airport: FRA, adapter: src }];
    const t = await tick(db, both, ctxAt('2026-11-02T06:05:00Z'));
    expect(calls).toBe(1);                                                    // FRA is not called while offline
    expect(t.notReady.some((n) => n.airport === 'FRA' && /offline/.test(n.reason))).toBe(true);
    const t2 = await tick(db, both, ctxAt('2026-11-02T06:10:00Z'));           // 5 min later: CDG waits, FRA gets its first try
    expect(calls).toBe(2);
    expect(t2.notReady.some((n) => n.airport === 'CDG' && /waiting 10 min/.test(n.reason))).toBe(true);
    online = true;
    const t3 = await tick(db, both, ctxAt('2026-11-02T06:20:00Z'));           // next tick: collected
    expect(t3.runs.filter((r) => r.status !== 'failed').length).toBeGreaterThan(0);
  });

  it('offline failures do not use up the 3 attempts; a timeout or an HTTP error still waits 60 min', async () => {
    let n = 0;
    const src = fixtureAdapter(() => { n++; return { ok: false, status: null, error: 'fetch failed' }; });
    await upsertSource(db, src.info);
    for (let m = 5; m <= 65; m += 15) await tick(db, [{ airport: CDG, adapter: src }], ctxAt(new Date(Date.parse('2026-11-02T06:00:00Z') + m * 60_000).toISOString()));
    expect(n).toBe(5);                                                        // one per tick, more than maxSlotAttempts
    let k = 0;
    const slow = fixtureAdapter(() => { k++; return { ok: false, status: null, error: 'timeout after 45000 ms' }; });
    await upsertAirport(db, AIRPORTS.FCO, true);
    for (let m = 5; m <= 50; m += 15) await tick(db, [{ airport: AIRPORTS.FCO, adapter: slow }], ctxAt(new Date(Date.parse('2026-11-02T06:00:00Z') + m * 60_000).toISOString()));
    expect(k).toBe(1);
  });

  it('the unit budget stops scheduled calls once reached (rolling period)', async () => {
    let calls = 0;
    const paid = fixtureAdapter(() => { calls++; return { ok: true, records: [] }; }, { unitBudget: { unitsPerRequest: 2, periodDays: 30, envVar: 'FD_TEST_BUDGET', defaultUnits: 100 } });
    await upsertSource(db, paid.info);
    await db.query(`INSERT INTO fd_collection_runs (run_key, airport, source_id, direction, target_date, slot, trigger, started_at, status, pages_fetched)
                    VALUES ('x','CDG','fixture','arrival','2026-11-01','manual:x','manual','2026-11-01T10:00:00Z','success',50)`);
    expect(await unitsUsed(db, paid.info, {}, new Date('2026-11-02T06:05:00Z'))).toMatchObject({ used: 100, budget: 100 });
    const t = await tick(db, [{ airport: CDG, adapter: paid }], ctxAt('2026-11-02T06:05:00Z'));
    expect(calls).toBe(0);
    expect(t.notReady[0].reason).toMatch(/unit budget reached \(100 of 100/);
    // A higher budget in the environment lets collection continue.
    const t2 = await tick(db, [{ airport: CDG, adapter: paid }], { ...ctxAt('2026-11-02T06:05:00Z'), env: { FD_TEST_BUDGET: '500' } });
    expect(t2.runs.length).toBeGreaterThan(0);
  });

  it('the AeroDataBox adapter carries the Pro-plan budget below the 5,000-unit hard limit', () => {
    expect(aerodatabox.info.unitBudget).toMatchObject({ unitsPerRequest: 2, defaultUnits: 4_750 });
  });

  it('a custom retry rule is honoured: here 429 is final and 503 is retried', async () => {
    let n = 0;
    const f = (status: number) => (async () => { n++; return new Response('x', { status }); }) as any;
    const rule = { retries: 2, retryOn: (s: number | null) => s === null || s >= 500, sleep: async () => {}, minSpacingMs: 0 };
    n = 0; expect((await politeGet(f(429), 'https://example.test/a', rule)).attempts).toBe(1);
    n = 0; expect((await politeGet(f(503), 'https://example.test/b', rule)).attempts).toBe(3);
    expect(n).toBe(3);
  });
});

describe('statistics keep counting after raw rows are rolled into monthly counters', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb(':memory:');
    await upsertAirport(db, CDG, true);
    const ad = fixtureAdapter(() => ({ ok: true, records: [rec({ flightNumber: 'AF1', scheduledUtc: '2026-11-02T08:00:00Z', terminal: '2F', gate: 'F21' })] }));
    await upsertSource(db, ad.info);
    await tick(db, [{ airport: CDG, adapter: ad }], ctxAt('2026-11-02T06:05:00Z'));
    // Counters as retention.ts writes them for 9 earlier October flight-days of AF1 (one without a gate).
    for (const [field, value, n] of [['flight-days', 'all', 9], ['terminal', '2F', 8], ['terminal', '2E', 1], ['gate', 'F21', 6], ['gate', 'F23', 2], ['gate', '', 1]] as const)
      await db.query(`INSERT INTO fd_derived_counts (source_id, airport, direction, flight_key, carrier, other, month, field, value, n) VALUES ('fixture','CDG','departure','AF1','AF','JFK','2026-10-01',$1,$2,$3)`, [field, value, n]);
  });

  it('distribution merges raw flight-days and counters, and says how many came from counters', async () => {
    const [g] = await distribution(db, { airport: 'CDG', direction: 'departure' }, 'terminal', 'flight_key');
    expect(g).toMatchObject({ group: 'AF1', total: 10, derived: 9, known: 10 });
    expect(g.values[0]).toMatchObject({ value: '2F', n: 9 });
    const [gate] = await distribution(db, { airport: 'CDG', direction: 'departure' }, 'gate', 'none');
    expect(gate).toMatchObject({ total: 10, missing: 1 });
    // A date filter after October leaves only the raw day.
    const [nov] = await distribution(db, { airport: 'CDG', direction: 'departure', from: '2026-11-01' }, 'terminal', 'none');
    expect(nov).toMatchObject({ total: 1, derived: 0 });
  });

  it('summary gives one line per airport and direction with terminal and gate shares', async () => {
    const lines = await summary(db);
    const dep = lines.find((l) => l.direction === 'departure')!;
    expect(dep).toMatchObject({ airport: 'CDG', flightDays: 10, derived: 9, withTerminal: 10, withGate: 9, first: '2026-10-01', last: '2026-11-02' });
    expect(dep.terminals[0]).toMatchObject({ value: '2F', n: 9 });
  });
});

describe('operations: health report, backups, lock after reboot', () => {
  it('classifies every slot since activation: on time, caught up late, missed, pending', async () => {
    const { opsHealth } = await import('../flightdata/src/ops.ts');
    const db = await openDb(':memory:');
    await upsertAirport(db, CDG, true);
    const ad = fixtureAdapter(() => ({ ok: true, records: [rec({ flightNumber: 'AF1', scheduledUtc: '2026-11-02T08:00:00Z', terminal: '2F', gate: 'F21' })] }));
    await upsertSource(db, ad.info);
    await tick(db, [{ airport: CDG, adapter: ad }], ctxAt('2026-11-02T06:05:00Z'));   // 07:00 Paris: on time
    await tick(db, [{ airport: CDG, adapter: ad }], ctxAt('2026-11-02T16:30:00Z'));   // 15:00 Paris (14:00Z): 2.5 h late
    // 23:30 Paris (22:30Z) is never collected; at 05:00Z on 11-03 it is past the 6-h window -> missed.
    const h = await opsHealth(db, { assignments: [{ airport: 'CDG', source: 'fixture' }], env: {}, now: new Date('2026-11-03T05:00:00Z'), graceHours: 6 });
    const a = h.airports[0];
    expect(a.slots).toMatchObject({ collected: 1, late: 1, missed: 1, pending: 0 });
    expect(a.problemSlots.map((p: any) => `${p.slot}:${p.state}`)).toEqual(['2026-11-02 15:00:late', '2026-11-02 23:30:missed']);
    expect(h.duplicateRuns).toBe(0);
    expect(a.coverage7d.departure).toMatchObject({ flightDays: 1, withTerminal: 1, withGate: 1 });
    const pending = await opsHealth(db, { assignments: [{ airport: 'CDG', source: 'fixture' }], env: {}, now: new Date('2026-11-02T23:00:00Z'), graceHours: 6 });
    expect(pending.airports[0].slots.pending).toBe(1);
  });

  it('a daily backup restores into a new directory with the same data, and rotation keeps 7', async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const { dailyBackup, listBackups } = await import('../flightdata/src/backup.ts');
    const { restorePglite } = await import('../flightdata/src/db.ts');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-bk-'));
    const db = await openDb(':memory:');
    await upsertAirport(db, CDG, true);
    for (let d = 1; d <= 9; d++) await dailyBackup(db, new Date(`2026-11-0${d}T12:00:00Z`), { dir: tmp, keep: 7 });
    expect(listBackups(tmp).map((b) => b.date)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    expect((await dailyBackup(db, new Date('2026-11-09T18:00:00Z'), { dir: tmp })).written).toBeNull();   // once a day
    const restored = path.join(tmp, 'restored');
    await restorePglite(new Uint8Array(fs.readFileSync(path.join(tmp, 'fd-backup-2026-11-09.tar.gz'))), restored);
    const db2 = await openDb(restored);
    expect((await db2.query('SELECT iata FROM fd_airports'))[0]).toMatchObject({ iata: 'CDG' });
    await db2.close(); await db.close();
    await expect(restorePglite(new Uint8Array(1), restored)).rejects.toThrow(/not empty/);
  }, 60_000);

  it('a lock written before the last boot is taken over even if its pid is alive again', async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const { acquireLock } = await import('../flightdata/src/lock.ts');
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-lock-')), 'pg');
    fs.mkdirSync(dir);
    const lockFile = path.join(dir, '..', 'pg.lock');
    const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 60_000).toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, what: 'old server', at: beforeBoot }));   // alive pid, stale time
    const release = acquireLock(dir, 'test');
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    release();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, what: 'running server', at: new Date().toISOString() }));
    expect(() => acquireLock(dir, 'test')).toThrow(/in use/);
  });
});

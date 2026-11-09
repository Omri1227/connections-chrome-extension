// Data-quality pass of 2026-10-31: gate areas, the read-only lookup for the Chrome extension, final coverage,
// licence-safe backups and codeshare linking by aircraft.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { fixtureAdapter, rec } from '../flightdata/src/adapters/fixture.ts';
import { parseFids } from '../flightdata/src/adapters/aerodatabox.ts';
import { collect } from '../flightdata/src/collector.ts';
import { upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { distribution, gateArea } from '../flightdata/src/analysis.ts';
import { lookupConnection, lookupFlight, LOOKUP_RULES } from '../flightdata/src/lookup.ts';
import { sweepRetention, DEFAULT_SAFETY_DAYS } from '../flightdata/src/retention.ts';
import { tick } from '../flightdata/src/scheduler.ts';
import type { FetchContext, NormalizedFlight } from '../flightdata/src/types.ts';

const ctxAt = (iso: string): FetchContext => ({ fetch: (() => { throw new Error('no network in tests'); }) as any, now: () => new Date(iso), env: {}, log: () => {} });
const DAYS = Array.from({ length: 10 }, (_, i) => `2026-10-${String(11 + i).padStart(2, '0')}`);

describe('gate area', () => {
  it('is the leading letter group of the gate', () => {
    expect(['K45', 'A1A', 'C44,C43', 'J', 'Z02', '12', null].map(gateArea)).toEqual(['K', 'A', 'C', 'J', 'Z', null, null]);
  });
});

describe('lookup for the Chrome extension', () => {
  let db: Db;
  const NOW = new Date('2026-10-21T08:00:00Z');
  beforeAll(async () => {
    db = await openDb(':memory:');
    await upsertAirport(db, AIRPORTS.CDG, true);
    // CDG on 10 days: AF1234 arrives from TLV (2E, gates K…), AF1500 departs to NCE (2F on 8 days, 2G on 2), AF77 departs
    // on 3 days only; 8 other arrivals a day give the airport enough flight-days to judge what the source publishes.
    const ad = fixtureAdapter((w) => {
      const i = DAYS.indexOf(w.localDate), d = w.localDate;
      if (i < 0 || !w.label.endsWith('#1')) return { ok: true, records: [] };
      const r: NormalizedFlight[] = w.direction === 'arrival'
        ? [rec({ flightNumber: 'AF1234', direction: 'arrival', role: 'operating', origin: 'TLV', destination: 'CDG', scheduledUtc: `${d}T06:00:00Z`, terminal: '2E', gate: i < 7 ? `K${40 + i}` : 'L21', codeshares: ['LY8001'] }),
            ...Array.from({ length: 8 }, (_, k) => rec({ flightNumber: `AF${2000 + k}`, direction: 'arrival', role: 'operating', origin: 'LYS', destination: 'CDG', scheduledUtc: `${d}T07:0${k}:00Z`, terminal: '2F', gate: null }))]
        : [rec({ flightNumber: 'AF1500', role: 'operating', destination: 'NCE', scheduledUtc: `${d}T09:00:00Z`, terminal: i < 8 ? '2F' : '2G', gate: i < 8 ? 'F21' : 'G30' }),
            ...(i < 3 ? [rec({ flightNumber: 'AF77', role: 'operating', destination: 'JFK', scheduledUtc: `${d}T08:30:00Z`, terminal: '2E', gate: 'M40' })] : [])];
      return { ok: true, records: r };
    });
    await upsertSource(db, ad.info);
    for (const d of DAYS) for (const direction of ['arrival', 'departure'] as const)
      await collect(db, { airport: AIRPORTS.CDG, adapter: ad, direction, targetDate: d, slot: `${d} 07:00`, trigger: 'schedule' }, ctxAt(`${d}T05:00:00Z`));
  });
  afterAll(async () => { await db.close(); });

  it('predicts terminal and gate area with sample, period, confidence and alternatives', async () => {
    const a = await lookupFlight(db, { airport: 'CDG', flight: 'LY 8001', date: '2026-10-21', direction: 'arrival', now: NOW });
    expect(a.status).toBe('ok');
    // 10 of 10: Wilson lower bound 0.72, so 'medium' — ten days are not enough for 'high'.
    expect(a.terminal).toMatchObject({ status: 'predicted', value: '2E', sample: 10, confidence: 'medium', distribution: [{ value: '2E', n: 10, share: 1 }] });
    expect(a.gateArea).toMatchObject({ status: 'predicted', value: 'K', sample: 10, alternatives: ['L'] });
    expect(a.gateArea.distribution).toEqual([{ value: 'K', n: 7, share: 0.7 }, { value: 'L', n: 3, share: 0.3 }]);
    expect(a.gate.confidence).toBe('low');   // gates vary day to day
    expect(a.basis).toMatchObject({ flightDays: 10, period: { from: '2026-10-11', to: '2026-10-20' }, sources: ['fixture'] });
    expect(a.gateArea.interval![0]).toBeLessThan(0.7);
    expect(a.gateArea.interval![1]).toBeGreaterThan(0.7);
  });

  it('uses only days before the date (no leakage) and reports the same day separately', async () => {
    const a = await lookupFlight(db, { airport: 'CDG', flight: 'AF1500', date: '2026-10-15', direction: 'departure', now: NOW });
    expect(a.basis.flightDays).toBe(4);
    expect(a.terminal.status).toBe('insufficient-data');
    expect(a.sameDay).toMatchObject({ terminal: '2F', gate: 'F21', gateArea: 'F' });
  });

  it('gives counts but no prediction and no percentages below the minimum sample', async () => {
    const a = await lookupFlight(db, { airport: 'CDG', flight: 'AF77', date: '2026-10-21', direction: 'departure', now: NOW });
    expect(LOOKUP_RULES.minSample).toBeGreaterThan(3);
    expect(a.status).toBe('insufficient-data');
    expect(a.terminal).toMatchObject({ status: 'insufficient-data', value: null, sample: 3, distribution: [{ value: '2E', n: 3, share: null }] });
  });

  it("marks a field the airport's source does not publish as not-published, and unknown flights as no-data", async () => {
    const a = await lookupFlight(db, { airport: 'CDG', flight: 'AF2003', date: '2026-10-21', direction: 'arrival', now: NOW });
    expect(a.terminal.status).toBe('predicted');
    expect(a.gate.status).toBe('not-published');
    expect(a.gateArea.status).toBe('not-published');
    expect((await lookupFlight(db, { airport: 'CDG', flight: 'XX1', date: '2026-10-21', direction: 'arrival', now: NOW })).status).toBe('no-data');
    expect((await lookupFlight(db, { airport: 'FRA', flight: 'LH1', date: '2026-10-21', direction: 'arrival', now: NOW })).status).toBe('airport-not-covered');
  });

  it('answers a connection and infers the connecting airport', async () => {
    const c = await lookupConnection(db, { arrivalFlight: 'AF1234', departureFlight: 'AF1500', date: '2026-10-21', now: NOW });
    expect(c).toMatchObject({ status: 'ok', airport: 'CDG', airportCandidates: ['CDG'], sameTerminalHistorically: false });
    expect(c.arrival!.terminal.value).toBe('2E');
    expect(c.departure!.terminal).toMatchObject({ value: '2F', alternatives: ['2G'] });
    expect((await lookupConnection(db, { arrivalFlight: 'AF1500', departureFlight: 'AF1234', date: '2026-10-21', now: NOW })).status).toBe('no-data');
  });

  it('keeps answering from monthly counters after the raw rows are rolled up', async () => {
    const before = await lookupFlight(db, { airport: 'CDG', flight: 'AF1234', date: '2026-10-21', direction: 'arrival', now: NOW });
    await sweepRetention(db, new Date('2026-10-30T00:00:00Z'));   // fixture source has no limit: nothing rolled
    expect(DEFAULT_SAFETY_DAYS).toBe(3);
    const after = await lookupFlight(db, { airport: 'CDG', flight: 'AF1234', date: '2026-10-21', direction: 'arrival', now: NOW });
    expect(after.terminal).toEqual(before.terminal);
  });

  it('distribution by gate area', async () => {
    const g = await distribution(db, { airport: 'CDG', direction: 'arrival', flight: 'AF1234' }, 'gateArea', 'flight_key');
    expect(g[0]).toMatchObject({ group: 'AF1234', total: 10, known: 10, values: [{ value: 'K', n: 7 }, { value: 'L', n: 3 }] });
  });

  it('R-26: leading zeros in the query are normalised like the stored keys', async () => {
    const plain = await lookupFlight(db, { airport: 'CDG', flight: 'AF77', date: '2026-10-21', direction: 'departure', now: NOW });
    const zeros = await lookupFlight(db, { airport: 'CDG', flight: 'AF 0077', date: '2026-10-21', direction: 'departure', now: NOW });
    expect(zeros.flight).toBe('AF77');
    expect(zeros.terminal).toEqual(plain.terminal);
    expect(zeros.basis.flightDays).toBe(3);
    const c = await lookupConnection(db, { arrivalFlight: 'ly08001', departureFlight: 'AF01500', date: '2026-10-21', now: NOW });
    expect(c.query).toMatchObject({ arrivalFlight: 'LY8001', departureFlight: 'AF1500' });
    expect(c.airport).toBe('CDG');
  });

  it('R-25: a date far after the latest data uses the window ending at the latest data, and says so', async () => {
    const near = await lookupFlight(db, { airport: 'CDG', flight: 'AF1234', date: '2026-10-21', direction: 'arrival', now: NOW });
    const far = await lookupFlight(db, { airport: 'CDG', flight: 'AF1234', date: '2027-06-01', direction: 'arrival', now: NOW });
    expect(far.terminal).toEqual(near.terminal);
    expect(far.basis.flightDays).toBe(near.basis.flightDays);
    expect(far.notes.join(' ')).toMatch(/after the latest collected data: the 30-day history window ends on 2026-10-21/);
    expect(near.notes.join(' ')).not.toMatch(/after the latest collected data/);
  });
});

describe('lookup with a licence-limited source: current-month counters for live queries', () => {
  it('uses the counters of the date’s month for a live query but not for a backtest', async () => {
    const db = await openDb(':memory:');
    await upsertAirport(db, AIRPORTS.CDG, true);
    const ad = fixtureAdapter((w) => ({ ok: true, records: w.label.endsWith('#1') ? [rec({ flightNumber: 'AF9', role: 'operating', destination: 'NCE', scheduledUtc: `${w.localDate}T09:00:00Z`, terminal: '2F', gate: 'F1' })] : [] }), { id: 'limited', rawRetentionDays: 7 });
    await upsertSource(db, ad.info);
    for (let d = 1; d <= 6; d++) { const day = `2026-11-0${d}`; await collect(db, { airport: AIRPORTS.CDG, adapter: ad, direction: 'departure', targetDate: day, slot: `${day} 07:00`, trigger: 'schedule' }, ctxAt(`${day}T05:00:00Z`)); }
    const r = await sweepRetention(db, new Date('2026-11-20T00:00:00Z'));
    expect(r.find((x) => x.source === 'limited')!.flightsRolled).toBe(6);
    const live = await lookupFlight(db, { airport: 'CDG', flight: 'AF9', date: '2026-11-20', direction: 'departure', now: new Date('2026-11-20T08:00:00Z') });
    expect(live.terminal).toMatchObject({ status: 'predicted', value: '2F', sample: 6 });
    expect(live.basis.fromCounters).toBe(6);
    const backtest = await lookupFlight(db, { airport: 'CDG', flight: 'AF9', date: '2026-11-10', direction: 'departure', now: new Date('2026-11-20T08:00:00Z') });
    expect(backtest.terminal.sample).toBe(0);
    await db.close();
  });
});

describe('final coverage counts only days collected again after they ended', () => {
  it('ignores the day in progress', async () => {
    const { opsHealth } = await import('../flightdata/src/ops.ts');
    const db = await openDb(':memory:');
    await upsertAirport(db, AIRPORTS.CDG, true);
    // Gates appear only once the flight has left: today's run has none, yesterday's (re-collected) has them.
    const ad = fixtureAdapter((w) => ({ ok: true, records: w.label.endsWith('#1') ? [rec({ flightNumber: 'AF1', role: 'operating', scheduledUtc: `${w.localDate}T08:00:00Z`, terminal: '2F', gate: w.localDate < '2026-11-02' ? 'F21' : null })] : [] }));
    await upsertSource(db, ad.info);
    await tick(db, [{ airport: AIRPORTS.CDG, adapter: ad }], ctxAt('2026-11-02T06:05:00Z'));   // 11-02 (today) + 11-01 (yesterday)
    const h = await opsHealth(db, { assignments: [{ airport: 'CDG', source: 'fixture' }], env: {}, now: new Date('2026-11-02T07:00:00Z'), graceHours: 6 });
    expect(h.airports[0].coverage7d.departure).toMatchObject({ flightDays: 2, withGate: 1 });
    expect(h.airports[0].coverageFinal.departure).toMatchObject({ days: 1, flightDays: 1, withGate: 1, withGateArea: 1 });
    expect(h.retention).toMatchObject({ rawLimitDays: 7, rawRollupDays: 4, fullBackupsKept: 2 });
    await db.close();
  });
});

describe('licence-safe backups', () => {
  it('keeps 2 full backups and 60 counter files, restores counters, and expires manual raw copies', async () => {
    const { dailyBackup, listBackups, listCounterBackups, importCounters, manualCopies } = await import('../flightdata/src/backup.ts');
    const zlib = await import('node:zlib');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-bk2-'));
    const db = await openDb(':memory:');
    await upsertAirport(db, AIRPORTS.CDG, true);
    await upsertSource(db, fixtureAdapter(() => ({ ok: true, records: [] }), { id: 'limited', rawRetentionDays: 7 }).info);
    await db.query(`INSERT INTO fd_derived_counts (source_id, airport, direction, flight_key, carrier, other, month, field, value, n) VALUES ('limited','CDG','departure','AF1','AF','NCE','2026-10-01','terminal','2F',4)`);
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.join(dataDir, 'pg.backup-2026-11-01-before-x'), { recursive: true });
    fs.utimesSync(path.join(dataDir, 'pg.backup-2026-11-01-before-x'), new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'));
    for (let d = 1; d <= 5; d++) await dailyBackup(db, new Date(`2026-11-0${d}T12:00:00Z`), { dir: tmp, dataDir });
    expect(listBackups(tmp).map((b) => b.date)).toEqual(['2026-11-04', '2026-11-05']);
    expect(listCounterBackups(tmp)).toHaveLength(5);
    // No collection run in this database: the copy may hold rows from 4 days before it was made → delete by +6 - 4 days.
    expect(manualCopies(dataDir, null, new Date('2026-11-01T12:00:00Z'))).toEqual([]);   // already expired and deleted on 11-03
    const file = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'fd-counters-2026-11-05.json.gz'))).toString('utf8'));
    expect(file.rows).toHaveLength(1);
    const db2 = await openDb(':memory:');
    await upsertAirport(db2, AIRPORTS.CDG, true);
    await upsertSource(db2, fixtureAdapter(() => ({ ok: true, records: [] }), { id: 'limited', rawRetentionDays: 7 }).info);
    expect(await importCounters(db2, file)).toEqual({ inserted: 1, skipped: 0 });
    expect(await importCounters(db2, file)).toEqual({ inserted: 0, skipped: 1 });
    await db.close(); await db2.close();
    // Five full PGlite dumps: about 30 s on a quiet machine, but it ran past 60 s while the extension tests were
    // running beside it (2026-11-09, found by running the suite under load twice).
  }, 180_000);

  it('a manual copy made on the first collection day expires 6 days after that day', async () => {
    const { manualCopies } = await import('../flightdata/src/backup.ts');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-man-'));
    const dir = path.join(dataDir, 'pg.backup-2026-10-31-before-codeshare-cleanup');
    fs.mkdirSync(dir);
    fs.utimesSync(dir, new Date('2026-10-31T09:30:00Z'), new Date('2026-10-31T09:30:00Z'));
    const [c] = manualCopies(dataDir, new Date('2026-10-31T08:52:00Z'), new Date('2026-11-05T00:00:00Z'));
    expect(c).toMatchObject({ deleteBy: '2026-11-06T08:52:00.000Z', expired: false });
  });
});

describe('codeshare linking by aircraft', () => {
  const row = (number: string, status: string, reg: string, model: string, iata = 'AGP') => ({
    number, status: 'Expected', codeshareStatus: status, isCargo: false, airline: { name: number.slice(0, 2) }, aircraft: { reg, model },
    movement: { airport: { iata }, scheduledTime: { utc: '2026-10-31 17:55Z' }, terminal: '1', gate: null, quality: [] },
  });
  it('links a codeshare to the operator with the same registration when two operators share time and route', () => {
    const body = { departures: [row('VY 7900', 'IsOperator', 'EC-MLD', 'Airbus A320'), row('HV 6110', 'IsOperator', 'PH-HXA', 'Boeing 737-800'), row('IB 5868', 'IsCodeshared', 'EC-MLD', 'Airbus A320'), row('KL 2664', 'IsCodeshared', '', 'Boeing 737-800')] };
    const { records } = parseFids(body, AIRPORTS.AMS, 'departure');
    const by = (n: string) => records.find((r) => r.flightNumber === n)!;
    expect(by('IB5868').operatingFlightNumber).toBe('VY7900');
    expect(by('KL2664').operatingFlightNumber).toBe('HV6110');   // no registration: the only same-model operator
    expect(by('VY7900').codeshares).toEqual(['IB5868']);
    expect(String(by('IB5868').extra?.codeshareLink)).toMatch(/registration/);
  });
  it('leaves the row unlinked when aircraft do not tell the operators apart', () => {
    const body = { departures: [row('VY 7900', 'IsOperator', '', 'Airbus A320'), row('U2 7987', 'IsOperator', '', 'Airbus A320'), row('IB 5868', 'IsCodeshared', '', 'Airbus A320')] };
    expect(parseFids(body, AIRPORTS.AMS, 'departure').records.find((r) => r.flightNumber === 'IB5868')!.operatingFlightNumber).toBeNull();
  });
});

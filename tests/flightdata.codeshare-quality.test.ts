// Regression tests for the AMS data-quality review of 2026-11-01: duplicated operator rows breaking codeshare links,
// phantom codeshare flight-days left by one snapshot, codeshares counted as physical flights in statistics and
// predictions, same-time gate conflicts (AMS D6 bus gates), and the capped flight list.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFids } from '../flightdata/src/adapters/aerodatabox.ts';
import { fixtureAdapter, rec } from '../flightdata/src/adapters/fixture.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { completeness, countFlights, distribution, listFlights, predict, summary } from '../flightdata/src/analysis.ts';
import { collect } from '../flightdata/src/collector.ts';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { lookupFlight } from '../flightdata/src/lookup.ts';
import { gateConflicts } from '../flightdata/src/quality.ts';
import { sweepRetention } from '../flightdata/src/retention.ts';
import { upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import type { FetchContext, NormalizedFlight } from '../flightdata/src/types.ts';

const AMS = AIRPORTS.AMS;
const ctxAt = (iso: string): FetchContext => ({ fetch: (() => { throw new Error('no network in tests'); }) as any, now: () => new Date(iso), env: {}, log: () => {} });

describe('codeshare linking with duplicated rows (AeroDataBox, AMS 2026-10-31 / 11-01)', () => {
  const mv = (o: { gate?: string | null; iata?: string; t?: string }) => ({ ...(o.iata ? { airport: { iata: o.iata } } : {}), scheduledTime: { utc: o.t ?? '2026-11-01 15:00Z' }, terminal: '2', gate: o.gate ?? null, quality: ['Basic'] });
  const row = (number: string, status: 'IsOperator' | 'IsCodeshared', m: object, reg?: string) => ({ number, codeshareStatus: status, status: 'Expected', movement: m, aircraft: { model: 'Boeing 737-800', ...(reg ? { reg } : {}) } });

  it('links route-less codeshares when the operator row is sent twice (KL941 + VS6991 at D2)', () => {
    const op = row('KL 941', 'IsOperator', mv({ gate: 'D2', iata: 'GLA' }), 'PH-BXA');
    const cs = row('VS 6991', 'IsCodeshared', mv({ gate: 'D2' }), 'PH-BXA');
    const cs2 = row('DL 9239', 'IsCodeshared', mv({ gate: 'D2' }), 'PH-BXA');
    const p = parseFids({ departures: [op, cs, cs2, op, cs, cs2] }, AMS, 'departure');
    for (const n of ['VS6991', 'DL9239']) expect(p.records.filter((r) => r.flightNumber === n).every((r) => r.operatingFlightNumber === 'KL941' && r.destination === 'GLA')).toBe(true);
    // Both copies of the operator carry each code exactly once.
    for (const o of p.records.filter((r) => r.flightNumber === 'KL941')) expect(o.codeshares).toEqual(['VS6991', 'DL9239']);
    expect(p.issues.some((i) => /not linked/.test(i.detail))).toBe(false);
  });

  it('links a routed codeshare when the operator row is sent twice (OS318 + AI8442 → VIE)', () => {
    const op = row('OS 318', 'IsOperator', mv({ gate: 'B35', iata: 'VIE' }));
    const p = parseFids({ departures: [op, op, row('AI 8442', 'IsCodeshared', mv({ gate: 'B35', iata: 'VIE' }))] }, AMS, 'departure');
    expect(p.records.find((r) => r.flightNumber === 'AI8442')!.operatingFlightNumber).toBe('OS318');
  });

  it('still refuses two genuinely different operators at the same time and route', () => {
    const p = parseFids({ departures: [
      row('VY 8312', 'IsOperator', mv({ gate: 'D7', iata: 'AGP' }), 'EC-AAA'),
      row('HV 5131', 'IsOperator', mv({ gate: 'D9', iata: 'AGP' }), 'PH-BBB'),
      row('IB 5000', 'IsCodeshared', mv({ iata: 'AGP' })),
    ] }, AMS, 'departure');
    expect(p.records.find((r) => r.flightNumber === 'IB5000')!.operatingFlightNumber).toBeNull();
  });

  it('links a codeshare without route or gate only by aircraft registration', () => {
    const p = parseFids({ departures: [
      row('KL 1001', 'IsOperator', mv({ iata: 'LHR' }), 'PH-EXA'),
      row('KL 1003', 'IsOperator', mv({ iata: 'MAN' }), 'PH-EXB'),
      row('MU 1807', 'IsCodeshared', mv({}), 'PH-EXB'),
      row('KQ 1293', 'IsCodeshared', mv({})),               // no registration: never linked
    ] }, AMS, 'departure');
    expect(p.records.find((r) => r.flightNumber === 'MU1807')).toMatchObject({ operatingFlightNumber: 'KL1003', destination: 'MAN' });
    expect(p.records.find((r) => r.flightNumber === 'KQ1293')!.operatingFlightNumber).toBeNull();
  });
});

describe('same-time gate conflicts', () => {
  const dep = (n: string, gate: string, to: string, ac: string, extra: Partial<NormalizedFlight> = {}) =>
    rec({ airport: 'AMS', origin: 'AMS', flightNumber: n, scheduledUtc: '2026-11-01T21:40:00.000Z', gate, terminal: '2', destination: to, aircraftType: ac, role: 'operating', ...extra });

  it('classifies D6 bus gates, codeshares flagged as operators, and the rest', () => {
    const c = gateConflicts([
      dep('KL1131', 'D6', 'ORK', 'Embraer 195'), dep('KL961', 'D6', 'NCL', 'Embraer 195'), dep('KL1025', 'D6', 'LBA', 'Embraer 195'),
      dep('KL807', 'E17', 'TPE', 'Boeing 777'), dep('CI9388', 'E17', 'TPE', 'Boeing 777'),
      dep('KL461', 'D27', 'OTP', 'Boeing 737'), dep('HV5751', 'D27', 'RAK', 'Boeing 737'),
      // A linked codeshare is the same movement, an unlinked one is not a movement: neither makes a conflict.
      dep('DL9536', 'B3', 'ORK', 'Embraer 195', { role: 'marketing', operatingFlightNumber: 'KL1229' }), dep('KL1229', 'B3', 'GOT', 'Embraer 195'),
      dep('AF8425', 'B5', 'TLV', 'Boeing 737', { role: 'marketing' }), dep('KL1341', 'B5', 'POZ', 'Embraer 175'),
    ], AMS);
    expect(c.map((x) => [x.gate, x.kind])).toEqual([['D27', 'unexplained'], ['D6', 'shared-boarding-area'], ['E17', 'probable-duplicate-operator']]);
    expect(c.find((x) => x.gate === 'D6')!.flights).toEqual(['KL1025', 'KL1131', 'KL961']);
  });
});

describe('phantom codeshare flight-days and physical counting', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(':memory:'); await upsertAirport(db, AMS, true); });
  afterEach(async () => { await db.close(); });

  const at = (date: string, hm: string) => `${date}T${hm}:00.000Z`;
  const op = (n: string, date: string, extra: Partial<NormalizedFlight> = {}) =>
    rec({ airport: 'AMS', origin: 'AMS', destination: 'GLA', flightNumber: n, scheduledUtc: at(date, '15:00'), terminal: '2', gate: 'D2', role: 'operating', ...extra });
  const mk = (n: string, date: string, linkedTo: string | null) =>
    rec({ airport: 'AMS', origin: 'AMS', destination: null, flightNumber: n, scheduledUtc: at(date, '15:00'), terminal: '2', gate: 'D2', role: 'marketing', operatingFlightNumber: linkedTo });
  async function run(records: NormalizedFlight[], date: string, slot: string, nowIso: string, over = {}) {
    const ad = fixtureAdapter(() => ({ ok: true, records }), over);
    await upsertSource(db, ad.info);
    return collect(db, { airport: AMS, adapter: ad, direction: 'departure', targetDate: date, slot: `${date} ${slot}`, trigger: 'schedule' }, ctxAt(nowIso));
  }
  const keys = async () => (await db.query<{ flight_key: string }>('SELECT flight_key FROM fd_flights ORDER BY flight_key')).map((r) => r.flight_key);

  it('removes a listing one snapshot could not link once a later snapshot links it (VS6991 → KL941)', async () => {
    const d = '2026-11-01';
    await run([op('KL941', d, { codeshares: ['DL9239'] }), mk('DL9239', d, 'KL941'), mk('VS6991', d, null)], d, '07:00', at(d, '06:00'));
    expect(await keys()).toEqual(['KL941', 'VS6991']);
    await run([op('KL941', d, { codeshares: ['DL9239', 'VS6991'] }), mk('DL9239', d, 'KL941'), mk('VS6991', d, 'KL941')], d, '15:00', at(d, '14:00'));
    expect(await keys()).toEqual(['KL941']);
    const codes = await db.query<{ code: string }>("SELECT code FROM fd_flight_codes c JOIN fd_flights f ON f.id=c.flight_id WHERE f.flight_key='KL941' ORDER BY code");
    expect(codes.map((c) => c.code)).toEqual(['DL9239', 'KL941', 'VS6991']);
    const f = await db.query<{ kind: string; detail: any }>("SELECT kind, detail FROM fd_quality_findings WHERE kind='superseded-listing'");
    expect(f[0].detail.examples).toEqual(['VS6991 → KL941']);
  });

  it('removes a codeshare the source briefly flagged as an operator (KL209 "operating", then a code of CI74)', async () => {
    const d = '2026-10-31';
    const tpe = { destination: 'TPE', gate: 'F4', terminal: '1', aircraftType: 'Airbus A350-900' };
    await run([op('CI74', d, tpe), op('KL209', d, tpe)], d, '07:00', at(d, '06:00'));
    await run([op('CI74', d, { ...tpe, codeshares: ['KL209'] }), { ...mk('KL209', d, 'CI74'), ...tpe }], d, '15:00', at(d, '14:00'));
    expect(await keys()).toEqual(['CI74']);
  });

  it('never removes a listing without a source-made link at the same instant', async () => {
    const d = '2026-11-01';
    await run([op('KL941', d), mk('VS6991', d, null), mk('AF8425', d, null)], d, '07:00', at(d, '06:00'));
    // Later run: VS6991 still unlinked; a code with the same number appears on a flight at another time.
    await run([op('KL941', d), mk('VS6991', d, null), op('KL1001', d, { scheduledUtc: at(d, '17:00'), codeshares: ['AF8425'] })], d, '15:00', at(d, '14:00'));
    expect(await keys()).toEqual(['AF8425', 'KL1001', 'KL941', 'VS6991']);
  });

  it('leaves codeshare listings out of statistics, keeps them listed, and reports the true total', async () => {
    const d = '2026-11-01';
    await run([op('KL941', d), mk('VS6991', d, null), mk('DL9203', d, null)], d, '07:00', at(d, '06:00'));
    const f = { airport: 'AMS', direction: 'departure' as const };
    expect(await distribution(db, f, 'gate', 'none')).toMatchObject([{ total: 1, values: [{ value: 'D2', n: 1 }] }]);
    expect((await completeness(db, f))[0]).toMatchObject({ flights: 1, with_gate: 1, codeshare_listings: 2 });
    expect((await summary(db)).find((l) => l.airport === 'AMS')!.flightDays).toBe(1);
    expect(await countFlights(db, f)).toEqual({ total: 3, codeshareListings: 2, duplicates: 0 });
    const page = await listFlights(db, f, 2, 0);
    expect(page).toHaveLength(2);
    expect((await listFlights(db, f, 2, 2))).toHaveLength(1);
    expect(page.every((x: any) => x.sightings === 1 && Number(x.observations) === 1)).toBe(true);
  });

  it('counts a flight-day once in predictions and lookups when its number is both a listing and a code at the same instant', async () => {
    for (const [i, d] of ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].entries())
      // Same run: VS6991 is a code of KL941 (operator row) and also an unlinked row of its own.
      await run([op('KL941', d, { codeshares: ['VS6991'] }), mk('VS6991', d, null)], d, '07:00', `${d}T0${i}:30:00.000Z`);
    expect((await db.query<{ n: number }>("SELECT count(*)::int n FROM fd_flights WHERE flight_key='VS6991'"))[0].n).toBe(5);
    const p = await predict(db, { airport: 'AMS', flight: 'VS6991', date: '2026-10-30', direction: 'departure', now: new Date('2026-10-30T10:00:00Z') });
    expect(p.historical.totalFlightDays).toBe(5);
    expect(p.historical.sample).toBe(5);
    const l = await lookupFlight(db, { airport: 'AMS', flight: 'VS6991', date: '2026-10-30', direction: 'departure', now: new Date('2026-10-30T10:00:00Z') });
    expect(l.basis.flightDays).toBe(5);
    expect(l.gate.sample).toBe(5);
  });

  it('rolls an unlinked codeshare listing into listed:* counters, not the physical ones', async () => {
    const d = '2026-10-20';
    await run([op('KL941', d), mk('VS6991', d, null)], d, '07:00', at(d, '06:00'), { id: 'limited', rawRetentionDays: 7 });
    await sweepRetention(db, new Date('2026-10-30T00:00:00Z'));
    const rows = await db.query<{ flight_key: string; field: string }>('SELECT flight_key, field FROM fd_derived_counts ORDER BY flight_key, field');
    expect(rows.filter((r) => r.flight_key === 'VS6991').map((r) => r.field)).toEqual(['listed:flight-days', 'listed:gate', 'listed:terminal']);
    expect(rows.filter((r) => r.flight_key === 'KL941').map((r) => r.field)).toEqual(['flight-days', 'gate', 'terminal']);
    expect((await summary(db)).find((l) => l.airport === 'AMS')!.flightDays).toBe(1);
  });
});

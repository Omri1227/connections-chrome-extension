// Regression tests for the AMS follow-up of 2026-11-01: flight-days the source listed as separate operating flights
// although they are one movement (KL807 / CI9388 / AF8414 → TPE, verified on FlightStats), verified codeshares with a
// wrong route on the codeshare row (AF3588 → "FCO" on DL237 → TPA; AF8425 / LY8854 / KQ1461 → TLV on KL461 via OTP),
// the owner decision that matching time, gate, route and aircraft model alone is no proof (Option 1), gate histories
// (initial / updated / final), and the cross-airport completeness check.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFids } from '../flightdata/src/adapters/aerodatabox.ts';
import { fixtureAdapter, rec } from '../flightdata/src/adapters/fixture.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { completeness, countFlights, distribution, gateHistory, leadBucket, listFlights, summary } from '../flightdata/src/analysis.ts';
import { collect } from '../flightdata/src/collector.ts';
import { crossAirportCheck } from '../flightdata/src/crosscheck.ts';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { sweepRetention } from '../flightdata/src/retention.ts';
import { markDuplicates, upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import type { FetchContext, NormalizedFlight } from '../flightdata/src/types.ts';
import { VERIFIED_CODESHARES } from '../flightdata/src/verified-codeshares.ts';

const AMS = AIRPORTS.AMS, FRA = AIRPORTS.FRA;
const ctxAt = (iso: string): FetchContext => ({ fetch: (() => { throw new Error('no network in tests'); }) as any, now: () => new Date(iso), env: {}, log: () => {} });

let db: Db;
beforeEach(async () => { db = await openDb(':memory:'); await upsertAirport(db, AMS, true); await upsertAirport(db, FRA, true); });
afterEach(async () => { await db.close(); });

async function run(records: NormalizedFlight[], airport = AMS, direction: 'departure' | 'arrival', date: string, slot: string, nowIso: string, over = {}) {
  const ad = fixtureAdapter(() => ({ ok: true, records }), over);
  await upsertSource(db, ad.info);
  return collect(db, { airport, adapter: ad, direction, targetDate: date, slot, trigger: 'schedule' }, ctxAt(nowIso));
}
const dep = (n: string, date: string, hm: string, extra: Partial<NormalizedFlight> = {}) =>
  rec({ airport: 'AMS', direction: 'departure', origin: 'AMS', destination: 'TPE', flightNumber: n, scheduledUtc: `${date}T${hm}:00.000Z`, terminal: '2', gate: 'E17', aircraftType: 'Boeing 777', role: 'operating', ...extra });
const flight = async (key: string, date = '2026-11-01') =>
  (await db.query<{ id: string; duplicate_of: string | null; duplicate_reason: string | null }>('SELECT id, duplicate_of, duplicate_reason FROM fd_flights WHERE flight_key=$1 AND local_date=$2', [key, date]))[0];

describe('verified codeshares listed as operating flights (AMS 2026-11-01)', () => {
  const tpe = (d: string) => [dep('KL807', d, '19:20'), dep('CI9388', d, '19:20'), dep('AF8414', d, '19:20')];

  it('marks CI9388 and AF8414 as duplicates of KL807, counts one movement, keeps every observation', async () => {
    const d = '2026-11-01';
    await run(tpe(d), AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`);
    const kl = await flight('KL807');
    for (const k of ['CI9388', 'AF8414']) expect(await flight(k)).toMatchObject({ duplicate_of: kl.id, duplicate_reason: 'verified-codeshare' });
    expect(kl.duplicate_of).toBeNull();
    const f = { airport: 'AMS', direction: 'departure' as const };
    expect((await completeness(db, f))[0]).toMatchObject({ flights: 1, with_gate: 1, duplicates: 2, codeshare_listings: 0 });
    expect(await distribution(db, f, 'gate', 'none')).toMatchObject([{ total: 1, values: [{ value: 'E17', n: 1 }] }]);
    expect((await summary(db)).find((l) => l.airport === 'AMS')!.flightDays).toBe(1);
    expect(await countFlights(db, f)).toEqual({ total: 3, codeshareListings: 0, duplicates: 2 });
    // Nothing deleted: three flight-days, three observations, each still found by its own number.
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM fd_observations'))[0].n).toBe(3);
    const ci = await listFlights(db, { ...f, flight: 'CI9388' });
    expect(ci).toHaveLength(1);
    expect(ci[0]).toMatchObject({ duplicate_of_key: 'KL807', duplicate_reason: 'verified-codeshare', gate: 'E17' });
    const finding = await db.query<{ detail: any }>("SELECT detail FROM fd_quality_findings WHERE kind='duplicate-flight-day'");
    expect(finding[0].detail).toMatchObject({ pattern: 'verified-codeshare', count: 2 });
    expect([...finding[0].detail.examples].sort()).toEqual(['AF8414 = KL807', 'CI9388 = KL807']);
  });

  it('does not mark the same pattern on a date the relationship was not verified for (owner decision, Option 1)', async () => {
    const d = '2026-11-02';
    await run(tpe(d), AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`);
    for (const k of ['KL807', 'CI9388', 'AF8414']) expect((await flight(k, d)).duplicate_of).toBeNull();
    // Still reported, still counted.
    const f = await db.query<{ detail: any }>("SELECT detail FROM fd_quality_findings WHERE kind='gate-time-conflict'");
    expect(f[0].detail).toMatchObject({ pattern: 'probable-duplicate-operator', count: 1 });
    expect((await completeness(db, { airport: 'AMS', direction: 'departure' }))[0]).toMatchObject({ flights: 3, duplicates: 0 });
  });

  it('marks verified codeshare listings with a wrong route (AF3588 "FCO" on DL237 → TPA; KL461 via OTP, codes to TLV)', async () => {
    const d = '2026-11-01';
    const mk = (n: string, hm: string, to: string, gate: string) => dep(n, d, hm, { role: 'marketing', destination: to, gate, aircraftType: null });
    await run([
      dep('DL237', d, '08:55', { destination: 'TPA', gate: 'D43', aircraftType: 'Airbus A330-900' }), mk('AF3588', '08:55', 'FCO', 'D43'),
      dep('KL461', d, '15:40', { destination: 'OTP', gate: 'D27', aircraftType: 'Boeing 737' }), mk('AF8425', '15:40', 'TLV', 'D27'), mk('LY8854', '15:40', 'TLV', 'D27'), mk('KQ1461', '15:40', 'TLV', 'D27'),
    ], AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`);
    expect(await flight('AF3588')).toMatchObject({ duplicate_of: (await flight('DL237')).id, duplicate_reason: 'verified-codeshare' });
    for (const k of ['AF8425', 'LY8854', 'KQ1461']) expect((await flight(k)).duplicate_of).toBe((await flight('KL461')).id);
    // They were codeshare listings before and stay outside the physical count either way.
    expect((await completeness(db, { airport: 'AMS', direction: 'departure' }))[0]).toMatchObject({ flights: 2, codeshare_listings: 4, duplicates: 0 });
  });

  it('recomputes marks: a mark disappears when its evidence does', async () => {
    const d = '2026-11-01';
    await run(tpe(d), AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`);
    expect((await markDuplicates(db, { airport: 'AMS', direction: 'departure', dates: [d], verified: [] }))).toEqual([]);
    expect((await flight('CI9388')).duplicate_of).toBeNull();
    expect((await markDuplicates(db, { airport: 'AMS', direction: 'departure', dates: [d] })).map((m) => m.flightKey).sort()).toEqual(['AF8414', 'CI9388']);
  });

  it('every verified entry names its evidence and a single checked date', () => {
    for (const v of VERIFIED_CODESHARES) {
      expect(v.evidence.length).toBeGreaterThan(30);
      expect(v.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.marketing).not.toContain(v.operating);
    }
  });

  it('rolls a duplicate into listed:* counters, not the physical ones', async () => {
    const d = '2026-11-01';
    await run(tpe(d), AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`, { id: 'limited', rawRetentionDays: 7 });
    await sweepRetention(db, new Date('2026-11-10T00:00:00Z'));
    const rows = await db.query<{ flight_key: string; field: string }>("SELECT flight_key, field FROM fd_derived_counts WHERE field <> 'code' AND field <> 'listed:code' ORDER BY flight_key, field");
    expect(rows.filter((r) => r.flight_key === 'KL807').map((r) => r.field)).toEqual(['flight-days', 'gate', 'terminal']);
    expect(rows.filter((r) => r.flight_key === 'CI9388').map((r) => r.field)).toEqual(['listed:flight-days', 'listed:gate', 'listed:terminal']);
  });
});

describe('same-aircraft duplicates (registration evidence)', () => {
  const fra = (n: string, reg: string | null, extra: Partial<NormalizedFlight> = {}) =>
    rec({ airport: 'FRA', direction: 'departure', origin: 'FRA', destination: 'AYT', flightNumber: n, scheduledUtc: '2026-10-31T09:00:00.000Z', terminal: '1', gate: 'C13', aircraftType: 'Boeing 737-800', role: 'operating', extra: reg ? { registration: reg } : {}, ...extra });

  it('marks two operating numbers on one airframe at one instant, keeping the lower number (LH9416 = XQ971)', async () => {
    const d = '2026-10-31';
    await run([fra('LH9416', 'TC-SNU'), fra('XQ971', 'TC-SNU')], FRA, 'departure', d, `${d} 07:00`, `${d}T05:00:00.000Z`);
    expect(await flight('LH9416', d)).toMatchObject({ duplicate_of: (await flight('XQ971', d)).id, duplicate_reason: 'same-aircraft' });
    expect((await completeness(db, { airport: 'FRA', direction: 'departure' }))[0]).toMatchObject({ flights: 1, duplicates: 1 });
  });

  it('does not mark them when registrations differ or are missing', async () => {
    const d = '2026-10-31';
    await run([fra('LH9416', 'TC-SNU'), fra('XQ971', 'TC-SNV'), fra('LH9594', null, { destination: 'ADB', gate: 'C20' }), fra('XQ141', null, { destination: 'ADB', gate: 'C20' })], FRA, 'departure', d, `${d} 07:00`, `${d}T05:00:00.000Z`);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM fd_flights WHERE duplicate_of IS NOT NULL'))[0].n).toBe(0);
  });

  it('stores the aircraft registration from AeroDataBox rows', () => {
    const p = parseFids({ departures: [{ number: 'XQ 971', codeshareStatus: 'IsOperator', status: 'Expected', movement: { airport: { iata: 'AYT' }, scheduledTime: { utc: '2026-10-31 09:00Z' }, terminal: '1', gate: 'C13' }, aircraft: { model: 'Boeing 737-800', reg: ' tc-snu ' } }] }, FRA, 'departure');
    expect(p.records[0].extra).toMatchObject({ registration: 'TC-SNU' });
  });
});

describe('gate history: initial, updated and final assignments', () => {
  it('records E17 first, F4 later, and judges F4 final after departure (KL807 pattern)', async () => {
    const d = '2026-11-01';
    const kl = (gate: string | null, extra: Partial<NormalizedFlight> = {}) => dep('KL807', d, '19:20', { gate, ...extra });
    const kept = (gate: string, extra: Partial<NormalizedFlight> = {}) => dep('KL1001', d, '10:00', { destination: 'LHR', gate, aircraftType: 'Embraer 175', ...extra });
    const moved = { status: 'departed' as const, actualUtc: `${d}T19:48:00.000Z` };
    await run([kl('E17'), kept('D6')], AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`);
    await run([kl('F4'), kept('D6', { status: 'departed', actualUtc: `${d}T10:05:00.000Z` })], AMS, 'departure', d, `${d} 15:00`, `${d}T14:00:00.000Z`);
    // Next morning's run sees the flight after departure; the source has withdrawn the gate of the other one.
    await run([kl('F4', moved), kept('D6', { status: 'departed', actualUtc: `${d}T10:05:00.000Z`, gate: null })], AMS, 'departure', d, '2026-11-02 07:00', '2026-11-02T06:00:00.000Z');
    const h = await gateHistory(db, { airport: 'AMS', direction: 'departure' });
    const t = h.changed.find((x) => x.flight === 'KL807')!;
    expect(t).toMatchObject({ initial: { gate: 'E17', leadHours: 12.6 }, latest: 'F4', state: 'final', firstSeenAfterMovement: false });
    expect(t.updates).toEqual([{ gate: 'F4', seenAt: `${d}T14:00:00.000Z` }]);
    expect(h.summary).toMatchObject({ withGate: 2, final: 2, judged: 2, keptInitial: 1, changed: 1, withdrawn: 0 });
    expect(h.summary.byLead.find((b) => b.lead === '12-24h')).toMatchObject({ n: 1, kept: 0, share: 0 });
    expect(h.summary.byLead.find((b) => b.lead === '3-12h')).toMatchObject({ n: 1, kept: 1, share: 1 }); // KL1001: 3.3 h ahead
    const rows = await listFlights(db, { airport: 'AMS', direction: 'departure', flight: 'KL807' });
    expect(rows[0]).toMatchObject({ gate: 'F4', first_gate: 'E17', gate_state: 'final' });
  });

  it('does not judge a flight first seen only after its movement (AMS 2026-10-30 KL807 at F3)', async () => {
    const d = '2026-10-30';
    await run([dep('KL807', d, '19:20', { gate: 'F3', status: 'departed', actualUtc: `${d}T19:48:00.000Z` })], AMS, 'departure', d, '2026-10-31 07:00', '2026-10-31T08:49:00.000Z');
    const h = await gateHistory(db, { airport: 'AMS', direction: 'departure' });
    expect(h.summary).toMatchObject({ withGate: 1, final: 1, firstSeenAfterMovement: 1, judged: 0 });
    expect((await listFlights(db, { airport: 'AMS', direction: 'departure' }))[0]).toMatchObject({ gate: 'F3', gate_state: 'final' });
  });

  it('marks a pre-movement gate as latest, and buckets lead times', async () => {
    const d = '2026-11-01';
    await run([dep('KL807', d, '19:20')], AMS, 'departure', d, `${d} 07:00`, `${d}T06:45:00.000Z`);
    expect((await listFlights(db, { airport: 'AMS', direction: 'departure' }))[0]).toMatchObject({ gate: 'E17', first_gate: 'E17', gate_state: 'latest' });
    expect([2.9, 3, 11.9, 12, 23.9, 24].map(leadBucket)).toEqual(['<3h', '3-12h', '3-12h', '12-24h', '12-24h', '>24h']);
  });
});

describe('cross-airport completeness (AMS ↔ FRA)', () => {
  it('matches departures to arrivals by number or code and reports one-sided flights', async () => {
    const d = '2026-11-01';
    const amsDep = (n: string, hm: string, extra: Partial<NormalizedFlight> = {}) => rec({ airport: 'AMS', direction: 'departure', origin: 'AMS', destination: 'FRA', flightNumber: n, scheduledUtc: `${d}T${hm}:00.000Z`, role: 'operating', ...extra });
    const fraArr = (n: string, hm: string, extra: Partial<NormalizedFlight> = {}) => rec({ airport: 'FRA', direction: 'arrival', origin: 'AMS', destination: 'FRA', flightNumber: n, scheduledUtc: `${d}T${hm}:00.000Z`, role: 'operating', ...extra });
    await run([amsDep('KL1763', '06:00'), amsDep('LH993', '08:00'), amsDep('KL1767', '12:00', { codeshares: ['LH4743'] }), amsDep('KL1771', '15:00', { status: 'cancelled' })], AMS, 'departure', d, `${d} 07:00`, `${d}T05:00:00.000Z`);
    await run([fraArr('KL1763', '07:10'), fraArr('LH4743', '13:10'), fraArr('LH1001', '17:00'), fraArr('KL1771', '16:10')], FRA, 'arrival', d, `${d} 07:00`, `${d}T05:00:00.000Z`);
    // The day before at AMS and the next day at FRA were collected too (nothing relevant in them).
    await run([], AMS, 'departure', '2026-10-31', '2026-10-31 07:00', '2026-10-31T05:00:00.000Z');
    await run([], FRA, 'arrival', '2026-11-02', '2026-11-02 07:00', '2026-11-02T05:00:00.000Z');
    await db.query("UPDATE fd_collection_runs SET status='success' WHERE status NOT IN ('success','partial','suspect')");
    const c = await crossAirportCheck(db, { date: d });
    const p = c.pairs.find((x) => x.from === 'AMS' && x.to === 'FRA')!;
    expect(p).toMatchObject({ departures: 4, matched: 3, missingArrival: ['LH993 08:00Z'], arrivals: 4, missingDeparture: ['LH1001 17:00Z'], statusMismatch: ['KL1771 15:00Z cancelled/scheduled'] });
  });

  it('judges nothing when the other side was not collected', async () => {
    const d = '2026-11-01';
    await run([rec({ airport: 'AMS', direction: 'departure', origin: 'AMS', destination: 'FRA', flightNumber: 'LH993', scheduledUtc: `${d}T08:00:00.000Z`, role: 'operating' })], AMS, 'departure', d, `${d} 07:00`, `${d}T05:00:00.000Z`);
    expect((await crossAirportCheck(db, { date: d })).totals).toMatchObject({ departures: 0, missingArrival: 0 });
  });
});

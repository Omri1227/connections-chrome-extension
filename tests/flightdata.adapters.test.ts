// Source adapters (parsers against saved or documented payloads, never live sites), retention roll-up, and the API.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adrFco, parseRows, resolveTimes, toRecord, totalEntries, parseDetailGate, listUrl } from '../flightdata/src/adapters/adr-fco.ts';
import { aerodatabox, parseFids, windowUrl } from '../flightdata/src/adapters/aerodatabox.ts';
import { parseFlightInfo, swedavia } from '../flightdata/src/adapters/swedavia.ts';
import { fixtureAdapter, rec } from '../flightdata/src/adapters/fixture.ts';
import { resolveAssignments } from '../flightdata/src/adapters/index.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { createFdApp } from '../flightdata/src/api.ts';
import { collect } from '../flightdata/src/collector.ts';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { sweepRetention } from '../flightdata/src/retention.ts';
import { predict } from '../flightdata/src/analysis.ts';
import { upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import type { FetchContext } from '../flightdata/src/types.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'flightdata');
const ctx = (iso: string, f: typeof fetch = (() => { throw new Error('no network'); }) as any, env: Record<string, string> = {}): FetchContext => ({ fetch: f, now: () => new Date(iso), env, log: () => {} });

// The adr.it excerpts may be saved for own-organisation use only, so they stay in the private repository; the public
// snapshot skips these parser tests.
const HAS_ADR = fs.existsSync(path.join(FIX, 'fco-departures.html'));
describe.skipIf(!HAS_ADR)('Rome Fiumicino board (adr.it) parser', () => {
  const dep = HAS_ADR ? fs.readFileSync(path.join(FIX, 'fco-departures.html'), 'utf8') : '';
  const arr = HAS_ADR ? fs.readFileSync(path.join(FIX, 'fco-arrivals.html'), 'utf8') : '';

  it('reads the reported entry total and every row', () => {
    expect(totalEntries(dep)).toBe(1456);
    expect(totalEntries(arr)).toBe(1438);
    expect(parseRows(dep).rows).toHaveLength(8);
    expect(parseRows(dep).issues).toEqual([]);
  });
  it('normalises departures: flight number, codeshare link, other airport, terminal, status, scheduled time', () => {
    const recs = parseRows(dep).rows.map((r) => toRecord(r, AIRPORTS.FCO, 'departure', '2026-10-29').record!);
    const first = recs[0];
    expect(first).toMatchObject({ flightNumber: 'W42032', role: 'operating', destination: 'KRK', origin: 'FCO', terminal: '3', status: 'departed', statusRaw: 'DEPARTED', scheduledUtc: '2026-10-29T04:30:00.000Z' });
    const cs = recs.find((r) => r.role === 'marketing')!;
    expect(cs.operatingFlightNumber).toMatch(/^[A-Z0-9]{2}\d+$/);
    expect(recs.every((r) => r.gate === null)).toBe(true); // the list has no gates
  });
  it('normalises arrivals with origin, and puts an early effective time on the previous day', () => {
    const recs = parseRows(arr).rows.map((r) => toRecord(r, AIRPORTS.FCO, 'arrival', '2026-10-29').record!);
    expect(recs.every((r) => r.origin && r.destination === 'FCO')).toBe(true);
    const t = resolveTimes('2026-10-29', '00:05', '23:58', 'Europe/Rome');
    expect(t.scheduled.toISOString()).toBe('2026-10-28T23:05:00.000Z');
    expect(t.effective!.toISOString()).toBe('2026-10-28T22:58:00.000Z');
  });
  it('reads a gate from a detail page and treats "-" as not assigned', () => {
    expect(parseDetailGate('<p>Terminal: 3</p><p>Check-in: 246</p><p>Gate: A82</p>')).toEqual({ gate: 'A82', terminal: '3' });
    expect(parseDetailGate('<p>Terminal: 1</p><p>Gate: -</p>').gate).toBeNull();
  });
  it('builds full-day list URLs and pages until the reported total is read', async () => {
    expect(listUrl('arrival', '2026-10-29', 2)).toMatch(/tab=arrival.*date=2026-10-29.*orario=00%3A00-24%3A00.*cur=2/);
    const page = dep.replace('of 1,456 entries', 'of 16 entries');
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return new Response(page, { status: 200 }); }) as any;
    const w = adrFco.windows(AIRPORTS.FCO, 'departure', '2026-10-29')[0];
    const r = await adrFco.fetchWindow(AIRPORTS.FCO, w, ctx('2026-10-30T10:00:00Z', f));
    expect(r.ok).toBe(true);
    expect(urls).toHaveLength(2);
    expect(r.rawCount).toBe(16);
  }, 20000);
  it('stops on a bot-protection page instead of retrying or circumventing it', async () => {
    const f = (async () => new Response('<script src="/_Incapsula_Resource?x"></script>', { status: 200 })) as any;
    const w = adrFco.windows(AIRPORTS.FCO, 'departure', '2026-10-29')[0];
    const r = await adrFco.fetchWindow(AIRPORTS.FCO, w, ctx('2026-10-30T10:00:00Z', f));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not circumvented/);
  });
  it('reports a format change when the row structure disappears', () => {
    const p = parseRows('<table><tr class="x"><td>flight-numb but nothing else</td></tr></table>');
    expect(p.issues[0].kind).toBe('format-change');
  });
});

// Synthetic payload built from the documented AeroDataBox schema (AirportFidsContract); no real response is stored.
const ADB = {
  departures: [
    { number: 'AF 1234', status: 'Departed', codeshareStatus: 'IsOperator', isCargo: false, airline: { name: 'Air France', iata: 'AF' }, aircraft: { model: 'Airbus A320' },
      movement: { airport: { iata: 'TLV', icao: 'LLBG' }, scheduledTime: { utc: '2026-10-30 08:00Z', local: '2026-10-30 09:00+01:00' }, revisedTime: { utc: '2026-10-30 08:12Z' }, terminal: '2E', gate: 'K31', quality: ['Basic', 'Live'] } },
    { number: 'DL 8410', status: 'Departed', codeshareStatus: 'IsCodeshared', isCargo: false, airline: { name: 'Delta', iata: 'DL' },
      movement: { airport: { iata: 'TLV' }, scheduledTime: { utc: '2026-10-30 08:00Z' }, terminal: '2E', gate: 'K31', quality: ['Basic'] } },
    { number: 'XX 1', status: 'Wibble', codeshareStatus: 'Unknown', isCargo: false, movement: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-10-30 09:00Z' }, quality: ['Basic'] } },
    { number: 'CARGO1', status: 'Expected', codeshareStatus: 'IsOperator', isCargo: true, movement: { airport: { iata: 'LEJ' }, scheduledTime: { utc: '2026-10-30 09:00Z' }, quality: ['Basic'] } },
    { number: '???', status: 'Expected', codeshareStatus: 'IsOperator', isCargo: false, movement: { airport: { iata: 'LEJ' }, quality: ['Basic'] } },
  ],
  arrivals: [{ number: 'LY 323', status: 'Arrived', codeshareStatus: 'IsOperator', isCargo: false, movement: { airport: { iata: 'TLV' }, scheduledTime: { utc: '2026-10-30 07:00Z' }, revisedTime: { utc: '2026-10-30 06:51Z' }, terminal: '1', gate: null, baggageBelt: '12', quality: ['Basic', 'Live'] } }],
};

describe('AeroDataBox FIDS parser (documented schema)', () => {
  it('maps fields, links a codeshare row to its operator only on an exact match, skips cargo, rejects rows without a schedule', () => {
    const p = parseFids(ADB, AIRPORTS.CDG, 'departure');
    expect(p.rawCount).toBe(5);
    const af = p.records.find((r) => r.flightNumber === 'AF1234')!;
    expect(af).toMatchObject({ role: 'operating', destination: 'TLV', terminal: '2E', gate: 'K31', status: 'departed', actualUtc: '2026-10-30T08:12:00.000Z', codeshares: ['DL8410'] });
    expect(p.records.find((r) => r.flightNumber === 'DL8410')!.operatingFlightNumber).toBe('AF1234');
    expect(p.records.find((r) => r.flightNumber === 'XX1')!.status).toBe('unknown');
    expect(p.records.some((r) => r.flightNumber === 'CARGO1')).toBe(false);
    expect(p.issues.map((i) => i.kind)).toEqual(expect.arrayContaining(['rejected-row', 'unexpected-value']));
  });
  it('links route-less codeshare rows only on a unique time + terminal + gate match, and skips callsign rows (live shapes seen 2026-10-31)', () => {
    const mv = (gate: string | null, iata?: string) => ({ ...(iata ? { airport: { iata } } : {}), scheduledTime: { utc: '2026-10-31 21:40Z' }, terminal: '2', gate, quality: ['Basic'] });
    const body = { departures: [
      { number: 'KL 1001', codeshareStatus: 'IsOperator', status: 'Expected', movement: mv('D55', 'LHR') },
      { number: 'KL 1003', codeshareStatus: 'IsOperator', status: 'Expected', movement: mv('D57', 'MAN') },
      { number: 'MU 1653', codeshareStatus: 'IsCodeshared', status: 'Expected', movement: mv('D57') },   // AMS: no destination
      { number: 'VS 7100', codeshareStatus: 'IsCodeshared', status: 'Expected', movement: mv('D9') },    // no operator at D9
      { number: 'KQ 1', codeshareStatus: 'IsCodeshared', status: 'Expected', movement: mv(null) },       // no gate: never linked
      { number: 'LH 9CP', codeshareStatus: 'IsOperator', status: 'Expected', movement: mv(null, 'FRA') }, // callsign
    ] };
    const p = parseFids(body, AIRPORTS.AMS, 'departure');
    expect(p.records.find((r) => r.flightNumber === 'MU1653')).toMatchObject({ operatingFlightNumber: 'KL1003', destination: 'MAN' });
    expect(p.records.find((r) => r.flightNumber === 'VS7100')!.operatingFlightNumber).toBeNull();
    expect(p.records.find((r) => r.flightNumber === 'KQ1')!.operatingFlightNumber).toBeNull();
    expect(p.records.some((r) => r.flightNumber.startsWith('LH'))).toBe(false);
    expect(p.issues.some((i) => i.kind === 'rejected-row')).toBe(false);
    expect(p.rawCount).toBe(5);
  });
  it('reads arrivals and reports a changed response shape', () => {
    expect(parseFids(ADB, AIRPORTS.CDG, 'arrival').records[0]).toMatchObject({ flightNumber: 'LY323', origin: 'TLV', terminal: '1', baggageBelt: '12', status: 'arrived' });
    expect(parseFids({ data: [] }, AIRPORTS.CDG, 'arrival').issues[0].kind).toBe('format-change');
  });
  it('builds local-time 12-hour windows and is not ready without a key', () => {
    const [w1] = aerodatabox.windows(AIRPORTS.CDG, 'departure', '2026-10-30');
    expect(windowUrl('https://aerodatabox.p.rapidapi.com', AIRPORTS.CDG, w1)).toMatch(/\/flights\/airports\/iata\/CDG\/2026-10-30T00:00\/2026-10-30T11:59\?direction=Both/);
    expect(aerodatabox.notReady({})).toMatch(/FD_AERODATABOX_KEY/);
    expect(aerodatabox.info.rawRetentionDays).toBe(7);
  });
  it('fetches one call for both directions of a window and sends the key only in headers', async () => {
    const calls: { url: string; headers: any }[] = [];
    const f = (async (u: string, init: any) => { calls.push({ url: u, headers: init.headers }); return new Response(JSON.stringify(ADB), { status: 200 }); }) as any;
    const env = { FD_AERODATABOX_KEY: 'k-secret' };
    const [w] = aerodatabox.windows(AIRPORTS.CDG, 'arrival', '2026-11-02');
    const [wd] = aerodatabox.windows(AIRPORTS.CDG, 'departure', '2026-11-02');
    const a = await aerodatabox.fetchWindow(AIRPORTS.CDG, w, ctx('2026-11-02T10:00:00Z', f, env));
    const d = await aerodatabox.fetchWindow(AIRPORTS.CDG, wd, ctx('2026-11-02T10:00:00Z', f, env));
    expect(a.ok && d.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('k-secret');
    expect(calls[0].headers['X-RapidAPI-Key']).toBe('k-secret');
  });
});

// Synthetic payload following the documented Swedavia FlightInfo v2 model (camelCase, as the API is read case-insensitively).
const SWE = { from: { departureAirportIata: 'ARN' }, numberOfFlights: 2, flights: [
  { flightId: 'SK1415', airlineOperator: { iata: 'SK', name: 'SAS' }, departureTime: { scheduledUtc: '2026-10-30T06:00:00Z', estimatedUtc: '2026-10-30T06:10:00Z', actualUtc: '2026-10-30T06:14:00Z' },
    locationAndStatus: { terminal: '5', gate: 'F36', flightLegStatus: 'ACT', flightLegStatusEnglish: 'Departed' }, codeShareData: ['LH6003', 'TG 6234'], flightLegIdentifier: { arrivalAirportIata: 'CPH', ifplId: 'AA123' } },
  { FlightId: 'DY4321', DepartureTime: { ScheduledUtc: '2026-10-30T22:30:00Z' }, LocationAndStatus: { Terminal: 'T2', Gate: null, FlightLegStatus: 'CAN' }, FlightLegIdentifier: { ArrivalAirportIata: 'OSL' } },
] };

describe('Swedavia FlightInfo parser (documented model)', () => {
  it('maps terminal, gate, codeshares and status in either key casing', () => {
    const p = parseFlightInfo(SWE, AIRPORTS.ARN, 'departure');
    expect(p.records[0]).toMatchObject({ flightNumber: 'SK1415', terminal: '5', gate: 'F36', destination: 'CPH', status: 'departed', codeshares: ['LH6003', 'TG6234'] });
    expect(p.records[1]).toMatchObject({ flightNumber: 'DY4321', terminal: '2', gate: null, status: 'cancelled' });
  });
  it('covers a Stockholm local day with the two UTC dates it spans', () => {
    const ws = swedavia.windows(AIRPORTS.ARN, 'departure', '2026-10-30');
    expect(ws.map((w) => w.label)).toEqual(['departure:2026-10-30#utc-2026-10-29', 'departure:2026-10-30#utc-2026-10-30']);
    expect(ws[0].fromUtc).toBe('2026-10-29T23:00:00.000Z');
    expect(ws[1].toUtc).toBe('2026-10-30T23:00:00.000Z');
  });
});

describe('registry', () => {
  it('rejects unknown pairings', () => {
    expect(() => resolveAssignments([{ airport: 'CDG', source: 'swedavia' }])).toThrow(/does not cover/);
    expect(() => resolveAssignments([{ airport: 'XXX', source: 'aerodatabox' }])).toThrow(/unknown airport/);
    expect(resolveAssignments([{ airport: 'FCO', source: 'adr-fco-web' }])[0].adapter.info.permission).toBe('pending-owner-approval');
  });
});

describe('licence retention: roll-up then purge', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(':memory:'); await upsertAirport(db, AIRPORTS.CDG, true); });
  afterEach(async () => { await db.close(); });

  it('rolls flight-days older than the limit into monthly counters and deletes the raw rows, once', async () => {
    const ad = fixtureAdapter((w) => ({ ok: true, records: [rec({ flightNumber: 'AF1234', role: 'operating', scheduledUtc: `${w.localDate}T10:00:00Z`, terminal: '2E', gate: 'K31', destination: 'TLV', codeshares: ['DL8410'] })] }), { id: 'limited', rawRetentionDays: 7 });
    await upsertSource(db, ad.info);
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-20'])
      await collect(db, { airport: AIRPORTS.CDG, adapter: ad, direction: 'departure', targetDate: d, slot: `${d} 07:00`, trigger: 'schedule' }, ctx(`${d}T06:00:00Z`));
    const r1 = await sweepRetention(db, new Date('2026-10-22T00:00:00Z'));
    expect(r1.find((x) => x.source === 'limited')!.flightsRolled).toBe(2);
    expect((await db.query('SELECT local_date::text d FROM fd_flights')).map((x) => x.d)).toEqual(['2026-10-20']);
    const counts = await db.query("SELECT field, value, n FROM fd_derived_counts WHERE flight_key='AF1234' ORDER BY field, value");
    expect(counts).toEqual([{ field: 'code', value: 'DL8410', n: 2 }, { field: 'flight-days', value: 'all', n: 2 }, { field: 'gate', value: 'K31', n: 2 }, { field: 'terminal', value: '2E', n: 2 }]);
    // The counters feed predict(), also through the codeshare number, and only for months before the date's month.
    const p = await predict(db, { airport: 'CDG', flight: 'DL8410', date: '2026-11-05', direction: 'departure' });
    // 2 rolled-up flight-days (counters) + 1 raw flight-day (2026-10-20, still within the licence window).
    expect(p.historical.terminals).toEqual([{ value: '2E', n: 3, share: 1 }]);
    expect(p.historical.totalFlightDays).toBe(3);
    expect(p.notes.join(' ')).toMatch(/monthly counters/);
    const same = await predict(db, { airport: 'CDG', flight: 'AF1234', date: '2026-10-25', direction: 'departure' });
    // Same month as the counters: they are excluded (no leakage); only the raw 2026-10-20 flight-day counts.
    expect(same.historical.terminals).toEqual([{ value: '2E', n: 1, share: 1 }]);
    expect(same.historical.totalFlightDays).toBe(1);
    const r2 = await sweepRetention(db, new Date('2026-10-22T00:00:00Z'));
    expect(r2.find((x) => x.source === 'limited')!.flightsRolled).toBe(0);
    expect((await db.query("SELECT n FROM fd_derived_counts WHERE field='flight-days'"))[0].n).toBe(2);
  });
  it('never purges sources without a licence limit', async () => {
    const ad = fixtureAdapter(() => ({ ok: true, records: [rec({ flightNumber: 'AF1', role: 'operating', scheduledUtc: '2026-01-01T10:00:00Z' })] }), { id: 'open' });
    await upsertSource(db, ad.info);
    await collect(db, { airport: AIRPORTS.CDG, adapter: ad, direction: 'departure', targetDate: '2026-01-01', slot: '2026-01-01 07:00', trigger: 'schedule' }, ctx('2026-01-01T06:00:00Z'));
    await sweepRetention(db, new Date('2026-10-22T00:00:00Z'));
    expect((await db.query('SELECT count(*)::int n FROM fd_observations'))[0].n).toBe(1);
  });
});

describe('research API', () => {
  let db: Db; let server: http.Server; let base = '';
  beforeEach(async () => {
    db = await openDb(':memory:'); await upsertAirport(db, AIRPORTS.CDG, true);
    const ad = fixtureAdapter(() => ({ ok: true, records: [rec({ flightNumber: 'AF1234', role: 'operating', scheduledUtc: '2026-10-30T10:00:00Z', terminal: '2E', gate: 'K31' })] }));
    await upsertSource(db, ad.info);
    await collect(db, { airport: AIRPORTS.CDG, adapter: ad, direction: 'departure', targetDate: '2026-10-30', slot: '2026-10-30 07:00', trigger: 'schedule' }, ctx('2026-10-30T06:00:00Z'));
    server = http.createServer(createFdApp({ db, adminToken: 'tok' }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => { server.close(); await db.close(); });
  const get = (p: string, token = 'tok') => fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });

  it('requires the admin token except for health', async () => {
    expect((await fetch(base + '/fd-api/health')).status).toBe(200);
    expect((await get('/fd-api/overview', 'wrong')).status).toBe(401);
  });
  it('serves overview, runs, flights, history, stats, quality and prediction', async () => {
    const ov = await (await get('/fd-api/overview')).json();
    expect(ov.airports.find((a: any) => a.iata === 'CDG').flights).toBe(1);
    const runs = await (await get('/fd-api/runs?airport=CDG')).json();
    expect(runs.runs).toHaveLength(1);
    const fl = await (await get('/fd-api/flights?airport=CDG&direction=departure&flight=AF1234')).json();
    expect(fl.flights[0]).toMatchObject({ flight_key: 'AF1234', terminal: '2E', gate: 'K31' });
    const h = await (await get(`/fd-api/flights/${fl.flights[0].id}`)).json();
    expect(h.observations).toHaveLength(1);
    const dist = await (await get('/fd-api/stats/distribution?airport=CDG&direction=departure&field=gate&groupBy=flight_key')).json();
    expect(dist.groups[0].values[0].value).toBe('K31');
    expect((await get('/fd-api/stats/completeness?airport=CDG&direction=departure')).status).toBe(200);
    expect((await get('/fd-api/quality?airport=CDG')).status).toBe(200);
    const p = await (await get('/fd-api/predict?airport=CDG&direction=departure&flight=AF1234&date=2026-11-05')).json();
    expect(p.historical.confidence).toBe('insufficient-sample');
  });
  it('validates input', async () => {
    expect((await get('/fd-api/flights?airport=CDG&direction=sideways')).status).toBe(400);
    expect((await get('/fd-api/flights?airport=CDG&from=yesterday')).status).toBe(400);
    expect((await get('/fd-api/stats/distribution?airport=CDG&groupBy=drop table')).status).toBe(400);
    expect((await get('/fd-api/predict?airport=CDG&flight=AF1')).status).toBe(400);
  });
});

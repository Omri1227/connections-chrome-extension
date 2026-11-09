// Public gate service (owner decision D2, 2026-11-02): one value per flight number, airport and direction — the gate
// used on the most flight-days of the last 30 days — and a public server that only reads the snapshot file.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../flightdata/src/db.ts';
import { fixtureAdapter, rec } from '../flightdata/src/adapters/fixture.ts';
import { collect } from '../flightdata/src/collector.ts';
import { upsertAirport, upsertSource } from '../flightdata/src/store.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { buildPublicSnapshot, dbSource, NO_PUBLIC_GATES, PUBLIC_GATE_AIRPORTS, publicAnswer, topGate, type GateSource, type PublicSnapshot } from '../flightdata/src/public-gates.ts';
import { createPublicApp, normFlight } from '../flightdata/public/server.ts';
import type { FetchContext, NormalizedFlight } from '../flightdata/src/types.ts';

const ctxAt = (iso: string): FetchContext => ({ fetch: (() => { throw new Error('no network in tests'); }) as any, now: () => new Date(iso), env: {}, log: () => {} });
// 40 days: 2026-09-22 … 2026-10-31; the snapshot is built on 2026-11-01 → window 2026-10-02 … 2026-10-31
const DAYS = Array.from({ length: 40 }, (_, i) => new Date(Date.parse('2026-09-22T00:00:00Z') + i * 864e5).toISOString().slice(0, 10));
const NOW = new Date('2026-11-01T08:00:00Z');

describe('most-used gate', () => {
  it('needs the minimum of flight-days with a gate; ties go to the alphabetically first gate', () => {
    expect(topGate([{ value: 'Z25', n: 4 }])).toBeNull();
    expect(topGate([{ value: 'Z25', n: 3 }, { value: 'A1', n: 3 }])).toEqual({ gate: 'A1', gateDays: 3, known: 6 });
    expect(topGate([{ value: 'B44', n: 2 }, { value: 'Z25', n: 7 }])).toMatchObject({ gate: 'Z25' });
  });
});

describe('public snapshot from the database', () => {
  let db: Db, snap: PublicSnapshot;
  beforeAll(async () => {
    db = await openDb(':memory:');
    await upsertAirport(db, AIRPORTS.FRA, true);
    const ad = fixtureAdapter((w) => {
      const i = DAYS.indexOf(w.localDate), d = w.localDate;
      if (i < 0 || !w.label.endsWith('#1') || w.direction !== 'departure') return { ok: true, records: [] };
      // LH400: Z25 on the first 10 days (outside the window), then Z50 ×14 and Z25 ×6 inside it; cancelled on 2 days at B44
      // LH900: only 3 flight-days with a gate (below the minimum); LH123: never a gate
      const r: NormalizedFlight[] = [
        rec({ flightNumber: 'LH400', airport: 'FRA', origin: 'FRA', role: 'operating', destination: 'JFK', scheduledUtc: `${d}T06:00:00Z`, terminal: '1', gate: i < 10 ? 'Z25' : i < 24 ? 'Z50' : i < 30 ? 'Z25' : i < 38 ? 'Z50' : 'B44', status: i >= 38 ? 'cancelled' : 'departed', codeshares: ['UA8840'] }),
        ...(i >= 37 ? [rec({ flightNumber: 'LH900', airport: 'FRA', origin: 'FRA', role: 'operating', destination: 'LHR', scheduledUtc: `${d}T07:00:00Z`, terminal: '1', gate: 'A26' })] : []),
        rec({ flightNumber: 'LH123', airport: 'FRA', origin: 'FRA', role: 'operating', destination: 'CDG', scheduledUtc: `${d}T08:00:00Z`, terminal: '1', gate: null }),
      ];
      return { ok: true, records: r };
    });
    await upsertSource(db, ad.info);
    for (const d of DAYS) await collect(db, { airport: AIRPORTS.FRA, adapter: ad, direction: 'departure', targetDate: d, slot: `${d} 07:00`, trigger: 'schedule' }, ctxAt(`${d}T05:00:00Z`));
    snap = await buildPublicSnapshot(dbSource(db), { now: NOW, airports: ['FRA'] });
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('uses the last 30 days only, one value per flight, cancelled days excluded', () => {
    expect(snap.window).toEqual({ days: 30, from: '2026-10-02', to: '2026-10-31' });
    // inside the window: Z50 on 10-02…10-15 (14) and 10-22…10-29 (8) = 22, Z25 on 10-16…10-21 (6); B44 only cancelled
    expect(snap.flights.LH400).toEqual([{ airport: 'FRA', direction: 'departure', gate: 'Z50', gateDays: 22, flightDays: 28 }]);
  });
  it('codeshare numbers point at the operating flight; too few days or no gate → not listed', () => {
    expect(snap.flights.UA8840).toEqual([{ airport: 'FRA', direction: 'departure', gate: 'Z50', gateDays: 22, flightDays: 28, operatedAs: 'LH400' }]);
    expect(snap.flights.LH900).toBeUndefined();
    expect(snap.flights.LH123).toBeUndefined();
  });
  it('the public answer carries the gate and nothing about individual days', () => {
    const a = publicAnswer(snap, { flight: 'LH400' });
    expect(a).toMatchObject({ flight: 'LH400', found: true, results: [{ airport: 'FRA', direction: 'departure', gate: 'Z50', flightDays: 28 }] });
    expect(JSON.stringify(a)).not.toMatch(/2026-10-1\d|scheduled|terminal"/);
    expect(publicAnswer(snap, { flight: 'LH400', direction: 'arrival' }).found).toBe(false);
  });
});

describe('public snapshot airports (LHR replaces IST, 2026-11-02)', () => {
  // a source that would return a gate for every airport asked
  const asked: string[] = [];
  const src: GateSource = {
    distribution: async (airport) => { asked.push(airport); return [{ group: 'XX1', total: 9, values: [{ value: 'B7', n: 9 }] }]; },
    codes: async () => [],
  };
  it('covers the product airports with gates only: never LHR (no gates in the source), no longer IST', async () => {
    asked.length = 0;
    const s = await buildPublicSnapshot(src, { now: NOW });
    expect([...new Set(asked)].sort()).toEqual([...PUBLIC_GATE_AIRPORTS].sort());
    expect(s.flights.XX1.map((e) => e.airport)).not.toContain('LHR');
    expect(s.flights.XX1.map((e) => e.airport)).not.toContain('IST');
    expect(s.notes.some((n) => n.startsWith('LHR: no gates'))).toBe(true);
  });
  it('an explicit request for LHR still yields no LHR gate', async () => {
    asked.length = 0;
    const s = await buildPublicSnapshot(src, { now: NOW, airports: ['LHR', 'FRA'] });
    expect(asked).not.toContain('LHR');
    expect(Object.keys(NO_PUBLIC_GATES)).toContain('LHR');
    expect(s.flights.XX1.map((e) => e.airport)).toEqual(['FRA', 'FRA']);
  });
});

describe('public server (snapshot only)', () => {
  const snap: PublicSnapshot = { version: 1, generatedAt: '2026-11-01T08:00:00.000Z', window: { days: 30, from: '2026-10-02', to: '2026-10-31' }, minDays: 5, notes: ['n'],
    flights: { LH400: [{ airport: 'FRA', direction: 'departure', gate: 'Z50', gateDays: 22, flightDays: 28 }] } };
  const start = async (o: Partial<Parameters<typeof createPublicApp>[0]> = {}) => {
    const s = http.createServer(createPublicApp({ load: () => snap, ...o }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };
  it('answers a flight number in any common spelling, with CORS and caching', async () => {
    const { s, base } = await start();
    try {
      expect(normFlight('lh 0400')).toBe('LH400');
      const r = await fetch(`${base}/v1/gate?flight=lh%200400`);
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('cache-control')).toMatch(/max-age=3600/);
      expect((await r.json()).results).toEqual([{ airport: 'FRA', direction: 'departure', gate: 'Z50', flightDays: 28 }]);
      expect((await (await fetch(`${base}/v1/gate?flight=XX1`)).json()).found).toBe(false);
      expect((await fetch(`${base}/v1/gate?flight=%3Cscript%3E`)).status).toBe(400);
      expect((await fetch(`${base}/v1/gate`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${base}/fd-api/overview`)).status).toBe(404);
    } finally { s.close(); }
  });
  it('API keys (when configured), rate limit and no-data state', async () => {
    let t = 0;
    const { s, base } = await start({ apiKeys: ['k1'], ratePerMinute: 2, now: () => t });
    try {
      expect((await fetch(`${base}/v1/gate?flight=LH400`)).status).toBe(401);
      expect((await fetch(`${base}/v1/gate?flight=LH400`, { headers: { 'X-API-Key': 'k1' } })).status).toBe(200);
      expect((await fetch(`${base}/v1/gate?flight=LH400`, { headers: { 'X-API-Key': 'k1' } })).status).toBe(429);
      t += 60_000;
      expect((await fetch(`${base}/v1/gate?flight=LH400`, { headers: { 'X-API-Key': 'k1' } })).status).toBe(200);
    } finally { s.close(); }
    const empty = await start({ load: () => null });
    try { expect((await fetch(`${empty.base}/v1/health`)).status).toBe(503); expect((await fetch(`${empty.base}/v1/gate?flight=LH400`)).status).toBe(503); } finally { empty.s.close(); }
  });
});

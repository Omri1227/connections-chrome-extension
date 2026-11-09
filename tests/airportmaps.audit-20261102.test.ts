// Cross-airport routing audit 2026-11-02 (docs/REMAINING_AIRPORT_ROUTING_GAPS.md, docs/TRANSFER_TIME_CALCULATION_AUDIT.md).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findRoute, findSelfTransfer, needsTransferScreening, zoneOn } from '../airportmaps/src/route.ts';
import type { AirportModel } from '../airportmaps/src/types.ts';

const load = (iata: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'airportmaps', 'data', iata, 'airport.json'), 'utf8')) as AirportModel;
const SEVEN = ['cdg', 'fra', 'ams', 'fco', 'mad', 'zrh', 'muc'];
const date = '2026-11-10';
const TLV = { transfer: true, fromArrival: true, date, originAirport: 'TLV', originCountry: 'IL' };
const JFK = { transfer: true, fromArrival: true, date, originAirport: 'JFK', originCountry: 'US' };
const screens = (r: ReturnType<typeof findRoute>) => !!r?.steps.some((s) => s.control && (s.control.kind === 'security' || s.control.kind === 'transfer-security'));

describe('AU-1: transfer screening for origins outside one-stop security is never skipped (EU 300/2008 Annex 4.1)', () => {
  for (const iata of SEVEN) it(`${iata.toUpperCase()}: every protected non-Schengen-arrival pair from TLV passes a screening`, () => {
    const m = load(iata);
    const gated = new Set(m.gateGroups.filter((g) => g.gates.length).map((g) => g.area));
    const areas = m.areas.filter((a) => a.side === 'airside' && gated.has(a.id));
    for (const a of areas.filter((x) => zoneOn(x, date) !== 'schengen')) for (const d of areas) {
      const r = findRoute(m, a.id, d.id, TLV);
      if (r) expect(screens(r), `${a.id} -> ${d.id}`).toBe(true);
    }
  });
  it('the guard applies only to protected arrivals from origins not covered (or unknown)', () => {
    const m = load('ams');
    expect(needsTransferScreening(m, 'ams-d-n', 'ams-e', TLV)).toBe(true);
    expect(needsTransferScreening(m, 'ams-d-n', 'ams-e', JFK)).toBe(false);
    expect(needsTransferScreening(m, 'ams-d-n', 'ams-e', { transfer: true })).toBe(true);           // origin unknown: assumed
    expect(needsTransferScreening(m, 'ams-d-n', 'ams-e', { ...TLV, transfer: false })).toBe(false);
    expect(needsTransferScreening(m, 'ams-d-n', 'ams-e', { ...TLV, fromArrival: false })).toBe(false);
    expect(needsTransferScreening(m, 'ams-d-s', 'ams-b', { transfer: true })).toBe(false);          // Schengen arrival
  });
  it('AMS D-lower: no modelled checkpoint, so the airport\'s own transfer-filter allowance is added as an unplaced step', () => {
    const m = load('ams');
    const r = findRoute(m, 'ams-d-n', 'ams-e', TLV)!, u = findRoute(m, 'ams-d-n', 'ams-e', JFK)!;
    const st = r.steps.find((s) => s.refId?.startsWith('unplaced-transfer-security'))!;
    expect(st.minutes).toMatchObject({ min: 5, typical: 15, max: 40 });
    expect(st.confidence).toBe('unknown');
    expect(r.issues.map((i) => i.code)).toContain('transfer-screening-unplaced');
    expect(r.total.typical).toBeCloseTo(u.total.typical + 15, 5);
    expect(screens(u)).toBe(false);                       // US origin: one-stop, no screening
  });
  it('ZRH E → E from TLV goes through the Airside Center transfer security (the model\'s own checkpoint), JFK stays in Dock E', () => {
    const m = load('zrh');
    const r = findRoute(m, 'zrh-e', 'zrh-e', TLV)!;
    expect(r.lines).toEqual(['l:zrh-skymetro']);
    expect(r.controls).toEqual(['transfer-security']);
    expect(r.issues.map((i) => i.code)).toContain('transfer-screening-route');
    expect(findRoute(m, 'zrh-e', 'zrh-e', JFK)!.lines).toEqual([]);
  });
  it('FCO E11-24 → A21-27 from TLV uses the T3 arrivals / transfer level (passport + transfer security)', () => {
    const r = findRoute(load('fco'), 'fco-e11-24', 'fco-a21-27', TLV)!;
    expect(r.steps.map((s) => s.refId)).toContain('w:fco-e1124-t3arr');
    expect(r.controls).toEqual(['passport', 'transfer-security']);
  });
  it('a same-area loop through another gate area is rejected (CDG 2B → 2B does not ride the shuttle to 2E and back)', () => {
    const r = findRoute(load('cdg'), 'cdg-2b', 'cdg-2b', TLV)!;
    expect(r.lines).toEqual([]);
    expect(r.issues.map((i) => i.code)).toContain('transfer-screening-unplaced');
  });
  it('a round trip through another gate area is rejected (MUC T2 H → L does not ride the bus to T1 and back); a pass back through a transfer hub is kept (FCO E1-8 → T3 transfer level → E11-24)', () => {
    const r = findRoute(load('muc'), 'muc-t2-h', 'muc-sat-l', TLV)!;
    expect(r.lines).not.toContain('l:muc-bus-nonschengen');
    expect(r.issues.map((i) => i.code)).toContain('transfer-screening-unplaced');
    const f = findRoute(load('fco'), 'fco-e1-8', 'fco-e11-24', TLV)!;
    expect(f.issues.map((i) => i.code)).toContain('transfer-screening-route');
  });
  it('self-transfers are not affected (they pass the normal departure security)', () => {
    const m = load('ams');
    const s = findSelfTransfer(m, 'ams-d-n', 'ams-e', { date, originAirport: 'TLV', originCountry: 'IL' })!;
    expect(s.steps.some((x) => x.refId?.startsWith('unplaced-transfer-security'))).toBe(false);
  });
});

describe('AU-2 / AU-3: a self-transfer from a non-Schengen arrival passes its own reclaim and customs', () => {
  for (const iata of SEVEN) it(`${iata.toUpperCase()}: entry passport, reclaim and customs before the check-in; security after it`, () => {
    const m = load(iata);
    const gated = new Set(m.gateGroups.filter((g) => g.gates.length).map((g) => g.area));
    const areas = m.areas.filter((a) => a.side === 'airside' && gated.has(a.id));
    for (const a of areas.filter((x) => zoneOn(x, date) === 'non-schengen')) for (const d of areas) {
      const r = findSelfTransfer(m, a.id, d.id, { date, originAirport: 'TLV', originCountry: 'IL' });
      if (!r) continue;
      const k = r.checkIn!.step, before = r.steps.slice(0, k), after = r.steps.slice(k + 1);
      const kinds = before.map((s) => s.control?.kind ?? s.kind);
      expect(kinds, `${a.id} -> ${d.id}`).toContain('passport');
      expect(kinds.indexOf('reclaim'), `${a.id} -> ${d.id}`).toBeLessThan(kinds.indexOf('customs'));
      expect(kinds.indexOf('passport'), `${a.id} -> ${d.id}`).toBeLessThan(kinds.indexOf('reclaim'));
      expect(after.some((s) => s.control?.kind === 'security' || s.control?.kind === 'transfer-security'), `${a.id} -> ${d.id}`).toBe(true);
    }
  });
  it('FRA Z → A: the bags are collected through the Z arrivals exit, not by walking airside into Schengen A first', () => {
    const r = findSelfTransfer(load('fra'), 'fra-t1-z', 'fra-t1-a', { date, originAirport: 'TLV', originCountry: 'IL' })!;
    expect(r.steps[0].refId).toBe('w:fra-z-hall-arr');
    expect(r.issues.map((i) => i.code)).not.toContain('customs-not-modelled');
  });
  it('MAD T4S → T4: a protected transfer leaves baggage hall 10 by the connection security, without customs', () => {
    const r = findRoute(load('mad'), 'mad-t4s-s', 'mad-t4-hjk', TLV)!;
    expect(r.controls).not.toContain('customs');
  });
});

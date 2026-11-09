// Airline → terminal fallback (LHR, Heathrow's official terminal finder): used only without history and without a
// value published for the day; an ESTIMATE (no percentage); never for codeshares ("operated by"); other airports
// (no `airlineTerminals`) unchanged.
import { describe, expect, it } from 'vitest';
import { analyzeConnection } from '../extension/src/core/analyze.ts';
import { FixtureHistory } from '../extension/src/core/history.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas } from '../extension/src/core/resolve.ts';
import { summarisePlace } from '../extension/src/core/summary.ts';
import type { Leg } from '../extension/src/core/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';

const D = '2026-11-18';
const LHR = MODELS.LHR;
const leg = (fn: string, from: string, to: string, dep: string, arr: string, operatedBy: string | null = null): Leg =>
  ({ flightNumber: fn, altNumbers: [], airline: null, operatedBy, from, to, depDate: D, depTime: dep, arrDate: D, arrTime: arr });
const noHistory = new FixtureHistory(() => null);
const ids = (r: ReturnType<typeof resolveAreas>) => r.candidates.map((c) => c.area.id).sort();

describe('LHR airline terminal fallback', () => {
  it('BA to Tel Aviv departs T5 (estimated, terminal group, no percentage)', () => {
    const r = resolveAreas(LHR, { direction: 'departure', other: 'TLV', answer: null, date: D, flight: { airline: 'BA' } });
    expect(r.provenance).toBe('estimated');
    expect(r.basis).toBe('airline-terminal');
    expect(ids(r)).toEqual(['lhr-t5a', 'lhr-t5b', 'lhr-t5c']);
    expect(r.areaLevel).toBe(false);
    const s = summarisePlace(r);
    expect(s.top.every((o) => o.p === null)).toBe(true);
    expect(s.basisText).toMatch(/typical terminal for this airline/);
  });
  it('BA to a T3 destination (Prague) uses T3; El Al from Tel Aviv arrives at T4', () => {
    expect(ids(resolveAreas(LHR, { direction: 'departure', other: 'PRG', answer: null, date: D, flight: { airline: 'BA' } }))).toEqual(['lhr-t3']);
    expect(ids(resolveAreas(LHR, { direction: 'arrival', other: 'TLV', answer: null, date: D, flight: { airline: 'LY' } }))).toEqual(['lhr-t4']);
  });
  it('codeshares and unknown airlines stay unknown', () => {
    expect(resolveAreas(LHR, { direction: 'departure', other: 'JFK', answer: null, date: D, flight: { airline: 'AA', operatedByOther: true } }).provenance).toBe('unknown');
    expect(resolveAreas(LHR, { direction: 'departure', other: 'JFK', answer: null, date: D, flight: { airline: 'ZZ' } }).provenance).toBe('unknown');
  });
  it('airports without a published allocation are unchanged', () => {
    expect(MODELS.CDG.airlineTerminals).toBeUndefined();
    expect(resolveAreas(MODELS.CDG, { direction: 'departure', other: 'JFK', answer: null, date: D, flight: { airline: 'AF' } }).provenance).toBe('unknown');
  });
  it('end to end: VS (T3) → BA (T5) without history names both terminals and says why', async () => {
    const a = await analyzeConnection({ airport: 'LHR', inbound: leg('VS4', 'JFK', 'LHR', '19:00', '07:00'), outbound: leg('BA404', 'LHR', 'TLV', '10:30', '17:30'), selfTransfer: false },
      { models: MODELS, history: noHistory, today: D });
    expect(a.arrival!.basis).toBe('airline-terminal');
    expect(ids(a.arrival!)).toEqual(['lhr-t3']);
    expect(a.departure!.basis).toBe('airline-terminal');
    expect(a.unknowns.join(' ')).toMatch(/published terminal, not a prediction/);
    expect(a.assessment!.combos.every((c) => c.arrival.area.id === 'lhr-t3' && c.departure.area.id.startsWith('lhr-t5'))).toBe(true);
  });
  it('a codeshare leg ("Operated by …") is not given the marketing airline\'s terminal', async () => {
    const a = await analyzeConnection({ airport: 'LHR', inbound: leg('AA6150', 'JFK', 'LHR', '19:00', '07:00', 'British Airways'), outbound: leg('BA404', 'LHR', 'TLV', '10:30', '17:30'), selfTransfer: false },
      { models: MODELS, history: noHistory, today: D });
    expect(a.arrival!.provenance).toBe('unknown');
  });
  it('the LHR model with the allocation validates', () => {
    expect(validateAirport(LHR).errors).toEqual([]);
  });
});

// Connection analysis: history → candidate areas → routes on the airport model → indicative assessment.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeConnection, connectionsOf } from '../extension/src/core/analyze.ts';
import { FixtureHistory, LocalServerHistory, type FieldAnswer, type FlightAnswer, type ConnectionAnswer } from '../extension/src/core/history.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas } from '../extension/src/core/resolve.ts';
import { assessTransfer } from '../extension/src/core/assess.ts';
import { parseSkyscannerText } from '../extension/src/core/skyscanner.ts';
import { FORBIDDEN_WORDS } from '../extension/src/core/summary.ts';

const fx = (f: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'extension', f), 'utf8').replace(/^﻿/, '');
const TODAY = '2026-10-31';

function field(dist: [string, number][], status?: FieldAnswer['status']): FieldAnswer {
  const sample = dist.reduce((s, [, n]) => s + n, 0);
  const st = status ?? (sample >= 5 ? 'predicted' : sample ? 'insufficient-data' : 'no-data');
  return { status: st, value: st === 'predicted' ? dist[0][0] : null, confidence: st === 'predicted' ? 'medium' : null, confidenceScore: null, interval: null, sample,
    distribution: dist.map(([value, n]) => ({ value, n, share: sample >= 5 ? n / sample : null })), alternatives: [] };
}
function flight(p: Partial<FlightAnswer> & { flight: string; airport: string; direction: 'arrival' | 'departure'; date: string }): FlightAnswer {
  return { status: 'ok', terminal: field([]), gateArea: field([]), gate: field([]), sameDay: null,
    basis: { windowDays: 30, flightDays: 30, fromCounters: 0, cancelled: 0, period: { from: '2026-10-01', to: '2026-10-30' }, sources: ['aerodatabox'], lastRefresh: null }, notes: [], ...p };
}
const answer = (arrival: FlightAnswer, departure: FlightAnswer): ConnectionAnswer => ({ query: { arrivalFlight: arrival.flight, departureFlight: departure.flight, date: arrival.date, departureDate: departure.date, airport: arrival.airport },
  status: 'ok', airport: arrival.airport, airportCandidates: [arrival.airport], arrival, departure, sameTerminalHistorically: null, notes: [] });

describe('candidate areas from history', () => {
  const cdg = MODELS.CDG;
  it('terminal 2E from a non-Schengen origin → the three 2E concourses; 2F to a Schengen destination → 2F', () => {
    const arr = resolveAreas(cdg, { direction: 'arrival', other: 'TLV', date: '2026-11-04', answer: flight({ flight: 'AF1621', airport: 'CDG', direction: 'arrival', date: '2026-11-04', terminal: field([['2E', 27], ['2F', 3]]) }) });
    expect(arr).toMatchObject({ zone: 'non-schengen', provenance: 'predicted', basis: 'terminal', sample: 30 });
    expect(arr.candidates.map((c) => c.area.id).sort()).toEqual(['cdg-2e-k', 'cdg-2e-l', 'cdg-2e-m']);   // 2F is Schengen-only: filtered out by zone
    const dep = resolveAreas(cdg, { direction: 'departure', other: 'AMS', date: '2026-11-04', answer: flight({ flight: 'AF1240', airport: 'CDG', direction: 'departure', date: '2026-11-04', terminal: field([['2F', 20], ['2G', 4]]) }) });
    expect(dep.candidates.map((c) => [c.area.id, Number(c.p.toFixed(2))])).toEqual([['cdg-2f', 0.83], ['cdg-2g', 0.17]]);
  });
  it('gate history maps through the gate list; gate areas by letter (AMS D split by zone)', () => {
    const ams = MODELS.AMS;
    const g = resolveAreas(ams, { direction: 'departure', other: 'JFK', date: '2026-11-04', answer: flight({ flight: 'KL641', airport: 'AMS', direction: 'departure', date: '2026-11-04', gate: field([['E7', 6], ['F4', 3], ['E9', 1]]) }) });
    expect(g.basis).toBe('gate');
    expect(g.candidates.map((c) => [c.area.id, Number(c.p.toFixed(1))])).toEqual([['ams-e', 0.7], ['ams-f', 0.3]]);
    const d = resolveAreas(ams, { direction: 'departure', other: 'LHR', date: '2026-11-04', answer: flight({ flight: 'KL1001', airport: 'AMS', direction: 'departure', date: '2026-11-04', gateArea: field([['D', 8]]) }) });
    expect(d).toMatchObject({ basis: 'gate-area', zone: 'non-schengen' });
    expect(d.candidates.map((c) => c.area.id)).toEqual(['ams-d-n']);
  });
  it('a gate published for the day is observed, not predicted', () => {
    const r = resolveAreas(MODELS.FRA, { direction: 'departure', other: 'JFK', date: '2026-11-04', answer: flight({ flight: 'LH400', airport: 'FRA', direction: 'departure', date: '2026-11-04', sameDay: { terminal: '1', gate: 'Z25', gateArea: 'Z', status: 'scheduled', observedAt: '2026-11-04T08:00:00Z', source: 'aerodatabox' } }) });
    expect(r).toMatchObject({ provenance: 'observed', basis: 'published-gate' });
    expect(r.candidates.map((c) => c.area.id)).toEqual(['fra-t1-z']);
  });
  it('no history → every plausible area of the zone, marked unknown', () => {
    const r = resolveAreas(MODELS.CDG, { direction: 'arrival', other: 'TLV', date: '2026-11-04', answer: null });
    expect(r.provenance).toBe('unknown');
    expect(r.candidates.length).toBeGreaterThan(3);
    expect(r.candidates.every((c) => c.area.zone === 'non-schengen' || c.area.zone === 'mixed')).toBe(true);
  });
});

describe('transfer assessment', () => {
  const cdg = MODELS.CDG;
  const arr = resolveAreas(cdg, { direction: 'arrival', other: 'TLV', date: '2026-11-04', answer: flight({ flight: 'AF1621', airport: 'CDG', direction: 'arrival', date: '2026-11-04', terminal: field([['2E', 30]]) }) });
  const dep = resolveAreas(cdg, { direction: 'departure', other: 'AMS', date: '2026-11-04', answer: flight({ flight: 'AF1240', airport: 'CDG', direction: 'departure', date: '2026-11-04', terminal: field([['2F', 30]]) }) });
  it('routes every combination (2E concourses → 2F), with passport control, and never says guaranteed', () => {
    const a = assessTransfer(cdg, arr, dep, { scheduledMinutes: 95, selfTransfer: false, date: '2026-11-04' });
    expect(a.combos).toHaveLength(3);
    expect(a.combos.every((c) => c.route && c.route.controls.includes('passport'))).toBe(true);
    // R-39: an explicit forbidden-word list (the former regex matched "(not a guarantee)" and passed by accident)
    for (const v of [95, 240, 20]) expect(assessTransfer(cdg, arr, dep, { scheduledMinutes: v, selfTransfer: false, date: '2026-11-04' }).verdictText).not.toMatch(FORBIDDEN_WORDS);
    expect(['comfortable', 'tight', 'risky']).toContain(a.verdict);
  });
  it('a short connection is risky, a long one comfortable, an unknown time is not assessed', () => {
    expect(assessTransfer(cdg, arr, dep, { scheduledMinutes: 35, selfTransfer: false, date: '2026-11-04' }).verdict).toBe('risky');
    expect(assessTransfer(cdg, arr, dep, { scheduledMinutes: 240, selfTransfer: false, date: '2026-11-04' }).verdict).toBe('comfortable');
    expect(assessTransfer(cdg, arr, dep, { scheduledMinutes: null, selfTransfer: false, date: '2026-11-04' }).verdict).toBe('not-assessed');
  });
  it('a self-transfer needs much more time (bags, check-in closing, security)', () => {
    const prot = assessTransfer(cdg, arr, dep, { scheduledMinutes: 150, selfTransfer: false, date: '2026-11-04' });
    const self = assessTransfer(cdg, arr, dep, { scheduledMinutes: 150, selfTransfer: true, date: '2026-11-04' });
    expect(self.combos[0].route!.checkIn).toBeDefined();   // one route with the check-in point (R-11)
    expect(self.combos[0].needed!.typical).toBeGreaterThan(prot.combos[0].needed!.typical + 40);
    // 150 min is comfortable on a protected connection but not as a self-transfer; 90 min self-transfer is risky
    // the 2E hall is not predicted: protected is at worst tight (some halls), never risky; the self-transfer is worse
    expect(['comfortable', 'uncertain']).toContain(prot.verdict);
    expect(prot.worst).not.toBe('risky');
    expect(self.verdict).not.toBe('comfortable');
    expect(assessTransfer(cdg, arr, dep, { scheduledMinutes: 90, selfTransfer: true, date: '2026-11-04' }).verdict).toBe('risky');
  });
});

describe('unknown areas', () => {
  it('without predictions the verdict is "uncertain" when plausible pairs disagree, not the worst case', () => {
    const cdg = MODELS.CDG;
    const arr = resolveAreas(cdg, { direction: 'arrival', other: 'TLV', date: '2026-11-04', answer: null });
    const dep = resolveAreas(cdg, { direction: 'departure', other: 'AMS', date: '2026-11-04', answer: null });
    const a = assessTransfer(cdg, arr, dep, { scheduledMinutes: 95, selfTransfer: false, date: '2026-11-04' });
    expect(a.verdict).toBe('uncertain');
    expect(a.verdictText).toMatch(/^Depends on the area/);
    expect(a.notes.join(' ')).toMatch(/Robustness check .*Risky in \d+ %–\d+ % of the cases/);   // interval bounds kept in the details
    // but a connection too short for any plausible pair is still risky
    expect(assessTransfer(cdg, arr, dep, { scheduledMinutes: 20, selfTransfer: false, date: '2026-11-04' }).verdict).toBe('risky');
  });
});

describe('end to end from a Skyscanner fixture', () => {
  it('details page → CDG connection with history → predicted areas, routes, verdict', async () => {
    const [c] = connectionsOf(parseSkyscannerText(fx('details-one-stop.txt'), TODAY));
    const queries: unknown[] = [];
    const history = new FixtureHistory((q) => { queries.push(q); return answer(
      flight({ flight: 'AF1621', airport: 'CDG', direction: 'arrival', date: '2026-11-04', terminal: field([['2E', 30]]) }),
      flight({ flight: 'AF1240', airport: 'CDG', direction: 'departure', date: '2026-11-04', terminal: field([['2F', 28], ['2G', 2]]) })); });
    const r = await analyzeConnection(c, { models: MODELS, history, today: TODAY });
    expect(queries).toEqual([{ arrivalFlight: 'AF1621', departureFlight: 'AF1240', date: '2026-11-04', departureDate: '2026-11-04', airport: 'CDG' }]);   // nothing else leaves the page
    expect(r).toMatchObject({ status: 'ok', airport: 'CDG', observed: { scheduledMinutes: 95, selfTransferAssumed: true }, history: { status: 'ok' } });
    expect(r.arrival!.provenance).toBe('predicted');
    expect(r.assessment!.combos.length).toBeGreaterThanOrEqual(3);
    expect(r.unknowns.join(' ')).toMatch(/protected connection/);
    expect(r.rules.some((x) => /mct/.test(x.id))).toBe(true);
  });
  it('a results card without flight numbers: no history request, areas unknown, missing information listed', async () => {
    const [c] = connectionsOf(parseSkyscannerText(fx('card-one-stop.txt'), TODAY));
    let asked = 0;
    const r = await analyzeConnection(c, { models: MODELS, history: new FixtureHistory(() => { asked++; return null; }), today: TODAY });
    expect(asked).toBe(0);
    expect(r.status).toBe('missing-information');
    expect(r.missing).toEqual(expect.arrayContaining(['arriving flight number', 'departing flight number', 'arrival and departure times']));
    expect(r.arrival!.provenance).toBe('unknown');
    expect(r.assessment!.verdict).toBe('not-assessed');
  });
  it('an unsupported airport says so', async () => {
    const [c] = connectionsOf(parseSkyscannerText(fx('details-unsupported.txt'), TODAY));
    const r = await analyzeConnection(c, { models: MODELS, history: new FixtureHistory(() => null), today: TODAY });
    expect(r.status).toBe('unsupported-airport');
    expect(r.unknowns[0]).toMatch(/ATH is not one of the supported/);
  });
  it('history server unreachable or unconfigured → analysis continues with unknown areas', async () => {
    const [c] = connectionsOf(parseSkyscannerText(fx('details-return.txt'), TODAY));   // MUC
    const down = new LocalServerHistory('http://127.0.0.1:9', 'tok', (async () => { throw new Error('ECONNREFUSED'); }) as any);
    const r = await analyzeConnection(c, { models: MODELS, history: down, today: TODAY });
    expect(r.history.status).toBe('unavailable');
    expect(r.unknowns.join(' ')).toMatch(/not reachable/);
    expect(r.assessment!.combos.length).toBeGreaterThan(0);
    const none = await new LocalServerHistory('', '').connection({ arrivalFlight: 'LH687', departureFlight: 'LH2416', date: '2026-11-10', airport: 'MUC' });
    expect(none).toMatchObject({ ok: false, reason: 'not-configured' });
  });
  it('every connection of the multi-leg fixtures analyses without throwing', async () => {
    for (const f of ['details-overnight-self-transfer.txt', 'details-return.txt', 'card-two-stops.txt', 'card-return.txt']) {
      for (const c of connectionsOf(parseSkyscannerText(fx(f), TODAY))) {
        const r = await analyzeConnection(c, { models: MODELS, history: new FixtureHistory(() => null), today: TODAY });
        expect(['ok', 'missing-information', 'unsupported-airport']).toContain(r.status);
        if (r.status !== 'unsupported-airport') expect(r.assessment!.combos.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('feed gate values (audit 2026-11-02)', () => {
  it('a paired value ("S8,S7", "C44/C43") resolves through each gate, not through a letter guess on the string', () => {
    const mad = MODELS.MAD;
    const g = resolveAreas(mad, { direction: 'departure', other: 'JFK', date: '2026-11-04', answer: flight({ flight: 'IB6251', airport: 'MAD', direction: 'departure', date: '2026-11-04', gate: field([['S46,S45', 4], ['U57/U58', 2]]) }) });
    expect(g.candidates.map((c) => c.area.id)).toEqual(['mad-t4s-s']);
    expect(g.unassigned).toBe(0);
  });
  it('AMS arrival bus drop-off codes ("A4", "A8"; pier A not open) stay unmapped: no area is guessed', () => {
    const ams = MODELS.AMS;
    const a = resolveAreas(ams, { direction: 'arrival', other: 'LHR', date: '2026-11-04', answer: flight({ flight: 'KL1000', airport: 'AMS', direction: 'arrival', date: '2026-11-04', gate: field([['A4', 4], ['D3', 2]]) }) });
    expect(a.unassigned).toBeCloseTo(4 / 6, 5);
    expect(a.candidates.map((c) => c.area.id)).toEqual(['ams-d-n']);
  });
});

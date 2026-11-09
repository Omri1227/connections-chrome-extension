// Transfer-time audit 2026-11-02 (docs/TRANSFER_TIME_CALCULATION_AUDIT.md).
import { describe, expect, it } from 'vitest';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas } from '../extension/src/core/resolve.ts';
import { assessTransfer } from '../extension/src/core/assess.ts';
import type { FieldAnswer, FlightAnswer } from '../extension/src/core/history.ts';

function field(dist: [string, number][]): FieldAnswer {
  const sample = dist.reduce((s, [, n]) => s + n, 0);
  return { status: 'predicted', value: dist[0][0], confidence: 'medium', confidenceScore: null, interval: null, sample, distribution: dist.map(([value, n]) => ({ value, n, share: n / sample })), alternatives: [] };
}
const flight = (p: Partial<FlightAnswer> & { flight: string; airport: string; direction: 'arrival' | 'departure'; date: string }): FlightAnswer => ({ status: 'ok', terminal: { ...field([['x', 1]]), status: 'no-data', sample: 0, distribution: [] }, gateArea: { ...field([['x', 1]]), status: 'no-data', sample: 0, distribution: [] }, gate: field([['x', 1]]), sameDay: null,
  basis: { windowDays: 30, flightDays: 30, fromCounters: 0, cancelled: 0, period: { from: '2026-10-01', to: '2026-10-30' }, sources: ['aerodatabox'], lastRefresh: null }, notes: [], ...p });

describe('AU-4: the route clock starts after this pair\'s deplaning', () => {
  const ams = MODELS.AMS, date = '2026-11-10';
  const dep = resolveAreas(ams, { direction: 'departure', other: 'CDG', date, answer: flight({ flight: 'KL1229', airport: 'AMS', direction: 'departure', date, gate: field([['C10', 10]]) }) });
  const at = (gate: string) => {
    const arr = resolveAreas(ams, { direction: 'arrival', other: 'BCN', date, answer: flight({ flight: 'KL1666', airport: 'AMS', direction: 'arrival', date, gate: field([[gate, 10]]) }) });
    const a = assessTransfer(ams, arr, dep, { scheduledMinutes: 90, selfTransfer: false, date, arrivalTime: '10:00' });
    return a.primary!.route!.steps[0].at;
  };
  it('contact stand: 8 min (deplaneContact typical); apron bus: 17 min (deplaneBus typical)', () => {
    expect(at('B13')).toBe('10:08');
    expect(at('B1')).toBe('10:17');   // B1–B8 are bus gates
  });
});

describe('AU-5: the shown clock follows the calibrated passport minutes', () => {
  it('FRA Z22 → A20 from TLV at 10:00: walk 6, calibrated entry passport 7 → transfer security at 10:21', () => {
    const fra = MODELS.FRA, date = '2026-11-10';
    const arr = resolveAreas(fra, { direction: 'arrival', other: 'TLV', date, answer: flight({ flight: 'LH687', airport: 'FRA', direction: 'arrival', date, gate: field([['Z22', 10]]) }) });
    const dep = resolveAreas(fra, { direction: 'departure', other: 'MUC', date, answer: flight({ flight: 'LH100', airport: 'FRA', direction: 'departure', date, gate: field([['A20', 10]]) }) });
    const a = assessTransfer(fra, arr, dep, { scheduledMinutes: 75, selfTransfer: false, date, arrivalTime: '10:00', profile: { originAirport: 'TLV', originCountry: 'IL', destinationAirport: 'MUC', destinationCountry: 'DE', airline: 'LH' } });
    const st = a.primary!.route!.steps;
    expect(st.map((s) => s.at)).toEqual(['10:08', '10:14', '10:21']);
    expect(st[1].minutes.typical).toBe(7);
  });
});

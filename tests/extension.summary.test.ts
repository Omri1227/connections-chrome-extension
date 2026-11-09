// Compact result view: likely arrival / departure (with ties), single best route, route confidence, checks.
import { describe, expect, it } from 'vitest';
import { analyzeConnection } from '../extension/src/core/analyze.ts';
import { FixtureHistory, type ConnectionAnswer, type FieldAnswer, type FlightAnswer } from '../extension/src/core/history.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { bestRoute, FORBIDDEN_WORDS, mapMarks, MODEL_FACTOR, ROUTE_SURE_THRESHOLD, SHORT_VERDICT, summarisePlace } from '../extension/src/core/summary.ts';
import type { ConnectionInput, Leg } from '../extension/src/core/types.ts';

const D = '2026-11-04';
function field(dist: [string, number][]): FieldAnswer {
  const sample = dist.reduce((s, [, n]) => s + n, 0);
  const st = sample >= 5 ? 'predicted' : sample ? 'insufficient-data' : 'no-data';
  return { status: st, value: st === 'predicted' ? dist[0][0] : null, confidence: st === 'predicted' ? 'medium' : null, confidenceScore: null, interval: null, sample,
    distribution: dist.map(([value, n]) => ({ value, n, share: sample >= 5 ? n / sample : null })), alternatives: [] };
}
const flight = (p: Partial<FlightAnswer> & { flight: string; airport: string; direction: 'arrival' | 'departure' }): FlightAnswer => ({
  status: 'ok', date: D, terminal: field([]), gateArea: field([]), gate: field([]), sameDay: null,
  basis: { windowDays: 30, flightDays: 30, fromCounters: 0, cancelled: 0, period: { from: '2026-10-01', to: '2026-10-30' }, sources: ['aerodatabox'], lastRefresh: null }, notes: [], ...p });
const leg = (fn: string, from: string, to: string, dep: string, arr: string): Leg => ({ flightNumber: fn, altNumbers: [], airline: null, operatedBy: null, from, to, depDate: D, depTime: dep, arrDate: D, arrTime: arr });
async function run(airport: string, origin: string, dest: string, arr: FlightAnswer | null, dep: FlightAnswer | null, o: { gap?: [string, string]; selfTransfer?: boolean | null } = {}) {
  const [a, d] = o.gap ?? ['12:00', '14:30'];
  const c: ConnectionInput = { airport, inbound: leg('XX1', origin, airport, '08:00', a), outbound: leg('YY2', airport, dest, d, '18:00'), selfTransfer: o.selfTransfer === undefined ? false : o.selfTransfer };
  const ans = arr && dep ? ({ query: { arrivalFlight: 'XX1', departureFlight: 'YY2', date: D, departureDate: D, airport }, status: 'ok', airport, airportCandidates: [airport], arrival: arr, departure: dep, sameTerminalHistorically: null, notes: [] } as ConnectionAnswer) : null;
  return analyzeConnection(c, { models: MODELS, history: new FixtureHistory(() => ans), today: D });
}

describe('arrival / departure summary', () => {
  it('a terminal with several halls is ONE option at the evidence level (Terminal 2E 100 %, hall not predicted); the rest as "others"', async () => {
    const r = await run('CDG', 'TLV', 'AMS', flight({ flight: 'XX1', airport: 'CDG', direction: 'arrival', terminal: field([['2E', 30]]) }), flight({ flight: 'YY2', airport: 'CDG', direction: 'departure', terminal: field([['2F', 28], ['2G', 2]]) }));
    const arr = summarisePlace(r.arrival!), dep = summarisePlace(r.departure!);
    expect(arr.top).toHaveLength(1);
    expect(arr.top[0]).toMatchObject({ name: 'Terminal 2E', short: '2E', p: 1 });
    expect(arr.top[0].areaIds.sort()).toEqual(['cdg-2e-k', 'cdg-2e-l', 'cdg-2e-m']);
    expect(arr.top[0].detail).toMatch(/which one is not predicted/);
    expect(arr.basisText).toBe('from 30 earlier flight-days');
    expect(dep.top.map((o) => o.areaId)).toEqual(['cdg-2f']);
    expect(dep.others.map((o) => o.areaId)).toEqual(['cdg-2g']);
    const best = bestRoute(MODELS.CDG, r)!;
    const marks = mapMarks(arr, dep, best);
    expect(marks.filter((m) => m.role === 'from').map((m) => m.text)).toEqual(['ARRIVE 2E? · 100 %', 'ARRIVE 2E? · 100 %', 'ARRIVE 2E? · 100 %']);
    expect(marks.find((m) => m.role === 'to')!.text).toMatch(/^DEPART .+ · 93 %$/);
    // one of three halls of the terminal → never "sure", and the route is only illustrative
    expect(best.confidence).toBeLessThan(ROUTE_SURE_THRESHOLD);
    expect(best.sure).toBe(false);
    expect(best.illustrative).toBe(true);
  });
  it('unknown areas: no top option, no percentage, the map marks the route ends with "?"', async () => {
    const r = await run('CDG', 'TLV', 'AMS', null, null);
    const arr = summarisePlace(r.arrival!), dep = summarisePlace(r.departure!);
    expect(arr.top).toEqual([]);
    expect(arr.others.every((o) => o.p === null)).toBe(true);
    expect(arr.basisText).toMatch(/^not predicted: \d+ possible areas \(non-schengen\)$/);
    const best = bestRoute(MODELS.CDG, r)!;
    expect(best.sure).toBe(false);
    expect(mapMarks(arr, dep, best).map((m) => m.text)).toEqual(['ARRIVE ? (not predicted)', 'DEPART ? (not predicted)']);
  });
  it('a gate published for the day: observed, shown without a percentage; confidence = 0.95 × 0.95 × model factor', async () => {
    const same = (gate: string, t: string) => ({ terminal: t, gate, gateArea: gate[0], status: 'scheduled', observedAt: `${D}T08:00:00Z`, source: 'aerodatabox' });
    const r = await run('FRA', 'JFK', 'MAD', flight({ flight: 'XX1', airport: 'FRA', direction: 'arrival', sameDay: same('Z25', '1') as any }), flight({ flight: 'YY2', airport: 'FRA', direction: 'departure', sameDay: same('A26', '1') as any }));
    const arr = summarisePlace(r.arrival!);
    expect(arr).toMatchObject({ provenance: 'observed', basisText: 'published for this flight (may still change)' });
    expect(arr.top).toEqual([expect.objectContaining({ areaId: 'fra-t1-z', p: null, detail: 'gate Z25' })]);
    const best = bestRoute(MODELS.FRA, r)!;
    expect(best.combo.departure.area.id).toBe('fra-t1-a');
    expect(best.confidence).toBeCloseTo(0.95 * 0.95 * MODEL_FACTOR[best.combo.route!.confidence], 6);
    expect(best.sure).toBe(best.confidence >= 0.7);
  });
  it('protected vs self-transfer not shown on the page lowers the confidence (× 0.9)', async () => {
    const h = () => [flight({ flight: 'XX1', airport: 'AMS', direction: 'arrival', gateArea: field([['D', 8]]) }), flight({ flight: 'YY2', airport: 'AMS', direction: 'departure', gateArea: field([['B', 9]]) })] as const;
    const a0 = await run('AMS', 'LHR', 'BCN', ...h(), { selfTransfer: null });
    const assumed = bestRoute(MODELS.AMS, a0)!;
    // unknown ticket type: the headline is the less favourable scenario; compare with that type given explicitly
    const known = bestRoute(MODELS.AMS, await run('AMS', 'LHR', 'BCN', ...h(), { selfTransfer: a0.assessment!.selfTransfer }))!;
    // both areas certain from history: Wilson lower bounds of 8/8 and 9/9 (small samples are not "100 % sure", R-46)
    const wl = (n: number) => { const z = 1.96, d = 1 + (z * z) / n; return (1 + (z * z) / (2 * n) - z * Math.sqrt((z * z) / (4 * n * n))) / d; };
    expect(known.confidence).toBeCloseTo(wl(8) * wl(9) * MODEL_FACTOR[known.combo.route!.confidence], 6);
    expect(assumed.confidence).toBeCloseTo(known.confidence * 0.9, 6);
    expect(assumed.confidenceWhy.join(' ')).toMatch(/ticket type not shown in the itinerary/);
  });
});

describe('best route content', () => {
  it('walk + transport + walk + checks + leaving the aircraft add up to the total (protected, with a people mover)', async () => {
    const r = await run('FRA', 'TLV', 'MAD', flight({ flight: 'XX1', airport: 'FRA', direction: 'arrival', gateArea: field([['Z', 10]]) }), flight({ flight: 'YY2', airport: 'FRA', direction: 'departure', gateArea: field([['A', 10]]) }));
    const b = bestRoute(MODELS.FRA, r)!;
    const s = b.segments;
    expect(s.movement.typical).toBeCloseTo(b.combo.route!.steps.reduce((t, x) => t + x.minutes.typical, 0) + s.deplane, 6);
    expect(s.walkBefore + (s.transport?.minutes ?? 0) + s.walkAfter + s.checksMinutes + s.deplane).toBeCloseTo(s.movement.typical, 0);
    expect(s.needed).toEqual(b.combo.needed);   // R-29: needed (incl. boarding close, combined by timing.ts) is shown, not only the movement
    expect(s.needed!.typical).toBeGreaterThan(s.movement.typical);
    expect(s.checks.map((c) => c.label)).toContain('Passport control');
    expect(s.deadline.label).toBe('Boarding closes');
    expect(s.bags).toBeNull();
  });
  it('a self-transfer lists baggage reclaim, the bag re-check and security, and counts the bag wait', async () => {
    const r = await run('ZRH', 'JFK', 'GVA', flight({ flight: 'XX1', airport: 'ZRH', direction: 'arrival', gateArea: field([['E', 10]]) }), flight({ flight: 'YY2', airport: 'ZRH', direction: 'departure', gateArea: field([['A', 10]]) }), { selfTransfer: true, gap: ['12:00', '16:00'] });
    const s = bestRoute(MODELS.ZRH, r)!.segments;
    const labels = s.checks.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['Passport control', 'Baggage reclaim', 'Check-in / bag drop again', 'Security']));
    if (labels.includes('Customs')) expect(labels.indexOf('Baggage reclaim')).toBeLessThan(labels.indexOf('Customs'));
    expect(labels.indexOf('Check-in / bag drop again')).toBeLessThan(labels.lastIndexOf('Security'));
    expect(s.bags).toBe(25);
    const b2 = bestRoute(MODELS.ZRH, r)!;
    expect(s.movement.typical).toBeCloseTo(b2.combo.route!.steps.reduce((t, x) => t + x.minutes.typical, 0) + s.deplane, 6);
    expect(Math.abs(s.walkBefore + (s.transport?.minutes ?? 0) + s.walkAfter + s.checksMinutes + s.deplane + s.bags! - s.movement.typical)).toBeLessThanOrEqual(2);   // rounded parts
    expect(s.deadline.label).toBe('Check-in closes');
  });
  it('the one-line verdicts are short and never say safe or guaranteed', () => {
    for (const t of Object.values(SHORT_VERDICT)) {
      expect(t.length).toBeLessThanOrEqual(40);
      expect(t).not.toMatch(FORBIDDEN_WORDS);
    }
  });
});

// Most-likely-route verdict policy (owner brief 2026-11-02, docs/research/VERDICT_POLICY_REVIEW.md): examples A–D,
// the separation of route uncertainty from procedure uncertainty, and the absence of the old "material → tight" cap.
import { describe, expect, it } from 'vitest';
import { assessTransfer } from '../extension/src/core/assess.ts';
import type { FieldAnswer, FlightAnswer } from '../extension/src/core/history.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas, type Resolution } from '../extension/src/core/resolve.ts';
import { likelyVerdict, mixtureQuantile, type PointScenario } from '../extension/src/core/risk.ts';
import { SCREENING_POLICY, screeningPolicy } from '../extension/src/core/timing.ts';

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
function res(m: typeof MODELS.FRA, direction: 'arrival' | 'departure', other: string, gateAreas: [string, number][]): Resolution {
  return resolveAreas(m, { direction, other, date: D, answer: flight({ flight: 'X1', airport: m.iata, direction, gateArea: field(gateAreas) }) });
}
const S = (p: number, typical: number, high: number, extra: Partial<PointScenario> = {}): PointScenario => ({ p, needed: { min: typical * 0.6, typical, high }, label: `${typical}`, ...extra });

describe('mixture of needed times', () => {
  it('one scenario: median = typical, 90th percentile = high (the single-route margins are unchanged)', () => {
    const n = { min: 20, typical: 40, high: 55 };
    expect(mixtureQuantile([{ p: 1, n }], 0.5)).toBeCloseTo(40, 0);
    expect(mixtureQuantile([{ p: 1, n }], 0.9)).toBeCloseTo(55, 0);
  });
  it('missing weight is unbounded time', () => {
    expect(mixtureQuantile([{ p: 0.85, n: { min: 20, typical: 40, high: 55 } }], 0.9)).toBe(Infinity);
    expect(Number.isFinite(mixtureQuantile([{ p: 0.85, n: { min: 20, typical: 40, high: 55 } }], 0.5))).toBe(true);
  });
});

describe('Example A: ordinary uncertainty does not downgrade', () => {
  it('several nearby areas with similar times → the primary route\'s own verdict, no change', () => {
    const v = likelyVerdict([S(0.4, 38, 52, { primary: true }), S(0.35, 40, 55), S(0.25, 42, 57)], 90);
    expect(v.primary).toBe('comfortable');
    expect(v.verdict).toBe('comfortable');
    expect(v.changed).toBe(false);
  });
  it('real model: CDG terminal 2E (halls K/L/M not predicted) on a long connection is comfortable', () => {
    const cdg = MODELS.CDG;
    const arr = resolveAreas(cdg, { direction: 'arrival', other: 'JFK', date: D, answer: flight({ flight: 'AF7', airport: 'CDG', direction: 'arrival', terminal: field([['2E', 30]]) }) });
    const dep = resolveAreas(cdg, { direction: 'departure', other: 'JFK', date: D, answer: flight({ flight: 'AF8', airport: 'CDG', direction: 'departure', terminal: field([['2E', 30]]) }) });
    const a = assessTransfer(cdg, arr, dep, { scheduledMinutes: 180, selfTransfer: false, date: D });
    expect(a.verdict).toBe('comfortable');
    expect(a.drivers).toEqual([]);
  });
});

describe('Example B: material route uncertainty changes the verdict and says why', () => {
  it('a credible 85-min alternative with 30 % weight: not comfortable, named', () => {
    const v = likelyVerdict([S(0.7, 40, 55, { primary: true, label: 'Z' }), S(0.3, 85, 100, { label: 'J' })], 90);
    expect(v.primary).toBe('comfortable');
    expect(v.verdict).not.toBe('comfortable');
    expect(v.changed).toBe(true);
    expect(v.worse[0]).toMatchObject({ label: 'J', category: 'risky' });
  });
  it('the same alternative at 5 % stays below the 90th percentile: comfortable, still listed (not silent)', () => {
    const v = likelyVerdict([S(0.95, 40, 55, { primary: true, label: 'Z' }), S(0.05, 85, 100, { label: 'J' })], 90);
    expect(v.verdict).toBe('comfortable');
    expect(v.worse.map((w) => w.label)).toEqual(['J']);
  });
  it('the effect grows monotonically with the alternative\'s weight (sensitivity)', () => {
    const order = { comfortable: 0, tight: 1, risky: 2, uncertain: 2, 'not-assessed': 3 } as const;
    let last = 0;
    for (let q = 0; q <= 0.6 + 1e-9; q += 0.02) {
      const v = likelyVerdict([S(1 - q, 40, 55, { primary: true }), S(q, 85, 100)], 90);
      expect(order[v.verdict]).toBeGreaterThanOrEqual(last);
      last = order[v.verdict];
    }
  });
});

describe('Example C: a required procedure never costs 0 min', () => {
  it('every special screening without minutes in the eight models has an explicit policy', () => {
    for (const m of Object.values(MODELS)) for (const s of m.specialScreening ?? []) {
      if (s.minutes) continue;
      const pol = screeningPolicy(s);
      expect(pol, `${s.id} (${s.certainty})`).not.toBeNull();
    }
  });
  it('FCO, ITA Airways to Tel Aviv: the T1 X-ray flow is a timed step with a sourced allowance', () => {
    const m = MODELS.FCO;
    const prof = { airline: 'AZ', destinationCountry: 'IL', destinationAirport: 'TLV', originCountry: 'US', originAirport: 'JFK' };
    const a = assessTransfer(m, res(m, 'arrival', 'JFK', [['E', 10]]), res(m, 'departure', 'TLV', [['E', 10]]), { scheduledMinutes: 120, selfTransfer: false, date: D, profile: prof });
    const steps = a.primary!.route!.steps;
    const ss = steps.find((s) => s.control?.kind === 'special-screening');
    const pol = SCREENING_POLICY['ss:fco-us-israel-t1'];
    expect(pol.kind).toBe('bound');
    expect(ss?.minutes).toMatchObject(pol.kind === 'bound' ? { typical: pol.minutes.typical, max: pol.minutes.max } : {});
    expect(a.primary!.route!.issues.map((i) => i.code)).toContain('special-screening-bounded');
    expect(a.primary!.route!.issues.map((i) => i.code)).not.toContain('special-screening-time-unknown');
  });
  it('MAD, El Al to Tel Aviv: no Madrid deadline is published, so El Al\'s own station deadlines bound it', () => {
    const m = MODELS.MAD;
    const prof = { airline: 'LY', destinationCountry: 'IL', destinationAirport: 'TLV', originCountry: 'US', originAirport: 'JFK' };
    const a = assessTransfer(m, res(m, 'arrival', 'JFK', [['S', 10]]), res(m, 'departure', 'TLV', [['S', 10]]), { scheduledMinutes: 120, selfTransfer: false, date: D, profile: prof });
    expect(a.primary!.needed!.typical).toBeGreaterThanOrEqual(85);
    expect(a.verdict).not.toBe('comfortable');
    // without the screening the same connection needs far less
    const b = assessTransfer(m, res(m, 'arrival', 'JFK', [['S', 10]]), res(m, 'departure', 'TLV', [['S', 10]]), { scheduledMinutes: 120, selfTransfer: false, date: D, profile: { ...prof, airline: 'UX' } });
    expect(b.primary!.needed!.typical).toBeLessThan(a.primary!.needed!.typical);
  });
  it('a required screening with no known or boundable duration → not assessed (insufficiently established)', () => {
    const m = structuredClone(MODELS.MAD);
    m.specialScreening = [...(m.specialScreening ?? []), { id: 'ss:test-required', appliesTo: { destinationCountries: ['IL'] }, certainty: 'verified', text: 'Test: a required check of unknown length.', sources: [] }];
    const prof = { airline: 'UX', destinationCountry: 'IL', destinationAirport: 'TLV', originCountry: 'US', originAirport: 'JFK' };
    const a = assessTransfer(m, res(m, 'arrival', 'JFK', [['S', 10]]), res(m, 'departure', 'TLV', [['S', 10]]), { scheduledMinutes: 240, selfTransfer: false, date: D, profile: prof });
    expect(a.verdict).toBe('not-assessed');
    expect(a.verdictText).toMatch(/not established/);
  });
  it('a screening whose existence is unknown is a warning, not minutes and not a cap', () => {
    const v = screeningPolicy({ id: 'ss:zrh-israel-other', certainty: 'unknown' });
    expect(v?.kind).toBe('possible');
  });
});

describe('procedure not established at this hour', () => {
  it('AMS, TLV arrival at G, 00:30: the GH filter is closed and the only way is unconfirmed → not assessed; by day assessed', () => {
    const m = MODELS.AMS;
    const prof = { originAirport: 'TLV', originCountry: 'IL' };
    const arr = res(m, 'arrival', 'TLV', [['G', 10]]), dep = res(m, 'departure', 'JFK', [['D', 10]]);
    const night = assessTransfer(m, arr, dep, { scheduledMinutes: 180, selfTransfer: false, date: D, arrivalTime: '00:22', profile: prof });
    const gd = night.combos.find((c) => c.arrival.area.id === 'ams-g' && c.departure.area.id === 'ams-d-n');
    expect(gd).toBeDefined();
    {
      expect(gd!.route).toBeNull();
      expect(gd!.why).toMatch(/checkpoint is closed/);
    }
    const day = assessTransfer(m, arr, dep, { scheduledMinutes: 180, selfTransfer: false, date: D, arrivalTime: '14:00', profile: prof });
    expect(day.combos.find((c) => c.arrival.area.id === 'ams-g' && c.departure.area.id === 'ams-d-n')?.route).not.toBeNull();
  });
});

describe('Example D and unestablished time', () => {
  it('a side with no evidence whose areas disagree → "depends on the area" (no invented most likely area)', () => {
    expect(likelyVerdict([S(0.5, 40, 55, { primary: true }), S(0.5, 85, 100)], 90, { noEvidence: true }).verdict).toBe('uncertain');
    expect(likelyVerdict([S(0.5, 40, 55, { primary: true }), S(0.5, 42, 56)], 90, { noEvidence: true }).verdict).toBe('comfortable');
  });
  it('unestablished time: ≥ 50 % → not assessed; 10–50 % → never comfortable; it never improves a verdict', () => {
    const na = (p: number): PointScenario => ({ p, needed: null, label: 'na', reason: 'no modelled route' });
    expect(likelyVerdict([S(0.5, 30, 40, { primary: true }), na(0.5)], 120).verdict).toBe('not-assessed');
    expect(likelyVerdict([S(0.8, 30, 40, { primary: true }), na(0.2)], 120).verdict).not.toBe('comfortable');
    expect(likelyVerdict([S(0.95, 30, 40, { primary: true }), na(0.05)], 120).verdict).toBe('comfortable');
  });
  it('limited history: the route is labelled illustrative and the verdict is still the estimate', async () => {
    const { bestRoute } = await import('../extension/src/core/summary.ts');
    const m = MODELS.FRA;
    // upstream: fewer than 5 flight-days is "insufficient data" → the side is not predicted at all
    expect(res(m, 'arrival', 'JFK', [['Z', 3]]).provenance).toBe('unknown');
    // a source that still calls 3 days a prediction: the route is only an example
    const few: FieldAnswer = { ...field([['Z', 5]]), sample: 3, distribution: [{ value: 'Z', n: 3, share: 1 }] };
    const arr = resolveAreas(m, { direction: 'arrival', other: 'JFK', date: D, answer: flight({ flight: 'X1', airport: 'FRA', direction: 'arrival', gateArea: few }) });
    const dep = res(m, 'departure', 'DXB', [['Z', 30]]);
    expect(arr).toMatchObject({ provenance: 'predicted', sample: 3 });
    const a = assessTransfer(m, arr, dep, { scheduledMinutes: 150, selfTransfer: false, date: D });
    expect(a.dataQuality).toBe('limited');
    expect(a.verdict).not.toBe('not-assessed');
    const b = bestRoute(m, { assessment: a, arrival: arr, departure: dep, observed: { selfTransferAssumed: false } } as never);
    expect(b).toMatchObject({ illustrative: true, sure: false, limitedHistory: 3 });
  });
});

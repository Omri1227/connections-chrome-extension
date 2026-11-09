// Passport-control calibration by airport, direction and EES status (docs/research/TRANSFER_TIME_CALIBRATION.md §3).
import { describe, expect, it } from 'vitest';
import { assessTransfer } from '../extension/src/core/assess.ts';
import { calibratePassport, expectedCrossings, PASSPORT } from '../extension/src/core/calibration.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas } from '../extension/src/core/resolve.ts';

const D = '2026-11-18';
const unknownSide = (m: typeof MODELS.AMS, direction: 'arrival' | 'departure', other: string) => resolveAreas(m, { direction, other, date: D, answer: null });
const passportSteps = (a: ReturnType<typeof assessTransfer>) => a.combos.flatMap((c) => c.route?.steps.filter((s) => s.control?.kind === 'passport') ?? []);

describe('which border checks a connection passes', () => {
  it('protected Schengen hub: entry, exit, or none for an airside non-Schengen transit', () => {
    expect(expectedCrossings('AMS', 'non-schengen', 'schengen', false)).toEqual(['entry']);
    expect(expectedCrossings('AMS', 'schengen', 'non-schengen', false)).toEqual(['exit']);
    expect(expectedCrossings('AMS', 'non-schengen', 'non-schengen', false)).toEqual([]);
    expect(expectedCrossings('AMS', 'schengen', 'schengen', false)).toEqual([]);
  });
  it('self-transfer: entry when arriving from outside, exit when leaving for outside; IST: entering Turkey', () => {
    expect(expectedCrossings('FRA', 'non-schengen', 'non-schengen', true)).toEqual(['entry', 'exit']);
    expect(expectedCrossings('FRA', 'schengen', 'non-schengen', true)).toEqual(['exit']);
    expect(expectedCrossings('IST', 'international', 'international', true)).toEqual(['entry']);
    expect(expectedCrossings('IST', 'international', 'international', false)).toEqual([]);
  });
});

describe('calibrated minutes on real routes', () => {
  it('AMS, Tel Aviv → Paris, EES-registered: the entry check uses the calibrated 15 / 45', () => {
    const m = MODELS.AMS;
    const a = assessTransfer(m, unknownSide(m, 'arrival', 'TLV'), unknownSide(m, 'departure', 'CDG'), { scheduledMinutes: 120, selfTransfer: false, date: D });
    const ps = passportSteps(a);
    expect(ps.length).toBeGreaterThan(0);
    for (const s of ps) expect(s.minutes).toMatchObject({ typical: 15, max: 45, basis: 'derived' });
    expect(a.notes.join(' ')).toMatch(/Entry\/Exit System/);
  });
  it('AMS has no lane-level data for EES-exempt travellers: the model value stays (nothing invented)', () => {
    const m = MODELS.AMS;
    expect(PASSPORT.AMS?.['entry:ees-exempt']).toBeUndefined();
    const reg = assessTransfer(m, unknownSide(m, 'arrival', 'TLV'), unknownSide(m, 'departure', 'CDG'), { scheduledMinutes: 120, selfTransfer: false, date: D });
    const ex = assessTransfer(m, unknownSide(m, 'arrival', 'TLV'), unknownSide(m, 'departure', 'CDG'), { scheduledMinutes: 120, selfTransfer: false, date: D, passenger: 'ees-exempt' });
    expect(passportSteps(ex).every((s) => s.minutes.basis === 'assumed')).toBe(true);
    expect(passportSteps(reg).every((s) => s.minutes.basis === 'derived')).toBe(true);
  });
  it('CDG, EES-exempt (PARAFE lanes) is faster than EES-registered and never slower', () => {
    const m = MODELS.CDG;
    const run = (passenger?: 'ees-exempt' | 'ees-registered') => assessTransfer(m, unknownSide(m, 'arrival', 'TLV'), unknownSide(m, 'departure', 'AMS'), { scheduledMinutes: 120, selfTransfer: false, date: D, passenger });
    const ex = passportSteps(run('ees-exempt')), reg = passportSteps(run());
    expect(ex.length).toBeGreaterThan(0);
    {
      expect(ex[0].minutes.typical).toBeLessThan(reg[0].minutes.typical);
      expect(ex[0].minutes.max).toBeLessThanOrEqual(reg[0].minutes.max);
    }
  });
  it('a route whose crossings do not match the expectation is left unchanged', () => {
    const step = { kind: 'control' as const, text: 'Passport control', from: 'x', to: 'x', minutes: { min: 3, typical: 10, max: 30, basis: 'assumed' as const }, control: { kind: 'passport' as const, minutes: { min: 3, typical: 10, max: 30, basis: 'assumed' as const } }, confidence: 'probable' as const, sources: [] };
    const r = calibratePassport('AMS', [step, step], { arrZone: 'non-schengen', depZone: 'schengen', selfTransfer: false });
    expect(r.applied).toEqual([]);
    expect(r.steps[0].minutes.typical).toBe(10);
  });
  it('every calibrated value has typical ≤ max, a source and the derived basis', () => {
    for (const [ap, t] of Object.entries(PASSPORT)) for (const [k, v] of Object.entries(t ?? {})) {
      expect(v!.min, `${ap} ${k}`).toBeLessThanOrEqual(v!.typical);
      expect(v!.typical).toBeLessThanOrEqual(v!.max);
      expect(v!.source.length).toBeGreaterThan(10);
      expect(v!.basis).toBe('derived');
    }
  });
});

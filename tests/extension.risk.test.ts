// Connection risk under uncertain areas (R-03, R-15, R-22, R-47): docs/research/TRANSFER_RISK_MODEL.md.
// Properties: unknown mass never disappears; more uncertainty never improves the conservative verdict; a plausible risky
// scenario is never silently ignored; the audit's adversarial scenarios.
import { describe, expect, it } from 'vitest';
import { assessConnection, assessSides, buildScenarios, categorize, RISK, sideMass, type Category, type Outcome, type Scenario, type SideEvidence } from '../extension/src/core/risk.ts';

const N = (typical: number, high: number): Outcome => ({ needed: { typical, high } });
const P = (ids: string[], p: number) => ({ ids, p });
const RANK: Record<Category | 'not-assessed', number> = { 'not-assessed': -1, risky: 0, tight: 1, comfortable: 2 };

// FRA, 75 min (AS-verdict S1 / S1b): Z→Z comfortable, Z→J and C→J risky, C→Z tight.
const fra = (a: string, d: string) => ({ 'Z|Z': N(40, 55), 'Z|J': N(70, 95), 'C|Z': N(55, 70), 'C|J': N(72, 100) } as Record<string, Outcome>)[`${a}|${d}`];

describe('categorize', () => {
  it('keeps the assess.ts thresholds (comfortable: pessimistic margin ≥ 15; risky: typical margin < 10)', () => {
    expect(categorize(N(40, 60), 75)).toBe('comfortable');
    expect(categorize(N(40, 61), 75)).toBe('tight');
    expect(categorize(N(66, 80), 75)).toBe('risky');
    expect(categorize(N(65, 80), 75)).toBe('tight');
  });
  it('not assessed without a route, a scheduled time, or with a blocking issue', () => {
    expect(categorize({ needed: null }, 75)).toBeNull();
    expect(categorize(N(10, 20), null)).toBeNull();
    expect(categorize({ needed: { typical: 10, high: 20 }, issues: [{ level: 'blocking', code: 'x', text: '' }] }, 75)).toBeNull();
  });
  it('a material issue no longer caps a comfortable scenario (owner decision 2026-11-02; legacy switch kept)', () => {
    const o = { needed: { typical: 10, high: 20 }, issues: [{ level: 'material' as const, code: 'special-screening-time', text: '' }] };
    expect(categorize(o, 75)).toBe('comfortable');
    expect(categorize(o, 75, { ...RISK, materialCaps: true })).toBe('tight');
  });
});

describe('adversarial scenarios from the audit', () => {
  it('S1 (arrival uncertain) is as risky as S1b (arrival certain): the 15 % J departure is not pooled away', () => {
    const s1 = assessSides({ kind: 'predicted', candidates: [P(['Z'], 0.6), P(['C'], 0.4)], sample: 60 }, { kind: 'predicted', candidates: [P(['Z'], 0.85), P(['J'], 0.15)], sample: 40 }, 75, fra);
    const s1b = assessSides({ kind: 'predicted', candidates: [P(['Z'], 1)], sample: 60 }, { kind: 'predicted', candidates: [P(['Z'], 0.85), P(['J'], 0.15)], sample: 40 }, 75, fra);
    expect(s1.verdict).toBe('risky');
    expect(s1b.verdict).toBe('risky');
    expect(s1.bounds.risky[0]).toBeGreaterThan(0.14);
    expect(s1.drivers[0].category).toBe('risky');
  });
  it('ZRH 70 min, both sides unknown, pairs half tight / half risky → never "uncertain" (R-15), conservative = risky', () => {
    const zrh = (a: string) => (a === 'D' ? N(55, 75) : N(62, 85));
    const r = assessSides({ kind: 'unknown', candidates: [P(['D'], 1), P(['E'], 1)] }, { kind: 'unknown', candidates: [P(['A'], 1), P(['B'], 1)] }, 70, zrh);
    expect(r.best).toBe('tight');
    expect(r.worst).toBe('risky');
    expect(r.verdict).toBe('risky');
  });
  it('unknown areas spanning comfortable and not → "uncertain", whose conservative bound is reported', () => {
    const r = assessSides({ kind: 'unknown', candidates: [P(['D'], 1), P(['E'], 1)] }, { kind: 'observed', candidates: [P(['A'], 1)] }, 70, (a) => (a === 'D' ? N(30, 45) : N(65, 85)));
    expect(r.verdict).toBe('uncertain');
    expect(r.worst).toBe('risky');
    expect(r.best).toBe('comfortable');
  });
  it('AMS: 12 % unmapped history is kept, counted as possibly risky, and blocks a "comfortable" verdict', () => {
    const r = assessSides({ kind: 'predicted', candidates: [P(['D'], 0.88)], unmapped: 0.12, sample: 50 }, { kind: 'observed', candidates: [P(['B'], 1)] }, 60, () => N(25, 40));
    expect(r.coverage.unassigned).toBeGreaterThan(0.11);
    expect(r.bounds.risky[1]).toBeGreaterThan(0.11);
    expect(r.verdict).toBe('uncertain');
    expect(r.text).toMatch(/could not be assessed/);
  });
  it('CDG 2E 70 % / T1 30 % at terminal level: 2E stays one share over K/L/M (no 23 % per hall); T1 drives the verdict', () => {
    const cdg = (a: string) => ({ K: N(30, 45), L: N(32, 48), M: N(40, 58), T1: N(62, 80) } as Record<string, Outcome>)[a];
    const arr: SideEvidence = { kind: 'predicted', candidates: [P(['K', 'L', 'M'], 0.7), P(['T1'], 0.3)], sample: 80 };
    const r70 = assessSides(arr, { kind: 'observed', candidates: [P(['2F'], 1)] }, 70, cdg);
    expect(r70.verdict).toBe('risky');
    expect(r70.drivers[0].label).toBe('T1 → 2F');
    const r90 = assessSides(arr, { kind: 'observed', candidates: [P(['2F'], 1)] }, 90, cdg);
    expect(r90.verdict).toBe('tight');   // M is tight at 90 min and its hall share is open: comfortable is not established
  });
});

describe('unknown mass is preserved', () => {
  it('unassigned + open + assessed + not assessed = 1', () => {
    const r = assessSides({ kind: 'predicted', candidates: [P(['Z'], 0.5), P(['C'], 0.3)], unmapped: 0.2, sample: 10 }, { kind: 'unknown', candidates: [P(['Z'], 1), P(['J'], 1)] }, 75, fra);
    const c = r.coverage;
    expect(c.assessed + c.open + c.unassigned + c.notAssessed).toBeCloseTo(1, 9);
    expect(c.unassigned).toBeGreaterThan(0.15);
  });
  it('a shortfall of Σp is added to the unassigned mass, never rescaled away', () => {
    const r = assessConnection([{ p: 0.6, ...N(20, 30), label: 'a' }], 0, 75);
    expect(r.coverage.unassigned).toBeCloseTo(0.4, 9);
    expect(r.verdict).toBe('uncertain');
  });
  it('a pair with no route is "not assessed" mass, inside every upper bound', () => {
    const r = assessConnection([{ p: 0.8, ...N(20, 30), label: 'a' }, { p: 0.2, needed: null, label: 'b' }], 0, 75);
    expect(r.coverage.notAssessed).toBeCloseTo(0.2, 9);
    expect(r.bounds.risky[1]).toBeCloseTo(0.2, 9);
    expect(r.worst).toBe('risky');
  });
  it('IDM: a small sample leaves s/(n+s) open over every eligible area (universe), not only the areas seen', () => {
    const m = sideMass({ kind: 'predicted', candidates: [P(['Z'], 1)], sample: 5, universe: ['Z', 'J'] });
    expect(m.atoms.find((a) => a.ids.length === 2)!.p).toBeCloseTo(1 / 6, 9);
    const r = assessSides({ kind: 'observed', candidates: [P(['Z'], 1)] }, { kind: 'predicted', candidates: [P(['Z'], 1)], sample: 5, universe: ['Z', 'J'] }, 75, fra);
    expect(r.worst).toBe('risky');   // J was never seen in 5 flight-days, but cannot be excluded
    const big = assessSides({ kind: 'observed', candidates: [P(['Z'], 1)] }, { kind: 'predicted', candidates: [P(['Z'], 1)], sample: 200, universe: ['Z', 'J'] }, 75, fra);
    expect(big.verdict).toBe('comfortable');
  });
});

// Random scenario generator for the property tests (seeded).
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

describe('monotonicity: more uncertainty never improves the conservative verdict (worst)', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const make = (r: () => number) => {
    const table = new Map<string, Outcome>();
    for (const x of ids) for (const y of ids) table.set(`${x}|${y}`, r() < 0.1 ? { needed: null } : N(20 + r() * 60, 0));
    for (const o of table.values()) if (o.needed) o.needed.high = o.needed.typical + 5 + r() * 30;
    return (a: string, d: string) => table.get(`${a}|${d}`)!;
  };
  const dist = (r: () => number): { ids: string[]; p: number }[] => { const w = ids.map(() => r()); const s = w.reduce((a, b) => a + b, 0); return ids.map((x, i) => P([x], w[i] / s)); };

  it('moving evidence mass into unmapped mass (R-22)', () => {
    const r = rng(7);
    for (let k = 0; k < 300; k++) {
      const out = make(r), sched = 40 + r() * 60, a = dist(r), d = dist(r), cut = r();
      const base = assessSides({ kind: 'predicted', candidates: a, sample: 30 }, { kind: 'predicted', candidates: d, sample: 30 }, sched, out);
      const less = assessSides({ kind: 'predicted', candidates: a.map((x) => ({ ...x, p: x.p * (1 - cut) })), unmapped: cut, sample: 30 }, { kind: 'predicted', candidates: d, sample: 30 }, sched, out);
      expect(RANK[less.worst]).toBeLessThanOrEqual(RANK[base.worst]);
      expect(less.bounds.risky[1]).toBeGreaterThanOrEqual(base.bounds.risky[1] - 1e-9);
      expect(less.bounds.risky[0]).toBeLessThanOrEqual(base.bounds.risky[0] + 1e-9);
    }
  });
  it('a smaller sample (more IDM open mass)', () => {
    const r = rng(11);
    for (let k = 0; k < 300; k++) {
      const out = make(r), sched = 40 + r() * 60, a = dist(r), d = dist(r);
      const big = assessSides({ kind: 'predicted', candidates: a, sample: 100, universe: ids }, { kind: 'predicted', candidates: d, sample: 100, universe: ids }, sched, out);
      const small = assessSides({ kind: 'predicted', candidates: a, sample: 4, universe: ids }, { kind: 'predicted', candidates: d, sample: 100, universe: ids }, sched, out);
      expect(RANK[small.worst]).toBeLessThanOrEqual(RANK[big.worst]);
    }
  });
  it('replacing a predicted side by "unknown" over the same areas', () => {
    const r = rng(13);
    for (let k = 0; k < 300; k++) {
      const out = make(r), sched = 40 + r() * 60, a = dist(r), d = dist(r);
      const pred = assessSides({ kind: 'predicted', candidates: a, sample: 50 }, { kind: 'observed', candidates: [d[0]] }, sched, out);
      const unk = assessSides({ kind: 'unknown', candidates: a }, { kind: 'observed', candidates: [d[0]] }, sched, out);
      expect(RANK[unk.worst]).toBeLessThanOrEqual(RANK[pred.worst]);
    }
  });
  it('coarsening the evidence (two areas merged into one terminal-level share)', () => {
    const r = rng(17);
    for (let k = 0; k < 300; k++) {
      const out = make(r), sched = 40 + r() * 60, a = dist(r);
      const fine = assessSides({ kind: 'predicted', candidates: a, sample: 50 }, { kind: 'observed', candidates: [P(['a'], 1)] }, sched, out);
      const coarse = assessSides({ kind: 'predicted', candidates: [P(['a', 'b'], a[0].p + a[1].p), a[2], a[3]], sample: 50 }, { kind: 'observed', candidates: [P(['a'], 1)] }, sched, out);
      expect(RANK[coarse.worst]).toBeLessThanOrEqual(RANK[fine.worst]);
    }
  });
  it('splitting a side over more areas with the same outcomes does not change the verdict (no pooling threshold)', () => {
    const a = assessSides({ kind: 'predicted', candidates: [P(['Z'], 1)], sample: 1000 }, { kind: 'predicted', candidates: [P(['Z'], 0.85), P(['J'], 0.15)], sample: 1000 }, 75, fra);
    const split = assessSides({ kind: 'predicted', candidates: [P(['Z'], 0.5), P(['Z2'], 0.5)], sample: 1000 }, { kind: 'predicted', candidates: [P(['Z'], 0.85), P(['J'], 0.15)], sample: 1000 }, 75, (x, y) => fra(x.replace('2', ''), y));
    expect(split.verdict).toBe(a.verdict);
    expect(split.bounds.risky[0]).toBeCloseTo(a.bounds.risky[0], 9);
  });
});

describe('no silent risk', () => {
  it('a risky pair below the tolerance is named in the text', () => {
    const r = assessSides({ kind: 'observed', candidates: [P(['Z'], 1)] }, { kind: 'predicted', candidates: [P(['Z'], 0.95), P(['J'], 0.05)], sample: 2000 }, 75, fra);
    expect(r.verdict).toBe('comfortable');   // J risky at ≈5 % < tolerance: the verdict stays, but the risk is named
    expect(r.bounds.risky[1]).toBeLessThan(RISK.tolerance);
    expect(r.text).toMatch(/Less likely but risky: Z → J/);
  });
  it('every scenario appears among the drivers (aggregated per pair)', () => {
    const { scenarios, unassignedMass } = buildScenarios({ kind: 'unknown', candidates: [P(['Z'], 1), P(['C'], 1)] }, { kind: 'predicted', candidates: [P(['Z'], 0.85), P(['J'], 0.15)], sample: 40 }, fra);
    const r = assessConnection(scenarios as Scenario[], unassignedMass, 75);
    expect(new Set(r.drivers.map((d) => d.label))).toEqual(new Set(['Z → Z', 'Z → J', 'C → Z', 'C → J']));
  });
  it('no scheduled time → not assessed', () => {
    expect(assessSides({ kind: 'observed', candidates: [P(['Z'], 1)] }, { kind: 'observed', candidates: [P(['Z'], 1)] }, null, fra).verdict).toBe('not-assessed');
  });
});

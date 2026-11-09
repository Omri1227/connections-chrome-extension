// Transfer-time combination (R-31) and allowance tables (R-32): docs/research/TRANSFER_TIME_MODEL.md.
import { describe, expect, it } from 'vitest';
import { checkInCloseFor, combine, correlationOf, fitLognormal, gateCloseFor, GATE_CLOSE, CHECKIN_CLOSE, GENERIC, monteCarlo, reference, type Part, type Span } from '../extension/src/core/timing.ts';

const P = (min: number, typical: number, max: number, group: string, correlated?: string, basis: Span['basis'] = 'assumed'): Part => ({ minutes: { min, typical, max, basis }, group, correlated });
// A representative protected FRA connection: deplane, two walks (one pace), passport + security (one peak), gate close.
const FRA: Part[] = [P(5, 10, 20, 'deplane'), P(3, 6, 10, 'walk', 'walk'), P(5, 10, 25, 'passport', 'queue'), P(5, 10, 30, 'security', 'queue'), P(2, 4, 8, 'walk', 'walk'), P(15, 20, 30, 'gateClose')];

describe('fitLognormal', () => {
  it('passes through min, median = typical and q90 = max', () => {
    const d = fitLognormal({ min: 5, typical: 10, max: 25 });
    expect(d.shift).toBe(5);
    expect(d.shift + Math.exp(d.mu)).toBeCloseTo(10, 9);
    expect(d.shift + Math.exp(d.mu + 1.2815515655446004 * d.sigma)).toBeCloseTo(25, 9);
  });
  it('degenerate spans stay finite', () => {
    expect(combine([P(20, 20, 20, 'gateClose')]).high).toBe(20);
    expect(Number.isFinite(combine([P(5, 5, 9, 'x')]).high)).toBe(true);
  });
});

describe('combine', () => {
  it('matches a 200 000-draw Monte Carlo of the same dependence model within 1.5 min', () => {
    for (const parts of [FRA, [P(2, 3, 5, 'a'), P(2, 3, 5, 'b'), P(2, 3, 5, 'c'), P(2, 3, 5, 'd')], [P(1, 2, 6, 'wait'), P(4, 7, 12, 'walk', 'walk'), P(5, 15, 40, 'ts', 'queue')]]) {
      const c = combine(parts), mc = monteCarlo(parts, 200000, 3);
      expect(Math.abs(c.high - mc.high)).toBeLessThan(1.5);
      expect(Math.abs(c.median - mc.typical)).toBeLessThan(1.0);
    }
  });
  it('a single comonotonic group gives exactly Σ max (quantiles add)', () => {
    const c = combine([P(2, 3, 5, 'walk', 'walk'), P(2, 3, 5, 'walk', 'walk'), P(2, 3, 5, 'walk', 'walk')]);
    expect(c.high).toBeCloseTo(15, 0);
    expect(c.typical).toBe(9);
  });
  it('splitting one corridor into more steps does not lower the pessimistic value (the R-31 artefact of RSS)', () => {
    const one = combine([P(8, 12, 20, 'walk', 'walk')]);
    const four = combine([0, 1, 2, 3].map(() => P(2, 3, 5, 'walk', 'walk')));
    expect(four.high).toBeGreaterThanOrEqual(one.high - 0.5);
    const rss1 = reference.rssAll([{ min: 8, typical: 12, max: 20 }]).high, rss4 = reference.rssAll([0, 1, 2, 3].map(() => ({ min: 2, typical: 3, max: 5 }))).high;
    expect(rss4).toBeLessThan(rss1);   // what the shipped add() does
  });
  it('lies between RSS-of-everything and the sum of every max when queues are correlated', () => {
    const c = combine(FRA), rss = reference.rssAll(FRA.map((p) => p.minutes)).high, sum = reference.sumOfMax(FRA.map((p) => p.minutes)).high;
    expect(c.high).toBeGreaterThan(rss);
    expect(c.high).toBeLessThan(sum);
  });
  it('more correlation never lowers the 90th percentile', () => {
    const indep = combine(FRA.map((p) => ({ ...p, correlated: undefined })));
    const corr = combine(FRA);
    const all = combine(FRA.map((p) => ({ ...p, correlated: 'all' })));
    expect(corr.high).toBeGreaterThanOrEqual(indep.high);
    expect(all.high).toBeGreaterThanOrEqual(corr.high - 0.2);
    expect(all.high).toBeCloseTo(reference.sumOfMax(FRA.map((p) => p.minutes)).high, 0);
  });
  it('adding a part never lowers min, typical or high (monotone in components)', () => {
    let prev = combine([]);
    const acc: Part[] = [];
    for (const p of FRA) { acc.push(p); const c = combine(acc); expect(c.high).toBeGreaterThanOrEqual(prev.high); expect(c.typical).toBeGreaterThanOrEqual(prev.typical); prev = c; }
  });
  it('typical is Σ typical (legacy meaning) and the median of the sum is reported separately', () => {
    const c = combine(FRA);
    expect(c.typical).toBe(60);
    expect(c.median).toBeGreaterThan(c.typical);   // right-skewed parts
    expect(c.method).toBe('comonotonic-groups+quantile-convolution');
  });
  it('basis: a small assumed part does not downgrade a measured route; a large one does', () => {
    expect(combine([P(5, 8, 20, 'walk', 'walk', 'measured'), P(1, 1, 1.5, 'x', undefined, 'assumed')]).basis).toBe('measured');
    expect(combine([P(5, 8, 20, 'walk', 'walk', 'measured'), P(10, 20, 40, 'q', 'queue', 'assumed')]).basis).toBe('assumed');
  });
});

describe('dependence groups', () => {
  it('walks share one group, queues another, customs and rides are independent', () => {
    expect(correlationOf('walk')).toBe('walk');
    expect(correlationOf('intra-walk')).toBe('walk');
    expect(correlationOf('control', 'security')).toBe('queue');
    expect(correlationOf('control', 'passport')).toBe('queue');
    expect(correlationOf('control', 'transfer-security')).toBe('queue');
    expect(correlationOf('control', 'customs')).toBeUndefined();
    expect(correlationOf('ride')).toBeUndefined();
    expect(correlationOf('wait')).toBeUndefined();
  });
});

describe('allowance tables', () => {
  it('every published value carries a source; generic values are assumed, or derived with their sources', () => {
    for (const a of Object.values(GATE_CLOSE)) { expect(a.basis).toBe('published'); expect(a.sources.length).toBeGreaterThan(0); }
    for (const v of Object.values(CHECKIN_CLOSE)) for (const a of [v.short, v.long]) expect(a.sources.length).toBeGreaterThan(0);
    for (const a of Object.values(GENERIC)) {
      expect(['assumed', 'derived']).toContain(a.basis);
      if (a.basis === 'assumed') expect(a.sources).toEqual([]); else expect(a.sources.length).toBeGreaterThan(0);
    }
  });
  it('airline lookups and fallbacks', () => {
    expect(gateCloseFor('AF').typical).toBe(20);
    expect(gateCloseFor('kl').typical).toBe(15);
    expect(gateCloseFor('IB')).toBe(GENERIC.gateClose);   // Iberia not read (iberia.com blocked)
    expect(gateCloseFor(null)).toBe(GENERIC.gateClose);
    expect(checkInCloseFor('AF', true, 'IL').typical).toBe(90);
    expect(checkInCloseFor('LH', true).typical).toBe(60);
    expect(checkInCloseFor('XX', false)).toBe(GENERIC.checkInClose);
  });
});

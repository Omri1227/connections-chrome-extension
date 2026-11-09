// Shared airport-map engine: validator and router on a small synthetic airport (not real data).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AirportModel, Control } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute, routeWithAlternatives } from '../airportmaps/src/route.ts';

const M = (v: number) => ({ min: v * 0.7, typical: v, max: v * 1.5, basis: 'assumed' as const });
const passport: Control = { kind: 'passport', minutes: M(10) };
const security: Control = { kind: 'security', minutes: M(12) };

function demo(): AirportModel {
  return {
    iata: 'XXX', name: 'Demo', city: 'Nowhere', asOf: '2026-10-31',
    schematic: { width: 1000, height: 640, northDeg: 0 },
    sources: [
      { id: 'src:a', title: 'Official map', url: 'https://example.org/a', publisher: 'Airport', kind: 'official-map', group: 'airport', accessed: '2026-10-31' },
      { id: 'src:b', title: 'Video', url: 'https://example.org/b', publisher: 'Channel', kind: 'video', group: 'yt-channel', accessed: '2026-10-31' },
    ],
    areas: [
      { id: 'land1', name: 'T1 landside', short: 'T1', kind: 'landside-hall', side: 'landside', zone: 'n/a', matrix: true, anchor: [100, 300], confidence: 'probable', sources: ['src:a'] },
      { id: 'land2', name: 'T2 landside', short: 'T2', kind: 'landside-hall', side: 'landside', zone: 'n/a', matrix: true, anchor: [800, 300], confidence: 'probable', sources: ['src:a'] },
      { id: 'A', name: 'Concourse A', short: 'A', kind: 'concourse', side: 'airside', zone: 'schengen', matrix: true, anchor: [100, 150], confidence: 'verified', sources: ['src:a', 'src:b'] },
      { id: 'B', name: 'Concourse B', short: 'B', kind: 'concourse', side: 'airside', zone: 'non-schengen', matrix: true, anchor: [300, 150], confidence: 'probable', sources: ['src:a'] },
      { id: 'D', name: 'Concourse D', short: 'D', kind: 'concourse', side: 'airside', zone: 'schengen', matrix: true, anchor: [800, 150], confidence: 'probable', sources: ['src:a'] },
    ],
    gateGroups: [{ id: 'g:a', area: 'A', label: 'A1–A3', gates: ['A1', 'A2', 'A3'], path: [[80, 140], [120, 140]], confidence: 'probable', sources: ['src:a'] }],
    stops: [
      { id: 's:t1', name: 'Train T1', area: 'land1', side: 'landside', anchor: [150, 320], accessMinutes: M(3), confidence: 'probable', sources: ['src:a'] },
      { id: 's:t2', name: 'Train T2', area: 'land2', side: 'landside', anchor: [750, 320], accessMinutes: M(3), confidence: 'probable', sources: ['src:a'] },
      { id: 's:busB', name: 'Bus B', area: 'B', side: 'airside', anchor: [320, 180], accessMinutes: M(2), confidence: 'probable', sources: ['src:a'] },
      { id: 's:busD', name: 'Bus D', area: 'D', side: 'airside', anchor: [780, 180], accessMinutes: M(2), confidence: 'probable', sources: ['src:a'], egressControls: [passport] },
    ],
    lines: [
      { id: 'l:train', name: 'Train', mode: 'people-mover', colour: '#2266aa', access: 'public', side: 'landside', stops: ['s:t1', 's:t2'], direction: 'both', rideMin: [2], service: [{ hours: '00:00–24:00', headwayMin: { min: 2, max: 4 }, waitMin: M(2) }], eligibility: 'anyone', confidence: 'probable', sources: ['src:a'] },
      { id: 'l:bus', name: 'Transfer bus', mode: 'bus', colour: '#aa6622', access: 'transfer', side: 'airside', stops: ['s:busB', 's:busD'], direction: 'both', rideMin: [8], service: [{ hours: '05:00–23:00', headwayMin: { min: 5, max: 10 }, waitMin: M(4) }], eligibility: 'transfer passengers', confidence: 'probable', sources: ['src:a'] },
    ],
    walks: [
      { id: 'w:A-B', from: 'A', to: 'B', bidirectional: true, access: 'airside', minutes: M(5), controls: [passport], practical: 'practical', confidence: 'probable', sources: ['src:a'] },
      { id: 'w:land1-A', from: 'land1', to: 'A', bidirectional: true, access: 'public', minutes: M(4), controls: [security], reverseControls: [], practical: 'practical', confidence: 'probable', sources: ['src:a'] },
      { id: 'w:land2-D', from: 'land2', to: 'D', bidirectional: true, access: 'public', minutes: M(4), controls: [security], reverseControls: [], practical: 'practical', confidence: 'probable', sources: ['src:a'] },
      { id: 'w:land1-land2', from: 'land1', to: 'land2', bidirectional: true, access: 'public', minutes: M(25), practical: 'long', confidence: 'inferred', sources: [] },
      { id: 'w:A-D-staff', from: 'A', to: 'D', bidirectional: true, access: 'restricted', minutes: M(3), practical: 'avoid', confidence: 'probable', sources: ['src:a'] },
    ],
    rules: [], openQuestions: [],
  };
}

describe('airport-map validator', () => {
  it('accepts the demo model', () => {
    const r = validateAirport(demo());
    expect(r.errors).toEqual([]);
  });
  it('rejects landside → airside walks without security and Schengen ↔ non-Schengen walks without passport control', () => {
    const m = demo();
    m.walks[0].controls = [];
    m.walks[1].controls = [];
    const r = validateAirport(m);
    expect(r.errors.some((e) => e.includes('without a passport control'))).toBe(true);
    expect(r.errors.some((e) => e.includes('without a security control'))).toBe(true);
  });
  it('requires two independent groups for verified and known references', () => {
    const m = demo();
    m.areas[0].confidence = 'verified';
    m.gateGroups[0].area = 'nope';
    m.gateGroups.push({ ...m.gateGroups[0], id: 'g:dup' });
    const r = validateAirport(m);
    expect(r.errors.some((e) => e.includes("'verified' needs"))).toBe(true);
    expect(r.errors.some((e) => e.includes('unknown area nope'))).toBe(true);
    expect(r.errors.some((e) => e.includes('gate A1 listed in'))).toBe(true);
  });
  it('checks rideMin length against the line direction', () => {
    const m = demo();
    m.lines[0].direction = 'loop';
    expect(validateAirport(m).errors.some((e) => e.includes('rideMin has 1 values'))).toBe(true);
  });
});

describe('airport-map router', () => {
  it('never uses restricted connections', () => {
    const r = findRoute(demo(), 'A', 'D')!;
    expect(r.steps.some((s) => s.refId === 'w:A-D-staff')).toBe(false);
  });
  it('uses transfer-only services only for connecting passengers', () => {
    const m = demo();
    const t = findRoute(m, 'B', 'D', { transfer: true })!;
    expect(t.lines).toContain('l:bus');
    const p = findRoute(m, 'B', 'D', { transfer: false })!;
    expect(p.lines).not.toContain('l:bus');
  });
  it('never uses transfer-only services when the destination is landside', () => {
    const m = demo();
    // make the transfer bus the fastest way B → land2 (via D)
    m.walks.find((w) => w.id === 'w:land1-land2')!.practical = 'avoid';
    const r = findRoute(m, 'B', 'land2', { transfer: true })!;
    expect(r.lines).not.toContain('l:bus');
    expect(findRoute(m, 'B', 'D', { transfer: true })!.lines).toContain('l:bus');
  });
  it('counts a wait once per boarding and applies alighting controls', () => {
    const r = findRoute(demo(), 'B', 'D')!;
    expect(r.steps.filter((s) => s.kind === 'wait')).toHaveLength(1);
    expect(r.controls).toContain('passport');
    expect(r.borderCrossings).toBe(1);
  });
  it('totals equal the sum of the steps', () => {
    const r = findRoute(demo(), 'land1', 'D')!;
    expect(r.total.typical).toBeCloseTo(r.steps.reduce((s, x) => s + x.minutes.typical, 0));
    expect(r.total.min).toBeLessThanOrEqual(r.total.typical);
    expect(r.total.max).toBeGreaterThanOrEqual(r.total.typical);
  });
  it('prefers the train to a long walk landside and offers the walk as an alternative', () => {
    const c = routeWithAlternatives(demo(), 'land1', 'land2');
    expect(c.route!.lines).toEqual(['l:train']);
    expect(c.alternatives.some((a) => a.label === 'Walking only')).toBe(true);
  });
  it('builds a full matrix with a route in every off-diagonal cell', () => {
    const mx = buildMatrix(demo());
    expect(mx.areas).toHaveLength(5);
    expect(mx.cells.filter((c) => c.from !== c.to && !c.route)).toEqual([]);
  });
});

describe('time of day, ride ranges, movement vs controls (phase 2)', () => {
  const night = (): AirportModel => {
    const m = demo();
    const bus = m.lines[1];
    bus.service = [
      { hours: '05:00–23:00', windows: [{ from: '05:00', until: '23:00' }], headwayMin: { min: 5, max: 10 }, waitMin: M(4) },
    ];
    bus.ride = [{ min: 6, typical: 8, max: 11, basis: 'measured' }];
    return m;
  };
  it('runs a line only inside its service windows when a time is given', () => {
    const m = night();
    expect(findRoute(m, 'B', 'D', { transfer: true, time: '10:00' })!.lines).toEqual(['l:bus']);
    // at 03:00 the transfer bus is not running: the only way is via landside (passport, security again)
    const r = findRoute(m, 'B', 'D', { transfer: true, time: '03:00' });
    expect(r?.lines ?? []).not.toContain('l:bus');
    // without a time the typical daytime service is used
    expect(findRoute(m, 'B', 'D')!.lines).toEqual(['l:bus']);
  });
  it('handles windows that wrap past midnight and weekday / date-limited patterns', () => {
    const m = night();
    m.lines[1].service = [
      { hours: '22:00–05:00 (night)', windows: [{ from: '22:00', until: '05:00' }], headwayMin: { min: 20, max: 30 }, waitMin: M(12), days: ['sat', 'sun'] },
      { hours: '05:00–22:00', windows: [{ from: '05:00', until: '22:00' }], headwayMin: { min: 5, max: 10 }, waitMin: M(4), validUntil: '2026-12-31' },
    ];
    // 2026-10-31 is a Saturday
    const sat = findRoute(m, 'B', 'D', { transfer: true, time: '02:00', date: '2026-10-31' })!;
    expect(sat.steps.find((s) => s.kind === 'wait')!.minutes.typical).toBe(12);
    // Monday 02:00 is still the Sunday-night service (service-day semantics, R-45); Tuesday 02:00 is Monday night: none
    const mon = findRoute(m, 'B', 'D', { transfer: true, time: '02:00', date: '2026-11-02' })!;
    expect(mon.steps.find((s) => s.kind === 'wait')!.minutes.typical).toBe(12);
    const tue = findRoute(m, 'B', 'D', { transfer: true, time: '02:00', date: '2026-11-03' });
    expect(tue?.lines ?? []).not.toContain('l:bus');
    const day2027 = findRoute(m, 'B', 'D', { transfer: true, time: '10:00', date: '2027-01-04' });
    expect(day2027?.lines ?? []).not.toContain('l:bus');
  });
  it('a bounded works timetable replaces the normal pattern for the whole day (no fall-back outside its windows)', () => {
    const m = night();
    m.lines[1].service = [
      { hours: '05:00–23:00 (works)', windows: [{ from: '05:00', until: '23:00' }], headwayMin: { min: 10, max: 10 }, waitMin: M(5), validFrom: '2026-11-01', validUntil: '2026-11-30' },
      { hours: 'not published', headwayMin: { min: 5, max: 5 }, waitMin: M(2) },
    ];
    const inWorks = (t: string) => findRoute(m, 'B', 'D', { transfer: true, time: t, date: '2026-11-15' });
    expect(inWorks('12:00')!.lines).toContain('l:bus');
    expect(inWorks('03:00')?.lines ?? []).not.toContain('l:bus');
    // Outside the works period the undated pattern applies at any time.
    expect(findRoute(m, 'B', 'D', { transfer: true, time: '03:00', date: '2026-12-15' })!.lines).toContain('l:bus');
  });
  it('closes walks and stops outside their hours', () => {
    const m = night();
    m.walks[0].hours = [{ from: '05:00', until: '23:30' }];
    expect(findRoute(m, 'A', 'B', { transfer: true, time: '12:00' })!.steps[0].refId).toBe('w:A-B');
    expect(findRoute(m, 'A', 'B', { transfer: true, time: '01:00' })?.steps.some((s) => s.refId === 'w:A-B') ?? false).toBe(false);
  });
  it('reports ride ranges with their basis and splits movement from control time', () => {
    const r = findRoute(night(), 'B', 'D')!;
    const ride = r.steps.find((s) => s.kind === 'ride')!;
    expect(ride.minutes).toMatchObject({ min: 6, typical: 8, max: 11, basis: 'measured' });
    expect(r.controlTime.typical).toBe(10); // passport on alighting at D
    expect(r.movement.typical + r.controlTime.typical).toBeCloseTo(r.total.typical);
    expect(r.basisMix.measured).toBe(8);
    // a line without ride ranges or rideBasis reports its rides as assumed, not published
    const r2 = findRoute(demo(), 'land1', 'land2', { transfer: true, preferTransport: true })!;
    expect(r2.steps.find((s) => s.kind === 'ride')!.minutes.basis).toBe('assumed');
  });
  it('never routes a line marked notRouted, and warns about unpublished hours when a time is asked', () => {
    const m = demo();
    m.lines[1].notRouted = 'operation unverified';
    expect(findRoute(m, 'B', 'D')?.lines ?? []).not.toContain('l:bus');
    const w = findRoute(demo(), 'B', 'D', { transfer: true, time: '03:00' })!;
    expect(w.warnings.some((x) => x.includes('hours not published'))).toBe(true);
  });
  it('validates windows, ride ranges, replacement links and duplicate controls', () => {
    const m = night();
    m.lines[1].service[0].windows = [{ from: '5:00', until: '23:00' }];
    m.lines[1].ride = [{ min: 6, typical: 9, max: 11, basis: 'measured' }];
    m.lines[0].replaces = 'l:nope';
    m.walks[1].controls = [security, security];
    m.lines[0].notRouted = ' ';
    const e = validateAirport(m).errors.join('\n');
    expect(e).toContain('times must be HH:MM');
    expect(e).toContain('ride[0].typical 9');
    expect(e).toContain('replaces unknown line');
    expect(e).toContain('listed twice');
    expect(e).toContain('notRouted needs a reason');
  });
  it('warns when a route passes security twice', () => {
    const m = demo();
    m.lines.splice(1, 1); // no transfer bus: A → D must go landside and back airside
    // modelling slip: the exit direction reuses the entry security (no reverseControls) → counted twice
    delete m.walks[1].reverseControls;
    const r = findRoute(m, 'A', 'D')!;
    expect(r.warnings.some((x) => x.includes('passes security'))).toBe(true);
  });
});

describe('status periods, arrivals flows, stacks and border zones', () => {
  const susp = (from?: string, until?: string) => [{ state: 'suspended' as const, from, until, note: 'works', confidence: 'probable' as const, sources: ['src:a'] }];
  it('does not route a line while it is suspended, and routes it again afterwards', () => {
    const m = demo();
    m.lines[0].status = susp('2026-10-01', '2026-11-30');
    expect(findRoute(m, 'land1', 'land2')!.lines).not.toContain('l:train');
    expect(findRoute(m, 'land1', 'land2', { transfer: true, date: '2026-12-01' })!.lines).toContain('l:train');
  });
  it('drops a closed area from the routing graph and from the matrix', () => {
    const m = demo();
    m.areas[4].status = [{ state: 'closed', from: '2026-06-09', note: 'closed', confidence: 'probable', sources: ['src:a'] }];
    expect(findRoute(m, 'A', 'D')).toBeNull();
    expect(routeWithAlternatives(m, 'A', 'D').reason).toMatch(/closed/);
    expect(buildMatrix(m).areas.map((a) => a.id)).not.toContain('D');
  });
  it('uses an arrivals-flow walk only at the start of a route from an arriving flight', () => {
    const m = demo();
    // B → land2 only through the arrivals flow (one-way, no controls modelled for the demo)
    m.walks.push({ id: 'w:B-arr', from: 'B', to: 'land1', bidirectional: false, access: 'airside', flow: 'arrivals', minutes: M(3), practical: 'practical', confidence: 'probable', sources: ['src:a'] });
    expect(validateAirport(m).errors).toEqual([]);
    const r = findRoute(m, 'B', 'land1')!;
    expect(r.steps[0].refId).toBe('w:B-arr');
    // not usable after another movement: A → B → land1 must not use it
    const viaA = findRoute(m, 'A', 'land1')!;
    expect(viaA.steps.some((s) => s.refId === 'w:B-arr')).toBe(false);
    // and not at all when the origin is not an arriving flight
    expect(findRoute(m, 'B', 'land1', { transfer: true, fromArrival: false })?.steps.some((s) => s.refId === 'w:B-arr') ?? false).toBe(false);
  });
  it('makes an arriving passenger leave a segregated area through the arrivals flow', () => {
    const m = demo();
    m.walks.push({ id: 'w:B-arr', from: 'B', to: 'land1', bidirectional: false, access: 'airside', flow: 'arrivals', minutes: M(3), practical: 'practical', confidence: 'probable', sources: ['src:a'] });
    m.areas[3].arrivals = 'segregated';
    expect(validateAirport(m).errors).toEqual([]);
    const r = findRoute(m, 'B', 'A')!; // arriving at B: not the direct B → A walk, but arrivals flow → landside → security → A
    expect(r.steps[0].refId).toBe('w:B-arr');
    expect(r.controls).toContain('security');
    // a passenger already departing from B (not arriving) may walk directly
    expect(findRoute(m, 'B', 'A', { transfer: true, fromArrival: false })!.steps[0].refId).toBe('w:A-B');
    m.walks.pop();
    expect(validateAirport(m).errors.some((e) => e.includes("arrivals 'segregated' but no"))).toBe(true);
  });
  it('rejects a bidirectional arrivals flow and checks stacks and status periods', () => {
    const m = demo();
    m.walks[0].flow = 'arrivals';
    m.areas[2].stack = { group: 'ab', order: 0, label: 'L2' };
    m.areas[3].stack = { group: 'ab', order: 0, label: 'L3' };
    m.lines[1].status = [{ state: 'suspended', from: '2026-12-01', until: '2026-11-01', note: 'x', confidence: 'probable', sources: ['src:nope'] }];
    const e = validateAirport(m).errors;
    expect(e.some((x) => x.includes('must be one-way'))).toBe(true);
    expect(e.some((x) => x.includes('duplicate order'))).toBe(true);
    expect(e.some((x) => x.includes('from after until'))).toBe(true);
    expect(e.some((x) => x.includes('unknown source src:nope'))).toBe(true);
  });
  it('requires passport control between domestic and international zones', () => {
    const m = demo();
    m.areas[2].zone = 'domestic'; m.areas[3].zone = 'international'; m.areas[4].zone = 'domestic';
    m.walks[0].controls = [];
    expect(validateAirport(m).errors.some((x) => x.includes('domestic ↔ international'))).toBe(true);
  });
  it('finds a gate regardless of case and spacing', async () => {
    const { findGate } = await import('../airportmaps/src/route.ts');
    expect(findGate(demo(), 'a 2')?.area.id).toBe('A');
    expect(findGate(demo(), 'Z9')).toBeNull();
  });
});

// Every bundled airport: valid, every matrix pair routable (the airport-specific tests check the facts).
const dataDir = path.join(import.meta.dirname, '..', 'airportmaps', 'data');
const airports = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((d) => fs.existsSync(path.join(dataDir, d, 'airport.json'))) : [];
describe.each(airports)('bundled airport %s', (code) => {
  const m = JSON.parse(fs.readFileSync(path.join(dataDir, code, 'airport.json'), 'utf8')) as AirportModel;
  const evp = path.join(dataDir, code, 'evidence.json');
  const ev = fs.existsSync(evp) ? JSON.parse(fs.readFileSync(evp, 'utf8')) : undefined;
  it('validates without errors', () => { expect(validateAirport(m, ev).errors).toEqual([]); });
  it('routes every pair of matrix areas', () => {
    const mx = buildMatrix(m);
    expect(mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}>${c.to}`)).toEqual([]);
  });
  it('no route is longer than 3 hours or uses a restricted connection', () => {
    const restricted = new Set(m.walks.filter((w) => w.access === 'restricted').map((w) => w.id));
    for (const c of buildMatrix(m).cells) {
      if (!c.route) continue;
      expect(c.route.total.typical).toBeLessThan(180);
      expect(c.route.steps.some((s) => s.refId && restricted.has(s.refId))).toBe(false);
    }
  });
  it('a connection within an area with segregated arrivals leaves through the arrivals flow (never 0 min), without crossing passport control', () => {
    for (const a of m.areas.filter((x) => x.arrivals === 'segregated')) {
      const r = findRoute(m, a.id, a.id)!;
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.steps[0].kind).toBe('walk');
      expect(r.steps[0].text).toMatch(/arrivals flow/);
      expect(r.borderCrossings).toBe(0);
      // A passenger who is not arriving (already at the departure level) walks between two gates of the area (never 0, R-02).
      const w = findRoute(m, a.id, a.id, { transfer: true, fromArrival: false })!;
      expect(w.steps.map((x) => x.kind)).toEqual(['walk']);
      expect(w.total.typical).toBeGreaterThan(0);
      expect(w.controls).toEqual([]);
    }
  });
});

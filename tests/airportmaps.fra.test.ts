// FRA (Frankfurt am Main) data model: gate lists, zones, connections and safety rules (data assertions, as of 2026-10-31).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/fra/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute, serviceAt, stateOn } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('fra');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const line = (id: string) => m.lines.find((l) => l.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);

describe('FRA model validity', () => {
  it('validates without errors', () => {
    expect(validateAirport(m, EV).errors).toEqual([]);
  });
  it('every matrix pair is routable', () => {
    const mx = buildMatrix(m);
    const missing = mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`);
    expect(missing).toEqual([]);
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['fra-rail-long', 'fra-t1-a', 'fra-t1-b-n', 'fra-t1-b-s', 'fra-t1-c', 'fra-t1-hall', 'fra-t1-z', 'fra-t3-h', 'fra-t3-hall', 'fra-t3-j']);
  });
});

describe('FRA terminal status (2026-10-31)', () => {
  it('Terminal 2 is closed: no D/E gates, no T2 area in the matrix', () => {
    expect(allGates.filter((g) => /^[DE]\d/.test(g))).toEqual([]);
    expect(m.areas.filter((a) => a.terminal === 'T2' && a.matrix)).toEqual([]);
    expect(m.rules.find((r) => r.id === 'r:fra-t2-closed')!.text).toContain('9 June 2026');
  });
  it('the T2 terminal area is closed from 9 June 2026, while its Sky Line interchange stays open', () => {
    const t2 = area('fra-t2');
    expect(stateOn(t2.status, '2026-06-08')).toBe('active');
    expect(stateOn(t2.status, '2026-06-09')).toBe('closed');
    expect(stateOn(t2.status, m.asOf)).toBe('closed');
    for (const id of ['fra-t2-land', 'fra-t2-air']) expect(stateOn(area(id).status, m.asOf)).toBe('active');
    expect(buildMatrix(m).areas.map((a) => a.id)).not.toContain('fra-t2');
  });
  it('Terminal 3 areas are planned before 23 April 2026 and drop out of the matrix then', () => {
    for (const id of ['fra-t3-hall', 'fra-t3-h', 'fra-t3-j']) {
      expect(stateOn(area(id).status, '2026-04-22')).toBe('planned');
      expect(stateOn(area(id).status, '2026-04-23')).toBe('active');
    }
    const ids = buildMatrix(m, { transfer: true, date: '2026-04-01' }).areas.map((a) => a.id);
    expect(ids.filter((id) => id.startsWith('fra-t3'))).toEqual([]);
    expect(ids).toContain('fra-t1-a');
  });
  it('Terminal 3 is open with piers H (Schengen), J (non-Schengen) and G (mixed, no gates attested)', () => {
    expect(area('fra-t3-h').zone).toBe('schengen');
    expect(area('fra-t3-j').zone).toBe('non-schengen');
    expect(area('fra-t3-g').zone).toBe('mixed');
    expect(gatesOf('fra-t3-g')).toEqual([]);
    expect(allGates.filter((g) => g.startsWith('G'))).toEqual([]);
  });
});

describe('FRA gates per area (OSM 2026-10-31 + sources)', () => {
  it('concourse A (Schengen) holds A gates only, incl. A-Plus A50–A69', () => {
    const a = gatesOf('fra-t1-a');
    expect(a.every((g) => g.startsWith('A'))).toBe(true);
    for (const g of ['A1', 'A5', 'A15', 'A26', 'A40', 'A50', 'A69']) expect(a).toContain(g);
    expect(a).not.toContain('A12');
  });
  it('concourse Z holds Z gates; Z11–Z25 only as attested (Z22, Z23)', () => {
    const z = gatesOf('fra-t1-z');
    expect(z.every((g) => g.startsWith('Z'))).toBe(true);
    expect(m.gateGroups.find((g) => g.id === 'fra-gates-z11-z25')!.gates).toEqual(['Z22', 'Z23']);
    for (const g of ['Z50', 'Z69']) expect(z).toContain(g);
  });
  it('B is split at B19/B20: B1–B19 Schengen, B20+ non-Schengen', () => {
    const num = (g: string) => parseInt(g.slice(1), 10);
    expect(gatesOf('fra-t1-b-s').every((g) => g.startsWith('B') && num(g) <= 19)).toBe(true);
    expect(gatesOf('fra-t1-b-n').every((g) => g.startsWith('B') && num(g) >= 20)).toBe(true);
    expect(gatesOf('fra-t1-b-s')).toContain('B19');
    expect(gatesOf('fra-t1-b-n')).toEqual(expect.arrayContaining(['B20', 'B28', 'B41', 'B48', 'B60', 'B62']));
  });
  it('dual-numbered bus gates: B14–B16 (Schengen) and B60–B62 (non-Schengen) are bus gates', () => {
    const s = m.gateGroups.find((g) => g.id === 'fra-gates-b14-b16-bus')!;
    const n = m.gateGroups.find((g) => g.id === 'fra-gates-b-bus-ns')!;
    expect(s.bus && n.bus).toBe(true);
    expect(s.gates).toEqual(['B14', 'B15', 'B16']);
    expect(n.gates).toEqual(expect.arrayContaining(['B60', 'B61', 'B62']));
  });
  it('C gates are in concourse C; C1 kept with an unresolved zone', () => {
    expect(gatesOf('fra-t1-c').every((g) => g.startsWith('C'))).toBe(true);
    const c1 = m.gateGroups.find((g) => g.id === 'fra-gates-c1')!;
    expect(c1.zone).toBe('mixed');
    expect(c1.confidence).toBe('unknown');
  });
  it('T3: H1–H13 and J1–J14 contact gates; J3 (first T3 flight) present; apron-level groups are bus gates (probable, counts match 5 H / 8 J)', () => {
    expect(m.gateGroups.find((g) => g.id === 'fra-gates-j-contact')!.gates).toEqual(Array.from({ length: 14 }, (_, i) => `J${i + 1}`));
    expect(gatesOf('fra-t3-h')).toEqual(expect.arrayContaining(['H1', 'H6', 'H13', 'H51', 'H56']));
    const h50 = m.gateGroups.find((g) => g.id === 'fra-gates-h50s')!, j50 = m.gateGroups.find((g) => g.id === 'fra-gates-j50s')!;
    for (const g of [h50, j50]) { expect(g.confidence).toBe('probable'); expect(g.bus).toBe(true); }
    expect(h50.gates.length).toBe(5);
    expect(j50.gates.length).toBe(8);
  });
  it('no gate is listed twice and the total is stable', () => {
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(allGates.length).toBe(136);
  });
});

describe('FRA zones and controls (safety)', () => {
  it('Schengen ↔ non-Schengen walks always pass passport control, both directions', () => {
    for (const id of ['w:fra-a-z', 'w:fra-bs-bn', 'w:fra-t3-h-j']) {
      const w = walk(id);
      expect(kinds(w.controls)).toContain('passport');
      expect(kinds(w.reverseControls ?? w.controls)).toContain('passport');
    }
  });
  it('entering airside from the public side always passes security', () => {
    for (const w of m.walks) {
      const a = area(w.from), b = area(w.to);
      if (w.access === 'restricted') continue;
      if (a.side === 'landside' && b.side === 'airside') expect(kinds(w.controls)).toEqual(expect.arrayContaining([expect.stringMatching(/security/)]));
      if (w.bidirectional && b.side === 'landside' && a.side === 'airside') expect(kinds(w.reverseControls ?? w.controls)).toEqual(expect.arrayContaining([expect.stringMatching(/security/)]));
    }
  });
  it('the A15–B19 tunnel stays inside Schengen without a control', () => {
    const w = walk('w:fra-a-bs');
    expect(area(w.from).zone).toBe('schengen');
    expect(area(w.to).zone).toBe('schengen');
    expect(w.controls ?? []).toEqual([]);
  });
  it('transfer-only lines are airside and never stop in a landside area', () => {
    for (const l of m.lines.filter((x) => x.access === 'transfer')) {
      expect(l.side).toBe('airside');
      for (const sid of l.stops) expect(area(m.stops.find((s) => s.id === sid)!.area).side).toBe('airside');
    }
  });
  it('the Sky Line connecting-flights car only serves non-Schengen areas', () => {
    for (const id of ['l:fra-skyline2-transfer', 'l:fra-skyline1-transfer']) {
      for (const sid of line(id).stops) expect(area(m.stops.find((s) => s.id === sid)!.area).zone).toBe('non-schengen');
    }
  });
  it('the B → A apron bus is one-way and ends with passport control into Schengen A', () => {
    const l = line('l:fra-bus-bn-a');
    expect(l.direction).toBe('one-way');
    const last = m.stops.find((s) => s.id === l.stops.at(-1))!;
    expect(area(last.area).zone).toBe('schengen');
    expect(kinds(last.egressControls)).toContain('passport');
  });
});

describe('FRA stacked levels', () => {
  it('A (level 2, Schengen) and Z (level 3, non-Schengen) share one footprint as a stack', () => {
    const a = area('fra-t1-a'), z = area('fra-t1-z');
    expect(a.stack).toEqual({ group: 'fra-a-z', order: 0, label: 'L2' });
    expect(z.stack).toEqual({ group: 'fra-a-z', order: 1, label: 'L3' });
    expect(z.shape).toEqual(a.shape);
    expect([a.zone, z.zone]).toEqual(['schengen', 'non-schengen']);
  });
  it('pier J departures (L3) and its non-Schengen arrivals level (L2) are a stack', () => {
    const j = area('fra-t3-j'), ja = area('fra-t3-j-arr');
    expect(ja.stack!.group).toBe(j.stack!.group);
    expect(ja.stack!.order).toBeLessThan(j.stack!.order);
    expect(ja.shape).toEqual(j.shape);
    expect(ja.zone).toBe('non-schengen');
    expect(ja.matrix).toBe(false);
  });
});

describe('FRA arrivals flows', () => {
  it('non-Schengen arrivals leave through entry passport control on one-way arrivals walks', () => {
    for (const id of ['w:fra-z-hall-arr', 'w:fra-bn-hall-arr', 'w:fra-c-hall-arr', 'w:fra-t3-j-arr', 'w:fra-t3-jarr-hall']) {
      const w = walk(id);
      expect(w.flow).toBe('arrivals');
      expect(w.bidirectional).toBe(false);
    }
    for (const id of ['w:fra-z-hall-arr', 'w:fra-bn-hall-arr', 'w:fra-c-hall-arr', 'w:fra-t3-jarr-hall']) expect(kinds(walk(id).controls)).toContain('passport');
    for (const id of ['w:fra-hall-z', 'w:fra-hall-bn', 'w:fra-hall-c', 'w:fra-t3hall-j']) expect(walk(id).bidirectional).toBe(false);
  });
  it('pier J arrivals are segregated: every route from J (arriving) starts on the arrivals level; only J is marked', () => {
    expect(area('fra-t3-j').arrivals).toBe('segregated');
    expect(m.areas.filter((a) => a.arrivals === 'segregated').map((a) => a.id)).toEqual(['fra-t3-j']);
    for (const c of buildMatrix(m).cells.filter((x) => x.from === 'fra-t3-j' && x.to !== 'fra-t3-j')) expect(c.route!.steps[0].refId).toBe('w:fra-t3-j-arr');
    const jh = findRoute(m, 'fra-t3-j', 'fra-t3-h')!;
    expect(jh.borderCrossings).toBe(1);
    expect(jh.steps.map((s) => s.refId).filter((x) => x?.startsWith('w:'))).toContain('w:fra-t3-h-j');
    // a passenger already in the J departures area (not arriving) walks straight to H
    expect(findRoute(m, 'fra-t3-j', 'fra-t3-h', { transfer: true, fromArrival: false })!.steps[0].refId).toBe('w:fra-t3-h-j');
  });
  it('the connecting-flights car serves the pier J arrivals level; T1 → J climbs to departures via a (possible) transfer security check', () => {
    expect(m.stops.find((s) => s.id === 's:fra-sl2-t3-air')!.area).toBe('fra-t3-j-arr');
    const r = findRoute(m, 'fra-t1-z', 'fra-t3-j')!;
    expect(r.steps.some((s) => s.refId === 'w:fra-t3-jarr-j')).toBe(true);
    expect(r.controls).toContain('transfer-security');
  });
  it('an arriving J passenger reaches T1 Z airside via the arrivals level; a non-arriving one cannot use the arrivals flow', () => {
    const arr = findRoute(m, 'fra-t3-j', 'fra-t1-z')!;
    expect(arr.steps.some((s) => s.refId === 'w:fra-t3-j-arr')).toBe(true);
    expect(arr.lines).toEqual(['l:fra-skyline2-transfer', 'l:fra-skyline1-transfer']);
    expect(arr.borderCrossings).toBe(0);
    const dep = findRoute(m, 'fra-t3-j', 'fra-t1-z', { transfer: true, fromArrival: false })!;
    expect(dep.steps.some((s) => s.refId === 'w:fra-t3-j-arr')).toBe(false);
    expect(dep.lines).not.toContain('l:fra-skyline2-transfer');
  });
});

describe('FRA transport', () => {
  it('public Sky Line: T1 rail stations → T2 → T3, 04:00–23:00 every 2–3 min (published), measured ≈7 min end to end', () => {
    const l = line('l:fra-skyline2-public');
    expect(l.stops.map((s) => m.stops.find((x) => x.id === s)!.area)).toEqual(['fra-rail-regional', 'fra-t2-land', 'fra-t3-hall']);
    expect(l.service[0].hours).toBe('04:00–23:00');
    expect(l.service[0].windows).toEqual([{ from: '04:00', until: '23:00' }]);
    expect(l.service[0].headwayMin).toEqual({ min: 2, max: 3 });
    expect(l.service[0].headwayBasis).toBe('published');
    // measured June 2026 (after the 50 km/h restart): T3 → T2 ≈4.3 min + dwell, T2 → T1 ≈2.4 min; official "eight minutes or less"
    expect(l.rideMin).toEqual([2.5, 4.5]);
    expect(l.ride!.map((r) => r.basis)).toEqual(['measured', 'measured']);
    expect(l.ride!.reduce((s, r) => s + r.max, 0)).toBeGreaterThanOrEqual(8);
    expect(l.confidence).toBe('verified');
  });
  it('the connecting-flights car rides in the same vehicles: same hours, headway and T2 → T3 ride', () => {
    const p = line('l:fra-skyline2-public'), t = line('l:fra-skyline2-transfer');
    expect(t.service[0].windows).toEqual(p.service[0].windows);
    expect(t.service[0].headwayMin).toEqual(p.service[0].headwayMin);
    expect(t.ride![0]).toEqual(expect.objectContaining({ typical: p.ride![1].typical, basis: 'measured' }));
    expect(t.confidence).toBe('verified');
  });
  it('old SkyLine: transit car only (A/Z and C transit areas → T2), 05:00–23:00; public car closed since the T3 opening', () => {
    const t = line('l:fra-skyline1-transfer');
    expect(t.stops).toEqual(['s:fra-sl1-z', 's:fra-sl1-c', 's:fra-sl1-t2-air']);
    expect(m.stops.some((s) => s.id === 's:fra-sl1-bn')).toBe(false);
    expect(t.service[0].windows).toEqual([{ from: '05:00', until: '23:00' }]);
    expect(stateOn(t.status, m.asOf)).toBe('active');
    const p = line('l:fra-skyline1-public');
    expect(stateOn(p.status, '2026-04-22')).toBe('active');
    expect(stateOn(p.status, '2026-04-23')).toBe('closed');
    for (const c of buildMatrix(m).cells) expect(c.route?.lines ?? []).not.toContain('l:fra-skyline1-public');
  });
  it('the B → A apron bus (seen once, 2025) is drawn but not routed', () => {
    const l = line('l:fra-bus-bn-a');
    expect(l.notRouted).toBeTruthy();
    for (const c of buildMatrix(m).cells) expect(c.route?.lines ?? []).not.toContain('l:fra-bus-bn-a');
    const r = findRoute(m, 'fra-t1-b-n', 'fra-t1-a')!;
    expect(r.controls).toContain('passport');
    expect(r.borderCrossings).toBe(1);
  });
  it('new Sky Line: suspended 28 May – 14 June 2026, not routed on 2026-06-01 (bus instead), routed again on asOf', () => {
    for (const id of ['l:fra-skyline2-public', 'l:fra-skyline2-transfer']) {
      const st = line(id).status;
      expect(stateOn(st, '2026-05-27')).toBe('active');
      expect(stateOn(st, '2026-06-01')).toBe('suspended');
      expect(stateOn(st, '2026-06-14')).toBe('suspended');
      expect(stateOn(st, '2026-06-15')).toBe('active');
      expect(stateOn(st, m.asOf)).toBe('active');
    }
    const june = findRoute(m, 'fra-t1-hall', 'fra-t3-hall', { transfer: true, date: '2026-06-01' })!;
    expect(june.lines).not.toContain('l:fra-skyline2-public');
    expect(june.lines).toEqual(['l:fra-skyline-replacement-bus']);
    const now = findRoute(m, 'fra-t1-hall', 'fra-t3-hall')!;
    expect(now.lines).toEqual(['l:fra-skyline2-public']);
    // during the suspension no airside T1 → T3 path exists: Z → J must leave and re-enter
    const zj = findRoute(m, 'fra-t1-z', 'fra-t3-j', { transfer: true, date: '2026-06-01' })!;
    expect(zj.lines).not.toContain('l:fra-skyline2-transfer');
    expect(zj.borderCrossings).toBe(2);
  });
  it('night shuttle bus is landside between the T1 and T3 forecourts, 22:00–05:00', () => {
    const l = line('l:fra-nightbus');
    expect(l.access).toBe('public');
    expect(l.service[0].hours).toBe('22:00–05:00');
    expect(l.service[0].windows).toEqual([{ from: '22:00', until: '05:00' }]);
    expect(l.stops.map((s) => m.stops.find((x) => x.id === s)!.area)).toEqual(['fra-t1-hall', 'fra-t3-hall']);
  });
  it('replacement bus replaces the public Sky Line only during the suspension, every 2–3 min by day and 10 min at night', () => {
    const b = line('l:fra-skyline-replacement-bus');
    expect(b.replaces).toBe('l:fra-skyline2-public');
    expect(b.access).toBe('public');
    expect(stateOn(b.status, '2026-05-27')).toBe('planned');
    expect(stateOn(b.status, '2026-05-28')).toBe('active');
    expect(stateOn(b.status, '2026-06-14')).toBe('active');
    expect(stateOn(b.status, '2026-06-15')).toBe('closed');
    expect(b.service.map((s) => [s.windows, s.headwayMin])).toEqual([
      [[{ from: '05:00', until: '23:00' }], { min: 2, max: 3 }],
      [[{ from: '23:00', until: '05:00' }], { min: 10, max: 10 }],
    ]);
    const night = findRoute(m, 'fra-t1-hall', 'fra-t3-hall', { transfer: true, date: '2026-06-01', time: '02:00' })!;
    expect(night.lines.some((x) => ['l:fra-skyline-replacement-bus', 'l:fra-nightbus'].includes(x))).toBe(true);
    expect(serviceAt(b, '2026-06-01', '02:00')!.headwayMin).toEqual({ min: 10, max: 10 });
    expect(night.lines).not.toContain('l:fra-skyline2-public');
    for (const c of buildMatrix(m).cells) expect(c.route?.lines ?? []).not.toContain('l:fra-skyline-replacement-bus');
  });
});

describe('FRA time of day (Sky Line pause 23:00–04:00, night bus 22:00–05:00)', () => {
  it('10:00: T1 ↔ T3 by Sky Line; 23:30 and 03:00: the landside night bus', () => {
    expect(findRoute(m, 'fra-t1-hall', 'fra-t3-hall', { transfer: true, time: '10:00' })!.lines).toEqual(['l:fra-skyline2-public']);
    for (const time of ['23:30', '03:00']) {
      const r = findRoute(m, 'fra-t1-hall', 'fra-t3-hall', { transfer: true, time })!;
      expect(r.lines).toEqual(['l:fra-nightbus']);
      expect(r.warnings.join(' ')).not.toMatch(/hours not published/);
    }
  });
  it('night transfer Z → J at 03:00 cannot stay airside: it leaves and re-enters (2 passport crossings)', () => {
    const day = findRoute(m, 'fra-t1-z', 'fra-t3-j', { transfer: true, time: '10:00' })!;
    expect(day.lines).toEqual(['l:fra-skyline1-transfer', 'l:fra-skyline2-transfer']);
    expect(day.borderCrossings).toBe(0);
    const night = findRoute(m, 'fra-t1-z', 'fra-t3-j', { transfer: true, time: '03:00' })!;
    expect(night.lines).toEqual(['l:fra-nightbus']);
    expect(night.borderCrossings).toBe(2);
    expect(night.total.typical).toBeGreaterThan(day.total.typical + 20);
  });
  it('every matrix pair stays routable at 03:00 (walks within T1, night bus T1 ↔ T3)', () => {
    const mx = buildMatrix(m, { transfer: true, time: '03:00' });
    expect(mx.cells.filter((c) => c.from !== c.to && !c.route)).toEqual([]);
    for (const c of mx.cells) for (const l of c.route?.lines ?? []) expect(['l:fra-nightbus']).toContain(l);
  });
});

describe('FRA travel-time cases', () => {
  it('very short: A → B Schengen through the A15–B19 tunnel, walking only, no control', () => {
    // a Schengen origin (arriving at A): one-stop covered, so no transfer security (unknown origin would apply it, R-05)
    const r = findRoute(m, 'fra-t1-a', 'fra-t1-b-s', { transfer: true, originAirport: 'CDG', originCountry: 'FR' })!;
    expect(r.lines).toEqual([]);
    expect(r.controls).toEqual([]);
    expect(r.total.typical).toBeLessThanOrEqual(10);
  });
  it('very long: Z → J on a suspension date takes over an hour with two passport crossings', () => {
    const r = findRoute(m, 'fra-t1-z', 'fra-t3-j', { transfer: true, date: '2026-06-01' })!;
    expect(r.total.typical).toBeGreaterThanOrEqual(60);
    expect(r.borderCrossings).toBe(2);
  });
  it('J (arriving) → H passes one transfer security check and one passport control, not two security checks', () => {
    const r = findRoute(m, 'fra-t3-j', 'fra-t3-h')!;
    expect(r.controls.filter((k) => k === 'transfer-security' || k === 'security').length).toBe(1);
    expect(r.controls.filter((k) => k === 'passport').length).toBe(1);
    expect(kinds(walk('w:fra-t3-h-j').reverseControls)).toEqual(['passport']);
  });
  it('movement and control time are reported separately; T1 hall → T3 hall movement uses measured rides', () => {
    const r = findRoute(m, 'fra-t1-hall', 'fra-t3-hall')!;
    expect(r.controlTime.typical).toBe(0);
    expect(r.movement.typical).toBe(r.total.typical);
    const sl2t1 = m.stops.find((s) => s.id === 's:fra-sl2-t1')!;
    expect(sl2t1.accessMinutes.basis).toBe('measured');
  });
});

describe('FRA routes', () => {
  it('T1 Schengen A → T3 Schengen H goes landside via the public Sky Line and re-screens at T3', () => {
    const r = findRoute(m, 'fra-t1-a', 'fra-t3-h')!;
    expect(r.lines).toContain('l:fra-skyline2-public');
    expect(r.controls).toContain('security');
    expect(r.borderCrossings).toBe(0);
  });
  it('T1 non-Schengen Z → T3 non-Schengen J stays airside (old SkyLine + connecting-flights car) without passport control', () => {
    const r = findRoute(m, 'fra-t1-z', 'fra-t3-j')!;
    expect(r.lines).toEqual(['l:fra-skyline1-transfer', 'l:fra-skyline2-transfer']);
    expect(r.borderCrossings).toBe(0);
    expect(r.confidence).not.toBe('verified');
  });
  it('without the transfer profile, Z → J must leave through passport control and re-enter at T3', () => {
    const r = findRoute(m, 'fra-t1-z', 'fra-t3-j', { transfer: false })!;
    expect(r.lines).not.toContain('l:fra-skyline2-transfer');
    expect(r.controls).toEqual(expect.arrayContaining(['passport', 'security']));
  });
  it('A → Z crosses exactly one passport control', () => {
    const r = findRoute(m, 'fra-t1-a', 'fra-t1-z')!;
    expect(r.borderCrossings).toBe(1);
  });
});

describe('FRA phase 3: transfer scenarios (2026-11-01)', () => {
  const stop = (id: string) => m.stops.find((s) => s.id === id)!;
  const rule = (id: string) => m.rules.find((r) => r.id === id)!;
  it('transfer checkpoints from Fraport data: Hall A L4 (A/Z), Hall B L3 (B20–B63), Hall J L3 (G, H, J); none listed for C', () => {
    const t = rule('r:fra-transfer-checkpoints').text;
    expect(t).toMatch(/Hall A L4 transfer security checkpoint \(A\/Z/);
    expect(t).toMatch(/Hall B L3 transfer security checkpoint \(B non-Schengen, B20–B63\)/);
    expect(t).toMatch(/Hall J L3 transfer security checkpoint \(G, H, J\)/);
    expect(t).toMatch(/No transfer checkpoint is listed for concourse C/);
    expect(kinds(stop('s:fra-sl1-z').egressControls)).toEqual(['transfer-security']);
    expect(stop('s:fra-sl1-z').egressControls![0].minutes.basis).toBe('assumed');
    expect(kinds(walk('w:fra-t3-jarr-j').controls)).toEqual(['transfer-security']);
    expect(walk('w:fra-t3-h-j').sources).toContain('src:qsensor-fra');
  });
  it('T3 J (arriving) → T1 Z stays airside and passes exactly one transfer security check (at the A/Z SkyLine level)', () => {
    const r = findRoute(m, 'fra-t3-j', 'fra-t1-z')!;
    expect(r.lines).toEqual(['l:fra-skyline2-transfer', 'l:fra-skyline1-transfer']);
    expect(r.borderCrossings).toBe(0);
    expect(r.controls).toEqual(['transfer-security']);
  });
  it('T3 J (arriving) → T1 A (non-Schengen → Schengen): one transfer security check and one passport control, no landside exit', () => {
    const r = findRoute(m, 'fra-t3-j', 'fra-t1-a')!;
    expect(r.lines).not.toContain('l:fra-skyline2-public');
    expect(r.controls.filter((k) => k === 'transfer-security').length).toBe(1);
    expect(r.controls.filter((k) => k === 'security').length).toBe(0);
    expect(r.borderCrossings).toBe(1);
  });
  it('T1 Z (departing side) → T3 J boards at Z and is not charged the A/Z arrival check; it passes the Hall J transfer check once', () => {
    const r = findRoute(m, 'fra-t1-z', 'fra-t3-j')!;
    expect(r.controls).toEqual(['transfer-security']);
  });
  it('pier G: boarding gates not in use from 23 Apr 2026 (planned until further notice), so H → G does not route; no G gates', () => {
    const g = area('fra-t3-g');
    expect(stateOn(g.status, '2026-04-23')).toBe('planned');
    expect(stateOn(g.status, m.asOf)).toBe('planned');
    expect(gatesOf('fra-t3-g')).toEqual([]);
    expect(findRoute(m, 'fra-t3-h', 'fra-t3-g')).toBeNull();
  });
  it('self-transfer (separate tickets, no transfer profile) J → A leaves through entry control and re-enters through security', () => {
    const r = findRoute(m, 'fra-t3-j', 'fra-t1-a', { transfer: false })!;
    expect(r.lines).not.toContain('l:fra-skyline2-transfer');
    expect(r.lines).not.toContain('l:fra-skyline1-transfer');
    expect(r.controls).toEqual(expect.arrayContaining(['passport', 'security']));
    expect(rule('r:fra-baggage').text).toMatch(/checked through/);
  });
  it('rail station → each terminal: T1 areas walk from the long-distance station, T3 by Sky Line (day) or night bus (03:00)', () => {
    for (const a of ['fra-t1-a', 'fra-t1-z', 'fra-t1-b-s', 'fra-t1-b-n', 'fra-t1-c']) expect(findRoute(m, 'fra-rail-long', a, { transfer: true, fromArrival: false })!.lines).toEqual([]);
    expect(findRoute(m, 'fra-rail-long', 'fra-t3-h', { transfer: true, fromArrival: false })!.lines).toEqual(['l:fra-skyline2-public']);
    expect(findRoute(m, 'fra-rail-long', 'fra-t3-j', { transfer: true, fromArrival: false, time: '03:00' })!.lines).toEqual(['l:fra-nightbus']);
    const out = findRoute(m, 'fra-t3-j', 'fra-rail-long', { transfer: true })!;
    expect(out.lines).not.toContain('l:fra-skyline2-transfer');
    expect(out.controls).toEqual(['passport', 'customs']);   // customs exit since the 2026-11-02 audit (AU-2)
  });
  it('night (23:30) J → Z still leaves landside with two passport crossings; the night bus stays landside with unpublished interval', () => {
    const r = findRoute(m, 'fra-t3-j', 'fra-t1-z', { transfer: true, time: '23:30' })!;
    expect(r.lines).toEqual(['l:fra-nightbus']);
    expect(r.borderCrossings).toBe(2);
    expect(line('l:fra-nightbus').service[0].headwayBasis).toBe('assumed');
    expect(m.openQuestions.map((q) => q.id)).toEqual(expect.arrayContaining(['q:fra-night-airside', 'q:fra-transfer-security-t1', 'q:fra-customs-transfer', 'q:fra-rmv-buses-night']));
  });
  it('Lufthansa MCT 60 min since summer 2025 is recorded as a rule, not used as a route time', () => {
    expect(rule('r:fra-mct').text).toMatch(/60 min since the summer 2025/);
  });
});

describe.skipIf(!EV)('FRA evidence', () => {
  it('evidence references only known sources and covers videos', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    if (EV) expect(ev.items.filter((i) => i.method === 'video-frames').length).toBeGreaterThanOrEqual(8);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.stops, ...m.lines, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('FRA remediation data (contract v1 fields)', () => {
  const mm = m as any;
  const ids = new Set(m.areas.map((a) => a.id));
  const srcIds = new Set(m.sources.map((s) => s.id));
  it('intraWalk on every matrix airside area with gates: never 0, derived, min ≤ typical < max', () => {
    const withGates = new Set(m.gateGroups.map((g) => g.area));
    for (const a of m.areas.filter((x) => x.side === 'airside' && x.matrix && withGates.has(x.id)) as any[]) {
      expect(a.intraWalk, a.id).toBeTruthy();
      expect(a.intraWalk.typical).toBeGreaterThan(0);
      expect(a.intraWalk.min).toBeLessThanOrEqual(a.intraWalk.typical);
      expect(a.intraWalk.typical).toBeLessThan(a.intraWalk.max);
      expect(a.intraWalk.basis).toBe('derived');
    }
  });
  it('check-in halls are landside and serve existing airside areas', () => {
    const halls = (m.areas as any[]).filter((a) => a.checkIn);
    expect(halls.length).toBeGreaterThan(0);
    for (const h of halls) { expect(h.side).toBe('landside'); for (const s of h.checkIn.serves) { expect(ids.has(s), s).toBe(true); expect(m.areas.find((a) => a.id === s)!.side).toBe('airside'); } }
  });
  it('special screening entries are sourced; areas exist; no invented minutes', () => {
    for (const s of mm.specialScreening ?? []) {
      expect(s.sources.length).toBeGreaterThan(0);
      for (const x of s.sources) expect(srcIds.has(x), x).toBe(true);
      for (const a of s.areas ?? []) expect(ids.has(a), a).toBe(true);
      expect(s.minutes).toBeUndefined();
      if (s.certainty === 'unknown') expect(s.areas).toBeUndefined();
    }
  });
  it('feed terminal mappings point at existing areas; one-stop sources exist; TLV is excluded', () => {
    for (const dir of ['arrival', 'departure']) for (const v of Object.values(mm.feedTerminals?.[dir] ?? {}) as string[][]) for (const a of v) expect(ids.has(a), a).toBe(true);
    for (const x of mm.oneStopSecurity?.sources ?? []) expect(srcIds.has(x), x).toBe(true);
    if (mm.oneStopSecurity) { expect(mm.oneStopSecurity.countries).not.toContain('IL'); expect(mm.oneStopSecurity.excludedAirports).toContain('TLV'); }
  });
  it('R-05: FRA transfer securities are origin-conditional (Fraport) and the T2 feed value maps to no active area', () => {
    for (const id of ['w:fra-bs-bn', 'w:fra-t3-jarr-j']) { const w = m.walks.find((x) => x.id === id)!; for (const c of [...(w.controls ?? []), ...(w.reverseControls ?? [])].filter((c) => c.kind === 'transfer-security') as any[]) expect(c.when).toBe('origin-not-one-stop'); }
    expect(mm.feedTerminals.arrival['2']).toEqual([]);
  });
  it('R-19: Tel Aviv departures restricted to concourse C (feed 13/13, Fraport)', () => {
    expect(mm.specialScreening.find((x: any) => x.id === 'ss:fra-israel-c').areas).toEqual(['fra-t1-c']);
  });
});

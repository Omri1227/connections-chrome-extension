// ZRH (Zurich) data model: gate lists, zones, the B/D stacked pier, the Skymetro and safety rules (data assertions, as of 2026-10-31).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/zrh/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute, serviceAt, stateOn } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('zrh');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const line = (id: string) => m.lines.find((l) => l.id === id)!;
const stop = (id: string) => m.stops.find((s) => s.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);
const num = (g: string) => parseInt(g.slice(1), 10);

describe('ZRH model validity', () => {
  it('validates without errors', () => {
    expect(validateAirport(m, EV).errors).toEqual([]);
  });
  it('every matrix pair is routable', () => {
    const mx = buildMatrix(m);
    const missing = mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`);
    expect(missing).toEqual([]);
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['zrh-a', 'zrh-ac', 'zrh-b', 'zrh-centre', 'zrh-d', 'zrh-e', 'zrh-t1', 'zrh-t2']);
  });
});

describe('ZRH zones and the B/D pier', () => {
  it('A is Schengen, E is non-Schengen, the Airside Center departure level is Schengen', () => {
    expect(area('zrh-a').zone).toBe('schengen');
    expect(area('zrh-e').zone).toBe('non-schengen');
    expect(area('zrh-ac').zone).toBe('schengen');
    expect(area('zrh-hub').zone).toBe('non-schengen');
  });
  it('B (Schengen) and D (non-Schengen) are one stacked footprint, D on the lower level', () => {
    const b = area('zrh-b'), d = area('zrh-d');
    expect(b.zone).toBe('schengen');
    expect(d.zone).toBe('non-schengen');
    expect(b.stack!.group).toBe(d.stack!.group);
    expect(d.stack!.order).toBeLessThan(b.stack!.order);
    expect(b.shape).toEqual(d.shape);
  });
  it('B31–B43 and D31–D43 share stand numbers (same numbers, different prefixes)', () => {
    const b = m.gateGroups.find((g) => g.id === 'zrh-gates-b31-b43')!.gates.map(num);
    const d = m.gateGroups.find((g) => g.id === 'zrh-gates-d31-d43')!.gates.map(num);
    expect(b).toEqual(d);
    expect(b).toContain(34);
  });
});

describe('ZRH gates per area (OSM 2026-10-31 + sources)', () => {
  it('each area only holds its own letter', () => {
    for (const [a, p] of [['zrh-a', 'A'], ['zrh-b', 'B'], ['zrh-d', 'D'], ['zrh-e', 'E']] as const) {
      expect(gatesOf(a).length).toBeGreaterThan(0);
      expect(gatesOf(a).every((g) => g.startsWith(p))).toBe(true);
    }
    expect(gatesOf('zrh-ac')).toEqual([]);
  });
  it('key gates sit where the sources put them', () => {
    expect(gatesOf('zrh-a')).toEqual(expect.arrayContaining(['A62', 'A54', 'A55', 'A86']));
    expect(gatesOf('zrh-b')).toEqual(expect.arrayContaining(['B34', 'B10']));
    expect(gatesOf('zrh-d')).toEqual(expect.arrayContaining(['D34', 'D21', 'D58']));
    expect(gatesOf('zrh-e')).toEqual(expect.arrayContaining(['E34', 'E36', 'E37', 'E42', 'E52']));
  });
  it('bus gates are flagged only where a bus-gate source exists', () => {
    const bus = m.gateGroups.filter((g) => g.bus).map((g) => g.id).sort();
    expect(bus).toEqual(['zrh-gates-a01-a06-bus', 'zrh-gates-a50-a59-bus', 'zrh-gates-b01-b10-bus', 'zrh-gates-d21-d26-bus']);
    expect(m.gateGroups.find((g) => g.id === 'zrh-gates-d51-d58')!.bus).toBeUndefined();
  });
  it('no unattested gate ranges were filled in', () => {
    for (const g of ['A60', 'A61', 'A70', 'B11', 'B32', 'E28', 'E33', 'E40']) expect(allGates).not.toContain(g);
  });
  it('no gate is listed twice and the total is stable', () => {
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(allGates.length).toBe(104);
  });
});

describe('ZRH controls (safety)', () => {
  it('entering the airside from the public side always passes security', () => {
    for (const w of m.walks) {
      if (w.access === 'restricted') continue;
      const a = area(w.from), b = area(w.to);
      if (a.side === 'landside' && b.side === 'airside') expect(kinds(w.controls)).toContain('security');
      if (w.bidirectional && b.side === 'landside' && a.side === 'airside') expect(kinds(w.reverseControls ?? w.controls)).toContain('security');
    }
  });
  it('the Airside Center ↔ non-Schengen link passes passport control in both directions', () => {
    const w = walk('w:zrh-ac-hub');
    expect(kinds(w.controls)).toContain('passport');
    expect(kinds(w.reverseControls)).toContain('passport');
  });
  it('D ↔ transit area and the Skymetro need no passport control (non-Schengen ↔ non-Schengen)', () => {
    expect(walk('w:zrh-hub-d').controls ?? []).toEqual([]);
    for (const s of line('l:zrh-skymetro').stops) expect(area(stop(s).area).zone).toBe('non-schengen');
  });
  it('arrivals-only flows are one-way, and non-Schengen exits pass entry passport control', () => {
    const flows = m.walks.filter((w) => w.flow === 'arrivals');
    expect(flows.map((w) => w.id).sort()).toEqual(['w:zrh-a-t1-arr', 'w:zrh-b-t1-arr', 'w:zrh-d-t2-arr']);
    for (const w of flows) expect(w.bidirectional).toBe(false);
    expect(kinds(walk('w:zrh-d-t2-arr').controls)).toContain('passport');
    expect(kinds(walk('w:zrh-hub-t2').controls)).toEqual(expect.arrayContaining(['passport', 'customs']));
  });
  it('there is no walking route to Dock E: the tunnel link is restricted and never routed', () => {
    const t = walk('w:zrh-hub-e-tunnel');
    expect(t.access).toBe('restricted');
    for (const from of ['zrh-a', 'zrh-ac', 'zrh-d', 'zrh-t1']) {
      const r = findRoute(m, from, 'zrh-e')!;
      expect(r.steps.some((s) => s.refId === 'w:zrh-hub-e-tunnel')).toBe(false);
      expect(r.lines).toContain('l:zrh-skymetro');
    }
    expect(findRoute(m, 'zrh-ac', 'zrh-e', { transfer: true, walkOnly: true })).toBeNull();
  });
});

describe('ZRH Skymetro', () => {
  it('one routed line, Airside Center ↔ Dock E, both directions, no intermediate stop', () => {
    const l = line('l:zrh-skymetro');
    expect(l.stops.map((s) => stop(s).area)).toEqual(['zrh-hub', 'zrh-e']);
    expect(l.direction).toBe('both');
    expect(l.access).toBe('airside');
    expect(l.confidence).toBe('verified');
    expect(l.notRouted).toBeUndefined();
  });
  it('ride measured from two uncut front-window videos: 2–3 min, typical 2.5', () => {
    const l = line('l:zrh-skymetro');
    expect(l.rideMin).toEqual([2.5]);
    expect(l.ride![0]).toMatchObject({ min: 2, typical: 2.5, max: 3, basis: 'measured' });
    const vids = ev.items.filter((i) => i.method === 'video-frames' && i.supports?.includes('l:zrh-skymetro') && /t=/.test(i.locator ?? ''));
    if (EV) expect(new Set(vids.map((i) => i.source)).size).toBeGreaterThanOrEqual(2);
  });
  it('the works are dated service entries, not status periods: the line is never suspended', () => {
    const l = line('l:zrh-skymetro');
    expect(l.status ?? []).toEqual([]);
    for (const d of ['2025-12-01', '2026-10-31', '2026-11-03', '2027-03-01', '2027-07-01']) expect(stateOn(l.status, d)).toBe('active');
  });
  it('on 2026-10-31 both tunnels run (phase 1 done June 2026, phase 2 starts Tuesday 3 Nov 2026)', () => {
    const l = line('l:zrh-skymetro');
    const today = serviceAt(l, m.asOf)!;
    expect(today.validFrom).toBeUndefined();
    expect(today.headwayMin.max).toBeLessThanOrEqual(5);
    const p2 = serviceAt(l, '2026-11-03')!;
    expect(p2.validFrom).toBe('2026-11-03');
    expect(p2.validUntil).toBe('2027-05-31');
    expect(p2.headwayMin.max).toBeGreaterThan(today.headwayMin.max);
    expect(serviceAt(l, '2026-11-02')).toBe(today);
    expect(serviceAt(l, '2026-01-15')!.validFrom).toBe('2025-11-04');
    expect(serviceAt(l, '2027-06-15')).toBe(today);
  });
  it('hours are published only for works phase 1 (official diagram 04:45–23:30, every 6–7 min); normal and phase-2 service have no windows', () => {
    const l = line('l:zrh-skymetro');
    const p1 = serviceAt(l, '2026-01-15')!;
    expect(p1.windows).toEqual([{ from: '04:45', until: '23:30' }]);
    expect(p1.headwayMin).toEqual({ min: 6, max: 7 });
    expect(p1.headwayBasis).toBe('published');
    expect(p1.sources).toContain('src:zrh-staff-newsletter-skymetro-2025');
    // Phase-1 figures are not carried over to phase 2 or to normal service.
    expect(serviceAt(l, m.asOf)!.windows).toBeUndefined();
    const p2 = serviceAt(l, '2026-12-01')!;
    expect(p2.windows).toBeUndefined();
    expect(p2.headwayBasis).toBe('derived');
  });
  it('in works phase 1 Dock E was unroutable at 03:00 (Skymetro closed) but routable at 05:00 and 23:00', () => {
    expect(findRoute(m, 'zrh-a', 'zrh-e', { transfer: true, date: '2026-01-15', time: '03:00' })).toBeNull();
    for (const t of ['05:00', '23:00']) expect(findRoute(m, 'zrh-a', 'zrh-e', { transfer: true, date: '2026-01-15', time: t })!.lines).toEqual(['l:zrh-skymetro']);
  });
  it('phase 2 keeps the later start date (3 Nov 2026) and records the official 19 Oct 2026 plan as a conflict', () => {
    const p2 = serviceAt(line('l:zrh-skymetro'), '2026-11-03')!;
    expect(p2.notes).toMatch(/19\. Oktober 2026/);
    expect(serviceAt(line('l:zrh-skymetro'), '2026-10-20')!.validFrom).toBeUndefined();
  });
  it('a route to Dock E inside works phase 2 waits longer than on 2026-10-31', () => {
    const now = findRoute(m, 'zrh-a', 'zrh-e')!;
    const p2 = findRoute(m, 'zrh-a', 'zrh-e', { transfer: true, date: '2026-12-01' })!;
    expect(p2.lines).toEqual(['l:zrh-skymetro']);
    expect(p2.movement.typical).toBeGreaterThan(now.movement.typical);
  });
});

describe('ZRH Skymetro relief bus (works phases)', () => {
  const bus = () => line('l:zrh-skymetro-relief-bus');
  it('is drawn but never routed (boarding points and eligibility unknown) and does not claim to replace a suspended line', () => {
    expect(bus().notRouted).toMatch(/not published/);
    expect(bus().replaces).toBeUndefined();
    for (const s of bus().stops) expect(stop(s).confidence).toBe('unknown');
    for (const d of ['2026-11-10', '2026-01-15']) {
      for (const t of ['07:00', '11:00', '15:00']) {
        const r = findRoute(m, 'zrh-ac', 'zrh-e', { transfer: true, date: d, time: t })!;
        expect(r.lines).not.toContain('l:zrh-skymetro-relief-bus');
      }
    }
  });
  it('status: active only in the two works phases', () => {
    const st = (d: string) => stateOn(bus().status, d);
    expect(st('2025-10-01')).toBe('planned');
    expect(st('2026-01-15')).toBe('active');
    expect(st('2026-10-31')).toBe('closed');
    expect(st('2026-11-03')).toBe('active');
    expect(st('2027-07-01')).toBe('closed');
  });
  it('phase-1 hours 06:00–09:00 and 10:30–13:00 are machine-readable; phase-2 peak hours are not published', () => {
    expect(serviceAt(bus(), '2026-01-15', '07:30')).not.toBeNull();
    expect(serviceAt(bus(), '2026-01-15', '09:30')).toBeNull();
    expect(serviceAt(bus(), '2026-01-15', '11:00')).not.toBeNull();
    expect(serviceAt(bus(), '2026-11-10')!.windows).toBeUndefined();
  });
  it('phase-1 bus frequency is published (about every 3 min); phase-2 frequency stays assumed', () => {
    const p1 = serviceAt(bus(), '2026-01-15', '07:30')!;
    expect(p1.headwayMin).toEqual({ min: 3, max: 3 });
    expect(p1.headwayBasis).toBe('published');
    expect(p1.notes).toMatch(/ICAO E → A\/B/);
    expect(serviceAt(bus(), '2026-11-10')!.headwayBasis).toBe('assumed');
  });
});

describe('ZRH night (curfew 23:00–06:00, delays to 23:30)', () => {
  it('the curfew is a verified rule', () => {
    const r = m.rules.find((x) => x.id === 'r:zrh-night-curfew')!;
    expect(r.text).toMatch(/23:30/);
    expect(r.confidence).toBe('verified');
  });
  it('at 03:00 routes to Dock E still compute but warn that the Skymetro hours are not published', () => {
    const r = findRoute(m, 'zrh-a', 'zrh-e', { transfer: true, time: '03:00' })!;
    expect(r.lines).toEqual(['l:zrh-skymetro']);
    expect(r.warnings.join(' ')).toMatch(/not published/);
  });
  it('landside and Schengen-only routes need no line and carry no hours warning at 23:30', () => {
    const r = findRoute(m, 'zrh-t1', 'zrh-a', { transfer: true, time: '23:30' })!;
    expect(r.lines).toEqual([]);
    expect(r.warnings.join(' ')).not.toMatch(/not published/);
  });
});

describe('ZRH difficult scenarios', () => {
  it('very short: Check-in 1 ↔ Check-in 2 is a landside walk of 3–7 min (one complex, no control)', () => {
    const r = findRoute(m, 'zrh-t1', 'zrh-t2')!;
    expect(r.movement).toMatchObject({ min: 3, typical: 4, max: 7 });
    expect(r.controls).toEqual([]);
  });
  it('same pier, other level: B → D crosses the border once (via the passport hall), not by walking down', () => {
    const r = findRoute(m, 'zrh-b', 'zrh-d')!;
    expect(r.borderCrossings).toBe(1);
    expect(r.lines).toEqual([]);
  });
  it('long: railway station → Dock E needs security, exit passport control and the Skymetro', () => {
    const r = findRoute(m, 'zrh-centre', 'zrh-e')!;
    expect(r.controls).toEqual(expect.arrayContaining(['security', 'passport']));
    expect(r.total.typical).toBeGreaterThan(40);
  });
  it('arrivals-only flows are not usable by a passenger who did not just land', () => {
    const r = findRoute(m, 'zrh-a', 'zrh-t1', { transfer: false, fromArrival: false })!;
    expect(r.steps.some((s) => s.refId === 'w:zrh-a-t1-arr')).toBe(false);
  });
  it('movement minutes exclude control allowances', () => {
    const r = findRoute(m, 'zrh-a', 'zrh-e')!;
    expect(r.controlTime.typical).toBeGreaterThan(0);
    expect(r.total.typical).toBeCloseTo(r.movement.typical + r.controlTime.typical, 5);
  });
});

describe('ZRH routes', () => {
  it('A (Schengen) → E crosses exactly one passport control and rides the Skymetro', () => {
    const r = findRoute(m, 'zrh-a', 'zrh-e')!;
    expect(r.borderCrossings).toBe(1);
    expect(r.lines).toEqual(['l:zrh-skymetro']);
  });
  it('E → D (both non-Schengen) has no passport control', () => {
    const r = findRoute(m, 'zrh-e', 'zrh-d')!;
    expect(r.borderCrossings).toBe(0);
    expect(r.controls).not.toContain('passport');
  });
  it('B → D (same stand, other level) goes through the passport control hall', () => {
    const r = findRoute(m, 'zrh-b', 'zrh-d')!;
    expect(r.borderCrossings).toBe(1);
    expect(r.steps.some((s) => s.refId === 'w:zrh-ac-hub')).toBe(true);
  });
  it('railway station → E: security, passport control, Skymetro', () => {
    const r = findRoute(m, 'zrh-centre', 'zrh-e')!;
    expect(r.controls).toEqual(expect.arrayContaining(['security', 'passport']));
    expect(r.lines).toEqual(['l:zrh-skymetro']);
  });
});

describe.skipIf(!EV)('ZRH evidence', () => {
  it('evidence references only known sources and covers videos read frame by frame', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    const vids = new Set(ev.items.filter((i) => i.method === 'video-frames').map((i) => i.source));
    expect(vids.size).toBeGreaterThanOrEqual(6);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.stops, ...m.lines, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('ZRH remediation data (contract v1 fields)', () => {
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
  it('R-05: Dock E / D arrivals pass an origin-conditional transfer security on leaving their dock', () => {
    for (const s of m.stops.filter((x) => x.id === 's:zrh-sky-ac' || x.id === 's:zrh-bus-ac')) expect((s.egressControls as any[])[0]).toMatchObject({ kind: 'transfer-security', when: 'origin-not-one-stop' });
    expect((m.walks.find((w) => w.id === 'w:zrh-hub-d')!.reverseControls as any[])[0].when).toBe('origin-not-one-stop');
  });
  it('R-23: the arrival strings "1" / "2" (arrival halls) map to docks', () => {
    expect(mm.feedTerminals.arrival['1']).toEqual(['zrh-a', 'zrh-b']);
    expect(mm.feedTerminals.arrival['2']).toEqual(['zrh-a', 'zrh-b', 'zrh-d', 'zrh-e']);
  });
  it('R-38: works phase 2 recorded from the official release, without the historical phase-1 bus hours', () => {
    expect(m.rules.find((x) => x.id === 'r:zrh-works-phase2-2026')!.text).toMatch(/NOT applied to phase 2/);
  });
});

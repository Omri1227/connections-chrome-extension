// CDG (Paris Charles de Gaulle) data model: gate lists, zones, connections and safety rules (data assertions, as of 2026-10-31).
// Facts carried over from the CDG Navigator Terminal 2 pilot research (data/curated, data/generated/t2/route-db.json).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/cdg/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findGate, findRoute, serviceAt, type Profile } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('cdg');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const line = (id: string) => m.lines.find((l) => l.id === id)!;
const stop = (id: string) => m.stops.find((s) => s.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);

describe('CDG model validity', () => {
  it('validates without errors', () => {
    expect(validateAirport(m, EV).errors).toEqual([]);
  });
  it('every matrix pair is routable and the matrix has the 14 expected areas', () => {
    const mx = buildMatrix(m);
    expect(mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`)).toEqual([]);
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['cdg-2a', 'cdg-2b', 'cdg-2c', 'cdg-2d', 'cdg-2e-k', 'cdg-2e-l', 'cdg-2e-m', 'cdg-2f', 'cdg-2g', 'cdg-t1-land', 'cdg-t1-ns', 'cdg-t1-s', 'cdg-t2-station', 'cdg-t3-air']);
  });
});

describe('CDG gates per area', () => {
  it('Terminal 2 halls hold their own letters', () => {
    for (const [a, p] of [['cdg-2a', 'A'], ['cdg-2c', 'C'], ['cdg-2e-k', 'K'], ['cdg-2e-l', 'L'], ['cdg-2e-m', 'M'], ['cdg-2f', 'F'], ['cdg-2g', 'G']] as const) {
      expect(gatesOf(a).length).toBeGreaterThan(0);
      expect(gatesOf(a).every((g) => g.startsWith(p))).toBe(true);
    }
    expect(gatesOf('cdg-2d').every((g) => g.startsWith('D') && parseInt(g.slice(1), 10) >= 50)).toBe(true);
  });
  it('2B holds B20–B31 and the D40/D41 gates signed "Terminal 2B"', () => {
    expect(gatesOf('cdg-2b')).toEqual(expect.arrayContaining(['B20', 'B28', 'B31', 'D40', 'D41']));
    expect(findGate(m, 'D41')?.area.id).toBe('cdg-2b');
    expect(findGate(m, 'd56')?.area.id).toBe('cdg-2d');
  });
  it('T1 and T3 numbers are terminal-scoped and split as attested (10–38 non-Schengen, 40–68 Schengen)', () => {
    expect(findGate(m, 'T1 63')?.area.id).toBe('cdg-t1-s');
    expect(findGate(m, 'T1 34A')?.area.id).toBe('cdg-t1-ns');
    expect(findGate(m, 'T3 15')?.area.id).toBe('cdg-t3-air');
    const n = (g: string) => parseInt(g.replace(/^T1 /, ''), 10);
    expect(gatesOf('cdg-t1-ns').every((g) => n(g) >= 10 && n(g) <= 38)).toBe(true);
    expect(gatesOf('cdg-t1-s').every((g) => n(g) >= 40 && n(g) <= 68)).toBe(true);
  });
  it('gates missing from the current official maps (owner check 2026-10-27) are not listed', () => {
    for (const g of ['T1 13', 'T1 23', 'T1 24', 'T1 34', 'T1 70', 'T1 78', 'T3 13', 'A44', 'A46', 'B32', 'B34', 'D42', 'D55', 'D63', 'D65', 'F21', 'F41', 'F43', 'K51', 'K54']) expect(allGates).not.toContain(g);
  });
  it('K21–K27 are the only bus gates; no gate is listed twice; the total is stable', () => {
    expect(m.gateGroups.filter((g) => g.bus).map((g) => g.id)).toEqual(['cdg-gates-k21-k27']);
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(allGates.length).toBe(234);
  });
});

describe('CDG zones and controls (safety)', () => {
  it('zones follow the pilot research', () => {
    for (const a of ['cdg-2a', 'cdg-2c', 'cdg-2b', 'cdg-2e-k', 'cdg-2e-l', 'cdg-2e-m', 'cdg-t1-ns']) expect(area(a).zone).toBe('non-schengen');
    for (const a of ['cdg-2f', 'cdg-2g', 'cdg-2d', 'cdg-t1-s']) expect(area(a).zone).toBe('schengen');
    expect(area('cdg-t3-air').zone).toBe('mixed');
    expect(m.gateGroups.find((g) => g.id === 'cdg-gates-d50-d69')!.zone).toBe('mixed');
  });
  it('Schengen ↔ non-Schengen walks pass passport control in every usable direction', () => {
    for (const id of ['w:cdg-k-2f', 'w:cdg-l-2f']) {
      expect(kinds(walk(id).controls)).toEqual(expect.arrayContaining(['transfer-security', 'passport']));
      expect(kinds(walk(id).reverseControls)).toEqual(['passport']);
    }
    expect(kinds(walk('w:cdg-hub-2f').controls)).toEqual(['transfer-security', 'passport']);
    expect(kinds(walk('w:cdg-2d-2b').controls)).toEqual(['passport']);
  });
  it('entering airside from the public side always passes security', () => {
    for (const w of m.walks) {
      if (w.access === 'restricted') continue;
      const a = area(w.from), b = area(w.to);
      if (a.side === 'landside' && b.side === 'airside') expect(kinds(w.controls).some((k) => /security/.test(k))).toBe(true);
      if (w.bidirectional && b.side === 'landside' && a.side === 'airside') expect(kinds(w.reverseControls ?? w.controls).some((k) => /security/.test(k))).toBe(true);
    }
  });
  it('2B → 2D (non-Schengen → Schengen) has no airside walk: only 2D → 2B through exit passport control', () => {
    expect(walk('w:cdg-2d-2b').bidirectional).toBe(false);
    expect(m.walks.some((w) => (w.from === 'cdg-2b' && w.to === 'cdg-2d') || (w.bidirectional && w.from === 'cdg-2d' && w.to === 'cdg-2b'))).toBe(false);
  });
  it('2A ↔ 2C airside passage and alighting at the 2A/2C blue stop stay inferred', () => {
    expect(walk('w:cdg-link-2a').confidence).toBe('inferred');
    expect(walk('w:cdg-link-2c').confidence).toBe('inferred');
    expect(findRoute(m, 'cdg-2a', 'cdg-2c')!.confidence).toBe('inferred');
  });
  it('transfer-only lines are airside and never stop in a landside area', () => {
    for (const l of m.lines.filter((x) => x.access === 'transfer')) {
      expect(l.side).toBe('airside');
      for (const sid of l.stops) expect(area(stop(sid).area).side).toBe('airside');
    }
  });
  it('unknown shuttle controls are marked: the 2B/2D blue stop sits on its own node, security both ways to 2B (inferred), passport + security to 2D (first-hand)', () => {
    const s = stop('s:cdg-blue-bd');
    expect(s.confidence).toBe('inferred');
    expect(s.area).toBe('cdg-2bd-bus');
    expect(s.accessControls ?? []).toEqual([]);
    expect(kinds(walk('w:cdg-2b-2bdbus').controls)).toEqual(['security']);
    expect(kinds(walk('w:cdg-2bdbus-2b').controls)).toEqual(['security']);
    expect(walk('w:cdg-2bdbus-2b').confidence).toBe('inferred');
    expect(kinds(walk('w:cdg-2bdbus-2d').controls)).toEqual(['passport', 'security']);
    expect(m.walks.some((w) => w.from === 'cdg-2d' && w.to === 'cdg-2bd-bus')).toBe(false);
  });
});

describe('CDG transport', () => {
  it('CDGVAL: T1 → PR → Roissypôle → PX → T2 station, public, 04:00–01:00, 9 min scheduled', () => {
    const l = line('l:cdg-cdgval');
    expect(l.stops.map((s) => stop(s).area)).toEqual(['cdg-t1-land', 'cdg-cdgval-pr', 'cdg-roissypole', 'cdg-cdgval-px', 'cdg-t2-station']);
    expect(l.access).toBe('public');
    expect(l.service[0].hours).toBe('04:00–01:00');
    expect(l.rideMin.reduce((s, x) => s + x, 0)).toBe(9);
  });
  it('LISA: K station (behind the 2E border post) → L → M; alighting at L or M passes security', () => {
    const l = line('l:cdg-lisa');
    expect(l.stops.map((s) => stop(s).area)).toEqual(['cdg-2e-hub', 'cdg-2e-l', 'cdg-2e-m']);
    expect(kinds(stop('s:cdg-lisa-l').egressControls)).toEqual(['security']);
    expect(kinds(stop('s:cdg-lisa-m').egressControls)).toEqual(['security']);
    expect(kinds(walk('w:cdg-2eland-hub').controls)).toEqual(['passport']);
  });
  it('blue connection shuttle: one-way loop 2A/2C → T1 → 2B/2D → 2F/L → K, 35 min, no Hall M stop', () => {
    const l = line('l:cdg-blue');
    expect(l.direction).toBe('loop');
    expect(l.stops.map((s) => stop(s).area)).toEqual(['cdg-2ac-link', 'cdg-t1-blue', 'cdg-2bd-bus', 'cdg-2f-blue', 'cdg-2e-k-transfer']);
    expect(l.rideMin.reduce((s, x) => s + x, 0)).toBe(35);
    expect(l.access).toBe('transfer');
    expect(l.confidence).toBe('probable');
  });
  it('orange shuttle links Schengen 2F and 2G airside without controls; N2 links them on the public side', () => {
    const o = line('l:cdg-orange');
    expect(o.stops.map((s) => area(stop(s).area).zone)).toEqual(['schengen', 'schengen']);
    expect(o.stops.every((s) => !(stop(s).accessControls?.length) && !(stop(s).egressControls?.length))).toBe(true);
    expect(line('l:cdg-n2').stops.map((s) => stop(s).area)).toEqual(['cdg-t2f-land', 'cdg-t2g-land']);
  });
  it('the 2F → Hall M bus is one-way and boarded after the exit passport control', () => {
    const l = line('l:cdg-bus-2f-m');
    expect(l.direction).toBe('one-way');
    expect(kinds(stop(l.stops[0]).accessControls)).toEqual(['passport']);
    expect(area(stop(l.stops[1]).area).id).toBe('cdg-2e-m');
  });
});

describe('CDG routes', () => {
  it('2E Hall M → 2F: LISA to K, then transfer security and Schengen entry (one crossing)', () => {
    const r = findRoute(m, 'cdg-2e-m', 'cdg-2f')!;
    expect(r.lines).toEqual(['l:cdg-lisa']);
    expect(r.controls).toEqual(['transfer-security', 'passport']);
    expect(r.borderCrossings).toBe(1);
  });
  it('2F → 2G stays airside on the orange shuttle with no controls', () => {
    const r = findRoute(m, 'cdg-2f', 'cdg-2g')!;
    expect(r.lines).toEqual(['l:cdg-orange']);
    expect(r.controls).toEqual([]);
  });
  it('2G → 2E Hall K: orange shuttle to 2F, then exit passport control', () => {
    const r = findRoute(m, 'cdg-2g', 'cdg-2e-k')!;
    expect(r.lines).toEqual(['l:cdg-orange']);
    expect(r.controls).toContain('passport');
    expect(r.borderCrossings).toBe(1);
  });
  it('2E Hall K → 2A for connecting passengers uses the blue shuttle and stays inferred', () => {
    const r = findRoute(m, 'cdg-2e-k', 'cdg-2a')!;
    expect(r.lines).toEqual(['l:cdg-blue']);
    expect(r.borderCrossings).toBe(0);
    expect(r.confidence).toBe('inferred');
    const p = findRoute(m, 'cdg-2e-k', 'cdg-2a', { transfer: false })!;
    expect(p.lines).not.toContain('l:cdg-blue');
  });
  it('Schengen 2D → 2F goes through the public side (no airside Schengen link)', () => {
    const r = findRoute(m, 'cdg-2d', 'cdg-2f')!;
    expect(r.controls).toContain('security');
    expect(r.borderCrossings).toBe(0);
  });
  it('2E Hall K → 2E Hall M by LISA with security at Hall M', () => {
    const r = findRoute(m, 'cdg-2e-k', 'cdg-2e-m')!;
    expect(r.lines).toEqual(['l:cdg-lisa']);
    expect(r.controls).toEqual(['security']);
  });
  it('Terminal 1 ↔ Terminal 2 public routes use CDGVAL', () => {
    expect(findRoute(m, 'cdg-t1-land', 'cdg-t2-station')!.lines).toEqual(['l:cdg-cdgval']);
  });
});

describe('CDG phase 2: hours, ride bases and time of day', () => {
  const T = (from: string, to: string, time?: string, extra: Partial<Profile> = {}) => findRoute(m, from, to, { transfer: true, time, ...extra });
  it('every routed line has hour windows and ride ranges whose typical equals rideMin', () => {
    for (const l of m.lines.filter((x) => !x.notRouted)) {
      expect(l.service.every((s) => (s.windows ?? []).length > 0)).toBe(true);
      expect(l.ride?.length).toBe(l.rideMin.length);
      l.ride!.forEach((r, i) => { expect(r.typical).toBe(l.rideMin[i]); expect(r.min).toBeLessThanOrEqual(r.typical); expect(r.max).toBeGreaterThanOrEqual(r.typical); });
    }
  });
  it('published hours: CDGVAL 04:00–01:00 (4/5 min), LISA 04:30–00:30, N1 24 h (15 min at night), N2 05:30–23:30, blue 05:30–23:30, orange 05:30–23:00, purple 05:30–20:00', () => {
    const d = m.asOf;
    expect(serviceAt(line('l:cdg-cdgval'), d, '02:00')).toBeNull();
    expect(serviceAt(line('l:cdg-cdgval'), d, '00:50')!.headwayMin.max).toBe(5);
    expect(serviceAt(line('l:cdg-cdgval'), d, '08:00')!.headwayMin.max).toBe(4);
    expect(serviceAt(line('l:cdg-cdgval-night-bus'), d, '03:00')).not.toBeNull();
    expect(serviceAt(line('l:cdg-cdgval-night-bus'), d, '10:00')).toBeNull();
    expect(serviceAt(line('l:cdg-lisa'), d, '00:45')).toBeNull();
    expect(serviceAt(line('l:cdg-lisa'), d, '04:45')!.headwayMin.max).toBe(5);
    expect(serviceAt(line('l:cdg-n1'), d, '03:00')!.headwayMin.max).toBe(15);
    expect(serviceAt(line('l:cdg-n2'), d, '23:45')).toBeNull();
    expect(serviceAt(line('l:cdg-blue'), d, '05:15')).toBeNull();
    expect(serviceAt(line('l:cdg-orange'), d, '23:15')).toBeNull();
    expect(serviceAt(line('l:cdg-bus-2f-m'), d, '20:30')).toBeNull();
  });
  it('ride bases: CDGVAL/N1/N2/blue/orange published (timetable, signs, maps), LISA measured, night bus derived', () => {
    for (const id of ['l:cdg-cdgval', 'l:cdg-n1', 'l:cdg-n2', 'l:cdg-blue', 'l:cdg-orange']) expect(line(id).ride!.every((r) => r.basis === 'published')).toBe(true);
    expect(line('l:cdg-lisa').ride!.map((r) => r.basis)).toEqual(['measured', 'measured']);
    expect(line('l:cdg-cdgval-night-bus').ride!.every((r) => r.basis === 'derived')).toBe(true);
    expect(line('l:cdg-cdgval-night-bus').confidence).toBe('inferred');
  });
  it('yellow and red shuttles are drawn but not routed', () => {
    expect(line('l:cdg-yellow').notRouted).toBeTruthy();
    expect(line('l:cdg-red').notRouted).toBeTruthy();
    const mx = buildMatrix(m);
    for (const c of mx.cells) if (c.route) expect(c.route.lines.some((x) => x === 'l:cdg-yellow' || x === 'l:cdg-red')).toBe(false);
  });
  it('night (03:00): T1 ↔ T2 by the CDGVAL replacement bus; Hall M unreachable (LISA closed); 2G unreachable (N2 and orange closed)', () => {
    expect(T('cdg-t1-land', 'cdg-t2-station', '03:00')!.lines).toEqual(['l:cdg-cdgval-night-bus']);
    expect(T('cdg-t1-land', 'cdg-t2-station', '10:00')!.lines).toEqual(['l:cdg-cdgval']);
    expect(T('cdg-2e-k', 'cdg-2e-m', '03:00')).toBeNull();
    expect(T('cdg-2e-k', 'cdg-2e-m', '05:00')!.lines).toEqual(['l:cdg-lisa']);
    expect(T('cdg-2f', 'cdg-2g', '03:00')).toBeNull();
    expect(T('cdg-2f', 'cdg-2g', '23:30')).toBeNull();
    expect(T('cdg-2f', 'cdg-2g', '22:30')!.lines).toEqual(['l:cdg-orange']);
  });
  it('2F → Hall M: purple bus by day, LISA from the K station in the evening', () => {
    expect(T('cdg-2f', 'cdg-2e-m', '10:00')!.lines).toEqual(['l:cdg-bus-2f-m']);
    const eve = T('cdg-2f', 'cdg-2e-m', '21:00')!;
    expect(eve.lines).toEqual(['l:cdg-lisa']);
    expect(eve.borderCrossings).toBe(1);
  });
  it('controls are counted once: Hall M → 2A screens once (transfer level reached from the LISA K station)', () => {
    const r = findRoute(m, 'cdg-2e-m', 'cdg-2a')!;
    expect(r.lines).toEqual(['l:cdg-lisa', 'l:cdg-blue']);
    expect(r.controls).toEqual(['transfer-security']);
  });
  it('T1 non-Schengen ↔ Terminal 2 non-Schengen use the blue shuttle without passport control (ANA: after the gates 10–38 security)', () => {
    const out = findRoute(m, 'cdg-t1-ns', 'cdg-2e-k')!;
    expect(out.lines).toEqual(['l:cdg-blue']);
    expect(out.controls).toEqual(['transfer-security']);
    expect(out.borderCrossings).toBe(0);
    expect(out.steps.find((s) => s.kind === 'ride')!.minutes.typical).toBe(21);
    const back = findRoute(m, 'cdg-2a', 'cdg-t1-ns')!;
    expect(back.borderCrossings).toBe(0);
    expect(back.confidence).toBe('inferred');
  });
  it('only T3 pairs still cross passport control twice (no airside link to T3)', () => {
    const mx = buildMatrix(m);
    const twice = mx.cells.filter((c) => c.route && c.route.borderCrossings > 1);
    expect(twice.length).toBe(14);
    expect(twice.every((c) => c.from === 'cdg-t3-air' || c.to === 'cdg-t3-air')).toBe(true);
  });
  it('2E Hall K → 2D (non-Schengen → Schengen) crosses passport control once', () => {
    const r = findRoute(m, 'cdg-2e-k', 'cdg-2d')!;
    expect(r.borderCrossings).toBe(1);
    expect(r.controls.filter((k) => k === 'passport').length).toBe(1);
  });
  it('very short and very long connections', () => {
    const short = findRoute(m, 'cdg-2d', 'cdg-2b')!;
    expect(short.movement.typical).toBeLessThanOrEqual(8);
    expect(short.controls).toEqual(['passport']);
    const long = findRoute(m, 'cdg-t1-ns', 'cdg-2g')!;
    expect(long.total.typical).toBeGreaterThan(45);
    // Protected transfers prefer the airside path (blue shuttle, entry passport at 2F, orange shuttle) over landside CDGVAL + N2.
    expect(long.lines).toEqual(['l:cdg-blue', 'l:cdg-orange']);
    expect(long.entersCountry).toBe(false);
  });
  it('walk times: measured video segments and published walks carry their basis', () => {
    expect(walk('w:cdg-t1land-t1ns').minutes.basis).toBe('measured');
    expect(walk('w:cdg-station-2eland').minutes.basis).toBe('measured');
    expect(walk('w:cdg-acland-bdland').minutes.basis).toBe('measured');
    expect(walk('w:cdg-t3land-roissypole').minutes).toMatchObject({ typical: 5, basis: 'published' });
    expect(stop('s:cdg-cdgval-t3').accessMinutes.basis).toBe('measured');
    const assumed = m.walks.filter((w) => w.minutes.basis === 'assumed').map((w) => w.id).sort();
    expect(assumed).toEqual(['w:cdg-2b-2bdbus', 'w:cdg-2bdbus-2b', 'w:cdg-2bdbus-2d']);
  });
});

describe('CDG phase 3: transfer scenarios, night service and baggage', () => {
  const T = (from: string, to: string, time?: string, extra: Partial<Profile> = {}) => findRoute(m, from, to, { transfer: true, time, ...extra });
  const evOf = (id: string) => ev.items.filter((i) => i.supports?.includes(id)).map((i) => i.source);
  it('CDGVAL night replacement: headway published (GTFS 20 min, Grand Roissy 25 min), stops and rides still inferred', () => {
    const l = line('l:cdg-cdgval-night-bus');
    const s = serviceAt(l, m.asOf, '03:00')!;
    expect(s.headwayMin).toEqual({ min: 20, max: 25 });
    expect(s.headwayBasis).toBe('published');
    expect(s.waitMin).toMatchObject({ typical: 11, max: 25, basis: 'derived' });
    expect(s.sources).toEqual(expect.arrayContaining(['src:idfm-gtfs-2026-11', 'src:grand-roissy-cdgval']));
    expect(stop('s:cdg-cdgvalbus-t2').where).toMatch(/level 5/);
    expect(l.confidence).toBe('inferred');
    expect(l.ride!.every((r) => r.basis === 'derived')).toBe(true);
    if (EV) expect(evOf('l:cdg-cdgval-night-bus')).toEqual(expect.arrayContaining(['src:idfm-gtfs-2026-11', 'src:grand-roissy-cdgval']));
  });
  it('night T1/T3 ↔ T2 by the replacement bus waits about 11 min; CDGVAL takes over again by day', () => {
    const r = T('cdg-t1-land', 'cdg-t2-station', '03:00')!;
    expect(r.lines).toEqual(['l:cdg-cdgval-night-bus']);
    expect(r.steps.find((x) => x.kind === 'wait')!.minutes.typical).toBe(11);
    expect(T('cdg-roissypole', 'cdg-t2-station', '02:30')!.lines).toEqual(['l:cdg-cdgval-night-bus']);
  });
  it('N2: 05:30–23:30 between 2F and 2G; the evening call at 2E (GTFS, 21:30–23:30) is drawn but not routed', () => {
    expect(line('l:cdg-n2').service[0].windows).toEqual([{ from: '05:30', until: '23:30' }]);
    const e = line('l:cdg-n2-evening');
    expect(e.notRouted).toBeTruthy();
    expect(e.stops.map((s) => stop(s).area)).toEqual(['cdg-t2f-land', 'cdg-t2e-land', 'cdg-t2g-land']);
    expect(e.service[0].windows).toEqual([{ from: '21:30', until: '23:30' }]);
    for (const time of [undefined, '22:00']) for (const c of buildMatrix(m, { transfer: true, time }).cells) if (c.route) expect(c.route.lines).not.toContain('l:cdg-n2-evening');
    expect(T('cdg-2f', 'cdg-2g', '22:00')!.lines).toEqual(['l:cdg-orange']);
  });
  it('2G ↔ 2E go through 2F (CDG Facile 2026-10-28): orange shuttle + passport by day, the N2 public side after the orange shuttle stops', () => {
    const day = T('cdg-2g', 'cdg-2e-k', '10:00')!;
    expect(day.lines).toEqual(['l:cdg-orange']);
    expect(day.borderCrossings).toBe(1);
    const late = T('cdg-2g', 'cdg-2e-k', '23:15')!;
    expect(late.lines).toEqual(['l:cdg-n2']);
    expect(late.controls).toEqual(expect.arrayContaining(['passport', 'security']));
    expect(T('cdg-2g', 'cdg-2e-k', '23:45')).toBeNull();
  });
  it('rail: T1 and T3 reach the RER CDG 1 hall (Roissypôle), Terminal 2 arrivals reach the TGV/RER station, all on public links', () => {
    const t1 = findRoute(m, 'cdg-t1-ns', 'cdg-roissypole')!;
    expect(t1.lines).toEqual(['l:cdg-cdgval']);
    expect(t1.borderCrossings).toBe(1);
    expect(T('cdg-t1-ns', 'cdg-roissypole', '03:00')!.lines).toEqual(['l:cdg-cdgval-night-bus']);
    expect(findRoute(m, 'cdg-t3-air', 'cdg-roissypole')!.lines).toEqual([]);
    for (const a of ['cdg-2a', 'cdg-2e-k', 'cdg-2e-m', 'cdg-2f', 'cdg-2g']) {
      const r = findRoute(m, a, 'cdg-t2-station')!;
      expect(r.lines.every((id) => line(id).access !== 'transfer')).toBe(true);
    }
    const toM = findRoute(m, 'cdg-t2-station', 'cdg-2e-m', { transfer: false, fromArrival: false })!;
    expect(toM.lines).toEqual(['l:cdg-lisa']);
    expect(toM.controls).toEqual(['passport', 'security']);
  });
  it('self-transfer (bags re-checked) is two legs: arrival → departure terminal public hall without transfer-only lines, then security', () => {
    const out = findRoute(m, 'cdg-2e-k', 'cdg-t2f-land')!;
    expect(out.controls).toEqual(['passport', 'customs']);
    expect(out.lines.every((id) => line(id).access !== 'transfer')).toBe(true);
    const back = findRoute(m, 'cdg-t2f-land', 'cdg-2f', { transfer: false, fromArrival: false })!;
    expect(back.controls).toEqual(['security']);
  });
  it('baggage and customs rule: bags through on one ticket, re-check landside, EU 2015/2447 art. 39, and the open domestic-onward question', () => {
    const r = m.rules.find((x) => x.id === 'r:cdg-baggage')!;
    expect(r.sources).toEqual(expect.arrayContaining(['src:cdgfacile', 'src:eu-reg-2015-2447-art39']));
    expect(r.text).toMatch(/no check-in desk in the transit area/);
    expect(m.openQuestions.map((q) => q.id)).toEqual(expect.arrayContaining(['q:cdg-dom-bags', 'q:cdg-n2-evening', 'q:cdg-cdgval-night-bus']));
  });
  it('T1 non-Schengen ↔ Terminal 2 outside blue-shuttle hours falls back to the public side through two passport controls', () => {
    const r = T('cdg-t1-ns', 'cdg-2e-k', '23:45')!;
    expect(r.lines).toEqual(['l:cdg-cdgval']);
    expect(r.borderCrossings).toBe(2);
    expect(T('cdg-t1-ns', 'cdg-2e-k', '10:00')!.borderCrossings).toBe(0);
  });
});

describe.skipIf(!EV)('CDG evidence', () => {
  it('evidence references only known sources and covers videos read frame by frame', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    expect(new Set(ev.items.filter((i) => i.method === 'video-frames').map((i) => i.source)).size).toBeGreaterThanOrEqual(30);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.stops, ...m.lines, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('CDG remediation data (contract v1 fields)', () => {
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
  it('R-42: every CDG transfer security is conditional on the origin (Air France: not after CA/US/IE/UK/Schengen)', () => {
    const ts = [...m.walks.flatMap((w) => [...(w.controls ?? []), ...(w.reverseControls ?? [])]), ...m.stops.flatMap((s) => [...(s.accessControls ?? []), ...(s.egressControls ?? [])])].filter((c) => c.kind === 'transfer-security');
    expect(ts.length).toBeGreaterThan(5);
    for (const c of ts as any[]) expect(c.when).toBe('origin-not-one-stop');
    expect(mm.oneStopSecurity.countries).toEqual(expect.arrayContaining(['US', 'CA', 'GB', 'IE', 'FR']));
  });
  it('R-02: 2E halls carry a conditional same-hall security and an intra-hall walk of several minutes', () => {
    for (const id of ['cdg-2e-k', 'cdg-2e-l', 'cdg-2e-m']) { const a = m.areas.find((x) => x.id === id) as any; expect(a.intraControls[0].when).toBe('origin-not-one-stop'); expect(a.intraWalk.typical).toBeGreaterThanOrEqual(4); }
  });
  it('R-12: the 2E hub is not a check-in hall; 2E departures check in at the 2E hall', () => {
    expect((m.areas.find((a) => a.id === 'cdg-2e-hub') as any).checkIn).toBeUndefined();
    expect((m.areas.find((a) => a.id === 'cdg-t2e-land') as any).checkIn.serves).toEqual(['cdg-2e-k', 'cdg-2e-l', 'cdg-2e-m']);
  });
  it('R-19: El Al at 2B with a published gate presence deadline; no screening minutes', () => {
    const s = mm.specialScreening.find((x: any) => x.id === 'ss:cdg-elal-2b');
    expect(s.areas).toEqual(['cdg-2b']);
    expect(s.deadline.minutesBeforeDeparture).toBe(50);
  });
});

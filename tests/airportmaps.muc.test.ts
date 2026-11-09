// MUC (Munich) data model: gate lists, zones, connections and safety rules (data assertions, as of 2026-10-31).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/muc/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('muc');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const line = (id: string) => m.lines.find((l) => l.id === id)!;
const stop = (id: string) => m.stops.find((s) => s.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);
const num = (g: string) => parseInt(g.slice(1), 10);

describe('MUC model validity', () => {
  it('validates without errors', () => {
    expect(validateAirport(m, EV).errors).toEqual([]);
  });
  it('every matrix pair is routable', () => {
    const mx = buildMatrix(m);
    const missing = mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`);
    expect(missing).toEqual([]);
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['muc-sat-k', 'muc-sat-l', 'muc-sbahn', 'muc-t1-a', 'muc-t1-b', 'muc-t1-c', 'muc-t1-d', 'muc-t1-land', 'muc-t1-pier', 'muc-t2-g', 'muc-t2-h', 'muc-t2-land']);
  });
});

describe('MUC T1 Pier (opened 21 April 2026)', () => {
  it('the pier is non-Schengen and planned before / active from 21 April 2026', () => {
    const p = area('muc-t1-pier');
    expect(p.zone).toBe('non-schengen');
    expect(p.status?.find((s) => s.state === 'planned')?.until).toBe('2026-04-20');
    expect(p.status?.find((s) => s.state === 'active')?.from).toBe('2026-04-21');
  });
  it('before the opening the pier drops out of the matrix', () => {
    const mx = buildMatrix(m, { transfer: true, date: '2026-03-01' });
    expect(mx.areas.map((a) => a.id)).not.toContain('muc-t1-pier');
    expect(buildMatrix(m).areas.map((a) => a.id)).toContain('muc-t1-pier');
  });
  it('pier gates: contact A40–A51, remote (bus) A60–A62 and A64; crew gate A63 not listed', () => {
    expect(m.gateGroups.find((g) => g.id === 'muc-gates-a40-a51')!.gates).toEqual(Array.from({ length: 12 }, (_, i) => `A${40 + i}`));
    const bus = m.gateGroups.find((g) => g.id === 'muc-gates-a60-a64')!;
    expect(bus.bus).toBe(true);
    expect(bus.gates).toEqual(['A60', 'A61', 'A62', 'A64']);
    expect(allGates).not.toContain('A63');
  });
  it('departure into the pier passes security and exit passport control; leaving it is an arrivals flow with entry control', () => {
    expect(kinds(walk('w:muc-t1-pier-dep').controls)).toEqual(['security', 'passport']);
    for (const id of ['w:muc-t1-pier-arr-l05', 'w:muc-t1-pier-arr']) {
      expect(walk(id).flow).toBe('arrivals');
      expect(walk(id).bidirectional).toBe(false);
    }
    expect(kinds(walk('w:muc-t1-pier-arr').controls)).toEqual(['passport', 'customs']);
  });
  it('pier arrivals are segregated: an arriving transfer passenger goes via Level 05 and the transfer checkpoint', () => {
    expect(area('muc-t1-pier').arrivals).toBe('segregated');
    expect(kinds(walk('w:muc-t1-pier-transfer').controls)).toEqual(['transfer-security']);
    const r = findRoute(m, 'muc-t1-pier', 'muc-t2-h')!;
    expect(r.controls).toContain('transfer-security');
    expect(r.lines).toEqual(['l:muc-bus-nonschengen']);
  });
});

describe('MUC gates per area (OSM 2026-10-31 + sources)', () => {
  it('module A holds A09–A28 (A13 not attested)', () => {
    const a = gatesOf('muc-t1-a');
    expect(a.every((g) => g.startsWith('A') && num(g) >= 9 && num(g) <= 28)).toBe(true);
    expect(a).toEqual(expect.arrayContaining(['A09', 'A20', 'A28']));
    expect(a).not.toContain('A13');
  });
  it('modules B, C, D hold only their letter', () => {
    for (const [id, l] of [['muc-t1-b', 'B'], ['muc-t1-c', 'C'], ['muc-t1-d', 'D']]) expect(gatesOf(id).every((g) => g.startsWith(l))).toBe(true);
    expect(gatesOf('muc-t1-c')).toContain('C08');
    expect(gatesOf('muc-t1-d')).toEqual(expect.arrayContaining(['D15', 'D23']));
  });
  it('T2: G01–G48 and H01–H48 are complete and on the same stands (stacked levels)', () => {
    const seq = (l: string) => Array.from({ length: 48 }, (_, i) => `${l}${String(i + 1).padStart(2, '0')}`);
    expect(m.gateGroups.find((g) => g.id === 'muc-gates-g01-g48')!.gates).toEqual(seq('G'));
    expect(m.gateGroups.find((g) => g.id === 'muc-gates-h01-h48')!.gates).toEqual(seq('H'));
    expect(area('muc-t2-g').stack).toEqual({ group: 'muc-t2-main', order: 0, label: 'L04' });
    expect(area('muc-t2-h').stack?.group).toBe('muc-t2-main');
    expect(area('muc-t2-h').stack?.order).toBe(1);
  });
  it('T2 bus gates G61–G84 (incl. G83) and satellite J gates are bus gates', () => {
    const gb = m.gateGroups.find((g) => g.id === 'muc-gates-g-bus')!;
    expect(gb.bus).toBe(true);
    expect(gb.gates).toContain('G83');
    const j = m.gateGroups.find((g) => g.id === 'muc-gates-j')!;
    expect(j.bus).toBe(true);
    expect(j.gates).toEqual(['J01', 'J02', 'J03', 'J04', 'J05', 'J06']);
    expect(j.zone).toBe('mixed');
  });
  it('satellite: K Schengen below, L non-Schengen above (stacked); K14, K27, L30 attested', () => {
    expect(area('muc-sat-k').zone).toBe('schengen');
    expect(area('muc-sat-l').zone).toBe('non-schengen');
    expect(area('muc-sat-k').stack!.order).toBeLessThan(area('muc-sat-l').stack!.order);
    expect(gatesOf('muc-sat-k')).toEqual(expect.arrayContaining(['K14', 'K27']));
    expect(gatesOf('muc-sat-l')).toContain('L30');
    expect(gatesOf('muc-sat-l').every((g) => g.startsWith('L'))).toBe(true);
  });
  it('no gate is listed twice, no E or F gates are invented, and the total is stable', () => {
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(allGates.filter((g) => /^[EF]\d/.test(g))).toEqual([]);
    expect(gatesOf('muc-hall-f')).toEqual([]);
    expect(allGates.length).toBe(239);
  });
});

describe('MUC zones and controls (safety)', () => {
  it('Schengen ↔ non-Schengen walks pass passport control both ways', () => {
    for (const id of ['w:muc-g-h', 'w:muc-k-l']) {
      const w = walk(id);
      expect(kinds(w.controls)).toContain('passport');
      expect(kinds(w.reverseControls ?? w.controls)).toContain('passport');
    }
  });
  it('entering airside from the public side always passes security', () => {
    for (const w of m.walks) {
      const a = area(w.from), b = area(w.to);
      if (a.side === 'landside' && b.side === 'airside') expect(kinds(w.controls)).toContain('security');
      if (w.bidirectional && b.side === 'landside' && a.side === 'airside') expect(kinds(w.reverseControls ?? w.controls)).toContain('security');
    }
  });
  it('legacy modules A and B keep an unresolved zone and have no airside link to other areas', () => {
    for (const id of ['muc-t1-a', 'muc-t1-b']) {
      expect(area(id).zone).toBe('mixed');
      const links = m.walks.filter((w) => w.from === id || w.to === id);
      expect(links.every((w) => [w.from, w.to].includes('muc-t1-land'))).toBe(true);
    }
  });
  it('the T1–T2 transfer buses are airside, transfer-only, and each stays in one border zone', () => {
    const zoneOf = (sid: string) => area(stop(sid).area).zone;
    for (const [id, z] of [['l:muc-bus-schengen', 'schengen'], ['l:muc-bus-nonschengen', 'non-schengen']]) {
      const l = line(id);
      expect(l.access).toBe('transfer');
      expect(l.side).toBe('airside');
      for (const sid of l.stops) expect(zoneOf(sid)).toBe(z);
    }
    expect(line('l:muc-bus-schengen').stops.map((s) => stop(s).area)).toEqual(['muc-t1-c', 'muc-t2-g']);
  });
  it('the PTS lines link G ↔ K and H ↔ L only, within one zone each', () => {
    expect(line('l:muc-pts-schengen').stops.map((s) => stop(s).area)).toEqual(['muc-t2-g', 'muc-sat-k']);
    expect(line('l:muc-pts-nonschengen').stops.map((s) => stop(s).area)).toEqual(['muc-t2-h', 'muc-sat-l']);
  });
});

describe('MUC transport', () => {
  it('PTS: 04:00–24:00 every 4 min, ~1 min ride, both directions; 2024 maintenance suspension is historical', () => {
    const l = line('l:muc-pts-schengen');
    expect(l.mode).toBe('people-mover');
    expect(l.direction).toBe('both');
    expect(l.rideMin).toEqual([1]);
    expect(l.service[0]).toMatchObject({ hours: '04:00–24:00', headwayMin: { min: 4, max: 4 } });
    expect(l.status?.[0]).toMatchObject({ state: 'suspended', from: '2024-01-29', until: '2024-02-25' });
    expect(l.confidence).toBe('verified');
  });
  it('transfer bus: every 10 min 07–17, every 20 min 06–07 and 17–23, ride ~6 min', () => {
    const l = line('l:muc-bus-schengen');
    expect(l.service.map((s) => s.headwayMin.max)).toEqual([10, 20]);
    expect(l.service[0].hours).toBe('07:00–17:00');
    expect(l.rideMin).toEqual([6]);
  });
});

describe('MUC routes', () => {
  it('T2 G → satellite L: one passport crossing (PTS + K→L or G→H + PTS)', () => {
    const r = findRoute(m, 'muc-t2-g', 'muc-sat-l')!;
    expect(r.borderCrossings).toBe(1);
    expect(r.lines.some((x) => x.startsWith('l:muc-pts'))).toBe(true);
  });
  it('T1 Pier → satellite L stays airside: non-Schengen bus then non-Schengen PTS, no passport', () => {
    const r = findRoute(m, 'muc-t1-pier', 'muc-sat-l')!;
    expect(r.lines).toEqual(['l:muc-bus-nonschengen', 'l:muc-pts-nonschengen']);
    expect(r.borderCrossings).toBe(0);
    expect(r.controls).not.toContain('security');
  });
  it('without the transfer profile, the pier → T2 H route leaves via the arrivals flow and re-enters T2', () => {
    const r = findRoute(m, 'muc-t1-pier', 'muc-t2-h', { transfer: false })!;
    expect(r.lines).toEqual([]);
    expect(r.controls).toEqual(expect.arrayContaining(['passport', 'security']));
  });
  it('T1 C (Schengen) → T2 G uses the Schengen transfer bus', () => {
    const r = findRoute(m, 'muc-t1-c', 'muc-t2-g')!;
    expect(r.lines).toEqual(['l:muc-bus-schengen']);
    expect(r.borderCrossings).toBe(0);
  });
  it('S-Bahn → T2 G: MAC, T2 hall and central security', () => {
    const r = findRoute(m, 'muc-sbahn', 'muc-t2-g')!;
    expect(r.controls).toEqual(['security']);
    expect(r.lines).toEqual([]);
  });
});

describe('MUC phase 2: hours, rides and night (official transfer page re-read 2026-10-31)', () => {
  const T = (time?: string, extra: Record<string, unknown> = {}) => ({ transfer: true, time, ...extra });
  it('PTS: one published window 04:00–24:00 on both car groups, headway basis published, ride measured / published ~1 min', () => {
    for (const id of ['l:muc-pts-schengen', 'l:muc-pts-nonschengen']) {
      const l = line(id);
      expect(l.service).toHaveLength(1);
      expect(l.service[0].windows).toEqual([{ from: '04:00', until: '24:00' }]);
      expect(l.service[0].headwayBasis).toBe('published');
      expect(l.ride![0].typical).toBe(l.rideMin[0]);
      expect(l.ride![0].max).toBeLessThanOrEqual(1.5);
    }
    expect(line('l:muc-pts-schengen').ride![0].basis).toBe('measured');
    expect(line('l:muc-pts-nonschengen').ride![0].basis).toBe('published');
  });
  it('transfer bus: daytime 07–17 every 10 min first, then 06–07 and 17–23 every 20 min; ride published 5–7 min', () => {
    for (const id of ['l:muc-bus-schengen', 'l:muc-bus-nonschengen']) {
      const l = line(id);
      expect(l.service[0].windows).toEqual([{ from: '07:00', until: '17:00' }]);
      expect(l.service[1].windows).toEqual([{ from: '06:00', until: '07:00' }, { from: '17:00', until: '23:00' }]);
      expect(l.service.map((s) => s.headwayMin.max)).toEqual([10, 20]);
      expect(l.ride).toEqual([expect.objectContaining({ min: 5, typical: 6, max: 7, basis: 'published' })]);
    }
  });
  it('the H and L platform accesses are measured from an uncut video segment', () => {
    expect(stop('s:muc-pts-h').accessMinutes).toMatchObject({ typical: 3, basis: 'measured' });
    expect(stop('s:muc-pts-l').accessMinutes.basis).toBe('measured');
  });
  it('T1 C → T2 G: bus at 10:00 (10-min headway), longer wait at 06:30 (20-min headway), public side at 23:30', () => {
    const day = findRoute(m, 'muc-t1-c', 'muc-t2-g', T('10:00'))!;
    const early = findRoute(m, 'muc-t1-c', 'muc-t2-g', T('06:30'))!;
    expect(day.lines).toEqual(['l:muc-bus-schengen']);
    expect(early.lines).toEqual(['l:muc-bus-schengen']);
    expect(early.total.typical - day.total.typical).toBe(5);
    const late = findRoute(m, 'muc-t1-c', 'muc-t2-g', T('23:30'))!;
    expect(late.lines).toEqual([]);
    expect(late.controls).toEqual(['security']);
  });
  it('T1 Pier arrival → T2 H: bus with transfer security by day; at 23:30 only via entry and exit passport control (warned)', () => {
    const day = findRoute(m, 'muc-t1-pier', 'muc-t2-h', T('10:00'))!;
    expect(day.lines).toEqual(['l:muc-bus-nonschengen']);
    expect(day.borderCrossings).toBe(0);
    const late = findRoute(m, 'muc-t1-pier', 'muc-t2-h', T('23:30'))!;
    expect(late.lines).toEqual([]);
    expect(late.borderCrossings).toBe(2);
    expect(late.warnings.join(' ')).toMatch(/passport control more than once/);
  });
  it('the satellite is reachable at 23:30 but not at 03:00 (PTS 04:00–24:00)', () => {
    expect(findRoute(m, 'muc-t2-g', 'muc-sat-k', T('23:30'))!.lines).toEqual(['l:muc-pts-schengen']);
    for (const [a, b] of [['muc-t2-g', 'muc-sat-k'], ['muc-sat-l', 'muc-t2-h'], ['muc-sbahn', 'muc-sat-k']]) {
      expect(findRoute(m, a, b, T('03:00'))).toBeNull();
    }
    // The clock runs along the route (R-13): from the T1 Pier at 03:00 the PTS is reached after it opens at 04:00, but only
    // through landside (two passport controls, entering the country), so the route carries material issues.
    const pier = findRoute(m, 'muc-t1-pier', 'muc-sat-l', T('03:00'))!;
    expect(pier.lines).toEqual(['l:muc-pts-nonschengen']);
    expect(pier.issues.filter((i) => i.level === 'material').map((i) => i.code)).toEqual(expect.arrayContaining(['double-passport', 'enters-country']));
    const night = buildMatrix(m, T('03:00'));
    const sat = new Set(['muc-sat-k', 'muc-sat-l']);
    const missing = night.cells.filter((c) => c.from !== c.to && !c.route);
    expect(missing.length).toBe(38);
    expect(missing.every((c) => sat.has(c.from) || sat.has(c.to))).toBe(true);
  });
  it('inside the 2024 PTS suspension the satellite is unroutable (replacement bus not modelled)', () => {
    expect(findRoute(m, 'muc-t2-g', 'muc-sat-k', { transfer: true, date: '2024-02-10' })).toBeNull();
    expect(findRoute(m, 'muc-t2-g', 'muc-sat-k', { transfer: true, date: '2024-03-01' })!.lines).toEqual(['l:muc-pts-schengen']);
  });
  it('a very short connection (G → K, ~8 min movement) and the longest one (satellite L → T1 A, via the public side)', () => {
    const short = findRoute(m, 'muc-t2-g', 'muc-sat-k')!;
    expect(short.movement.typical).toBeLessThanOrEqual(9);
    expect(short.controls).toEqual([]);
    const long = findRoute(m, 'muc-sat-l', 'muc-t1-a')!;
    expect(long.controls).toEqual(['passport', 'customs', 'security']);
    expect(long.confidence).toBe('inferred');
    expect(long.total.typical).toBeGreaterThan(55);
  });
  it('before the pier opened (2026-03-01) a T1 → T2 non-Schengen route cannot start at the pier', () => {
    expect(findRoute(m, 'muc-t1-pier', 'muc-t2-h', { transfer: true, date: '2026-03-01' })).toBeNull();
  });
  it('movement and control time are reported separately (controls never folded into walks)', () => {
    const r = findRoute(m, 'muc-sbahn', 'muc-t2-h')!;
    expect(r.controlTime.typical).toBe(25);
    expect(r.movement.typical + r.controlTime.typical).toBeCloseTo(r.total.typical, 5);
  });
  it('night rule and the new open questions are recorded', () => {
    expect(m.rules.find((r) => r.id === 'r:muc-night')).toBeTruthy();
    expect(m.openQuestions.map((q) => q.id)).toEqual(expect.arrayContaining(['q:muc-t1-ab-checkpoints', 'q:muc-pts-replacement', 'q:muc-night-transfer']));
  });
});

describe.skipIf(!EV)('MUC evidence', () => {
  it('evidence references only known sources and covers videos read frame by frame', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    const vids = new Set(ev.items.filter((i) => i.method === 'video-frames').map((i) => i.source));
    expect(vids.size).toBeGreaterThanOrEqual(7);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.stops, ...m.lines, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});

describe('MUC phase 3: transfer scenarios, baggage and controls (2026-11-01)', () => {
  it('arrivals exits pass customs after entry passport control (T1 pier and T2 H), never on departure', () => {
    expect(kinds(walk('w:muc-t1-pier-arr').controls)).toEqual(['passport', 'customs']);
    expect(kinds(walk('w:muc-t2-h').reverseControls)).toEqual(['passport', 'customs']);
    expect(kinds(walk('w:muc-t2-h').controls)).not.toContain('customs');
    expect(kinds(walk('w:muc-t1-pier-dep').controls)).not.toContain('customs');
  });
  it('airside non-Schengen transfer T1 pier → T2 H uses transfer security and the non-Schengen bus, without passport or customs', () => {
    const r = findRoute(m, 'muc-t1-pier', 'muc-t2-h', { transfer: true, time: '10:00' })!;
    expect(r.lines).toEqual(['l:muc-bus-nonschengen']);
    expect(r.controls).toEqual(['transfer-security']);
    expect(r.borderCrossings).toBe(0);
  });
  it('the same pair without a transfer boarding pass (self-transfer) goes landside: passport, customs, security, passport', () => {
    const r = findRoute(m, 'muc-t1-pier', 'muc-t2-h', { transfer: false, time: '10:00' })!;
    expect(r.lines).toEqual([]);
    expect(r.controls).toEqual(['passport', 'customs', 'security', 'passport']);
    expect(r.warnings.join(' ')).toMatch(/passport control more than once/);
  });
  it('at 23:30 and 03:00 (no transfer bus) pier → T2 H falls back to the public side with a double-passport warning', () => {
    for (const time of ['23:30', '03:00']) {
      const r = findRoute(m, 'muc-t1-pier', 'muc-t2-h', { transfer: true, time })!;
      expect(r.lines).toEqual([]);
      expect(r.borderCrossings).toBe(2);
    }
  });
  it('non-Schengen arrival in T2 H → Schengen G: entry passport and (origin-dependent) transfer security, no customs airside', () => {
    const r = findRoute(m, 'muc-t2-h', 'muc-t2-g')!;
    expect(r.controls).toEqual(['passport', 'transfer-security']);
  });
  it('T2 ↔ satellite is unroutable 00:00–04:00 (PTS hours) in both border zones', () => {
    for (const [a, b] of [['muc-t2-h', 'muc-sat-l'], ['muc-sat-k', 'muc-t2-g'], ['muc-sbahn', 'muc-sat-l']]) expect(findRoute(m, a, b, { transfer: true, time: '03:00' })).toBeNull();
  });
  it('landside rail → departure and arrival → rail exist for every terminal (S-Bahn ↔ T1 pier, T2 G/H, satellite)', () => {
    for (const to of ['muc-t1-pier', 'muc-t1-d', 'muc-t2-g', 'muc-t2-h', 'muc-sat-k', 'muc-sat-l']) expect(findRoute(m, 'muc-sbahn', to, { transfer: false })).not.toBeNull();
    expect(findRoute(m, 'muc-t1-pier', 'muc-sbahn', { transfer: false })!.controls).toEqual(['passport', 'customs']);
    expect(findRoute(m, 'muc-sat-l', 'muc-sbahn', { transfer: false })!.controls).toEqual(['passport', 'customs']);
  });
  it('a pier arrival connecting to another pier gate re-enters through the Level 05 transfer checkpoint', () => {
    expect(findRoute(m, 'muc-t1-pier-l05', 'muc-t1-pier')!.controls).toEqual(['transfer-security']);
  });
  it('baggage rule and the phase-3 open questions are recorded with their sources', () => {
    const r = m.rules.find((x) => x.id === 'r:muc-baggage')!;
    expect(r.sources).toEqual(expect.arrayContaining(['src:muc-official-transfer', 'src:eu-2015-2447-art39']));
    expect(m.openQuestions.map((q) => q.id)).toEqual(expect.arrayContaining(['q:muc-domestic-bags', 'q:muc-reclaim-time']));
    expect(m.openQuestions.find((q) => q.id === 'q:muc-night-transfer')!.howToResolve).toMatch(/STAFF screening/);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('MUC remediation data (contract v1 fields)', () => {
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
  it('R-16: legacy modules A/B leave the non-Schengen zone from 2026-04-21 (all non-Schengen flights at the Pier)', () => {
    for (const id of ['muc-t1-a', 'muc-t1-b']) expect((m.areas.find((a) => a.id === id) as any).zones).toEqual([{ zone: 'schengen', validFrom: '2026-04-21' }]);
    expect(mm.feedTerminals.arrival['1B']).toEqual(['muc-t1-pier']);
  });
  it('R-19: Israel flights at Hall F (official + feed 1F = TLV)', () => {
    const s = mm.specialScreening.find((x: any) => x.id === 'ss:muc-israel-hall-f');
    expect(s.areas).toEqual(['muc-hall-f']);
    expect(s.certainty).toBe('verified');
    expect(mm.feedTerminals.departure['1F']).toEqual(['muc-hall-f']);
  });
  it('R-05: H → Pier by the non-Schengen bus is screened conditionally at the Pier; Pier → H only once', () => {
    expect((m.stops.find((s) => s.id === 's:muc-bus-t1-a28')!.egressControls as any[])[0].when).toBe('origin-not-one-stop');
    expect(findRoute(m, 'muc-t1-pier', 'muc-t2-h', { transfer: true, time: '10:00' })!.controls).toEqual(['transfer-security']);
  });
});

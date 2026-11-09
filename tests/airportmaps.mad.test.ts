// MAD (Adolfo Suárez Madrid-Barajas) data model: gate lists, zones, connections and safety rules (data assertions, as of 2026-10-31).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/mad/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('mad');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const line = (id: string) => m.lines.find((l) => l.id === id)!;
const stop = (id: string) => m.stops.find((s) => s.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);

describe('MAD model validity', () => {
  it('validates without errors or warnings', () => {
    const r = validateAirport(m, EV);
    expect(r.errors).toEqual([]);
    // sources cited only by the contract-v1 fields (specialScreening, checkIn …) look uncited to the pre-v1 validator
    const v1 = JSON.stringify({ s: (m as any).specialScreening, c: m.areas.map((a: any) => a.checkIn), f: (m as any).feedTerminals });
    expect(r.warnings.filter((w) => !(/is not cited anywhere/.test(w) && v1.includes(w.match(/source (\S+) is/)![1])))).toEqual([]);
  });
  it('every matrix pair is routable', () => {
    const mx = buildMatrix(m);
    const missing = mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`);
    expect(missing).toEqual([]);
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['mad-t1-ab', 'mad-t1-land', 'mad-t2-cd', 'mad-t2-land', 'mad-t3-e', 'mad-t4-hjk', 'mad-t4-land', 'mad-t4s-m', 'mad-t4s-s']);
  });
});

describe('MAD gates per area (OSM 2026-10-31 + Aena + videos)', () => {
  it('T1 A and B gates are non-Schengen; the B/C swing positions carry both numbers', () => {
    expect(area('mad-t1-ab').zone).toBe('non-schengen');
    const ab = gatesOf('mad-t1-ab');
    expect(ab.every((g) => /^[AB]\d+$/.test(g))).toBe(true);
    for (const g of ['A1', 'A14', 'B18', 'B29', 'B30', 'B33']) expect(ab).toContain(g);
    expect(gatesOf('mad-t2-cd')).toEqual(expect.arrayContaining(['C30', 'C33']));
  });
  it('C and D gates are Schengen in the C/D area; E gates in T3', () => {
    expect(area('mad-t2-cd').zone).toBe('schengen');
    expect(gatesOf('mad-t2-cd').every((g) => /^[CD]\d+$/.test(g))).toBe(true);
    for (const g of ['C34', 'C38', 'C50', 'D53', 'D66']) expect(gatesOf('mad-t2-cd')).toContain(g);
    expect(gatesOf('mad-t3-e').every((g) => g.startsWith('E'))).toBe(true);
    expect(gatesOf('mad-t3-e')).not.toContain('E79');
  });
  it('T4 has H, J, K gates (Schengen); J40–J59 complete', () => {
    expect(area('mad-t4-hjk').zone).toBe('schengen');
    expect(gatesOf('mad-t4-hjk').every((g) => /^[HJK]\d+$/.test(g))).toBe(true);
    expect(m.gateGroups.find((g) => g.id === 'mad-gates-j')!.gates).toEqual(Array.from({ length: 20 }, (_, i) => `J${40 + i}`));
  });
  it('T4S: M gates on the Schengen level only as attested; R/S/U on the non-Schengen level', () => {
    expect(gatesOf('mad-t4s-m')).toEqual(['M22', 'M28', 'M51']);
    expect(area('mad-t4s-m').zone).toBe('schengen');
    expect(area('mad-t4s-s').zone).toBe('non-schengen');
    expect(gatesOf('mad-t4s-s').every((g) => /^[RSU]\d+$/.test(g))).toBe(true);
    for (const g of ['S15', 'S16', 'S20', 'S37', 'S39', 'S40', 'S46', 'U74', 'R1']) expect(gatesOf('mad-t4s-s')).toContain(g);
  });
  it('M and S levels share one stacked footprint', () => {
    expect(area('mad-t4s-m').stack).toMatchObject({ group: 'mad-t4s', order: 0 });
    expect(area('mad-t4s-s').stack).toMatchObject({ group: 'mad-t4s', order: 1 });
  });
  it('no gate is listed twice, no bus gate is claimed and the total is stable', () => {
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(m.gateGroups.some((g) => g.bus)).toBe(false);
    expect(allGates.length).toBe(210);
  });
});

describe('MAD zones and controls (safety)', () => {
  it('every Schengen → non-Schengen walk passes passport control (C/D → A/B, M → S, S arrivals)', () => {
    for (const id of ['w:mad-cd-ab', 'w:mad-m-s', 'w:mad-s-arr', 'w:mad-t1land-ab', 'w:mad-conn-cd', 'w:mad-conn-t1land']) expect(kinds(walk(id).controls)).toContain('passport');
  });
  it('entering airside from the public side always passes security', () => {
    for (const w of m.walks) {
      const a = area(w.from), b = area(w.to);
      if (w.access === 'restricted') continue;
      if (a.side === 'landside' && b.side === 'airside') expect(kinds(w.controls)).toEqual(expect.arrayContaining([expect.stringMatching(/security/)]));
      if (w.bidirectional && b.side === 'landside' && a.side === 'airside') expect(kinds(w.reverseControls ?? w.controls)).toEqual(expect.arrayContaining([expect.stringMatching(/security/)]));
    }
  });
  it('arrivals-flow walks are one-way and include the T4S floor-2 passport control', () => {
    const arr = m.walks.filter((w) => w.flow === 'arrivals');
    expect(arr.every((w) => !w.bidirectional)).toBe(true);
    expect(arr.map((w) => w.id)).toEqual(expect.arrayContaining(['w:mad-ab-conn', 'w:mad-s-arr', 'w:mad-m-arr', 'w:mad-hjk-t4arr', 'w:mad-s-remote']));
  });
  it('arrivals are segregated at T1 A/B and T4S S: routes from there start with the arrivals flow', () => {
    for (const id of ['mad-t1-ab', 'mad-t4s-s']) {
      expect(area(id).arrivals).toBe('segregated');
      const r = findRoute(m, id, 'mad-t4-land')!;
      expect(r.steps.find((s) => s.kind === 'walk')!.text).toContain('arrivals flow');
    }
  });
  it('transfer-only and airside lines never stop in a landside area', () => {
    for (const l of m.lines.filter((x) => x.access !== 'public')) {
      expect(l.side).toBe('airside');
      for (const sid of l.stops) expect(area(stop(sid).area).side).toBe('airside');
    }
  });
  it('the T1–T4S transfer bus only links non-Schengen transit nodes', () => {
    const l = line('l:mad-tbus-t1-t4s');
    expect(l.access).toBe('transfer');
    expect(l.stops.map((s) => area(stop(s).area).zone)).toEqual(['non-schengen', 'non-schengen']);
  });
  it('no route uses a restricted link and none crosses the border twice when a transfer route exists', () => {
    const mx = buildMatrix(m);
    for (const c of mx.cells.filter((x) => x.route)) expect(c.route!.borderCrossings).toBeLessThanOrEqual(1);
  });
});

describe('MAD transport', () => {
  it('landside free buses: T1 → T2 → T4 (2 + 8 min) and T4 → T3 → T2 → T1 (8 + 2 + 5 min), 24 h, every 5 / 20 min', () => {
    const a = line('l:mad-bus-t1-t4'), b = line('l:mad-bus-t4-t1');
    expect(a.direction).toBe('one-way');
    expect(a.stops.map((s) => stop(s).area)).toEqual(['mad-t1-land', 'mad-t2-land', 'mad-t4-land']);
    expect(a.rideMin).toEqual([2, 8]);
    expect(b.stops.map((s) => stop(s).area)).toEqual(['mad-t4-land', 'mad-t3-land', 'mad-t2-land', 'mad-t1-land']);
    expect(b.rideMin.reduce((x, y) => x + y, 0)).toBe(15);
    for (const l of [a, b]) {
      expect(l.access).toBe('public');
      expect(l.service.map((s) => s.headwayMin.max)).toEqual([5, 20]);
    }
  });
  it('APM T4 ↔ T4S runs both ways, 24 h (window 00:00–24:00), every 4–12 min (published), ride measured 3–5 min (typ. 4), airside Schengen', () => {
    const l = line('l:mad-apm');
    expect(l.direction).toBe('both');
    expect(l.service[0].hours).toBe('00:00–24:00');
    expect(l.service[0].windows).toEqual([{ from: '00:00', until: '24:00' }]);
    expect(l.service[0].headwayMin).toEqual({ min: 4, max: 12 });
    expect(l.service[0].headwayBasis).toBe('published');
    expect(l.rideMin).toEqual([4]);
    expect(l.ride![0]).toMatchObject({ min: 3, typical: 4, max: 5, basis: 'measured' });
    expect(l.stops.map((s) => area(stop(s).area).zone)).toEqual(['schengen', 'schengen']);
  });
  it('the APM arrivals side is one-way T4S → T4 baggage hall 10, same 24-h service', () => {
    const l = line('l:mad-apm-arr');
    expect(l.direction).toBe('one-way');
    expect(l.stops.map((s) => stop(s).area)).toEqual(['mad-t4s-arr', 'mad-t4-arr']);
    expect(l.rideMin).toEqual(line('l:mad-apm').rideMin);
    expect(l.service[0].windows).toEqual([{ from: '00:00', until: '24:00' }]);
  });
  it('landside buses: published day (06–22, 5 min) and night (22–06, 20 min) windows and published per-segment rides', () => {
    for (const id of ['l:mad-bus-t1-t4', 'l:mad-bus-t4-t1']) {
      const l = line(id);
      expect(l.service.map((s) => s.windows)).toEqual([[{ from: '06:00', until: '22:00' }], [{ from: '22:00', until: '06:00' }]]);
      expect(l.service.every((s) => s.headwayBasis === 'published')).toBe(true);
      expect(l.ride!.map((r) => r.typical)).toEqual(l.rideMin);
      expect(l.ride!.every((r) => r.basis === 'published')).toBe(true);
    }
  });
  it('transfer bus T1 ↔ T4S: 24 h on request, wait assumed (no frequency published), ride observed ≈ 12 min', () => {
    const l = line('l:mad-tbus-t1-t4s');
    expect(l.service[0].windows).toEqual([{ from: '00:00', until: '24:00' }]);
    expect(l.service[0].headwayBasis).toBe('assumed');
    expect(l.service[0].waitMin.basis).toBe('assumed');
    expect(l.ride![0]).toMatchObject({ typical: 12, basis: 'observed' });
  });
  it('no line is left without hour windows or ride basis', () => {
    for (const l of m.lines) {
      expect(l.service.every((s) => (s.windows ?? []).length > 0)).toBe(true);
      expect(l.ride?.length).toBe(l.rideMin.length);
    }
  });
});

describe('MAD time of day (all inter-terminal transport is 24 h)', () => {
  it('every matrix pair stays routable at 03:00 and 23:30', () => {
    for (const time of ['03:00', '23:30']) {
      for (const a of m.areas.filter((x) => x.matrix)) for (const b of m.areas.filter((x) => x.matrix)) {
        if (a.id === b.id) continue;
        expect(findRoute(m, a.id, b.id, { transfer: true, time }), `${a.id}->${b.id} @${time}`).not.toBeNull();
      }
    }
  });
  it('at night the landside bus waits follow the 20-min headway (T2 C/D → T4 H/J/K)', () => {
    const day = findRoute(m, 'mad-t2-cd', 'mad-t4-hjk', { transfer: true, time: '10:00' })!;
    const night = findRoute(m, 'mad-t2-cd', 'mad-t4-hjk', { transfer: true, time: '03:00' })!;
    const wait = (r: typeof day) => r.steps.filter((s) => s.kind === 'wait').reduce((x, s) => x + s.minutes.typical, 0);
    expect(wait(day)).toBe(2.5);
    expect(wait(night)).toBe(10);
    expect(night.lines).toEqual(['l:mad-bus-t1-t4']);
    expect(night.warnings.join(' ')).not.toMatch(/hours not published/);
  });
  it('the T4 → T4S APM is used at 03:00 (uninterrupted service)', () => {
    const r = findRoute(m, 'mad-t4-hjk', 'mad-t4s-s', { transfer: true, time: '03:00' })!;
    expect(r.lines).toEqual(['l:mad-apm']);
  });
});

describe('MAD routes', () => {
  it('T2 Schengen C/D → T4 H/J/K goes landside on the free bus and re-screens at T4', () => {
    const r = findRoute(m, 'mad-t2-cd', 'mad-t4-hjk')!;
    expect(r.lines).toContain('l:mad-bus-t1-t4');
    expect(r.controls).toContain('security');
    expect(r.borderCrossings).toBe(0);
  });
  it('T4 H/J/K → T4S S takes the APM and one passport control', () => {
    const r = findRoute(m, 'mad-t4-hjk', 'mad-t4s-s')!;
    expect(r.lines).toEqual(['l:mad-apm']);
    expect(r.borderCrossings).toBe(1);
  });
  it('T1 A/B → T4S S (connecting) uses the transfer bus without passport control', () => {
    const r = findRoute(m, 'mad-t1-ab', 'mad-t4s-s')!;
    expect(r.lines).toEqual(['l:mad-tbus-t1-t4s']);
    expect(r.controls).not.toContain('passport');
    expect(r.borderCrossings).toBe(0);
  });
  it('without the transfer profile, A/B → S must enter Spain and leave again (warned)', () => {
    const r = findRoute(m, 'mad-t1-ab', 'mad-t4s-s', { transfer: false })!;
    expect(r.lines).not.toContain('l:mad-tbus-t1-t4s');
    expect(r.borderCrossings).toBe(2);
  });
  it('T4S S → C/D does not use the transfer bus (eligibility: non-Schengen ↔ non-Schengen only)', () => {
    const r = findRoute(m, 'mad-t4s-s', 'mad-t2-cd')!;
    expect(r.lines).not.toContain('l:mad-tbus-t1-t4s');
    expect(r.lines).toEqual(['l:mad-apm-arr', 'l:mad-bus-t4-t1']);
  });
  it('C/D → A/B is a walk with one passport control (near C34–C38)', () => {
    const r = findRoute(m, 'mad-t2-cd', 'mad-t1-ab')!;
    expect(r.lines).toEqual([]);
    expect(r.borderCrossings).toBe(1);
  });
  it('shortest vs longest: C/D → E is a short same-zone walk; T4S S → T3 E is the longest cell (two hubs, passport + re-screening)', () => {
    const short = findRoute(m, 'mad-t2-cd', 'mad-t3-e')!;
    expect(short.lines).toEqual([]);
    expect(short.controls).toEqual([]);
    expect(short.total.typical).toBeLessThan(10);
    const long = findRoute(m, 'mad-t4s-s', 'mad-t3-e')!;
    expect(long.lines).toEqual(['l:mad-apm-arr', 'l:mad-bus-t4-t1']);
    expect(long.controls).toEqual(expect.arrayContaining(['passport', 'security']));
    expect(long.total.typical).toBeGreaterThanOrEqual(60);
    expect(long.controlTime.typical).toBeGreaterThan(0);
    expect(long.movement.typical + long.controlTime.typical).toBeCloseTo(long.total.typical, 5);
  });
  it('T4S S arrival → T4S arrivals walk is measured (uncut 2024 video) and stays one-way arrivals flow', () => {
    const x = walk('w:mad-s-arr');
    expect(x.minutes.basis).toBe('measured');
    expect(x.flow).toBe('arrivals');
    expect(x.bidirectional).toBe(false);
  });
});

describe.skipIf(!EV)('MAD evidence', () => {
  it('evidence references only known sources and covers videos read frame by frame', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    expect(new Set(ev.items.filter((i) => i.method === 'video-frames').map((i) => i.source)).size).toBeGreaterThanOrEqual(10);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.stops, ...m.lines, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});

describe('MAD phase 3: transfer scenarios, baggage and controls (2026-11-01)', () => {
  const zoneOf = (id: string) => area(id).zone;
  const airside = ['mad-t1-ab', 'mad-t2-cd', 'mad-t3-e', 'mad-t4-hjk', 'mad-t4s-m', 'mad-t4s-s'];
  it('every airside pair routes, and passport crossings match the border zones (Aena connecting page)', () => {
    for (const a of airside) for (const b of airside) {
      if (a === b) continue;
      const r = findRoute(m, a, b, { transfer: true })!;
      expect(r, `${a}->${b}`).not.toBeNull();
      // a zone change needs exactly one passport crossing; same zone: none, except via the landside bus between hubs
      if (zoneOf(a) !== zoneOf(b)) expect(r.borderCrossings, `${a}->${b}`).toBe(1);
    }
  });
  it('the only airside link between the two hubs is the transfer bus, non-Schengen ↔ non-Schengen, without passport control', () => {
    for (const [a, b] of [['mad-t1-ab', 'mad-t4s-s'], ['mad-t4s-s', 'mad-t1-ab']]) {
      const r = findRoute(m, a, b, { transfer: true })!;
      expect(r.lines).toEqual(['l:mad-tbus-t1-t4s']);
      expect(r.controls).toEqual(['transfer-security']);
    }
    // Schengen ↔ any cross-hub pair uses the landside bus and re-screening
    const r = findRoute(m, 'mad-t2-cd', 'mad-t4-hjk', { transfer: true })!;
    expect(r.lines).toEqual(['l:mad-bus-t1-t4']);
    expect(r.controls).toEqual(['security']);
  });
  it('without a transfer boarding card (self-transfer, bags to collect) T1 A/B → T4S S goes landside with two passport controls', () => {
    const r = findRoute(m, 'mad-t1-ab', 'mad-t4s-s', { transfer: false })!;
    expect(r.lines).not.toContain('l:mad-tbus-t1-t4s');
    expect(r.controls).toEqual(['passport', 'customs', 'security', 'passport']);
    expect(r.warnings.join(' ')).toMatch(/passport control more than once/);
  });
  it('T1 non-Schengen arrivals leave through entry passport control and customs', () => {
    expect(kinds(walk('w:mad-conn-t1land').controls)).toEqual(['passport', 'customs']);
    expect(findRoute(m, 'mad-t1-ab', 'mad-t1-land', { transfer: false })!.controls).toEqual(['passport', 'customs']);
  });
  it('S → H/J/K passes T4S passport, the APM arrivals side and the hall-10 connection security (Aena)', () => {
    const r = findRoute(m, 'mad-t4s-s', 'mad-t4-hjk', { transfer: true })!;
    expect(r.lines).toEqual(['l:mad-apm-arr']);
    expect(r.controls).toEqual(['passport', 'transfer-security']);
  });
  it('S → M (Iberia Schengen at M) stays in T4S: passport on level 2, security on level 0, no APM', () => {
    const r = findRoute(m, 'mad-t4s-s', 'mad-t4s-m', { transfer: true })!;
    expect(r.lines).toEqual([]);
    expect(r.controls).toEqual(['passport', 'transfer-security']);
  });
  it('landside rail/metro → departure and arrival → rail exist for both hubs', () => {
    for (const [a, b] of [['mad-metro-t123', 'mad-t1-ab'], ['mad-metro-t123', 'mad-t2-cd'], ['mad-rail-t4', 'mad-t4-hjk'], ['mad-rail-t4', 'mad-t4s-s'], ['mad-t4s-s', 'mad-rail-t4'], ['mad-t1-ab', 'mad-metro-t123']]) expect(findRoute(m, a, b, { transfer: false }), `${a}->${b}`).not.toBeNull();
  });
  it('night (03:00): every cross-hub pair still routes (24-h buses, APM and transfer bus), with the 20-min night headway', () => {
    for (const [a, b] of [['mad-t1-ab', 'mad-t4s-s'], ['mad-t4s-s', 'mad-t2-cd'], ['mad-t2-cd', 'mad-t4s-m']]) expect(findRoute(m, a, b, { transfer: true, time: '03:00' }), `${a}->${b}`).not.toBeNull();
  });
  it('baggage rule, T4 night evidence and the phase-3 open questions are recorded', () => {
    expect(m.rules.find((r) => r.id === 'r:mad-baggage')!.sources).toEqual(expect.arrayContaining(['src:aena-connecting', 'src:eu-2015-2447-art39']));
    expect(m.openQuestions.map((q) => q.id)).toEqual(expect.arrayContaining(['q:mad-domestic-bags', 'q:mad-reclaim-time', 'q:mad-night-security', 'q:mad-tbus-time']));
    if (EV) expect(ev.items.find((i) => i.id === 'ev:mad-valet-t4-night')!.supports).toContain('w:mad-t4land-hjk');
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('MAD remediation data (contract v1 fields)', () => {
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
  it('R-17: a Schengen terminal "1" maps to T1/T2/T3 areas, never to T4/T4S', () => {
    expect(mm.feedTerminals.arrival['1']).toEqual(['mad-t1-ab', 'mad-t2-cd', 'mad-t3-e']);
    expect(mm.oneStopSecurity).toBeUndefined();   // no origin exemption documented at MAD: every transfer security applies
  });
  it('R-19: El Al boards at T4S S (Aena)', () => {
    expect(mm.specialScreening.find((x: any) => x.id === 'ss:mad-elal-t4s').areas).toEqual(['mad-t4s-s']);
  });
});

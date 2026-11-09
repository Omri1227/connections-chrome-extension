// AMS (Amsterdam Schiphol) data model: gate lists, zones, connections and safety rules (data assertions, as of 2026-10-31).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/ams/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('ams');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);
const num = (g: string) => parseInt(g.slice(1), 10);

describe('AMS model validity', () => {
  it('validates without errors', () => {
    expect(validateAirport(m, EV).errors).toEqual([]);
  });
  it('every matrix pair is routable; pier A (planned) is not in the matrix on 2026-10-31', () => {
    const mx = buildMatrix(m);
    const missing = mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`);
    expect(missing).toEqual([]);
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['ams-b', 'ams-c', 'ams-d-n', 'ams-d-s', 'ams-e', 'ams-f', 'ams-g', 'ams-h', 'ams-l1', 'ams-l2', 'ams-l3', 'ams-m', 'ams-plaza']);
  });
});

describe('AMS piers and status', () => {
  it('pier A is planned until April 2027 and has no gates', () => {
    const a = area('ams-a');
    expect(a.status![0].state).toBe('planned');
    expect(a.status![0].until).toBe('2027-03-31');
    expect(gatesOf('ams-a')).toEqual([]);
    expect(allGates.filter((g) => g.startsWith('A'))).toEqual([]);
  });
  it('zones: B, C, M and D upper Schengen; D lower, E, F, G, H non-Schengen', () => {
    for (const id of ['ams-b', 'ams-c', 'ams-m', 'ams-d-s', 'ams-l1']) expect(area(id).zone).toBe('schengen');
    for (const id of ['ams-d-n', 'ams-e', 'ams-f', 'ams-g', 'ams-h', 'ams-l2', 'ams-l3']) expect(area(id).zone).toBe('non-schengen');
  });
  it('pier D is one footprint on two levels: lower non-Schengen, upper Schengen', () => {
    const lo = area('ams-d-n'), up = area('ams-d-s');
    expect(lo.stack!.group).toBe(up.stack!.group);
    expect(lo.stack!.order).toBeLessThan(up.stack!.order);
    expect(lo.shape).toEqual(up.shape);
  });
  it('no walk links the two levels of pier D directly', () => {
    const pair = (w: { from: string; to: string }) => [w.from, w.to].sort().join('|');
    expect(m.walks.filter((w) => pair(w) === 'ams-d-n|ams-d-s')).toEqual([]);
  });
});

describe('AMS gates per area (OSM 2026-07 + videos)', () => {
  it('D1–D57 are on the lower level, D59–D87 on the upper level', () => {
    expect(gatesOf('ams-d-n').every((g) => g.startsWith('D') && num(g) <= 57)).toBe(true);
    expect(gatesOf('ams-d-s').every((g) => g.startsWith('D') && num(g) >= 59)).toBe(true);
    expect(gatesOf('ams-d-n')).toEqual(expect.arrayContaining(['D2', 'D7', 'D43', 'D57']));
    expect(gatesOf('ams-d-s')).toEqual(expect.arrayContaining(['D59', 'D78', 'D87']));
  });
  it('each pier holds only its own letter; H and M are separate areas', () => {
    for (const [id, p] of [['ams-b', 'B'], ['ams-c', 'C'], ['ams-e', 'E'], ['ams-f', 'F'], ['ams-g', 'G'], ['ams-h', 'H'], ['ams-m', 'M']] as const) {
      const g = gatesOf(id);
      expect(g.length).toBeGreaterThan(0);
      expect(g.every((x) => x.startsWith(p))).toBe(true);
    }
  });
  it('B1–B8 are bus gates; contact gates are not', () => {
    const bus = m.gateGroups.filter((g) => g.bus);
    expect(bus.map((g) => g.id)).toEqual(['ams-gates-b-bus']);
    expect(bus[0].gates).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']);
  });
  it('unattested numbers are not filled in (E10–E16, D1, B19)', () => {
    for (const g of ['E10', 'E13', 'E16', 'D1', 'B19', 'F1']) expect(allGates).not.toContain(g);
    expect(allGates).toContain('G10');
  });
  it('no gate is listed twice and the total is stable', () => {
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(allGates.length).toBe(140);
  });
});

describe('AMS zones and controls (safety)', () => {
  it('Lounge 1 ↔ Lounge 2 passes passport control both ways', () => {
    const w = walk('w:ams-l1-l2');
    expect(kinds(w.controls)).toContain('passport');
    expect(kinds(w.reverseControls)).toContain('passport');
  });
  it('entering airside from the Plaza always passes security; non-Schengen lounges also passport', () => {
    for (const w of m.walks.filter((x) => x.from === 'ams-plaza' && area(x.to).side === 'airside')) expect(kinds(w.controls)).toContain('security');
    for (const id of ['w:ams-plaza-l2', 'w:ams-plaza-l3']) expect(kinds(walk(id).controls)).toEqual(['security', 'passport']);
  });
  it('pier M is isolated: its only walks go to or from the Plaza', () => {
    const ws = m.walks.filter((w) => w.from === 'ams-m' || w.to === 'ams-m');
    expect(ws.map((w) => w.id)).toEqual(['w:ams-plaza-m']);
    const r = findRoute(m, 'ams-m', 'ams-b')!;
    expect(r.controls).toContain('security');
  });
  it('arrivals-flow walks are one-way; exits end landside through passport control, transfer flows pass the conditional filter', () => {
    const arr = m.walks.filter((w) => w.flow === 'arrivals');
    expect(arr.length).toBeGreaterThanOrEqual(2);
    for (const w of arr) {
      expect(w.bidirectional).toBe(false);
      if (area(w.to).side === 'landside') expect(kinds(w.controls)).toContain('passport');
      else {
        expect(w.access).toBe('transfer');
        expect(w.controls!.map((c) => [c.kind, (c as any).when])).toEqual([['transfer-security', 'origin-not-one-stop']]);
      }
    }
  });
  it('remediation R-02/R-05: E, F, G, H are arrivals-segregated with a transfer flow and a landside exit each', () => {
    for (const id of ['ams-e', 'ams-f', 'ams-g', 'ams-h']) {
      expect(area(id).arrivals).toBe('segregated');
      const out = m.walks.filter((w) => w.from === id && w.flow === 'arrivals');
      expect(out.some((w) => area(w.to).side === 'landside')).toBe(true);
      expect(out.some((w) => area(w.to).side === 'airside')).toBe(true);
    }
    // a same-pier connection is no longer 0 min: arrivals floor → filter → back to the pier
    const ee = findRoute(m, 'ams-e', 'ams-e')!;
    expect(ee.controls).toEqual(['transfer-security']);
    expect(ee.total.typical).toBeGreaterThan(10);
  });
  it('remediation R-05: one-stop security list (EU law + KLM), TLV excluded', () => {
    const o = (m as any).oneStopSecurity;
    expect(o.countries).toEqual(expect.arrayContaining(['US', 'GB', 'IE', 'CY', 'SG', 'NL', 'CH']));
    expect(o.countries).not.toContain('IL');
    expect(o.excludedAirports).toEqual(['TLV']);
    expect(o.airports).toEqual(['BEG']);
    expect(o.sources.length).toBeGreaterThan(0);
  });
  it('there is no transport line (all airside movement is on foot)', () => {
    expect(m.lines).toEqual([]);
    expect(m.stops).toEqual([]);
  });
});

describe('AMS routes', () => {
  it('Lounge 1 → B uses the BC link on 2026-10-31; the Middenbrug is planned until 17 Nov 2026', () => {
    const r = findRoute(m, 'ams-l1', 'ams-b')!;
    expect(r).toBeTruthy();
    const mb = walk('w:ams-l1-b-middenbrug');
    expect(mb.status![0]).toMatchObject({ state: 'planned', until: '2026-11-17' });
    const later = findRoute(m, 'ams-l1', 'ams-b', { transfer: true, date: '2026-12-01' })!;
    expect(later.total.typical).toBeLessThan(r.total.typical);
  });
  it('D upper (Schengen) → D lower (non-Schengen) goes via Lounge 1 and Lounge 2 with one passport crossing', () => {
    const r = findRoute(m, 'ams-d-s', 'ams-d-n')!;
    expect(r.borderCrossings).toBe(1);
    expect(r.controls).toContain('passport');
  });
  it('G → B (non-Schengen → Schengen) crosses exactly one border and is screened once', () => {
    const r = findRoute(m, 'ams-g', 'ams-b')!;
    expect(r.borderCrossings).toBe(1);
    // Since R-05 the G arrival passes one screening (the conditional transfer filter, or the departure security when the
    // router prefers the landside way at equal cost: an engine choice, see AGENT_B_LOG R-05) and one passport control.
    expect(r.controls.filter((c) => c === 'passport')).toHaveLength(1);
    expect(r.controls.filter((c) => c === 'security' || c === 'transfer-security')).toHaveLength(1);
  });
  it('E → G stays non-Schengen: only the origin-dependent transfer filter', () => {
    const r = findRoute(m, 'ams-e', 'ams-g')!;
    expect(r.borderCrossings).toBe(0);
    expect(r.controls).toEqual(['transfer-security']);
  });
});

describe('AMS phase 2: travel times and operations (2026-10-31)', () => {
  const movement = (r: { steps: { kind: string; minutes: { typical: number } }[] }) =>
    r.steps.filter((s) => s.kind !== 'control').reduce((t, s) => t + s.minutes.typical, 0);
  it('no walk minutes are assumed; frame-measured walks carry their timing note and a video source', () => {
    expect(m.walks.filter((w) => w.minutes.basis === 'assumed').map((w) => w.id)).toEqual([]);
    const measured = m.walks.filter((w) => w.minutes.basis === 'measured').map((w) => w.id).sort();
    expect(measured).toEqual(['w:ams-c-b', 'w:ams-l1-b', 'w:ams-l1-c', 'w:ams-l1-d-s', 'w:ams-l2-d-n', 'w:ams-l2-l3', 'w:ams-l3-g']);
    const kind = new Map(m.sources.map((s) => [s.id, s.kind]));
    for (const id of measured) {
      const w = walk(id);
      expect(w.minutes.note).toMatch(/t≈/);
      expect(w.sources.some((s) => kind.get(s) === 'video')).toBe(true);
      expect(w.minutes.min).toBeLessThan(w.minutes.max);
    }
  });
  it('measured values: Holland Boulevard Lounge 2 ↔ 3 ≈ 5 min, Lounge 1 → B via the BC link ≈ 7 min', () => {
    expect(walk('w:ams-l2-l3').minutes).toMatchObject({ typical: 5, basis: 'measured' });
    expect(walk('w:ams-l1-b').minutes).toMatchObject({ typical: 7, basis: 'measured' });
    expect(walk('w:ams-l3-g').minutes.typical).toBeLessThanOrEqual(5);
  });
  it('there is still no airside passenger transport, and no service hours to apply', () => {
    expect(m.lines).toEqual([]);
    expect(m.rules.find((r) => r.id === 'r:ams-single-terminal')!.text).toMatch(/No inter-terminal train, people mover or pier-to-pier bus/);
  });
  it('very short connection: Lounge 1 → C is a 2-minute walk with no control', () => {
    const r = findRoute(m, 'ams-l1', 'ams-c')!;
    expect(r.controls).toEqual([]);
    expect(r.total.typical).toBeLessThanOrEqual(3);
  });
  it('very long connection: M → H leaves through the Plaza, re-enters security and passport; movement and controls are separate', () => {
    const r = findRoute(m, 'ams-m', 'ams-h')!;
    expect(r.controls).toEqual(expect.arrayContaining(['security', 'passport']));
    expect(r.steps.some((s) => s.refId === 'w:ams-plaza-m')).toBe(true);
    expect(movement(r)).toBeLessThan(r.total.typical);
    expect(r.total.typical).toBeGreaterThanOrEqual(40);
  });
  it('G → B movement agrees with the uncut video (G9 → B17 ≈ 17.5 min incl. the passport filter without queue)', () => {
    const r = findRoute(m, 'ams-g', 'ams-b')!;
    expect(movement(r)).toBeGreaterThanOrEqual(15);
    expect(movement(r)).toBeLessThanOrEqual(21);
  });
  it('night: every pair routes at 03:00 and 23:30 (no filter hours published; see q:ams-night-filters)', () => {
    expect(m.walks.filter((w) => w.hours)).toEqual([]);
    expect(m.openQuestions.some((q) => q.id === 'q:ams-night-filters')).toBe(true);
    for (const time of ['03:00', '23:30']) expect(findRoute(m, 'ams-e', 'ams-c', { transfer: true, time })).toBeTruthy();
  });
  it('Middenbrug: planned on 17 Nov 2026, used from 18 Nov 2026', () => {
    const on17 = findRoute(m, 'ams-l1', 'ams-b', { transfer: true, date: '2026-11-17' })!;
    const on18 = findRoute(m, 'ams-l1', 'ams-b', { transfer: true, date: '2026-11-18' })!;
    expect(on17.steps.some((s) => s.refId === 'w:ams-l1-b-middenbrug')).toBe(false);
    expect(on18.steps.some((s) => s.refId === 'w:ams-l1-b-middenbrug')).toBe(true);
  });
  it('pier A stays out of routing until April 2027 (planned through 2027-03-31)', () => {
    expect(area('ams-a').status![0].until).toBe('2027-03-31');
    expect(m.walks.some((w) => w.from === 'ams-a' || w.to === 'ams-a')).toBe(false);
  });
  it('arriving at D lower to the Plaza uses the arrivals flow with entry passport; landside → D lower needs security and passport', () => {
    const arr = findRoute(m, 'ams-d-n', 'ams-plaza')!;
    expect(arr.steps.some((s) => s.refId === 'w:ams-d-n-arr-plaza')).toBe(true);
    expect(arr.borderCrossings).toBe(1);
    const dep = findRoute(m, 'ams-plaza', 'ams-d-n')!;
    expect(dep.controls).toEqual(expect.arrayContaining(['security', 'passport']));
  });
  it('border rule for transfers comes from the border authority (EES since April 2026)', () => {
    const r = m.rules.find((x) => x.id === 'r:ams-border-transfer')!;
    expect(r.sources).toContain('src:marechaussee-transit');
    expect(r.text).toMatch(/April 2026/);
  });
});

describe('AMS phase 3: transfer scenarios, rail and the Middenbrug (2026-11-01)', () => {
  const r = (a: string, b: string, p?: Parameters<typeof findRoute>[3]) => findRoute(m, a, b, p)!;
  const ids = (x: ReturnType<typeof r>) => x.steps.map((s) => s.refId);
  it('non-Schengen -> non-Schengen stays in the transit zone: no passport; the transfer filter is a conditional control', () => {
    for (const [a, b] of [['ams-g', 'ams-e'], ['ams-f', 'ams-d-n'], ['ams-e', 'ams-h']]) expect(r(a, b).controls).toEqual(['transfer-security']);
    const rule = m.rules.find((x) => x.id === 'r:ams-transfer-security')!;
    expect(rule.confidence).toBe('probable');
    expect(rule.text).toMatch(/conditional/);
  });
  it('Schengen <-> non-Schengen in both directions passes exactly one passport filter, never security', () => {
    // from a one-stop origin (an unknown origin at D-lower adds the unplaced transfer screening, AU-1)
    for (const [a, b] of [['ams-b', 'ams-g'], ['ams-d-n', 'ams-d-s'], ['ams-d-s', 'ams-e'], ['ams-c', 'ams-f']]) expect(r(a, b, { transfer: true, originAirport: 'JFK', originCountry: 'US' }).controls).toEqual(['passport']);
    expect(r('ams-g', 'ams-b').controls.filter((c) => c === 'passport')).toHaveLength(1);   // plus one screening since R-05
  });
  it('pier M is isolated: connections to and from M leave through the Plaza and re-enter through security', () => {
    expect(r('ams-b', 'ams-m').controls).toEqual(['security']);
    expect(r('ams-m', 'ams-b').controls).toEqual(['security']);
    expect(r('ams-m', 'ams-f').controls).toEqual(['security', 'passport']);
    expect(ids(r('ams-h', 'ams-m'))).toContain('w:ams-plaza-m');
  });
  it('pier H is reached from Lounge 3 (central security side), not from pier M', () => {
    expect(ids(r('ams-plaza', 'ams-h'))).toContain('w:ams-l3-h');
    expect(r('ams-plaza', 'ams-h').controls).toEqual(['security', 'passport']);
    expect(m.openQuestions.find((q) => q.id === 'q:ams-hm')!.question).toMatch(/cultureguru/);
  });
  it('rail station -> Schengen pier: security only; -> non-Schengen pier: security then exit passport', () => {
    expect(r('ams-station', 'ams-c').controls).toEqual(['security']);
    expect(r('ams-station', 'ams-g').controls).toEqual(['security', 'passport']);
  });
  it('arrival -> rail station: non-Schengen through the arrivals passport filter, Schengen without control', () => {
    expect(r('ams-g', 'ams-station').controls).toEqual(['passport', 'customs']);   // customs exit since the 2026-11-02 audit (AU-2)
    expect(r('ams-c', 'ams-station').controls).toEqual([]);
  });
  it('no invented night hours: every pair still routes at 03:00 (r:ams-night stays inferred)', () => {
    expect(r('ams-plaza', 'ams-g', { transfer: false, time: '03:00' })).toBeTruthy();
    expect(m.walks.every((w) => !w.hours)).toBe(true);
    expect(m.rules.find((x) => x.id === 'r:ams-night')!.confidence).toBe('inferred');
  });
  it('Middenbrug: not used on 2026-11-17, used from 2026-11-18 (year still inferred)', () => {
    expect(ids(r('ams-l1', 'ams-b', { transfer: true, date: '2026-11-17' }))).not.toContain('w:ams-l1-b-middenbrug');
    expect(ids(r('ams-l1', 'ams-b', { transfer: true, date: '2026-11-18' }))).toContain('w:ams-l1-b-middenbrug');
    expect(walk('w:ams-l1-b-middenbrug').confidence).toBe('inferred');
    if (EV) expect(ev.items.some((i) => i.id === 'ev:ams-middenbrug-nl-mid-november')).toBe(true);
  });
});

describe.skipIf(!EV)('AMS evidence', () => {
  it('evidence references only known sources and includes frame-read videos', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    expect(new Set(ev.items.filter((i) => i.method === 'video-frames').map((i) => i.source)).size).toBeGreaterThanOrEqual(6);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('AMS remediation data (contract v1 fields)', () => {
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

});

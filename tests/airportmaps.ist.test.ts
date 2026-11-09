// IST (Istanbul Airport) data model: gate lists, domestic/international zones, transfer flows and safety rules
// (data assertions, as of 2026-10-31).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/ist/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, Control, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findGate, findRoute } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('ist');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const allGates = m.gateGroups.flatMap((g) => g.gates);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;
const kinds = (cs?: Control[]) => (cs ?? []).map((c) => c.kind);
const walkIds = (from: string, to: string, p?: Parameters<typeof findRoute>[3]) =>
  findRoute(m, from, to, p)!.steps.filter((s) => s.kind === 'walk').map((s) => s.refId);

describe('IST model validity', () => {
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
    expect(mx.areas.map((a) => a.id).sort()).toEqual(['ist-intl-hub', 'ist-landside', 'ist-metro', 'ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f', 'ist-pier-g']);
  });
});

describe('IST layout and zones', () => {
  it('piers A, B, D, F are international, G is domestic; landside areas have no zone', () => {
    for (const id of ['ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f', 'ist-intl-hub', 'ist-arr-intl']) expect(area(id).zone).toBe('international');
    for (const id of ['ist-pier-g', 'ist-dom-hub', 'ist-arr-dom']) expect(area(id).zone).toBe('domestic');
    for (const id of ['ist-landside', 'ist-arr-hall', 'ist-metro']) expect(area(id).zone).toBe('n/a');
  });
  it('no Schengen zones are used', () => {
    expect(m.areas.filter((a) => a.zone === 'schengen' || a.zone === 'non-schengen')).toEqual([]);
  });
  it('the departures hall and the arrivals/transfer level are stacked on one footprint', () => {
    expect(area('ist-intl-hub').stack).toMatchObject({ group: 'ist-centre', order: 1 });
    expect(area('ist-arr-intl').stack).toMatchObject({ group: 'ist-centre', order: 0 });
  });
  it('there is no people mover or routed transport line: only the on-demand buggy, drawn but never routed', () => {
    expect(m.lines.map((l) => l.id).sort()).toEqual(['l:ist-buggy-a', 'l:ist-buggy-b', 'l:ist-buggy-d', 'l:ist-buggy-f', 'l:ist-buggy-g']);
    for (const l of m.lines) {
      expect(l.mode).toBe('other');
      expect(l.notRouted).toMatch(/paid/);
    }
    expect(m.rules.find((r) => r.id === 'r:ist-buggy')!.text).toContain('18.75 EUR');
  });
});

describe('IST gates per area', () => {
  it('each pier holds only its own letter (F1/F3 excepted on the domestic side)', () => {
    for (const [id, letter] of [['ist-pier-a', 'A'], ['ist-pier-b', 'B'], ['ist-pier-d', 'D'], ['ist-pier-f', 'F']] as const) {
      expect(gatesOf(id).every((g) => g.startsWith(letter))).toBe(true);
    }
    expect(gatesOf('ist-pier-g').filter((g) => !g.startsWith('G'))).toEqual(['F1', 'F3']);
  });
  it('C and E gates open off the central departures hall', () => {
    expect(gatesOf('ist-intl-hub')).toEqual(['C1', 'C2', 'C3', 'C4', 'E1', 'E2', 'E3', 'E4']);
  });
  it('key gate lookups', () => {
    expect(findGate(m, 'a11')!.area.id).toBe('ist-pier-a');
    expect(findGate(m, 'B6b')!.area.id).toBe('ist-pier-b');
    expect(findGate(m, 'D17')!.area.id).toBe('ist-pier-d');
    expect(findGate(m, 'F17')!.area.id).toBe('ist-pier-f');
    expect(findGate(m, 'G11A')!.area.id).toBe('ist-pier-g');
    const f1 = findGate(m, 'F1')!;
    expect(f1.area.id).toBe('ist-pier-g');
    expect(f1.group.zone).toBe('domestic');
  });
  it('D1–D17 complete; unattested numbers are not filled in', () => {
    expect(m.gateGroups.find((g) => g.id === 'ist-gates-d')!.gates).toEqual(Array.from({ length: 17 }, (_, i) => `D${i + 1}`));
    for (const g of ['A4', 'A12', 'B11', 'F10', 'F11', 'D18']) expect(allGates).not.toContain(g);
  });
  it('only G3 is marked as a bus gate', () => {
    expect(m.gateGroups.filter((g) => g.bus).flatMap((g) => g.gates)).toEqual(['G3']);
  });
  it('no gate is listed twice and the total is stable', () => {
    expect(new Set(allGates).size).toBe(allGates.length);
    expect(allGates.length).toBe(118);
  });
});

describe('IST controls (safety)', () => {
  it('every walk between domestic and international passes passport control', () => {
    for (const w of m.walks) {
      const z = [area(w.from).zone, area(w.to).zone];
      if (z.includes('domestic') && z.includes('international')) expect(kinds(w.controls)).toContain('passport');
    }
    for (const id of ['w:ist-arr-intl-dom', 'w:ist-arr-dom-intl']) expect(walk(id).bidirectional).toBe(false);
  });
  it('entering airside from the public side always passes security', () => {
    for (const w of m.walks) {
      const a = area(w.from), b = area(w.to);
      if (a.side === 'landside' && b.side === 'airside') expect(kinds(w.controls)).toEqual(expect.arrayContaining([expect.stringMatching(/security/)]));
      if (w.bidirectional && b.side === 'landside' && a.side === 'airside') expect(kinds(w.reverseControls ?? w.controls)).toEqual(expect.arrayContaining([expect.stringMatching(/security/)]));
    }
  });
  it('international departures pass passport control and security; the international transfer only security', () => {
    expect(kinds(walk('w:ist-hall-intl').controls)).toEqual(['passport', 'security']);
    expect(kinds(walk('w:ist-arr-intl-hub').controls)).toEqual(['transfer-security']);
    expect(walk('w:ist-arr-intl-hub').access).toBe('transfer');
  });
  it('arrivals flows are one-way and lead to the arrivals levels', () => {
    const flows = m.walks.filter((w) => w.flow === 'arrivals');
    expect(flows.map((w) => w.id).sort()).toEqual(['w:ist-a-arr', 'w:ist-b-arr', 'w:ist-ce-arr', 'w:ist-d-arr', 'w:ist-f-arr', 'w:ist-g-arr']);
    for (const w of flows) {
      expect(w.bidirectional).toBe(false);
      expect(['ist-arr-intl', 'ist-arr-dom']).toContain(w.to);
    }
  });
});

describe('IST routes', () => {
  it('international arrival at A connecting to domestic G: domestic transfer with one passport crossing', () => {
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-g')!;
    expect(walkIds('ist-pier-a', 'ist-pier-g')).toEqual(['w:ist-a-arr', 'w:ist-arr-intl-dom', 'w:ist-dom-g']);
    expect(r.borderCrossings).toBe(1);
    expect(r.controls).toEqual(expect.arrayContaining(['passport', 'transfer-security']));
  });
  it('domestic arrival at G connecting to F: international transfer via passport control', () => {
    const r = findRoute(m, 'ist-pier-g', 'ist-pier-f')!;
    expect(walkIds('ist-pier-g', 'ist-pier-f')).toEqual(['w:ist-g-arr', 'w:ist-arr-dom-intl', 'w:ist-intl-f']);
    expect(r.borderCrossings).toBe(1);
  });
  it('arriving international connection from the transfer point to F: transfer security, no passport', () => {
    const r = findRoute(m, 'ist-arr-intl', 'ist-pier-f')!;
    expect(r.controls).toEqual(['transfer-security']);
    expect(r.borderCrossings).toBe(0);
  });
  it('international piers, pier G and (remediation R-35) the central hub (gates C/E) are arrivals-segregated', () => {
    const seg = m.areas.filter((a) => a.arrivals === 'segregated').map((a) => a.id).sort();
    expect(seg).toEqual(['ist-intl-hub', 'ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f', 'ist-pier-g']);
  });
  it('R-35: a C/E gate arrival connecting at any pier, or at C/E again, passes the central transfer security', () => {
    for (const b of ['ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f', 'ist-intl-hub']) {
      const r = findRoute(m, 'ist-intl-hub', b)!;
      expect(r.controls).toEqual(['transfer-security']);
      expect(r.steps.find((s) => s.kind === 'walk')!.refId).toBe('w:ist-ce-arr');
    }
    expect(findRoute(m, 'ist-intl-hub', 'ist-intl-hub')!.total.typical).toBeGreaterThan(5);
  });
  it('arriving at A, connecting at F: arrivals flow, transfer security, then the walk out to F (30–45 min)', () => {
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-f')!;
    expect(walkIds('ist-pier-a', 'ist-pier-f')).toEqual(['w:ist-a-arr', 'w:ist-arr-intl-hub', 'w:ist-intl-f']);
    expect(r.controls).toEqual(['transfer-security']);
    expect(r.borderCrossings).toBe(0);
    expect(r.total.typical).toBeGreaterThanOrEqual(30);
    expect(r.total.typical).toBeLessThanOrEqual(45);
  });
  it('every international pier → pier connection from an arriving flight passes transfer security and stays airside', () => {
    const piers = ['ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f'];
    for (const a of piers) for (const b of piers) if (a !== b) {
      const r = findRoute(m, a, b)!;
      expect(r.controls).toEqual(['transfer-security']);
      expect(r.steps.some((s) => s.kind === 'walk' && area(s.to!)?.side === 'landside')).toBe(false);
    }
  });
  it('gate change A → F (already at the gate, fromArrival:false) uses the departure-level walk without controls', () => {
    const p = { transfer: true, fromArrival: false };
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-f', p)!;
    expect(walkIds('ist-pier-a', 'ist-pier-f', p)).toEqual(['w:ist-intl-a', 'w:ist-intl-f']);
    expect(r.controls).toEqual([]);
    expect(r.total.typical).toBeGreaterThanOrEqual(15);
  });
  it('metro to pier D: entrance screening, passport control and security', () => {
    const r = findRoute(m, 'ist-metro', 'ist-pier-d')!;
    expect(r.controls).toEqual(['security', 'passport', 'security']);
  });
  it('without the arrivals flow a pier cannot reach the landside (no reverse departure walk)', () => {
    expect(findRoute(m, 'ist-pier-d', 'ist-landside', { transfer: true, fromArrival: false })).toBeNull();
  });
});

describe('IST phase 2: transport, times and night (2026-10-31)', () => {
  const piers = ['ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f'];
  it('no route ever uses the buggy, at any time, for any profile', () => {
    const areas = m.areas.filter((a) => a.matrix).map((a) => a.id);
    for (const time of [undefined, '10:00', '03:00']) for (const transfer of [true, false]) for (const a of areas) for (const b of areas) if (a !== b) {
      const r = findRoute(m, a, b, { transfer, time });
      expect(r?.lines ?? []).toEqual([]);
    }
  });
  it('international → international: exactly one security (central transfer checkpoint), no passport, 24 h', () => {
    for (const time of ['10:00', '23:30', '03:00']) for (const a of piers) for (const b of piers) if (a !== b) {
      const r = findRoute(m, a, b, { transfer: true, time })!;
      expect(r.controls).toEqual(['transfer-security']);
      expect(r.borderCrossings).toBe(0);
      expect(r.steps.filter((s) => s.kind === 'walk').map((s) => s.refId)).toContain('w:ist-arr-intl-hub');
    }
    expect(walk('w:ist-arr-intl-hub').hours).toBeUndefined();
  });
  it('the double security from the landside is real (entrance screening + second security), not double counting', () => {
    for (const p of [...piers, 'ist-intl-hub']) expect(findRoute(m, 'ist-metro', p)!.controls).toEqual(['security', 'passport', 'security']);
    expect(findRoute(m, 'ist-metro', 'ist-pier-g')!.controls).toEqual(['security', 'security']);
    expect(m.rules.find((r) => r.id === 'r:ist-transfer-checkpoints')!.confidence).toBe('verified');
    // the two screenings sit on different connections (entrance walk, departure walk)
    expect(kinds(walk('w:ist-metro-hall').controls)).toEqual(['security']);
    expect(kinds(walk('w:ist-hall-intl').controls)).toEqual(['passport', 'security']);
  });
  it('movement and control time are separate; the very long cross-zone connection stays below an hour of movement', () => {
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-g')!;
    expect(r.controls).toEqual(['passport', 'transfer-security']);
    expect(r.movement.typical).toBeGreaterThanOrEqual(15);
    expect(r.movement.typical).toBeLessThanOrEqual(35);
    expect(r.controlTime.typical).toBeGreaterThan(0);
    expect(r.total.typical).toBeCloseTo(r.movement.typical + r.controlTime.typical, 5);
  });
  it('short connection: arriving via the transfer point to the C/E gates', () => {
    const r = findRoute(m, 'ist-arr-intl', 'ist-intl-hub')!;
    expect(r.movement.typical).toBeLessThanOrEqual(6);
    expect(r.controls).toEqual(['transfer-security']);
  });
  it('the metro station follows the M11 hours: open at 23:30, closed at 03:00', () => {
    expect(walk('w:ist-metro-hall').hours).toEqual([{ from: '05:30', until: '01:15' }]);
    expect(walk('w:ist-arrhall-metro').hours).toEqual([{ from: '05:30', until: '24:00' }]);
    expect(findRoute(m, 'ist-metro', 'ist-pier-b', { transfer: true, time: '23:30' })).not.toBeNull();
    expect(findRoute(m, 'ist-metro', 'ist-pier-b', { transfer: true, time: '03:00' })).toBeNull();
    expect(findRoute(m, 'ist-pier-f', 'ist-metro', { transfer: true, time: '03:00' })).toBeNull();
    // the airside network itself has no night closure
    expect(findRoute(m, 'ist-landside', 'ist-pier-f', { transfer: true, time: '03:00' })).not.toBeNull();
  });
  it('a transfer-only flow is never used for a landside destination', () => {
    const r = findRoute(m, 'ist-pier-d', 'ist-landside', { transfer: false })!;
    expect(r.steps.some((s) => s.refId === 'w:ist-arr-intl-hub' || s.refId === 'w:ist-arr-intl-dom')).toBe(false);
    expect(r.controls).toEqual(expect.arrayContaining(['passport', 'customs']));
  });
  it('time bases: only the two domestic transfer/exit walks remain assumed', () => {
    expect(m.walks.filter((w) => w.minutes.basis === 'assumed').map((w) => w.id).sort()).toEqual(['w:ist-arr-dom-dom', 'w:ist-arr-dom-exit']);
    for (const w of m.walks.filter((x) => x.minutes.basis === 'derived')) expect(w.minutes.min).toBeLessThan(w.minutes.max);
  });
  it('buggy lines: stops are at the official desks, rides are assumed ranges, eligibility is explicit', () => {
    expect(m.stops.find((s) => s.id === 's:ist-buggy-ce')!.name).toContain('C1');
    for (const l of m.lines) {
      expect(l.ride![0].basis).toBe('assumed');
      expect(l.eligibility).toMatch(/65\+/);
      expect(l.service[0].windows).toEqual([{ from: '00:00', until: '24:00' }]);
    }
  });
});

describe('IST phase 3: transfer scenarios, baggage and customs (2026-11-01)', () => {
  const rule = (id: string) => m.rules.find((r) => r.id === id)!;
  it('international → domestic, bags through-checked: passport at IST, no customs or baggage claim, purple route', () => {
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-g', { transfer: true })!;
    expect(r.controls).toEqual(['passport', 'transfer-security']);
    expect(r.steps.some((s) => s.refId === 'w:ist-arr-intl-dom')).toBe(true);
    expect(r.controls).not.toContain('customs');
  });
  it('international → domestic, bags collected at IST (separate tickets / non-customs airport): passport, customs, landside, domestic security', () => {
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-g', { transfer: false })!;
    expect(r.controls).toEqual(['passport', 'customs', 'security']);
    expect(walkIds('ist-pier-a', 'ist-pier-g', { transfer: false })).toEqual(expect.arrayContaining(['w:ist-arr-intl-exit', 'w:ist-hall-dom']));
    expect(r.steps.some((s) => s.refId === 'w:ist-arr-intl-dom')).toBe(false);
  });
  it('the baggage/customs rule is recorded with the airline and official sources and stays probable', () => {
    const r = rule('r:ist-intl-dom-baggage');
    expect(r.confidence).toBe('probable');
    expect(r.sources).toEqual(expect.arrayContaining(['src:ist-official-transfer-guide', 'src:tk-transfer-transit-excerpt', 'src:ana-ist-excerpt']));
    expect(r.text).toMatch(/customs airport/);
  });
  it('domestic → international from an arriving flight: passport then transfer security, never customs', () => {
    const r = findRoute(m, 'ist-pier-g', 'ist-pier-f', { transfer: true })!;
    expect(r.controls).toEqual(['passport', 'transfer-security']);
  });
  it('international self-transfer to an international gate leaves through passport/customs and re-enters (two passports)', () => {
    const r = findRoute(m, 'ist-pier-a', 'ist-pier-f', { transfer: false })!;
    expect(r.controls.filter((c) => c === 'passport').length).toBe(2);
    expect(r.controls).toContain('customs');
  });
  it('international arrival → metro passes passport and customs; at 03:00 it is unroutable (no train)', () => {
    expect(findRoute(m, 'ist-pier-d', 'ist-metro')!.controls).toEqual(['passport', 'customs']);
    expect(findRoute(m, 'ist-pier-d', 'ist-metro', { transfer: false, time: '03:00' })).toBeNull();
    expect(findRoute(m, 'ist-pier-g', 'ist-metro')!.controls).toEqual([]);
  });
  it('the short-connection (orange) route is still not routed: no walk bypasses the central transfer security', () => {
    for (const p of ['ist-pier-a', 'ist-pier-b', 'ist-pier-d', 'ist-pier-f']) {
      const r = findRoute(m, p, p === 'ist-pier-f' ? 'ist-pier-a' : 'ist-pier-f', { transfer: true })!;
      expect(r.steps.some((s) => s.refId === 'w:ist-arr-intl-hub')).toBe(true);
    }
    expect(m.openQuestions.some((q) => q.id === 'q:ist-short-connection')).toBe(true);
  });
});

describe.skipIf(!EV)('IST evidence', () => {
  it('evidence references only known sources and covers videos', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source)).toBe(true);
    if (EV) expect(ev.items.filter((i) => i.method === 'video-frames').length).toBeGreaterThanOrEqual(8);
  });
  it('verified items rest on at least two independence groups', () => {
    const grp = new Map(m.sources.map((s) => [s.id, s.group]));
    const all = [...m.areas, ...m.gateGroups, ...m.walks, ...m.rules];
    for (const o of all.filter((x) => x.confidence === 'verified')) expect(new Set(o.sources.map((s) => grp.get(s))).size).toBeGreaterThanOrEqual(2);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('IST remediation data (contract v1 fields)', () => {
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
  it('IST: no one-stop list (Türkiye re-screens every international transfer) and no feed terminal table (the feed sends none)', () => {
    expect(mm.oneStopSecurity).toBeUndefined();
    expect(mm.feedTerminals).toBeUndefined();
  });
});

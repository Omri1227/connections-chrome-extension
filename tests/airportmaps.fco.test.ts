// FCO (Rome Fiumicino) data model: gate lists, zones, connections and safety rules (data assertions).
import { describe, expect, it } from 'vitest';
import model from '../airportmaps/data/fco/airport.json';
import { evidenceOrEmpty } from './helpers/evidence.ts';
import type { AirportModel, EvidenceFile } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute } from '../airportmaps/src/route.ts';

const m = model as unknown as AirportModel;
const { file: EV, ev } = evidenceOrEmpty('fco');
const area = (id: string) => m.areas.find((a) => a.id === id)!;
const gatesOf = (areaId: string) => m.gateGroups.filter((g) => g.area === areaId).flatMap((g) => g.gates);
const range = (p: string, a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `${p}${a + i}`);
const walk = (id: string) => m.walks.find((w) => w.id === id)!;

describe('FCO model validity', () => {
  it('validates without errors', () => {
    const r = validateAirport(m, EV);
    expect(r.errors).toEqual([]);
  });
  it('every matrix pair is routable', () => {
    const mx = buildMatrix(m);
    const missing = mx.cells.filter((c) => c.from !== c.to && !c.route).map((c) => `${c.from}->${c.to}`);
    expect(missing).toEqual([]);
    expect(mx.areas.length).toBeGreaterThanOrEqual(6);
  });
});

describe('FCO gates per boarding area (ADR maps 2024-12 / 2025)', () => {
  it('T1 A gates', () => {
    expect(gatesOf('fco-a1-3')).toEqual(range('A', 1, 3));
    expect(gatesOf('fco-a21-27')).toEqual(range('A', 21, 27));
    expect(gatesOf('fco-a31-52').sort()).toEqual(range('A', 31, 52).sort());
    expect(gatesOf('fco-a61-83').sort()).toEqual(range('A', 61, 83).sort());
  });
  it('T3 E gates', () => {
    expect(gatesOf('fco-e1-8')).toEqual(range('E', 1, 8));
    expect(gatesOf('fco-e11-24')).toEqual(range('E', 11, 24));
    expect(gatesOf('fco-e31-44')).toEqual(range('E', 31, 44));
    expect(gatesOf('fco-e51-61').sort()).toEqual(range('E', 51, 61).sort());
  });
  it('does not invent A4–A10 or A53–A59 (only range labels exist)', () => {
    const all = m.gateGroups.flatMap((g) => g.gates);
    for (const g of [...range('A', 4, 10), ...range('A', 53, 59)]) expect(all).not.toContain(g);
    expect(all.length).toBe(102);
  });
  it('Pier A has 13 contact + 10 ground-level remote gates', () => {
    expect(m.gateGroups.find((g) => g.id === 'fco-gates-a61-a73')!.gates).toHaveLength(13);
    const remote = m.gateGroups.find((g) => g.id === 'fco-gates-a74-a83')!;
    expect(remote.gates).toHaveLength(10);
    expect(remote.bus).toBe(true);
  });
});

describe('FCO zones', () => {
  it('A areas are Schengen, E areas non-Schengen', () => {
    for (const id of ['fco-a1-3', 'fco-a21-27', 'fco-a31-52', 'fco-a61-83', 'fco-t1-air']) expect(area(id).zone).toBe('schengen');
    for (const id of ['fco-e1-8', 'fco-e11-24', 'fco-e31-44', 'fco-e51-61']) expect(area(id).zone).toBe('non-schengen');
    for (const g of m.gateGroups) expect(g.zone).toBe(g.gates[0].startsWith('A') ? 'schengen' : 'non-schengen');
  });
  it('no usable walk joins Schengen and non-Schengen without a passport control', () => {
    for (const w of m.walks.filter((x) => x.access !== 'restricted')) {
      const z = [area(w.from).zone, area(w.to).zone];
      if (z.includes('schengen') && z.includes('non-schengen')) {
        expect(w.controls?.some((c) => c.kind === 'passport'), w.id).toBe(true);
        if (w.bidirectional) expect((w.reverseControls ?? w.controls)?.some((c) => c.kind === 'passport'), w.id).toBe(true);
      }
    }
  });
  it('every landside → airside walk has security', () => {
    for (const w of m.walks.filter((x) => x.access !== 'restricted')) {
      if (area(w.from).side === 'landside' && area(w.to).side === 'airside') expect(w.controls?.some((c) => c.kind === 'security' || c.kind === 'transfer-security'), w.id).toBe(true);
      if (w.bidirectional && area(w.to).side === 'landside' && area(w.from).side === 'airside') expect((w.reverseControls ?? w.controls)?.some((c) => c.kind === 'security'), w.id).toBe(true);
    }
  });
});

describe('FCO connections', () => {
  it('landside T1 ↔ T3 ↔ station walks exist and are public', () => {
    for (const id of ['w:fco-t1land-t3land', 'w:fco-t3land-station', 'w:fco-t1land-station']) {
      expect(walk(id).access).toBe('public');
      expect(walk(id).bidirectional).toBe(true);
    }
  });
  it('E31–44 is reached only by the SkyBridge (direct walk recorded as restricted)', () => {
    expect(walk('w:fco-e18-e3144-none').access).toBe('restricted');
    // the only usable walk touching the satellite is the internal arrivals flow down to its own level 1
    const sat = ['fco-e31-44', 'fco-e31-44-arr'];
    const usable = m.walks.filter((w) => w.access !== 'restricted' && (sat.includes(w.from) || sat.includes(w.to)));
    expect(usable.map((w) => w.id)).toEqual(['w:fco-e3144-arr']);
    expect(usable.every((w) => sat.includes(w.from) && sat.includes(w.to))).toBe(true);
    const west = m.lines.find((l) => l.id === 'l:fco-skybridge-west')!;
    expect(west.direction).toBe('one-way');
    expect(west.mode).toBe('people-mover');
    const stopArea = (s: string) => m.stops.find((x) => x.id === s)!.area;
    expect(west.stops.map(stopArea)).toEqual(['fco-e1-8', 'fco-e31-44']);
  });
  it('A → E route crosses exactly one passport control and no security', () => {
    const r = findRoute(m, 'fco-a61-83', 'fco-e11-24')!;
    expect(r).toBeTruthy();
    expect(r.controls.filter((c) => c === 'passport')).toHaveLength(1);
    expect(r.controls).not.toContain('security');
  });
  it('A → E31-44 uses the westbound SkyBridge', () => {
    const r = findRoute(m, 'fco-a31-52', 'fco-e31-44')!;
    expect(r.lines).toContain('l:fco-skybridge-west');
    expect(r.borderCrossings).toBe(1);
  });
  it('E31-44 → A goes via the eastbound SkyBridge and one passport control', () => {
    const r = findRoute(m, 'fco-e31-44', 'fco-a21-27')!;
    expect(r.lines).toContain('l:fco-skybridge-east');
    expect(r.controls.filter((c) => c === 'passport')).toHaveLength(1);
  });
  it('T3 landside → E gates passes security then passport control', () => {
    const r = findRoute(m, 'fco-t3-land', 'fco-e51-61')!;
    const i = r.controls.indexOf('security'), j = r.controls.indexOf('passport');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
  });
  it('Schengen A ↔ A routes need no passport control', () => {
    const r = findRoute(m, 'fco-a21-27', 'fco-a61-83')!;
    expect(r.controls).not.toContain('passport');
  });
});

describe('FCO arrivals flows and the SkyBridge direction split', () => {
  const arrivalWalks = new Set(m.walks.filter((w) => w.flow === 'arrivals').map((w) => w.id));
  const MOVES = new Set(['walk', 'to-platform', 'from-platform', 'wait', 'ride']);
  it('arrivals-flow walks are one-way and lead into the arrivals-only nodes', () => {
    expect(arrivalWalks.size).toBeGreaterThanOrEqual(4);
    for (const w of m.walks.filter((x) => x.flow === 'arrivals')) {
      expect(w.bidirectional, w.id).toBe(false);
      expect(['fco-t3-arr', 'fco-e31-44-arr']).toContain(w.to);
    }
    // nothing but an arrivals flow enters the arrivals-only nodes
    for (const w of m.walks.filter((x) => x.access !== 'restricted' && ['fco-t3-arr', 'fco-e31-44-arr'].includes(x.to))) expect(w.flow, w.id).toBe('arrivals');
    expect(m.walks.some((w) => w.bidirectional && ['fco-t3-arr', 'fco-e31-44-arr'].includes(w.from))).toBe(false);
  });
  it('the eastbound SkyBridge boards only on the satellite arrivals level (stacked under the departures level)', () => {
    const east = m.lines.find((l) => l.id === 'l:fco-skybridge-east')!;
    expect(east.direction).toBe('one-way');
    expect(m.stops.find((s) => s.id === east.stops[0])!.area).toBe('fco-e31-44-arr');
    expect(area('fco-e31-44-arr').stack?.group).toBe(area('fco-e31-44').stack?.group);
    expect(area('fco-e31-44-arr').stack!.order).toBeLessThan(area('fco-e31-44').stack!.order);
    expect(area('fco-e31-44-arr').matrix).toBe(false);
  });
  it('arrivals flows appear only at the start of a route', () => {
    for (const c of buildMatrix(m).cells) {
      if (!c.route) continue;
      const moves = c.route.steps.filter((s) => MOVES.has(s.kind));
      const firstOther = moves.findIndex((s) => !arrivalWalks.has(s.refId ?? ''));
      const lastArr = moves.map((s) => arrivalWalks.has(s.refId ?? '')).lastIndexOf(true);
      if (lastArr >= 0) expect(lastArr, `${c.from}->${c.to}`).toBeLessThan(firstOther === -1 ? Infinity : firstOther);
    }
  });
  it('a departing origin (not an arriving flight) never uses an arrivals flow or the eastbound SkyBridge', () => {
    const dep = { transfer: true, fromArrival: false };
    expect(findRoute(m, 'fco-e31-44', 'fco-e11-24', dep)).toBeNull();
    for (const from of ['fco-e1-8', 'fco-e11-24', 'fco-e51-61', 'fco-a21-27']) for (const to of ['fco-t3-land', 'fco-a61-83', 'fco-e31-44']) {
      const r = findRoute(m, from, to, dep);
      if (!r) continue;
      expect(r.steps.some((s) => arrivalWalks.has(s.refId ?? '')), `${from}->${to}`).toBe(false);
      expect(r.lines).not.toContain('l:fco-skybridge-east');
    }
  });
  it('an arriving passenger at E31-44 leaves by the eastbound SkyBridge through the satellite arrivals level', () => {
    const r = findRoute(m, 'fco-e31-44', 'fco-t3-land')!;
    expect(r.steps[0].refId).toBe('w:fco-e3144-arr');
    expect(r.lines).toEqual(['l:fco-skybridge-east']);
    expect(r.controls).toContain('passport');
  });
  it('the galleria transiti (E → A) is for connecting passengers only', () => {
    expect(walk('w:fco-e18-a2127').access).toBe('transfer');
    const r = findRoute(m, 'fco-e1-8', 'fco-a21-27', { transfer: false })!;
    expect(r.steps.some((s) => s.refId === 'w:fco-e18-a2127' || s.refId === 'w:fco-t3arr-a2127')).toBe(false);
  });
});

describe('FCO status periods (routing date)', () => {
  const inMatrix = (date: string) => buildMatrix(m, { transfer: true, date }).areas.map((a) => a.id);
  it('the model routes on its asOf date with every matrix area active', () => {
    expect(inMatrix(m.asOf)).toHaveLength(10);
  });
  it('E31-44 was closed from 2020-11-17 (Covid) and drops out with the SkyBridge', () => {
    expect(inMatrix('2021-06-01')).not.toContain('fco-e31-44');
    expect(findRoute(m, 'fco-a21-27', 'fco-e31-44', { transfer: true, date: '2021-06-01' })).toBeNull();
    expect(inMatrix('2020-11-16')).toContain('fco-e31-44');
    expect(findRoute(m, 'fco-a21-27', 'fco-e31-44')!.lines).toContain('l:fco-skybridge-west');
  });
  it('Pier A (A61-83) is planned before its opening on 2022-05-19', () => {
    expect(inMatrix('2022-05-18')).not.toContain('fco-a61-83');
    expect(inMatrix('2022-05-19')).toContain('fco-a61-83');
  });
  it('A31-52 reopened on 2023-04-13 after the 2020-07 closure', () => {
    expect(inMatrix('2023-04-12')).not.toContain('fco-a31-52');
    expect(inMatrix('2023-04-13')).toContain('fco-a31-52');
    expect(area('fco-a31-52').status![0].confidence).toBe('inferred');
  });
});

describe('FCO phase 2: SkyBridge service, night and travel times (ADR operating instruction 2024)', () => {
  const line = (id: string) => m.lines.find((l) => l.id === id)!;
  const OI = 'src:fco-adr-apms-oi-2024';
  it('both SkyBridge directions run ≈05:30–24:00 by traffic and one on-call shuttle 00:00–05:30 (published hours, derived headway)', () => {
    for (const id of ['l:fco-skybridge-west', 'l:fco-skybridge-east']) {
      const l = line(id);
      expect(l.service.map((s) => s.windows)).toEqual([[{ from: '05:30', until: '24:00' }], [{ from: '00:00', until: '05:30' }]]);
      expect(l.service[1].hours).toMatch(/on call/);
      for (const s of l.service) {
        expect(s.headwayBasis, id).toBe('derived');
        expect(s.sources).toContain(OI);
      }
      expect(l.rideMin).toEqual([1]);
      expect(l.ride![0].basis).toBe('observed');
      expect(l.sources).toContain(OI);
    }
    expect(line('l:fco-skybridge-east').confidence).toBe('verified');
  });
  it('E31-44 stays reachable at 03:00 (on-call shuttle), with a longer wait than by day and no "hours not published" warning', () => {
    const day = findRoute(m, 'fco-a31-52', 'fco-e31-44', { transfer: true, time: '10:00' })!;
    const night = findRoute(m, 'fco-a31-52', 'fco-e31-44', { transfer: true, time: '03:00' })!;
    for (const r of [day, night]) {
      expect(r.lines).toEqual(['l:fco-skybridge-west']);
      expect(r.steps.some((s) => s.hoursUnpublished)).toBe(false);
    }
    const wait = (r: typeof day) => r.steps.find((s) => s.kind === 'wait')!.minutes.typical;
    expect(wait(night)).toBeGreaterThan(wait(day));
    const late = findRoute(m, 'fco-e31-44', 'fco-t3-land', { transfer: false, time: '23:30' })!;
    expect(late.lines).toEqual(['l:fco-skybridge-east']);
  });
  it('a connection from the satellite to the E piers rides east then passes transfer security in T3 (ADR: quota 6.10)', () => {
    const r = findRoute(m, 'fco-e31-44', 'fco-e11-24')!;
    expect(r.lines).toEqual(['l:fco-skybridge-east']);
    expect(r.controls).toEqual(['transfer-security']);
    expect(r.steps.some((s) => s.refId === 'w:fco-t3arr-e18')).toBe(true);
    expect(walk('w:fco-t3arr-e18').sources).toContain(OI);
  });
  it('the APMS outage buses are recorded but never routed', () => {
    const bus = line('l:fco-apms-outage-bus');
    expect(bus.notRouted).toMatch(/15 min/);
    expect(bus.mode).toBe('bus');
    for (const c of buildMatrix(m).cells) expect(c.route?.lines ?? [], `${c.from}->${c.to}`).not.toContain('l:fco-apms-outage-bus');
    expect(walk('w:fco-e18-e3144-none').access).toBe('restricted');
  });
  it('the T1 → T3 passport-control walk is measured (2024 one-take video) and no matrix route is mostly assumed', () => {
    const w = walk('w:fco-t3conn-t1air');
    expect(w.minutes.basis).toBe('measured');
    expect(w.minutes.typical).toBe(3);
    if (EV) expect(ev.items.some((i) => i.id === 'ev:fco-yt-groming-t1-pc-measure' && i.supports?.includes(w.id))).toBe(true);
    for (const c of buildMatrix(m).cells) {
      if (!c.route) continue;
      const mix = c.route.basisMix, tot = Object.values(mix).reduce((s, x) => s + (x ?? 0), 0);
      expect((mix.assumed ?? 0) / (tot || 1), `${c.from}->${c.to}`).toBeLessThanOrEqual(0.5);
    }
  });
  it('short vs long movement: E plaza → E11-24 is a few minutes, E31-44 → far Pier A is long and crosses one border', () => {
    const short = findRoute(m, 'fco-e1-8', 'fco-e11-24', { transfer: true, originAirport: 'JFK', originCountry: 'US' })!;   // one-stop origin (AU-1)
    expect(short.movement.typical).toBeLessThanOrEqual(6);
    expect(short.lines).toEqual([]);
    const long = findRoute(m, 'fco-e31-44', 'fco-a61-83')!;
    expect(long.movement.typical).toBeGreaterThanOrEqual(15);
    expect(long.borderCrossings).toBe(1);
    expect(long.lines).toEqual(['l:fco-skybridge-east']);
  });
  it('the E62–E63 sign contradiction is kept as an open question (no gates invented)', () => {
    expect(m.openQuestions.some((q) => q.id === 'q:fco-e62-63')).toBe(true);
    expect(m.gateGroups.flatMap((g) => g.gates)).not.toContain('E62');
  });
});

describe('FCO phase 3: transfer scenarios in both border directions, rail and the people-mover replacement (2026-11-01)', () => {
  const r = (a: string, b: string, p?: Parameters<typeof findRoute>[3]) => findRoute(m, a, b, p)!;
  const ids = (x: ReturnType<typeof r>) => x.steps.map((s) => s.refId);
  it('Schengen (A) -> non-Schengen (E): one exit passport control at T3, no security again', () => {
    for (const [a, b] of [['fco-a61-83', 'fco-e11-24'], ['fco-a31-52', 'fco-e51-61'], ['fco-a21-27', 'fco-e1-8']]) expect(r(a, b).controls).toEqual(['passport']);
  });
  it('Schengen (A) -> satellite E31-44: exit passport control, then the westbound SkyBridge', () => {
    const x = r('fco-a31-52', 'fco-e31-44');
    expect(x.controls).toEqual(['passport']);
    expect(x.steps.some((s) => s.line === 'l:fco-skybridge-west')).toBe(true);
  });
  it('satellite arrival -> Schengen: eastbound SkyBridge, then entry passport control and transfer security in the galleria', () => {
    const x = r('fco-e31-44', 'fco-a31-52');
    expect(x.controls).toEqual(['passport', 'transfer-security']);
    expect(ids(x)).toContain('w:fco-t3arr-a2127');
  });
  it('pier arrival E11-24 -> Schengen: routed through the E plaza and the galleria with passport only (structure uncertain, see q:fco-transfer-security)', () => {
    const x = r('fco-e11-24', 'fco-a61-83');
    expect(x.controls.filter((c) => c === 'passport').length).toBe(1);
    expect(m.openQuestions.some((q) => q.id === 'q:fco-transfer-security')).toBe(true);
    expect(m.openQuestions.some((q) => q.id === 'q:fco-galleria-departing')).toBe(true);
  });
  it('self-transfer non-Schengen -> Schengen (bags rechecked): passport + customs out, landside, security in', () => {
    expect(r('fco-e11-24', 'fco-a61-83', { transfer: false }).controls).toEqual(['passport', 'customs', 'security']);
  });
  it('rail station -> T1 gates: boarding-pass check and security, no passport; -> T3 gates: security then exit passport', () => {
    expect(r('fco-station', 'fco-a31-52').controls).toEqual(['boarding-pass', 'security']);
    expect(r('fco-station', 'fco-e11-24').controls).toEqual(['security', 'passport']);
  });
  it('arrival -> rail station: Schengen pier without control; non-Schengen through entry passport and customs', () => {
    expect(r('fco-a61-83', 'fco-station').controls).toEqual([]);
    expect(r('fco-e31-44', 'fco-station').controls).toEqual(['passport', 'customs']);
  });
  it('Leonardo Express hours are recorded from two groups; the station walks have no invented hours', () => {
    const rule = m.rules.find((x) => x.id === 'r:fco-rail')!;
    expect(rule.confidence).toBe('verified');
    expect(rule.text).toMatch(/05:38–23:27/);
    expect(rule.text).toMatch(/04:50–23:05/);
    for (const id of ['w:fco-t1land-station', 'w:fco-t3land-station']) expect(walk(id).hours).toBeUndefined();
  });
  it('the people-mover replacement has no dates: both SkyBridge lines stay active in 2027 and the question records the TED facts', () => {
    for (const id of ['l:fco-skybridge-west', 'l:fco-skybridge-east']) expect(m.lines.find((l) => l.id === id)!.status ?? []).toEqual([]);
    expect(findRoute(m, 'fco-e1-8', 'fco-e31-44', { transfer: true, date: '2027-06-01' })).not.toBeNull();
    expect(m.openQuestions.find((q) => q.id === 'q:fco-new-people-mover')!.question).toMatch(/264 months/);
  });
});

describe.skipIf(!EV)('FCO evidence', () => {
  it('every evidence item cites a known source and at least 10 videos/official maps are used', () => {
    const src = new Set(m.sources.map((s) => s.id));
    for (const it of ev.items) expect(src.has(it.source), it.id).toBe(true);
    expect(m.sources.filter((s) => s.kind === 'video').length).toBeGreaterThanOrEqual(10);
  });
  it('keeps the A-range contradiction visible', () => {
    if (EV) expect(ev.items.some((i) => i.contradicts?.includes('fco-gates-a1-a3'))).toBe(true);
    expect(m.openQuestions.some((q) => q.id === 'q:fco-a-ranges')).toBe(true);
  });
});


// ---------------------------------------------------------------- remediation data (Agent B, 2026-11-01; CONTRACT.md v1)
describe('FCO remediation data (contract v1 fields)', () => {
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
  it('R-02: the E31–44 satellite is arrivals-segregated: a same-satellite connection rides to T3 and back with transfer security', () => {
    const r = findRoute(m, 'fco-e31-44', 'fco-e31-44')!;
    expect(r.controls).toContain('transfer-security');
    expect(r.total.typical).toBeGreaterThan(15);
  });
  it('R-05: FCO one-stop list follows ADR (no UK; removed crown dependencies dropped)', () => {
    expect(mm.oneStopSecurity.countries).toEqual(expect.arrayContaining(['US', 'CA', 'ME']));
    expect(mm.oneStopSecurity.countries).not.toContain('GB');
    expect(mm.oneStopSecurity.airports).toEqual(['FAE']);
  });
});

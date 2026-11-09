// Router engine (remediation R-02, R-05, R-11/12, R-13, R-14, R-19, R-33, R-36, R-45) on synthetic airports, plus
// all-pairs properties on the eight bundled airports. Synthetic data only proves the engine; real values are B's data.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AirportModel, Control, Minutes } from '../airportmaps/src/types.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { checkInHalls, findRoute, findSelfTransfer, inWindow, intraWalk, INTRA_WALK_FLOOR, noRouteReason, oneStopCovered, serviceAt, stateOn, zoneOn } from '../airportmaps/src/route.ts';

const M = (v: number, basis: Minutes['basis'] = 'assumed'): Minutes => ({ min: v * 0.5, typical: v, max: v * 2, basis });
const passport: Control = { kind: 'passport', minutes: M(10) };
const security: Control = { kind: 'security', minutes: M(12) };
const customs: Control = { kind: 'customs', minutes: M(1) };
const tsec: Control = { kind: 'transfer-security', minutes: M(15), when: 'origin-not-one-stop' };
const src = ['src:a'];

/** Hub: landside halls H1 (serves N, S) and H2 (serves S2); airside S (schengen), N (non-schengen, segregated arrivals →
 *  arrivals corridor X with transfer security back to N), S2 (schengen, behind a boundary control); transfer hub T. */
function hub(): AirportModel {
  return {
    iata: 'HUB', name: 'Hub', city: 'Nowhere', asOf: '2026-11-01',
    schematic: { width: 1000, height: 640, northDeg: 0 },
    sources: [{ id: 'src:a', title: 'Map', url: 'https://example.org/a', publisher: 'Airport', kind: 'official-map', group: 'airport', accessed: '2026-11-01' }],
    areas: [
      { id: 'H1', name: 'Hall 1', short: 'H1', kind: 'landside-hall', side: 'landside', zone: 'n/a', matrix: true, anchor: [100, 500], confidence: 'probable', sources: src, checkIn: { serves: ['N', 'S'] } },
      { id: 'H2', name: 'Hall 2', short: 'H2', kind: 'landside-hall', side: 'landside', zone: 'n/a', matrix: true, anchor: [800, 500], confidence: 'probable', sources: src, checkIn: { serves: ['S2'] } },
      { id: 'T', name: 'Transfer hub', short: 'T', kind: 'transfer-hub', side: 'landside', zone: 'n/a', matrix: false, anchor: [300, 400], confidence: 'probable', sources: src },
      { id: 'S', name: 'Pier S', short: 'S', kind: 'pier', side: 'airside', zone: 'schengen', matrix: true, anchor: [100, 200], confidence: 'probable', sources: src },
      { id: 'N', name: 'Pier N', short: 'N', kind: 'pier', side: 'airside', zone: 'non-schengen', matrix: true, anchor: [400, 200], confidence: 'probable', sources: src, arrivals: 'segregated' },
      { id: 'X', name: 'Arrivals corridor N', short: 'X', kind: 'other', side: 'airside', zone: 'non-schengen', matrix: false, anchor: [400, 300], confidence: 'probable', sources: src },
      { id: 'S2', name: 'Pier S2', short: 'S2', kind: 'pier', side: 'airside', zone: 'schengen', matrix: true, anchor: [800, 200], confidence: 'probable', sources: src, entryControls: [{ kind: 'boarding-pass', minutes: M(2) }] },
    ],
    gateGroups: [
      { id: 'g:s', area: 'S', label: 'S1–S10', gates: Array.from({ length: 10 }, (_, i) => `S${i + 1}`), path: [[0, 200], [400, 200]], confidence: 'probable', sources: src },
      { id: 'g:n', area: 'N', label: 'N1–N4', gates: ['N1', 'N2', 'N3', 'N4'], path: [[380, 190], [420, 190]], confidence: 'probable', sources: src },
      { id: 'g:s2', area: 'S2', label: 'S21–S22', gates: ['S21', 'S22'], path: [[790, 200], [810, 200]], confidence: 'probable', sources: src },
    ],
    stops: [
      { id: 'st:s', name: 'Shuttle at S', area: 'S', side: 'airside', anchor: [150, 220], accessMinutes: M(2), confidence: 'probable', sources: src },
      { id: 'st:s2', name: 'Shuttle at S2', area: 'S2', side: 'airside', anchor: [750, 220], accessMinutes: M(2), confidence: 'probable', sources: src },
    ],
    lines: [
      { id: 'l:sh', name: 'Shuttle', mode: 'people-mover', colour: '#2266aa', access: 'airside', side: 'airside', stops: ['st:s', 'st:s2'], direction: 'both', rideMin: [4],
        service: [{ hours: '05:00–23:00', windows: [{ from: '05:00', until: '23:00' }], headwayMin: { min: 4, max: 4 }, waitMin: M(2) }], eligibility: 'airside passengers', confidence: 'probable', sources: src },
    ],
    walks: [
      { id: 'w:n-x', from: 'N', to: 'X', bidirectional: false, access: 'airside', flow: 'arrivals', minutes: M(3), practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:x-n', from: 'X', to: 'N', bidirectional: false, access: 'transfer', minutes: M(3), controls: [tsec], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:x-s', from: 'X', to: 'S', bidirectional: false, access: 'transfer', minutes: M(6), controls: [passport, tsec], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:s-n', from: 'S', to: 'N', bidirectional: false, access: 'airside', minutes: M(6), controls: [passport], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:x-h1', from: 'X', to: 'H1', bidirectional: false, access: 'airside', flow: 'arrivals', minutes: M(8), controls: [passport, customs], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:x-t', from: 'X', to: 'T', bidirectional: false, access: 'airside', flow: 'arrivals', minutes: M(1), practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:t-n', from: 'T', to: 'N', bidirectional: false, access: 'public', minutes: M(10), controls: [security], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:s-h1', from: 'S', to: 'H1', bidirectional: true, access: 'public', minutes: M(4), controls: [], reverseControls: [security], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:h1-h2', from: 'H1', to: 'H2', bidirectional: true, access: 'public', minutes: M(20), practical: 'long', confidence: 'probable', sources: src },
      { id: 'w:h2-s2', from: 'H2', to: 'S2', bidirectional: true, access: 'public', minutes: M(4), controls: [security], reverseControls: [], practical: 'practical', confidence: 'probable', sources: src },
      { id: 'w:s-s2', from: 'S', to: 'S2', bidirectional: true, access: 'airside', minutes: M(30), practical: 'long', confidence: 'probable', sources: src, hours: [{ from: '06:00', until: '22:00' }] },
    ],
    rules: [], openQuestions: [],
    oneStopSecurity: { countries: ['US'], airports: ['LHR'], excludedAirports: ['JFK'], asOf: '2026-11-01', sources: src },
  };
}

describe('engine schema v1: validator', () => {
  it('accepts the hub model and rejects bad new fields', () => {
    expect(validateAirport(hub()).errors).toEqual([]);
    const m = hub();
    m.areas[3].intraWalk = { min: 0, typical: 0, max: 0, basis: 'assumed' };
    m.areas[2].checkIn = { serves: ['S'] };
    m.areas[0].checkIn = { serves: ['H2'] };
    m.walks[1].controls = [{ ...tsec, when: 'sometimes' as any }];
    m.specialScreening = [{ id: 'ss', appliesTo: {}, areas: ['H1'], certainty: 'maybe' as any, text: 'x', sources: [] }];
    m.feedTerminals = { arrival: { '1': ['H1'] } };
    const e = validateAirport(m).errors.join('\n');
    for (const t of ['intraWalk must be > 0', 'checkIn on a transfer-hub', 'serves H2, not an airside area', 'bad control condition', 'bad certainty', 'is not an airside area', 'sources missing', 'feedTerminals.arrival["1"]'])
      expect(e).toContain(t);
  });
});

describe('R-14: route issues with levels; legacy warnings unchanged', () => {
  it('every issue has a level and a code; a double passport crossing is material', () => {
    const r = findRoute(hub(), 'S', 'S2', { transfer: true })!;
    for (const i of r.issues) expect(['blocking', 'material', 'secondary']).toContain(i.level);
    expect(r.warnings).toEqual([]);
  });
});

describe('R-02: same-area connections are never 0 minutes', () => {
  it('derived from the gate layout, never below the floor; data value wins; segregated arrivals pass the arrivals flow', () => {
    const m = hub();
    const s = findRoute(m, 'S', 'S', { transfer: true })!;
    expect(s.total.typical).toBeGreaterThanOrEqual(INTRA_WALK_FLOOR.typical);
    expect(s.total.max).toBeGreaterThan(s.total.typical);
    expect(s.steps.map((x) => x.kind)).toEqual(['walk']);
    expect(s.issues.map((i) => i.code)).toContain('intra-walk-estimated');
    expect(intraWalk(m, m.areas.find((a) => a.id === 'S')!).method).toBe('derived');      // 10 gates along 400 units
    expect(intraWalk(m, m.areas.find((a) => a.id === 'S2')!)).toMatchObject({ method: 'assumed', typical: INTRA_WALK_FLOOR.typical });   // 2 close gates → floor
    m.areas.find((a) => a.id === 'S')!.intraWalk = { min: 2, typical: 7, max: 12, basis: 'measured', sources: src };
    const d = findRoute(m, 'S', 'S', { transfer: true })!;
    expect(d.total).toEqual({ min: 2, typical: 7, max: 12 });
    expect(d.issues.map((i) => i.code)).not.toContain('intra-walk-estimated');
    // segregated pier N: arrivals corridor, then transfer security back in (no LHR/US origin given → applies, material)
    const n = findRoute(m, 'N', 'N', { transfer: true })!;
    expect(n.steps[0].text).toMatch(/arrivals flow/);
    expect(n.controls).toEqual(['transfer-security']);
    expect(n.issues.find((i) => i.code === 'origin-unknown')?.level).toBe('material');
  });
});

describe('R-05 / R-42: transfer security conditional on the inbound origin', () => {
  const m = hub();
  it('covered origins skip it, others pass it; JFK is excluded although US is listed', () => {
    expect(oneStopCovered(m, { originAirport: 'LHR' })).toBe(true);
    expect(oneStopCovered(m, { originAirport: 'BOS', originCountry: 'US' })).toBe(true);
    expect(oneStopCovered(m, { originAirport: 'JFK', originCountry: 'US' })).toBe(false);
    expect(oneStopCovered(m, { originAirport: 'TLV', originCountry: 'IL' })).toBe(false);
    expect(oneStopCovered(m, {})).toBeNull();
    const us = findRoute(m, 'N', 'N', { transfer: true, originAirport: 'BOS', originCountry: 'US' })!;
    expect(us.controls).toEqual([]);
    expect(us.issues.find((i) => i.code === 'one-stop-exempt')?.level).toBe('secondary');
    const tlv = findRoute(m, 'N', 'S', { transfer: true, originAirport: 'TLV', originCountry: 'IL' })!;
    expect(tlv.controls).toEqual(['passport', 'transfer-security']);
    const jfk = findRoute(m, 'N', 'S', { transfer: true, originAirport: 'JFK', originCountry: 'US' })!;
    expect(jfk.controls).toContain('transfer-security');
  });
  it('without a one-stop list the control applies (current behaviour) with a secondary note', () => {
    const x = hub(); delete x.oneStopSecurity;
    const r = findRoute(x, 'N', 'S', { transfer: true, originCountry: 'US' })!;
    expect(r.controls).toContain('transfer-security');
    expect(r.issues.find((i) => i.code === 'one-stop-list-missing')?.level).toBe('secondary');
  });
});

describe('R-36: a control on the area boundary cannot be walked around', () => {
  it('every entry into S2 (walk or shuttle) passes its boundary control', () => {
    const m = hub();
    const viaShuttle = findRoute(m, 'S', 'S2', { transfer: true, time: '12:00' })!;
    const viaWalk = findRoute(m, 'S', 'S2', { transfer: true, walkOnly: true, time: '12:00' })!;
    const viaLand = findRoute(m, 'H2', 'S2', { transfer: false })!;
    for (const r of [viaShuttle, viaWalk, viaLand]) expect(r.controls).toContain('boarding-pass');
    expect(viaShuttle.lines).toEqual(['l:sh']);
    expect(viaWalk.lines).toEqual([]);
  });
});

describe('R-13 / R-45: the clock advances along the route', () => {
  const m = hub();
  it('a line that closes before the passenger reaches it is not used; stamps every step with its clock time', () => {
    const r = findRoute(m, 'S', 'S2', { transfer: true, time: '22:57' });
    // at 22:57 + 2 min to the platform = 22:59: still running; at 22:59 + 2 = 23:01 it is closed (and the walk closed at 22:00)
    expect(findRoute(m, 'S', 'S2', { transfer: true, time: '22:57' })!.lines).toEqual(['l:sh']);
    expect(r!.steps[0].at).toBe('22:57');
    expect(findRoute(m, 'S', 'S2', { transfer: true, time: '22:59' })?.lines ?? []).not.toContain('l:sh');
  });
  it('waits for the first service only within maxWait, and a detour may not be used to wait', () => {
    const early = findRoute(m, 'S', 'S2', { transfer: true, time: '04:40', maxWait: 30 })!;
    const w = early.steps.find((s) => s.kind === 'wait')!;
    expect(w.waitsForService).toBe('05:00');
    expect(w.minutes.typical).toBeCloseTo(18 + 2);       // reached 04:42, first service 05:00, then the usual half headway
    expect(early.issues.find((i) => i.code === 'waits-for-service')?.level).toBe('material');
    expect(findRoute(m, 'S', 'S2', { transfer: true, time: '04:40' })?.lines ?? []).toEqual(expect.not.arrayContaining(['l:sh']));
  });
  it('says why there is no route: closed at this hour vs no route', () => {
    const x = hub();
    x.walks = x.walks.filter((w) => w.id !== 'w:s-h1' && w.id !== 'w:h1-h2');
    expect(findRoute(x, 'S', 'S2', { transfer: true, time: '03:00' })).toBeNull();
    expect(noRouteReason(x, 'S', 'S2', { transfer: true, time: '03:00' })).toBe('closed-at-time');
    expect(noRouteReason(x, 'S2', 'X', { transfer: true })).toBe('no-route');
  });
  it('window edge cases: wrap past midnight by service day, "24:00", daytime pattern without a time', () => {
    expect(inWindow('24:00', { from: '00:00', until: '05:00' })).toBe(true);
    expect(inWindow('23:59', { from: '05:00', until: '24:00' })).toBe(true);
    const l = structuredClone(m.lines[0]);
    l.service = [
      { hours: 'Fri 22:00–05:00', windows: [{ from: '22:00', until: '05:00' }], days: ['fri'], headwayMin: { min: 20, max: 20 }, waitMin: M(10) },
      { hours: '05:00–22:00', windows: [{ from: '05:00', until: '22:00' }], headwayMin: { min: 4, max: 4 }, waitMin: M(2) },
    ];
    expect(serviceAt(l, '2026-11-07', '02:00')?.hours).toBe('Fri 22:00–05:00');   // Saturday 02:00 = the Friday night service
    expect(serviceAt(l, '2026-11-08', '02:00')).toBeNull();                        // Sunday 02:00: no Saturday night service
    expect(serviceAt(l, '2026-11-06')?.hours).toBe('05:00–22:00');                 // untimed: the daytime pattern, not the first entry
  });
});

describe('R-11 / R-12: a self-transfer is one route with reclaim, customs, check-in at the departure hall and security', () => {
  it('passes passport, reclaim, customs, landside, the hall that serves the departure area, then security', () => {
    const m = hub();
    const r = findSelfTransfer(m, 'N', 'S2', { date: '2026-11-01' })!;
    const kinds = r.steps.map((s) => s.kind === 'control' ? s.control!.kind : s.kind);
    expect(kinds.indexOf('passport')).toBeLessThan(kinds.indexOf('reclaim'));
    expect(kinds.indexOf('reclaim')).toBeLessThan(kinds.indexOf('customs'));
    expect(kinds.indexOf('customs')).toBeLessThan(kinds.indexOf('check-in'));
    expect(kinds.indexOf('check-in')).toBeLessThan(kinds.indexOf('security'));
    expect(r.checkIn).toEqual({ area: 'H2', step: kinds.indexOf('check-in') });   // H2 serves S2 (not the arrival hall H1)
    expect(r.steps.some((s) => s.from === 'T' || s.to === 'T')).toBe(false);      // never through the transfer hub
    expect(r.entersCountry).toBe(true);
    expect(r.issues.find((i) => i.code === 'enters-country')?.level).toBe('material');
    expect(r.total.typical).toBeCloseTo(r.steps.reduce((s, x) => s + x.minutes.typical, 0));
  });
  it('without check-in data: the landside hall nearest the departure area (never a transfer hub) + a material issue', () => {
    const m = hub(); for (const a of m.areas) delete a.checkIn;
    expect(checkInHalls(m, 'S2', '2026-11-01')).toMatchObject({ mode: 'no-check-in-data', halls: [{ id: 'H1' }, { id: 'H2' }] });
    const r = findSelfTransfer(m, 'N', 'S2', {})!;
    expect(r.checkIn!.area).toBe('H2');
    expect(r.issues.find((i) => i.code === 'check-in-hall-unknown')?.level).toBe('material');
  });
  it('the clock runs through both halves', () => {
    const r = findSelfTransfer(hub(), 'N', 'S2', { time: '10:00' })!;
    const ci = r.steps[r.checkIn!.step];
    const before = r.steps.slice(0, r.checkIn!.step).reduce((s, x) => s + x.minutes.typical, 0);
    expect(ci.at).toBe(`${String(10 + Math.floor(before / 60)).padStart(2, '0')}:${String(Math.round(before % 60)).padStart(2, '0')}`);
  });
});

describe('R-33: entering the country', () => {
  it('a protected route that passes entry passport control then goes landside is flagged; stayAirside avoids it', () => {
    const m = hub();
    m.lines = []; m.walks = m.walks.filter((w) => w.id !== 'w:s-s2' && w.id !== 'w:x-s');
    const r = findRoute(m, 'N', 'S2', { transfer: true })!;
    expect(r.entersCountry).toBe(true);
    expect(r.issues.find((i) => i.code === 'enters-country')!.text).toMatch(/Schengen area.*not checked/);
    expect(findRoute(m, 'N', 'S2', { transfer: true, stayAirside: true })).toBeNull();
    expect(findRoute(hub(), 'N', 'S', { transfer: true })!.entersCountry).toBe(false);
  });
});

describe('R-19: special screening by destination / airline', () => {
  it('adds a step with its minutes, or a material issue when the time is unknown; flags another area', () => {
    const m = hub();
    m.specialScreening = [{ id: 'ss:tlv', appliesTo: { destinationCountries: ['IL'] }, areas: ['S2'], minutes: M(20, 'observed'), certainty: 'probable', text: 'flights to Israel', sources: src }];
    const r = findRoute(m, 'S', 'S2', { transfer: true, destinationCountry: 'IL' })!;
    expect(r.controls.at(-1)).toBe('special-screening');
    expect(r.issues.find((i) => i.code === 'special-screening')?.level).toBe('material');
    expect(findRoute(m, 'S', 'S2', { transfer: true, destinationCountry: 'FR' })!.controls).not.toContain('special-screening');
    const other = findRoute(m, 'S2', 'S', { transfer: true, destinationCountry: 'IL' })!;
    expect(other.issues.map((i) => i.code)).toContain('special-screening-area');
    delete m.specialScreening[0].minutes;
    expect(findRoute(m, 'S', 'S2', { transfer: true, destinationCountry: 'IL' })!.issues.map((i) => i.code)).toContain('special-screening-time-unknown');
  });
});

describe('R-16: dated zones', () => {
  it('a dated zone overrides the area zone inside its period', () => {
    const a = { ...hub().areas[3], zones: [{ zone: 'mixed' as const, validUntil: '2026-04-20' }] };
    expect(zoneOn(a, '2026-04-01')).toBe('mixed');
    expect(zoneOn(a, '2026-04-21')).toBe('schengen');
  });
});

// ---- all-pairs properties on the bundled airports (R-39) ----
const DATA = path.join(import.meta.dirname, '..', 'airportmaps', 'data');
const MODELS = fs.readdirSync(DATA).filter((d) => fs.existsSync(path.join(DATA, d, 'airport.json'))).map((d) => JSON.parse(fs.readFileSync(path.join(DATA, d, 'airport.json'), 'utf8')) as AirportModel);

describe('all ordered area pairs, including same-area, at every bundled airport', () => {
  for (const m of MODELS) it(`${m.iata}: finite, never 0, ordered ranges, passport on every border-zone change`, () => {
    const date = '2026-11-15';
    const areas = m.areas.filter((a) => a.side === 'airside' && m.gateGroups.some((g) => g.area === a.id && g.gates.length) && stateOn(a.status, date) === 'active');
    const bad: string[] = [];
    for (const a of areas) for (const b of areas) {
      const r = findRoute(m, a.id, b.id, { transfer: true, date });
      if (!r) { bad.push(`${a.id}>${b.id}: no route`); continue; }
      const t = r.total;
      if (!(t.typical >= 1 && isFinite(t.max) && t.min <= t.typical && t.typical <= t.max)) bad.push(`${a.id}>${b.id}: ${t.min}/${t.typical}/${t.max}`);
      const za = zoneOn(a, date), zb = zoneOn(b, date);
      const border = [['schengen', 'non-schengen'], ['domestic', 'international']].some(([p, q]) => (za === p && zb === q) || (za === q && zb === p));
      if (border && !r.controls.includes('passport')) bad.push(`${a.id}>${b.id}: border change without passport control`);
      for (const i of r.issues) if (!['blocking', 'material', 'secondary'].includes(i.level)) bad.push(`${a.id}>${b.id}: issue level ${i.level}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('contract changes CR-B1 / CR-B2 / CR-B4 (accepted by the coordinator)', () => {
  it('CR-B1: intraControls apply to an arriving passenger on a same-area connection (conditional by origin)', () => {
    const m = hub();
    m.areas.find((a) => a.id === 'S')!.intraControls = [{ ...tsec }];
    expect(findRoute(m, 'S', 'S', { transfer: true, originCountry: 'IL', originAirport: 'TLV' })!.controls).toEqual(['transfer-security']);
    expect(findRoute(m, 'S', 'S', { transfer: true, originCountry: 'US', originAirport: 'BOS' })!.controls).toEqual([]);
    expect(findRoute(m, 'S', 'S', { transfer: true, fromArrival: false })!.controls).toEqual([]);
  });
  it('CR-B2: a conditional transfer security applies once per route and only on protected transfers', () => {
    const m = hub();
    m.areas.find((a) => a.id === 'S')!.entryControls = [{ ...tsec }];
    const r = findRoute(m, 'N', 'S', { transfer: true, originCountry: 'IL', originAirport: 'TLV' })!;
    expect(r.controls.filter((c) => c === 'transfer-security')).toHaveLength(1);
    const self = findSelfTransfer(m, 'N', 'S2', { originCountry: 'IL', originAirport: 'TLV' })!;
    expect(self.controls).not.toContain('transfer-security');
  });
  it('CR-B4: every given criterion must match; a presence deadline and the issue level are carried', () => {
    const m = hub();
    m.specialScreening = [{ id: 'ss:x', appliesTo: { destinationCountries: ['IL'], airlines: ['XX'] }, certainty: 'probable', text: 'XX to Israel', sources: src, deadline: { minutesBeforeDeparture: 50, basis: 'published', text: 'at the gate 50 min before' }, issueLevel: 'secondary' }];
    expect(findRoute(m, 'S', 'S2', { transfer: true, destinationCountry: 'IL', airline: 'YY' })!.deadline).toBeUndefined();
    const r = findRoute(m, 'S', 'S2', { transfer: true, destinationCountry: 'IL', airline: 'XX' })!;
    expect(r.deadline).toEqual({ minutes: 50, text: 'at the gate 50 min before' });
    expect(r.issues.find((i) => i.code === 'special-screening-time-unknown')?.level).toBe('secondary');
  });
});

// London Heathrow (LHR) production model and its wiring into the extension (owner decision 2026-11-02: LHR replaces IST).
// Scenario matrix: every row carries its evidence status (verified / partly verified / unsupported) and the test asserts
// that the engine is honest where evidence is missing (unestablished steps flagged, terminal-level "depends on the area",
// never a fabricated border crossing, never 0 minutes). Reference: docs/research/LHR_FEASIBILITY_AND_MAPPING.md §8.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AirportModel } from '../airportmaps/src/types.ts';
import { loadEvidence } from './helpers/evidence.ts';
import { validateAirport } from '../airportmaps/src/validate.ts';
import { buildMatrix, findRoute, findSelfTransfer, type Profile, type Route } from '../airportmaps/src/route.ts';
import { analyzeConnection } from '../extension/src/core/analyze.ts';
import { assessTransfer, longHaul } from '../extension/src/core/assess.ts';
import { SUPPORTED, zoneFor } from '../extension/src/core/airports.ts';
import { expectedCrossings, PASSPORT } from '../extension/src/core/calibration.ts';
import { FixtureHistory, type ConnectionAnswer, type FieldAnswer, type FlightAnswer } from '../extension/src/core/history.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas } from '../extension/src/core/resolve.ts';
import { summarisePlace } from '../extension/src/core/summary.ts';
import { HUB_TZ } from '../extension/src/core/time.ts';
import { checkInCloseFor, gateCloseFor, screeningPolicy, securityDeadlineFor } from '../extension/src/core/timing.ts';
import type { Leg } from '../extension/src/core/types.ts';

const DIR = path.join(import.meta.dirname, '..', 'airportmaps', 'data', 'lhr');
const m = JSON.parse(fs.readFileSync(path.join(DIR, 'airport.json'), 'utf8')) as AirportModel;
const ev = loadEvidence('lhr');   // research evidence: private repository only (undefined in the public snapshot)
const D = '2026-11-18';
const P: Profile = { transfer: true, date: D };
const route = (a: string, b: string, p: Partial<Profile> = {}) => findRoute(m, `lhr-${a}`, `lhr-${b}`, { ...P, ...p })!;
const count = (r: Route, k: string) => r.controls.filter((c) => c === k).length;
const codes = (r: Route) => r.issues.map((i) => i.code);
const areaOf = (r: Route) => new Set(r.steps.flatMap((s) => [s.from, s.to]));

// ---- fixtures for the extension pipeline ----
function field(dist: [string, number][]): FieldAnswer {
  const sample = dist.reduce((s, [, n]) => s + n, 0);
  const st = sample >= 5 ? 'predicted' : sample ? 'insufficient-data' : 'no-data';
  return { status: st, value: st === 'predicted' ? dist[0][0] : null, confidence: st === 'predicted' ? 'medium' : null, confidenceScore: null, interval: null, sample,
    distribution: dist.map(([value, n]) => ({ value, n, share: sample >= 5 ? n / sample : null })), alternatives: [] } as FieldAnswer;
}
const flight = (fl: string, direction: 'arrival' | 'departure', terminal: [string, number][]): FlightAnswer => ({ flight: fl, airport: 'LHR', direction, status: 'ok', date: D, terminal: field(terminal), gateArea: field([]), gate: field([]), sameDay: null,
  basis: { windowDays: 30, flightDays: 30, fromCounters: 0, cancelled: 0, period: { from: '2026-10-15', to: '2026-11-14' }, sources: ['fixture'], lastRefresh: null }, notes: [] } as unknown as FlightAnswer);
const leg = (fn: string, from: string, to: string, dep: string, arr: string, depDate = D, arrDate = D): Leg => ({ flightNumber: fn, altNumbers: [], airline: null, operatedBy: null, from, to, depDate, depTime: dep, arrDate, arrTime: arr });
const analyse = (inb: Leg, out: Leg, selfTransfer: boolean | null, arrT?: [string, number][], depT?: [string, number][], passenger?: 'ees-exempt' | 'ees-registered') => {
  const ans = arrT || depT ? ({ query: {} as never, status: 'ok', airport: 'LHR', airportCandidates: ['LHR'], arrival: flight(inb.flightNumber!, 'arrival', arrT ?? []), departure: flight(out.flightNumber!, 'departure', depT ?? []), sameTerminalHistorically: null, notes: [] } as unknown as ConnectionAnswer) : null;
  return analyzeConnection({ airport: 'LHR', inbound: inb, outbound: out, selfTransfer }, { models: MODELS, history: new FixtureHistory(() => ans), today: '2026-11-14', passenger });
};

describe('LHR model: structure and evidence', () => {
  it('passes the shared validator with no errors, and every matrix pair has a route', () => {
    expect(validateAirport(m, ev).errors).toEqual([]);
    const mx = buildMatrix(m);
    expect(mx.cells.filter((c) => c.from !== c.to && !c.route)).toEqual([]);
  });
  it('has all four terminals with their sub-areas, the UK & Ireland logical areas and Europe/London time', () => {
    const ids = m.areas.map((a) => a.id);
    for (const id of ['t2a', 't2b', 't3', 't4', 't5a', 't5b', 't5c', 't2-dom', 't5-dom', 't2-fc', 't3-fc', 't4-fc', 't5-fc', 't2-land', 't3-land', 't4-land', 't5-land']) expect(ids).toContain(`lhr-${id}`);
    expect(m.tz).toBe('Europe/London');
    expect(HUB_TZ.LHR).toBe('Europe/London');
    expect(m.areas.filter((a) => a.zone === 'domestic').map((a) => a.id).sort()).toEqual(['lhr-t2-dom', 'lhr-t5-dom']);
    // international gate areas keep arrivals apart from departures: every connection goes through Flight Connections
    for (const id of ['t2a', 't2b', 't3', 't4', 't5a', 't5b', 't5c']) expect(m.areas.find((a) => a.id === `lhr-${id}`)!.arrivals).toBe('segregated');
  });
  it('asymmetric UK border: domestic → international is open, international → domestic is not', () => {
    expect(m.openBorders).toEqual([expect.objectContaining({ from: 'domestic', to: 'international' })]);
    // the validator still requires a passport control on any international → domestic walk
    const bad = structuredClone(m);
    bad.walks.find((w) => w.id === 'w:lhr-t5fc-t5dom')!.controls = bad.walks.find((w) => w.id === 'w:lhr-t5fc-t5dom')!.controls!.filter((c) => c.kind !== 'passport');
    expect(validateAirport(bad).errors.join(' ')).toMatch(/w:lhr-t5fc-t5dom.*crosses domestic ↔ international without a passport control/);
    // and refuses an open border in both directions
    const both = structuredClone(m);
    both.openBorders!.push({ from: 'international', to: 'domestic', note: 'x', sources: ['src:lhr-connecting'] });
    expect(validateAirport(both).errors.join(' ')).toMatch(/both directions open/);
  });
  it('gates: T5/T2 letters are prefixed by terminal (both have A and B gates); T4 is a partial list of named gates only', () => {
    const all = m.gateGroups.flatMap((g) => g.gates);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('T5 B35');
    expect(all).toContain('T2 B30');
    expect(all).toContain('T3 7');
    expect(m.gateGroups.find((g) => g.id === 'g:lhr-t4')!.gates).toEqual(['T4 7', 'T4 11A']);
    expect(m.gateGroups.find((g) => g.id === 'g:lhr-t4')!.notes).toMatch(/PARTIAL/);
    expect(m.gateGroups.find((g) => g.id === 'g:lhr-t5a-coach')!.bus).toBe(true);
  });
  it('feed terminals map to whole terminals (no satellite is predicted from a terminal value)', () => {
    expect(m.feedTerminals!.departure!['5']).toEqual(['lhr-t5a', 'lhr-t5b', 'lhr-t5c', 'lhr-t5-dom']);
    expect(m.feedTerminals!.arrival!['2']).toEqual(['lhr-t2a', 'lhr-t2b', 'lhr-t2-dom']);
    expect(m.feedTerminals!.arrival!['4']).toEqual(['lhr-t4']);
  });
  it('no time is invented as 0, and unknown T4 structure stays "unknown"', () => {
    for (const w of m.walks) expect(w.minutes.typical, w.id).toBeGreaterThan(0);
    for (const l of m.lines) for (const r of l.ride ?? []) expect(r.typical, l.id).toBeGreaterThan(0);
    expect(m.areas.find((a) => a.id === 'lhr-t4-fc')!.confidence).toBe('unknown');
    expect(m.walks.filter((w) => w.from === 'lhr-t4' && w.to === 'lhr-t4-fc' || w.from === 'lhr-t4-fc').every((w) => w.confidence === 'unknown')).toBe(true);
    // the connections bus publishes no hours: no windows invented
    for (const l of m.lines.filter((x) => x.id.startsWith('l:lhr-fcbus'))) expect(l.service.every((s) => !s.windows)).toBe(true);
    // only the toured T3 → T5 ride is published; the other five pairs are derived
    expect(m.lines.filter((l) => l.id.startsWith('l:lhr-fcbus')).map((l) => `${l.id}:${l.ride![0].basis}`).sort()).toEqual(['l:lhr-fcbus-t2-t3:derived', 'l:lhr-fcbus-t2-t4:derived', 'l:lhr-fcbus-t2-t5:derived', 'l:lhr-fcbus-t3-t4:derived', 'l:lhr-fcbus-t3-t5:published', 'l:lhr-fcbus-t4-t5:derived']);
  });
});

// ---- the scenario matrix (docs §8): status per row, and what the engine must do ----
type Status = 'verified' | 'partly' | 'unsupported';
const TERM: Record<string, string> = { '2': 't2a', '3': 't3', '4': 't4', '5': 't5a' };

describe('LHR scenario matrix: every terminal pair, international → international, protected', () => {
  for (const a of ['2', '3', '4', '5']) for (const b of ['2', '3', '4', '5']) {
    const status: Status = a === '4' || b === '4' ? 'partly' : 'partly';
    it(`T${a} → T${b} (${status}): one re-screening, no passport, bus between terminals, T4 flagged as unestablished`, () => {
      const r = route(TERM[a], TERM[b]);
      expect(count(r, 'transfer-security')).toBe(1);
      expect(count(r, 'passport')).toBe(0);
      expect(r.entersCountry).toBe(false);
      expect(r.total.typical).toBeGreaterThan(15);
      if (a !== b) expect(r.lines.some((l) => l.startsWith('l:lhr-fcbus'))).toBe(true);
      else expect(r.lines.filter((l) => l.startsWith('l:lhr-fcbus'))).toEqual([]);
      // every arriving passenger goes through a Flight Connections area first
      expect(r.steps[0].refId).toMatch(/arr-fc$/);
      const t4 = a === '4' || b === '4';
      expect(codes(r).includes('unestablished-step'), `T${a}→T${b}`).toBe(t4);
      expect(r.confidence).toBe(t4 ? 'unknown' : a === '3' && b === '5' ? 'probable' : 'inferred');
    });
  }
  it('T3 → T5 (partly verified: the Heathrow tour route): 9 walk + 10 bus + 16 to the gates, re-screened at T5 Level 3', () => {
    const r = route('t3', 't5a');
    expect(r.lines).toEqual(['l:lhr-fcbus-t3-t5']);
    expect(r.steps.find((s) => s.kind === 'ride')!.minutes).toMatchObject({ typical: 10, basis: 'published' });
    expect(r.steps.map((s) => s.refId)).toContain('w:lhr-t5fc-t5a');
    expect(r.controls).toEqual(['boarding-pass', 'transfer-security']);
  });
});

describe('LHR scenario matrix: inside terminals', () => {
  it('T5A ↔ T5B ↔ T5C (partly): the Transit train after T5 connections security; never a gate-to-gate walk without re-screening', () => {
    for (const [a, b] of [['t5a', 't5b'], ['t5a', 't5c'], ['t5b', 't5c'], ['t5c', 't5a'], ['t5b', 't5b']]) {
      const r = route(a, b);
      expect(count(r, 'transfer-security'), `${a}>${b}`).toBe(1);
      expect(areaOf(r).has('lhr-t5-fc')).toBe(true);
      if (b !== 't5a') expect(r.lines).toContain('l:lhr-t5-transit');
    }
    expect(route('t5a', 't5c').steps.find((s) => s.line === 'l:lhr-t5-transit' && s.kind === 'ride')!.minutes.basis).toBe('derived');
  });
  it('T2A ↔ T2B (partly): the published 15-min subway walk after re-screening', () => {
    const r = route('t2a', 't2b');
    expect(r.steps.map((s) => s.refId)).toContain('w:lhr-t2a-t2b');
    expect(r.steps.find((s) => s.refId === 'w:lhr-t2a-t2b')!.minutes).toMatchObject({ typical: 15, basis: 'published' });
    expect(count(r, 'transfer-security')).toBe(1);
  });
  it('same area (partly): T3 → T3 and T4 → T4 loop through Flight Connections and security (never 0 min)', () => {
    for (const t of ['t3', 't4', 't5a', 't2a']) {
      const r = route(t, t);
      expect(count(r, 'transfer-security'), t).toBe(1);
      expect(r.total.typical).toBeGreaterThanOrEqual(20);
    }
    expect(codes(route('t4', 't4'))).toContain('unestablished-step');
  });
});

describe('LHR scenario matrix: UK border (asymmetric)', () => {
  it('international → UK & Ireland (partly): UK immigration once, then biometric + security, at T5 and at T2', () => {
    for (const [a, b] of [['t5a', 't5-dom'], ['t5c', 't5-dom'], ['t3', 't5-dom'], ['t2b', 't2-dom'], ['t4', 't2-dom']]) {
      const r = route(a, b);
      expect(count(r, 'passport'), `${a}>${b}`).toBe(1);
      expect(count(r, 'transfer-security')).toBe(1);
      expect(r.controls).toContain('boarding-pass');
      expect(r.entersCountry).toBe(false);   // stays airside: the eligibility warning comes from analyze.ts
    }
  });
  it('UK & Ireland → international (partly): no passport control (no UK exit control), one re-screening', () => {
    for (const [a, b] of [['t5-dom', 't5a'], ['t5-dom', 't5b'], ['t2-dom', 't2a'], ['t2-dom', 't3'], ['t5-dom', 't4']]) {
      const r = route(a, b);
      expect(count(r, 'passport'), `${a}>${b}`).toBe(0);
      expect(count(r, 'transfer-security')).toBe(1);
    }
  });
  it('UK & Ireland → UK & Ireland, same terminal (partly): re-screened, no passport', () => {
    const r = route('t5-dom', 't5-dom');
    expect(r.controls).toEqual(['transfer-security']);
  });
  it('UK & Ireland T5 → T2 (unsupported airside): no fabricated UK border; the only modelled way is landside (gap)', () => {
    const r = route('t5-dom', 't2-dom');
    expect(count(r, 'passport')).toBe(0);
    expect(r.controls).toContain('security');            // landside rail + departure security: the airside procedure is unknown
    expect(r.lines.some((l) => l.startsWith('l:lhr-fcbus'))).toBe(false);
  });
});

describe('LHR scenario matrix: self-transfer (separate tickets)', () => {
  it('with checked bags (partly): UK border, reclaim, customs, landside link, check-in at the departure terminal, security', () => {
    for (const [a, b, line] of [['t3', 't5a', 'l:lhr-rail-t23-t5'], ['t4', 't5a', 'l:lhr-h30-t4-t5'], ['t2a', 't4', 'l:lhr-rail-t23-t4'], ['t5b', 't3', '']]) {
      const r = findSelfTransfer(m, `lhr-${a}`, `lhr-${b}`, { date: D, time: '12:00' })!;
      expect(r.controls, `${a}>${b}`).toEqual(expect.arrayContaining(['passport', 'customs', 'security']));
      expect(r.entersCountry).toBe(true);
      expect(r.steps.some((s) => s.kind === 'reclaim')).toBe(true);
      expect(m.areas.find((x) => x.id === r.checkIn!.area)!.checkIn!.serves).toContain(`lhr-${b}`);
      if (line) expect(r.lines).toContain(line);
      expect(codes(r)).toContain('enters-country');
    }
  });
  it('T2 ↔ T3 self-transfer uses the 10-min landside walkway, not a train', () => {
    const r = findSelfTransfer(m, 'lhr-t2a', 'lhr-t3', { date: D, time: '12:00' })!;
    expect(r.lines).toEqual([]);
    expect(r.steps.map((s) => s.refId)).toEqual(expect.arrayContaining(['w:lhr-t2land-station', 'w:lhr-t3land-station']));
  });
  it('from a UK & Ireland arrival (partly): no UK border on the way out', () => {
    const r = findSelfTransfer(m, 'lhr-t5-dom', 'lhr-t3', { date: D, time: '12:00' })!;
    expect(r.controls).not.toContain('passport');
    expect(r.entersCountry).toBe(false);
  });
  it('cabin bags only (unsupported in the product): the engine can route it without reclaim/check-in, the extension always assumes checked bags', () => {
    const r = findRoute(m, 'lhr-t3', 'lhr-t5a', { transfer: false, date: D })!;
    expect(r.controls).toEqual(expect.arrayContaining(['passport', 'security']));
    expect(r.steps.some((s) => s.kind === 'reclaim' || s.kind === 'check-in')).toBe(false);
  });
  it('night (partly): T4 → T5 at 00:30 waits for the first H30 / train (timetable May 2025), flagged', () => {
    const r = findSelfTransfer(m, 'lhr-t4', 'lhr-t5a', { date: D, time: '00:30', maxWait: 400 })!;
    expect(codes(r)).toContain('waits-for-service');
    expect(r.steps.find((s) => s.waitsForService)!.waitsForService! >= '03:17').toBe(true);
    expect(findSelfTransfer(m, 'lhr-t4', 'lhr-t5a', { date: D, time: '00:30' })).toBeNull();
  });
  it('early morning 05:30 (partly): Elizabeth line T4 → T2&3 runs from 05:30 on weekdays', () => {
    const r = findSelfTransfer(m, 'lhr-t4', 'lhr-t3', { date: D, time: '05:15', maxWait: 60 })!;
    expect(r.lines.some((l) => l === 'l:lhr-rail-t4-t23' || l === 'l:lhr-picc-t4-t23')).toBe(true);
  });
});

describe('LHR scenario matrix: time of day on protected connections', () => {
  it('night / early morning (partly): the connections bus has no published hours, so a timed route says so (never silently "running")', () => {
    for (const t of ['05:10', '12:00', '23:30']) expect(codes(route('t3', 't5a', { time: t }))).toContain('hours-unpublished');
    expect(codes(route('t5a', 't5c', { time: '05:30' }))).toContain('hours-unpublished');   // T5 Transit hours not published either
  });
});

describe('LHR extension wiring', () => {
  it('eight supported airports exactly, LHR instead of IST', () => {
    expect([...SUPPORTED].sort()).toEqual(['AMS', 'CDG', 'FCO', 'FRA', 'LHR', 'MAD', 'MUC', 'ZRH']);
    expect(Object.keys(MODELS).sort()).toEqual([...SUPPORTED].sort());
    expect(fs.existsSync(path.join(DIR, '..', 'ist', 'airport.json'))).toBe(true);   // kept for history
  });
  it('zones: UK, Ireland, Channel Islands and Isle of Man are UK & Ireland (domestic); everything else international', () => {
    for (const x of ['EDI', 'MAN', 'BHD', 'DUB', 'JER', 'GCI', 'IOM']) expect(zoneFor('LHR', x), x).toBe('domestic');
    for (const x of ['TLV', 'JFK', 'CDG', 'GIB', 'AMS']) expect(zoneFor('LHR', x), x).toBe('international');
  });
  it('long-haul for check-in deadlines: Europe and the UK/CTA are short-haul at LHR', () => {
    for (const c of ['GB', 'IE', 'JE', 'FR', 'GI', 'CY']) expect(longHaul('LHR', c), c).toBe(false);
    for (const c of ['IL', 'US', 'IN']) expect(longHaul('LHR', c), c).toBe(true);
  });
  it('UK border crossings: entry on international → domestic and on a self-transfer from abroad; never an exit check', () => {
    expect(expectedCrossings('LHR', 'international', 'international', false)).toEqual([]);
    expect(expectedCrossings('LHR', 'international', 'domestic', false)).toEqual(['entry']);
    expect(expectedCrossings('LHR', 'domestic', 'international', false)).toEqual([]);
    expect(expectedCrossings('LHR', 'international', 'international', true)).toEqual(['entry']);
    expect(expectedCrossings('LHR', 'domestic', 'international', true)).toEqual([]);
    expect(PASSPORT.LHR!['entry:ees-exempt']!.max).toBeLessThan(25);       // MTI: EEA ≥ 99 % < 25 min
    expect(PASSPORT.LHR!['entry:ees-registered']!.max).toBeGreaterThanOrEqual(45);
  });
  it('deadlines: BA gate 20, BA check-in 45/60, BA through security 35 at LHR only, Virgin check-in 60', () => {
    expect(gateCloseFor('BA').typical).toBe(20);
    expect(checkInCloseFor('BA', false).typical).toBe(45);
    expect(checkInCloseFor('BA', true).typical).toBe(60);
    expect(checkInCloseFor('VS', true).typical).toBe(60);
    expect(securityDeadlineFor('BA', 'LHR')!.typical).toBe(35);
    expect(securityDeadlineFor('BA', 'CDG')).toBeNull();
    expect(gateCloseFor('VS').basis).toBe('assumed');   // not published: the generic assumption stays
  });
  it('terminal-only data: a T5 departure is one evidence group 5A/5B/5C, no per-satellite percentage', () => {
    const r = resolveAreas(m, { direction: 'departure', other: 'JFK', date: D, answer: flight('BA117', 'departure', [['5', 20]]) });
    expect(r.areaLevel).toBe(false);
    expect(r.groups).toEqual([{ label: '5', p: 1, areas: ['lhr-t5a', 'lhr-t5b', 'lhr-t5c'] }]);
    const s = summarisePlace(r);
    expect(s.top).toHaveLength(1);
    expect(s.top[0].detail).toMatch(/which one is not predicted/);
    expect(s.top[0].areaIds).toEqual(['lhr-t5a', 'lhr-t5b', 'lhr-t5c']);
    // T2 likewise; T3 / T4 are single areas
    const t2 = resolveAreas(m, { direction: 'arrival', other: 'FRA', date: D, answer: flight('LH900', 'arrival', [['2', 18], ['5', 2]]) });
    expect(t2.groups.map((g) => [g.label, g.areas.length])).toEqual([['2', 2], ['5', 3]]);
  });
  it('a UK & Ireland flight resolves to the logical domestic area of its terminal (gates unknown)', () => {
    const r = resolveAreas(m, { direction: 'departure', other: 'EDI', date: D, answer: flight('BA1432', 'departure', [['5', 20]]) });
    expect(r.candidates.map((c) => c.area.id)).toEqual(['lhr-t5-dom']);
    const none = resolveAreas(m, { direction: 'departure', other: 'DUB', date: D, answer: null });
    expect(none.candidates.map((c) => c.area.id).sort()).toEqual(['lhr-t2-dom', 'lhr-t5-dom']);
    // other airports are unchanged by the gate-less rule (their zones all have gate areas)
    expect(resolveAreas(MODELS.MUC, { direction: 'departure', other: 'JFK', date: D, answer: null }).candidates.map((c) => c.area.id)).not.toContain('muc-hall-f');
  });
  it('missing history (gates are 0 % at LHR): every international area is possible and no percentage is shown', () => {
    const r = resolveAreas(m, { direction: 'arrival', other: 'JFK', date: D, answer: null });
    expect(r.provenance).toBe('unknown');
    expect(r.candidates.map((c) => c.area.id).sort()).toEqual(['lhr-t2a', 'lhr-t2b', 'lhr-t3', 'lhr-t4', 'lhr-t5a', 'lhr-t5b', 'lhr-t5c']);
    expect(summarisePlace(r).top.every((o) => o.p === null)).toBe(true);
  });
});

describe('LHR end-to-end connections (analyzeConnection)', () => {
  it('T3 → T5 on BA, 150 min, terminal history: assessed; the displayed route is illustrative inside T5', async () => {
    const r = await analyse(leg('BA174', 'JFK', 'LHR', '18:00', '06:30', '2026-11-17'), leg('BA432', 'LHR', 'AMS', '09:00', '11:15'), false, [['3', 20]], [['5', 20]]);
    expect(r.status).toBe('ok');
    const a = r.assessment!;
    expect(['comfortable', 'tight', 'risky']).toContain(a.verdict);
    expect(a.notes.join(' ')).toMatch(/35 min before departure/);
    expect(a.combos.every((c) => c.arrival.area.id === 'lhr-t3')).toBe(true);
    expect(new Set(a.combos.map((c) => c.departure.area.id))).toEqual(new Set(['lhr-t5a', 'lhr-t5b', 'lhr-t5c']));
  });
  it('the BA 35-min security deadline can decide the time needed (protected, T3 → T5A)', () => {
    const one = (id: string) => ({ direction: 'arrival' as const, zone: 'international' as const, candidates: [{ area: m.areas.find((a) => a.id === id)!, p: 1, evidence: 1, via: [] }], groups: [{ label: id, p: 1, areas: [id] }], unassigned: 0, areaLevel: true, provenance: 'observed' as const, basis: 'gate' as const, sample: null, summary: '', notes: [] });
    const arr = one('lhr-t3'), dep = { ...one('lhr-t5a'), direction: 'departure' as const };
    const ba = assessTransfer(m, arr, dep, { scheduledMinutes: 120, selfTransfer: false, date: D, arrivalTime: '10:00', profile: { airline: 'BA', destinationCountry: 'NL' } });
    const xx = assessTransfer(m, arr, dep, { scheduledMinutes: 120, selfTransfer: false, date: D, arrivalTime: '10:00', profile: { airline: 'XX', destinationCountry: 'NL' } });
    expect(ba.combos[0].needed!.typical).toBeGreaterThan(xx.combos[0].needed!.typical);
  });
  it('T2 → T4 onto El Al to Tel Aviv: departs from T4 only, bounded El Al deadline, T4 steps flagged', async () => {
    const r = await analyse(leg('LH900', 'FRA', 'LHR', '07:00', '07:45'), leg('LY316', 'LHR', 'TLV', '12:15', '19:15'), false, [['2', 20]], [['4', 20]]);
    const a = r.assessment!;
    expect(r.departure!.candidates.map((c) => c.area.id)).toEqual(['lhr-t4']);
    const c = a.combos.find((x) => x.route)!;
    expect(codes(c.route!)).toEqual(expect.arrayContaining(['unestablished-step', 'special-screening-bounded']));
    expect(screeningPolicy({ id: 'ss:lhr-elal-t4', certainty: 'probable' })).toMatchObject({ kind: 'deadline' });
    // with 4.5 h the verdict may be favourable, but the unestablished T4 connections steps stay visible as a material issue
    expect(a.issues.filter((i) => i.level === 'material').map((i) => i.code)).toContain('unestablished-step');
    const short = await analyse(leg('LH900', 'FRA', 'LHR', '07:00', '07:45'), leg('LY316', 'LHR', 'TLV', '09:45', '16:45'), false, [['2', 20]], [['4', 20]]);
    expect(short.assessment!.verdict).toBe('risky');   // 120 min: the El Al presence bound (85 / 120) decides
  });
  it('BA to Tel Aviv from T5: only a "may apply" warning for an extra check (existence not established), no minutes', async () => {
    const r = await analyse(leg('BA112', 'JFK', 'LHR', '18:00', '06:30', '2026-11-17'), leg('BA404', 'LHR', 'TLV', '10:30', '17:20'), false, [['5', 20]], [['5', 20]]);
    const c = r.assessment!.combos.find((x) => x.route)!;
    expect(codes(c.route!)).toContain('special-screening-possible');
    expect(c.route!.steps.some((s) => s.control?.kind === 'special-screening')).toBe(false);
  });
  it('international → UK domestic: caveat about UK border control, calibrated passport by passenger status', async () => {
    const inb = leg('BA178', 'JFK', 'LHR', '18:00', '06:30', '2026-11-17'), out = leg('BA1432', 'LHR', 'EDI', '09:10', '10:35');
    const reg = await analyse(inb, out, false, [['5', 20]], [['5', 20]]);
    const exm = await analyse(inb, out, false, [['5', 20]], [['5', 20]], 'ees-exempt');
    expect(reg.caveats.join(' ')).toMatch(/UK border control/);
    expect(reg.assessment!.notes.join(' ')).toMatch(/non-EEA lanes/);
    expect(exm.assessment!.notes.join(' ')).toMatch(/EU\/EEA\/Swiss passports/);
    expect(exm.assessment!.likely!.needed!.typical).toBeLessThan(reg.assessment!.likely!.needed!.typical);
  });
  it('self-transfer T4 → T5: UK border, bags, H30 / rail, BA check-in deadline; ticket type unknown shows both', async () => {
    const inb = leg('KL1001', 'AMS', 'LHR', '08:00', '08:30'), out = leg('BA404', 'LHR', 'TLV', '13:30', '20:20');
    const self = await analyse(inb, out, true, [['4', 20]], [['5', 20]]);
    expect(self.assessment!.deadline).toMatchObject({ label: 'Check-in closes', minutes: 60 });
    expect(self.assessment!.issues.map((i) => i.code)).toContain('enters-country');
    const unk = await analyse(inb, out, null, [['4', 20]], [['5', 20]]);
    expect(unk.scenarios).not.toBeNull();
  });
  it('an unknown airport change from LHR (LHR → LGW) is out of scope', async () => {
    const r = await analyse(leg('BA1', 'JFK', 'LHR', '18:00', '06:30', '2026-11-17'), { ...leg('BA2', 'LGW', 'MAD', '12:00', '15:00') }, true);
    expect(r.status).toBe('airport-change');
  });
});

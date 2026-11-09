// Regression tests for the remediation findings (docs/COMPREHENSIVE_ROUTING_AUDIT.md, R-xx) in the extension pipeline:
// input validation, ticket type, verdict monotonicity, evidence-level probabilities, gate mapping, time of day.
import { describe, expect, it } from 'vitest';
import { analyzeConnection, connectionsOf } from '../extension/src/core/analyze.ts';
import { assessTransfer, severityOf, type Verdict } from '../extension/src/core/assess.ts';
import { normFlight } from '../extension/src/core/flight.ts';
import { FixtureHistory, type ConnectionAnswer, type FieldAnswer, type FlightAnswer } from '../extension/src/core/history.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { resolveAreas, type Resolution } from '../extension/src/core/resolve.ts';
import { parseSkyscannerText, scheduledConnectionMinutes } from '../extension/src/core/skyscanner.ts';
import { bestRoute, FORBIDDEN_WORDS, SHORT_VERDICT, summarisePlace } from '../extension/src/core/summary.ts';
import { connectionTiming, HUB_TZ, localToday } from '../extension/src/core/time.ts';
import type { ConnectionInput, Leg } from '../extension/src/core/types.ts';
import { AIRPORTS } from '../flightdata/src/airports.ts';
import { normFlightNumber } from '../flightdata/src/normalize.ts';

const D = '2026-11-04';
function field(dist: [string, number][]): FieldAnswer {
  const sample = dist.reduce((s, [, n]) => s + n, 0);
  const st = sample >= 5 ? 'predicted' : sample ? 'insufficient-data' : 'no-data';
  return { status: st, value: st === 'predicted' ? dist[0][0] : null, confidence: st === 'predicted' ? 'medium' : null, confidenceScore: null, interval: null, sample,
    distribution: dist.map(([value, n]) => ({ value, n, share: sample >= 5 ? n / sample : null })), alternatives: [] };
}
const flight = (p: Partial<FlightAnswer> & { flight: string; airport: string; direction: 'arrival' | 'departure' }): FlightAnswer => ({
  status: 'ok', date: D, terminal: field([]), gateArea: field([]), gate: field([]), sameDay: null,
  basis: { windowDays: 30, flightDays: 30, fromCounters: 0, cancelled: 0, period: { from: '2026-10-01', to: '2026-10-30' }, sources: ['aerodatabox'], lastRefresh: null }, notes: [], ...p });
const leg = (fn: string | null, from: string, to: string, depDate: string | null, dep: string | null, arrDate: string | null, arr: string | null): Leg => ({ flightNumber: fn, altNumbers: [], airline: null, operatedBy: null, from, to, depDate, depTime: dep, arrDate, arrTime: arr });
const conn = (airport: string, inbound: Leg, outbound: Leg, selfTransfer: boolean | null = false): ConnectionInput => ({ airport, inbound, outbound, selfTransfer });
const answerOf = (airport: string, arr: FlightAnswer | null, dep: FlightAnswer | null) => (arr && dep ? ({ query: { arrivalFlight: arr.flight, departureFlight: dep.flight, date: D, departureDate: D, airport }, status: 'ok', airport, airportCandidates: [airport], arrival: arr, departure: dep, sameTerminalHistorically: null, notes: [] } as ConnectionAnswer) : null);
const run = (c: ConnectionInput, ans: ConnectionAnswer | null = null, queries: unknown[] = []) => analyzeConnection(c, { models: MODELS, history: new FixtureHistory((q) => { queries.push(q); return ans; }), today: D });
/** A resolution with given evidence shares (for verdict tests). */
function res(m: typeof MODELS.FRA, direction: 'arrival' | 'departure', other: string, gateAreas: [string, number][]): Resolution {
  return resolveAreas(m, { direction, other, date: D, answer: flight({ flight: 'X1', airport: m.iata, direction, gateArea: field(gateAreas) }) });
}

describe('R-04: missing or inconsistent dates are never assessed', () => {
  it('manual entry with only the departure date → not assessed, no absurd minutes, no lookup', async () => {
    const q: unknown[] = [];
    const r = await run(conn('MUC', leg('LH687', 'TLV', 'MUC', null, '08:00', null, '12:00'), leg('LH2416', 'MUC', 'CDG', D, '12:40', D, '14:00')), null, q);
    expect(r.observed.scheduledMinutes).toBeNull();
    expect(r.notAssessed).toMatchObject({ code: 'missing-date' });
    expect(r.assessment!.verdict).toBe('not-assessed');
    expect(r.status).toBe('missing-information');
    expect(r.missing).toContain('arrival date');
    expect(q).toEqual([]);
  });
  it('the first date only between the legs (selection below the header) → not assessed', async () => {
    const it = parseSkyscannerText('08:15\nTLV Tel Aviv\nAF 1621\n12:05\nCDG Paris\nWed, 4 Nov 2026\n13:40\nCDG Paris\nAF 1240\n15:05\nAMS Amsterdam', D);
    const [c] = connectionsOf(it);
    expect(scheduledConnectionMinutes(c.inbound, c.outbound)).toBeNull();
    expect((await run(c)).assessment!.verdict).toBe('not-assessed');
  });
  it('departure before arrival → invalid-times, not "risky"; over 24 h → a stopover, not assessed', async () => {
    const neg = await run(conn('MUC', leg('LH687', 'TLV', 'MUC', D, '08:00', D, '12:00'), leg('LH2416', 'MUC', 'CDG', '2026-11-03', '20:00', '2026-11-03', '21:30')));
    expect(neg).toMatchObject({ status: 'invalid-times', notAssessed: { code: 'negative' } });
    expect(neg.assessment!.verdict).toBe('not-assessed');
    const long = await run(conn('LHR', leg('BA164', 'TLV', 'LHR', D, '08:00', D, '11:30'), leg('BA500', 'LHR', 'LIS', '2026-11-06', '10:00', '2026-11-06', '12:40')));   // LHR replaced IST (2026-11-02)
    expect(long.notAssessed).toMatchObject({ code: 'too-long' });
  });
});

describe('R-06 / R-28: day offsets per leg and time zones', () => {
  const at = (txt: string) => { const [c] = connectionsOf(parseSkyscannerText(txt, '2026-11-01')); return c; };
  it('"+1" on the departure time, on its own line, overnight, multi-day', () => {
    const mid = at('Outbound\nFri, 13 Nov 2026\n20:00\nTLV Tel Aviv\nLufthansa LH 691\n23:50\nFRA Frankfurt\n50m connection\n00:40+1\nFRA Frankfurt\nLufthansa LH 1166\n02:50+1\nLIS Lisbon');
    expect([mid.outbound.depDate, scheduledConnectionMinutes(mid.inbound, mid.outbound)]).toEqual(['2026-11-14', 50]);
    const own = at('Outbound\nFri, 13 Nov 2026\n20:00\nTLV Tel Aviv\nLufthansa LH 691\n23:50\nFRA Frankfurt\n50m connection\n00:40\n+1\nFRA Frankfurt\nLufthansa LH 1166\n02:50\n+1\nLIS Lisbon');
    expect(scheduledConnectionMinutes(own.inbound, own.outbound)).toBe(50);
    const night = at('Outbound\nFri, 13 Nov 2026\n18:00\nTLV Tel Aviv\nLufthansa LH 691\n21:30\nFRA Frankfurt\n10h 30m connection\n08:00+1\nFRA Frankfurt\nLufthansa LH 1166\n10:10+1\nLIS Lisbon');
    expect(scheduledConnectionMinutes(night.inbound, night.outbound)).toBe(630);
    const two = at('Outbound\nFri, 13 Nov 2026\n08:00\nTLV Tel Aviv\nTurkish Airlines TK 785\n10:30\nIST Istanbul\n1d 23h 30m connection\n10:00+2\nIST Istanbul\nTurkish Airlines TK 1861\n12:20+2\nLIS Lisbon');
    expect(scheduledConnectionMinutes(two.inbound, two.outbound)).toBe(2850);
    expect(connectionTiming(two.inbound, two.outbound, 'IST').status).toBe('too-long');
    const ampm = at('Depart\nWed, Nov 4, 2026\n8:15 PM\nTLV Tel Aviv\nAF1621\n11:50 PM\nCDG Paris\n12:40 AM\nCDG Paris\nAF0010\n2:45 AM\nJFK New York');
    expect(scheduledConnectionMinutes(ampm.inbound, ampm.outbound)).toBe(50);
  });
  it('the departing flight is looked up on its own local date', async () => {
    const c = at('Outbound\nFri, 13 Nov 2026\n20:00\nTLV Tel Aviv\nLufthansa LH 691\n23:50\nFRA Frankfurt\n00:40+1\nFRA Frankfurt\nLufthansa LH 1166\n02:50+1\nLIS Lisbon');
    const q: any[] = [];
    await run(c, null, q);
    expect(q[0]).toMatchObject({ date: '2026-11-13', departureDate: '2026-11-14' });
  });
  it('DST: spring-forward night counts the real 60 min; autumn the real 330 min (Intl zones match the collector)', () => {
    const spring = connectionTiming(leg('AF11', 'JFK', 'CDG', '2027-03-27', '22:40', '2027-03-28', '01:30'), leg('AF1240', 'CDG', 'AMS', '2027-03-28', '03:30', '2027-03-28', '05:00'), 'CDG');
    expect(spring).toMatchObject({ minutes: 60, clockChange: true, status: 'ok' });
    const autumn = connectionTiming(leg('LH691', 'TLV', 'FRA', '2026-10-24', '23:00', '2026-10-25', '01:30'), leg('LH1166', 'FRA', 'LIS', '2026-10-25', '06:00', '2026-10-25', '08:10'), 'FRA');
    expect(autumn.minutes).toBe(330);
    for (const [k, tz] of Object.entries(HUB_TZ)) expect(AIRPORTS[k].tz).toBe(tz);
  });
  it('R-40: today is the local calendar date', () => {
    const d = new Date(2026, 10, 1, 0, 30);   // 00:30 local
    expect(localToday(d)).toBe('2026-11-01');
  });
});

describe('R-41 / R-27: parser robustness', () => {
  it('words starting with a month name do not swallow times; per-leg "Departure" labels are not headings', () => {
    const sep = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\nSeparate tickets\nBook each flight separately\n08:15\nTLV Tel Aviv\nLY 335\n12:05\nCDG Paris\n17:40\nCDG Paris\nAF 1240\n19:05\nAMS Amsterdam', D);
    expect(connectionsOf(sep).map((c) => c.airport)).toEqual(['CDG']);
    const ram = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\nRoyal Air Maroc\n06:10\nTLV Tel Aviv\nAT 1\n10:00\nMAD Madrid\nMarabu\n12:00\nMAD Madrid\nIB 3100\n13:30\nLIS Lisbon', D);
    expect(connectionsOf(ram).map((c) => [c.airport, c.inbound.depTime])).toEqual([['MAD', '06:10']]);
    const lab = parseSkyscannerText('Wed, 4 Nov 2026\nDeparture\n08:15\nTLV Tel Aviv\nAF 1621\nArrival\n12:05\nCDG Paris\nDeparture\n13:40\nCDG Paris\nAF 1240\nArrival\n15:05\nAMS Amsterdam', D);
    expect(lab.journeys).toHaveLength(1);
    expect(connectionsOf(lab).map((c) => c.airport)).toEqual(['CDG']);
  });
  it('aircraft types are not flight numbers; a number is used for one leg only; suffix letters are kept', () => {
    const ac = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\n08:15\nTLV Tel Aviv\nAirbus A320neo\nAir France AF 1621\n12:05\nCDG Paris\n13:40\nCDG Paris\nEmbraer E190\nAir France AF 1240\n15:05\nAMS Amsterdam', D);
    expect(ac.journeys[0].legs.map((l) => [l.flightNumber, l.altNumbers])).toEqual([['AF1621', []], ['AF1240', []]]);
    const after = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\n08:15\nTLV Tel Aviv\n12:05\nCDG Paris\nAF 1621\n13:40\nCDG Paris\n15:05\nAMS Amsterdam\nAF 1240', D);
    const fns = after.journeys[0].legs.map((l) => l.flightNumber);
    expect(fns[0]).not.toBe(fns[1]);
    const suf = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\n08:15\nTLV Tel Aviv\nAF 0010\n12:05\nCDG Paris\n13:40\nCDG Paris\nLH 2416A\n15:05\nMUC Munich', D);
    expect(suf.journeys[0].legs.map((l) => l.flightNumber)).toEqual(['AF10', 'LH2416A']);
  });
});

describe('R-26: flight numbers normalised like the server', () => {
  it('client normaliser = server normaliser; the lookup gets "KL461" for "KL0461"', async () => {
    for (const v of ['AF 0012', 'af12', 'AF012', 'KL0461', 'U2 4801', 'LH2416A', 'KLM461', 'XX', '12', 'AF12345'])
      expect(normFlight(v)).toBe(normFlightNumber(v)?.number ?? null);
    const q: any[] = [];
    await run(conn('AMS', leg('LY0335', 'TLV', 'AMS', D, '06:00', D, '10:00'), leg('KL0461', 'AMS', 'OTP', D, '12:00', D, '15:00')), null, q);
    expect(q[0]).toMatchObject({ arrivalFlight: 'LY335', departureFlight: 'KL461' });
  });
});

describe('R-07: change of airport', () => {
  it('IST → SAW is not assessed and nothing is looked up', async () => {
    const q: unknown[] = [];
    const r = await run(conn('IST', leg('TK785', 'TLV', 'IST', D, '08:00', D, '10:30'), leg('PC1', 'SAW', 'ESB', D, '15:30', D, '16:40'), true), null, q);
    expect(r).toMatchObject({ status: 'airport-change', assessment: null, notAssessed: { code: 'airport-change' } });
    expect(r.notAssessed!.text).toMatch(/change of airport \(IST → SAW\)/);
    expect(q).toEqual([]);
  });
});

describe('R-10: ticket type', () => {
  const ans = answerOf('CDG', flight({ flight: 'AF1621', airport: 'CDG', direction: 'arrival', gateArea: field([['K', 10]]) }), flight({ flight: 'AF1240', airport: 'CDG', direction: 'departure', gateArea: field([['F', 10]]) }));
  it('unknown → both scenarios; the headline is the less favourable; never a silent "protected"', async () => {
    const c = conn('CDG', leg('AF1621', 'TLV', 'CDG', D, '08:00', D, '12:00'), leg('AF1240', 'CDG', 'AMS', D, '13:40', D, '15:05'), null);
    const r = await run(c, ans);
    expect(r.scenarios).not.toBeNull();
    const { protected: p, selfTransfer: s } = r.scenarios!;
    expect(severityOf(r.assessment!)).toBe(Math.max(severityOf(p), severityOf(s)));
    expect(severityOf(s)).toBeGreaterThanOrEqual(severityOf(p));
    expect(r.unknowns.join(' ')).toMatch(/both are shown/);
    const known = await run({ ...c, selfTransfer: false }, ans);
    expect(known.scenarios).toBeNull();
  });
  it('labels count per connection; a negated label does not count; "Separate tickets" does', () => {
    const two = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\n06:00\nTLV Tel Aviv\nLH 687\n09:15\nMUC Munich\nConnect in airport 1h 05m\n10:20\nMUC Munich\nLH 2416\n11:50\nCDG Paris\nSelf transfer · collect and re-check bags\n15:00\nCDG Paris\nAF 1240\n16:25\nAMS Amsterdam', D);
    expect(connectionsOf(two).map((c) => [c.airport, c.selfTransfer])).toEqual([['MUC', null], ['CDG', true]]);
    const neg = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\nProtected connection - this is not a self transfer\n08:15\nTLV Tel Aviv\nAF 1621\n12:05\nCDG Paris\n13:40\nCDG Paris\nAF 1240\n15:05\nAMS Amsterdam', D);
    expect(connectionsOf(neg)[0].selfTransfer).toBeNull();
    const sep = parseSkyscannerText('Outbound\nWed, 4 Nov 2026\nSeparate tickets\n08:15\nTLV Tel Aviv\nLY 335\n12:05\nCDG Paris\n17:40\nCDG Paris\nAF 1240\n19:05\nAMS Amsterdam', D);
    expect(connectionsOf(sep)[0].selfTransfer).toBe(true);
  });
});

describe('R-03: the verdict is monotone in uncertainty and uses marginal shares', () => {
  const fra = MODELS.FRA;
  it('FRA S1: a departure area seen on 15 % of days counts whatever the arrival split (audit AS-1)', () => {
    const dep = res(fra, 'departure', 'DXB', [['Z', 85], ['J', 15]]);
    const split = assessTransfer(fra, res(fra, 'arrival', 'JFK', [['Z', 60], ['C', 40]]), dep, { scheduledMinutes: 75, selfTransfer: false, date: D });
    const sure = assessTransfer(fra, res(fra, 'arrival', 'JFK', [['Z', 100]]), dep, { scheduledMinutes: 75, selfTransfer: false, date: D });
    expect(split.verdict).not.toBe('comfortable');
    expect(severityOf(split)).toBeGreaterThanOrEqual(severityOf(sure));
    // most-likely-route policy: Z → Z (tight on its own) is the primary pair and the headline; the 15 % risky J departure
    // does not move the median, but it carries ≥ the 10 % tolerance, so it is named next to the verdict (never silent)
    expect(split.verdict).toBe(sure.verdict);
    expect(split.verdict).toBe('tight');
    expect(split.likely!.primary).toBe('tight');
    expect(split.drivers.map((d) => d.text).join(' ')).toMatch(/risky if you depart from J/);
  });
  it('property: mixing any distribution toward "unknown" (spread + unmapped) never improves the verdict', () => {
    const cases: [string, string, string, [string, number][], [string, number][]][] = [
      ['FRA', 'JFK', 'DXB', [['Z', 60], ['C', 40]], [['Z', 85], ['J', 15]]],
      ['AMS', 'JFK', 'BCN', [['E', 9], ['F', 1]], [['B', 8], ['C', 2]]],
      ['MUC', 'TLV', 'FCO', [['H', 10]], [['G', 7], ['K', 3]]],
      ['CDG', 'TLV', 'AMS', [['K', 7], ['L', 3]], [['F', 10]]],
    ];
    for (const [ap, o, d, aD, dD] of cases) {
      const m = MODELS[ap];
      // adding unmapped history ("X" gates are not in any model) = more uncertainty at each step
      for (const sched of [45, 60, 75, 90, 120]) {
        let last = -1;
        for (const k of [0, 1, 3, 6, 10, 30]) {
          const a = res(m, 'arrival', o, [...aD, ['QQ', k]]), b = res(m, 'departure', d, [...dD, ['QQ', k]]);
          const v = severityOf(assessTransfer(m, a, b, { scheduledMinutes: sched, selfTransfer: false, date: D }));
          expect(v, `${ap} ${sched} min, +${k} unmapped`).toBeGreaterThanOrEqual(last);
          last = v;
        }
        // and the fully unknown case is never better than any predicted case
        const unk = assessTransfer(m, resolveAreas(m, { direction: 'arrival', other: o, date: D, answer: null }), resolveAreas(m, { direction: 'departure', other: d, date: D, answer: null }), { scheduledMinutes: sched, selfTransfer: false, date: D });
        const pred = assessTransfer(m, res(m, 'arrival', o, aD), res(m, 'departure', d, dD), { scheduledMinutes: sched, selfTransfer: false, date: D });
        expect(severityOf(unk), `${ap} ${sched} unknown vs predicted`).toBeGreaterThanOrEqual(severityOf(pred));
      }
    }
  });
});

describe('R-15: unknown areas', () => {
  it('ZRH unknown, 70 min: no plausible pair is comfortable → not "uncertain" but the worst case, with what drives it', () => {
    const z = MODELS.ZRH;
    const a = resolveAreas(z, { direction: 'arrival', other: 'JFK', date: D, answer: null }), d = resolveAreas(z, { direction: 'departure', other: 'BCN', date: D, answer: null });
    const as = assessTransfer(z, a, d, { scheduledMinutes: 70, selfTransfer: false, date: D });
    expect(as.combos.filter((c) => c.plausible).some((c) => c.verdict === 'comfortable')).toBe(false);
    expect(as.verdict).not.toBe('uncertain');
    expect(as.verdict).toBe('risky');
  });
});

describe('R-20 / R-21 / R-22: probabilities at the level of the evidence', () => {
  it('CDG 2E 70 % / T1 30 %: "Terminal 2E 70 %" is the most likely arrival and the route starts in 2E (illustrative)', async () => {
    const r = await run(conn('CDG', leg('AF1621', 'TLV', 'CDG', D, '08:00', D, '12:00'), leg('AF1240', 'CDG', 'AMS', D, '15:00', D, '16:25')),
      answerOf('CDG', flight({ flight: 'AF1621', airport: 'CDG', direction: 'arrival', terminal: field([['2E', 7], ['1', 3]]) }), flight({ flight: 'AF1240', airport: 'CDG', direction: 'departure', terminal: field([['2F', 10]]) })));
    const s = summarisePlace(r.arrival!);
    expect(s.top[0]).toMatchObject({ short: '2E', p: 0.7 });
    expect(s.others[0].p).toBeCloseTo(0.3);
    const b = bestRoute(MODELS.CDG, r)!;
    expect(b.combo.arrival.area.id).toMatch(/^cdg-2e-/);
    expect(b.illustrative).toBe(true);
    expect(b.sure).toBe(false);
  });
  it('a terminal published for the day that spans three halls is never "sure"', async () => {
    const same = { terminal: '2E', gate: null, gateArea: null, status: 'scheduled', observedAt: `${D}T06:00:00Z`, source: 'aerodatabox' };
    const r = await run(conn('CDG', leg('AF1621', 'TLV', 'CDG', D, '08:00', D, '12:00'), leg('AF1', 'CDG', 'JFK', D, '15:00', D, '17:25')),
      answerOf('CDG', flight({ flight: 'AF1621', airport: 'CDG', direction: 'arrival', status: 'insufficient-data', sameDay: same as any }), flight({ flight: 'AF1', airport: 'CDG', direction: 'departure', status: 'insufficient-data', sameDay: same as any })));
    const b = bestRoute(MODELS.CDG, r)!;
    expect(b.sure).toBe(false);
    expect(b.confidence).toBeLessThan(0.2);
  });
  it('unmapped history stays an explicit share; small areas are kept in the analysis', () => {
    const fra = res(MODELS.FRA, 'departure', 'BCN', [['A', 51], ['QQ', 49]]);
    expect(fra.unassigned).toBeCloseTo(0.49);
    expect(fra.candidates[0].p).toBeCloseTo(0.51);
    const ams = res(MODELS.AMS, 'departure', 'JFK', [['D', 83], ['E', 4], ['F', 4], ['G', 4], ['H', 5]]);
    expect(ams.candidates.map((c) => c.area.short)).toEqual(expect.arrayContaining(['E', 'F', 'G']));
    expect(summarisePlace(ams).top[0].p).toBeCloseTo(0.83);
  });
});

describe('R-08 / R-09 / R-43: gates and same-day values', () => {
  const sd = (gate: string | null, terminal: string | null, status: string) => ({ terminal, gate, gateArea: gate?.[0] ?? null, status, observedAt: `${D}T06:00:00Z`, source: 'aerodatabox' });
  it('a gate is resolved to its own group whatever the passenger zone (AMS D-low for a Schengen flight is kept and flagged)', () => {
    const r = resolveAreas(MODELS.AMS, { direction: 'departure', other: 'OTP', date: D, answer: flight({ flight: 'KL461', airport: 'AMS', direction: 'departure', gate: field([['D2', 3], ['D27', 2], ['D47', 2]]) }) });
    expect(r.candidates.map((c) => c.area.id)).toEqual(['ams-d-n']);
    expect(r.candidates[0].zoneConflict).toBe(true);
    const cdg = resolveAreas(MODELS.CDG, { direction: 'departure', other: 'JFK', date: D, answer: flight({ flight: 'AF1', airport: 'CDG', direction: 'departure', gate: field([['D50', 6]]) }) });
    expect(cdg.candidates.map((c) => c.area.id)).toEqual(['cdg-2d']);
  });
  it('owner decision DA-1: the 30-day history decides; a same-day gate (any status) is only mentioned', () => {
    const hist = { gate: field([['B44', 9]]) };
    const fra = (status: string) => resolveAreas(MODELS.FRA, { direction: 'departure', other: 'JFK', date: D, answer: flight({ flight: 'LH400', airport: 'FRA', direction: 'departure', ...hist, sameDay: sd('Z50', '1', status) as any }) });
    for (const s of ['cancelled', 'scheduled', 'boarding']) {
      const r = fra(s);
      expect(r.provenance).toBe('predicted');
      expect(r.candidates.map((c) => [c.area.id, c.p])).toEqual([['fra-t1-b-n', 1]]);
    }
    expect(fra('scheduled').notes.join(' ')).toMatch(/Gate Z50 is published for this flight-day .* still uses the flight-days in the last 30 days/);
    expect(fra('scheduled').summary).toMatch(/^Predicted from 9 flight-days in the last 30 days/);
  });
  it('without any history, the same-day value is used (observed); a cancelled one is not', () => {
    const r = resolveAreas(MODELS.CDG, { direction: 'departure', other: 'FCO', date: D, answer: flight({ flight: 'AF1', airport: 'CDG', direction: 'departure', sameDay: sd(null, '2G', 'scheduled') as any }) });
    expect(r.provenance).toBe('observed');
    expect(r.candidates[0].area.id).toBe('cdg-2g');
    const c = resolveAreas(MODELS.CDG, { direction: 'departure', other: 'FCO', date: D, answer: flight({ flight: 'AF1', airport: 'CDG', direction: 'departure', sameDay: sd(null, '2G', 'cancelled') as any }) });
    expect(c.provenance).toBe('unknown');
    const hist = resolveAreas(MODELS.CDG, { direction: 'departure', other: 'FCO', date: D, answer: flight({ flight: 'AF1', airport: 'CDG', direction: 'departure', terminal: field([['2F', 10]]), sameDay: sd(null, '2G', 'scheduled') as any }) });
    expect(hist.candidates.every((x) => x.area.id !== 'cdg-2g')).toBe(true);
  });
  it('bare numeric CDG gates map onto "T1 30"', () => {
    const r = resolveAreas(MODELS.CDG, { direction: 'arrival', other: 'TLV', date: D, answer: flight({ flight: 'LY325', airport: 'CDG', direction: 'arrival', gate: field([['30', 8]]) }) });
    expect(r.candidates.map((c) => c.area.id)).toEqual(['cdg-t1-ns']);
  });
});

describe('R-13 / R-29 / R-34 / R-33 / R-14 / R-48: time of day, needed vs moving, caveats, issues, rules', () => {
  it('routes start at the arrival time plus leaving the aircraft, and steps carry clock times', async () => {
    const r = await run(conn('FRA', leg('LH691', 'TLV', 'FRA', D, '18:00', D, '22:50'), leg('LH1166', 'FRA', 'LIS', D, '23:59', '2026-11-05', '02:00')),
      answerOf('FRA', flight({ flight: 'LH691', airport: 'FRA', direction: 'arrival', gateArea: field([['Z', 10]]) }), flight({ flight: 'LH1166', airport: 'FRA', direction: 'departure', gateArea: field([['A', 10]]) })));
    // 22:50 + leaving the aircraft (GENERIC.deplaneContact.typical, 8 min since the 2026-11-02 calibration)
    expect(r.assessment!.time).toBe('22:58');
    expect(r.assessment!.combos[0].route!.steps[0].at).toBe('22:58');
  });
  it('a pair with no route at night is "not assessed: night service unknown", and makes the verdict uncertain at best (R-47)', async () => {
    const m = MODELS.MUC;
    const a = resolveAreas(m, { direction: 'arrival', other: 'FCO', date: D, answer: flight({ flight: 'X', airport: 'MUC', direction: 'arrival', gate: field([['G20', 10]]) }) });
    const d = resolveAreas(m, { direction: 'departure', other: 'FCO', date: D, answer: flight({ flight: 'Y', airport: 'MUC', direction: 'departure', gate: field([['K10', 10]]) }) });
    const as = assessTransfer(m, a, d, { scheduledMinutes: 120, selfTransfer: false, date: D, arrivalTime: '01:30' });
    const c = as.combos[0];
    // T2 G → satellite K needs the PTS (04:00–24:00): at 01:38 it would mean a wait longer than the connection
    expect(c.route).toBeNull();
    expect(c.why).toMatch(/no modelled route at 01:38 \(night service unknown\)/);
    expect(as.verdict).toBe('not-assessed');
    expect(as.verdictText).toMatch(/night service unknown/);
    // in the daytime the same pair is routed
    expect(assessTransfer(m, a, d, { scheduledMinutes: 120, selfTransfer: false, date: D, arrivalTime: '12:00' }).combos[0].route).not.toBeNull();
    // an unroutable plausible pair counts as unbounded time (R-47): half the mass → not assessed; a fifth → never comfortable
    const d2 = resolveAreas(m, { direction: 'departure', other: 'FCO', date: D, answer: flight({ flight: 'Y', airport: 'MUC', direction: 'departure', gate: field([['K10', 5], ['G20', 5]]) }) });
    expect(assessTransfer(m, a, d2, { scheduledMinutes: 100, selfTransfer: false, date: D, arrivalTime: '01:30' }).verdict).toBe('not-assessed');
    const d3 = resolveAreas(m, { direction: 'departure', other: 'FCO', date: D, answer: flight({ flight: 'Y', airport: 'MUC', direction: 'departure', gate: field([['K10', 2], ['G20', 8]]) }) });
    const a3 = assessTransfer(m, a, d3, { scheduledMinutes: 100, selfTransfer: false, date: D, arrivalTime: '01:30' });
    expect(a3.likely!.unassessed).toBeCloseTo(0.2, 2);
    expect(a3.verdict).not.toBe('comfortable');
  });
  it('compact view: the time needed (with the deadline) next to the movement time, never a short "total" alone', async () => {
    const r = await run(conn('FRA', leg('LH691', 'TLV', 'FRA', D, '08:00', D, '12:00'), leg('LH1166', 'FRA', 'MAD', D, '13:00', D, '15:30')),
      answerOf('FRA', flight({ flight: 'LH691', airport: 'FRA', direction: 'arrival', gateArea: field([['Z', 10]]) }), flight({ flight: 'LH1166', airport: 'FRA', direction: 'departure', gateArea: field([['A', 10]]) })));
    const b = bestRoute(MODELS.FRA, r)!;
    expect(b.segments.needed!.typical).toBeGreaterThan(b.segments.movement.typical);
    expect(b.segments.needed).toEqual(b.combo.needed);
  });
  it('overnight caveat, Schengen entry caveat, material route issues and baggage/customs rules', async () => {
    const r = await run(conn('CDG', leg('LY325', 'TLV', 'CDG', D, '18:00', D, '22:00'), leg('AF1240', 'CDG', 'AMS', '2026-11-05', '07:00', '2026-11-05', '08:25')));
    expect(r.caveats.join(' ')).toMatch(/Overnight or long connection/);
    expect(r.caveats.join(' ')).toMatch(/enter the Schengen area at CDG/);
    expect(r.caveats.join(' ')).not.toMatch(FORBIDDEN_WORDS);
    const muc = await run(conn('MUC', leg('LH687', 'TLV', 'MUC', D, '06:00', D, '10:00'), leg('LH2416', 'MUC', 'CDG', D, '13:00', D, '14:30')));
    expect(muc.rules.some((x) => /bag|customs/.test(x.id)) || !MODELS.MUC.rules.some((x) => /bag|customs/.test(x.id))).toBe(true);
  });
  it('every verdict text and short verdict avoids the forbidden words', () => {
    for (const t of Object.values(SHORT_VERDICT)) expect(t).not.toMatch(FORBIDDEN_WORDS);
    const cdg = MODELS.CDG;
    const a = resolveAreas(cdg, { direction: 'arrival', other: 'TLV', date: D, answer: null }), d = resolveAreas(cdg, { direction: 'departure', other: 'AMS', date: D, answer: null });
    for (const v of [null, 20, 60, 95, 240] as (number | null)[]) for (const st of [false, true]) expect(assessTransfer(cdg, a, d, { scheduledMinutes: v, selfTransfer: st, date: D }).verdictText).not.toMatch(FORBIDDEN_WORDS);
  });
});

// ---- all-pairs verdict snapshot (R-39): any change of models, router or allowances shows up as a diff ----
describe('all-pairs verdict snapshot', () => {
  it('protected and self-transfer needed minutes and verdicts for every ordered gate-area pair of every airport', async () => {
    const out: Record<string, string[]> = {};
    for (const [iata, m] of Object.entries(MODELS).sort()) {
      const areas = m.areas.filter((a) => a.side === 'airside' && m.gateGroups.some((g) => g.area === a.id && g.gates.length)).map((a) => a.id);
      const lines: string[] = [];
      for (const st of [false, true]) {
        // one pair at a time: certain areas on both sides
        for (const x of areas) for (const y of areas) {
          const r1: Resolution = { direction: 'arrival', zone: null, candidates: [{ area: m.areas.find((a) => a.id === x)!, p: 1, evidence: 1, via: [] }], groups: [{ label: x, p: 1, areas: [x] }], unassigned: 0, areaLevel: true, provenance: 'observed', basis: 'gate', sample: null, summary: '', notes: [] };
          const r2: Resolution = { ...r1, direction: 'departure', candidates: [{ area: m.areas.find((a) => a.id === y)!, p: 1, evidence: 1, via: [] }], groups: [{ label: y, p: 1, areas: [y] }] };
          const as = assessTransfer(m, r1, r2, { scheduledMinutes: 75, selfTransfer: st, date: '2026-11-15', arrivalTime: '12:00' });
          const c = as.combos[0];
          lines.push(`${st ? 'self' : 'prot'} ${x}>${y} ${c.needed ? `${c.needed.typical}/${c.needed.max}` : 'none'} ${as.verdict}`);
        }
      }
      out[iata] = lines;
    }
    await expect(JSON.stringify(out, null, 1)).toMatchFileSnapshot('./snapshots/all-pairs-verdicts.json');
  });
});
const _v: Verdict = 'comfortable'; void _v;

describe('R-19 with the research data (CR-B4, CR-B5)', () => {
  it('MUC → Tel Aviv departs from Hall F (gate-less area); CDG El Al uses the 50-min presence deadline', async () => {
    const muc = await run(conn('MUC', leg('LH2417', 'CDG', 'MUC', D, '08:00', D, '09:30'), leg('LH686', 'MUC', 'TLV', D, '13:00', D, '17:30')));
    expect(muc.departure!.candidates.map((c) => c.area.id)).toEqual(['muc-hall-f']);
    const cdg = await run(conn('CDG', leg('AF1240', 'AMS', 'CDG', D, '08:00', D, '09:20'), leg('LY324', 'CDG', 'TLV', D, '13:00', D, '18:00')),
      answerOf('CDG', flight({ flight: 'AF1240', airport: 'CDG', direction: 'arrival', terminal: field([['2F', 10]]) }), flight({ flight: 'LY324', airport: 'CDG', direction: 'departure', terminal: field([['2B', 10]]) })));
    const c = cdg.assessment!.combos.find((x) => x.departure.area.id === 'cdg-2b' && x.route)!;
    expect(c.route!.deadline?.minutes).toBe(50);
    expect(c.needed!.typical).toBeGreaterThan(c.movement!.typical + 40);   // 50-min deadline, not El Al's 10-min gate close
  });
});

// Transfer assessment: route the (arrival area × departure area) pairs on the airport model and compare the scheduled
// connection with the time the transfer needs. Indicative only: allowances are stated assumptions or published airline
// deadlines, on-time arrival is assumed, and no verdict ever claims a connection will work.
//
// The two research modules (Agent B, docs/research/) are wired at ONE point each:
//   - combineParts(...) → timing.ts `combine` (comonotonic groups + quantile convolution, R-31);
//   - assessRisk(...)   → risk.ts `assessSides` (interval probabilities, IDM open mass, unmapped kept; R-03, R-15, R-22, R-47).
import type { AirportModel, Minutes } from '../../../airportmaps/src/types.ts';
import { findGate, findRoute, findSelfTransfer, noRouteReason, specialScreeningFor, type Profile, type Route, type RouteIssue, type Step } from '../../../airportmaps/src/route.ts';
import { SCHENGEN, UK_CTA } from './airports.ts';
import type { AreaCandidate, Resolution } from './resolve.ts';
import { assessSides, categorize, likelyVerdict, RISK, type LikelyVerdict, type Outcome, type RiskAssessment, type SideEvidence } from './risk.ts';
import { calibratePassport, DEFAULT_STATUS, type CalibratedSteps, type PassengerStatus } from './calibration.ts';
import { checkInCloseFor, combine, correlationOf, gateCloseFor, GENERIC, screeningPolicy, securityDeadlineFor, type Allowance, type Part } from './timing.ts';

/** Allowances shown to the traveller (generic values; airline-specific deadlines replace gateClose / checkInClose). */
export const ASSUMPTIONS = {
  deplane: GENERIC.deplaneContact,
  deplaneBus: GENERIC.deplaneBus,
  gateClose: GENERIC.gateClose,
  baggage: GENERIC.baggage,
  bagDrop: GENERIC.bagDrop,
  checkInClose: GENERIC.checkInClose,
  /** Pessimistic margin (high values) at or above this → "comfortable on our estimates" (risk.ts RISK). */
  comfortableMargin: RISK.comfortableMargin,
  /** Typical margin below this → "risky". Between → "tight". */
  riskyMargin: RISK.riskyMargin,
  /** A side's area is shown as plausible (drivers, most likely route) when its evidence share plus the unmapped share
   *  reaches this (the risk tolerance). */
  plausibleShare: RISK.tolerance,
};

/** 'uncertain': a side has no evidence and its possible areas lead to different categories ("depends on the area"). */
export type Verdict = 'comfortable' | 'tight' | 'risky' | 'uncertain' | 'not-assessed';
/** Severity order of headline verdicts ('uncertain' and 'not-assessed' rank with risky: neither is reassuring). */
export const SEVERITY: Record<Verdict, number> = { comfortable: 0, tight: 1, risky: 2, uncertain: 2, 'not-assessed': 2 };
/** Severity of the headline (used to pick the less favourable ticket scenario, R-10). */
export const severityOf = (a: Pick<Assessment, 'verdict'>) => SEVERITY[a.verdict];

export type Span = { min: number; typical: number; max: number };

export interface Combo {
  arrival: AreaCandidate;
  departure: AreaCandidate;
  p: number;                                   // joint routing weight (independent lookups; not a calibrated probability)
  /** Joint evidence share (each side's evidence-level share): used for the "most likely" ranking and the drivers. */
  evidence: number;
  /** Both sides are plausible (evidence + unmapped share ≥ the tolerance, or the side is not predicted). */
  plausible: boolean;
  route: Route | null;                         // one route (a self-transfer includes reclaim, check-in and security)
  /** Moving between the areas: leaving the aircraft + the route's steps (no deadlines). typical = Σ typicals. */
  movement: Span | null;
  /** Time needed to make the flight (combined: typical = median of the sum, max = 90th percentile; timing.ts). */
  needed: Span | null;
  margin: { typical: number; pessimistic: number } | null;         // scheduled − needed
  verdict: Verdict;
  why: string;
}

export interface Driver { combo: Combo; text: string }

export interface Assessment {
  scheduledMinutes: number | null;
  selfTransfer: boolean;
  /** Local clock time the routes start at (arrival + leaving the aircraft), when known. */
  time: string | null;
  combos: Combo[];
  verdict: Verdict;
  /** Conservative / optimistic bounds of the interval model over EVERY possible area (risk.ts assessConnection): the
   *  robustness view shown in the details; the headline is `likely`. */
  worst: 'comfortable' | 'tight' | 'risky' | 'not-assessed';
  best: 'comfortable' | 'tight' | 'risky' | 'not-assessed';
  risk: RiskAssessment | null;
  /** The headline: the connection the passenger most likely experiences (risk.ts likelyVerdict). */
  likely: LikelyVerdict | null;
  /** The most likely pair (the displayed route). */
  primary: Combo | null;
  /** good = history for both sides; limited = a side from fewer than LIMITED_SAMPLE flight-days; none = a side not predicted. */
  dataQuality: 'good' | 'limited' | 'none';
  verdictText: string;
  /** Routing weight per verdict over the listed pairs, plus the unmapped share (R-22). */
  spread: Record<Verdict, number> & { unmapped: number };
  /** Plausible pairs that make the verdict worse than the most likely pair ("risky if you depart from J"). */
  drivers: Driver[];
  range: { min: number; max: number } | null;   // needed minutes, typical, over the plausible pairs
  /** The deadline used before departure (airline-specific when published). */
  deadline: { label: string; minutes: number; text: string };
  /** Route issues of the plausible pairs (each code once, at its highest level). */
  issues: RouteIssue[];
  notes: string[];
}

/** THE time-combination point: timing.ts `combine`; typical = median of the sum, max = its 90th percentile. */
export function combineParts(parts: Part[]): Span {
  const c = combine(parts);
  return { min: c.min, typical: c.median, max: c.high };
}
/** Independent spans combined (kept for callers without step kinds). */
export const combineSpans = (...xs: Span[]): Span => combineParts(xs.map((x, i) => ({ minutes: x, group: `x${i}` })));
/** @deprecated use combineParts / combineSpans */
export const add = combineSpans;

const kindOf = (k: Step['kind']) => (k === 'to-platform' || k === 'from-platform' ? 'walk' : k);
const stepParts = (steps: Step[]): Part[] => steps.map((s) => ({ minutes: s.minutes, group: s.kind, correlated: correlationOf(kindOf(s.kind), s.control?.kind), label: s.text }));
const fixedSpan = (v: number): Minutes => ({ min: v, typical: v, max: v, basis: 'published' });

/** Issues that mean the needed time is incomplete (risk.ts caps such a pair at "tight"). Eligibility warnings
 *  (entering a country, two passport controls) and conservative assumptions (origin unknown → control applied) do not. */
const TIME_INCOMPLETE = new Set(['unestablished-step', 'hours-unpublished', 'service-hours-assumed', 'check-in-hall-unknown', 'special-screening-time-unknown', 'special-screening-area']);

const plausibleSide = (c: AreaCandidate, r: Resolution) => r.provenance === 'unknown' || c.evidence + r.unassigned >= ASSUMPTIONS.plausibleShare - 1e-9;
const pct = (p: number) => `${Math.round(p * 100)} %`;
const label = (c: AreaCandidate) => (c.group ? `${c.area.short} (${c.group})` : c.area.short);

/** Evidence of one side for risk.ts, at its own level (never rescaled; unmapped kept; zone-only = vacuous). */
export function sideEvidence(r: Resolution): SideEvidence {
  const universe = [...new Set([...r.candidates.map((c) => c.area.id), ...(r.universe ?? [])])];
  if (r.provenance === 'unknown') return { kind: 'unknown', candidates: r.candidates.map((c) => ({ ids: [c.area.id], p: c.p })), universe };
  const candidates = r.groups.length ? r.groups.map((g) => ({ ids: g.areas, p: g.p })) : r.candidates.map((c) => ({ ids: [c.area.id], p: c.evidence }));
  // a published value blended with history may still change: it is passed as history with its sample (risk.ts §8)
  const pure = r.provenance === 'observed' && !r.sample;
  return { kind: pure ? 'observed' : 'predicted', candidates, unmapped: r.unassigned, sample: pure ? null : r.sample, universe };
}

/** THE verdict point: risk.ts over both sides' evidence; `outcome` gives the needed time of any area pair. */
export function assessRisk(arr: Resolution, dep: Resolution, scheduled: number | null, outcome: (a: string, d: string) => Outcome): RiskAssessment {
  return assessSides(sideEvidence(arr), sideEvidence(dep), scheduled, outcome);
}

/**
 * Special screenings of a route that have no published minutes (route issue 'special-screening-time-unknown'), resolved
 * by timing.ts SCREENING_POLICY: a bound becomes a timed step, a derived deadline replaces boarding close, an
 * existence-unknown one stays a warning; a REQUIRED one with no policy makes the time "not established".
 */
export function boundScreening(route: Route, m: AirportModel, p: Profile): { route: Route; deadline: Allowance | null; insufficient: string | null } {
  // every screening of the flight applies, whichever area this pair departs from (a mismatch is its own issue)
  const ss = specialScreeningFor(m, p).filter((s) => !s.minutes);
  const steps = [...route.steps], issues = route.issues.filter((i) => i.code !== 'special-screening-time-unknown');
  let deadline: Allowance | null = null;
  for (const s of ss) {
    const pol = screeningPolicy(s);
    if (!pol) return { route, deadline: null, insufficient: `a required additional screening has no known or boundable duration (${s.text.slice(0, 120)}…): the time is not established` };
    if (pol.kind === 'bound') {
      steps.push({ kind: 'control', text: `Additional screening (allowance: ${pol.minutes.text.split(':')[0]})`, from: route.to, to: route.to, minutes: pol.minutes, control: { kind: 'special-screening', minutes: pol.minutes, note: s.text }, confidence: 'inferred', sources: pol.minutes.sources });
      issues.push({ level: 'material', code: 'special-screening-bounded', text: `Additional screening for this flight: ${s.text} No duration is published; a conservative allowance of up to ${pol.minutes.max} min is included.` });
    } else if (pol.kind === 'deadline') {
      if (!deadline || pol.deadline.typical > deadline.typical) deadline = pol.deadline;
      issues.push({ level: 'material', code: 'special-screening-bounded', text: `Additional screening for this flight: ${s.text} No deadline is published here; the time needed assumes you must be at the gate about ${pol.deadline.typical} min (up to ${pol.deadline.max}) before departure, as the airline requires at its other stations.` });
    } else if (pol.kind === 'possible') {
      issues.push({ level: s.issueLevel ?? 'material', code: 'special-screening-possible', text: `An additional check may apply to this flight (not established, so no time is included): ${s.text}` });
    } else {
      issues.push({ level: pol.kind === 'informational' ? 'secondary' : s.issueLevel ?? 'material', code: 'special-screening', text: `Additional screening for this flight: ${s.text}` });
    }
  }
  return { route: { ...route, steps, issues }, deadline, insufficient: null };
}

// rounded to the whole minute first (before: 659.6 → "10:60")
const hhmm = (t0: number) => { const t = ((Math.round(t0) % 1440) + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export interface TransferOptions {
  scheduledMinutes: number | null;
  selfTransfer: boolean;
  date: string;
  /** Local arrival time "HH:MM" (the clock starts after leaving the aircraft). */
  arrivalTime?: string | null;
  /** Passenger-dependent procedures: inbound origin, outbound destination and airline. */
  profile?: Pick<Profile, 'originAirport' | 'originCountry' | 'destinationAirport' | 'destinationCountry' | 'airline'>;
  /** EES status of the traveller (settings; never sent anywhere). Not given → EES-registered values (calibration.ts). */
  passenger?: PassengerStatus;
}

/** European countries outside Schengen counted as short-haul at LHR (BA: "UK domestic and short-haul" = Europe). */
const EUROPE_NON_SCHENGEN = new Set(['AL', 'AD', 'BA', 'CY', 'GI', 'MD', 'ME', 'MK', 'MC', 'RS', 'SM', 'XK', 'UA', 'VA', 'FO']);
/** Whether a departure counts as long-haul for check-in deadlines (outside Schengen / UK / Ireland; at IST: international;
 *  at LHR: outside the UK, the Common Travel Area and Europe). */
export function longHaul(hub: string, destCountry?: string): boolean {
  if (!destCountry) return true;   // unknown → the longer deadline (conservative)
  if (hub === 'IST') return destCountry !== 'TR';
  if (hub === 'LHR') return !(UK_CTA.has(destCountry) || SCHENGEN.has(destCountry) || EUROPE_NON_SCHENGEN.has(destCountry));
  return !(SCHENGEN.has(destCountry) || destCountry === 'GB' || destCountry === 'IE');
}

export function assessTransfer(m: AirportModel, arr: Resolution, dep: Resolution, o: TransferOptions): Assessment {
  // clock: arrival + leaving the aircraft (R-13); the route may roll over midnight
  let date = o.date, time: string | null = null;
  const deplaneTyp = GENERIC.deplaneContact.typical;
  if (o.arrivalTime) {
    const t = Number(o.arrivalTime.slice(0, 2)) * 60 + Number(o.arrivalTime.slice(3, 5)) + deplaneTyp;
    if (t >= 1440) date = addDays(o.date, 1);
    time = hhmm(t);
  }
  const maxWait = o.scheduledMinutes ?? 0;   // a longer wait for a first service cannot help
  const base0: Profile = { transfer: true, fromArrival: true, date, time: time ?? undefined, maxWait, ...o.profile };
  // apron-bus arrivals: the clock starts deplaneBus.typical after arrival instead of deplaneContact.typical
  const baseBus: Profile = (() => {
    if (!o.arrivalTime) return base0;
    const t = Number(o.arrivalTime.slice(0, 2)) * 60 + Number(o.arrivalTime.slice(3, 5)) + GENERIC.deplaneBus.typical;
    return { ...base0, date: t >= 1440 ? addDays(o.date, 1) : o.date, time: hhmm(t) };
  })();
  const airline = o.profile?.airline ?? null;
  const gateClose = gateCloseFor(airline);
  const checkInClose = checkInCloseFor(airline, longHaul(m.iata, o.profile?.destinationCountry), o.profile?.destinationCountry, m.iata);
  // an airline deadline for being through security at this airport (BA at LHR: 35 min), applied at the last screening step
  const securityBy = securityDeadlineFor(airline, m.iata);
  // deplaning: by apron bus when the arrival evidence points at bus gates
  const busGate = (c: AreaCandidate) => c.via.some((g) => findGate(m, g)?.group.bus);
  const byId = new Map<string, AreaCandidate>();
  for (const c of [...arr.candidates, ...dep.candidates]) if (!byId.has(c.area.id)) byId.set(c.area.id, c);
  const cand = (id: string, list: AreaCandidate[]): AreaCandidate => list.find((c) => c.area.id === id) ?? { area: m.areas.find((a) => a.id === id)!, p: 0, evidence: 0, via: [] };

  const cache = new Map<string, Combo>();
  let passportApplied: CalibratedSteps['applied'] = [];
  const comboOf = (aId: string, dId: string): Combo => {
    const key = `${aId}|${dId}`;
    const hit = cache.get(key); if (hit) return hit;
    const a = cand(aId, arr.candidates), d = cand(dId, dep.candidates);
    // the route clock starts when this pair's passenger has left the aircraft: later after an apron-bus arrival (AU-4)
    const bus = busGate(a);
    const base = bus ? baseBus : base0;
    let route = o.selfTransfer ? findSelfTransfer(m, aId, dId, { ...base, reclaim: GENERIC.baggage, bagDrop: GENERIC.bagDrop }) : findRoute(m, aId, dId, base);
    let noRoute: string | null = null;
    if (!route) {
      const why = noRouteReason(m, aId, dId, { ...base, transfer: !o.selfTransfer });
      noRoute = why === 'closed-at-time' ? `no modelled route at ${time} (night service unknown)` : why === 'closed-area' ? 'an area is closed on that date' : 'no modelled route';
    } else if (route.issues.some((i) => i.level === 'blocking')) { noRoute = route.issues.find((i) => i.level === 'blocking')!.text; route = null; }
    // the usual checkpoint is CLOSED when reached and the only modelled way is an unconfirmed fallback: the procedure at
    // this hour is not established, like a closed night line (not ordinary route uncertainty; VERDICT_POLICY_REVIEW §4)
    else if (route.issues.some((i) => i.code === 'checkpoint-closed')) { noRoute = `the usual transfer checkpoint is closed at ${time}; the night procedure is not established`; route = null; }
    // passport controls: calibrated minutes by airport, direction and EES status where the evidence supports one
    if (route) {
      const cal = calibratePassport(m.iata, route.steps, { arrZone: arr.zone, depZone: dep.zone, selfTransfer: o.selfTransfer, status: o.passenger });
      if (cal.applied.length) {
        // the shown clock follows the calibrated minutes (AU-5; opening hours were checked by the router on the model's
        // own passport minutes, a few minutes apart: docs/REMAINING_AIRPORT_ROUTING_GAPS.md)
        const t0 = cal.steps[0]?.at;
        const steps = t0 ? cal.steps.map((s) => ({ ...s })) : cal.steps;
        if (t0) { let t = Number(t0.slice(0, 2)) * 60 + Number(t0.slice(3, 5)); for (const s of steps) { s.at = hhmm(t); t += s.minutes.typical; } }
        route = { ...route, steps }; passportApplied = cal.applied;
      }
    }
    // required special screening without published minutes: bounded, or the pair's time is not established (Example C)
    let screenDeadline: Allowance | null = null;
    if (route && route.issues.some((i) => i.code === 'special-screening-time-unknown')) {
      const r = boundScreening(route, m, base);
      if (r.insufficient) { noRoute = r.insufficient; route = null; } else { route = r.route; screenDeadline = r.deadline; }
    }
    let movement: Span | null = null, needed: Span | null = null;
    if (route) {
      const deplane = bus ? GENERIC.deplaneBus : GENERIC.deplaneContact;
      const dPart: Part = { minutes: deplane, group: 'deplane' };
      const steps = stepParts(route.steps);
      // a published presence deadline of a special screening replaces boarding close when later (CR-B4); a derived
      // deadline bound (timing.ts SCREENING_POLICY) likewise
      let gate: Minutes = route.deadline && route.deadline.minutes > gateClose.typical ? fixedSpan(route.deadline.minutes) : gateClose;
      if (screenDeadline && screenDeadline.typical > gate.typical) gate = screenDeadline;
      const c = combine([dPart, ...steps]);
      movement = { min: c.min, typical: Math.round((deplane.typical + route.steps.reduce((s, x) => s + x.minutes.typical, 0)) * 10) / 10, max: c.high };
      let gateBranch = combineParts([dPart, ...steps, { minutes: gate, group: 'gate-close' }]);
      // through security by the airline's deadline: the route up to the end (protected: "clear security") or the start
      // (self-transfer: "enter security") of its last screening step, plus the deadline; the later branch decides
      const iSec = route.steps.map((s) => s.control?.kind === 'security' || s.control?.kind === 'transfer-security').lastIndexOf(true);
      if (securityBy && iSec >= 0) {
        const secBranch = combineParts([dPart, ...stepParts(route.steps.slice(0, o.selfTransfer ? iSec : iSec + 1)), { minutes: securityBy, group: 'security-deadline' }]);
        gateBranch = { min: Math.max(secBranch.min, gateBranch.min), typical: Math.max(secBranch.typical, gateBranch.typical), max: Math.max(secBranch.max, gateBranch.max) };
      }
      if (!o.selfTransfer) needed = gateBranch;
      else {
        const k = route.checkIn?.step ?? route.steps.length - 1;
        const ciBranch = combineParts([dPart, ...stepParts(route.steps.slice(0, k + 1)), { minutes: checkInClose, group: 'check-in-close' }]);
        needed = { min: Math.max(ciBranch.min, gateBranch.min), typical: Math.max(ciBranch.typical, gateBranch.typical), max: Math.max(ciBranch.max, gateBranch.max) };
      }
    }
    const outcome: Outcome = { needed: needed ? { typical: needed.typical, high: needed.max } : null, issues: (route?.issues ?? []).filter((i) => i.level === 'blocking' || TIME_INCOMPLETE.has(i.code)) };
    const cat = categorize(outcome, o.scheduledMinutes);
    const margin = o.scheduledMinutes !== null && needed ? { typical: o.scheduledMinutes - needed.typical, pessimistic: o.scheduledMinutes - needed.max } : null;
    const why = o.scheduledMinutes === null ? 'scheduled connection time unknown' : !needed ? noRoute ?? 'no modelled route'
      : `${o.scheduledMinutes} min scheduled; about ${needed.typical} min needed (up to ${needed.max} with long queues and waits)`;
    const combo: Combo = { arrival: a, departure: d, p: a.p * d.p, evidence: a.evidence * d.evidence, plausible: a.evidence + d.evidence > 0 && plausibleSide(a, arr) && plausibleSide(d, dep), route, movement, needed, margin, verdict: cat ?? 'not-assessed', why };
    cache.set(key, combo);
    return combo;
  };
  for (const a of arr.candidates) for (const d of dep.candidates) comboOf(a.area.id, d.area.id);
  const risk = assessRisk(arr, dep, o.scheduledMinutes, (aId, dId) => {
    const c = comboOf(aId, dId);
    return { needed: c.needed ? { typical: c.needed.typical, high: c.needed.max } : null, issues: (c.route?.issues ?? []).filter((i) => TIME_INCOMPLETE.has(i.code)), label: `${c.arrival.area.short} → ${c.departure.area.short}` };
  });
  const combos = [...cache.values()].filter((c) => c.p > 0 || arr.candidates.some((x) => x.area.id === c.arrival.area.id) && dep.candidates.some((x) => x.area.id === c.departure.area.id))
    .sort((x, y) => y.evidence - x.evidence || y.p - x.p);
  const spread = { comfortable: 0, tight: 0, risky: 0, uncertain: 0, 'not-assessed': 0, unmapped: 0 } as Assessment['spread'];
  for (const c of combos) spread[c.verdict] += c.p;
  spread.unmapped = Math.max(0, 1 - combos.reduce((s, c) => s + c.p, 0));
  const pool = combos.filter((c) => c.plausible);
  // ---- headline: the most likely route and the connection the passenger most likely experiences (VERDICT_POLICY_REVIEW.md)
  const top = primaryCombo(combos);
  const noEvidence = arr.provenance === 'unknown' || dep.provenance === 'unknown';
  const keyOf = (c: Combo) => `${c.arrival.area.id}|${c.departure.area.id}`;
  const points = [...cache.values()].filter((c) => c.p > 0);
  const likely = likelyVerdict(points.map((c) => ({ p: c.p, needed: c.needed ? { min: c.needed.min, typical: c.needed.typical, high: c.needed.max } : null, label: keyOf(c), primary: c === top, reason: c.needed ? undefined : c.why })), o.scheduledMinutes, { noEvidence });
  const verdict: Verdict = o.scheduledMinutes === null || !top ? 'not-assessed' : likely.verdict;
  // drivers: the worse alternatives that changed the verdict (or that it depends on), most likely first
  const drivers: Driver[] = [];
  // Worse alternatives are grouped by the area that differs from the most likely pair (a departure area's share counts
  // whatever the arrival split, audit AS-1): "if you depart from J" carries the summed share of every worse pair ending at J.
  const sh = (x: AreaCandidate, r: Resolution) => (r.provenance === 'unknown' ? '' : ` (${pct(x.evidence)})`);
  const groups = new Map<string, { text: string; p: number; combo: Combo }>();
  for (const w of likely.worse) {
    const c = cache.get(w.label);
    if (!c || !top) continue;
    const dd = c.departure.area.id !== top.departure.area.id, da = c.arrival.area.id !== top.arrival.area.id;
    if (!dd && !da) continue;
    const key = dd ? `d:${c.departure.area.id}` : `a:${c.arrival.area.id}`;
    const text = dd ? `if you depart from ${label(c.departure)}${sh(c.departure, dep)}` : `if you arrive at ${label(c.arrival)}${sh(c.arrival, arr)}`;
    const g = groups.get(key) ?? { text, p: 0, combo: c };
    g.p += w.p;
    if (SEVERITY[c.verdict] > SEVERITY[g.combo.verdict] || (c.verdict === 'not-assessed' && g.combo.verdict !== 'not-assessed')) g.combo = c;
    groups.set(key, g);
  }
  const driverText = (g: { text: string; combo: Combo }) => `${g.combo.verdict === 'not-assessed' ? 'not assessed' : g.combo.verdict} ${g.text}${g.combo.needed ? `: about ${Math.round(g.combo.needed.typical)} min needed` : g.combo.why ? ` (${g.combo.why})` : ''}`;
  const minor: string[] = [];
  for (const g of [...groups.values()].sort((x, y) => y.p - x.p)) {
    const bad = g.combo.verdict === 'risky' || g.combo.verdict === 'not-assessed';
    // shown with the verdict: the alternatives that changed it (or that it depends on), and — never silent — a risky or
    // unassessable alternative carrying at least the risk tolerance (10 %, owner-kept DR-B1) even when it did not
    const significant = bad && g.p >= RISK.tolerance - 1e-9 && verdict !== 'risky';
    if ((likely.changed || verdict === 'uncertain' || significant) && drivers.length < 3) drivers.push({ combo: g.combo, text: driverText(g) });
    else if (bad) minor.push(`${driverText(g)}${noEvidence ? '' : `, ${pct(g.p)} of past cases`}`);
  }

  const typicals = pool.filter((c) => c.needed).map((c) => c.needed!.typical);
  const RANK = { blocking: 0, material: 1, secondary: 2 } as const;
  const issues: RouteIssue[] = [];
  for (const c of pool) for (const i of c.route?.issues ?? []) {
    const k = issues.findIndex((x) => x.code === i.code);
    if (k < 0) issues.push(i); else if (RANK[i.level] < RANK[issues[k].level]) issues[k] = i;
  }
  const notes: string[] = [];
  if (likely.needed && verdict !== 'not-assessed') notes.push(`Over the likely areas (weighted by past use) the transfer needs about ${fmtNeeded(likely.needed.typical)} (up to ${fmtNeeded(likely.needed.high)}).`);
  if (likely.unassessed > 0.005 && verdict !== 'not-assessed') notes.push(`${pct(likely.unassessed)} of the likely area combinations have no established time and are counted as possibly missed.`);
  if (minor.length) notes.push(`Less likely, not changing the verdict: ${minor.slice(0, 3).join('; ')}.`);
  const un = Math.max(arr.unassigned, dep.unassigned);
  if (un >= RISK.tolerance && !noEvidence) notes.push(`${pct(un)} of the earlier flights used gates that are not on our map; they are left out of the estimate.`);
  if (passportApplied.length && m.iata === 'LHR') notes.push(`UK border control at Heathrow uses the Heathrow MTI queue figures for ${(o.passenger ?? DEFAULT_STATUS) === 'ees-exempt' ? 'EU/EEA/Swiss passports (EEA lanes and eGates)' : `other passports (non-EEA lanes, e.g. Israel${o.passenger ? '' : '; change in settings if you hold an EU/EEA/Swiss passport'})`}: about ${passportApplied[0].minutes.typical} min, up to ${passportApplied[0].minutes.max}. Entering the UK needs an ETA or a visa for most passports; this is not checked here.`);
  else if (passportApplied.length) notes.push(`Passport control uses ${m.iata} ${passportApplied.map((x) => x.dir).join(' / ')} queue estimates for ${(o.passenger ?? DEFAULT_STATUS) === 'ees-exempt' ? 'travellers not registered in EES (EU/EEA/Swiss citizens, Schengen residence permits)' : `travellers registered in the EU Entry/Exit System (non-EU passports${o.passenger ? '' : '; change in settings if you hold an EU/EEA/Swiss passport or a Schengen residence permit'})`}: about ${passportApplied[0].minutes.typical} min, up to ${passportApplied[0].minutes.max}.`);
  if (risk.text) notes.push(`Robustness check (every possible area, interval model): ${risk.text}`);
  if (pool.some((c) => !c.route)) notes.push(`Some plausible area combinations have no usable modelled route${time ? ` at ${time}` : ''}.`);
  notes.push('Assumes both flights on time. Delays, missed boarding and airline rules beyond the published deadlines are not modelled.');
  const dt = drivers.length ? ` (${drivers.map((d) => d.text).join('; ')})` : '';
  const span = [...new Set(points.map((c) => c.verdict))].sort((x, y) => SEVERITY[x] - SEVERITY[y]);
  const verdictText = {
    comfortable: 'Looks comfortable on our estimates (estimates, not a promise)',
    tight: `Tight: feasible on typical times, little margin for queues, waits or delays${dt}`,
    risky: `Risky: the scheduled time is shorter than or close to what the transfer typically needs${dt}`,
    uncertain: `Depends on the area, which is not predicted: ${span.map((x) => (x === 'not-assessed' ? 'not assessed' : x)).join(' to ')} depending on where you arrive and depart${dt}`,
    'not-assessed': o.scheduledMinutes === null ? 'Not assessed: the scheduled connection time is unknown'
      : top && likely.primary === 'not-assessed' ? `Not assessed: ${top.why}`
      : likely.unassessed >= 0.5 ? `Not assessed: most of the likely area combinations have no established time${points.some((c) => /night service/.test(c.why)) ? ` (no modelled route at ${time}; night service unknown)` : ''}`
      : pool.some((c) => /night service/.test(c.why)) ? `Not assessed: no modelled route at ${time} (night service unknown)` : 'Not assessed: no modelled route between the likely areas',
  }[verdict];
  const deadline = o.selfTransfer ? { label: 'Check-in closes', minutes: checkInClose.typical, text: checkInClose.text } : { label: 'Boarding closes', minutes: gateClose.typical, text: gateClose.text };
  if (securityBy) notes.push(`${securityBy.text}; the time needed also checks this deadline.`);
  const limited = (r: Resolution) => r.provenance === 'predicted' && r.sample !== null && r.sample < LIMITED_SAMPLE;
  const dataQuality: Assessment['dataQuality'] = noEvidence ? 'none' : limited(arr) || limited(dep) ? 'limited' : 'good';

  return { scheduledMinutes: o.scheduledMinutes, selfTransfer: o.selfTransfer, time, combos, verdict, worst: risk.worst, best: risk.best, risk, likely, primary: top, dataQuality, verdictText, spread, drivers, range: typicals.length ? { min: Math.min(...typicals), max: Math.max(...typicals) } : null, deadline, issues, notes };
}

const fmtNeeded = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} min` : 'an unknown time');

/** Below this many flight-days a predicted area is "limited history": the route is shown as illustrative (Example D;
 *  the same 5 as the product rule "no percentages for samples under 5"). */
export const LIMITED_SAMPLE = 5;

const CONF_RANK: Record<string, number> = { verified: 3, probable: 2, inferred: 1, unknown: 0 };
/**
 * THE most likely pair (the route shown, and the verdict's primary scenario): among routed pairs without a blocking
 * issue — plausible ones first — the highest evidence-level likelihood; ties → the route the model is most confident
 * in, then the median transfer time of the tied pairs (a representative route, neither a trivial nor an unusual one).
 */
export function primaryCombo(combos: Combo[]): Combo | null {
  const routed = combos.filter((c) => c.route && !c.route.issues.some((i) => i.level === 'blocking'));
  if (!routed.length) return combos.filter((c) => c.plausible).sort((x, y) => y.evidence - x.evidence || y.p - x.p)[0] ?? null;
  const plausible = routed.filter((c) => c.plausible);
  const pool = plausible.length ? plausible : routed;
  const key = (c: Combo) => Math.round(c.evidence * 1000);
  const conf = (c: Combo) => CONF_RANK[c.route!.confidence] ?? 0;
  const ranked = [...pool].sort((x, y) => key(y) - key(x) || conf(y) - conf(x) || (x.needed?.typical ?? 0) - (y.needed?.typical ?? 0));
  const tied = ranked.filter((c) => key(c) === key(ranked[0]) && conf(c) === conf(ranked[0]));
  return tied[Math.floor(tied.length / 2)];
}

// Decision-oriented summary of one connection analysis (the compact result view): where the traveller most likely
// arrives and departs (at the level the evidence supports), a one-line verdict with what drives it, ONE most likely
// route split into walk / transport / walk, the checks on the way, the movement time vs the time needed, and a heuristic
// confidence that this route is the right one. Plain TypeScript (no browser APIs).
//
// Honesty rules: percentages only for predicted values and only at the evidence level ("Terminal 2E 70 %", never an
// invented share per hall, R-20); observed values stay "observed"; minutes stay "estimated"; when no route can be picked
// with defensible confidence the displayed route is labelled "illustrative" (R-15); the route confidence is a heuristic.
import type { AirportModel, Confidence, Line } from '../../../airportmaps/src/types.ts';
import type { RouteIssue, Step } from '../../../airportmaps/src/route.ts';
import { ASSUMPTIONS, LIMITED_SAMPLE, primaryCombo, type Assessment, type Combo, type Span, type Verdict } from './assess.ts';
import type { ConnectionAnalysis } from './analyze.ts';
import type { AreaCandidate, Resolution } from './resolve.ts';
import type { Provenance } from './types.ts';

/** Below this the view says "We are not fully sure this is the correct route." */
export const ROUTE_SURE_THRESHOLD = 0.7;
/** Words a verdict or label may never use (product rule). */
export const FORBIDDEN_WORDS = /\b(safe|safely|guarantee|guaranteed|guarantees)\b/i;

/** One-line verdicts (the long explanation lives in the details). */
export const SHORT_VERDICT: Record<Verdict, string> = {
  comfortable: 'Looks comfortable on our estimates',
  tight: 'Looks tight on our estimates',
  risky: 'Looks risky on our estimates',
  uncertain: 'Depends on the area (not predicted)',
  'not-assessed': 'Not assessed',
};

export interface PlaceOption {
  areaId: string;              // first area of the option (map focus)
  areaIds: string[];           // every area the option covers (a terminal can cover several halls)
  name: string; short: string;
  p: number | null;            // evidence-level share; null when not predicted
  detail: string | null;
}
export interface PlaceSummary {
  role: 'arrival' | 'departure';
  provenance: Provenance;
  /** The most likely option(s): more than one when tied at the top (same rounded percentage). */
  top: PlaceOption[];
  /** The other options, most likely first (shares below 5 % are folded into `otherShare`). */
  others: PlaceOption[];
  /** Share not shown as an option: small options and history that matches no area. */
  otherShare: number;
  /** "from 30 earlier flight-days", "published for this flight (may change)", "not predicted: 6 possible areas". */
  basisText: string;
}

const rounded = (p: number) => Math.round(p * 100);

function optionsOf(r: Resolution): PlaceOption[] {
  if (r.provenance === 'unknown') return r.candidates.map((c) => ({ areaId: c.area.id, areaIds: [c.area.id], name: c.area.name, short: c.area.short, p: null, detail: null }));
  const area = (id: string) => r.candidates.find((c) => c.area.id === id)!.area;
  return r.groups.map((g) => {
    const as = g.areas.map(area);
    const kind = r.basis === 'published-gate' || r.basis === 'gate' ? 'gate' : r.basis === 'gate-area' ? 'gate area' : 'terminal';
    const multi = as.length > 1;
    const detail = multi ? `${kind} ${g.label}: ${as.map((x) => x.short).join(' / ')} (which one is not predicted)` : r.basis === 'published-gate' ? `gate ${g.label}` : `${kind} ${g.label}`;
    return { areaId: as[0].id, areaIds: as.map((x) => x.id), name: multi ? `Terminal ${g.label}` : as[0].name, short: multi ? g.label : as[0].short, p: r.provenance === 'predicted' || r.provenance === 'observed' ? g.p : null, detail };
  });
}

export function summarisePlace(r: Resolution): PlaceSummary {
  const opts = optionsOf(r);
  let n = 0;
  if (r.provenance !== 'unknown' && opts.length) { const t = rounded(opts[0].p ?? 0); n = opts.filter((o) => rounded(o.p ?? 0) === t).length; }
  const top = opts.slice(0, n);
  const rest = opts.slice(n);
  const others = r.provenance === 'unknown' ? rest : rest.filter((o) => (o.p ?? 0) >= 0.05);
  const otherShare = r.provenance === 'unknown' ? 0 : rest.filter((o) => (o.p ?? 0) < 0.05).reduce((s, o) => s + (o.p ?? 0), 0) + r.unassigned;
  const observedPure = r.provenance === 'observed' && opts.length === 1 && (opts[0].p ?? 0) >= 0.999;
  // an observed value blended with history keeps its share visible; a single published value shows no percentage
  if (observedPure) for (const o of top) o.p = null;
  const basisText = r.provenance === 'observed' ? (observedPure ? 'published for this flight (may still change)' : `published for this flight (may still change), with ${r.sample ?? '?'} earlier flight-days`)
    : r.provenance === 'predicted' ? `from ${r.sample ?? '?'} earlier flight-days`
    : r.provenance === 'estimated' && r.basis === 'airline-terminal' ? 'typical terminal for this airline (published allocation; no flight history yet)'
    : `not predicted: ${opts.length} possible area${opts.length === 1 ? '' : 's'}${r.zone ? ` (${r.zone})` : ''}`;
  return { role: r.direction, provenance: r.provenance, top, others, otherShare, basisText };
}

/** Heuristic weight of the airport model's own confidence in a route (the weakest of its parts). */
export const MODEL_FACTOR: Record<Confidence, number> = { verified: 1, probable: 0.9, inferred: 0.75, unknown: 0.5 };
/** A gate or terminal published for the day can still change. */
const OBSERVED_FACTOR = 0.95;
/** Confidence in an airline's published terminal when the flight has no history (allocation tables change; codeshares excluded). */
const AIRLINE_TERMINAL_FACTOR = 0.85;
/** The page did not say protected vs self-transfer. */
const ASSUMED_TYPE_FACTOR = 0.9;

export interface RouteSegments {
  walkBefore: number;                                   // minutes (typical) of walking before the first ride
  transport: { minutes: number; labels: string[] } | null;   // waits + rides (+ changes between them); null = walk only
  walkAfter: number;                                    // walking after the last ride
  checks: { label: string; minutes: number }[];         // in passage order, with typical minutes
  checksMinutes: number;
  deplane: number;                                      // assumed minutes to leave the aircraft
  bags: number | null;                                  // self-transfer: assumed wait for checked bags
  /** Physical movement: leaving the aircraft → the departure area (no deadline). */
  movement: Span;
  /** @deprecated same as movement */
  total: Span;
  /** Time needed to make the flight: movement + the deadline before departure (R-29). */
  needed: Span | null;
  deadline: { label: string; minutes: number };         // boarding closes / check-in closes before departure (assumed)
}

export interface BestRoute {
  combo: Combo;
  /** Heuristic chance that this is the route the traveller will take (area likelihoods × model confidence). */
  confidence: number;
  sure: boolean;
  /** No route could be picked with defensible confidence: the map shows an example of the possible routes (R-15). */
  illustrative: boolean;
  /** Fewest flight-days behind a predicted end (< LIMITED_SAMPLE), else null. */
  limitedHistory: number | null;
  /** Why the confidence is what it is (shown in the details). */
  confidenceWhy: string[];
  segments: RouteSegments;
  /** The route's issues: material ones are shown in the compact view, secondary ones in the details (R-14). */
  material: RouteIssue[];
  secondary: RouteIssue[];
}

const MODE_LABEL: Record<Line['mode'], string> = { train: 'Train', 'people-mover': 'People mover', bus: 'Bus', 'shuttle-bus': 'Shuttle bus', rail: 'Rail', other: 'Transport' };
const CHECK_LABEL: Record<string, string> = { security: 'Security', 'transfer-security': 'Transfer security', passport: 'Passport control', 'boarding-pass': 'Boarding-pass check', customs: 'Customs', 'special-screening': 'Additional screening' };
const WALKING = new Set<Step['kind']>(['walk', 'to-platform', 'from-platform']);
const TRANSIT = new Set<Step['kind']>(['wait', 'ride']);

export function segmentsOf(m: AirportModel, c: Combo, selfTransfer: boolean, deadline?: { label: string; minutes: number }): RouteSegments {
  const steps = c.route?.steps ?? [];
  const i0 = steps.findIndex((s) => TRANSIT.has(s.kind));
  const i1 = steps.length - 1 - [...steps].reverse().findIndex((s) => TRANSIT.has(s.kind));
  const sum = (xs: Step[]) => Math.round(xs.reduce((t, s) => t + s.minutes.typical, 0));
  let walkBefore = 0, walkAfter = 0, transport: RouteSegments['transport'] = null;
  if (i0 < 0) walkBefore = sum(steps.filter((s) => WALKING.has(s.kind)));
  else {
    walkBefore = sum(steps.slice(0, i0).filter((s) => WALKING.has(s.kind)));
    walkAfter = sum(steps.slice(i1 + 1).filter((s) => WALKING.has(s.kind)));
    const mid = steps.slice(i0, i1 + 1).filter((s) => TRANSIT.has(s.kind) || WALKING.has(s.kind));
    const labels: string[] = [];
    for (const s of mid) if (s.kind === 'ride' && s.line) {
      const l = m.lines.find((x) => x.id === s.line);
      const lab = !l ? 'Transport' : /mover|bus|train|shuttle/i.test(l.name) ? l.name : `${MODE_LABEL[l.mode]}: ${l.name}`;
      if (!labels.includes(lab)) labels.push(lab);
    }
    transport = { minutes: sum(mid), labels };
  }
  // checks in passage order (a self-transfer route carries its own reclaim and check-in steps, R-30)
  const checks = steps.filter((s) => (s.kind === 'control' && s.control) || s.kind === 'reclaim' || s.kind === 'check-in').map((s) => ({
    label: s.kind === 'reclaim' ? 'Baggage reclaim' : s.kind === 'check-in' ? 'Check-in / bag drop again' : CHECK_LABEL[s.control!.kind] ?? s.text,
    minutes: Math.round(s.minutes.typical),
  }));
  const checksMinutes = checks.filter((x) => x.label !== 'Baggage reclaim').reduce((t, x) => t + x.minutes, 0);
  const bags = selfTransfer ? Math.round(steps.filter((s) => s.kind === 'reclaim').reduce((t, s) => t + s.minutes.typical, 0)) : null;
  const movement = c.movement ?? { min: 0, typical: 0, max: 0 };
  const deplane = Math.round((movement.typical - steps.reduce((t, s) => t + s.minutes.typical, 0)) * 10) / 10;
  return {
    walkBefore, transport, walkAfter, checks, checksMinutes, deplane: c.route ? deplane : ASSUMPTIONS.deplane.typical, bags, movement, total: movement, needed: c.needed,
    deadline: deadline ?? (selfTransfer ? { label: 'Check-in closes', minutes: ASSUMPTIONS.checkInClose.typical } : { label: 'Boarding closes', minutes: ASSUMPTIONS.gateClose.typical }),
  };
}

/** Wilson 95 % lower bound of a share k/n (a small sample gives a lower confidence than a large one, R-46). */
function wilsonLower(p: number, n: number, z = 1.96): number {
  if (!n) return p;
  const d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}

/**
 * The ONE most likely route (R-15): the plausible pair with the highest evidence-level likelihood (a terminal's share
 * counts for each of its halls), excluding routes with a blocking issue; ties → the route the model is most confident
 * in, then the median transfer time (assess.ts primaryCombo). The headline verdict is built on this same pair, with
 * the other likely pairs weighted by past use (risk.ts likelyVerdict). Confidence = the area-level probability of each end
 * (Wilson lower bound when the sample is known; an equal split inside a multi-area terminal) × the model's confidence
 * in the route (× 0.95 for each published value, which can change; × 0.9 when the ticket type was not given).
 */
export function bestRoute(m: AirportModel, a: ConnectionAnalysis): BestRoute | null {
  const as: Assessment | null = a.assessment;
  if (!as || !a.arrival || !a.departure) return null;
  // the same pair the headline verdict is built on (assess.ts primaryCombo)
  const best = as.primary?.route ? as.primary : primaryCombo(as.combos);
  if (!best?.route) return null;
  const why: string[] = [];
  const end = (r: Resolution, c: AreaCandidate, what: string) => {
    const size = c.group ? r.groups.find((g) => g.label === c.group)?.areas.length ?? 1 : 1;
    if (r.provenance === 'unknown') { why.push(`${what} area not predicted (1 of ${r.candidates.length} possible)`); return 1 / r.candidates.length; }
    if (r.provenance === 'observed' && c.evidence >= 0.999) { why.push(`${what} ${size > 1 ? `terminal published for the day; which of its ${size} areas is not known` : 'area published for the day (may change)'}`); return OBSERVED_FACTOR / size; }
    if (r.provenance === 'estimated') { why.push(`${what} terminal is the airline's published terminal (no flight history)${size > 1 ? `; which of its ${size} areas is not predicted` : ''}`); return AIRLINE_TERMINAL_FACTOR / size; }
    const lo = r.sample ? wilsonLower(c.evidence, r.sample) : c.evidence;
    if (size > 1) why.push(`${what} terminal ${c.group} ${rounded(c.evidence)} % likely; which of its ${size} areas is not predicted`);
    else why.push(`${what} area ${rounded(c.evidence)} % likely from ${r.sample ?? '?'} earlier flight-days`);
    return lo / size;
  };
  let conf = end(a.arrival, best.arrival, 'Arrival') * end(a.departure, best.departure, 'Departure');
  const routeConf = best.route!.confidence;
  conf *= MODEL_FACTOR[routeConf];
  if (routeConf !== 'verified') why.push(`route on the airport model is ${routeConf}`);
  if (a.observed.selfTransferAssumed) { conf *= ASSUMED_TYPE_FACTOR; why.push('ticket type not shown in the itinerary'); }
  const areaKnown = (r: Resolution, c: AreaCandidate) => r.provenance !== 'unknown' && !c.group;
  // Example D: a prediction from very few flight-days is shown as an example, never as a confident route
  const fewDays = [a.arrival, a.departure].filter((r) => r.provenance === 'predicted' && r.sample !== null && r.sample < LIMITED_SAMPLE).map((r) => r.sample!);
  if (fewDays.length) why.push(`limited history: ${Math.min(...fewDays)} earlier flight-day${Math.min(...fewDays) === 1 ? '' : 's'}`);
  const illustrative = !areaKnown(a.arrival, best.arrival) || !areaKnown(a.departure, best.departure) || fewDays.length > 0;
  const issues = best.route!.issues;
  return {
    combo: best, confidence: conf, sure: !illustrative && conf >= ROUTE_SURE_THRESHOLD, illustrative, limitedHistory: fewDays.length ? Math.min(...fewDays) : null, confidenceWhy: why, segments: segmentsOf(m, best, as.selfTransfer, as.deadline),
    material: issues.filter((i) => i.level !== 'secondary'), secondary: issues.filter((i) => i.level === 'secondary'),
  };
}
export const mostLikelyRoute = bestRoute;

/** Map callouts: the top arrival / departure option(s); when nothing is predicted, the route's ends marked "?". */
export interface MapMark { area: string; role: 'from' | 'to'; text: string }
export function mapMarks(arr: PlaceSummary, dep: PlaceSummary, best: BestRoute | null): MapMark[] {
  const marks: MapMark[] = [];
  const side = (s: PlaceSummary, role: 'from' | 'to', fallback: string | undefined) => {
    const word = role === 'from' ? 'ARRIVE' : 'DEPART';
    if (s.top.length) for (const o of s.top) for (const id of o.areaIds) {
      const short = o.areaIds.length > 1 ? `${o.short}?` : o.short;
      marks.push({ area: id, role, text: `${word} ${short}${o.p !== null ? ` · ${rounded(o.p)} %` : s.provenance === 'observed' && o.detail ? ` · ${o.detail}` : ''}` });
    }
    else if (fallback) marks.push({ area: fallback, role, text: `${word} ? (not predicted)` });
  };
  side(arr, 'from', best?.combo.arrival.area.id);
  side(dep, 'to', best?.combo.departure.area.id);
  return marks;
}

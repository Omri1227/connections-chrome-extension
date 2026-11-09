// Area-to-area routing on an AirportModel (shared by all airports).
// Graph: area nodes, stop (platform) nodes and per-line "on board" nodes, so a wait is counted once per boarding and
// staying on board through intermediate stops costs only the ride. Edge weights are typical minutes; the practical
// ranking adds small penalties for walks marked 'long' / 'avoid' and per boarding. Controls add their allowance.
// Safety rules: 'restricted' connections are never used; 'transfer'-only connections need the transfer profile;
// a route crosses a passport control at most once unless no other route exists (then it is flagged).
// Time of day (Profile.time): the clock starts at that local time and advances along the route by the typical minutes
// of each step, so a line, corridor or station is used only if it is open when the passenger gets there (R-13).
// Passenger-dependent procedures (R-05, R-19): conditional controls by inbound origin, special screening by destination.
import type { AirportModel, Area, CheckInFacility, Confidence, Control, GateGroup, Line, LineService, Minutes, SpecialScreening, StatusPeriod, Stop, TimeWindow, Weekday, Zone } from './types.ts';

export interface Profile {
  /** Connecting passenger with an onward boarding pass: may use transfer-only buses/corridors. */
  transfer: boolean;
  /** Disable transport (walking only). */
  walkOnly?: boolean;
  /** Avoid walks marked 'long' or 'avoid' when anything else exists. */
  preferTransport?: boolean;
  /** The origin is an arriving flight: walks with flow 'arrivals' may be used at the start of the route (default true). */
  fromArrival?: boolean;
  /** Routing date (ISO) for status periods; default: the model's asOf date. */
  date?: string;
  /** Local time of day "HH:MM" when the route starts (e.g. the arrival time plus leaving the aircraft). When set, the
   *  clock advances along the route: lines run only inside their service windows, walks/stops only inside their hours,
   *  and the wait uses the service pattern running when the passenger reaches the stop. Unset = typical daytime service. */
  time?: string;
  /** With `time`: the longest wait (minutes) for a line that has not started yet when reached (e.g. the first morning
   *  service). Default 0 = such a line is not usable. */
  maxWait?: number;
  /** Never leave airside (a passenger who may not enter the country landside). */
  stayAirside?: boolean;
  /** Inbound flight's origin (IATA) and its country (ISO-2): conditional transfer security (R-05). */
  originAirport?: string;
  originCountry?: string;
  /** Outbound flight's destination, its country and the airline (IATA code): special screening (R-19). */
  destinationAirport?: string;
  destinationCountry?: string;
  airline?: string;
  /** Leaving the arrival area through its own arrivals flow when it has one, as if it were segregated (a self-transfer
   *  passenger collects the bags of THIS flight at its reclaim: no other concourse's exit, AU-3). */
  arrivalsExit?: boolean;
}

const toMin = (t: string) => { const [h, mm] = t.split(':').map(Number); return h * 60 + (mm || 0); };
const hhmm = (t: number) => { const x = ((Math.round(t) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** Is a time "HH:MM" inside a daily window (wrapping past midnight when until < from)? "24:00" as a time = "00:00". */
export function inWindow(time: string, w: TimeWindow): boolean {
  const t = toMin(time) % 1440, f = toMin(w.from), u = toMin(w.until);
  if (f === u || (f === 0 && u === 1440)) return true;
  return f < u ? t >= f && t < u : t >= f || t < u;
}
const wraps = (w: TimeWindow) => toMin(w.from) > toMin(w.until);
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const weekdayOf = (date: string): Weekday => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
export const openAt = (hours: TimeWindow[] | undefined, time: string | undefined) => !time || !hours?.length || hours.some((w) => inWindow(time, w));

/** Service entries valid on a date (a temporary timetable bounded by validFrom and validUntil replaces the others). */
function validOn(l: Line, date: string): LineService[] {
  const day = weekdayOf(date);
  const onDate = l.service.filter((sv) => (!sv.validFrom || sv.validFrom <= date) && (!sv.validUntil || date <= sv.validUntil) && (!sv.days?.length || sv.days.includes(day)));
  const dated = onDate.filter((sv) => sv.validFrom && sv.validUntil);
  return dated.length ? dated : onDate;
}

/** The service pattern of a line on a date (and at a time, when given); null = not running then.
 *  After midnight (R-45) a wrapping window ("22:00"–"05:00" at 02:00) matches on the calendar date or as the previous
 *  day's service (its `days` and validity), whichever the data means. Without a time, the first entry running in the daytime (windows absent or
 *  containing 12:00) is the "typical daytime" service, else the first valid entry. */
export function serviceAt(l: Line, date: string, time?: string): LineService | null {
  const valid = validOn(l, date);
  if (!time) return valid.find((sv) => !sv.windows?.length || sv.windows.some((w) => inWindow('12:00', w))) ?? valid[0] ?? null;
  const t = toMin(time) % 1440;
  const today = valid.find((sv) => !sv.windows?.length || sv.windows.some((w) => inWindow(time, w)));
  if (today) return today;
  // after midnight: a wrapping window of the previous service day
  return validOn(l, addDays(date, -1)).find((sv) => sv.windows?.some((w) => wraps(w) && t < toMin(w.until))) ?? null;
}
/** Ride range of segment i, with its basis. */
export const rideSeg = (l: Line, i: number): Minutes => l.ride?.[i] ?? { min: l.rideMin[i], typical: l.rideMin[i], max: l.rideMin[i], basis: l.rideBasis ?? 'assumed' };

/** The status period covering a date, if any. */
export function periodOn(status: StatusPeriod[] | undefined, date: string): StatusPeriod | undefined {
  return (status ?? []).find((p) => (!p.from || p.from <= date) && (!p.until || date <= p.until));
}
/** State of an item on a date: the first status period covering the date, else 'active'. */
export const stateOn = (status: StatusPeriod[] | undefined, date: string): StatusPeriod['state'] => periodOn(status, date)?.state ?? 'active';
export const routingDate = (m: AirportModel, p: Profile) => p.date ?? m.asOf;
export const DEFAULT_PROFILE: Profile = { transfer: true };

/** Border zone of an area on a date (dated `zones` override `zone`, R-16). */
export function zoneOn(a: Area, date: string): Zone {
  return a.zones?.find((z) => (!z.validFrom || z.validFrom <= date) && (!z.validUntil || date <= z.validUntil))?.zone ?? a.zone;
}

/** Is the inbound origin under one-stop security? null = cannot tell (no list in the model, or origin unknown). */
export function oneStopCovered(m: AirportModel, p: Pick<Profile, 'originAirport' | 'originCountry'>): boolean | null {
  const o = m.oneStopSecurity;
  if (!o) return null;
  const ap = p.originAirport?.toUpperCase(), c = p.originCountry?.toUpperCase();
  if (ap && o.excludedAirports?.includes(ap)) return false;
  if (ap && o.airports?.includes(ap)) return true;
  if (c) return o.countries.includes(c);
  return null;
}

/** Special-screening procedures that apply to the outbound flight of a profile (R-19). */
export function specialScreeningFor(m: AirportModel, p: Pick<Profile, 'destinationAirport' | 'destinationCountry' | 'airline'>): SpecialScreening[] {
  const up = (s?: string) => s?.toUpperCase();
  return (m.specialScreening ?? []).filter((s) => {
    const a = s.appliesTo;
    // every criterion given must match (destination = its country or its airport; and the airline when listed)
    const hasDest = !!(a.destinationCountries?.length || a.destinationAirports?.length);
    const dest = (!!p.destinationCountry && !!a.destinationCountries?.includes(up(p.destinationCountry)!)) || (!!p.destinationAirport && !!a.destinationAirports?.includes(up(p.destinationAirport)!));
    const air = !!p.airline && !!a.airlines?.includes(up(p.airline)!);
    return (hasDest || !!a.airlines?.length) && (!hasDest || dest) && (!a.airlines?.length || air);
  });
}

export type StepKind = 'walk' | 'to-platform' | 'wait' | 'ride' | 'from-platform' | 'control' | 'reclaim' | 'check-in';

export interface Step {
  kind: StepKind;
  text: string;
  from: string;              // node id (area or stop)
  to: string;
  minutes: Minutes;
  line?: string;             // line id (wait / ride)
  stops?: string[];          // stop ids passed on a ride (inclusive)
  control?: Control;
  confidence: Confidence;
  sources: string[];
  refId?: string;            // walk / stop / line id the step comes from
  practical?: 'practical' | 'long' | 'avoid';
  /** Wait step of a service whose hours are not published, on a route asked for a time of day. */
  hoursUnpublished?: boolean;
  /** Wait step that includes waiting for a line to start (not running when the passenger reaches it). */
  waitsForService?: string;
  /** Untimed route: the service pattern used runs only at some hours (no daytime pattern). */
  hoursAssumed?: boolean;
  /** Conditional controls the passenger does not pass on this edge (origin under one-stop security). */
  exempt?: Control[];
  /** Local clock "HH:MM" when the step starts (routes asked for a time of day). */
  at?: string;
}

/** How much a route problem matters (R-14): blocking = the route must not be recommended; material = affects the
 *  analysis and is shown concisely; secondary = shown only in the details. */
export type IssueLevel = 'blocking' | 'material' | 'secondary';
export interface RouteIssue { level: IssueLevel; code: string; text: string }

export interface Route {
  from: string;
  to: string;
  steps: Step[];
  total: { min: number; typical: number; max: number };
  /** Movement only: walks, platform access, waits and rides (no control allowances). */
  movement: { min: number; typical: number; max: number };
  /** Control allowances only (security, passport ...): planning values, not queue predictions. */
  controlTime: { min: number; typical: number; max: number };
  /** Typical movement minutes by evidence basis (how much of the time is published / measured / ... / assumed). */
  basisMix: Partial<Record<Minutes['basis'], number>>;
  modes: ('walk' | Line['mode'])[];
  lines: string[];
  controls: Control['kind'][];
  confidence: Confidence;     // weakest of its parts
  borderCrossings: number;
  /** Legacy warning texts (kept for compatibility); `issues` carries every problem with its level. */
  warnings: string[];
  issues: RouteIssue[];
  /** The route passes an entry passport control and then goes landside (R-33): the passenger must be allowed to enter. */
  entersCountry: boolean;
  /** Self-transfer route: where bags are dropped again (the check-in deadline point) and the index of that step. */
  checkIn?: { area: string; step: number };
  /** A published presence deadline before departure from special screening (CR-B4): replaces boarding close when later. */
  deadline?: { minutes: number; text: string };
  /** Short human summary, e.g. "Walk 6 min · SkyLine T1→T2 · walk 3 min". */
  summary: string;
}

const RANK: Confidence[] = ['verified', 'probable', 'inferred', 'unknown'];
const weakest = (cs: Confidence[]) => cs.reduce<Confidence>((w, c) => (RANK.indexOf(c) > RANK.indexOf(w) ? c : w), 'verified');
const sumMin = (xs: Minutes[]) => ({ min: xs.reduce((s, x) => s + x.min, 0), typical: xs.reduce((s, x) => s + x.typical, 0), max: xs.reduce((s, x) => s + x.max, 0) });
const BOARD_PENALTY = 1, LONG_PENALTY = 2, AVOID_PENALTY = 8, LANDSIDE_TIE = LONG_PENALTY;

interface Edge {
  to: string; cost: number; cross: number; steps: Step[]; arr?: boolean;
  /** Opening hours checked at the clock time the edge is taken (timed routes). */
  hours?: TimeWindow[];
  /** Boarding a line: the wait depends on the service running when the stop is reached (timed routes). */
  board?: Line;
}

function controlSteps(cs: Control[] | undefined, at: string, conf: Confidence, sources: string[]): Step[] {
  return (cs ?? []).map((c) => ({ kind: 'control' as const, text: CONTROL_TEXT[c.kind] + (c.note ? ` (${c.note})` : ''), from: at, to: at, minutes: c.minutes, control: c, confidence: conf, sources }));
}
export const CONTROL_TEXT: Record<Control['kind'], string> = {
  security: 'Security check', 'transfer-security': 'Transfer security check', passport: 'Passport control', 'boarding-pass': 'Boarding-pass check', customs: 'Customs', 'special-screening': 'Additional security screening',
};
const crossings = (cs?: Control[]) => (cs ?? []).filter((c) => c.kind === 'passport').length;

/** Service used for waits: the first entry (the daytime service). */
export const mainService = (l: Line) => l.service[0];

const waitStep = (l: Line, sid: string, sv: LineService, unpublished: boolean, assumed: boolean): Step => ({
  kind: 'wait', text: `Wait for ${l.name} (every ${sv.headwayMin.min === sv.headwayMin.max ? sv.headwayMin.min : `${sv.headwayMin.min}–${sv.headwayMin.max}`} min, ${sv.hours})`, from: sid, to: sid, minutes: sv.waitMin, line: l.id,
  confidence: l.confidence, sources: sv.sources?.length ? sv.sources : l.sources, refId: l.id, hoursUnpublished: unpublished || undefined, hoursAssumed: assumed || undefined,
});

export function buildGraph(m: AirportModel, p: Profile = DEFAULT_PROFILE) {
  const date = routingDate(m, p);
  const live = (x: { status?: StatusPeriod[] }) => stateOn(x.status, date) === 'active';
  const area = new Map(m.areas.filter((a) => stateOn(a.status, date) === 'active').map((a) => [a.id, a]));
  const stop = new Map(m.stops.filter((s) => live(s) && area.has(s.area)).map((s) => [s.id, s]));
  const adj = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => { if (!adj.has(from)) adj.set(from, []); adj.get(from)!.push(e); };
  const ok = (access: string) => access !== 'restricted' && (access !== 'transfer' || p.transfer);
  const covered = oneStopCovered(m, p);
  /** Conditional controls: dropped when the origin is covered (kept as `exempt` for the explanation). */
  const applies = (cs: Control[] | undefined): { keep: Control[]; exempt: Control[] } => {
    const keep: Control[] = [], exempt: Control[] = [];
    // CR-B2: a conditional transfer security is for protected transfers only (a self-transfer passes the normal security)
    for (const c of cs ?? []) { if (c.when === 'origin-not-one-stop' && !p.transfer) continue; (c.when === 'origin-not-one-stop' && covered === true ? exempt : keep).push(c); }
    // at most one conditional transfer security per edge (a stop's own checkpoint and the area-boundary one are the same check)
    const firstCond = keep.findIndex((c) => c.when === 'origin-not-one-stop');
    if (firstCond >= 0) for (let i = keep.length - 1; i > firstCond; i--) if (keep[i].when === 'origin-not-one-stop') keep.splice(i, 1);
    return { keep, exempt };
  };
  const entry = (areaId: string, fromId: string): Control[] => (area.get(areaId)?.entryControls ?? []).filter((c) => !c.exceptFrom?.includes(fromId)).map(({ exceptFrom: _x, ...c }) => c);
  const sideOf = (id: string) => area.get(id)?.side ?? stop.get(id)?.side;
  const blocked = (to: string) => !!p.stayAirside && sideOf(to) === 'landside';

  for (const w of m.walks) {
    if (!ok(w.access) || !live(w) || !area.has(w.from) || !area.has(w.to)) continue;
    if (w.flow === 'arrivals' && p.fromArrival === false) continue;
    const pen = w.practical === 'avoid' ? AVOID_PENALTY : w.practical === 'long' ? (p.preferTransport ? AVOID_PENALTY : LONG_PENALTY) : 0;
    const mk = (a: string, b: string, cs0?: Control[]): Edge => {
      const { keep, exempt } = applies([...(cs0 ?? []), ...entry(b, a)]);
      const walk: Step = { kind: 'walk', text: `Walk from ${area.get(a)?.name ?? a} to ${area.get(b)?.name ?? b}${w.via ? ` (${w.via})` : ''}`, from: a, to: b, minutes: w.minutes, confidence: w.confidence, sources: w.sources, refId: w.id, practical: w.practical, exempt: exempt.length ? exempt : undefined };
      const ctl = controlSteps(keep, b, w.confidence, w.sources);
      // controls sit between the two areas: show them after the walk (we do not model where along the corridor)
      if (w.flow === 'arrivals') walk.text += ' (arrivals flow)';
      // a protected transfer prefers staying airside: leaving to landside costs a route-choice penalty like a 'long' walk
      // (cost only, not minutes), so a landside path wins only when it is clearly faster (RT-5; AMS G→B)
      const land = p.transfer && area.get(b)?.side === 'landside' ? LANDSIDE_TIE : 0;
      return { to: b, cost: w.minutes.typical + ctl.reduce((s, c) => s + c.minutes.typical, 0) + pen + land, cross: crossings(keep), steps: [walk, ...ctl], arr: w.flow === 'arrivals', hours: w.hours };
    };
    if (!blocked(w.to)) add(w.from, mk(w.from, w.to, w.controls));
    if (w.bidirectional && !blocked(w.from)) add(w.to, mk(w.to, w.from, w.reverseControls ?? w.controls));
  }

  for (const s of stop.values()) {
    const a = area.get(s.area); if (!a) continue;
    const acc = applies(s.accessControls), egr = applies([...(s.egressControls ?? []), ...entry(a.id, s.id)]);
    const accSteps = controlSteps(acc.keep, s.id, s.confidence, s.sources), egrSteps = controlSteps(egr.keep, s.area, s.confidence, s.sources);
    if (!blocked(s.id)) add(a.id, { to: s.id, cost: s.accessMinutes.typical + accSteps.reduce((x, c) => x + c.minutes.typical, 0), cross: crossings(acc.keep), hours: s.hours,
      steps: [...accSteps, { kind: 'to-platform', text: `Go to ${s.name}${s.where ? ` — ${s.where}` : ''}`, from: a.id, to: s.id, minutes: s.accessMinutes, confidence: s.confidence, sources: s.sources, refId: s.id, exempt: acc.exempt.length ? acc.exempt : undefined }] });
    if (!blocked(a.id)) add(s.id, { to: a.id, cost: s.accessMinutes.typical + egrSteps.reduce((x, c) => x + c.minutes.typical, 0), cross: crossings(egr.keep), hours: s.hours,
      steps: [{ kind: 'from-platform', text: `Walk from ${s.name} into ${a.name}`, from: s.id, to: a.id, minutes: s.accessMinutes, confidence: s.confidence, sources: s.sources, refId: s.id, exempt: egr.exempt.length ? egr.exempt : undefined }, ...egrSteps] });
  }

  if (!p.walkOnly) for (const l of m.lines) {
    if (l.notRouted || !ok(l.access) || stateOn(l.status, date) !== 'active') continue;
    if (l.stops.some((sid) => !stop.has(sid))) continue; // a closed stop takes the line out (no partial-line model)
    // untimed: the daytime pattern; timed: the pattern is chosen when the stop is reached (search)
    const sv = p.time ? (validOn(l, date).length || validOn(l, addDays(date, 1)).length || validOn(l, addDays(date, -1)).length ? l.service[0] : null) : serviceAt(l, date);
    if (!sv) continue; // not running on that day
    const assumed = !p.time && !!sv.windows?.length && !sv.windows.some((w) => inWindow('12:00', w));
    const n = l.stops.length;
    const segs: [number, number, number][] = []; // [fromIdx, toIdx, segment index]
    for (let i = 0; i < n - 1; i++) segs.push([i, i + 1, i]);
    if (l.direction === 'loop') segs.push([n - 1, 0, n - 1]);
    const dirs: ('f' | 'r')[] = l.direction === 'both' ? ['f', 'r'] : ['f'];
    for (const d of dirs) {
      const node = (i: number) => `ride:${l.id}:${d}:${l.stops[i]}`;
      for (let i = 0; i < n; i++) {
        const sid = l.stops[i];
        add(sid, { to: node(i), cost: sv.waitMin.typical + BOARD_PENALTY, cross: 0, board: p.time ? l : undefined, steps: [waitStep(l, sid, sv, false, assumed)] });
        add(node(i), { to: sid, cost: 0, cross: 0, steps: [] });
      }
      for (const [a, b, seg] of segs) {
        const [x, y] = d === 'f' ? [a, b] : [b, a];
        const mins = rideSeg(l, seg);
        add(node(x), { to: node(y), cost: mins.typical, cross: 0, steps: [{ kind: 'ride', text: '', from: l.stops[x], to: l.stops[y], minutes: mins, line: l.id, stops: [l.stops[x], l.stops[y]], confidence: l.confidence, sources: l.sources, refId: l.id }] });
      }
    }
  }
  return { adj, area, stop };
}

/** The wait for a line boarded at absolute clock minute t (from 00:00 of the routing date), or null if not usable. */
function boardAt(l: Line, sid: string, date: string, t: number, maxWait: number): { cost: number; dt: number; step: Step } | null {
  const day = (x: number) => addDays(date, Math.floor(x / 1440));
  const sv = serviceAt(l, day(t), hhmm(t));
  if (sv) return { cost: sv.waitMin.typical + BOARD_PENALTY, dt: sv.waitMin.typical, step: waitStep(l, sid, sv, !sv.windows?.length, false) };
  if (maxWait <= 0) return null;
  // the next start of a service window within maxWait (today and tomorrow)
  let best: { at: number; sv: LineService } | null = null;
  for (const k of [Math.floor(t / 1440), Math.floor(t / 1440) + 1]) for (const s of validOn(l, addDays(date, k))) for (const w of s.windows ?? []) {
    const at = k * 1440 + toMin(w.from);
    if (at > t && at - t <= maxWait && (!best || at < best.at) && serviceAt(l, day(at), hhmm(at))) best = { at, sv: s };
  }
  if (!best) return null;
  const extra = best.at - t, w = best.sv.waitMin;
  const step = waitStep(l, sid, best.sv, false, false);
  step.minutes = { min: extra + w.min, typical: extra + w.typical, max: extra + w.max, basis: 'derived', note: `not running at ${hhmm(t)}; next service from ${hhmm(best.at)}` };
  step.text = `Wait for ${l.name}: not running at ${hhmm(t)}, first service from ${hhmm(best.at)} (${best.sv.hours})`;
  step.waitsForService = hhmm(best.at);
  return { cost: extra + w.typical + BOARD_PENALTY, dt: extra + w.typical, step };
}

/** Dijkstra with a border-crossing counter in the state and, for timed routes, a clock along the path. */
function search(m: AirportModel, from: string, to: string, p: Profile, maxCross: number, loop = false, needScreen = false): Route | null {
  const { adj, area, stop } = buildGraph(m, p);
  if (!area.has(from) || !area.has(to)) return null;
  const date = routingDate(m, p);
  const timed = !!p.time, t0 = p.time ? toMin(p.time) : 0, maxWait = p.maxWait ?? 0;
  // state: node | passport crossings | still in the arrivals flow (1 until the first non-arrivals movement) | already passed a
  // conditional transfer security (CR-B2: it applies at most once per route, so a second one costs nothing in the search)
  const key = (n: string, c: number, a: number, sc = 0) => `${n}|${c}|${a}|${sc}`;
  const a0 = p.fromArrival === false ? 0 : 1;
  const segregated = area.get(from)?.arrivals === 'segregated' || (!!p.arrivalsExit && a0 === 1 && !!adj.get(from)?.some((e) => e.arr));
  const start = key(from, 0, a0);
  const dist = new Map<string, number>(), clock = new Map<string, number>(), earliest = new Map<string, number>(), prev = new Map<string, { k: string; e: Edge }>();
  const pq: [number, string, string, number, number, number][] = [[0, start, from, 0, a0, 0]];
  dist.set(start, 0); clock.set(start, t0);
  let goal: string | null = null;
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, k, n, c, af, sc] = pq.shift()!;
    if (d > (dist.get(k) ?? Infinity)) continue;
    // needScreen (AU-1): the goal counts only once a conditional transfer security has been passed
    if (n === to && !(loop && k === start) && (!needScreen || sc)) { goal = k; break; }
    const t = clock.get(k)!;
    // earliest clock at which any path reached this node: a later path may not "wait" for a closed line or corridor by
    // making a detour (only the earliest arrival may wait, up to maxWait)
    const te = Math.min(t, earliest.get(n) ?? t);
    if (!earliest.has(n) || t < earliest.get(n)!) earliest.set(n, t);
    for (const e0 of adj.get(n) ?? []) {
      if (e0.arr && !af) continue;
      if (n === from && af && segregated && !e0.arr) continue; // arriving here: leave only through the arrivals flow
      const nc = c + e0.cross; if (nc > maxCross) continue;
      let e = e0, dt = e0.steps.reduce((s, x) => s + x.minutes.typical, 0);
      if (timed) {
        if (e0.hours && (!openAt(e0.hours, hhmm(t)) || !openAt(e0.hours, hhmm(te)))) continue;   // corridor / station closed when reached
        // a checkpoint with published hours, closed when this passenger reaches it (a conditional one already passed costs
        // nothing and is not needed again, CR-B2)
        let at = t, shut = false;
        for (const x of e0.steps) {
          if (x.control?.hours && !(sc && x.control.when === 'origin-not-one-stop') && !openAt(x.control.hours, hhmm(at))) { shut = true; break; }
          at += x.minutes.typical;
        }
        if (shut) continue;
        if (e0.board) {
          if (te < t && !serviceAt(e0.board, addDays(date, Math.floor(te / 1440)), hhmm(te))) continue;
          const b = boardAt(e0.board, n, date, t, maxWait);
          if (!b) continue;                                      // line not running then (and not starting soon enough)
          e = { ...e0, cost: b.cost, steps: [b.step] }; dt = b.dt;
        }
      }
      const cond = e.steps.filter((x) => x.control?.when === 'origin-not-one-stop');
      const condMin = cond.reduce((s2, x) => s2 + x.minutes.typical, 0);
      const cost = sc ? e.cost - condMin : e.cost;
      if (sc) dt -= condMin;
      const ns = sc || cond.length ? 1 : 0;
      const na = e.arr ? af : 0;
      const nk = key(e.to, nc, na, ns), nd = d + cost;
      if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); clock.set(nk, t + dt); prev.set(nk, { k, e }); pq.push([nd, nk, e.to, nc, na, ns]); }
    }
  }
  if (!goal) return null;
  const edges: Edge[] = [];
  for (let k = goal; k !== start;) { const pr = prev.get(k)!; edges.unshift(pr.e); k = pr.k; }
  const raw0 = edges.flatMap((e) => e.steps.map((s) => ({ ...s })));
  // CR-B2: a conditional transfer security applies at most once per route (once screened, the passenger is cleared)
  let screened = false;
  const raw = raw0.filter((s) => { if (s.control?.when !== 'origin-not-one-stop') return true; if (screened) return false; screened = true; return true; });
  if (timed) { let t = t0; for (const s of raw) { s.at = hhmm(t); t += s.minutes.typical; } }
  const steps = mergeRides(m, raw, stop);
  const crossCount = edges.reduce((s, e) => s + e.cross, 0);
  return finish(m, from, to, steps, crossCount, p);
}

const BASIS_RANK: Minutes['basis'][] = ['published', 'measured', 'observed', 'derived', 'assumed'];
const weakerBasis = (a: Minutes['basis'], b: Minutes['basis']) => (BASIS_RANK.indexOf(a) >= BASIS_RANK.indexOf(b) ? a : b);

function mergeRides(m: AirportModel, raw: Step[], stop: Map<string, Stop>): Step[] {
  const out: Step[] = [];
  for (const s of raw) {
    const last = out.at(-1);
    if (s.kind === 'ride' && last?.kind === 'ride' && last.line === s.line && last.to === s.from) {
      last.to = s.to; last.stops = [...last.stops!, s.to];
      last.minutes = { min: last.minutes.min + s.minutes.min, typical: last.minutes.typical + s.minutes.typical, max: last.minutes.max + s.minutes.max, basis: weakerBasis(last.minutes.basis, s.minutes.basis) };
    } else out.push({ ...s, stops: s.stops ? [...s.stops] : undefined });
  }
  const lines = new Map(m.lines.map((l) => [l.id, l]));
  for (const s of out) if (s.kind === 'ride') {
    const l = lines.get(s.line!)!;
    const nm = (id: string) => stop.get(id)?.name ?? id;
    const mid = s.stops!.length - 2;
    s.text = `Ride ${l.name} from ${nm(s.from)} to ${nm(s.to)}${mid > 0 ? ` (${mid} stop${mid > 1 ? 's' : ''} in between)` : ''}`;
  }
  return out;
}

const SCHENGEN_HUB = (m: AirportModel) => m.areas.some((a) => a.zone === 'schengen' || a.zone === 'non-schengen');

/** Issues of a route from its steps (R-14). Legacy `warnings` keep their exact former texts. */
function routeIssues(m: AirportModel, steps: Step[], borderCrossings: number, p: Profile, entersCountry: boolean): { warnings: string[]; issues: RouteIssue[] } {
  const warnings: string[] = [], issues: RouteIssue[] = [];
  const both = (level: IssueLevel, code: string, text: string) => { warnings.push(text); issues.push({ level, code, text }); };
  const issue = (level: IssueLevel, code: string, text: string) => { if (!issues.some((i) => i.code === code)) issues.push({ level, code, text }); };
  if (borderCrossings > 1) both('material', 'double-passport', 'This route crosses passport control more than once (no simpler route is modelled). Check with staff.');
  if (steps.some((s) => s.practical === 'avoid')) both('secondary', 'walk-not-recommended', 'Includes a walk the sources do not recommend.');
  if (steps.some((s) => s.confidence === 'unknown')) both('material', 'unestablished-step', 'Part of this route is not established by sources.');
  const lineName = (id?: string) => m.lines.find((l) => l.id === id)?.name ?? id;
  const unpub = [...new Set(steps.filter((s) => s.hoursUnpublished).map((s) => lineName(s.line)))];
  if (unpub.length) both('material', 'hours-unpublished', `Operating hours not published for ${unpub.join(', ')}: assumed running at ${p.time}.`);
  const sec = steps.filter((s) => s.control && (s.control.kind === 'security' || s.control.kind === 'transfer-security')).length;
  if (sec > 1) both('secondary', 'multiple-security', `This route passes security ${sec} times (e.g. re-entering airside, or a terminal-entrance screening plus the main checkpoint). Each is a separate checkpoint in the model.`);
  for (const s of steps.filter((x) => x.waitsForService)) issue('material', 'waits-for-service', `${lineName(s.line)} is not running when you reach it; the route waits for the first service at ${s.waitsForService}.`);
  const assumedHours = [...new Set(steps.filter((s) => s.hoursAssumed).map((s) => lineName(s.line)))];
  if (assumedHours.length) issue('material', 'service-hours-assumed', `${assumedHours.join(', ')} runs only at some hours; without the time of day it is assumed to be running.`);
  // checkpoints with published hours: without a time of day the route assumes they are open (R-13)
  const ctlHours = steps.filter((s) => s.control?.hours?.length);
  if (ctlHours.length && !p.time) issue('material', 'control-hours-assumed', `${ctlHours.map((s) => `${CONTROL_TEXT[s.control!.kind]} (${s.control!.hours!.map((w) => `${w.from}–${w.until}`).join(', ')}${s.control!.hoursNote ? `; ${s.control!.hoursNote}` : ''})`).join('; ')}: open only at some hours; without the time of day it is assumed to be open.`);
  const conditional = steps.filter((s) => s.control?.when === 'origin-not-one-stop');
  const exempt = steps.flatMap((s) => s.exempt ?? []);
  const covered = oneStopCovered(m, p);
  if (conditional.length || exempt.length) {
    if (!m.oneStopSecurity) issue('secondary', 'one-stop-list-missing', 'Transfer security depends on where the inbound flight came from; the airport model has no one-stop security list, so the check is assumed to apply.');
    else if (covered === null) issue('material', 'origin-unknown', 'Transfer security depends on where the inbound flight came from, which is not known here: the check is assumed to apply.');
    else if (covered === false && conditional.length) issue('secondary', 'one-stop-not-covered', `Flights from ${p.originAirport ?? p.originCountry} are not under one-stop security: transfer security applies.`);
    if (exempt.length) issue('secondary', 'one-stop-exempt', `No transfer security for flights from ${p.originAirport ?? p.originCountry} (one-stop security, list as of ${m.oneStopSecurity?.asOf}).`);
  }
  if (entersCountry) issue('material', 'enters-country', `This route enters ${SCHENGEN_HUB(m) ? 'the Schengen area' : 'the country'} (entry passport control, then landside). Whether you may enter depends on your nationality and documents; this is not checked here.`);
  return { warnings, issues };
}

function finish(m: AirportModel, from: string, to: string, steps: Step[], borderCrossings: number, p: Profile, extra: { issues?: RouteIssue[]; entersCountry?: boolean; checkIn?: Route['checkIn'] } = {}): Route {
  const total = sumMin(steps.map((s) => s.minutes));
  const movement = sumMin(steps.filter((s) => s.kind !== 'control').map((s) => s.minutes));
  const controlTime = sumMin(steps.filter((s) => s.kind === 'control').map((s) => s.minutes));
  const basisMix: Route['basisMix'] = {};
  for (const s of steps) if (s.kind !== 'control') basisMix[s.minutes.basis] = (basisMix[s.minutes.basis] ?? 0) + s.minutes.typical;
  const lines = [...new Set(steps.filter((s) => s.kind === 'ride').map((s) => s.line!))];
  const lineById = new Map(m.lines.map((l) => [l.id, l]));
  const modes: Route['modes'] = [];
  for (const s of steps) {
    const md = s.kind === 'ride' ? lineById.get(s.line!)!.mode : (s.kind === 'walk' || s.kind === 'to-platform' || s.kind === 'from-platform') ? 'walk' : null;
    if (md && modes.at(-1) !== md) modes.push(md);
  }
  const parts: string[] = [];
  let walkAcc = 0;
  const flush = () => { if (walkAcc > 0) parts.push(`walk ${Math.round(walkAcc)} min`); walkAcc = 0; };
  for (const s of steps) {
    if (s.kind === 'walk' || s.kind === 'to-platform' || s.kind === 'from-platform') walkAcc += s.minutes.typical;
    else if (s.kind === 'ride') { flush(); parts.push(`${lineById.get(s.line!)!.name} ${Math.round(s.minutes.typical)} min`); }
    else if (s.kind === 'control') { flush(); parts.push(CONTROL_TEXT[s.control!.kind].toLowerCase()); }
    else if (s.kind === 'reclaim') { flush(); parts.push('collect bags'); }
    else if (s.kind === 'check-in') { flush(); parts.push('check in / drop bags'); }
  }
  flush();
  const summary = parts.join(' · ').replace(/^./, (c) => c.toUpperCase());
  // entering the country: an entry passport control followed by a landside place (protected routes)
  const side = (id: string) => m.areas.find((a) => a.id === id)?.side ?? m.stops.find((s) => s.id === id)?.side;
  const iPass = steps.findIndex((s) => s.control?.kind === 'passport');
  const entersCountry = extra.entersCountry ?? (iPass >= 0 && steps.slice(iPass).some((s) => side(s.to) === 'landside' || side(s.from) === 'landside'));
  const { warnings, issues } = routeIssues(m, steps, borderCrossings, p, entersCountry);
  for (const i of extra.issues ?? []) if (!issues.some((x) => x.code === i.code)) issues.push(i);
  return { from, to, steps, total, movement, controlTime, basisMix, modes, lines, controls: steps.filter((s) => s.control).map((s) => s.control!.kind), confidence: weakest(steps.map((s) => s.confidence)), borderCrossings, warnings, issues, entersCountry, checkIn: extra.checkIn, summary };
}

// ---- same-area connections (R-02) ----

/** Assumed minimum for a gate-to-gate walk inside one area (neighbouring gates, leaving the jet bridge). */
export const INTRA_WALK_FLOOR: Minutes = { min: 1, typical: 3, max: 6, basis: 'assumed', note: 'short walk between two gates of the same area (assumed minimum)' };

/** Gate positions spread evenly along each gate group's placement path. */
function gatePoints(gs: GateGroup[]): [number, number][] {
  const out: [number, number][] = [];
  for (const g of gs) {
    const P = g.path ?? []; if (!P.length) continue;
    const L: number[] = []; let tot = 0;
    for (let i = 1; i < P.length; i++) { const s = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); L.push(s); tot += s; }
    const n = g.gates.length;
    for (let k = 0; k < n; k++) {
      let t = n === 1 ? tot / 2 : (tot * k) / (n - 1), i = 0;
      while (i < L.length && t > L[i]) { t -= L[i]; i++; }
      out.push(i >= L.length ? P.at(-1)! : [P[i][0] + ((P[i + 1][0] - P[i][0]) * t) / (L[i] || 1), P[i][1] + ((P[i + 1][1] - P[i][1]) * t) / (L[i] || 1)]);
    }
  }
  return out;
}

/** Model's own walking pace: median typical minutes per schematic unit over its area-to-area walks. */
function minutesPerUnit(m: AirportModel): number | null {
  const pos = new Map(m.areas.map((a) => [a.id, a.anchor]));
  const r = m.walks.filter((w) => !w.flow && w.minutes.typical > 0).map((w) => { const a = pos.get(w.from), b = pos.get(w.to); const d = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0; return d > 0 ? w.minutes.typical / d : NaN; })
    .filter((x) => isFinite(x)).sort((x, y) => x - y);
  return r.length ? r[Math.floor(r.length / 2)] : null;
}

/** Gate-to-gate walk between two unknown gates of one area (never 0): the area's `intraWalk` when the data has it, else
 *  derived from the distribution of distances between its gates (gate placement × the model's walking pace: typical =
 *  mean distance, max = 90th percentile), never below INTRA_WALK_FLOOR. */
export function intraWalk(m: AirportModel, a: Area, date?: string): Minutes & { method: 'data' | 'derived' | 'assumed' } {
  if (a.intraWalk) return { ...a.intraWalk, method: 'data' };
  const d = date ?? m.asOf;
  const pts = gatePoints(m.gateGroups.filter((g) => g.area === a.id && g.gates.length && stateOn(g.status, d) === 'active'));
  const k = minutesPerUnit(m);
  const F = INTRA_WALK_FLOOR;
  if (pts.length >= 2 && k) {
    const ds: number[] = [];
    for (let i = 0; i < pts.length; i++) for (let j = 0; j < pts.length; j++) if (i !== j) ds.push(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    ds.sort((x, y) => x - y);
    const mean = ds.reduce((s, x) => s + x, 0) / ds.length, p90 = ds[Math.floor(ds.length * 0.9)];
    const r1 = (x: number) => Math.round(x * 2) / 2;
    const typical = r1(mean * k), max = r1(p90 * k);
    if (typical >= F.typical) return { min: F.min, typical, max: Math.max(max, typical), basis: 'derived', note: `gate-to-gate distances of ${pts.length} gates on the schematic × the model's walking pace (approximate)`, method: 'derived' };
  }
  return { ...F, method: 'assumed' };
}

/** Append the special-screening step(s) that apply at the departure area (R-19). */
function withScreening(m: AirportModel, r: Route, p: Profile): Route {
  const to = m.areas.find((a) => a.id === r.to);
  if (!to || to.side !== 'airside') return r;
  const ss = specialScreeningFor(m, p);
  if (!ss.length) return r;
  const steps = [...r.steps], issues = [...r.issues];
  let deadline: Route['deadline'] = r.deadline;
  for (const s of ss) {
    if (s.minutes) steps.push({ kind: 'control', text: `${CONTROL_TEXT['special-screening']}: ${s.text}`, from: r.to, to: r.to, minutes: s.minutes, control: { kind: 'special-screening', minutes: s.minutes, note: s.text }, confidence: s.certainty === 'verified' ? 'verified' : s.certainty === 'probable' ? 'probable' : 'unknown', sources: s.sources, refId: s.id });
    if (s.deadline && (!deadline || s.deadline.minutesBeforeDeparture > deadline.minutes)) deadline = { minutes: s.deadline.minutesBeforeDeparture, text: s.deadline.text };
    issues.push({ level: s.issueLevel ?? 'material', code: s.minutes ? 'special-screening' : 'special-screening-time-unknown', text: s.minutes ? `Additional screening for this flight: ${s.text}` : `Additional screening for this flight (time not known): ${s.text}` });
    if (s.areas?.length && !s.areas.includes(r.to)) issues.push({ level: 'material', code: 'special-screening-area', text: `Flights covered by "${s.text}" normally leave from ${s.areas.join(', ')}, not from this area.` });
  }
  const out = finish(m, r.from, r.to, steps, r.borderCrossings, p, { issues, entersCountry: r.entersCountry, checkIn: r.checkIn });
  return { ...out, deadline };
}

// ---- mandatory transfer screening for origins outside one-stop security (AU-1) ----
// EU Regulation 300/2008 Annex 4.1 (applied in Switzerland through the EU–CH air transport agreement): transfer
// passengers and their cabin baggage are screened unless they arrive from a Member State or a third country recognised
// as equivalent (Regulation 2015/1998 Attachment 4-B; Tel Aviv removed by Regulation 2025/920). So a protected transfer
// from such an origin can never reach a departure gate unscreened. Where the model places the airport's own transfer
// checkpoint on an airside way, the route is taken through it; otherwise the airport's own conditional transfer-security
// allowance is added as a step whose location is not established (never 0 min, never an invented path).

const SCREEN_KINDS = new Set<Control['kind']>(['security', 'transfer-security']);
const screened = (r: Route) => r.steps.some((s) => s.control && SCREEN_KINDS.has(s.control.kind));

/** Does this protected route need a transfer screening (origin not known to be under one-stop security)? */
export function needsTransferScreening(m: AirportModel, from: string, to: string, p: Profile): boolean {
  if (!p.transfer || p.fromArrival === false || !m.oneStopSecurity || oneStopCovered(m, p) === true) return false;
  const date = routingDate(m, p);
  const a = m.areas.find((x) => x.id === from), b = m.areas.find((x) => x.id === to);
  return !!a && !!b && a.side === 'airside' && b.side === 'airside' && zoneOn(a, date) !== 'schengen';
}

/** The airport's own conditional transfer-security allowance (largest typical among its conditional controls). */
export function transferScreeningAllowance(m: AirportModel): Control | null {
  const cs = [...m.walks.flatMap((w) => [...(w.controls ?? []), ...(w.reverseControls ?? [])]), ...m.stops.flatMap((s) => [...(s.accessControls ?? []), ...(s.egressControls ?? [])]), ...m.areas.flatMap((a) => [...(a.entryControls ?? []), ...(a.intraControls ?? [])])]
    .filter((c) => c.when === 'origin-not-one-stop' && c.kind === 'transfer-security');
  return cs.sort((x, y) => y.minutes.typical - x.minutes.typical || y.minutes.max - x.minutes.max)[0] ?? null;
}

function findRouteBase(m: AirportModel, from: string, to: string, p: Profile): Route | null {
  const r = findRouteCore(m, from, to, p);
  if (!r || screened(r) || !needsTransferScreening(m, from, to, p)) return r;
  // 1. the model's own transfer checkpoint on an airside way (same passport-crossing budget as the usual route)
  const q = { ...p, stayAirside: true };
  const via = search(m, from, to, q, Math.max(1, r.borderCrossings), from === to, true);
  // a same-area loop through another gate area (e.g. riding a shuttle to another terminal and back) is not a transfer flow
  const gated = new Set(m.gateGroups.filter((g) => g.gates.length).map((g) => g.area));
  // … nor is any round trip that comes back to an area already passed (MUC H → bus to T1 → back to H → L)
  const isArea = new Set(m.areas.map((a) => a.id));
  const seq = via ? [from, ...via.steps.map((s) => s.to).filter((id, i, xs) => isArea.has(id) && id !== xs[i - 1])] : [];
  const revisit = seq.slice(0, from === to ? -1 : undefined).some((id, i, xs) => xs.indexOf(id) !== i);
  // (a pass back through a transfer hub, FCO E plaza → T3 transfer level → E plaza → E11-24, is a real transfer flow)
  const otherGated = !!via && via.steps.some((s) => [s.from, s.to].some((id) => id !== from && id !== to && gated.has(id)));
  const detour = otherGated && (revisit || from === to);
  if (via && !detour) { via.issues.push({ level: 'secondary', code: 'transfer-screening-route', text: 'Arriving from an origin outside one-stop security: the route goes through the transfer security checkpoint.' }); return via; }
  // 2. no modelled place: the airport's own allowance, location not established
  const c0 = transferScreeningAllowance(m);
  const c: Control = c0 ? { ...c0, hours: undefined, hoursNote: undefined, note: 'required for arrivals from outside one-stop security; where it takes place on this route is not established' } : { kind: 'transfer-security', when: 'origin-not-one-stop', minutes: { min: 3, typical: 10, max: 30, basis: 'assumed', note: 'no transfer-security allowance in the model' }, note: 'required for arrivals from outside one-stop security; where it takes place on this route is not established' };
  const step: Step = { kind: 'control', text: `${CONTROL_TEXT['transfer-security']} (${c.note})`, from: r.steps[0]?.to ?? from, to: r.steps[0]?.to ?? from, minutes: c.minutes, control: c, confidence: 'unknown', sources: [], refId: `unplaced-transfer-security:${m.iata}` };
  const steps = [...r.steps];
  steps.splice(Math.min(1, steps.length), 0, step);
  if (p.time) { let t = toMin(p.time); for (const s of steps) { s.at = hhmm(t); t += s.minutes.typical; } }
  return finish(m, from, to, steps, r.borderCrossings, p, { entersCountry: r.entersCountry, checkIn: r.checkIn, issues: [...r.issues, { level: 'material', code: 'transfer-screening-unplaced', text: `Arriving from an origin outside one-stop security, you must pass transfer security before your departure gate. The model does not establish where on this route; about ${c.minutes.typical} min (up to ${c.minutes.max}) is included, as at this airport's other transfer checkpoints.` }] });
}

function findRouteCore(m: AirportModel, from: string, to: string, p: Profile): Route | null {
  if (from === to) {
    const a = m.areas.find((x) => x.id === from);
    if (!a || stateOn(a.status, routingDate(m, p)) !== 'active') return null;
    // An arriving passenger in an area with segregated arrivals must leave through the arrivals flow (and its transfer
    // controls) before reaching a departure gate of the same area.
    if (p.fromArrival !== false && a.arrivals === 'segregated') return search(m, from, to, p, 1, true) ?? search(m, from, to, p, 3, true);
    // Otherwise a gate-to-gate walk inside the area (never 0 minutes).
    const w = intraWalk(m, a, routingDate(m, p));
    const step: Step = { kind: 'walk', text: `Walk between two gates of ${a.name}`, from, to, minutes: { min: w.min, typical: w.typical, max: w.max, basis: w.basis, note: w.note }, confidence: w.method === 'data' ? a.confidence : 'inferred', sources: w.method === 'data' ? (a.intraWalk?.sources ?? a.sources) : [], refId: `intra:${a.id}`, at: p.time };
    // CR-B1: controls an arriving passenger passes on a connection inside this area (conditional ones by origin)
    const covered = oneStopCovered(m, p);
    const ic = p.fromArrival === false ? [] : (a.intraControls ?? []).filter((c) => c.when !== 'origin-not-one-stop' || (p.transfer && covered !== true));
    const exempt = p.fromArrival === false ? [] : (a.intraControls ?? []).filter((c) => c.when === 'origin-not-one-stop' && p.transfer && covered === true);
    if (exempt.length) step.exempt = exempt;
    const ctl = controlSteps(ic, to, a.confidence, a.sources);
    return finish(m, from, to, [step, ...ctl], 0, p, { issues: w.method === 'data' ? [] : [{ level: 'secondary', code: 'intra-walk-estimated', text: `Walk inside ${a.short}: the gates are not known, so a gate-to-gate walk of about ${w.typical} min (up to ${w.max}) is ${w.method === 'derived' ? 'estimated from the gate layout' : 'assumed'}.` }] });
  }
  // transfer-only services are for passengers continuing to a departure gate: a route ending landside never uses them
  const q = p.transfer && m.areas.find((a) => a.id === to)?.side === 'landside' ? { ...p, transfer: false } : p;
  return search(m, from, to, q, 1) ?? search(m, from, to, q, 3);
}

const withHours = new WeakMap<AirportModel, boolean>();
/** Whether any control of the model has published opening hours (cached per model object). */
function hasControlHours(m: AirportModel): boolean {
  if (!withHours.has(m)) {
    const cs = [...m.walks.flatMap((w) => [...(w.controls ?? []), ...(w.reverseControls ?? [])]), ...m.stops.flatMap((s) => [...(s.accessControls ?? []), ...(s.egressControls ?? [])]), ...m.areas.flatMap((a) => [...(a.entryControls ?? []), ...(a.intraControls ?? [])])];
    withHours.set(m, cs.some((c) => c.hours?.length));
  }
  return withHours.get(m)!;
}

export function findRoute(m: AirportModel, from: string, to: string, p: Profile = DEFAULT_PROFILE): Route | null {
  const r = findRouteBase(m, from, to, p);
  if (r && p.time && p.transfer && hasControlHours(m)) {
    // the usual way exists at other hours: a checkpoint on it is closed now, so the route falls back to another way (often
    // leaving the airside area) — not a verified night procedure (AMS GH filter 04:30–23:30, Schengen exit filter 05:00–22:00)
    const day = findRouteBase(m, from, to, { ...p, time: undefined });
    const shut = day && day.steps.map((s) => s.refId ?? s.kind).join('>') !== r.steps.map((s) => s.refId ?? s.kind).join('>') ? day.steps.filter((s) => s.control?.hours?.length && !s.control.hours.some((w) => inWindow(p.time!, w))) : [];
    if (shut.length) r.issues.push({ level: 'material', code: 'checkpoint-closed', text: `${shut.map((s) => `${CONTROL_TEXT[s.control!.kind]} on the airside way (open ${s.control!.hours!.map((w) => `${w.from}–${w.until}`).join(', ')})`).join('; ')} is closed at ${p.time}. The only modelled alternative leaves the airside area; it is not confirmed as the procedure at this hour. Ask the airline or transfer desk.` });
  }
  return r && withScreening(m, r, p);
}

/** Why `findRoute` found nothing: an area is closed, the route exists only at other hours, or no route is modelled. */
export function noRouteReason(m: AirportModel, from: string, to: string, p: Profile): 'closed-area' | 'closed-at-time' | 'no-route' {
  const date = routingDate(m, p);
  if ([from, to].some((id) => { const a = m.areas.find((x) => x.id === id); return !a || stateOn(a.status, date) !== 'active'; })) return 'closed-area';
  if (p.time && findRoute(m, from, to, { ...p, time: undefined })) return 'closed-at-time';
  return 'no-route';
}

// ---- self-transfer as one route (R-11, R-12) ----

interface FacilityState { closed: boolean; issues: RouteIssue[] }
const fmtHours = (f: CheckInFacility) => `${f.name} ${f.hours.map((w) => `${w.from}–${w.until}`).join(', ')}${f.hoursNote ? ` (${f.hoursNote})` : ''}`;
/** The airline's check-in facilities in a hall at the clock minute the passenger reaches it (null = untimed). */
export function facilityState(h: Area, airline: string | undefined, at: number | null): FacilityState {
  const fac = (h.checkIn?.facilities ?? []).filter((f) => !!airline && f.airlines.includes(airline.toUpperCase()));
  if (!fac.length) return { closed: false, issues: [] };
  const list = fac.map(fmtHours).join('; ');
  if (at === null) return { closed: false, issues: [{ level: 'secondary', code: 'check-in-hours', text: `Check-in at ${h.name} for this airline: ${list}. Without the time of day it is assumed open.` }] };
  const now = hhmm(at);
  const open = fac.filter((f) => openAt(f.hours, now));
  if (!open.length) return { closed: true, issues: [{ level: 'material', code: 'check-in-closed', text: `You reach ${h.name} at about ${now}, when this airline's check-in there is closed (${list}). Bags could not be dropped again then; check other options with the airline.` }] };
  if (open.every((f) => f.kind === 'self-bag-drop')) return { closed: false, issues: [{ level: 'material', code: 'self-bag-drop-only', text: `At about ${now} only ${open.map((f) => f.name).join(' / ')} is open at ${h.name}: it needs a boarding pass from online check-in${open[0].eligibility ? ` (${open[0].eligibility})` : ''}.` }] };
  return { closed: false, issues: [] };
}

export const RECLAIM_DEFAULT: Minutes = { min: 15, typical: 25, max: 45, basis: 'assumed', note: 'waiting for checked bags' };
export const BAG_DROP_DEFAULT: Minutes = { min: 5, typical: 10, max: 25, basis: 'assumed', note: 'check-in / bag-drop queue' };

/** Landside check-in halls for a departure area: those whose `checkIn.serves` lists it; else every `checkIn` hall (the
 *  model does not say which serves it); else, when the model has no check-in data, every landside hall (never a
 *  transfer hub or a station). */
export function checkInHalls(m: AirportModel, to: string, date: string): { halls: Area[]; mode: 'serves' | 'any-check-in' | 'no-check-in-data' } {
  const active = m.areas.filter((a) => a.side === 'landside' && stateOn(a.status, date) === 'active');
  const withCi = active.filter((a) => a.checkIn);
  const serving = withCi.filter((a) => a.checkIn!.serves.includes(to));
  if (serving.length) return { halls: serving, mode: 'serves' };
  if (withCi.length) return { halls: withCi, mode: 'any-check-in' };
  return { halls: active.filter((a) => a.kind === 'landside-hall'), mode: 'no-check-in-data' };
}

/**
 * A self-transfer as ONE route: arrival area → arrivals flow → entry passport (if any) → baggage reclaim → customs →
 * landside → the check-in hall of the departure area (bag drop = the check-in deadline point) → security → departure
 * area. The clock runs through the whole route. Without check-in data the hall nearest to the departure area is used
 * (material issue).
 */
export function findSelfTransfer(m: AirportModel, from: string, to: string, p: Omit<Profile, 'transfer'> & { transfer?: boolean; reclaim?: Minutes; bagDrop?: Minutes } = {}): Route | null {
  const date = routingDate(m, p as Profile);
  const reclaim = p.reclaim ?? RECLAIM_DEFAULT, bagDrop = p.bagDrop ?? BAG_DROP_DEFAULT;
  const { halls, mode } = checkInHalls(m, to, date);
  const t0 = p.time ? toMin(p.time) : null;
  let best: { r1: Route; r2: Route; h: Area; fac: FacilityState } | null = null;
  for (const h of halls) {
    const r1 = findRouteBase(m, from, h.id, { ...p, transfer: false, fromArrival: true, stayAirside: false, arrivalsExit: true });
    if (!r1) continue;
    const fac = facilityState(h, p.airline, t0 === null ? null : t0 + r1.total.typical + reclaim.typical);
    const t1 = t0 === null ? undefined : hhmm(t0 + r1.total.typical + reclaim.typical + bagDrop.typical);
    const r2 = findRoute(m, h.id, to, { ...p, transfer: false, fromArrival: false, stayAirside: false, time: t1, date: t0 !== null && t0 + r1.total.typical + reclaim.typical + bagDrop.typical >= 1440 ? addDays(date, 1) : p.date });
    if (!r2) continue;
    // a hall whose facility for this airline is closed when reached ranks after every open one
    const score = (x: { r1: Route; r2: Route; fac: FacilityState }) => [x.fac.closed ? 1 : 0, ...(mode === 'no-check-in-data' ? [x.r2.total.typical, x.r1.total.typical + x.r2.total.typical] : [x.r1.total.typical + x.r2.total.typical, 0])];
    const c = { r1, r2, h, fac };
    const sc = score(c), sb = best && score(best);
    if (!sb || sc[0] < sb[0] || (sc[0] === sb[0] && (sc[1] < sb[1] || (sc[1] === sb[1] && sc[2] < sb[2])))) best = c;
  }
  if (!best) return null;
  const { r1, r2, h, fac } = best;
  // baggage reclaim: before customs, else where the route first reaches landside, else at the hall
  const s1 = r1.steps.map((s) => ({ ...s }));
  const side = (id: string) => m.areas.find((a) => a.id === id)?.side ?? m.stops.find((s) => s.id === id)?.side;
  let iR = s1.findIndex((s) => s.control?.kind === 'customs');
  if (iR < 0) { const j = s1.findIndex((s) => side(s.to) === 'landside'); iR = j < 0 ? s1.length : j + 1; while (iR < s1.length && s1[iR].kind === 'control') iR++; }
  const at = s1[iR - 1]?.to ?? from;
  // allowances, not route facts: they take the confidence of the place where they happen
  const reclaimStep: Step = { kind: 'reclaim', text: 'Collect your checked bags (baggage reclaim)', from: at, to: at, minutes: reclaim, confidence: s1[iR - 1]?.confidence ?? 'inferred', sources: s1[iR - 1]?.sources ?? [] };
  s1.splice(iR, 0, reclaimStep);
  const ciStep: Step = { kind: 'check-in', text: `Check in / drop bags again at ${h.name}${h.checkIn?.note ? ` (${h.checkIn.note})` : ''}`, from: h.id, to: h.id, minutes: bagDrop, confidence: h.checkIn ? h.confidence : 'inferred', sources: h.checkIn?.sources ?? h.sources };
  const steps = [...s1, ciStep, ...r2.steps];
  if (t0 !== null) { let t = t0; for (const s of steps) { s.at = hhmm(t); t += s.minutes.typical; } }
  const issues: RouteIssue[] = [...r1.issues.filter((i) => i.code !== 'enters-country'), ...r2.issues.filter((i) => i.code !== 'enters-country')];
  if (mode === 'any-check-in') issues.push({ level: 'material', code: 'check-in-hall-unknown', text: `The model does not say which hall checks in flights from ${m.areas.find((a) => a.id === to)?.short ?? to}; ${h.name} is assumed.` });
  if (mode === 'no-check-in-data') issues.push({ level: 'material', code: 'check-in-hall-unknown', text: `Check-in halls are not in the airport model; ${h.name} (nearest to the departure area) is assumed as the check-in point.` });
  issues.push(...fac.issues);
  if (!s1.some((s) => s.control?.kind === 'customs')) issues.push({ level: 'secondary', code: 'customs-not-modelled', text: 'No customs exit is modelled on the way out (the green / red channel after baggage reclaim).' });
  const enters = r1.steps.some((s) => s.control?.kind === 'passport');
  const out = finish(m, from, to, steps, r1.borderCrossings + r2.borderCrossings, p as Profile, { issues, entersCountry: enters, checkIn: { area: h.id, step: s1.length } });
  return out;
}

export interface MatrixCell { from: string; to: string; route: Route | null; alternatives: { label: string; route: Route }[]; reason?: string }
export interface Matrix { iata: string; profile: Profile; areas: Area[]; cells: MatrixCell[] }

const sig = (r: Route) => r.steps.filter((s) => s.kind === 'ride' || s.kind === 'walk').map((s) => s.refId).join('>');

export function routeWithAlternatives(m: AirportModel, from: string, to: string, p: Profile = DEFAULT_PROFILE): MatrixCell {
  const route = findRoute(m, from, to, p);
  const alternatives: MatrixCell['alternatives'] = [];
  if (route && from !== to) {
    const tries: [string, Profile][] = [['Walking only', { ...p, walkOnly: true }], ['With transport', { ...p, preferTransport: true }]];
    for (const [label, q] of tries) {
      const r = findRoute(m, from, to, q);
      if (r && sig(r) !== sig(route) && !alternatives.some((a) => sig(a.route) === sig(r)) && r.total.typical <= route.total.typical * 2.5 + 10) alternatives.push({ label, route: r });
    }
  }
  let reason: string | undefined;
  const date = routingDate(m, p);
  const closed = [from, to].map((id) => m.areas.find((a) => a.id === id)).find((a) => a && stateOn(a.status, date) !== 'active');
  if (!route && from !== to) reason = closed ? `${closed.name} is ${stateOn(closed.status, date)} on ${date}` : p.transfer ? 'no modelled connection' : 'no connection without transfer-only services';
  return { from, to, route, alternatives, reason };
}

export function buildMatrix(m: AirportModel, p: Profile = DEFAULT_PROFILE): Matrix {
  const date = routingDate(m, p);
  const areas = m.areas.filter((a) => a.matrix && stateOn(a.status, date) === 'active'); // closed areas drop out of the matrix
  const cells: MatrixCell[] = [];
  for (const a of areas) for (const b of areas) cells.push(a.id === b.id ? { from: a.id, to: b.id, route: null, alternatives: [] } : routeWithAlternatives(m, a.id, b.id, p));
  return { iata: m.iata, profile: p, areas, cells };
}

/** Gate number → its group and area (case-insensitive, ignores spaces: "a 12" = "A12"). */
export function findGate(m: AirportModel, gate: string): { gate: string; group: GateGroup; area: Area } | null {
  const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  const g = norm(gate);
  for (const grp of m.gateGroups) {
    const hit = grp.gates.find((x) => norm(x) === g);
    if (hit) { const area = m.areas.find((a) => a.id === grp.area); if (area) return { gate: hit, group: grp, area }; }
  }
  return null;
}

/** Schematic position of a node (area anchor, stop anchor). */
export function nodePos(m: AirportModel, id: string): [number, number] | null {
  const a = m.areas.find((x) => x.id === id);
  if (a) { const [dx, dy] = stackShift(a); return [a.anchor[0] + dx, a.anchor[1] + dy]; }
  return m.stops.find((s) => s.id === id)?.anchor ?? null;
}

/** Drawing offset of a stacked area (levels sharing one footprint are drawn shifted up-right by level). */
export const STACK_STEP = 10;
export const stackShift = (a?: Area): [number, number] => (a?.stack ? [a.stack.order * STACK_STEP, -a.stack.order * STACK_STEP] : [0, 0]);

/** Polyline of a ride between two stops along the line's drawn path (falls back to straight segments through the stops). */
export function ridePath(m: AirportModel, line: Line, stops: string[]): [number, number][] {
  const pts = stops.map((s) => nodePos(m, s)!).filter(Boolean);
  if (!line.path?.length) return pts;
  // take the sub-path between the path vertices nearest to the first and last stop
  const near = (p: [number, number]) => line.path!.reduce((bi, q, i, arr) => (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(arr[bi][0] - p[0], arr[bi][1] - p[1]) ? i : bi), 0);
  const i = near(pts[0]), j = near(pts.at(-1)!);
  const seg = i <= j ? line.path.slice(i, j + 1) : line.path.slice(j, i + 1).reverse();
  if (line.direction === 'loop' && i > j) {
    // loops run forward: i → end → start → j
    return [pts[0], ...line.path.slice(i), ...line.path.slice(0, j + 1), pts.at(-1)!];
  }
  return [pts[0], ...seg, pts.at(-1)!];
}

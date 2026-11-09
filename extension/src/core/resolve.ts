// From what history (or the page) says about a flight to weighted candidate AREAS of the airport model.
// Most specific usable evidence first: the gate distribution of the last 30 days → the gate-area (letter) distribution
// → the terminal distribution → (no history) a gate or terminal published for this flight-day → no evidence (every
// plausible area in the flight's border zone).
//
// Probabilities stay at the level of the evidence (R-20, R-22):
//   - a value that names several areas (terminal "2E" = halls K, L, M) is ONE evidence group with its share; the areas
//     inside it share the weight equally for routing, but no per-area percentage is claimed (`areaLevel` false);
//   - history that does not map onto the model (unknown gates) stays as an explicit `unassigned` share, never rescaled;
//   - small shares are kept (they can still matter for the verdict); the summary hides them, not the analysis.
// A gate is resolved to its own gate group first, whatever the passenger's zone (R-08); a zone conflict is flagged.
import type { AirportModel, Area, Zone } from '../../../airportmaps/src/types.ts';
import { findGate, specialScreeningFor, stateOn, zoneOn } from '../../../airportmaps/src/route.ts';
import { zoneFor } from './airports.ts';
import type { FieldAnswer, FlightAnswer } from './history.ts';
import type { Provenance } from './types.ts';

export interface AreaCandidate {
  area: Area;
  /** Routing weight: the evidence share, split equally over the areas of a multi-area value. Σ p = 1 − unassigned. */
  p: number;
  /** Evidence share of the value(s) naming this area (a terminal's whole share for each of its halls). */
  evidence: number;
  via: string[];
  /** Label of the evidence group when the value names several areas ("2E"). */
  group?: string;
  /** The gate's own area is in another border zone than the flight's (kept, flagged; R-08). */
  zoneConflict?: boolean;
}
export interface EvidenceGroup { label: string; p: number; areas: string[] }
export interface Resolution {
  direction: 'arrival' | 'departure';
  zone: Zone | null;                 // border zone of the flight at this airport (from the other airport's country)
  candidates: AreaCandidate[];       // most likely first
  /** Evidence groups at the level the evidence supports (what may be shown with a percentage). */
  groups: EvidenceGroup[];
  /** Share of the evidence that maps to no area of the model (could be any area). */
  unassigned: number;
  /** Every group names a single area, so per-area percentages are supported. */
  areaLevel: boolean;
  provenance: Provenance;            // observed (published for the day) | predicted (history) | unknown
  basis: 'published-gate' | 'gate' | 'gate-area' | 'terminal' | 'airline-terminal' | 'zone-only';
  sample: number | null;             // flight-days behind the distribution used
  /** Every area this flight could use (eligible areas of its zone, or those a special screening names). */
  universe?: string[];
  summary: string;
  notes: string[];
}

/** Shares below this are not listed in the summary (they stay in the analysis). */
export const MIN_SHARE = 0.05;
const FINAL = new Set(['boarding', 'gate-closed', 'departed', 'airborne', 'approaching', 'landed', 'arrived']);
const IGNORED = new Set(['cancelled', 'diverted']);
const normT = (t: string) => t.toUpperCase().replace(/^TERMINAL\s*/, '').replace(/^T(?=\d)/, '').trim();

/** Active airside areas with active gates, compatible with the flight's zone on the date ('mixed' areas fit both). */
export function eligibleAreas(m: AirportModel, zone: Zone | null, date: string): Area[] {
  const active = (x: { status?: any }) => stateOn(x.status, date) === 'active';
  const withGates = new Set(m.gateGroups.filter((g) => active(g) && g.gates.length).map((g) => g.area));
  const all = m.areas.filter((a) => a.side === 'airside' && active(a) && withGates.has(a.id));
  const fit = zone ? all.filter((a) => { const z = zoneOn(a, date); return z === zone || z === 'mixed'; }) : all;
  if (fit.length) return fit;
  // A zone with no gate list at all (LHR UK & Ireland flights: logical areas in the common departure lounges, gates not
  // published): the gate-less airside areas of that zone that the feed's terminal table names. Other zones unchanged.
  if (zone) {
    const named = new Set([...Object.values(m.feedTerminals?.arrival ?? {}), ...Object.values(m.feedTerminals?.departure ?? {})].flat());
    const gateless = m.areas.filter((a) => a.side === 'airside' && active(a) && named.has(a.id) && !withGates.has(a.id) && zoneOn(a, date) === zone);
    if (gateless.length) return gateless;
  }
  return all;
}

/** Areas a terminal value names: the model's feed table first (R-17, R-23), then area.terminal "T2E" ↔ "2E"; MUC "1B"
 *  falls back to T1 when no area is called T1B. */
function areasForTerminal(m: AirportModel, eligible: Area[], t: string, direction: 'arrival' | 'departure'): Area[] {
  const table = m.feedTerminals?.[direction];
  if (table && t in table) return eligible.filter((a) => table[t].includes(a.id));
  const v = normT(t);
  const exact = eligible.filter((a) => a.terminal && normT(a.terminal) === v);
  if (exact.length) return exact;
  const digit = /^(\d)/.exec(v)?.[1];
  return digit ? eligible.filter((a) => a.terminal && normT(a.terminal) === digit) : [];
}

function areasForGateArea(m: AirportModel, eligible: Area[], letter: string): Area[] {
  const ids = new Set(m.gateGroups.filter((g) => g.gates.some((x) => new RegExp(`^${letter}\\s?\\d`, 'i').test(x) || x.toUpperCase() === letter)).map((g) => g.area));
  return eligible.filter((a) => ids.has(a.id));
}

/** The border zone of one gate: gate-level override → its group's zone → its area's (dated) zone. */
function gateZone(m: AirportModel, gate: string, date: string): Zone | null {
  const hit = findGate(m, gate);
  if (!hit) return null;
  return hit.group.zoneGates?.find((z) => z.gates.includes(hit.gate))?.zone ?? hit.group.zone ?? zoneOn(hit.area, date);
}

interface GateHit { areas: Area[]; conflict: boolean }
/** A gate → its own area (whatever the passenger's zone), else bare numbers with a terminal prefix ("30" → "T1 30", R-43),
 *  else (gate not in the model) every eligible area with gates of that letter. */
function areasForGate(m: AirportModel, eligible: Area[], gate: string, zone: Zone | null, date: string): GateHit {
  // a feed field holding two gates ("S8,S7", "C44/C43": paired stand numbers, MAD) → each gate on its own; the areas
  // they name together (usually one), never a letter guess on the combined string (audit 2026-11-02)
  const parts = gate.split(/\s*[,;/]\s*/).filter(Boolean);
  if (parts.length > 1) {
    const hits = parts.map((x) => areasForGate(m, eligible, x, zone, date));
    const ids = new Set<string>(), areas: Area[] = [];
    for (const h of hits) for (const a of h.areas) if (!ids.has(a.id)) { ids.add(a.id); areas.push(a); }
    return { areas, conflict: hits.some((h) => h.conflict) };
  }
  const active = (x: { status?: any }) => stateOn(x.status, date) === 'active';
  const hit = findGate(m, gate);
  if (hit && active(hit.area) && active(hit.group) && hit.area.side === 'airside') {
    const gz = gateZone(m, gate, date);
    return { areas: [hit.area], conflict: !!zone && !!gz && gz !== zone && gz !== 'mixed' };
  }
  if (/^\d{1,3}$/.test(gate.trim())) {
    const n = Number(gate.trim());
    const ids = new Set(m.gateGroups.filter((g) => active(g) && g.gates.some((x) => { const mm = /^T\d+[A-Z]?\s+0*(\d+)$/i.exec(x.trim()); return !!mm && Number(mm[1]) === n; })).map((g) => g.area));
    const areas = eligible.filter((a) => ids.has(a.id));
    if (areas.length) return { areas, conflict: false };
  }
  if (hit) return { areas: [], conflict: false };   // the gate's own area is closed: do not move it to another area
  const letter = /^([A-Z]+)/i.exec(gate)?.[1];
  return { areas: letter ? areasForGateArea(m, eligible, letter.toUpperCase()) : [], conflict: false };
}

interface Entry { value: string; share: number; areas: Area[]; conflict?: boolean }

const fmtPct = (p: number) => `${Math.round(p * 100)} %`;

export function resolveAreas(m: AirportModel, q: { direction: 'arrival' | 'departure'; other: string; answer: FlightAnswer | null; date: string; outbound?: { destinationAirport?: string; destinationCountry?: string; airline?: string }; flight?: { airline?: string; operatedByOther?: boolean } }): Resolution {
  const zone = zoneFor(m.iata, q.other);
  let eligible = eligibleAreas(m, zone, q.date);
  const notes: string[] = [];
  if (!zone) notes.push(`The country of ${q.other} is not known, so the Schengen / non-Schengen side could not be narrowed down.`);
  // special screening that names its departure areas (R-19): only those areas are candidates
  if (q.direction === 'departure' && q.outbound) for (const s of specialScreeningFor(m, q.outbound)) {
    if (s.areas?.length && s.certainty !== 'unknown') {
      // CR-B5: a named area counts even without gate numbers (MUC Hall F)
      const only = m.areas.filter((a) => s.areas!.includes(a.id) && a.side === 'airside' && stateOn(a.status, q.date) === 'active');
      if (only.length) { eligible = only; notes.push(`${s.text}: departures use ${only.map((a) => a.short).join(', ')} (${s.certainty}).`); }
    }
  }
  const a = q.answer;

  const done = (basis: Resolution['basis'], provenance: Provenance, entries: Entry[], unassigned: number, sample: number | null, label: string): Resolution => {
    const by = new Map<string, AreaCandidate>();
    const groups: EvidenceGroup[] = [];
    for (const e of entries) {
      if (!e.areas.length || e.share <= 0) continue;
      const g = groups.find((x) => x.areas.length === e.areas.length && x.areas.every((id) => e.areas.some((ar) => ar.id === id)));
      if (g) { g.p += e.share; if (!g.label.split('/').includes(e.value)) g.label += `/${e.value}`; }
      else groups.push({ label: e.value, p: e.share, areas: e.areas.map((x) => x.id) });
      for (const ar of e.areas) {
        const c = by.get(ar.id) ?? { area: ar, p: 0, evidence: 0, via: [] };
        c.p += e.share / e.areas.length; c.evidence += e.share; if (e.value && !c.via.includes(e.value)) c.via.push(e.value);
        if (e.areas.length > 1) c.group = e.value;
        if (e.conflict) c.zoneConflict = true;
        by.set(ar.id, c);
      }
    }
    const cands = [...by.values()].sort((x, y) => y.evidence - x.evidence || y.p - x.p);
    groups.sort((x, y) => y.p - x.p);
    const areaLevel = groups.every((g) => g.areas.length === 1);
    for (const c of cands.filter((x) => x.zoneConflict)) notes.push(`Gate area ${c.area.short} is in another border zone than this flight's (${zone}); it is kept as the data says. Check on the day.`);
    if (unassigned > 0.005 && provenance !== 'unknown') notes.push(`${fmtPct(unassigned)} of the evidence does not match an area of the map; it is kept as “other / unknown”, not spread over the areas shown.`);
    const name = (g: EvidenceGroup) => g.areas.length === 1 ? (by.get(g.areas[0])?.area.short ?? g.label) : `${g.label} (${g.areas.map((id) => by.get(id)?.area.short ?? id).join('/')})`;
    const list = provenance === 'unknown' ? cands.map((c) => c.area.short).join(', ')
      : groups.filter((g) => g.p >= MIN_SHARE).map((g) => `${name(g)} ${fmtPct(g.p)}`).join(', ') + (unassigned >= MIN_SHARE ? `, other ${fmtPct(unassigned)}` : '');
    return { direction: q.direction, zone, candidates: cands, groups, unassigned, areaLevel, provenance, basis, sample, universe: eligible.map((x) => x.id), summary: `${label}: ${list}`, notes };
  };

  /** History field → entries (shares of the whole sample; unmapped values become `unassigned`). */
  const fromField = (field: 'gate' | 'gateArea' | 'terminal'): { entries: Entry[]; unassigned: number; f: FieldAnswer; mostly: boolean; used: number } | null => {
    const f = a?.[field];
    if (!f || f.status !== 'predicted' || !f.sample) return null;
    const entries: Entry[] = [];
    let used = 0, named = 0;
    const table = field === 'terminal' ? m.feedTerminals?.[q.direction] : undefined;
    for (const d of f.distribution) {
      // CR-B3: a feed value the model maps to no area ([]) is known history about a closed / unmodelled terminal: unmapped share
      if (table && d.value in table && !table[d.value].length) { named += d.n; continue; }
      const hit = field === 'terminal' ? { areas: areasForTerminal(m, eligible, d.value, q.direction), conflict: false } : field === 'gate' ? areasForGate(m, eligible, d.value, zone, q.date) : { areas: areasForGateArea(m, eligible, d.value), conflict: false };
      if (!hit.areas.length) continue;
      used += d.n;
      entries.push({ value: d.value, share: d.n / f.sample, areas: hit.areas, conflict: hit.conflict });
    }
    if (!entries.length) return null;
    return { entries, unassigned: (f.sample - used) / f.sample, f, mostly: used + named >= f.sample * 0.5, used };
  };
  // the most specific field whose history mostly maps onto the model; else the field that maps best (its unmapped
  // share stays explicit: never a fall-back to "no evidence", which would make more unmapped history look better)
  const history = () => {
    const all = (['gate', 'gateArea', 'terminal'] as const).map((field) => ({ h: fromField(field), field, basis: field === 'gateArea' ? 'gate-area' as const : field }));
    const ok = all.filter((x) => x.h);
    const pick = ok.find((x) => x.h!.mostly) ?? [...ok].sort((x, y) => y.h!.used / y.h!.f.sample - x.h!.used / x.h!.f.sample)[0];
    if (!pick) return null;
    const { f, used } = pick.h!;
    if (used < f.sample) notes.push(`${f.sample - used} of ${f.sample} earlier flight-days had a ${pick.field === 'gateArea' ? 'gate area' : pick.field} not found on the map.`);
    return { ...pick.h!, basis: pick.basis, field: pick.field };
  };
  const fieldName = (f: string) => (f === 'gateArea' ? 'gate area' : f);

  // Owner decision 2026-11-02 (DA-1): the prediction is the history of the last 30 days (HISTORY_DAYS); a value published
  // for the flight-day itself is NOT weighted above it. It is only mentioned, and used alone when no history exists.
  const sd = a?.sameDay;
  const g = sd && !IGNORED.has(sd.status) && sd.gate ? areasForGate(m, eligible, sd.gate, zone, q.date) : null;
  const t = sd && !IGNORED.has(sd.status) && !g?.areas.length && sd.terminal ? areasForTerminal(m, eligible, sd.terminal, q.direction) : [];
  const pub: Entry | null = g?.areas.length ? { value: sd!.gate!, share: 1, areas: g.areas, conflict: g.conflict } : t.length ? { value: sd!.terminal!, share: 1, areas: t } : null;
  const what = g?.areas.length ? `Gate ${sd!.gate}` : `Terminal ${sd?.terminal}`;
  if (sd && IGNORED.has(sd.status)) notes.push(`The value published for this flight-day is ignored: the flight is ${sd.status}.`);
  // 1–3. Historical distributions, most specific first.
  const h = history();
  if (h) {
    // the window the server actually applied (servers before 2026-11-02 do not report it and use 120 days)
    const win = a?.basis?.windowDays ? `in the last ${a.basis.windowDays} days` : 'earlier';
    if (pub) notes.push(`${what} is published for this flight-day (status ${sd!.status}); the prediction still uses the flight-days ${win}.`);
    return done(h.basis, 'predicted', h.entries, h.unassigned, h.f.sample, `Predicted from ${h.f.sample} flight-days ${win} (${fieldName(h.field)})`);
  }
  // 4. No usable history: the value published for this flight-day, if any.
  if (pub) {
    if (!FINAL.has(sd!.status)) notes.push(`${what} was published for this flight (status ${sd!.status}); it may still change.`);
    return done(g?.areas.length ? 'published-gate' : 'terminal', 'observed', [pub], 0, null, `${what} published for this flight (no earlier history)`);
  }
  // 4b. No history and nothing published: the airport's published airline → terminal allocation (LHR terminal finder),
  // as an ESTIMATE (typical for the airline; no percentage). Skipped for codeshares (the operating carrier may differ).
  const at = m.airlineTerminals, airline = q.flight?.airline?.toUpperCase();
  if (at && airline && !q.flight?.operatedByOther) {
    const other = q.other?.toUpperCase();
    const byDest = at.byDestination?.find((x) => x.airline === airline && !!other && x.airports.includes(other));
    const term = byDest?.terminal ?? at.defaults[airline];
    const areas = term ? areasForTerminal(m, eligible, term, q.direction) : [];
    if (areas.length) {
      notes.push(`No flight history yet: Terminal ${term} is the terminal ${m.name} publishes for ${airline}${byDest ? ` flights to and from ${other}` : ''} (terminal finder, ${at.asOf}). Typical for the airline, not a prediction for this flight.`);
      const r = done('airline-terminal', 'estimated', [{ value: term!, share: 1, areas }], 0, null, `Terminal ${term}: typical for ${airline} (published allocation)`);
      return r;
    }
  }
  // 5. No usable evidence: every plausible area of the zone, equally weighted (unknown).
  if (a) for (const [k, f] of [['terminal', a.terminal], ['gate', a.gate]] as const) if (f.status === 'not-published') notes.push(`The data source does not publish ${k}s for this airport and direction.`);
  if (!a) notes.push('No historical data was available for this flight.');
  else if (a.status !== 'ok') notes.push(a.status === 'no-data' ? 'This flight number has not been observed here yet.' : 'Too few earlier flight-days for a prediction.');
  const n = eligible.length;
  const r = done('zone-only', 'unknown', eligible.map((x) => ({ value: '', share: 1 / n, areas: [x] })), 0, null, zone ? `Unknown (any ${zone} area)` : 'Unknown (any area)');
  return { ...r, groups: [], areaLevel: false };
}

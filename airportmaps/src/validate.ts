// Structural and evidence checks for an AirportModel (shared by all airports). Errors block; warnings are reported.
import { BORDER_PAIRS } from './types.ts';
import type { AirportModel, Confidence, Control, EvidenceFile, Minutes, StatusPeriod, TimeWindow } from './types.ts';

const CONF: Confidence[] = ['verified', 'probable', 'inferred', 'unknown'];

export interface ValidationResult { errors: string[]; warnings: string[] }

export function validateAirport(m: AirportModel, ev?: EvidenceFile): ValidationResult {
  const errors: string[] = [], warnings: string[] = [];
  const err = (s: string) => errors.push(s), warn = (s: string) => warnings.push(s);

  const ids = new Map<string, string>();
  const reg = (id: string, what: string) => { if (!id) err(`${what}: missing id`); else if (ids.has(id)) err(`duplicate id ${id} (${what} and ${ids.get(id)})`); else ids.set(id, what); };
  m.sources.forEach((s) => reg(s.id, 'source'));
  m.areas.forEach((a) => reg(a.id, 'area'));
  m.gateGroups.forEach((g) => reg(g.id, 'gateGroup'));
  m.stops.forEach((s) => reg(s.id, 'stop'));
  m.lines.forEach((l) => reg(l.id, 'line'));
  m.walks.forEach((w) => reg(w.id, 'walk'));
  m.rules.forEach((r) => reg(r.id, 'rule'));
  m.openQuestions.forEach((q) => reg(q.id, 'openQuestion'));

  const src = new Set(m.sources.map((s) => s.id));
  const area = new Map(m.areas.map((a) => [a.id, a]));
  const stop = new Map(m.stops.map((s) => [s.id, s]));
  const W = m.schematic.width, H = m.schematic.height;
  const inPlane = (p: [number, number], what: string) => { if (!Array.isArray(p) || p.length !== 2 || p.some((v) => typeof v !== 'number' || !isFinite(v))) err(`${what}: bad point ${JSON.stringify(p)}`); else if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) warn(`${what}: point ${p} outside the ${W}×${H} plane`); };
  const minutes = (x: Minutes | undefined, what: string) => {
    if (!x) return err(`${what}: minutes missing`);
    if (!(x.min >= 0 && x.min <= x.typical && x.typical <= x.max)) err(`${what}: minutes must satisfy 0 ≤ min ≤ typical ≤ max (${x.min}/${x.typical}/${x.max})`);
    if (!['published', 'measured', 'derived', 'observed', 'assumed'].includes(x.basis)) err(`${what}: bad minutes basis ${x.basis}`);
  };
  const sourced = (o: { confidence: Confidence; sources: string[] }, what: string) => {
    if (!CONF.includes(o.confidence)) err(`${what}: bad confidence ${o.confidence}`);
    if (!Array.isArray(o.sources)) return err(`${what}: sources missing`);
    for (const s of o.sources) if (!src.has(s)) err(`${what}: unknown source ${s}`);
    if (o.confidence !== 'unknown' && o.confidence !== 'inferred' && o.sources.length === 0) err(`${what}: ${o.confidence} without any source`);
    if (o.confidence === 'verified') {
      const groups = new Set(o.sources.map((s) => m.sources.find((x) => x.id === s)?.group));
      if (groups.size < 2) err(`${what}: 'verified' needs ≥ 2 independent source groups (has ${[...groups].join(', ') || 'none'})`);
    }
  };

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const HHMM = /^([01]\d|2[0-4]):[0-5]\d$/;
  const windows = (ws: TimeWindow[] | undefined, what: string) => {
    if (ws === undefined) return;
    if (!Array.isArray(ws) || !ws.length) return err(`${what}: hours/windows must be a non-empty array of {from, until}`);
    ws.forEach((w, i) => { if (!HHMM.test(w.from) || !HHMM.test(w.until)) err(`${what}[${i}]: times must be HH:MM (${w.from}–${w.until})`); });
  };
  const noDupControls = (cs: Control[] | undefined, what: string) => {
    const kinds = (cs ?? []).map((c) => c.kind);
    const dup = kinds.find((k, i) => kinds.indexOf(k) !== i);
    if (dup) err(`${what}: control ${dup} listed twice on one connection (double counting)`);
    if (kinds.includes('security') && kinds.includes('transfer-security')) err(`${what}: both security and transfer-security on one connection (double counting)`);
  };
  const status = (ps: StatusPeriod[] | undefined, what: string) => {
    if (ps === undefined) return;
    if (!Array.isArray(ps)) return err(`${what}: status must be an array of periods`);
    ps.forEach((p, i) => {
      const w = `${what} status[${i}]`;
      if (!['active', 'suspended', 'closed', 'planned'].includes(p.state)) err(`${w}: bad state ${p.state}`);
      for (const d of [p.from, p.until]) if (d !== undefined && !ISO.test(d)) err(`${w}: dates must be YYYY-MM-DD (${d})`);
      if (p.from && p.until && p.from > p.until) err(`${w}: from after until`);
      if (!p.note) err(`${w}: note missing`);
      sourced(p, w);
    });
  };

  for (const s of m.sources) {
    if (!s.url || !/^https?:\/\//.test(s.url)) warn(`source ${s.id}: no http(s) url`);
    if (!s.group) err(`source ${s.id}: missing independence group`);
    if (!s.accessed) err(`source ${s.id}: missing accessed date`);
  }

  for (const a of m.areas) {
    sourced(a, `area ${a.id}`);
    inPlane(a.anchor, `area ${a.id} anchor`);
    if (a.shape?.type === 'poly') a.shape.points.forEach((p, i) => inPlane(p, `area ${a.id} shape[${i}]`));
    if (a.side === 'landside' && a.zone !== 'n/a') err(`area ${a.id}: landside areas use zone 'n/a'`);
    if (a.side === 'airside' && a.zone === 'n/a') err(`area ${a.id}: airside areas need a zone`);
  }

  const gateSeen = new Map<string, string>();
  for (const g of m.gateGroups) {
    sourced(g, `gateGroup ${g.id}`);
    if (!area.has(g.area)) err(`gateGroup ${g.id}: unknown area ${g.area}`);
    if (!g.gates.length) err(`gateGroup ${g.id}: no gates`);
    if (!g.path?.length) err(`gateGroup ${g.id}: no placement path`);
    g.path?.forEach((p, i) => inPlane(p, `gateGroup ${g.id} path[${i}]`));
    for (const gate of g.gates) { if (gateSeen.has(gate)) err(`gate ${gate} listed in ${gateSeen.get(gate)} and ${g.id}`); gateSeen.set(gate, g.id); }
  }

  for (const s of m.stops) {
    sourced(s, `stop ${s.id}`);
    if (!area.has(s.area)) err(`stop ${s.id}: unknown area ${s.area}`);
    else if (area.get(s.area)!.side !== s.side && !(s.accessControls?.length)) warn(`stop ${s.id}: side ${s.side} differs from its area ${s.area} (${area.get(s.area)!.side}) without accessControls`);
    inPlane(s.anchor, `stop ${s.id} anchor`);
    minutes(s.accessMinutes, `stop ${s.id} accessMinutes`);
    s.accessControls?.forEach((c, i) => minutes(c.minutes, `stop ${s.id} accessControls[${i}]`));
    s.egressControls?.forEach((c, i) => minutes(c.minutes, `stop ${s.id} egressControls[${i}]`));
    noDupControls(s.accessControls, `stop ${s.id} accessControls`); noDupControls(s.egressControls, `stop ${s.id} egressControls`);
    windows(s.hours, `stop ${s.id} hours`);
    const ar = area.get(s.area);
    if (ar && s.side === 'airside' && ar.side === 'landside' && !(s.accessControls ?? []).some((c) => c.kind === 'security' || c.kind === 'transfer-security')) err(`stop ${s.id}: airside platform reached from landside area ${ar.id} without a security control`);
  }

  for (const l of m.lines) {
    sourced(l, `line ${l.id}`);
    if (l.stops.length < 2) err(`line ${l.id}: needs ≥ 2 stops`);
    for (const s of l.stops) if (!stop.has(s)) err(`line ${l.id}: unknown stop ${s}`);
    const need = l.direction === 'loop' ? l.stops.length : l.stops.length - 1;
    if (l.rideMin.length !== need) err(`line ${l.id}: rideMin has ${l.rideMin.length} values, ${l.direction} with ${l.stops.length} stops needs ${need}`);
    if (l.rideMin.some((x) => !(x > 0))) err(`line ${l.id}: rideMin values must be > 0`);
    if (l.ride !== undefined) {
      if (l.ride.length !== l.rideMin.length) err(`line ${l.id}: ride has ${l.ride.length} values, rideMin ${l.rideMin.length}`);
      l.ride.forEach((r, i) => { minutes(r, `line ${l.id} ride[${i}]`); if (Math.abs(r.typical - l.rideMin[i]) > 1e-9) err(`line ${l.id}: ride[${i}].typical ${r.typical} ≠ rideMin[${i}] ${l.rideMin[i]}`); });
    } else if (!l.rideBasis) warn(`line ${l.id}: ride times have no basis (set ride[] ranges or rideBasis)`);
    if (l.rideBasis && !['published', 'measured', 'derived', 'observed', 'assumed'].includes(l.rideBasis)) err(`line ${l.id}: bad rideBasis ${l.rideBasis}`);
    if (l.notRouted !== undefined && !l.notRouted.trim()) err(`line ${l.id}: notRouted needs a reason`);
    if (l.replaces !== undefined && !m.lines.some((x) => x.id === l.replaces && x.id !== l.id)) err(`line ${l.id}: replaces unknown line ${l.replaces}`);
    if (!l.service?.length) err(`line ${l.id}: no service entry`);
    l.service?.forEach((sv, i) => {
      minutes(sv.waitMin, `line ${l.id} service[${i}].waitMin`);
      if (!(sv.headwayMin.min > 0 && sv.headwayMin.min <= sv.headwayMin.max)) err(`line ${l.id} service[${i}]: bad headway`);
      if (!sv.hours) err(`line ${l.id} service[${i}]: hours missing`);
      windows(sv.windows, `line ${l.id} service[${i}].windows`);
      for (const d of [sv.validFrom, sv.validUntil]) if (d !== undefined && !ISO.test(d)) err(`line ${l.id} service[${i}]: dates must be YYYY-MM-DD (${d})`);
      if (sv.validFrom && sv.validUntil && sv.validFrom > sv.validUntil) err(`line ${l.id} service[${i}]: validFrom after validUntil`);
      if (sv.days?.some((d) => !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(d))) err(`line ${l.id} service[${i}]: bad weekday in days`);
      if (sv.headwayBasis && !['published', 'measured', 'derived', 'observed', 'assumed'].includes(sv.headwayBasis)) err(`line ${l.id} service[${i}]: bad headwayBasis`);
      for (const s of sv.sources ?? []) if (!src.has(s)) err(`line ${l.id} service[${i}]: unknown source ${s}`);
    });
    if (!/^#[0-9a-f]{6}$/i.test(l.colour)) err(`line ${l.id}: colour must be #rrggbb`);
    if (!l.eligibility) err(`line ${l.id}: eligibility missing`);
    l.path?.forEach((p, i) => inPlane(p, `line ${l.id} path[${i}]`));
  }

  for (const w of m.walks) {
    sourced(w, `walk ${w.id}`);
    if (!area.has(w.from)) err(`walk ${w.id}: unknown from ${w.from}`);
    if (!area.has(w.to)) err(`walk ${w.id}: unknown to ${w.to}`);
    if (w.from === w.to) err(`walk ${w.id}: from = to`);
    minutes(w.minutes, `walk ${w.id}`);
    [...(w.controls ?? []), ...(w.reverseControls ?? [])].forEach((c, i) => minutes(c.minutes, `walk ${w.id} control[${i}]`));
    noDupControls(w.controls, `walk ${w.id} controls`); noDupControls(w.reverseControls, `walk ${w.id} reverseControls`);
    windows(w.hours, `walk ${w.id} hours`);
    const a = area.get(w.from), b = area.get(w.to);
    if (a && b && w.access !== 'restricted') {
      const hasSec = (cs?: Control[]) => (cs ?? []).some((c) => c.kind === 'security' || c.kind === 'transfer-security');
      const hasPass = (cs?: Control[]) => (cs ?? []).some((c) => c.kind === 'passport');
      const dirs: [typeof a, typeof b, Control[] | undefined][] = [[a, b, w.controls]];
      if (w.bidirectional) dirs.push([b, a, w.reverseControls ?? w.controls]);
      for (const [x, y, cs0] of dirs) {
        const cs = [...(cs0 ?? []), ...(y.entryControls ?? [])];
        if (x.side === 'landside' && y.side === 'airside' && !hasSec(cs)) err(`walk ${w.id}: ${x.id} (landside) → ${y.id} (airside) without a security control`);
        const z = [x.zone, y.zone];
        const open = (m.openBorders ?? []).some((o) => o.from === x.zone && o.to === y.zone);
        for (const [p, q] of BORDER_PAIRS) if (z.includes(p) && z.includes(q) && !hasPass(cs) && !open) err(`walk ${w.id}: ${x.id} → ${y.id} crosses ${p} ↔ ${q} without a passport control`);
      }
    }
    if (w.flow !== undefined && w.flow !== 'arrivals') err(`walk ${w.id}: bad flow ${w.flow}`);
    if (w.flow === 'arrivals' && w.bidirectional) err(`walk ${w.id}: an arrivals-flow walk must be one-way (bidirectional: false)`);
    status(w.status, `walk ${w.id}`);
  }

  // stacked footprints
  const stacks = new Map<string, number[]>();
  for (const a of m.areas) if (a.stack) {
    if (!a.stack.group || typeof a.stack.order !== 'number' || !a.stack.label) err(`area ${a.id}: incomplete stack`);
    stacks.set(a.stack.group, [...(stacks.get(a.stack.group) ?? []), a.stack.order]);
  }
  for (const [g, orders] of stacks) {
    if (orders.length < 2) warn(`stack ${g}: only one member`);
    if (new Set(orders).size !== orders.length) err(`stack ${g}: duplicate order values`);
  }
  for (const a of m.areas) status(a.status, `area ${a.id}`);
  for (const a of m.areas) {
    if (a.arrivals !== undefined && a.arrivals !== 'segregated') err(`area ${a.id}: bad arrivals value ${a.arrivals}`);
    if (a.arrivals === 'segregated' && !m.walks.some((w) => w.from === a.id && w.flow === 'arrivals' && w.access !== 'restricted'))
      err(`area ${a.id}: arrivals 'segregated' but no arrivals-flow walk leaves it`);
  }
  // remediation schema v1 (docs/remediation/CONTRACT.md)
  const ZONES = ['schengen', 'non-schengen', 'domestic', 'international', 'mixed', 'n/a'];
  const allControls: [Control[] | undefined, string][] = [
    ...m.walks.flatMap((w) => [[w.controls, `walk ${w.id} controls`], [w.reverseControls, `walk ${w.id} reverseControls`]] as [Control[] | undefined, string][]),
    ...m.stops.flatMap((s) => [[s.accessControls, `stop ${s.id} accessControls`], [s.egressControls, `stop ${s.id} egressControls`]] as [Control[] | undefined, string][]),
    ...m.areas.map((a) => [a.entryControls, `area ${a.id} entryControls`] as [Control[] | undefined, string]),
    ...m.areas.map((a) => [a.intraControls, `area ${a.id} intraControls`] as [Control[] | undefined, string]),
  ];
  for (const [cs, what] of allControls) for (const c of cs ?? []) {
    if (c.when !== undefined && c.when !== 'origin-not-one-stop') err(`${what}: bad control condition ${c.when}`);
    if (c.when === 'origin-not-one-stop' && !m.oneStopSecurity) warn(`${what}: conditional control but the model has no oneStopSecurity list (it always applies)`);
  }
  for (const a of m.areas) {
    a.entryControls?.forEach((c, i) => { minutes(c.minutes, `area ${a.id} entryControls[${i}]`); for (const x of c.exceptFrom ?? []) if (!area.has(x) && !stop.has(x)) err(`area ${a.id} entryControls[${i}]: unknown exceptFrom ${x}`); });
    noDupControls(a.entryControls, `area ${a.id} entryControls`);
    a.intraControls?.forEach((c, i) => minutes(c.minutes, `area ${a.id} intraControls[${i}]`)); noDupControls(a.intraControls, `area ${a.id} intraControls`);
    if (a.intraWalk) { minutes(a.intraWalk, `area ${a.id} intraWalk`); if (!(a.intraWalk.typical > 0)) err(`area ${a.id}: intraWalk must be > 0 (a same-area connection is never 0 min)`); for (const s of a.intraWalk.sources ?? []) if (!src.has(s)) err(`area ${a.id} intraWalk: unknown source ${s}`); }
    if (a.checkIn) {
      if (a.side !== 'landside') err(`area ${a.id}: checkIn on an airside area`);
      if (a.kind === 'transfer-hub' || a.kind === 'station') err(`area ${a.id}: checkIn on a ${a.kind}`);
      for (const x of a.checkIn.serves ?? []) if (area.get(x)?.side !== 'airside') err(`area ${a.id} checkIn: serves ${x}, not an airside area`);
      for (const s of a.checkIn.sources ?? []) if (!src.has(s)) err(`area ${a.id} checkIn: unknown source ${s}`);
    }
    a.zones?.forEach((z, i) => {
      if (!ZONES.includes(z.zone)) err(`area ${a.id} zones[${i}]: bad zone ${z.zone}`);
      for (const d of [z.validFrom, z.validUntil]) if (d !== undefined && !ISO.test(d)) err(`area ${a.id} zones[${i}]: dates must be YYYY-MM-DD`);
      if (z.validFrom && z.validUntil && z.validFrom > z.validUntil) err(`area ${a.id} zones[${i}]: validFrom after validUntil`);
    });
  }
  for (const g of m.gateGroups) {
    if (g.offset) minutes(g.offset, `gateGroup ${g.id} offset`);
    for (const zg of g.zoneGates ?? []) { if (!ZONES.includes(zg.zone)) err(`gateGroup ${g.id} zoneGates: bad zone ${zg.zone}`); for (const x of zg.gates) if (!g.gates.includes(x)) err(`gateGroup ${g.id} zoneGates: ${x} is not a gate of the group`); }
  }
  if (m.oneStopSecurity) {
    const o = m.oneStopSecurity;
    if (!Array.isArray(o.countries) || o.countries.some((c) => !/^[A-Z]{2}$/.test(c))) err('oneStopSecurity: countries must be ISO-2 codes');
    for (const x of [...(o.airports ?? []), ...(o.excludedAirports ?? [])]) if (!/^[A-Z]{3}$/.test(x)) err(`oneStopSecurity: bad IATA code ${x}`);
    if (!o.asOf || !ISO.test(o.asOf)) err('oneStopSecurity: asOf must be YYYY-MM-DD');
    if (!o.sources?.length) err('oneStopSecurity: sources missing');
    for (const s of o.sources ?? []) if (!src.has(s)) err(`oneStopSecurity: unknown source ${s}`);
  }
  for (const s of m.specialScreening ?? []) {
    if (!s.id || !s.text) err('specialScreening: id and text required');
    if (!['verified', 'probable', 'unknown'].includes(s.certainty)) err(`specialScreening ${s.id}: bad certainty`);
    if (s.minutes) minutes(s.minutes, `specialScreening ${s.id}`);
    if (s.deadline && !(s.deadline.minutesBeforeDeparture > 0 && s.deadline.text)) err(`specialScreening ${s.id}: deadline needs minutesBeforeDeparture > 0 and a text`);
    if (s.issueLevel !== undefined && !['material', 'secondary'].includes(s.issueLevel)) err(`specialScreening ${s.id}: bad issueLevel`);
    for (const x of s.areas ?? []) if (area.get(x)?.side !== 'airside') err(`specialScreening ${s.id}: area ${x} is not an airside area`);
    if (!s.sources?.length) err(`specialScreening ${s.id}: sources missing`);
    for (const x of s.sources ?? []) if (!src.has(x)) err(`specialScreening ${s.id}: unknown source ${x}`);
  }
  for (const [i, o] of (m.openBorders ?? []).entries()) {
    if (!ZONES.includes(o.from) || !ZONES.includes(o.to) || o.from === o.to) err(`openBorders[${i}]: bad zones ${o.from} → ${o.to}`);
    if (!BORDER_PAIRS.some(([p, q]) => (p === o.from && q === o.to) || (p === o.to && q === o.from))) err(`openBorders[${i}]: ${o.from} → ${o.to} is not a border pair`);
    if ((m.openBorders ?? []).some((x) => x.from === o.to && x.to === o.from)) err(`openBorders[${i}]: both directions open (then it is no border)`);
    if (!o.note) err(`openBorders[${i}]: note missing`);
    if (!o.sources?.length) err(`openBorders[${i}]: sources missing`);
    for (const s of o.sources ?? []) if (!src.has(s)) err(`openBorders[${i}]: unknown source ${s}`);
  }
  for (const dir of ['arrival', 'departure'] as const) for (const [k, ids] of Object.entries(m.feedTerminals?.[dir] ?? {})) for (const x of ids) if (area.get(x)?.side !== 'airside') err(`feedTerminals.${dir}["${k}"]: ${x} is not an airside area`);
  if (m.airlineTerminals) {
    const at = m.airlineTerminals, known = new Set([...Object.keys(m.feedTerminals?.arrival ?? {}), ...Object.keys(m.feedTerminals?.departure ?? {})]);
    if (!at.sources?.length) err('airlineTerminals: sources missing');
    for (const s of at.sources ?? []) if (!src.has(s)) err(`airlineTerminals: unknown source ${s}`);
    for (const [al, t] of Object.entries(at.defaults)) if (!known.has(t)) err(`airlineTerminals.defaults.${al}: terminal "${t}" is not a feedTerminals key`);
    for (const [i, b] of (at.byDestination ?? []).entries()) { if (!known.has(b.terminal)) err(`airlineTerminals.byDestination[${i}]: terminal "${b.terminal}" is not a feedTerminals key`); if (!b.airports.length) err(`airlineTerminals.byDestination[${i}]: no airports`); }
  }
  if (m.tz !== undefined && !/^[A-Za-z_]+\/[A-Za-z_]+/.test(m.tz)) err(`tz ${m.tz}: not an IANA zone name`);

  for (const g of m.gateGroups) status(g.status, `gateGroup ${g.id}`);
  for (const s of m.stops) status(s.status, `stop ${s.id}`);
  for (const l of m.lines) status(l.status, `line ${l.id}`);

  for (const r of m.rules) sourced(r, `rule ${r.id}`);
  for (const q of m.openQuestions) if (!q.question || !q.impact || !q.howToResolve) err(`openQuestion ${q.id}: incomplete`);

  const matrixAreas = m.areas.filter((a) => a.matrix);
  if (matrixAreas.length < 2) err('fewer than 2 matrix areas');

  if (ev) {
    if (ev.iata !== m.iata) err(`evidence iata ${ev.iata} ≠ ${m.iata}`);
    const evIds = new Set<string>();
    for (const it of ev.items) {
      if (evIds.has(it.id)) err(`evidence: duplicate id ${it.id}`); evIds.add(it.id);
      if (!src.has(it.source)) err(`evidence ${it.id}: unknown source ${it.source}`);
      for (const x of [...(it.supports ?? []), ...(it.contradicts ?? [])]) if (!ids.has(x) && !gateSeen.has(x)) warn(`evidence ${it.id}: refers to unknown model id ${x}`);
    }
    const unused = m.sources.filter((s) => !ev.items.some((i) => i.source === s.id)
      && !JSON.stringify([m.areas, m.gateGroups, m.stops, m.lines, m.walks, m.rules, m.oneStopSecurity, m.specialScreening]).includes(`"${s.id}"`));
    for (const s of unused) warn(`source ${s.id} is not cited anywhere`);
  }
  return { errors, warnings };
}

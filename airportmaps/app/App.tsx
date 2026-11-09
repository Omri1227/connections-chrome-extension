// Airport maps viewer: #/ (index), #/<iata>?from=<areaId>&to=<areaId>&fg=<gate>&tg=<gate>&d=<YYYY-MM-DD>&t=<HH:MM>&p=public
import { useEffect, useMemo, useState } from 'react';
import { AIRPORTS, EVIDENCE } from './data.ts';
import SchematicMap from './SchematicMap.tsx';
import { buildMatrix, findGate, periodOn, rideSeg, routeWithAlternatives, serviceAt, stateOn, type Matrix, type Profile, type Route } from '../src/route.ts';
import type { AirportModel, Confidence, Line, LineService, Minutes, StatusPeriod, Zone } from '../src/types.ts';
import { ZONE_FILL, ZONE_STROKE } from './SchematicMap.tsx';

interface HashState { iata: string | null; from: string | null; to: string | null; pub: boolean; fg?: string | null; tg?: string | null; d?: string | null; t?: string | null }
const readHash = (): HashState => {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = h.split('?');
  const sp = new URLSearchParams(q);
  return { iata: p ? p.toLowerCase() : null, from: sp.get('from'), to: sp.get('to'), pub: sp.get('p') === 'public', fg: sp.get('fg'), tg: sp.get('tg'), d: sp.get('d'), t: sp.get('t') };
};
const writeHash = (s: HashState) => {
  const sp = new URLSearchParams();
  if (s.from) sp.set('from', s.from); if (s.to) sp.set('to', s.to); if (s.fg) sp.set('fg', s.fg); if (s.tg) sp.set('tg', s.tg); if (s.d) sp.set('d', s.d); if (s.t) sp.set('t', s.t); if (s.pub) sp.set('p', 'public');
  const q = sp.toString();
  const next = `#/${s.iata ?? ''}${q ? `?${q}` : ''}`;
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
};

const MODE_LABEL: Record<string, string> = { walk: 'Walk', train: 'Train', 'people-mover': 'People mover', bus: 'Bus', 'shuttle-bus': 'Shuttle bus', rail: 'Rail', other: 'Other' };
const MODE_ICON: Record<string, string> = { walk: '🚶', train: '🚆', 'people-mover': '🚝', bus: '🚌', 'shuttle-bus': '🚌', rail: '🚆', other: '•' };
const fmtRange = (t: { min: number; typical: number; max: number }) => `${Math.round(t.typical)} min` + (Math.round(t.min) !== Math.round(t.max) ? ` (${Math.round(t.min)}–${Math.round(t.max)})` : '');
const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const fmtRide = (r: Minutes) => (r.min === r.max ? `${fmtNum(r.typical)}′` : `${fmtNum(r.typical)}′ (${fmtNum(r.min)}–${fmtNum(r.max)})`);
const BASIS_ORDER: Minutes['basis'][] = ['published', 'measured', 'observed', 'derived', 'assumed'];
const BASIS_COLOUR: Record<Minutes['basis'], string> = { published: '#2f7d4f', measured: '#4f9d6f', observed: '#8fbf6f', derived: '#d9b44a', assumed: '#d26a4a' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const svcScope = (s: LineService) => [s.days?.length ? s.days.map((d) => DAY_LABEL[d]).join('/') : '', s.validFrom || s.validUntil ? `${s.validFrom ?? '…'} – ${s.validUntil ?? '…'}` : ''].filter(Boolean).join(', ');

function Badge({ c }: { c: Confidence }) { return <span className={`badge conf-${c}`}>{c}</span>; }

export default function App() {
  const [hs, setHs] = useState<HashState>(readHash);
  useEffect(() => { const f = () => setHs(readHash()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => { writeHash(hs); }, [hs]);
  const m = hs.iata ? AIRPORTS[hs.iata] : undefined;
  useEffect(() => { document.title = m ? `${m.iata} — schematic transfer map` : 'Airport maps'; }, [m]);
  if (!m) return <Index />;
  return <AirportView key={m.iata} m={m} hs={hs} setHs={setHs} />;
}

function Index() {
  const list = Object.entries(AIRPORTS).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="index">
      <h1>Airport maps <small>schematic transfer guides · research build</small></h1>
      <p>Original schematic maps with gate groups, walking links, inter-terminal transport and an area-to-area transfer matrix. Every fact carries sources and a confidence grade.</p>
      <ul>
        {list.map(([k, a]) => (
          <li key={k}><a href={`#/${k}`}><b>{a.iata}</b> {a.name}</a> <span className="muted">— {a.areas.length} areas, {a.gateGroups.reduce((n, g) => n + g.gates.length, 0)} gates, {a.lines.length} transport lines · as of {a.asOf}</span></li>
        ))}
        {!list.length && <li>No airport data yet.</li>}
      </ul>
    </div>
  );
}

type Tab = 'route' | 'matrix' | 'lines' | 'gates' | 'gaps' | 'sources';

function AirportView({ m, hs, setHs }: { m: AirportModel; hs: HashState; setHs: (s: HashState) => void }) {
  const [tab, setTab] = useState<Tab>('route');
  const [showWalks, setShowWalks] = useState(true);
  const [showGates, setShowGates] = useState(true);
  const [alt, setAlt] = useState(0);
  const date = hs.d && /^\d{4}-\d{2}-\d{2}$/.test(hs.d) ? hs.d : m.asOf;
  const time = hs.t && HHMM.test(hs.t) ? hs.t : undefined;
  const profile: Profile = { transfer: !hs.pub, date, time };
  const from = hs.from && m.areas.some((a) => a.id === hs.from) ? hs.from : null;
  const to = hs.to && m.areas.some((a) => a.id === hs.to) ? hs.to : null;
  // a gate is kept only while it belongs to the selected area
  const fGate = hs.fg ? findGate(m, hs.fg) : null, tGate = hs.tg ? findGate(m, hs.tg) : null;
  const fromGate = fGate && fGate.area.id === from ? fGate.gate : null;
  const toGate = tGate && tGate.area.id === to ? tGate.gate : null;
  const sameSeg = !!from && from === to && m.areas.find((a) => a.id === from)?.arrivals === 'segregated';
  const cell = useMemo(() => (from && to && (from !== to || sameSeg) ? routeWithAlternatives(m, from, to, profile) : null), [m, from, to, sameSeg, hs.pub, date, time]);
  useEffect(() => setAlt(0), [from, to, hs.pub, date, time]);
  const options = cell?.route ? [{ label: 'Recommended', route: cell.route }, ...cell.alternatives] : [];
  const route: Route | null = options[alt]?.route ?? null;
  const matrix = useMemo(() => buildMatrix(m, profile), [m, hs.pub, date, time]);
  const allGates = useMemo(() => m.gateGroups.flatMap((g) => g.gates), [m]);
  const zones = [...new Set(m.areas.map((a) => a.zone))] as Zone[];
  const setGate = (which: 'from' | 'to', v: string) => {
    const hit = findGate(m, v);
    if (which === 'from') setHs({ ...hs, fg: v || null, from: hit ? hit.area.id : hs.from });
    else setHs({ ...hs, tg: v || null, to: hit ? hit.area.id : hs.to });
  };
  const areaName = (id: string) => m.areas.find((a) => a.id === id)?.name ?? m.stops.find((s) => s.id === id)?.name ?? id;

  const pick = (id: string) => {
    if (!from || (from && to)) setHs({ ...hs, from: id, to: null, fg: null, tg: null });
    else if (id === from) setHs({ ...hs, from: null, to: null, fg: null, tg: null });
    else setHs({ ...hs, to: id, tg: null });
    setTab('route');
  };
  const areasSorted = [...m.areas].sort((a, b) => Number(b.matrix) - Number(a.matrix) || a.name.localeCompare(b.name));

  return (
    <div className="layout">
      <header className="top">
        <a href="#/" className="home">Airport maps</a>
        <h1>{m.name} <span className="iata">{m.iata}</span></h1>
        <span className="muted">research snapshot {m.asOf} · schematic · not for operational use</span>
        <nav className="switch">{Object.keys(AIRPORTS).sort().map((k) => <a key={k} href={`#/${k}`} className={k === m.iata.toLowerCase() ? 'cur' : ''}>{k.toUpperCase()}</a>)}</nav>
      </header>
      <main className="body">
        <section className="mapcol">
          <div className="mapbar">
            <div className="pickrow">
              <span className="pk from">From</span>
              <input className="gatein" aria-label="Arrival gate" placeholder="arrival gate" list="gatelist" value={hs.fg ?? ''} onChange={(e) => setGate('from', e.target.value)} />
              <select aria-label="From" value={from ?? ''} onChange={(e) => setHs({ ...hs, from: e.target.value || null, fg: null })}>
                <option value="">area…</option>{areasSorted.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button className="swap" title="Swap" onClick={() => setHs({ ...hs, from: to, to: from, fg: hs.tg, tg: hs.fg })}>⇄</button>
            </div>
            <div className="pickrow">
              <span className="pk to">To</span>
              <input className="gatein" aria-label="Departure gate" placeholder="departure gate" list="gatelist" value={hs.tg ?? ''} onChange={(e) => setGate('to', e.target.value)} />
              <select aria-label="To" value={to ?? ''} onChange={(e) => setHs({ ...hs, to: e.target.value || null, tg: null })}>
                <option value="">area…</option>{areasSorted.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <datalist id="gatelist">{allGates.map((g) => <option key={g} value={g} />)}</datalist>
            {(hs.fg && !fGate) || (hs.tg && !tGate) ? <span className="warn sm">Gate {hs.fg && !fGate ? hs.fg : hs.tg} is not in the mapped gate list.</span> : null}
            <label><input type="checkbox" checked={!hs.pub} onChange={(e) => setHs({ ...hs, pub: !e.target.checked })} /> connecting passenger</label>
            <label className="datein">date <input type="date" aria-label="Date" value={date} onChange={(e) => setHs({ ...hs, d: e.target.value && e.target.value !== m.asOf ? e.target.value : null })} /></label>
            <label className="timein" title="Time of day: lines outside their published hours are not used. Empty = typical daytime service.">time <input type="time" aria-label="Time" value={time ?? ''} onChange={(e) => setHs({ ...hs, t: e.target.value || null })} /></label>
          </div>
          <div className="mapwrap">
            <SchematicMap model={m} from={from} to={to} fromGate={fromGate} toGate={toGate} route={route} showWalks={showWalks} showGates={showGates} date={date} time={time} onPick={pick} />
          </div>
          <div className="legend">
            {zones.map((z) => <span key={z}><i className="sw" style={{ background: ZONE_FILL[z], borderColor: ZONE_STROKE[z] }} /> {ZONE_LABEL[z]}</span>)}
            <span><i className="lw" /> walking link</span>
            {m.walks.some((w) => w.flow === 'arrivals') && <span><i className="lw arr" /> arrivals flow only</span>}
            {m.areas.some((a) => a.stack) && <span><i className="sw stk" /> stacked levels (offset)</span>}
            {[...m.areas, ...m.lines].some((x) => x.status?.length) && <span><i className="sw off" /> closed / suspended on the date</span>}
            <span><i className="lw rs" /> not usable by passengers</span>
            {m.lines.map((l) => <span key={l.id}><i className="ln" style={{ background: l.colour }} /> {l.name}</span>)}
            <span><b className="ctl">S</b>/<b className="ctl">P</b> security / passport</span>
            <label><input type="checkbox" checked={showWalks} onChange={(e) => setShowWalks(e.target.checked)} /> walks</label>
            <span className="fine">Schematic, not to scale; straight walking lines are not corridors.</span>
            <label><input type="checkbox" checked={showGates} onChange={(e) => setShowGates(e.target.checked)} /> gates</label>
          </div>
        </section>
        <aside className="panel">
          <div className="tabs">
            {(['route', 'matrix', 'lines', 'gates', 'gaps', 'sources'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'cur' : ''} onClick={() => setTab(t)}>{({ route: 'Route', matrix: 'Transfer matrix', lines: 'Transport', gates: 'Gates', gaps: 'Open questions', sources: 'Sources' })[t]}</button>)}
          </div>
          <StatusBanner m={m} date={date} time={time} />
          {tab === 'route' && <RoutePanel m={m} from={from} to={to} fromGate={fromGate} toGate={toGate} cell={cell} options={options} alt={alt} setAlt={setAlt} areaName={areaName} />}
          {tab === 'matrix' && <MatrixPanel matrix={matrix} m={m} onPick={(f, t) => { setHs({ ...hs, from: f, to: t }); setTab('route'); }} from={from} to={to} />}
          {tab === 'lines' && <LinesPanel m={m} date={date} time={time} />}
          {tab === 'gates' && <GatesPanel m={m} />}
          {tab === 'gaps' && <GapsPanel m={m} date={date} />}
          {tab === 'sources' && <SourcesPanel m={m} />}
        </aside>
      </main>
    </div>
  );
}

function RoutePanel({ m, from, to, fromGate, toGate, cell, options, alt, setAlt, areaName }: { m: AirportModel; from: string | null; to: string | null; fromGate: string | null; toGate: string | null; cell: ReturnType<typeof routeWithAlternatives> | null; options: { label: string; route: Route }[]; alt: number; setAlt: (n: number) => void; areaName: (id: string) => string }) {
  if (!from || !to) return <div className="hint"><p><b>Select two areas or gates.</b> Type an arrival and a departure gate, click a building or station on the map (first click = from, second = to), or pick from the lists above.</p><p>Or open the <b>Transfer matrix</b> tab and click a cell.</p><AreaSummary m={m} /></div>;
  if (from === to && !options.length) return <p className="hint">{fromGate && toGate ? `Gates ${fromGate} and ${toGate} are in the same area (${areaName(from)}): walk along the concourse. ` : 'Same area — choose a different destination.'}</p>;
  const r = options[alt]?.route;
  if (!r) return <div className="noroute"><h2>{areaName(from)} → {areaName(to)}</h2><p>No modelled route ({cell?.reason}).</p></div>;
  const lines = new Map(m.lines.map((l) => [l.id, l]));
  return (
    <div className="route">
      <h2>{fromGate ? <>Gate {fromGate} · </> : null}{areaName(from)} → {toGate ? <>Gate {toGate} · </> : null}{areaName(to)}</h2>
      {(fromGate || toGate) && <p className="fine">Times run between the areas' typical points; add the walk along the concourse to the gate itself (gate positions on the map are approximate).</p>}
      {options.length > 1 && <div className="alts">{options.map((o, i) => <button key={i} className={i === alt ? 'cur' : ''} onClick={() => setAlt(i)}>{o.label} · {Math.round(o.route.total.typical)} min</button>)}</div>}
      <div className="total"><span className="big">{fmtRange(r.total)}</span><span className="modes">{r.modes.map((md, i) => <span key={i} className="mode">{MODE_ICON[md]} {MODE_LABEL[md]}</span>)}</span><Badge c={r.confidence} /></div>
      <p className="split">Movement {fmtRange(r.movement)}{r.controlTime.max > 0 ? <> + controls {fmtRange(r.controlTime)} <span className="muted">(planning allowances)</span></> : null}</p>
      <BasisMix mix={r.basisMix} />
      <p className="summary">{r.summary}</p>
      {r.warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}
      <ol className="steps">
        {r.steps.map((s, i) => {
          const l = s.line ? lines.get(s.line) : undefined;
          return (
            <li key={i} className={`step k-${s.kind}`}>
              <span className="sicon" style={l ? { background: l.colour } : undefined}>{s.kind === 'ride' ? MODE_ICON[l!.mode] : s.kind === 'wait' ? '⏱' : s.kind === 'control' ? (s.control!.kind === 'passport' ? 'P' : 'S') : '🚶'}</span>
              <div className="stext">
                <div>{s.text}</div>
                <div className="smeta">{fmtRange(s.minutes)} · {s.minutes.basis}{s.practical && s.practical !== 'practical' ? ` · ${s.practical} walk` : ''} · <Badge c={s.confidence} />{s.sources.length ? <> · <SourceLinks m={m} ids={s.sources} /></> : null}</div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="fine">Times: typical (range) from the cited sources; waits = typical wait for the published headway; control allowances are planning values, see their basis. Sum of minima/maxima, not a guarantee.</p>
    </div>
  );
}

/** How much of the movement time rests on published / measured / … / assumed values. */
function BasisMix({ mix }: { mix: Route['basisMix'] }) {
  const tot = BASIS_ORDER.reduce((s, b) => s + (mix[b] ?? 0), 0);
  if (!tot) return null;
  const parts = BASIS_ORDER.filter((b) => mix[b]);
  return (
    <div className="bmixw" title="Evidence basis of the movement minutes">
      <div className="bmix">{parts.map((b) => <i key={b} style={{ width: `${(100 * mix[b]!) / tot}%`, background: BASIS_COLOUR[b] }} />)}</div>
      <div className="bmix-legend">Time basis:{parts.map((b) => <span key={b}><b style={{ background: BASIS_COLOUR[b] }} />{b} {Math.round((100 * mix[b]!) / tot)}%</span>)}</div>
    </div>
  );
}

function AreaSummary({ m }: { m: AirportModel }) {
  return (
    <table className="mini"><thead><tr><th>Area</th><th>Side / zone</th><th>Gates</th><th /></tr></thead><tbody>
      {m.areas.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.side}{a.zone !== 'n/a' ? ` · ${a.zone}` : ''}</td><td>{m.gateGroups.filter((g) => g.area === a.id).map((g) => g.label).join(', ')}</td><td><Badge c={a.confidence} /></td></tr>)}
    </tbody></table>
  );
}

function MatrixPanel({ matrix, m, onPick, from, to }: { matrix: Matrix; m: AirportModel; onPick: (f: string, t: string) => void; from: string | null; to: string | null }) {
  const cell = (f: string, t: string) => matrix.cells.find((c) => c.from === f && c.to === t)!;
  const max = Math.max(1, ...matrix.cells.map((c) => c.route?.total.typical ?? 0));
  const lineById = new Map(m.lines.map((l) => [l.id, l]));
  return (
    <div className="matrix">
      <p className="hint">Typical minutes from row to column, door-of-area to door-of-area, incl. waits and control allowances{matrix.profile.time ? `, at ${matrix.profile.time}` : ' (typical daytime service)'}. Icons: modes used. ✕ = no usable route then. Click a cell to show the route.</p>
      <div className="mxscroll">
        <table className="mx">
          <thead><tr><th className="corner">from \ to</th>{matrix.areas.map((a) => <th key={a.id} title={a.name}>{a.short}</th>)}</tr></thead>
          <tbody>
            {matrix.areas.map((a) => (
              <tr key={a.id}>
                <th title={a.name}>{a.short}</th>
                {matrix.areas.map((b) => {
                  if (a.id === b.id) return <td key={b.id} className="diag">—</td>;
                  const c = cell(a.id, b.id), r = c.route;
                  if (!r) return <td key={b.id} className="none" title={c.reason}>✕</td>;
                  const t = r.total.typical / max;
                  const bg = `hsl(${140 - 120 * t} 55% ${92 - 22 * t}%)`;
                  return (
                    <td key={b.id} className={`${from === a.id && to === b.id ? 'sel' : ''} conf-${r.confidence}`} style={{ background: bg }} onClick={() => onPick(a.id, b.id)} title={`${a.name} → ${b.name}: ${r.summary} (${r.confidence})`}>
                      <div className="mt">{Math.round(r.total.typical)}</div>
                      <div className="mi">{r.modes.filter((x) => x !== 'walk').map((x, i) => <span key={i}>{MODE_ICON[x]}</span>)}{r.controls.includes('passport') ? <b className="ctl sm">P</b> : null}{r.lines.length ? '' : ''}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">Rows/columns: {matrix.areas.map((a) => `${a.short} = ${a.name}`).join(' · ')}. Lines used anywhere: {[...new Set(matrix.cells.flatMap((c) => c.route?.lines ?? []))].map((id) => lineById.get(id)?.name).join(', ') || 'none'}.</p>
    </div>
  );
}

function LinesPanel({ m, date, time }: { m: AirportModel; date: string; time?: string }) {
  const stop = new Map(m.stops.map((s) => [s.id, s]));
  return (
    <div className="lines">
      {!m.lines.length && <p>No inter-terminal transport modelled.</p>}
      {m.lines.map((l: Line) => {
        const sv = serviceAt(l, date, time);
        const replaced = l.replaces ? m.lines.find((x) => x.id === l.replaces) : undefined;
        return (
          <div key={l.id} className="lcard">
            <h3><i className="ln" style={{ background: l.colour }} /> {l.name} <span className="muted">{MODE_LABEL[l.mode]} · {l.access}{l.operator ? ` · ${l.operator}` : ''}</span> <Badge c={l.confidence} /></h3>
            {stateOn(l.status, date) !== 'active' && <p className="warn">{stateOn(l.status, date).toUpperCase()} on {date}: {periodOn(l.status, date)!.note}. Routes do not use it.</p>}
            {stateOn(l.status, date) === 'active' && !sv && <p className="warn">Not running {time ? `at ${time} ` : ''}on {date} (outside its service hours). Routes do not use it then.</p>}
            {l.notRouted && <p className="warn">Drawn only, never routed: {l.notRouted}</p>}
            {replaced && <p><b>Replaces:</b> {replaced.name} during its suspension.</p>}
            <p><b>Who:</b> {l.eligibility}</p>
            <p><b>Route ({l.direction === 'both' ? 'both directions' : l.direction === 'loop' ? 'one-way loop' : 'one way'}):</b> {l.stops.map((s, i) => <span key={s}>{i > 0 && <span className="muted"> —{fmtRide(rideSeg(l, i - 1))}→ </span>}{stop.get(s)?.name}</span>)}{l.direction === 'loop' && <span className="muted"> —{fmtRide(rideSeg(l, l.rideMin.length - 1))}→ (back to start)</span>}</p>
            <p className="fine">Ride times: {[...new Set(l.rideMin.map((_, i) => rideSeg(l, i).basis))].join(', ')}.</p>
            {l.service.map((s, i) => <p key={i} className={sv === s ? 'svc cur' : 'svc'}><b>Service{svcScope(s) ? ` (${svcScope(s)})` : ''}:</b> {s.hours}{!s.windows?.length ? ' (hours not machine-readable / not published)' : ''}; every {s.headwayMin.min === s.headwayMin.max ? s.headwayMin.min : `${s.headwayMin.min}–${s.headwayMin.max}`} min{s.headwayBasis ? ` (${s.headwayBasis})` : ''}; typical wait {fmtRange(s.waitMin)} ({s.waitMin.basis}){s.notes ? `. ${s.notes}` : ''}{s.sources?.length ? <> · <SourceLinks m={m} ids={s.sources} /></> : null}{sv === s ? <b className="muted"> ← used {time ? `at ${time}` : 'by default'}</b> : null}</p>)}
            <p><b>Boarding points:</b></p>
            <ul>{l.stops.map((s) => { const st = stop.get(s)!; return <li key={s}>{st.name} <span className="muted">({st.side}{st.where ? `; ${st.where}` : ''})</span></li>; })}</ul>
            {l.status?.length ? <p><b>Status:</b> {l.status.map((p, i) => <span key={i}>{i > 0 && '; '}<StatusText p={p} /></span>)}</p> : null}
            {l.notes && <p className="muted">{l.notes}</p>}
            <p className="fine">Sources: <SourceLinks m={m} ids={l.sources} /></p>
          </div>
        );
      })}
    </div>
  );
}

function GatesPanel({ m }: { m: AirportModel }) {
  const total = m.gateGroups.reduce((n, g) => n + g.gates.length, 0);
  return (
    <div className="gatesp">
      <p>{total} gates in {m.gateGroups.length} groups (only gates attested by a source).</p>
      {m.areas.filter((a) => m.gateGroups.some((g) => g.area === a.id)).map((a) => (
        <div key={a.id} className="gcard">
          <h3>{a.name} <span className="muted">{a.side}{a.zone !== 'n/a' ? ` · ${a.zone}` : ''}</span></h3>
          {m.gateGroups.filter((g) => g.area === a.id).map((g) => (
            <div key={g.id} className="grow"><b>{g.label}</b>{g.bus ? ' (bus gates)' : ''}{g.zone ? ` · ${g.zone}` : ''} <Badge c={g.confidence} /><div className="glist">{g.gates.join(' ')}</div>{g.notes && <div className="muted">{g.notes}</div>}<div className="fine"><SourceLinks m={m} ids={g.sources} /></div></div>
          ))}
        </div>
      ))}
    </div>
  );
}

function GapsPanel({ m, date }: { m: AirportModel; date: string }) {
  const changes = [...m.areas, ...m.stops, ...m.lines, ...m.walks, ...m.gateGroups].filter((x) => x.status?.length);
  return (
    <div className="gaps">
      {changes.length > 0 && <><h3>Operational changes (status on {date})</h3><ul>{changes.map((x) => <li key={x.id}><code>{x.id}</code> <b>{stateOn(x.status, date)}</b> — {x.status!.map((p, i) => <span key={i}>{i > 0 && '; '}<StatusText p={p} /> <SourceLinks m={m} ids={p.sources} /></span>)}</li>)}</ul></>}
      {m.rules.length > 0 && <><h3>Rules that affect routing</h3><ul>{m.rules.map((r) => <li key={r.id}>{r.text} <Badge c={r.confidence} /> <SourceLinks m={m} ids={r.sources} /></li>)}</ul></>}
      <h3>Open questions ({m.openQuestions.length})</h3>
      <ul>{m.openQuestions.map((q) => <li key={q.id}><b>{q.question}</b><div>Impact: {q.impact}</div><div className="muted">To resolve: {q.howToResolve}</div></li>)}</ul>
      <h3>Low-confidence items</h3>
      <ul>{[...m.areas, ...m.gateGroups, ...m.walks, ...m.lines, ...m.stops].filter((x) => x.confidence === 'inferred' || x.confidence === 'unknown').map((x) => <li key={x.id}><code>{x.id}</code> <Badge c={x.confidence} /> {x.notes}</li>)}</ul>
    </div>
  );
}

function SourcesPanel({ m }: { m: AirportModel }) {
  const ev = EVIDENCE[m.iata.toLowerCase()];
  const groups = new Set(m.sources.map((s) => s.group));
  return (
    <div className="sources">
      <p>{m.sources.length} sources in {groups.size} independence groups · {ev?.items.length ?? 0} recorded observations.</p>
      <ul>{m.sources.map((s) => (
        <li key={s.id} id={s.id}><a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a> <span className="muted">— {s.publisher} · {s.kind} · group {s.group} · read {s.accessed}{s.published ? ` · published ${s.published}` : ''}</span>{s.notes && <div className="fine">{s.notes}</div>}
          {ev && <ul className="evl">{ev.items.filter((i) => i.source === s.id).map((i) => <li key={i.id}>{i.locator ? <b>{i.locator}: </b> : null}{i.observed}</li>)}</ul>}
        </li>
      ))}</ul>
    </div>
  );
}

function SourceLinks({ m, ids }: { m: AirportModel; ids: string[] }) {
  return <>{ids.map((id, i) => { const s = m.sources.find((x) => x.id === id); return <span key={id}>{i > 0 && ', '}{s ? <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>{s.publisher}</a> : id}</span>; })}</>;
}

const ZONE_LABEL: Record<Zone, string> = { schengen: 'Schengen airside', 'non-schengen': 'Non-Schengen airside', domestic: 'Domestic airside', international: 'International airside', mixed: 'Mixed / swing', 'n/a': 'Landside (public)' };

function StatusText({ p }: { p: StatusPeriod }) {
  const span = p.from && p.until ? `${p.from} – ${p.until}` : p.from ? `from ${p.from}` : p.until ? `until ${p.until}` : 'indefinitely';
  return <>{p.state} {span}: {p.note} <Badge c={p.confidence} /></>;
}

/** Items not active on the routing date (closed terminals, suspended lines): always visible above the tabs. */
function StatusBanner({ m, date, time }: { m: AirportModel; date: string; time?: string }) {
  const off = [...m.areas, ...m.lines].filter((x) => stateOn(x.status, date) !== 'active');
  const idle = m.lines.filter((l) => stateOn(l.status, date) === 'active' && !l.notRouted && !serviceAt(l, date, time));
  if (!off.length && !idle.length) return null;
  return <>
    {off.length > 0 && <p className="warn statusbar">On {date}: {off.map((x, i) => <span key={x.id}>{i > 0 && ' · '}<b>{x.name}</b> {stateOn(x.status, date)}</span>)} — not used for routing.</p>}
    {idle.length > 0 && <p className="warn statusbar idle">{time ? `At ${time}` : 'On this day'}: {idle.map((l, i) => <span key={l.id}>{i > 0 && ' · '}<b>{l.name}</b> not running</span>)} — outside published hours.</p>}
  </>;
}

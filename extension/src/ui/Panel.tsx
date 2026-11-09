// Connection-analysis panel (shared by the in-page panel on Skyscanner and the popup). Compact, decision-first layout:
//   one-line verdict (+ what drives it) → ticket type (asked when unknown, both scenarios shown) → where you likely
//   arrive / depart → schematic map with ONE most likely route → that route (walk · transport · walk, checks, movement
//   vs time needed, material warnings) → everything else folded into "More detail".
// Every value carries a provenance badge: Observed · Predicted · Estimated · Unknown. The map is the maps layer's own
// SchematicMap component.
import { useMemo, useState } from 'react';
import SchematicMap from '../../../airportmaps/app/SchematicMap.tsx';
import type { AirportModel } from '../../../airportmaps/src/types.ts';
import type { ConnectionAnalysis } from '../core/analyze.ts';
import { ASSUMPTIONS, type Assessment, type Combo } from '../core/assess.ts';
import { BUNDLE_INFO } from '../core/bundle-info.ts';
import type { FieldAnswer, FlightAnswer } from '../core/history.ts';
import type { Resolution } from '../core/resolve.ts';
import { bestRoute, mapMarks, SHORT_VERDICT, summarisePlace, type BestRoute, type PlaceSummary } from '../core/summary.ts';
import { localToday } from '../core/time.ts';
import type { Provenance } from '../core/types.ts';

export interface AnalysisView { analysis: ConnectionAnalysis; model: AirportModel | null }

const LABEL: Record<Provenance, string> = { observed: 'Observed', predicted: 'Predicted', estimated: 'Estimated', unknown: 'Unknown' };
export const Badge = ({ k, title }: { k: Provenance; title?: string }) => <span className={`cx-badge cx-${k}`} title={title}>{LABEL[k]}</span>;
const mins = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n >= 60 ? `${Math.floor(n / 60)} h ${String(Math.round(n % 60)).padStart(2, '0')} min` : `${Math.round(n)} min`);
const pct = (p: number) => `${Math.round(p * 100)} %`;
const VERDICT_CLASS: Record<string, string> = { comfortable: 'cx-ok', tight: 'cx-warn', risky: 'cx-bad', uncertain: 'cx-bad', 'not-assessed': 'cx-muted' };

/** Area name without its parenthetical ("Pier E (non-Schengen)" → "Pier E"); the full name stays in the tooltip. */
const plain = (n: string) => n.replace(/\s*\([^)]*\)/g, '').trim() || n;

/** "Arrival: Pier D · 62 %" (or two tied options, a terminal without a known hall, or "Unknown"). */
function Place({ title, s, flight }: { title: string; s: PlaceSummary; flight: string }) {
  return (
    <div className={`cx-place cx-place-${s.role}`}>
      <span className="cx-place-k">{title}</span>
      <span className="cx-place-v">
        {s.top.length ? s.top.map((o, i) => (
          <span key={o.areaId} title={o.detail ?? o.name}>{i > 0 && <span className="cx-or"> or </span>}<strong>{plain(o.name)}</strong>{o.p !== null && <span className="cx-pct"> {pct(o.p)}</span>}{o.areaIds.length > 1 ? <span className="cx-muted"> · {o.detail}</span> : o.detail && s.provenance === 'observed' ? <span className="cx-muted"> · {o.detail}</span> : null}</span>
        )) : <strong>Unknown</strong>}
        {' '}<Badge k={s.provenance} />
      </span>
      <span className="cx-place-b cx-small cx-muted">{flight ? `${flight} · ` : ''}{s.basisText}{s.top.length > 1 ? ' · tied' : ''}{s.others.length && s.provenance !== 'unknown' ? ` · also ${s.others.slice(0, 2).map((o) => `${o.short} ${o.p !== null ? pct(o.p) : ''}`).join(', ')}` : ''}{s.otherShare >= 0.05 ? ` · other ${pct(s.otherShare)}` : ''}</span>
    </div>
  );
}

function RouteBlock({ b, scheduled, ticket }: { b: BestRoute; scheduled: number | null; ticket?: string }) {
  const s = b.segments;
  const t = s.transport;
  return (
    <section className="cx-route">
      <h4>{b.illustrative ? 'Illustrative route' : 'Most likely route'}: {plain(b.combo.arrival.area.name)} → {plain(b.combo.departure.area.name)}{ticket ? ` (${ticket})` : ''} <Badge k="estimated" /></h4>
      {b.illustrative ? <p className="cx-unsure">{b.limitedHistory !== null ? `Example only: based on just ${b.limitedHistory} earlier flight-day${b.limitedHistory === 1 ? '' : 's'}, so the areas may well differ.` : 'Example only: the exact areas are not predicted, so this is one of the possible routes.'}</p>
        : !b.sure && <p className="cx-unsure">We are not fully sure this is the correct route.</p>}
      <div className={`cx-legs ${t ? '' : 'cx-legs-3'}`}>
        <div><span className="cx-leg-k">{t ? 'Walk before' : 'Walk'}</span><span className="cx-leg-v">{mins(s.walkBefore)}</span></div>
        <div className="cx-leg-t"><span className="cx-leg-k">{t ? (t.labels.length ? t.labels.join(' + ') : 'Transport') : 'Shuttle / train'}</span><span className="cx-leg-v">{t ? mins(t.minutes) : 'none'}</span></div>
        {t && <div><span className="cx-leg-k">Walk after</span><span className="cx-leg-v">{mins(s.walkAfter)}</span></div>}
        <div className="cx-leg-total"><span className="cx-leg-k">Moving</span><span className="cx-leg-v">~{mins(s.movement.typical)}</span><span className="cx-small">up to {mins(s.movement.max)}</span></div>
      </div>
      <p className="cx-checks"><span className="cx-leg-k">Checks</span>{s.checks.length ? s.checks.map((c, i) => <span key={i} className="cx-check">{c.label}</span>) : <span className="cx-muted">none modelled</span>}</p>
      {s.needed && <p className="cx-needed"><strong>Needed ~{mins(s.needed.typical)}</strong> (up to {mins(s.needed.max)}){scheduled !== null ? <> of <strong>{mins(scheduled)}</strong> scheduled</> : null}: moving, plus {s.deadline.label.toLowerCase()} {s.deadline.minutes} min before departure. <Badge k="estimated" /></p>}
      <p className="cx-small cx-muted">Moving includes ~{s.deplane} min leaving the aircraft{s.bags !== null ? `, ~${s.bags} min for bags` : ''}{s.checksMinutes ? ` and ~${s.checksMinutes} min at checks` : ''}.</p>
      {b.material.length > 0 && <ul className="cx-issues cx-small">{b.material.map((i) => <li key={i.code} className={`cx-issue cx-${i.level}`}>⚠ {i.text}</li>)}</ul>}
    </section>
  );
}

// ---- details (folded) ----

function History({ f, label }: { f: FieldAnswer | undefined; label: string }) {
  if (!f) return null;
  if (f.status === 'predicted') return (
    <li>{label}: <strong>{f.value}</strong> in {pct(f.distribution[0].share ?? 0)} of {f.sample} earlier flight-days · confidence {f.confidence}
      {f.alternatives.length ? <> · also seen: {f.distribution.slice(1, 4).map((d) => `${d.value} ${d.share !== null ? pct(d.share) : ''}`).join(', ')}</> : null}</li>
  );
  if (f.status === 'insufficient-data') return <li>{label}: only {f.sample} earlier flight-day{f.sample === 1 ? '' : 's'} ({f.distribution.map((d) => `${d.value} ×${d.n}`).join(', ')}), too few for a prediction</li>;
  if (f.status === 'not-published') return <li>{label}: not published by the data source for this airport</li>;
  return <li>{label}: no earlier observations</li>;
}

function Side({ title, r, h, flight }: { title: string; r: Resolution | null; h: FlightAnswer | null | undefined; flight: string }) {
  if (!r) return null;
  return (
    <div className="cx-side">
      <h5>{title} <Badge k={r.provenance} /></h5>
      <p className="cx-small">{r.summary}{r.zone ? ` · ${r.zone} side` : ''}</p>
      {h && (
        <ul className="cx-small cx-hist">
          <History f={h.terminal} label="Terminal" /><History f={h.gateArea} label="Gate area" /><History f={h.gate} label="Gate" />
          {h.basis.flightDays ? <li>Based on {h.basis.flightDays} earlier flight-days of {flight}, {h.basis.period.from} → {h.basis.period.to} ({h.basis.sources.join(', ')}){h.basis.fromCounters ? `, ${h.basis.fromCounters} from monthly counters` : ''}</li> : null}
          {h.sameDay && <li>Published for this date: terminal {h.sameDay.terminal ?? '—'}, gate {h.sameDay.gate ?? '—'}, status {h.sameDay.status} (may still change)</li>}
        </ul>
      )}
      {r.notes.map((n, i) => <p key={i} className="cx-small cx-muted">{n}</p>)}
    </div>
  );
}

function Steps({ c }: { c: Combo }) {
  if (!c.route) return <p className="cx-muted">No modelled route between these areas.</p>;
  return (
    <ol className="cx-steps cx-small">
      <li>Leave the aircraft: about {c.movement ? Math.round(c.movement.typical - c.route.steps.reduce((t, s) => t + s.minutes.typical, 0)) : ASSUMPTIONS.deplane.typical} min (assumed)</li>
      {c.route.steps.map((s, i) => <li key={i}>{s.at ? <span className="cx-muted">{s.at} · </span> : null}{s.text} <span className="cx-muted">· {mins(s.minutes.typical)}{s.minutes.max > s.minutes.typical ? ` (up to ${mins(s.minutes.max)})` : ''}</span></li>)}
    </ol>
  );
}

const ticketText = (s: boolean | null, assumed: boolean) => (s === true ? 'Self-transfer (separate tickets: collect and re-check bags)' : s === false ? 'Protected (one ticket, bags checked through)' : assumed ? 'Ticket type not shown in the itinerary' : 'Ticket type unknown');

/** R-10: ask whether the connection is protected or a self-transfer; when unknown, both verdicts side by side. */
function TicketType({ a, onTicketType }: { a: ConnectionAnalysis; onTicketType?: (selfTransfer: boolean | null) => void }) {
  const s = a.observed.selfTransfer;
  const sc = a.scenarios;
  return (
    <div className="cx-ticket">
      {s === null && <p className="cx-small"><strong>Is this connection on one ticket?</strong> The page does not say.</p>}
      {onTicketType && <p className="cx-small cx-ticket-q">
        <button className={`cx-choice ${s === false ? 'on' : ''}`} onClick={() => onTicketType(false)}>One ticket (protected)</button>
        <button className={`cx-choice ${s === true ? 'on' : ''}`} onClick={() => onTicketType(true)}>Separate tickets (self-transfer)</button>
        <button className={`cx-choice ${s === null ? 'on' : ''}`} onClick={() => onTicketType(null)}>Not sure</button>
      </p>}
      {sc && <ul className="cx-scenarios cx-small">
        {([['One ticket (protected)', sc.protected], ['Separate tickets (self-transfer)', sc.selfTransfer]] as [string, Assessment][]).map(([k, x]) => (
          <li key={k} className={VERDICT_CLASS[x.verdict === 'uncertain' ? x.worst : x.verdict]}>{k}: <strong>{x.verdict === 'not-assessed' ? 'not assessed' : SHORT_VERDICT[x.verdict].replace(' on our estimates', '')}</strong>{x.drivers.length ? ` (${x.drivers[0].text})` : ''}</li>
        ))}
      </ul>}
    </div>
  );
}

export function Panel({ views, onEdit, onTicketType }: { views: AnalysisView[]; onEdit?: (v: AnalysisView) => void; onTicketType?: (v: AnalysisView, selfTransfer: boolean | null) => void }) {
  const [tab, setTab] = useState(0);
  const v = views[Math.min(tab, views.length - 1)];
  const a = v?.analysis;
  const date = a?.observed.date ?? localToday();
  const sum = useMemo(() => {
    if (!a || !a.arrival || !a.departure || a.notAssessed?.code === 'airport-change') return null;
    const arr = summarisePlace(a.arrival), dep = summarisePlace(a.departure);
    const best = v.model && !a.notAssessed ? bestRoute(v.model, a) : null;
    const marks = mapMarks(arr, dep, best);
    const steps = best?.combo.route?.steps ?? [];
    const focus = [...new Set([...marks.map((x) => x.area), ...steps.flatMap((s) => [s.from, s.to])])];
    return { arr, dep, best, marks, focus };
  }, [a, v?.model]);
  if (!v) return <p className="cx-muted">No connection to analyse.</p>;
  const h = a.history.answer;
  const as = a.assessment;
  const combos = as?.combos ?? [];
  const best = sum?.best ?? null;
  const unknownWeights = a.arrival?.provenance === 'unknown' || a.departure?.provenance === 'unknown';
  // material issues of the plausible routes not already shown with the displayed route (concise, never hidden)
  const shown = new Set(best?.material.map((i) => i.code) ?? []);
  // they describe OTHER possible routes, so say so (the displayed route may not have them)
  const otherMaterial = (as?.issues ?? []).filter((i) => i.level !== 'secondary' && !shown.has(i.code))
    .map((i) => (best ? { ...i, text: `On another possible route: ${i.text.replace(/^This route/, 'that route')}` } : i));
  const secondary = [...new Map([...(best?.secondary ?? []), ...(as?.issues ?? []).filter((i) => i.level === 'secondary')].map((i) => [i.code, i])).values()];
  return (
    <div className="cx-panel">
      {views.length > 1 && <nav className="cx-tabs">{views.map((x, i) => <button key={i} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{x.analysis.airport}</button>)}</nav>}
      <header className="cx-head">
        <h3>Connection at {a.airport}{a.airportName ? ` · ${a.airportName}` : ''}</h3>
        <p className="cx-small"><Badge k="observed" /> {a.input.inbound.flightNumber ?? '?'} {a.input.inbound.from}→{a.input.inbound.to} arr {a.input.inbound.arrTime ?? '?'}{a.input.inbound.arrDate ? ` ${a.input.inbound.arrDate}` : ''} · {a.input.outbound.flightNumber ?? '?'} {a.input.outbound.from}→{a.input.outbound.to} dep {a.input.outbound.depTime ?? '?'}{a.input.outbound.depDate ? ` ${a.input.outbound.depDate}` : ''}</p>
        <p className="cx-small">Scheduled connection <strong>{a.notAssessed && a.notAssessed.code !== 'airport-change' ? '—' : mins(a.observed.scheduledMinutes)}</strong> · {ticketText(a.observed.selfTransfer, a.observed.selfTransferAssumed)}
          {onEdit && <> · <button className="cx-link" onClick={() => onEdit(v)}>Edit details</button></>}</p>
      </header>

      {a.status === 'unsupported-airport' && <p className="cx-note">{a.unknowns[0]} The extension currently covers {a.supportedAirports.join(', ')}.</p>}
      {a.notAssessed && <p className="cx-verdict cx-muted"><strong>{a.notAssessed.text}</strong></p>}
      {a.missing.length > 0 && <p className="cx-note cx-small">Not in the itinerary: {a.missing.join(', ')}. {onEdit ? 'Use “Edit details” to add them.' : ''}</p>}
      {a.history.status === 'unavailable' && a.status !== 'unsupported-airport' && !a.notAssessed && <p className="cx-note cx-small">Historical data: {a.history.reason}</p>}

      {as && !a.notAssessed && (
        <div className={`cx-verdict ${VERDICT_CLASS[as.verdict === 'uncertain' ? as.worst : as.verdict]}`}>
          <strong>{as.verdict === 'not-assessed' ? as.verdictText : SHORT_VERDICT[as.verdict]}</strong> <Badge k="estimated" />
          {as.drivers.length > 0 && <p className="cx-small cx-drivers">{as.drivers.map((d) => d.text).join('; ')}.</p>}
        </div>
      )}
      {as && !a.notAssessed && <TicketType a={a} onTicketType={onTicketType ? (s) => onTicketType(v, s) : undefined} />}
      {(a.caveats.length > 0 || otherMaterial.length > 0) && !a.notAssessed && <ul className="cx-issues cx-small">{[...a.caveats.map((t) => ({ code: t, text: t })), ...otherMaterial].map((i) => <li key={i.code} className="cx-issue cx-material">⚠ {i.text}</li>)}</ul>}

      {sum && (
        <div className="cx-places">
          <Place title="Arrival" s={sum.arr} flight={a.input.inbound.flightNumber ?? ''} />
          <Place title="Departure" s={sum.dep} flight={a.input.outbound.flightNumber ?? ''} />
        </div>
      )}

      {best && v.model && (
        <div className="cx-map"><SchematicMap model={v.model} from={best.combo.arrival.area.id} to={best.combo.departure.area.id} route={best.combo.route} showWalks={false} showGates date={date} onPick={() => {}} marks={sum!.marks} focus={sum!.focus} /></div>
      )}
      {!best && as && !a.notAssessed && a.status !== 'unsupported-airport' && <p className="cx-muted cx-small">No usable modelled route between the likely areas{as.time ? ` at ${as.time}` : ''}.</p>}

      {best && <RouteBlock b={best} scheduled={as?.scheduledMinutes ?? null} ticket={a.scenarios ? (as?.selfTransfer ? 'if separate tickets' : 'if one ticket') : undefined} />}

      <details className="cx-more">
        <summary>More detail</summary>
        {as && !a.notAssessed && (
          <>
            <h5>Verdict <Badge k="estimated" /></h5>
            <p className="cx-small">{as.verdictText}.{as.range ? ` The transfer typically needs ${as.range.min === as.range.max ? mins(as.range.min) : `${mins(as.range.min)}–${mins(as.range.max)}`} including leaving the aircraft${as.selfTransfer ? ', bags and check-in closing' : ' and boarding closing'}, depending on the areas.` : ''} {as.notes.join(' ')}</p>
          </>
        )}
        {best && (
          <>
            <h5>{best.illustrative ? 'Illustrative' : 'Most likely'} route, step by step <Badge k="estimated" /></h5>
            <Steps c={best.combo} />
            <p className="cx-small cx-muted">Route confidence (heuristic, not a calibrated probability): about {pct(best.confidence)}; shown as “not fully sure” below 70 %. {best.confidenceWhy.join('; ')}.</p>
          </>
        )}
        {secondary.length > 0 && <><h5>Notes on the routes</h5><ul className="cx-small">{secondary.map((i) => <li key={i.code}>{i.text}</li>)}</ul></>}
        <div className="cx-sides">
          <Side title={`Arrival · ${a.input.inbound.flightNumber ?? 'first flight'}`} r={a.arrival} h={h?.arrival} flight={a.input.inbound.flightNumber ?? ''} />
          <Side title={`Departure · ${a.input.outbound.flightNumber ?? 'second flight'}`} r={a.departure} h={h?.departure} flight={a.input.outbound.flightNumber ?? ''} />
        </div>
        {combos.length > 1 && !a.notAssessed && (
          <>
            <h5>Other possible transfers <Badge k="estimated" /></h5>
            <table className="cx-table">
              <thead><tr><th>From</th><th>To</th><th>Weight</th><th>Needs (typ. · high)</th><th>Margin</th><th></th></tr></thead>
              <tbody>{combos.slice(0, 8).map((c, i) => (
                <tr key={i} className={c === best?.combo ? 'on' : ''}>
                  <td>{c.arrival.area.short}</td><td>{c.departure.area.short}</td><td>{unknownWeights ? 'unknown' : c.arrival.group || c.departure.group ? `${pct(c.evidence)} (terminal level)` : pct(c.evidence)}{c.plausible ? '' : ' · unlikely'}</td>
                  <td>{c.needed ? `${mins(c.needed.typical)} · ${mins(c.needed.max)}` : '—'}</td>
                  <td>{c.margin ? `${c.margin.typical >= 0 ? '+' : ''}${Math.round(c.margin.typical)} min` : '—'}</td>
                  <td className={VERDICT_CLASS[c.verdict]} title={c.why}>{c.verdict}</td>
                </tr>))}</tbody>
            </table>
            {combos.length > 8 && <p className="cx-small cx-muted">{combos.length - 8} less likely combinations not shown.</p>}
            <p className="cx-small cx-muted">Weight = how likely the pair of areas is from history (independent estimates, not a calibrated probability); a terminal's share is not split over its halls.</p>
          </>
        )}
        <h5>Unknown</h5><ul className="cx-small">{a.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
        <h5>Assumptions <Badge k="estimated" /></h5><ul className="cx-small">{a.assumptions.map((x) => <li key={x.name}>{x.text}: {x.minutes} min</li>)}</ul>
        {a.rules.length > 0 && <><h5>From the airport model</h5><ul className="cx-small">{a.rules.map((r) => <li key={r.id}>{r.text}</li>)}</ul></>}
        <p className="cx-small cx-muted">Schematic map, not to scale. Airport model as of {a.modelAsOf}. Bundle {BUNDLE_INFO.mapsHash.slice(0, 8)} · flight-data contract {BUNDLE_INFO.contractHash.slice(0, 8)}.</p>
      </details>
      <p className="cx-small cx-muted cx-foot">Predictions come from earlier flights, not confirmed gates. Check the departure boards and your airline on the day.</p>
    </div>
  );
}

// Flight-data research dashboard. Read-only views over the collection: health, runs, flights and their assignment
// history, statistics with sample sizes, quality findings, and the prediction boundary. Not linked from the passenger app.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

type Json = any;
const TOKEN_KEY = 'fd-admin-token';

async function api(path: string, token: string): Promise<Json> {
  const r = await fetch(`fd-api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status });
  return body;
}

function useApi(path: string | null, token: string, deps: unknown[] = []) {
  const [state, set] = useState<{ data: Json | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) return;
    let live = true;
    set((s) => ({ ...s, loading: true, error: null }));
    api(path, token).then((data) => live && set({ data, error: null, loading: false })).catch((e) => live && set({ data: null, error: e.message, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, ...deps]);
  return state;
}

const fmtTime = (iso: string | null | undefined, tz?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtHm = (iso: string | null | undefined, tz?: string) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : '—');
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)} %` : '—');
const Unknown = ({ children = 'not reported' }: { children?: ReactNode }) => <span className="fd-unknown">{children}</span>;

const STATUS_LABEL: Record<string, string> = { success: '✓ success', partial: '◐ partial', suspect: '⚠ suspect', failed: '✕ failed', running: '… running', skipped: '– skipped' };
const Status = ({ s }: { s: string }) => <span className={`fd-status fd-s-${s}`}>{STATUS_LABEL[s] ?? s}</span>;

/** A share meter: one hue, the value always printed beside it (never colour alone). */
const Meter = ({ k, n, label }: { k: number; n: number; label?: string }) => (
  <span className="fd-meter" title={`${label ?? ''} ${k} of ${n}`}>
    <span className="fd-meter-track" aria-hidden><span className="fd-meter-fill" style={{ width: n ? `${(100 * k) / n}%` : 0 }} /></span>
    <span className="fd-meter-val">{pct(k, n)}</span>
  </span>
);

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState(() => location.hash.replace('#', '') || 'health');
  useEffect(() => { const h = () => setTab(location.hash.replace('#', '') || 'health'); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  const overview = useApi(token ? 'overview' : null, token, [tab]);
  useEffect(() => { if (overview.error && /token/.test(overview.error) && token) { sessionStorage.removeItem(TOKEN_KEY); setToken(''); } }, [overview.error, token]);

  if (!token) return (
    <div className="fd-app"><main className="fd-main fd-login">
      <h1>Flight-data research</h1>
      <p className="fd-muted">Research tool of CDG Navigator — not part of the passenger app. Enter the admin token (FD_ADMIN_TOKEN or ADMIN_TOKEN in the local .env).</p>
      <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem(TOKEN_KEY, draft.trim()); setToken(draft.trim()); }}>
        <input type="password" aria-label="Admin token" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Admin token" autoFocus />
        <button type="submit">Open</button>
      </form>
    </main></div>
  );

  const airports: Json[] = overview.data?.airports ?? [];
  const tzOf = (iata: string) => airports.find((a) => a.iata === iata)?.tz;
  const tabs = [['health', 'Health'], ['overview', 'Overview'],['runs', 'Collection runs'], ['flights', 'Flights'], ['stats', 'Statistics'], ['quality', 'Quality'], ['predict', 'Prediction check']];
  return (
    <div className="fd-app">
      <header className="fd-top">
        <strong>Flight-data research</strong>
        <nav>{tabs.map(([id, label]) => <a key={id} href={`#${id}`} className={tab === id ? 'on' : ''}>{label}</a>)}</nav>
        <button className="fd-link" onClick={() => { sessionStorage.removeItem(TOKEN_KEY); setToken(''); }}>Sign out</button>
      </header>
      <main className="fd-main">
        {overview.error && <p className="fd-error">{overview.error}</p>}
        {tab === 'health' && <Health token={token} />}
        {tab === 'overview' && <Overview data={overview.data} />}
        {tab === 'runs' && <Runs token={token} airports={airports} tzOf={tzOf} />}
        {tab === 'flights' && <Flights token={token} airports={airports} tzOf={tzOf} />}
        {tab === 'stats' && <Stats token={token} airports={airports} sources={overview.data?.sources ?? []} assignments={overview.data?.assignments ?? []} />}
        {tab === 'quality' && <Quality token={token} airports={airports} />}
        {tab === 'predict' && <Predict token={token} airports={airports} />}
      </main>
    </div>
  );
}

const SLOT_LABEL: Record<string, string> = { collected: '✓ on time', late: '◷ caught up late', partial: '◐ partial', missed: '✕ missed', pending: '… in progress' };
function Health({ token }: { token: string }) {
  const h = useApi('ops', token, []);
  if (h.error) return <p className="fd-error">{h.error}</p>;
  if (!h.data) return <p className="fd-muted">Loading…</p>;
  const d = h.data, lastBackup = d.backups.at(-1);
  return (
    <section>
      <h1>Collector health</h1>
      <p className="fd-muted">Every collection slot since activation, per airport (07:00 + yesterday, 15:00, 23:30 local time). “Caught up late” = collected more than 30 min after the slot (computer asleep or off), still complete. “Missed” = not collected within the 6-hour catch-up window. Same report on the command line: <code>npm run fd:health</code>.</p>
      <div className="fd-tiles">
        {d.budgets.map((b: Json) => <div key={b.source} className="fd-tile"><span>API units, last {b.periodDays} days</span><strong>{b.used.toLocaleString()} <span className="fd-small fd-muted">of {b.budget.toLocaleString()}</span></strong><Meter k={b.used} n={b.budget} /></div>)}
        <div className="fd-tile"><span>Latest backup</span><strong>{lastBackup ? lastBackup.date : <Unknown>none yet</Unknown>}</strong><span>{d.backups.length} full kept{lastBackup ? ` · ${(lastBackup.bytes / 1e6).toFixed(1)} MB` : ''} · {(d.counterBackups ?? []).length} counter files</span></div>
        {d.retention && <div className="fd-tile"><span>Raw data (licence: ≤ {d.retention.rawLimitDays} days)</span><strong>{d.retention.oldestRawRow ? `${Math.floor((Date.parse(d.now) - Date.parse(d.retention.oldestRawRow)) / 864e5)} d oldest` : '—'}</strong><span>rolled up after {d.retention.rawRollupDays} d{(d.manualCopies ?? []).length ? ` · manual copy auto-deleted on ${String(d.manualCopies[0].deleteBy).slice(0, 10)}` : ''}</span></div>}
        <div className="fd-tile"><span>Database size</span><strong>{d.databaseBytes ? `${Math.round(d.databaseBytes / 1e6)} MB` : '—'}</strong><span>outside OneDrive</span></div>
        <div className="fd-tile"><span>Duplicate runs</span><strong>{d.duplicateRuns === 0 ? '✓ none' : `✕ ${d.duplicateRuns}`}</strong></div>
      </div>
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>Airport</th><th>Last success</th><th>Next slot</th><th>Flight-days</th><th>Departures, completed days: terminal · gate</th><th>Arrivals, completed days: terminal · gate</th><th>Slots</th><th>Failed runs 24 h</th><th>Problem slots</th></tr></thead>
        <tbody>{d.airports.map((a: Json) => {
          const none = { flightDays: 0, withTerminal: 0, withGate: 0 };
          const cov = a.coverageFinal ?? a.coverage7d, dep = cov.departure ?? none, arr = cov.arrival ?? none;
          return (
            <tr key={a.airport}>
              <td><strong>{a.airport}</strong></td><td>{a.lastSuccess ? fmtTime(a.lastSuccess, a.tz) : <Unknown>never</Unknown>}</td><td>{fmtTime(a.nextSlot, a.tz)}</td>
              <td>{a.flightDaysTotal.toLocaleString()}</td>
              <td><Meter k={dep.withTerminal} n={dep.flightDays} /> <Meter k={dep.withGate} n={dep.flightDays} /></td>
              <td><Meter k={arr.withTerminal} n={arr.flightDays} /> <Meter k={arr.withGate} n={arr.flightDays} /></td>
              <td className="fd-small">{Object.entries(a.slots).filter(([, n]) => n).map(([s, n]) => <span key={s} className="fd-chip">{SLOT_LABEL[s]} {String(n)}</span>)}</td>
              <td>{a.failedRuns24h ? <span className="fd-warn">{a.failedRuns24h}</span> : 0}</td>
              <td className="fd-small">{a.problemSlots.length ? a.problemSlots.map((p: Json) => `${p.slot} (${SLOT_LABEL[p.state]}${p.delayMinutes ? `, +${p.delayMinutes} min` : ''})`).join(' · ') : '—'}</td>
            </tr>);
        })}</tbody>
      </table></div>
    </section>
  );
}

function Overview({ data }: { data: Json | null }) {
  if (!data) return <p className="fd-muted">Loading…</p>;
  const active = data.airports.filter((a: Json) => a.enabled || a.flights > 0);
  return (
    <>
      <section>
        <h1>Collection health</h1>
        <p className="fd-muted">Collection slots (local airport time): {data.schedule.map((s: Json) => `${s.at}${s.dayOffsets.includes(-1) ? ' (+ yesterday)' : ''}`).join(' · ')}. Assigned sources: {data.assignments.length ? data.assignments.map((a: Json) => `${a.airport} ← ${a.source}`).join(', ') : <Unknown>none — recurring collection is not activated</Unknown>}.</p>
        {!active.length && <p className="fd-note">No airport has data yet. See docs/FLIGHT_DATA_OPERATIONS.md for how to activate approved sources.</p>}
        {(data.budgets ?? []).map((b: Json) => (
          <div key={b.source} className="fd-tiles">
            <div className="fd-tile"><span>{b.source}: API units used, last {b.periodDays} days</span><strong>{b.used.toLocaleString()} <span className="fd-small fd-muted">of {b.budget.toLocaleString()} budget</span></strong><Meter k={b.used} n={b.budget} /></div>
            <div className="fd-tile"><span>Status</span><strong>{b.used >= b.budget ? '✕ budget reached: collection paused' : b.used >= b.budget * 0.9 ? '⚠ close to the budget' : '✓ within budget'}</strong><span>Plan hard limit 5,000 units; the scheduler stops at the budget.</span></div>
          </div>
        ))}
        <div className="fd-cards">
          {active.map((a: Json) => {
            const runs = a.runs_7d ?? {};
            return (
              <article key={a.iata} className="fd-card">
                <h2>{a.iata} <span className="fd-muted">{a.name}</span></h2>
                <dl>
                  <dt>Scheduled</dt><dd>{a.enabled ? 'yes' : <Unknown>no (manual / test runs only)</Unknown>}</dd>
                  <dt>Last successful run</dt><dd>{a.last_success ? fmtTime(a.last_success, a.tz) : <Unknown>never</Unknown>}</dd>
                  <dt>Last run</dt><dd>{fmtTime(a.last_run, a.tz)}</dd>
                  <dt>Next slot</dt><dd>{a.enabled ? fmtTime(a.nextSlot, a.tz) : '—'}</dd>
                  <dt>Runs, last 7 days</dt><dd>{Object.keys(runs).length ? Object.entries(runs).map(([s, n]) => <span key={s} className="fd-chip"><Status s={s} /> {String(n)}</span>) : '—'}</dd>
                  <dt>Stored</dt><dd>{a.flights.toLocaleString()} flight-days · {a.observations.toLocaleString()} observations</dd>
                </dl>
              </article>
            );
          })}
        </div>
      </section>
      <section>
        <h2>Sources and permissions</h2>
        <div className="fd-scroll"><table className="fd-table">
          <thead><tr><th>Source</th><th>Kind</th><th>Airports</th><th>Permission</th><th>Retention</th><th>Fields</th><th>Cost</th></tr></thead>
          <tbody>{data.sources.filter((s: Json) => s.kind !== 'fixture').map((s: Json) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><div className="fd-small">{s.terms_url ? <a href={s.terms_url} target="_blank" rel="noreferrer">terms</a> : null} — {s.terms_summary}</div></td>
              <td>{s.kind}</td><td>{s.airports.join(', ')}</td>
              <td><span className={`fd-perm fd-p-${s.permission}`}>{s.permission.replace(/-/g, ' ')}</span></td>
              <td className="fd-small">{s.retention}</td>
              <td className="fd-small">{Object.entries(s.capabilities.fields).map(([f, v]) => <span key={f} className={v ? 'fd-has' : 'fd-not'}>{v ? '✓' : '✕'} {f} </span>)}</td>
              <td className="fd-small">{s.cost_note}</td>
            </tr>))}</tbody>
        </table></div>
      </section>
    </>
  );
}

function AirportSelect({ airports, value, onChange, all }: { airports: Json[]; value: string; onChange: (v: string) => void; all?: boolean }) {
  return (
    <label>Airport <select value={value} onChange={(e) => onChange(e.target.value)}>
      {all && <option value="">all</option>}
      {airports.map((a) => <option key={a.iata} value={a.iata}>{a.iata}{a.flights ? '' : ' (no data)'}</option>)}
    </select></label>
  );
}
const firstWithData = (airports: Json[]) => airports.find((a) => a.flights > 0)?.iata ?? airports[0]?.iata ?? 'CDG';

function Runs({ token, airports, tzOf }: { token: string; airports: Json[]; tzOf: (a: string) => string | undefined }) {
  const [airport, setAirport] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = new URLSearchParams({ limit: '300', ...(airport && { airport }), ...(status && { status }) });
  const runs = useApi(`runs?${q}`, token, [airport, status]);
  const detail = useApi(open ? `runs/${open}` : null, token, [open]);
  return (
    <section>
      <h1>Collection runs</h1>
      <div className="fd-filters">
        <AirportSelect airports={airports} value={airport} onChange={setAirport} all />
        <label>Status <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">all</option>{Object.keys(STATUS_LABEL).map((s) => <option key={s}>{s}</option>)}</select></label>
      </div>
      {runs.error && <p className="fd-error">{runs.error}</p>}
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>Started (local)</th><th>Airport</th><th>Source</th><th>Direction · date</th><th>Slot</th><th>Status</th><th>Windows</th><th>Flights</th><th>Terminal</th><th>Gate</th><th>New / unchanged obs.</th><th>Rejected</th><th>Warnings</th></tr></thead>
        <tbody>{(runs.data?.runs ?? []).map((r: Json) => (
          <tr key={r.id} className={open === r.id ? 'sel' : ''} onClick={() => setOpen(open === r.id ? null : r.id)}>
            <td>{fmtTime(r.started_at, tzOf(r.airport))}</td><td>{r.airport}</td><td className="fd-small">{r.source_id}</td>
            <td>{r.direction} · {r.target_date}</td><td className="fd-small">{r.trigger === 'schedule' ? r.slot.slice(11) : r.trigger}</td>
            <td><Status s={r.status} /></td><td>{r.windows_ok}/{r.windows_expected}</td><td>{r.flights_seen}</td>
            <td><Meter k={r.with_terminal} n={r.flights_seen} /></td><td><Meter k={r.with_gate} n={r.flights_seen} /></td>
            <td>{r.observations_new} / {r.observations_unchanged}</td><td>{r.rows_rejected}</td>
            <td className="fd-small">{(r.warnings ?? []).join('; ') || r.error || ''}</td>
          </tr>))}</tbody>
      </table></div>
      {open && detail.data && (
        <aside className="fd-panel">
          <h3>Run {open} <button className="fd-link" onClick={() => setOpen(null)}>close</button></h3>
          <p><Status s={detail.data.run.status} /> {detail.data.run.error}</p>
          <h4>Windows</h4>
          <table className="fd-table small"><thead><tr><th>Window</th><th>OK</th><th>HTTP</th><th>Pages</th><th>Rows</th><th>Kept</th><th>Error</th></tr></thead>
            <tbody>{(detail.data.run.diagnostics?.windows ?? []).map((w: Json) => <tr key={w.label}><td>{w.label}</td><td>{w.ok ? '✓' : '✕'}</td><td>{w.http ?? '—'}</td><td>{w.pages}</td><td>{w.rows}</td><td>{w.kept}</td><td>{w.error ?? ''}</td></tr>)}</tbody></table>
          <h4>Completeness judgement</h4>
          <pre>{JSON.stringify(detail.data.run.completeness, null, 2)}</pre>
          <h4>Findings ({detail.data.findings.length})</h4>
          <ul>{detail.data.findings.map((f: Json) => <li key={f.id}><span className={`fd-sev fd-sev-${f.severity}`}>{f.severity}</span> {f.kind}: {f.detail?.pattern ?? (f.detail?.reasons ?? []).join('; ')} {f.detail?.count ? `(${f.detail.count}×)` : ''}</li>)}</ul>
        </aside>
      )}
    </section>
  );
}

interface F { airport: string; direction: string; from: string; to: string; carrier: string; flight: string; other: string }
function FilterBar({ f, set, airports }: { f: F; set: (f: F) => void; airports: Json[] }) {
  const inp = (k: keyof F, label: string, ph = '') => <label>{label} <input value={f[k]} placeholder={ph} onChange={(e) => set({ ...f, [k]: k === 'from' || k === 'to' ? e.target.value : e.target.value.toUpperCase() })} type={k === 'from' || k === 'to' ? 'date' : 'text'} size={k === 'flight' ? 8 : 5} /></label>;
  return (
    <div className="fd-filters">
      <AirportSelect airports={airports} value={f.airport} onChange={(airport) => set({ ...f, airport })} />
      <label>Direction <select value={f.direction} onChange={(e) => set({ ...f, direction: e.target.value })}><option value="departure">departures</option><option value="arrival">arrivals</option></select></label>
      {inp('from', 'From')}{inp('to', 'To')}{inp('carrier', 'Airline', 'e.g. AF')}{inp('flight', 'Flight', 'e.g. AF1234')}{inp('other', f.direction === 'arrival' ? 'Origin' : 'Destination', 'e.g. TLV')}
    </div>
  );
}
const filterQuery = (f: F) => new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
function useFilters(airports: Json[]) {
  const [f, set] = useState<F>({ airport: '', direction: 'departure', from: '', to: '', carrier: '', flight: '', other: '' });
  useEffect(() => { if (!f.airport && airports.length) set((x) => ({ ...x, airport: firstWithData(airports) })); }, [airports, f.airport]);
  return [f, set] as const;
}

const PAGE = 500;
function Flights({ token, airports, tzOf }: { token: string; airports: Json[]; tzOf: (a: string) => string | undefined }) {
  const [f, set] = useFilters(airports);
  const [open, setOpen] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filterQuery(f)]);
  const list = useApi(f.airport ? `flights?${filterQuery(f)}&limit=${PAGE}&offset=${page * PAGE}` : null, token, [filterQuery(f), page]);
  const hist = useApi(open ? `flights/${open}` : null, token, [open]);
  const tz = tzOf(f.airport);
  const total = Number(list.data?.total ?? 0), shown = list.data?.flights?.length ?? 0;
  return (
    <section>
      <h1>Flights and assignment history</h1>
      <p className="fd-muted">One row per flight-day. Terminal and gate are the <em>last reported</em> values, not independently confirmed positions. “Runs” = collection runs that saw the flight; “States” = distinct reported states (a new state is stored only when status, times, terminal or gate change), so a flight seen in one run has 1 of each. “Changed” marks flights whose terminal or gate differed between states. A “codeshare listing” is a marketing number whose operator row could not be linked; a “duplicate” is a number the source listed as its own operating flight although it is the same movement as another (a verified codeshare, or the same aircraft registration). Neither is counted as a separate flight in statistics. Gate: <em>final</em> = the source was seen again after the movement; <em>latest</em> = may still change; the first published gate is shown when it differed.</p>
      <FilterBar f={f} set={set} airports={airports} />
      {list.error && <p className="fd-error">{list.error}</p>}
      {list.data && <p className="fd-small">Showing {total ? page * PAGE + 1 : 0}–{page * PAGE + shown} of {total} flight-days{list.data.codeshareListings ? ` (${list.data.codeshareListings} codeshare listings)` : ''}{list.data.duplicates ? ` (${list.data.duplicates} duplicates)` : ''}.{' '}
        {page > 0 && <button className="fd-link" onClick={() => setPage(page - 1)}>previous</button>}{' '}
        {(page + 1) * PAGE < total && <button className="fd-link" onClick={() => setPage(page + 1)}>next {PAGE}</button>}</p>}
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>Date</th><th>Flight</th><th>{f.direction === 'arrival' ? 'From' : 'To'}</th><th>Scheduled (local)</th><th>Terminal</th><th>Gate</th><th>Status</th><th>Runs</th><th>States</th><th>Changed</th><th>Identity</th></tr></thead>
        <tbody>{(list.data?.flights ?? []).map((x: Json) => (
          <tr key={x.id} className={open === x.id ? 'sel' : ''} onClick={() => setOpen(open === x.id ? null : x.id)}>
            <td>{String(x.local_date).slice(0, 10)}</td><td><strong>{x.flight_key}</strong></td><td>{x.other ?? <Unknown>?</Unknown>}</td>
            <td>{fmtHm(x.scheduled_utc, tz)}</td><td>{x.terminal ?? <Unknown />}</td><td>{x.gate ?? <Unknown />}{x.gate && <span className="fd-small fd-muted"> {x.gate_state}{x.first_gate && x.first_gate !== x.gate ? ` · first ${x.first_gate}` : ''}</span>}</td><td>{x.status}</td>
            <td>{x.sightings}</td><td>{x.observations}</td><td>{Number(x.terminals_seen) > 1 ? 'terminal ' : ''}{Number(x.gates_seen) > 1 ? 'gate' : ''}</td>
            <td className="fd-small">{x.duplicate_of ? `duplicate of ${x.duplicate_of_key} (${x.duplicate_reason === 'verified-codeshare' ? 'verified codeshare' : 'same aircraft'})` : x.marketing_only ? 'codeshare listing (operator not linked)' : x.identity === 'listed' ? 'listed number (operator unknown)' : 'operating flight'}</td>
          </tr>))}</tbody>
      </table></div>
      {list.data && !list.data.flights.length && <p className="fd-muted">No flights match.</p>}
      {open && hist.data && (
        <aside className="fd-panel">
          <h3>{hist.data.flight.flight_key} · {String(hist.data.flight.local_date).slice(0, 10)} <button className="fd-link" onClick={() => setOpen(null)}>close</button></h3>
          <p className="fd-small">Codes: {hist.data.codes.map((c: Json) => `${c.code} (${c.role})`).join(', ')} · seen in {hist.data.sightings.length} runs</p>
          <table className="fd-table small">
            <thead><tr><th>First seen</th><th>Last seen</th><th>Seen</th><th>Stage</th><th>Status</th><th>Terminal</th><th>Gate</th><th>Estimated</th><th>Actual</th><th>Source</th></tr></thead>
            <tbody>{hist.data.observations.map((o: Json) => (
              <tr key={o.id}>
                <td>{fmtTime(o.first_seen_at, tz)}</td><td>{fmtTime(o.last_seen_at, tz)}</td><td>{o.seen_count}×</td>
                <td>{o.stage === 'post-movement' ? 'after movement (last reported)' : o.stage === 'pre-movement' ? 'before movement' : o.stage}</td>
                <td>{o.status_raw ?? o.status}</td>
                <td className={o.terminal_changed ? 'fd-changed' : ''}>{o.terminal ?? <Unknown />}{o.terminal_changed ? ` (was ${o.prev_terminal ?? '—'})` : ''}</td>
                <td className={o.gate_changed ? 'fd-changed' : ''}>{o.gate ?? <Unknown />}{o.gate_changed ? ` (was ${o.prev_gate ?? '—'})` : ''}</td>
                <td>{fmtHm(o.estimated_utc, tz)}</td><td>{fmtHm(o.actual_utc, tz)}</td><td className="fd-small">{o.source_id}</td>
              </tr>))}</tbody>
          </table>
        </aside>
      )}
    </section>
  );
}

const SMALL = 5;
function Stats({ token, airports, sources, assignments }: { token: string; airports: Json[]; sources: Json[]; assignments: Json[] }) {
  const [f, set] = useFilters(airports);
  const [field, setField] = useState<'terminal' | 'gate' | 'gateArea'>('terminal');
  const [groupBy, setGroupBy] = useState('carrier');
  const q = filterQuery(f);
  const dist = useApi(f.airport ? `stats/distribution?${q}&field=${field}&groupBy=${groupBy}` : null, token, [q, field, groupBy]);
  const comp = useApi(f.airport ? `stats/completeness?${q}` : null, token, [q]);
  const days: Json[] = comp.data?.days ?? [];
  const gates = useApi(f.airport ? `stats/gates?${q}&limit=20` : null, token, [q]);
  // A field no source of this airport provides is 'not provided', not 'missing'.
  const provides = (field: string) => sources.some((s) => s.kind !== 'fixture' && (s.airports.includes(f.airport) || assignments.some((a) => a.airport === f.airport && a.source === s.id)) && s.capabilities?.fields?.[field]);
  const np = (field: string) => (sources.length && !provides(field) ? <span className="fd-small fd-warn"> not provided by this airport's source</span> : null);
  const tot = useMemo(() => days.reduce((s, d) => ({ flights: s.flights + d.flights, t: s.t + d.with_terminal, g: s.g + d.with_gate, b: s.b + d.with_both, n: s.n + d.with_neither, tc: s.tc + d.terminal_changed, gc: s.gc + d.gate_changed }), { flights: 0, t: 0, g: 0, b: 0, n: 0, tc: 0, gc: 0 }), [days]);
  const sum = useApi('stats/summary', token, []);
  return (
    <section>
      <h1>Statistics</h1>
      <h2>All airports at a glance</h2>
      <p className="fd-muted">Everything collected so far, per airport and direction (cancelled flights excluded). AeroDataBox raw rows are kept 4 days and then folded into monthly counters, which are included here.</p>
      {sum.error && <p className="fd-error">{sum.error}</p>}
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>Airport</th><th>Direction</th><th>Flight-days</th><th>With terminal</th><th>With gate</th><th>Leading terminals (share of flight-days with a terminal)</th><th>Period</th><th>From monthly counters</th></tr></thead>
        <tbody>{(sum.data?.lines ?? []).map((l: Json) => (
          <tr key={`${l.airport}-${l.direction}`} onClick={() => set({ ...f, airport: l.airport, direction: l.direction })} title="Show this airport below">
            <td><strong>{l.airport}</strong></td><td>{l.direction === 'arrival' ? 'arrivals' : 'departures'}</td><td>{l.flightDays.toLocaleString()}</td>
            <td><Meter k={l.withTerminal} n={l.flightDays} /></td><td><Meter k={l.withGate} n={l.flightDays} /></td>
            <td>{l.terminals.length ? l.terminals.slice(0, 4).map((t: Json) => <span key={t.value} className="fd-chip"><strong>{t.value}</strong> <Meter k={t.n} n={l.withTerminal} /></span>) : <Unknown />}</td>
            <td className="fd-small">{l.first} → {l.last}</td><td>{l.derived ? l.derived.toLocaleString() : '—'}</td>
          </tr>))}</tbody>
      </table></div>
      {sum.data && !sum.data.lines.length && <p className="fd-muted">No data collected yet: the first runs appear here after the next collection slot.</p>}
      <h2>One airport in detail</h2>
      <p className="fd-muted">Counted per flight-day from the last reported values; cancelled flights excluded from distributions. Groups with fewer than {SMALL} flight-days are marked “small sample” and should not be read as a pattern.</p>
      <FilterBar f={f} set={set} airports={airports} />
      <div className="fd-tiles">
        <div className="fd-tile"><span>Flight-days</span><strong>{tot.flights.toLocaleString()}</strong></div>
        <div className="fd-tile"><span>With terminal{np('terminal')}</span><strong>{pct(tot.t, tot.flights)}</strong></div>
        <div className="fd-tile"><span>With gate{np('gate')}</span><strong>{pct(tot.g, tot.flights)}</strong></div>
        <div className="fd-tile"><span>Both · neither</span><strong>{pct(tot.b, tot.flights)} · {pct(tot.n, tot.flights)}</strong></div>
        <div className="fd-tile"><span>Terminal changed · gate changed</span><strong>{pct(tot.tc, tot.flights)} · {pct(tot.gc, tot.flights)}</strong></div>
      </div>
      <h2>Distribution</h2>
      <div className="fd-filters">
        <label>Field <select value={field} onChange={(e) => setField(e.target.value as any)}><option value="terminal">terminal</option><option value="gateArea">gate area (pier / concourse letter)</option><option value="gate">gate</option></select></label>
        <label>Group by <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}><option value="carrier">airline</option><option value="other">route (other airport)</option><option value="flight_key">flight number</option><option value="none">everything</option></select></label>
      </div>
      {dist.error && <p className="fd-error">{dist.error}</p>}
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>{groupBy === 'carrier' ? 'Airline' : groupBy === 'other' ? 'Route' : groupBy === 'flight_key' ? 'Flight' : 'All'}</th><th>Flight-days</th><th>Missing {field}</th><th>Most common</th><th>Share of known</th><th>Others</th></tr></thead>
        <tbody>{(dist.data?.groups ?? []).slice(0, 300).map((g: Json) => (
          <tr key={g.group}>
            <td><strong>{g.group}</strong>{g.total < SMALL && <span className="fd-small fd-warn"> small sample</span>}</td>
            <td>{g.total}{g.derived ? <span className="fd-small fd-muted"> ({g.derived} from counters)</span> : null}</td><td><Meter k={g.missing} n={g.total} /></td>
            <td>{g.values[0]?.value ?? <Unknown />}</td><td>{g.values[0] ? (g.known >= SMALL ? <Meter k={g.values[0].n} n={g.known} /> : <span className="fd-small fd-muted">{g.values[0].n} of {g.known} (too few for a %)</span>) : '—'}</td>
            <td className="fd-small">{g.values.slice(1, 6).map((v: Json) => `${v.value} ${v.n}`).join(' · ')}{g.values.length > 6 ? ' …' : ''}</td>
          </tr>))}</tbody>
      </table></div>
      <h2>Completeness by day</h2>
      <p className="fd-muted fd-small">Raw days only (the last ≈ 4 days for AeroDataBox; older days live on in the monthly counters above). Today's gates are incomplete at MAD, IST and ZRH: they are published only shortly before departure.</p>
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>Date</th><th>Flight-days</th><th>Cancelled</th><th>Terminal</th><th>Gate</th><th>Both</th><th>Neither</th><th>Terminal changed</th><th>Gate changed</th><th>Operator unknown</th><th>Codeshare listings (not counted)</th><th>Duplicates (not counted)</th></tr></thead>
        <tbody>{days.map((d) => (
          <tr key={d.date}><td>{d.date}</td><td>{d.flights}</td><td>{d.cancelled}</td>
            <td><Meter k={d.with_terminal} n={d.flights} /></td><td><Meter k={d.with_gate} n={d.flights} /></td>
            <td><Meter k={d.with_both} n={d.flights} /></td><td><Meter k={d.with_neither} n={d.flights} /></td>
            <td>{d.terminal_changed}</td><td>{d.gate_changed}</td><td>{d.listed_identity}</td><td>{d.codeshare_listings}</td><td>{d.duplicates}</td></tr>))}</tbody>
      </table></div>
      <h2>Gate assignments: initial, updated, final</h2>
      <p className="fd-muted fd-small">Physical flight-days with a gate. <em>Final</em> = seen again after the movement. “Initial kept” is judged only on final flight-days first seen before the movement: how often the first published gate was still the gate at departure, by how many hours ahead it was first seen.</p>
      {gates.data && <>
        <p className="fd-small">{gates.data.summary.withGate} with a gate · {gates.data.summary.final} final · {gates.data.summary.changed} changed at least once ({gates.data.summary.changedTwiceOrMore} twice or more, {gates.data.summary.withdrawn} withdrawn) · initial gate kept on {gates.data.summary.keptInitial} of {gates.data.summary.judged} judged.</p>
        <div className="fd-scroll"><table className="fd-table small"><thead><tr><th>First seen ahead</th><th>Judged</th><th>Initial gate kept</th></tr></thead>
          <tbody>{gates.data.summary.byLead.map((b: Json) => <tr key={b.lead}><td>{b.lead}</td><td>{b.n}</td><td>{b.n ? <Meter k={b.kept} n={b.n} /> : '—'}</td></tr>)}</tbody></table></div>
      </>}
    </section>
  );
}

function Quality({ token, airports }: { token: string; airports: Json[] }) {
  const [airport, setAirport] = useState('');
  const list = useApi(`quality?limit=400${airport ? `&airport=${airport}` : ''}`, token, [airport]);
  return (
    <section>
      <h1>Data-quality findings</h1>
      <div className="fd-filters"><AirportSelect airports={airports} value={airport} onChange={setAirport} all /></div>
      <div className="fd-scroll"><table className="fd-table">
        <thead><tr><th>When</th><th>Severity</th><th>Airport</th><th>Run</th><th>Kind</th><th>Detail</th></tr></thead>
        <tbody>{(list.data?.findings ?? []).map((q: Json) => (
          <tr key={q.id}><td>{fmtTime(q.created_at)}</td><td><span className={`fd-sev fd-sev-${q.severity}`}>{q.severity}</span></td><td>{q.airport}</td><td>{q.run_id}</td><td>{q.kind}</td>
            <td className="fd-small">{q.detail?.pattern ?? (q.detail?.reasons ?? []).join('; ')} {q.detail?.count ? `(${q.detail.count}×)` : ''} {q.detail?.examples ? `e.g. ${JSON.stringify(q.detail.examples.slice(0, 2))}` : ''}</td></tr>))}</tbody>
      </table></div>
    </section>
  );
}

function Predict({ token, airports }: { token: string; airports: Json[] }) {
  const [q, setQ] = useState({ airport: '', flight: '', date: new Date().toISOString().slice(0, 10), direction: 'departure' });
  const [res, setRes] = useState<{ data: Json | null; error: string | null }>({ data: null, error: null });
  useEffect(() => { if (!q.airport && airports.length) setQ((x) => ({ ...x, airport: firstWithData(airports) })); }, [airports, q.airport]);
  const run = useCallback(() => { api(`predict?${new URLSearchParams(q)}`, token).then((data) => setRes({ data, error: null })).catch((e) => setRes({ data: null, error: e.message })); }, [q, token]);
  const p = res.data;
  return (
    <section>
      <h1>Prediction check</h1>
      <p className="fd-muted">The integration boundary CDG Navigator will call later (<code>GET /fd-api/predict</code>). It is <strong>not</strong> connected to passenger routing. History uses flight-days strictly before the date; no prediction below {5} flight-days.</p>
      <form className="fd-filters" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <AirportSelect airports={airports} value={q.airport} onChange={(airport) => setQ({ ...q, airport })} />
        <label>Direction <select value={q.direction} onChange={(e) => setQ({ ...q, direction: e.target.value })}><option value="departure">departure</option><option value="arrival">arrival</option></select></label>
        <label>Flight <input value={q.flight} onChange={(e) => setQ({ ...q, flight: e.target.value.toUpperCase() })} placeholder="AF1234" size={8} required /></label>
        <label>Date <input type="date" value={q.date} onChange={(e) => setQ({ ...q, date: e.target.value })} /></label>
        <button type="submit">Check</button>
      </form>
      {res.error && <p className="fd-error">{res.error}</p>}
      {p && (
        <div className="fd-cards">
          <article className="fd-card">
            <h2>Historical pattern</h2>
            <dl>
              <dt>Most likely terminal</dt><dd>{p.historical.mostLikelyTerminal ?? <Unknown>no prediction (insufficient sample)</Unknown>}</dd>
              <dt>Confidence</dt><dd>{p.historical.confidence} <span className="fd-small fd-muted">(score {p.historical.confidenceScore}, uncalibrated)</span></dd>
              <dt>Sample</dt><dd>{p.historical.sample} flight-days with a terminal, of {p.historical.totalFlightDays}</dd>
              <dt>Observed</dt><dd>{p.historical.range.from ?? '—'} to {p.historical.range.to ?? '—'}</dd>
              <dt>Terminals</dt><dd>{p.historical.terminals.map((t: Json) => `${t.value}: ${t.n}`).join(' · ') || '—'}</dd>
              <dt>Gates</dt><dd>{p.historical.gates.map((t: Json) => `${t.value}: ${t.n}`).join(' · ') || <Unknown>none reported</Unknown>}</dd>
            </dl>
          </article>
          <article className="fd-card">
            <h2>Current flight status</h2>
            {p.current ? <dl><dt>Terminal</dt><dd>{p.current.terminal ?? <Unknown />}</dd><dt>Gate</dt><dd>{p.current.gate ?? <Unknown />}</dd><dt>Status</dt><dd>{p.current.status} ({p.current.stage})</dd><dt>Observed</dt><dd>{fmtTime(p.current.observedAt)} · {p.current.source}</dd></dl> : <p><Unknown>no observation for this date</Unknown></p>}
            <p className="fd-small">Basis: <strong>{p.basis}</strong> · last refresh {fmtTime(p.lastRefresh)}</p>
            <ul className="fd-small">{p.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
          </article>
        </div>
      )}
    </section>
  );
}

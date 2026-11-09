// Confirmation view of an itinerary read from a screenshot. Every key field is shown, editable, with how it was
// established: read clearly, to check (unclear / corrected / worked out), missing, or typed by the traveller. The
// analysis stays disabled until every crucial value to check is confirmed or corrected and the airports and connection
// times are filled in. Nothing here is "verified" until the traveller says so.
import { fillDates, problems } from '../screenshot/extract.ts';
import type { Draft, DraftJourney, DraftLeg, Field, LegField } from '../screenshot/types.ts';

const up = (s: string) => s.toUpperCase().replace(/\s+/g, '');
const blank = (why: string): Field => ({ value: null, state: 'missing', why });
const blankLeg = (from: string | null): DraftLeg => ({
  f: { from: from ? { value: from, state: 'typed' } : blank('enter the airport'), to: blank('enter the airport'), depDate: blank('enter the date'), depTime: blank('enter the time'), arrDate: blank('enter the date'), arrTime: blank('enter the time'), flightNumber: blank('enter the flight number'), airline: blank('optional') },
  altNumbers: [], operatedBy: null,
});

const STATE_TEXT: Record<Field['state'], string> = { read: 'Read', check: 'Check', missing: 'Missing', typed: 'Yours' };

function Input({ field, label, type, onChange, onConfirm, crucial, width, placeholder, maxLength }: {
  field: Field; label: string; type: 'text' | 'date' | 'time'; onChange: (v: string) => void; onConfirm: () => void; crucial: boolean; width?: number; placeholder?: string; maxLength?: number;
}) {
  const cls = `cx-f cx-f-${field.state}${crucial ? ' cx-f-crucial' : ''}`;
  return (
    <label className={cls} title={field.why ?? STATE_TEXT[field.state]} style={width ? { width } : undefined}>
      <span className="cx-f-k">{label}{field.state !== 'typed' && <span className="cx-f-s"> · {STATE_TEXT[field.state]}</span>}</span>
      <span className="cx-f-v">
        <input type={type} value={field.value ?? ''} placeholder={placeholder} aria-label={label} data-state={field.state}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)} />
        {field.state === 'check' && <button type="button" className="cx-ok-btn" title="The value matches my screenshot" onClick={onConfirm} aria-label={`Confirm ${label}`}>✓</button>}
      </span>
      {field.state === 'check' && field.why && <span className="cx-f-why">{field.why}</span>}
    </label>
  );
}

export function ConfirmItinerary({ draft, onChange, onAnalyse, busy }: { draft: Draft; onChange: (d: Draft) => void; onAnalyse: () => void; busy?: boolean }) {
  const setJourney = (ji: number, j: DraftJourney) => onChange({ ...draft, journeys: draft.journeys.map((x, i) => (i === ji ? j : x)) });
  const setField = (ji: number, li: number, k: LegField, value: string | null, state: Field['state'] = 'typed') => {
    const j = draft.journeys[ji];
    let v = value === '' ? null : value;
    if (v && (k === 'from' || k === 'to' || k === 'flightNumber')) v = up(v);
    const legs = j.legs.map((l, i) => (i === li ? { ...l, f: { ...l.f, [k]: { value: v, state: v === null && state === 'typed' ? 'missing' : state, why: state === 'typed' ? (value === null ? undefined : 'confirmed or entered by you') : undefined } } } : l));
    // the connecting airport is one value: arriving at X means the next flight leaves from X (an airport change stays possible by editing the next "From")
    if (k === 'to' && legs[li + 1] && (!legs[li + 1].f.from.value || legs[li + 1].f.from.value === j.legs[li].f.to.value)) legs[li + 1] = { ...legs[li + 1], f: { ...legs[li + 1].f, from: { value: v, state: 'typed' } } };
    let nj: DraftJourney = { ...j, legs };
    if ((k === 'depDate' || k === 'arrDate') && v) nj = fillDates(nj);
    setJourney(ji, nj);
  };
  const confirm = (ji: number, li: number, k: LegField) => setField(ji, li, k, draft.journeys[ji].legs[li].f[k].value, 'typed');
  const setTicket = (ji: number, c: number, v: string) => {
    const j = draft.journeys[ji];
    setJourney(ji, { ...j, selfTransferAt: j.selfTransferAt.map((s, i) => (i === c ? (v === 'self' ? true : v === 'protected' ? false : null) : s)), ticketState: j.ticketState.map((s, i) => (i === c ? 'typed' : s)) });
  };
  const addLeg = (ji: number) => {
    const j = draft.journeys[ji];
    setJourney(ji, { ...j, legs: [...j.legs, blankLeg(j.legs.at(-1)?.f.to.value ?? null)], selfTransferAt: [...j.selfTransferAt, null], ticketState: [...j.ticketState, 'missing'] });
  };
  const removeLeg = (ji: number, li: number) => {
    const j = draft.journeys[ji];
    const c = Math.max(0, li - 1);   // the connection that disappears with the leg
    setJourney(ji, { ...j, legs: j.legs.filter((_, i) => i !== li), selfTransferAt: j.selfTransferAt.filter((_, i) => i !== c), ticketState: j.ticketState.filter((_, i) => i !== c) });
  };

  const probs = problems(draft);
  const toCheck = probs.filter((p) => p.text === 'confirm or correct').length, toFill = probs.length - toCheck;
  const legs = draft.journeys.flatMap((j) => j.legs);
  const conns = draft.journeys.reduce((n, j) => n + Math.max(0, j.legs.length - 1), 0);
  const noDate = legs.some((l) => !l.f.depDate.value || !l.f.arrDate.value);
  const noFlight = legs.some((l) => !l.f.flightNumber.value);
  const crucial = (k: LegField) => k !== 'airline';

  return (
    <form className="cx-confirm" onSubmit={(e) => { e.preventDefault(); if (!probs.length && conns) onAnalyse(); }}>
      <p className="cx-small">Check what was read against your screenshot. <span className="cx-legend"><span className="cx-f-read">Read</span> <span className="cx-f-check">Check</span> <span className="cx-f-missing">Missing</span></span></p>
      {draft.warnings.length > 0 && <ul className="cx-issues cx-small">{draft.warnings.map((w) => <li key={w} className="cx-issue cx-material">⚠ {w}</li>)}</ul>}
      {draft.journeys.map((j, ji) => (
        <fieldset key={ji} className="cx-journey">
          <legend>{j.label}</legend>
          {j.legs.map((l, li) => (
            <div key={li}>
              {li > 0 && (
                <div className="cx-conn-row">
                  <span>Change of plane at <strong>{j.legs[li - 1].f.to.value ?? '?'}</strong></span>
                  <label className={`cx-f-${j.ticketState[li - 1]}`}>Ticket
                    <select value={j.selfTransferAt[li - 1] === null ? 'unknown' : j.selfTransferAt[li - 1] ? 'self' : 'protected'} onChange={(e) => setTicket(ji, li - 1, e.target.value)} aria-label={`Ticket type at ${j.legs[li - 1].f.to.value ?? ''}`}>
                      <option value="unknown">Not shown — not sure (both shown)</option>
                      <option value="protected">One ticket (protected)</option>
                      <option value="self">Separate tickets (self-transfer)</option>
                    </select>
                  </label>
                  {j.ticketState[li - 1] === 'read' && <span className="cx-small cx-muted">“Self transfer” is shown in the screenshot</span>}
                </div>
              )}
              <div className="cx-leg-row" data-leg={`${ji}-${li}`}>
                <div className="cx-leg-head"><strong>Flight {li + 1}</strong>{j.legs.length > 1 && <button type="button" className="cx-link cx-small" onClick={() => removeLeg(ji, li)}>remove</button>}</div>
                <div className="cx-grid">
                  <Input field={l.f.from} label="From" type="text" maxLength={3} width={70} placeholder="TLV" crucial onChange={(v) => setField(ji, li, 'from', v)} onConfirm={() => confirm(ji, li, 'from')} />
                  <Input field={l.f.to} label="To" type="text" maxLength={3} width={70} placeholder="CDG" crucial onChange={(v) => setField(ji, li, 'to', v)} onConfirm={() => confirm(ji, li, 'to')} />
                  <Input field={l.f.flightNumber} label="Flight no." type="text" width={100} placeholder="AF1621" crucial onChange={(v) => setField(ji, li, 'flightNumber', v)} onConfirm={() => confirm(ji, li, 'flightNumber')} />
                  <Input field={l.f.airline} label="Airline" type="text" placeholder="optional" crucial={false} onChange={(v) => setField(ji, li, 'airline', v)} onConfirm={() => confirm(ji, li, 'airline')} />
                </div>
                <div className="cx-grid">
                  {(['depDate', 'depTime', 'arrDate', 'arrTime'] as const).map((k) => (
                    <Input key={k} field={l.f[k]} label={{ depDate: 'Departs (date)', depTime: 'Departs (time)', arrDate: 'Arrives (date)', arrTime: 'Arrives (time)' }[k]} type={k.endsWith('Date') ? 'date' : 'time'} crucial={crucial(k)}
                      onChange={(v) => setField(ji, li, k, v)} onConfirm={() => confirm(ji, li, k)} />
                  ))}
                </div>
              </div>
            </div>
          ))}
          <button type="button" className="cx-link cx-small" onClick={() => addLeg(ji)}>+ add a flight the screenshot does not show</button>
        </fieldset>
      ))}
      <p className="cx-small cx-muted">Times are local at each airport, as shown on Skyscanner.</p>
      {!conns && <p className="cx-note cx-small">This itinerary has no change of plane. Add the next flight if the screenshot cuts it off.</p>}
      {noDate && conns > 0 && <p className="cx-note cx-small">Without both dates of a connection it is shown as <strong>not assessed</strong>. Enter the dates for a verdict.</p>}
      {noFlight && conns > 0 && <p className="cx-small cx-muted">Without flight numbers, no terminal or gate history is looked up (result cards do not show them; the itinerary details do).</p>}
      {probs.length > 0 && <p className="cx-small cx-block" role="status">{toCheck ? `${toCheck} value${toCheck > 1 ? 's' : ''} to confirm (✓) or correct` : ''}{toCheck && toFill ? ' · ' : ''}{toFill ? `${toFill} to fill in or fix` : ''}.</p>}
      <button type="submit" className="cx-primary" disabled={!!probs.length || !conns || busy}>{busy ? 'Analysing…' : 'Analyze connection'}</button>
    </form>
  );
}

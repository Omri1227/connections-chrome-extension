// Manual itinerary entry: the fallback when the page cannot be read, and the way to complete or correct what was read.
import { useState } from 'react';
import { SUPPORTED } from '../core/airports.ts';
import { normFlight } from '../core/flight.ts';
import type { ConnectionInput, Leg } from '../core/types.ts';

const blankLeg = (from: string, to: string): Leg => ({ flightNumber: null, altNumbers: [], airline: null, operatedBy: null, from, to, depDate: null, depTime: null, arrDate: null, arrTime: null });
export const blankConnection = (airport = 'CDG'): ConnectionInput => ({ airport, inbound: blankLeg('', airport), outbound: blankLeg(airport, ''), selfTransfer: null });

const up = (s: string) => s.toUpperCase().replace(/\s+/g, '');
const orNull = (s: string) => (s.trim() ? s.trim() : null);
/** Flight number as typed, normalised when it looks like one ("KL0461" → "KL461", R-26). */
const flightOf = (s: string) => { const v = orNull(up(s)); return v ? normFlight(v) ?? v : null; };

export function ManualForm({ initial, onSubmit, busy }: { initial: ConnectionInput; onSubmit: (c: ConnectionInput) => void; busy?: boolean }) {
  const [c, setC] = useState<ConnectionInput>(initial);
  const leg = (k: 'inbound' | 'outbound', patch: Partial<Leg>) => setC((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  const airport = (a: string) => setC((x) => ({ ...x, airport: a, inbound: { ...x.inbound, to: a }, outbound: { ...x.outbound, from: a } }));
  const valid = !!c.airport;
  const dateHint = (!c.inbound.arrDate || !c.outbound.depDate) && (c.inbound.arrTime || c.outbound.depTime);
  return (
    <form className="cx-form" onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ ...c, inbound: { ...c.inbound, flightNumber: flightOf(c.inbound.flightNumber ?? '') }, outbound: { ...c.outbound, flightNumber: flightOf(c.outbound.flightNumber ?? '') } }); }}>
      <label>Connecting airport
        <select value={c.airport} onChange={(e) => airport(e.target.value)}>
          {[...SUPPORTED, ...(SUPPORTED.includes(c.airport as any) ? [] : [c.airport])].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Arriving flight</legend>
        <label>Flight number <input value={c.inbound.flightNumber ?? ''} placeholder="AF1621" onChange={(e) => leg('inbound', { flightNumber: orNull(up(e.target.value)) })} /></label>
        <label>From (IATA) <input value={c.inbound.from} placeholder="TLV" maxLength={3} onChange={(e) => leg('inbound', { from: up(e.target.value) })} /></label>
        <label>Arrival date <input type="date" value={c.inbound.arrDate ?? ''} onChange={(e) => {
          const d = orNull(e.target.value);
          // the departure date starts as the arrival date (visible and editable): never a hidden assumption
          setC((x) => ({ ...x, inbound: { ...x.inbound, arrDate: d, depDate: x.inbound.depDate ?? d }, outbound: { ...x.outbound, depDate: x.outbound.depDate ?? d } }));
        }} /></label>
        <label>Arrival time <input type="time" value={c.inbound.arrTime ?? ''} onChange={(e) => leg('inbound', { arrTime: orNull(e.target.value) })} /></label>
      </fieldset>
      <fieldset>
        <legend>Departing flight</legend>
        <label>Flight number <input value={c.outbound.flightNumber ?? ''} placeholder="AF1240" onChange={(e) => leg('outbound', { flightNumber: orNull(up(e.target.value)) })} /></label>
        <label>To (IATA) <input value={c.outbound.to} placeholder="AMS" maxLength={3} onChange={(e) => leg('outbound', { to: up(e.target.value) })} /></label>
        <label>Departure date <input type="date" value={c.outbound.depDate ?? ''} onChange={(e) => leg('outbound', { depDate: orNull(e.target.value) })} /></label>
        <label>Departure time <input type="time" value={c.outbound.depTime ?? ''} onChange={(e) => leg('outbound', { depTime: orNull(e.target.value) })} /></label>
      </fieldset>
      {dateHint && <p className="cx-small cx-muted">Both dates are needed for a verdict (an overnight connection departs the next day).</p>}
      <label>Ticket type
        <select value={c.selfTransfer === null ? 'unknown' : c.selfTransfer ? 'self' : 'protected'} onChange={(e) => setC((x) => ({ ...x, selfTransfer: e.target.value === 'unknown' ? null : e.target.value === 'self' }))}>
          <option value="unknown">Not sure (show both)</option>
          <option value="protected">One ticket (protected: bags checked through)</option>
          <option value="self">Separate tickets (self-transfer: collect and re-check bags)</option>
        </select>
      </label>
      <button type="submit" disabled={!valid || busy}>{busy ? 'Analysing…' : 'Analyze connection'}</button>
    </form>
  );
}

// Connection-analysis orchestration (site-independent): itinerary → connections → input checks → history lookup →
// candidate areas → routes and transfer assessment. Every part of the result says whether it is observed, predicted,
// estimated or unknown. Inputs that cannot be trusted fail safely as "not assessed" with the reason (R-04, R-06, R-07).
import type { AirportModel } from '../../../airportmaps/src/types.ts';
import { assessTransfer, ASSUMPTIONS, severityOf, type Assessment } from './assess.ts';
import type { PassengerStatus } from './calibration.ts';
import { cityOf, countryOf, isSupported, SUPPORTED } from './airports.ts';
import { airlineOf, normFlight } from './flight.ts';
import type { ConnectionAnswer, HistoryProvider, HistoryResult } from './history.ts';
import { resolveAreas, type Resolution } from './resolve.ts';
import { connectionTiming, type ConnectionTiming } from './time.ts';
import type { ConnectionInput, Itinerary } from './types.ts';

export const ANALYSIS_VERSION = 2;

export interface ConnectionAnalysis {
  version: number;
  status: 'ok' | 'unsupported-airport' | 'missing-information' | 'airport-change' | 'invalid-times';
  airport: string;
  airportName: string | null;
  input: ConnectionInput;
  /** Observed on the page / typed by the traveller. */
  observed: { scheduledMinutes: number | null; date: string | null; selfTransfer: boolean | null; selfTransferAssumed: boolean; timing: ConnectionTiming };
  /** Why no verdict is given at all (airport change, missing or inconsistent dates). */
  notAssessed: { code: 'airport-change' | 'missing-date' | 'missing-time' | 'negative' | 'too-long'; text: string } | null;
  missing: string[];
  history: { status: 'ok' | 'unavailable'; reason?: string; answer: ConnectionAnswer | null };
  arrival: Resolution | null;
  departure: Resolution | null;
  /** The verdict shown: the known ticket type, or — when the page did not say — the worse of the two scenarios (R-10). */
  assessment: Assessment | null;
  /** When the ticket type is unknown: both scenarios, so the traveller sees each (never a silent "protected"). */
  scenarios: { protected: Assessment; selfTransfer: Assessment } | null;
  /** Material caveats about the connection itself (overnight, entering Schengen, …). */
  caveats: string[];
  modelAsOf: string | null;
  rules: { id: string; text: string }[];       // airport rules shown for context (MCT, zones, controls, baggage, customs)
  assumptions: { name: string; text: string; minutes: string }[];
  unknowns: string[];
  supportedAirports: readonly string[];
}

/** Every change of plane in the itinerary, in order. The ticket type comes from the label of THAT connection (R-10). */
export function connectionsOf(it: Itinerary): ConnectionInput[] {
  const out: ConnectionInput[] = [];
  for (const j of it.journeys) for (let k = 0; k + 1 < j.legs.length; k++)
    out.push({ airport: j.legs[k].to, inbound: j.legs[k], outbound: j.legs[k + 1], selfTransfer: j.selfTransferAt ? j.selfTransferAt[k] ?? null : j.legs.length === 2 ? j.selfTransfer : null });
  return out;
}

const RULE_IDS = /mct|zones|controls|passport|transfer|security|baggage|bags|customs/;

export async function analyzeConnection(c0: ConnectionInput, deps: { models: Record<string, AirportModel>; history: HistoryProvider; today: string; passenger?: PassengerStatus }): Promise<ConnectionAnalysis> {
  // flight numbers as the data source stores them ("KL0461" → "KL461", R-26)
  const c: ConnectionInput = { ...c0, inbound: { ...c0.inbound, flightNumber: normFlight(c0.inbound.flightNumber) ?? c0.inbound.flightNumber }, outbound: { ...c0.outbound, flightNumber: normFlight(c0.outbound.flightNumber) ?? c0.outbound.flightNumber } };
  const m = deps.models[c.airport];
  const timing = connectionTiming(c.inbound, c.outbound, c.airport);
  const scheduledMinutes = timing.status === 'ok' ? timing.minutes : null;
  const date = c.inbound.arrDate ?? null;
  const missing: string[] = [];
  if (!c.inbound.flightNumber) missing.push('arriving flight number');
  if (!c.outbound.flightNumber) missing.push('departing flight number');
  if (!c.inbound.arrDate) missing.push('arrival date');
  if (!c.outbound.depDate) missing.push('departure date');
  if (!c.inbound.arrTime || !c.outbound.depTime) missing.push('arrival and departure times');
  const base: ConnectionAnalysis = {
    version: ANALYSIS_VERSION, status: 'ok', airport: c.airport, airportName: m?.name ?? cityOf(c.airport), input: c,
    observed: { scheduledMinutes, date, selfTransfer: c.selfTransfer, selfTransferAssumed: c.selfTransfer === null, timing },
    notAssessed: null, missing, history: { status: 'unavailable', answer: null }, arrival: null, departure: null, assessment: null, scenarios: null, caveats: [],
    modelAsOf: m?.asOf ?? null, rules: [], assumptions: Object.entries(ASSUMPTIONS).filter(([, v]) => typeof v === 'object').map(([k, v]: [string, any]) => ({ name: k, text: v.text, minutes: `${v.min}–${v.max} (typical ${v.typical})` })),
    unknowns: [], supportedAirports: SUPPORTED,
  };
  // A change of airport (IST → SAW, CDG → ORY) is out of scope (R-07): no lookup, no routes, no verdict.
  if (c.outbound.from && c.inbound.to && c.outbound.from !== c.inbound.to)
    return { ...base, status: 'airport-change', notAssessed: { code: 'airport-change', text: `Not assessed: change of airport (${c.inbound.to} → ${c.outbound.from}). Transfers between airports are out of scope; allow several hours and check the ground transfer yourself.` } };
  if (!isSupported(c.airport) || !m) return { ...base, status: 'unsupported-airport', unknowns: [`${c.airport} is not one of the supported connecting airports (${SUPPORTED.join(', ')}).`] };
  const notAssessed = timing.status === 'ok' ? null : { code: timing.status, text: timing.problem! };

  // History: only when both flight numbers and both dates are known (nothing else is sent).
  let h: HistoryResult | null = null;
  if (c.inbound.flightNumber && c.outbound.flightNumber && c.inbound.arrDate && c.outbound.depDate && timing.status !== 'negative')
    h = await deps.history.connection({ arrivalFlight: c.inbound.flightNumber, departureFlight: c.outbound.flightNumber, date: c.inbound.arrDate, departureDate: c.outbound.depDate, airport: c.airport });
  const answer = h?.ok ? h.answer : null;
  const routingDate = date ?? deps.today;
  const outboundInfo = { destinationAirport: c.outbound.to || undefined, destinationCountry: countryOf(c.outbound.to) ?? undefined, airline: airlineOf(c.outbound.flightNumber) ?? undefined };
  const arrival = resolveAreas(m, { direction: 'arrival', other: c.inbound.from, answer: answer?.arrival ?? null, date: routingDate, flight: { airline: airlineOf(c.inbound.flightNumber) ?? undefined, operatedByOther: !!c.inbound.operatedBy } });
  const departure = resolveAreas(m, { direction: 'departure', other: c.outbound.to, answer: answer?.departure ?? null, date: routingDate, outbound: outboundInfo, flight: { airline: airlineOf(c.outbound.flightNumber) ?? undefined, operatedByOther: !!c.outbound.operatedBy } });
  const profile = { originAirport: c.inbound.from || undefined, originCountry: countryOf(c.inbound.from) ?? undefined, ...outboundInfo };
  const run = (selfTransfer: boolean) => assessTransfer(m, arrival, departure, { scheduledMinutes, selfTransfer, date: routingDate, arrivalTime: date ? c.inbound.arrTime : null, profile, passenger: deps.passenger });
  let assessment: Assessment, scenarios: ConnectionAnalysis['scenarios'] = null;
  if (c.selfTransfer === null) {
    // unknown ticket type (R-10): assess both; the headline is the worse one, both are shown
    const prot = run(false), self = run(true);
    scenarios = { protected: prot, selfTransfer: self };
    // on a severity tie a definite verdict (risky / not assessed) leads over 'depends on the area'
    assessment = severityOf(self) > severityOf(prot) || (severityOf(self) === severityOf(prot) && prot.verdict === 'uncertain' && self.verdict !== 'uncertain') ? self : prot;
  } else assessment = run(c.selfTransfer);
  if (notAssessed) assessment = { ...assessment, verdict: 'not-assessed', worst: 'not-assessed', best: 'not-assessed', verdictText: notAssessed.text, drivers: [] };

  const caveats: string[] = [];
  if (timing.status === 'ok' && timing.overnight) caveats.push('Overnight or long connection: night closures, an overnight stay airside, check-in opening hours and transit / entry rules are not assessed.');
  if (timing.status === 'ok' && timing.clockChange) caveats.push('The clocks change during this layover (daylight saving); the connection time takes it into account.');
  // LHR (asymmetric UK border): an international arrival connecting to a UK / Ireland flight passes UK immigration
  if (c.airport === 'LHR' && arrival.zone === 'international' && departure.zone === 'domestic') caveats.push('You pass UK border control at Heathrow (international arrival → UK / Ireland flight), then a biometric check at security. Most passports need an ETA or a visa to enter the UK; this is not checked here.');
  if (arrival.zone === 'non-schengen' && departure.zone === 'schengen') caveats.push(`You enter the Schengen area at ${c.airport} (passport control on the way). Whether you may enter depends on your nationality and documents; this is not checked here.`);
  const unknowns: string[] = [];
  if (!h) unknowns.push('History was not looked up: both flight numbers and both dates are needed.');
  else if (!h.ok) unknowns.push(`History unavailable: ${h.detail}`);
  if (arrival.provenance === 'unknown') unknowns.push(`Arrival area of ${c.inbound.flightNumber ?? 'the first flight'} is not predicted.`);
  for (const [r, w, f] of [[arrival, 'Arrival', c.inbound.flightNumber], [departure, 'Departure', c.outbound.flightNumber]] as const) if (r.basis === 'airline-terminal') unknowns.push(`${w} terminal of ${f ?? 'this flight'} is the airline's published terminal, not a prediction from flight history.`);
  if (departure.provenance === 'unknown') unknowns.push(`Departure area of ${c.outbound.flightNumber ?? 'the second flight'} is not predicted.`);
  if (c.selfTransfer === null) unknowns.push('The page did not say whether this is a protected connection (one ticket, bags checked through) or a self-transfer (separate tickets): both are shown, and the verdict is the less favourable one.');
  if (!date) unknowns.push('The date is not known: the airport layout of today is used and no time of day is applied.');
  unknowns.push('Actual gate assignments, delays and queue lengths on the day.');

  return {
    ...base,
    status: notAssessed ? (timing.status === 'missing-date' || timing.status === 'missing-time' ? 'missing-information' : 'invalid-times') : missing.length ? 'missing-information' : 'ok',
    notAssessed,
    history: h?.ok ? { status: 'ok', answer } : { status: 'unavailable', reason: h ? h.detail : 'not looked up', answer: null },
    arrival, departure, assessment, scenarios, caveats,
    rules: m.rules.filter((r) => RULE_IDS.test(r.id)).map((r) => ({ id: r.id, text: r.text })),
    unknowns,
  };
}

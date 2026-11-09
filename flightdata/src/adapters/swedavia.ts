// Swedavia FlightInfo API v2 (Stockholm Arlanda and the other Swedavia airports) — official, free account
// (10,000 requests/month), terms allow storing and publicly displaying the data with attribution
// (https://apideveloper.swedavia.se/signup, §3.3–3.8; read, not accepted). NOT active until FD_SWEDAVIA_KEY is set.
//
// Endpoints (https://apideveloper.swedavia.se/content/Using_the_FlightInfo_API.pdf, model v2.0.0):
//   GET https://api.swedavia.se/flightinfo/v2/{airportIATA}/arrivals/{date}   (date = UTC date, yyyy-mm-dd)
//   GET https://api.swedavia.se/flightinfo/v2/{airportIATA}/departures/{date}
// Data kept from 7 days back to 90 days ahead. Field names follow the documented model; the JSON casing is read
// case-insensitively because the PDF lists PascalCase names and .NET services usually emit camelCase.
import { parseJson, politeGet } from '../http.ts';
import { normCode, normFlightNumber, normTerminal } from '../normalize.ts';
import { addDays, parseSourceTime, zonedInstant } from '../time.ts';
import type { AirportInfo, FetchContext, FlightStatus, NormalizedFlight, ParseIssue, SourceAdapter, Window, WindowResult } from '../types.ts';

const STATUS: Record<string, FlightStatus> = { SCH: 'scheduled', FPL: 'scheduled', SEQ: 'approaching', ACT: 'airborne', LAN: 'landed', CAN: 'cancelled', DIV: 'diverted', RER: 'diverted', FLS: 'unknown', DEL: 'cancelled' };

/** Case-insensitive property access along a path. */
export function pick(o: any, ...path: string[]): any {
  let cur = o;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const hit = Object.keys(cur).find((x) => x.toLowerCase() === k.toLowerCase());
    cur = hit === undefined ? undefined : cur[hit];
  }
  return cur;
}

export function parseFlightInfo(body: any, a: AirportInfo, direction: 'arrival' | 'departure'): { records: NormalizedFlight[]; issues: ParseIssue[]; rawCount: number } {
  const issues: ParseIssue[] = [];
  const flights = pick(body, 'flights');
  if (!Array.isArray(flights)) { issues.push({ kind: 'format-change', detail: 'response has no "flights" list' }); return { records: [], issues, rawCount: 0 }; }
  const timeKey = direction === 'arrival' ? 'arrivalTime' : 'departureTime';
  const recs: NormalizedFlight[] = [];
  for (const f of flights) {
    const fn = normFlightNumber(pick(f, 'flightId'));
    const sched = parseSourceTime(pick(f, timeKey, 'scheduledUtc'), 'UTC');
    if (!fn || !sched) { issues.push({ kind: 'rejected-row', detail: `row without ${fn ? 'a scheduled time' : 'a readable flight number'}`, sample: { flightId: pick(f, 'flightId') } }); continue; }
    const code = pick(f, 'locationAndStatus', 'flightLegStatus');
    const status: FlightStatus = code && STATUS[code] ? STATUS[code] : 'unknown';
    const actual = parseSourceTime(pick(f, timeKey, 'actualUtc'), 'UTC');
    const finalStatus: FlightStatus = direction === 'departure' && actual && status === 'airborne' ? 'departed' : status;
    const leg = pick(f, 'flightLegIdentifier') ?? {};
    const other = direction === 'arrival' ? normCode(pick(leg, 'departureAirportIata')) : normCode(pick(leg, 'arrivalAirportIata'));
    const cs = (pick(f, 'codeShareData') ?? []).map((x: unknown) => normFlightNumber(x)?.number).filter(Boolean) as string[];
    recs.push({
      airport: a.iata, direction, flightNumber: fn.number, carrier: fn.carrier,
      operatingFlightNumber: null, role: 'operating', codeshares: cs, airlineName: pick(f, 'airlineOperator', 'name') ?? null,
      origin: direction === 'arrival' ? other : a.iata, destination: direction === 'departure' ? other : a.iata,
      scheduledUtc: sched.toISOString(),
      estimatedUtc: parseSourceTime(pick(f, timeKey, 'estimatedUtc'), 'UTC')?.toISOString() ?? null,
      actualUtc: actual?.toISOString() ?? null,
      terminal: normTerminal(pick(f, 'locationAndStatus', 'terminal')), gate: normCode(pick(f, 'locationAndStatus', 'gate')), stand: null,
      baggageBelt: normCode(pick(f, 'baggage', 'baggageClaimUnit')),
      status: finalStatus, statusRaw: pick(f, 'locationAndStatus', 'flightLegStatusEnglish') ?? code ?? null, aircraftType: null,
      sourceRecordId: pick(leg, 'ifplId') ?? null,
      extra: { diIndicator: pick(f, 'diIndicator') ?? null, gateOpenUtc: pick(f, 'locationAndStatus', 'gateOpenUtc') ?? null },
    });
  }
  return { records: recs, issues, rawCount: flights.length };
}

export const swedavia: SourceAdapter = {
  info: {
    id: 'swedavia', name: 'Swedavia FlightInfo API v2', kind: 'official-api', airports: ['ARN', 'GOT', 'BMA', 'MMX', 'LLA', 'UME', 'OSD', 'VBY', 'RNB', 'KRN'],
    baseUrl: 'https://api.swedavia.se/flightinfo/v2', termsUrl: 'https://apideveloper.swedavia.se/signup',
    termsSummary: 'Free account (10,000 requests/month). Licence to access, use and publicly display the data in own applications, attribution mandatory (§3.3–3.4); combining with other data allowed (§3.6); sharing unchanged data to other systems or selling it not allowed (§3.7); no storage limit stated; on termination stop using the data (§11.2).',
    permission: 'pending-owner-approval',
    retention: 'No stated limit while the account is active; data must not be used after termination',
    rawRetentionDays: null,
    costNote: 'Free (10,000 requests/month; ≈ 360/month needed for one airport).',
    capabilities: { fields: { terminal: true, gate: true, stand: false, estimatedTime: true, actualTime: true, status: true, codeshares: true, operatingFlag: false, baggageBelt: true, checkIn: true }, maxWindowHours: 24, pastDays: 7, futureDays: 90, requiresKey: true },
  },
  notReady: (env) => (env.FD_SWEDAVIA_KEY ? null : 'FD_SWEDAVIA_KEY is not set (needs an owner-approved Swedavia developer account)'),
  // The API is keyed by UTC date: a local day spans two UTC dates, so two requests, filtered to the local day later.
  windows(a, direction, date) {
    const from = zonedInstant(date, '00:00', a.tz), to = zonedInstant(addDays(date, 1), '00:00', a.tz);
    const utcDates = [...new Set([from.toISOString().slice(0, 10), new Date(to.getTime() - 1).toISOString().slice(0, 10)])];
    return utcDates.map((d, i) => ({ direction, localDate: date, fromUtc: i === 0 ? from.toISOString() : `${d}T00:00:00.000Z`, toUtc: i === utcDates.length - 1 ? to.toISOString() : `${addDays(d, 1)}T00:00:00.000Z`, label: `${direction}:${date}#utc-${d}` }));
  },
  async fetchWindow(a: AirportInfo, w: Window, ctx: FetchContext): Promise<WindowResult> {
    const d = w.fromUtc.slice(0, 10);
    const url = `${ctx.env.FD_SWEDAVIA_BASE ?? 'https://api.swedavia.se/flightinfo/v2'}/${a.iata}/${w.direction === 'arrival' ? 'arrivals' : 'departures'}/${d}`;
    const r = await politeGet(ctx.fetch, url, { headers: { 'Ocp-Apim-Subscription-Key': ctx.env.FD_SWEDAVIA_KEY ?? '' }, minSpacingMs: 1000 });
    const out: WindowResult = { window: w, ok: false, httpStatus: r.status, pages: 1, rawCount: 0, records: [], issues: [], error: r.error, bytes: r.bytes };
    if (!r.ok) return out;
    const pj = parseJson(r.body);
    if (pj.error) { out.error = pj.error; return out; }
    const p = parseFlightInfo(pj.value, a, w.direction);
    const inWin = p.records.filter((x) => x.scheduledUtc >= w.fromUtc && x.scheduledUtc < w.toUtc);
    Object.assign(out, { ok: true, rawCount: p.rawCount, records: inWin, issues: p.issues, rawSample: { url, numberOfFlights: pick(pj.value, 'numberOfFlights') ?? null } });
    return out;
  },
};

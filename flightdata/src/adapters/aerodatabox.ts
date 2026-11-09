// AeroDataBox FIDS (airport departures and arrivals) — the only authorised route found to Paris-CDG terminal and gate
// data (docs/FLIGHT_DATA_SOURCE_RESEARCH.md). Needs an owner-approved account; NOT active until FD_AERODATABOX_KEY is set.
//
// Endpoint (OpenAPI https://doc.aerodatabox.com/docs/openapi-rapidapi-v1.json, verified 2026-10-30):
//   GET /flights/airports/iata/{code}/{fromLocal}/{toLocal}?direction=Both&withLeg=false&withCancelled=true&withCodeshared=true…
//   window ≤ 12 h on most plans; history 180–365 days by plan (so yesterday is retrievable); "TIER 2" = 2 units/call.
// Licence (https://aerodatabox.com/terms/, "Last updated: October 11, 2026", §5.2/5.5/5.6, verified): raw Contents may be
// kept at most 7 consecutive days (unless the plan has extended caching); Derived Works are exempt from that limit.
// → rawRetentionDays = 7; retention.ts rolls flight-days into monthly counters before deleting raw rows.
import { parseJson, politeGet } from '../http.ts';
import { normFlightNumber, normTerminal, normCode } from '../normalize.ts';
import { localParts, parseSourceTime } from '../time.ts';
import type { AirportInfo, FetchContext, FlightStatus, NormalizedFlight, ParseIssue, SourceAdapter, Window, WindowResult } from '../types.ts';
import { dayWindows } from './fixture.ts';

const STATUS: Record<string, FlightStatus> = {
  Unknown: 'unknown', Expected: 'scheduled', EnRoute: 'airborne', CheckIn: 'scheduled', Boarding: 'boarding', GateClosed: 'gate-closed',
  Departed: 'departed', Delayed: 'delayed', Approaching: 'approaching', Arrived: 'arrived', Canceled: 'cancelled', Diverted: 'diverted',
  CanceledUncertain: 'unknown', // "likely cancelled": not asserted as cancelled
};

const localStr = (iso: string, tz: string) => { const p = localParts(new Date(iso), tz); return `${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

export function windowUrl(base: string, a: AirportInfo, w: Window) {
  // toLocal is inclusive in the provider's API: end one minute before the next window starts.
  const to = new Date(Date.parse(w.toUtc) - 60_000).toISOString();
  const q = new URLSearchParams({ direction: 'Both', withLeg: 'false', withCancelled: 'true', withCodeshared: 'true', withCargo: 'false', withPrivate: 'false', withLocation: 'false' });
  return `${base.replace(/\/$/, '')}/flights/airports/iata/${a.iata}/${localStr(w.fromUtc, a.tz)}/${localStr(to, a.tz)}?${q}`;
}

/** Normalises one FIDS response for one direction. Codeshare rows are linked to an operator row only on an exact match. */
export function parseFids(body: any, a: AirportInfo, direction: 'arrival' | 'departure'): { records: NormalizedFlight[]; issues: ParseIssue[]; rawCount: number } {
  const issues: ParseIssue[] = [];
  const list = direction === 'arrival' ? body?.arrivals : body?.departures;
  if (!Array.isArray(list)) {
    if (body && typeof body === 'object' && !('arrivals' in body) && !('departures' in body)) issues.push({ kind: 'format-change', detail: `response has neither arrivals nor departures (keys: ${Object.keys(body).slice(0, 8).join(', ')})` });
    return { records: [], issues, rawCount: 0 };
  }
  const recs: NormalizedFlight[] = [];
  // Aircraft registration per row: links codeshare rows below, and is kept in extra.registration so that two
  // "operating" flight-days on one airframe at one instant are recognised as one movement (store.ts markDuplicates).
  const regOf = new WeakMap<NormalizedFlight, string>();
  let callsigns = 0;
  for (const f of list) {
    const mv = f.movement ?? (direction === 'arrival' ? f.arrival : f.departure);
    const fn = normFlightNumber(f.number);
    // Callsign-style numbers ("LH 9CP", "DE 3PW", seen at MUC 2026-10-31) are positioning, ferry or private
    // movements, not scheduled flight numbers: skipped like cargo, not counted as rejected rows.
    if (!fn && typeof f.number === 'string' && /^[A-Z0-9]{2,3}\s+\d+[A-Z]{1,3}$/.test(f.number.trim())) { callsigns++; continue; }
    const sched = parseSourceTime(mv?.scheduledTime?.utc, 'UTC') ?? parseSourceTime(mv?.scheduledTime?.local, a.tz);
    if (!fn || !mv || !sched) { issues.push({ kind: 'rejected-row', detail: `row without ${!fn ? 'a readable flight number' : !mv ? 'movement data' : 'a scheduled time'}`, sample: { number: f?.number } }); continue; }
    if (f.isCargo) continue;
    const status = STATUS[f.status] ?? 'unknown';
    if (!(f.status in STATUS)) issues.push({ kind: 'unexpected-value', detail: `unknown status "${f.status}"` });
    const revised = parseSourceTime(mv.revisedTime?.utc, 'UTC');
    const moved = status === 'departed' || status === 'arrived';
    const other = normCode(mv.airport?.iata) ?? normCode(mv.airport?.icao);
    recs.push({
      airport: a.iata, direction, flightNumber: fn.number, carrier: fn.carrier, operatingFlightNumber: null,
      role: f.codeshareStatus === 'IsOperator' ? 'operating' : f.codeshareStatus === 'IsCodeshared' ? 'marketing' : 'unknown', codeshares: [],
      airlineName: f.airline?.name ?? null,
      origin: direction === 'arrival' ? other : a.iata, destination: direction === 'departure' ? other : a.iata,
      scheduledUtc: sched.toISOString(),
      estimatedUtc: revised && !moved ? revised.toISOString() : null,
      actualUtc: revised && moved ? revised.toISOString() : null,
      terminal: normTerminal(mv.terminal), gate: normCode(mv.gate), stand: null, baggageBelt: normCode(mv.baggageBelt),
      status, statusRaw: f.status ?? null, aircraftType: f.aircraft?.model ?? null, sourceRecordId: null,
      extra: { quality: mv.quality ?? [], runwayUtc: parseSourceTime(mv.runwayTime?.utc, 'UTC')?.toISOString() ?? null, checkInDesk: mv.checkInDesk ?? null },
    });
    if (typeof f.aircraft?.reg === 'string' && f.aircraft.reg.trim()) {
      const reg = f.aircraft.reg.trim().toUpperCase(), r = recs[recs.length - 1];
      regOf.set(r, reg);
      r.extra = { ...r.extra, registration: reg };
    }
  }
  // Codeshare linking: a marketing row is attached to an operator row only when exactly one operator row has the same
  // scheduled instant and the same other airport. Some airports' codeshare rows carry no other airport (AMS, observed
  // 2026-10-31: ~1,200 rows a day) but do carry terminal and gate; those are linked only when exactly one operator row
  // has the same scheduled instant, terminal and gate. When several operator rows match (e.g. AMS→AGP at 18:55 by both
  // Vueling and Transavia, 2026-10-31), the one with the same aircraft registration, else the only one with the same
  // aircraft model, is taken. A route-less row without a gate is linked only by aircraft registration. Otherwise a row
  // stays unlinked (own number, identity 'listed').
  // The source sometimes sends a whole flight twice in one response (AMS 2026-10-31/11-01: 21–33 duplicate rows a
  // run, e.g. KL941 with its 10 codeshares). Candidates are therefore counted once per operating flight number: before
  // this, a duplicated operator looked like two candidates and its codeshares became phantom 'listed' flight-days.
  const ops = recs.filter((r) => r.role === 'operating');
  const otherOf = (r: NormalizedFlight) => (direction === 'arrival' ? r.origin : r.destination);
  const once = (xs: NormalizedFlight[]) => [...new Map(xs.map((o) => [`${o.flightNumber}|${o.scheduledUtc}`, o])).values()];
  for (const r of recs.filter((x) => x.role === 'marketing')) {
    const byRoute = otherOf(r) !== null;
    const reg = regOf.get(r);
    let m = once(ops.filter((o) => o.scheduledUtc === r.scheduledUtc && (byRoute ? otherOf(o) === otherOf(r)
      : r.gate !== null ? o.gate === r.gate && o.terminal === r.terminal : reg !== undefined && regOf.get(o) === reg)));
    let how = byRoute ? 'same scheduled time and route as the only operator row'
      : r.gate !== null ? 'no route on the codeshare row; same scheduled time, terminal and gate as the only operator row'
      : 'no route or gate on the codeshare row; same scheduled time and aircraft registration as the only operator row';
    if (m.length > 1) {
      const reg = regOf.get(r);
      const byReg = reg ? m.filter((o) => regOf.get(o) === reg) : [];
      const byModel = r.aircraftType ? m.filter((o) => o.aircraftType === r.aircraftType) : [];
      if (byReg.length === 1) { m = byReg; how += ', told apart by aircraft registration'; }
      else if (byModel.length === 1) { m = byModel; how += ', told apart by aircraft model'; }
    }
    if (m.length === 1) {
      r.operatingFlightNumber = m[0].flightNumber;
      // Every copy of a duplicated operator row gets the code (de-duplication later keeps one of them).
      for (const o of ops) if (o.flightNumber === m[0].flightNumber && o.scheduledUtc === m[0].scheduledUtc && !o.codeshares.includes(r.flightNumber)) o.codeshares.push(r.flightNumber);
      if (!byRoute) { if (direction === 'arrival') r.origin = m[0].origin; else r.destination = m[0].destination; }
      r.extra = { ...r.extra, codeshareLink: how };
    } else issues.push({ kind: 'unexpected-value', detail: `codeshare row not linked (${m.length} operator candidates)`, sample: { flight: r.flightNumber, scheduled: r.scheduledUtc } });
  }
  if (callsigns) issues.push({ kind: 'unexpected-value', detail: `${callsigns} callsign-style rows skipped (positioning, ferry or private movements)` });
  return { records: recs, issues, rawCount: list.length - callsigns };
}

/** Both directions come back in one call; the second direction of the same window is served from this short cache. */
const cache = new Map<string, { at: number; status: number | null; body: unknown; bytes: number; error: string | null }>();

export const aerodatabox: SourceAdapter = {
  info: {
    id: 'aerodatabox', name: 'AeroDataBox FIDS API (RapidAPI / API.Market)', kind: 'aggregator-api', airports: ['*'],
    baseUrl: 'https://aerodatabox.p.rapidapi.com', termsUrl: 'https://aerodatabox.com/terms/',
    termsSummary: 'Account and plan required. Raw Contents may be kept at most 7 days (§5.5) unless the plan includes extended caching; Derived Works (non-trivial statistics over multiple observations from which no individual record can be reconstructed) are exempt (§5.6). Free Basic plan: non-commercial, attribution required.',
    // Owner subscribed to Pro on API.Market on 2026-10-31 and asked to start collection (8 airports).
    permission: 'approved',
    retention: 'Raw rows ≤ 7 days (rolled into monthly counters, then deleted); derived counters kept',
    rawRetentionDays: 7,
    costNote: 'Pro on API.Market, $7.50/month: 5,000 units, hard limit. FIDS = 2 units per 12-h call (both directions); 8 airports ≈ 4,200 units/month (docs/FLIGHT_DATA_1_TO_20_AIRPORT_COST_MODEL.md).',
    // Guard below the 5,000-unit hard limit; override with FD_AERODATABOX_UNIT_BUDGET (rolling 30 days).
    unitBudget: { unitsPerRequest: 2, periodDays: 30, envVar: 'FD_AERODATABOX_UNIT_BUDGET', defaultUnits: 4_750 },
    capabilities: { fields: { terminal: true, gate: true, stand: false, estimatedTime: true, actualTime: true, status: true, codeshares: true, operatingFlag: true, baggageBelt: true, checkIn: true, aircraftType: true }, maxWindowHours: 12, pastDays: 1, futureDays: 1, requiresKey: true },
  },
  notReady: (env) => (env.FD_AERODATABOX_KEY ? null : 'FD_AERODATABOX_KEY is not set (needs an owner-approved AeroDataBox subscription)'),
  windows: (a, direction, date) => dayWindows(a, direction, date, 12),
  async fetchWindow(a: AirportInfo, w: Window, ctx: FetchContext): Promise<WindowResult> {
    const base = ctx.env.FD_AERODATABOX_BASE ?? 'https://aerodatabox.p.rapidapi.com';
    const url = windowUrl(base, a, w);
    const headers: Record<string, string> = {};
    const key = ctx.env.FD_AERODATABOX_KEY ?? '';
    if (/rapidapi/.test(base)) { headers['X-RapidAPI-Key'] = key; headers['X-RapidAPI-Host'] = new URL(base).host; }
    else headers[ctx.env.FD_AERODATABOX_KEY_HEADER ?? 'x-api-market-key'] = key;
    const ck = `${a.iata}|${url.replace(/\?.*$/, '')}`;
    let hit = cache.get(ck);
    let attempts = 0;
    if (!hit || Date.now() - hit.at > 10 * 60_000) {
      // Paid quota: at most 2 retries, for timeouts, 5xx and 429 (API.Market answers 429 for its 1 request/s limit,
      // observed 2026-10-31; a 429 that persists — e.g. quota spent — fails the run and stops the source for the tick).
      // Other 4xx are final. Spacing 1.5 s after the previous response.
      const r = await politeGet(ctx.fetch, url, { headers, minSpacingMs: 1500, timeoutMs: 45_000, retries: 2, retryOn: (s) => s === null || s === 429 || s >= 500 });
      const pj = r.ok ? parseJson(r.body) : { value: null, error: null };
      hit = { at: Date.now(), status: r.status, body: pj.value, bytes: r.bytes, error: r.ok ? pj.error : r.error };
      if (r.ok && !pj.error) cache.set(ck, hit);
      attempts = r.attempts;
    }
    const out: WindowResult = { window: w, ok: false, httpStatus: hit.status, pages: attempts, rawCount: 0, records: [], issues: [], error: hit.error, bytes: attempts ? hit.bytes : 0 };
    if (hit.error) return out;
    // 204 = no flights in the window per the provider; it is still checked against history by quality.ts.
    const p = parseFids(hit.body ?? {}, a, w.direction);
    Object.assign(out, { ok: true, rawCount: p.rawCount, records: p.records, issues: p.issues, rawSample: attempts ? { url: url.replace(/\?.*$/, ''), first: (hit.body as any)?.[w.direction === 'arrival' ? 'arrivals' : 'departures']?.slice?.(0, 2) } : undefined });
    return out;
  },
};

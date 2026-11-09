// Contract between the extension and the historical flight-data layer (flightdata/src/lookup.ts, served at
// /fd-api/v1/connection; documented in docs/FLIGHT_DATA_EXTENSION_API.md). The types are imported, not copied, so a
// change of the contract breaks the type check here.
import type { ConnectionAnswer, FieldAnswer, FlightAnswer } from '../../../flightdata/src/lookup.ts';

export type { ConnectionAnswer, FieldAnswer, FlightAnswer };

/** History window asked of the server (owner decision 2026-11-02). */
export const HISTORY_DAYS = 30;

export interface ConnectionQuery { arrivalFlight: string; departureFlight: string; date: string; departureDate?: string; airport: string }

/** Why history is missing: the extension then routes over every plausible area (shown as unknown). */
export type HistoryResult = { ok: true; answer: ConnectionAnswer } | { ok: false; reason: 'not-configured' | 'no-permission' | 'unreachable' | 'unauthorised' | 'error'; detail: string };

export interface HistoryProvider { connection(q: ConnectionQuery): Promise<HistoryResult> }

export const HISTORY_TIMEOUT_MS = 20_000;

/** The local flight-data server (pilot). Only the two flight numbers, the date(s) and the airport are sent. */
export class LocalServerHistory implements HistoryProvider {
  // The default wraps the global: calling a stored `fetch` as a method throws "Illegal invocation" in browsers.
  constructor(private base: string, private token: string, private fetchImpl: typeof fetch = (i, init) => fetch(i, init)) {}
  async connection(q: ConnectionQuery): Promise<HistoryResult> {
    if (!this.base || !this.token) return { ok: false, reason: 'not-configured', detail: 'Set the flight-data server address and token in the extension settings.' };
    const u = new URL('/fd-api/v1/connection', this.base);
    u.searchParams.set('arr', q.arrivalFlight); u.searchParams.set('dep', q.departureFlight); u.searchParams.set('date', q.date); u.searchParams.set('airport', q.airport);
    if (q.departureDate && q.departureDate !== q.date) u.searchParams.set('depDate', q.departureDate);
    u.searchParams.set('days', String(HISTORY_DAYS));   // owner decision: the last 30 days (servers before 2026-11-02 ignore it)
    try {
      // 20 s: the first lookup after the server has been idle took 9.9 s on 2026-11-09 (later ones 0.3–0.5 s), so the
      // former 8 s limit showed "history unavailable" for the first analysis of a session.
      const r = await this.fetchImpl(u, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) });
      if (r.status === 401) return { ok: false, reason: 'unauthorised', detail: 'The flight-data server rejected the token.' };
      if (!r.ok) return { ok: false, reason: 'error', detail: `The flight-data server answered HTTP ${r.status}.` };
      return { ok: true, answer: (await r.json()) as ConnectionAnswer };
    } catch (e) {
      return { ok: false, reason: 'unreachable', detail: `The flight-data server at ${this.base} is not reachable (${(e as Error).message}).` };
    }
  }
}

/** Fixed answers (tests, demo mode). */
export class FixtureHistory implements HistoryProvider {
  constructor(private answers: (q: ConnectionQuery) => ConnectionAnswer | null) {}
  async connection(q: ConnectionQuery): Promise<HistoryResult> {
    const a = this.answers(q);
    return a ? { ok: true, answer: a } : { ok: false, reason: 'not-configured', detail: 'no fixture for this query' };
  }
}

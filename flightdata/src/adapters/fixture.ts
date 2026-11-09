// A scripted adapter for tests and local demonstrations: each window answers from a function, so any sequence of
// boards (gate changes, outages, empty answers, format changes) can be replayed without touching a live source.
import type { AirportInfo, Direction, FetchContext, NormalizedFlight, SourceAdapter, SourceInfo, Window, WindowResult } from '../types.ts';
import { zonedInstant, addDays } from '../time.ts';

export type FixtureAnswer = { ok: true; records: NormalizedFlight[]; rawCount?: number } | { ok: false; status: number | null; error: string };

export function fixtureAdapter(answer: (w: Window, call: number) => FixtureAnswer, over: Partial<SourceInfo> = {}, windowHours = 12): SourceAdapter {
  let calls = 0;
  const info: SourceInfo = {
    id: 'fixture', name: 'Fixture source (tests)', kind: 'fixture', airports: ['*'], baseUrl: 'fixture://', termsUrl: null,
    termsSummary: 'Synthetic test data; never stored outside tests.', permission: 'test-only', retention: 'tests only', costNote: 'none',
    capabilities: { fields: { terminal: true, gate: true, stand: false, estimatedTime: true, actualTime: true, status: true, codeshares: true, operatingFlag: true }, maxWindowHours: windowHours, pastDays: 1, futureDays: 1, requiresKey: false },
    ...over,
  };
  return {
    info,
    notReady: () => null,
    windows: (a, direction, date) => dayWindows(a, direction, date, windowHours),
    async fetchWindow(_a: AirportInfo, w: Window, _ctx: FetchContext): Promise<WindowResult> {
      const r = answer(w, calls++);
      if (!r.ok) return { window: w, ok: false, httpStatus: r.status, pages: 1, rawCount: 0, records: [], issues: [], error: r.error, bytes: 0 };
      const inWin = r.records.filter((x) => x.direction === w.direction && x.scheduledUtc >= w.fromUtc && x.scheduledUtc < w.toUtc);
      return { window: w, ok: true, httpStatus: 200, pages: 1, rawCount: r.rawCount ?? inWin.length, records: inWin, issues: [], error: null, bytes: 100 };
    },
  };
}

/** Consecutive windows covering one local day (DST days are 23 or 25 hours long; windows follow the real instants). */
export function dayWindows(a: AirportInfo, direction: Direction, date: string, hours: number): Window[] {
  const start = zonedInstant(date, '00:00', a.tz).getTime(), end = zonedInstant(addDays(date, 1), '00:00', a.tz).getTime();
  const out: Window[] = [];
  for (let t = start, i = 0; t < end; t += hours * 36e5, i++) {
    const to = Math.min(t + hours * 36e5, end);
    out.push({ direction, localDate: date, fromUtc: new Date(t).toISOString(), toUtc: new Date(to).toISOString(), label: `${direction}:${date}#${i + 1}` });
  }
  return out;
}

/** Builds a normalised record with sensible defaults (tests). */
export function rec(p: Partial<NormalizedFlight> & { flightNumber: string; scheduledUtc: string }): NormalizedFlight {
  return {
    airport: 'CDG', direction: 'departure', carrier: p.flightNumber.slice(0, 2), operatingFlightNumber: null, role: 'unknown', codeshares: [],
    airlineName: null, origin: p.direction === 'arrival' ? 'JFK' : 'CDG', destination: p.direction === 'arrival' ? 'CDG' : 'JFK',
    estimatedUtc: null, actualUtc: null, terminal: null, gate: null, stand: null, baggageBelt: null, status: 'scheduled', statusRaw: null,
    aircraftType: null, sourceRecordId: null, ...p,
  };
}

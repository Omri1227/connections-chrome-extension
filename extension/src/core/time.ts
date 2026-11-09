// Local times → absolute instants with the connecting airport's IANA time zone (R-06, R-28, R-40). Uses only the
// built-in Intl API (no time-zone library): the offset of a zone at an instant comes from formatToParts.
import type { Leg } from './types.ts';

/** IANA zones of the supported connecting airports (same values as flightdata/src/airports.ts `tz`, checked by a test). */
export const HUB_TZ: Record<string, string> = {
  AMS: 'Europe/Amsterdam', CDG: 'Europe/Paris', FCO: 'Europe/Rome', FRA: 'Europe/Berlin', IST: 'Europe/Istanbul', LHR: 'Europe/London', MAD: 'Europe/Madrid', MUC: 'Europe/Berlin', ZRH: 'Europe/Zurich',
};

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Offset (minutes east of UTC) of a time zone at an instant. */
export function offsetMinutes(tz: string, utcMs: number): number {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmtCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** The instant (UTC ms) of a local date + "HH:MM" in a zone. A time inside a spring-forward gap resolves to the later offset. */
export function localToUtc(date: string, hm: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let t = naive - offsetMinutes(tz, naive) * 60000;
  t = naive - offsetMinutes(tz, t) * 60000;
  return t;
}

/** The device's local calendar date (YYYY-MM-DD), not the UTC date (R-40). */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Longest scheduled connection assessed as a connection (longer = a stopover). */
export const MAX_CONNECTION_MIN = 24 * 60;
/** Connections at least this long, or crossing local midnight, get the overnight caveat (R-34). */
export const LONG_CONNECTION_MIN = 6 * 60;

export interface ConnectionTiming {
  /** Scheduled minutes between landing and departure (absolute instants at the hub's zone); null when not computable. */
  minutes: number | null;
  status: 'ok' | 'missing-time' | 'missing-date' | 'negative' | 'too-long';
  /** Why the connection is not assessed (null when ok). */
  problem: string | null;
  /** The layover crosses local midnight or lasts ≥ LONG_CONNECTION_MIN. */
  overnight: boolean;
  /** The UTC offset changes during the layover (DST): the minutes already account for it. */
  clockChange: boolean;
  arrivalUtc: number | null;
  departureUtc: number | null;
}

/**
 * Validated scheduled connection at `airport` (R-04, R-06, R-28): both local dates and times are needed; minutes come
 * from absolute instants in the airport's zone; a negative connection or one longer than 24 h is not assessed.
 */
export function connectionTiming(inbound: Leg, outbound: Leg, airport: string): ConnectionTiming {
  const none = (status: ConnectionTiming['status'], problem: string): ConnectionTiming => ({ minutes: null, status, problem, overnight: false, clockChange: false, arrivalUtc: null, departureUtc: null });
  if (!inbound.arrTime || !outbound.depTime) return none('missing-time', 'The arrival or departure time was not read.');
  if (!inbound.arrDate || !outbound.depDate) {
    const which = !inbound.arrDate && !outbound.depDate ? 'the travel date' : !inbound.arrDate ? 'the arrival date' : 'the departure date';
    return none('missing-date', `Not assessed: ${which} was not read, so the connection time cannot be worked out. Add it with “Edit details”.`);
  }
  const tz = HUB_TZ[airport] ?? 'UTC';
  const a = localToUtc(inbound.arrDate, inbound.arrTime, tz), d = localToUtc(outbound.depDate, outbound.depTime, tz);
  const minutes = Math.round((d - a) / 60000);
  const base = { minutes, overnight: inbound.arrDate !== outbound.depDate || minutes >= LONG_CONNECTION_MIN, clockChange: offsetMinutes(tz, a) !== offsetMinutes(tz, d), arrivalUtc: a, departureUtc: d };
  if (minutes < 0) return { ...base, status: 'negative', problem: `Not assessed: the departure (${outbound.depDate} ${outbound.depTime}) is before the arrival (${inbound.arrDate} ${inbound.arrTime}). Check the dates.` };
  if (minutes > MAX_CONNECTION_MIN) return { ...base, status: 'too-long', problem: `Not assessed: ${Math.round(minutes / 60)} h between the flights is a stopover, not a connection (over 24 h).` };
  return { ...base, status: 'ok', problem: null };
}

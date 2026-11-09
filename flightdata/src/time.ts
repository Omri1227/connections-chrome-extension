// Time-zone helpers built on Intl (full ICU in Node). All instants are stored in UTC; local dates and wall-clock times
// are always computed for a named IANA zone, so daylight-saving transitions are handled by the zone database.

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts { date: string; hour: number; minute: number; second: number }

/** Wall-clock parts of an instant in a zone. */
export function localParts(instant: Date, tz: string): LocalParts {
  const p = Object.fromEntries(fmt(tz).formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(instant: Date, tz: string): string { return localParts(instant, tz).date; }

/** UTC offset of a zone at an instant, in minutes (e.g. +60 for Paris in winter). */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * The instant at which a zone's wall clock shows `date` `hh:mm`. In the spring gap (a time that does not exist) the
 * instant just after the gap is returned; in the autumn overlap (a time that occurs twice) the first occurrence.
 */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const naive = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  // Try both offsets around the naive instant; pick the earliest candidate whose wall clock matches.
  const offs = new Set([offsetMinutes(new Date(naive - 36e5 * 14), tz), offsetMinutes(new Date(naive), tz), offsetMinutes(new Date(naive + 36e5 * 14), tz)]);
  const hits = [...offs].map((o) => new Date(naive - o * 60000)).filter((d) => { const p = localParts(d, tz); return p.date === date && p.hour === h && p.minute === m; });
  if (hits.length) return hits.sort((a, b) => a.getTime() - b.getTime())[0];
  // Non-existent local time (spring forward): move forward to the first valid minute.
  for (let k = 1; k <= 180; k++) {
    const t = new Date(naive - Math.max(...offs) * 60000 + k * 60000);
    const p = localParts(t, tz);
    if (p.date === date && p.hour * 60 + p.minute >= h * 60 + m) return t;
  }
  throw new Error(`cannot resolve ${date} ${hhmm} in ${tz}`);
}

/** Adds whole days to a YYYY-MM-DD date (calendar arithmetic, zone-independent). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Parses a source timestamp into a UTC instant. Accepts ISO strings with an offset or "Z", and, when the source gives
 * local wall-clock time without an offset ("2026-10-30T07:05" or "2026-10-30 07:05"), interprets it in `tz`.
 * Returns null for empty or unparseable values — never a guess.
 */
export function parseSourceTime(v: unknown, tz: string): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim().replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
  return m ? zonedInstant(m[1], m[2], tz) : null;
}

/** Local date of the day before `instant` in a zone. */
export function yesterday(instant: Date, tz: string): string { return addDays(localDate(instant, tz), -1); }

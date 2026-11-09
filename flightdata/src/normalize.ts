// Source-independent normalisation and validation of flight records.
import crypto from 'node:crypto';
import { POST_MOVEMENT, type AirportInfo, type AssignmentStage, type FlightStatus, type NormalizedFlight, type ParseIssue } from './types.ts';

/**
 * "AF 0012", "af12", "AF012" → "AF12"; "U2 4801" → "U24801"; "KL1234A" keeps its suffix. Returns null when the value
 * does not look like an airline flight number (2-character IATA or 3-letter ICAO designator + 1–4 digits + optional letter).
 */
export function normFlightNumber(v: unknown): { number: string; carrier: string } | null {
  if (typeof v !== 'string') return null;
  const s = v.toUpperCase().replace(/[\s-]+/g, '');
  const m = /^([A-Z]{3}|[A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(s);
  if (!m) return null;
  // A 2-character designator must contain a letter ("12" is not a carrier); for ambiguous forms like "U24801", the
  // regex already prefers the 3-letter ICAO form only when it is all letters.
  if (!/[A-Z]/.test(m[1])) return null;
  return { number: `${m[1]}${Number(m[2])}${m[3]}`, carrier: m[1] };
}

const STATUS_WORDS: [RegExp, FlightStatus][] = [
  [/cancel|annul/i, 'cancelled'],
  [/divert|dérout/i, 'diverted'],
  [/gate\s*clos|closed|clôtur/i, 'gate-closed'],
  [/board|embarq/i, 'boarding'],
  [/arrived|on\s*block|gelandet.*park|at\s*gate|arrivé/i, 'arrived'],
  [/land|atterri|gelandet/i, 'landed'],
  [/approach|final|approche/i, 'approaching'],
  [/airborne|en\s*route|en\s*vol|in\s*air|enroute/i, 'airborne'],
  [/depart|took\s*off|off\s*block|décoll|parti|gestartet|abgeflogen/i, 'departed'],
  [/delay|retard|verspät/i, 'delayed'],
  [/sched|on\s*time|à\s*l'heure|planm|check.?in|expected|estimated|gate\s*open|go\s*to\s*gate/i, 'scheduled'],
];

/** Maps a source status word to the normalised vocabulary; unknown wording becomes 'unknown' (and is reported). */
export function normStatus(raw: unknown): FlightStatus {
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  for (const [re, s] of STATUS_WORDS) if (re.test(raw)) return s;
  return 'unknown';
}

/** Trims, upper-cases and drops placeholder values ("-", "TBA", "N/A") to null. */
export function normCode(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  if (!s || /^(-+|\?+|N\/?A|TBA|TBD|NONE|NULL|UNKNOWN)$/.test(s)) return null;
  return s;
}

/** Terminal labels to one form: "Terminal 2E" / "T2E" / "2E" → "2E"; "Terminal 1" → "1". Unrecognised forms are kept. */
export function normTerminal(v: unknown): string | null {
  const s = normCode(v);
  if (!s) return null;
  return s.replace(/^TERMINAL\s*/, '').replace(/^T(?=\d)/, '').replace(/\s+/g, '');
}

export function stageOf(f: Pick<NormalizedFlight, 'status' | 'actualUtc'>): AssignmentStage {
  if (f.status === 'cancelled') return 'cancelled';
  if (POST_MOVEMENT.includes(f.status) || f.actualUtc) return 'post-movement';
  if (f.status === 'unknown') return 'unknown';
  return 'pre-movement';
}

/** Hash of the fields whose change is meaningful (an identical state is deduplicated). */
export function contentHash(f: NormalizedFlight): string {
  const key = [f.status, f.statusRaw, f.terminal, f.gate, f.stand, f.baggageBelt, f.estimatedUtc, f.actualUtc, f.aircraftType, f.scheduledUtc, f.role, f.operatingFlightNumber].map((x) => x ?? '').join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
}

/**
 * Validates a normalised record against the airport metadata. Hard problems reject the record; soft ones (an unknown
 * terminal code, an odd gate format) keep it and are reported, because new terminals and gate names do appear.
 */
export function validate(f: NormalizedFlight, airport: AirportInfo): { ok: boolean; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  if (!f.flightNumber) issues.push({ kind: 'rejected-row', detail: 'no flight number' });
  if (!f.scheduledUtc || !Number.isFinite(Date.parse(f.scheduledUtc))) issues.push({ kind: 'rejected-row', detail: `no valid scheduled time (${f.flightNumber})` });
  if (f.direction === 'arrival' && f.destination && f.destination !== airport.iata && f.destination !== airport.icao)
    issues.push({ kind: 'rejected-row', detail: `arrival at ${airport.iata} lists destination ${f.destination} (${f.flightNumber})` });
  if (f.direction === 'departure' && f.origin && f.origin !== airport.iata && f.origin !== airport.icao)
    issues.push({ kind: 'rejected-row', detail: `departure from ${airport.iata} lists origin ${f.origin} (${f.flightNumber})` });
  const hard = issues.length > 0;
  if (f.terminal && airport.terminals.length && !airport.terminals.includes(f.terminal))
    issues.push({ kind: 'unexpected-value', detail: `terminal "${f.terminal}" not in the known list`, sample: { flight: f.flightNumber, terminal: f.terminal } });
  if (f.gate && airport.gatePattern && !new RegExp(airport.gatePattern).test(f.gate))
    issues.push({ kind: 'unexpected-value', detail: `gate "${f.gate}" has an unexpected format`, sample: { flight: f.flightNumber, gate: f.gate } });
  if (f.status === 'unknown' && f.statusRaw) issues.push({ kind: 'unexpected-value', detail: `unmapped status "${f.statusRaw}"` });
  return { ok: !hard, issues };
}

/**
 * Removes exact duplicate rows inside one response (same listed number and schedule) and links codeshare listings to
 * their operating flight when the source marks them. Listings without an operating link are left as they are: they
 * are never merged on a guess.
 */
export function dedupe(records: NormalizedFlight[]): { records: NormalizedFlight[]; duplicates: number } {
  const seen = new Map<string, NormalizedFlight>();
  let duplicates = 0;
  for (const r of records) {
    const k = `${r.direction}|${r.flightNumber}|${r.scheduledUtc}`;
    const prev = seen.get(k);
    if (prev) { duplicates++; if (score(r) > score(prev)) seen.set(k, r); } else seen.set(k, r);
  }
  return { records: [...seen.values()], duplicates };
}
const score = (r: NormalizedFlight) => [r.terminal, r.gate, r.stand, r.estimatedUtc, r.actualUtc].filter(Boolean).length;

/** The identity under which a record is stored: the operating flight when known, else the listed number. */
export function identityOf(r: NormalizedFlight): { key: string; identity: 'operating' | 'listed' } {
  if (r.role === 'operating') return { key: r.flightNumber, identity: 'operating' };
  if (r.role === 'marketing' && r.operatingFlightNumber) return { key: r.operatingFlightNumber, identity: 'operating' };
  return { key: r.flightNumber, identity: 'listed' };
}

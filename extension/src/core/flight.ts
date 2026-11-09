// Flight-number normalisation in the extension (R-26). Same rule as the flight-data server's `normFlightNumber`
// (flightdata/src/normalize.ts, which cannot be bundled: it imports node:crypto); a test checks they agree.
//   "AF 0012", "af12", "AF012" → "AF12"; "KL0461" → "KL461"; "LH2416A" keeps its suffix; "U2 4801" → "U24801".

/** Normalised flight number, or null when the value does not look like one (2-character IATA / 3-letter ICAO + 1–4 digits + optional letter). */
export function normFlight(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.toUpperCase().replace(/[\s-]+/g, '').replace(/^([A-Z]{3}|[A-Z0-9]{2})0+(?=\d)/, '$1');   // "LY08001" → "LY8001"
  const m = /^([A-Z]{3}|[A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(s);
  if (!m || !/[A-Z]/.test(m[1])) return null;
  return `${m[1]}${Number(m[2])}${m[3]}`;
}

/** Airline designator of a (normalised) flight number: "LY335" → "LY". */
export const airlineOf = (flight: string | null | undefined): string | null => (flight ? /^([A-Z]{3}|[A-Z0-9]{2})\d/.exec(flight)?.[1] ?? null : null);

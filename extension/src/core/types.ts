// Shared types of the connection-analysis extension. The core (extension/src/core) is plain TypeScript with no browser
// APIs, so it runs in the extension's service worker, in the popup and in tests alike.

/** Where a piece of information comes from. Every value shown to the traveller carries one. */
export type Provenance =
  | 'observed'    // read from the itinerary page, typed by the traveller, or published by the source for that very flight-day
  | 'predicted'   // statistically likely from earlier flight-days (never a confirmed assignment)
  | 'estimated'   // walking / waiting / riding / control allowances from the airport model and stated assumptions
  | 'unknown';    // not established

/** One flight as shown on the booking page (local times at each end). */
export interface Leg {
  flightNumber: string | null;   // "AF1621" (normalised, no space)
  altNumbers: string[];          // other numbers shown for the same leg (codeshare / operated-by)
  airline: string | null;        // marketing airline name as shown
  operatedBy: string | null;     // "Operated by KLM" when shown
  from: string;                  // IATA
  to: string;                    // IATA
  depDate: string | null;        // YYYY-MM-DD, local at `from`
  depTime: string | null;        // HH:MM, local at `from`
  arrDate: string | null;        // YYYY-MM-DD, local at `to`
  arrTime: string | null;        // HH:MM, local at `to`
}

export interface Journey {
  label: string;                 // "Outbound", "Return", "Journey 1"
  legs: Leg[];
  /** Airports the page lists as stops without leg details (results-list cards). */
  stopsOnly: string[];
  selfTransfer: boolean | null;  // true when the page says "self transfer" anywhere in this journey; null = not shown
  /** Per connection (k = between legs k and k+1): true when the page labels THAT change of plane as a self-transfer;
   *  null = not known (never false from page text: only the traveller can say "protected"). */
  selfTransferAt?: (boolean | null)[];
}

export interface Itinerary {
  site: 'skyscanner' | 'manual' | 'screenshot';   // 'screenshot': read from a pasted screenshot and confirmed by the traveller
  journeys: Journey[];
  /** What the parser could not read (shown to the traveller, who can fill it in). */
  missing: string[];
  warnings: string[];
}

/** One change of plane: arriving `inbound`, departing `outbound`, at `airport`. */
export interface ConnectionInput {
  airport: string;
  inbound: Leg;
  outbound: Leg;
  selfTransfer: boolean | null;
}

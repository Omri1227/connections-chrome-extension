// Shared types of the flight-data platform. A source adapter turns one source's responses into NormalizedFlight
// records; the collector stores them as observations of physical flight movements.

export type Direction = 'arrival' | 'departure';

/** Normalised operational status. The source's own wording is kept alongside in `statusRaw`. */
export type FlightStatus =
  | 'scheduled' | 'delayed' | 'boarding' | 'gate-closed' | 'departed' | 'airborne' | 'approaching' | 'landed' | 'arrived'
  | 'cancelled' | 'diverted' | 'unknown';

/** Statuses meaning the movement has happened, so an assignment reported now is the last reported one. */
export const POST_MOVEMENT: readonly FlightStatus[] = ['departed', 'airborne', 'landed', 'arrived'];

/**
 * How an assignment was reported. Sources report what is published; none of them can confirm the stand or gate the
 * aircraft really used, so 'independently-confirmed' is only ever derived later (two independent sources agreeing after
 * the movement), never set by an adapter.
 */
export type AssignmentStage = 'pre-movement' | 'post-movement' | 'cancelled' | 'unknown';

/** Whether the flight row is the operating flight, a marketing (codeshare) listing, or unknown. */
export type ListingRole = 'operating' | 'marketing' | 'unknown';

/** Fields a source can provide. Stored per source so "missing" is only counted for fields the source supports. */
export const FIELDS = ['terminal', 'gate', 'stand', 'estimatedTime', 'actualTime', 'status', 'aircraftType', 'codeshares', 'operatingFlag', 'baggageBelt', 'checkIn'] as const;
export type Field = (typeof FIELDS)[number];

export interface NormalizedFlight {
  airport: string;                // IATA of the airport being collected (CDG, …)
  direction: Direction;
  flightNumber: string;           // as listed, normalised: carrier code + number without spaces or leading zeros ("AF1234")
  carrier: string | null;         // carrier code of flightNumber
  operatingFlightNumber: string | null; // operating flight when the source says so (codeshare listings point to it)
  role: ListingRole;
  codeshares: string[];           // marketing numbers listed for this operating flight (normalised)
  airlineName: string | null;
  origin: string | null;          // IATA (or ICAO when only that is given); for arrivals the other airport
  destination: string | null;
  scheduledUtc: string;           // ISO instant; required — a record without a schedule is rejected
  estimatedUtc: string | null;
  actualUtc: string | null;
  terminal: string | null;
  gate: string | null;
  stand: string | null;
  baggageBelt: string | null;
  status: FlightStatus;
  statusRaw: string | null;
  aircraftType: string | null;
  sourceRecordId: string | null;  // the source's own id for the row, when it has one
  extra?: Record<string, unknown>; // other documented fields worth keeping (small)
}

/** One parse problem: a row that could not be normalised, with why. */
export interface ParseIssue { kind: 'rejected-row' | 'unexpected-field' | 'unexpected-value' | 'format-change'; detail: string; sample?: unknown }

/** A requested time window of a source (the unit of coverage). */
export interface Window { direction: Direction; localDate: string; fromUtc: string; toUtc: string; label: string }

export interface WindowResult {
  window: Window;
  ok: boolean;
  httpStatus: number | null;
  pages: number;                  // HTTP requests made for this window (retries included; 0 when served from cache)
  rawCount: number;               // rows in the response(s) before normalisation
  records: NormalizedFlight[];
  issues: ParseIssue[];
  error: string | null;
  bytes: number;
  rawSample?: unknown;            // small excerpt kept for diagnostics (no personal data in flight boards)
}

export interface SourceCapabilities {
  fields: Partial<Record<Field, boolean>>;
  maxWindowHours: number;         // longest window per request
  pastDays: number;               // how many days back the source serves (0 = only today/future)
  futureDays: number;
  requiresKey: boolean;
}

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'official-api' | 'aggregator-api' | 'website-json' | 'fixture';
  airports: string[];
  baseUrl: string;
  termsUrl: string | null;
  termsSummary: string;
  permission: 'approved' | 'pending-owner-approval' | 'test-only' | 'rejected';
  retention: string;              // what the terms allow us to keep
  /** Licence limit on keeping raw records, in days (null = no limit). Enforced by retention.ts. */
  rawRetentionDays?: number | null;
  costNote: string;
  capabilities: SourceCapabilities;
  /**
   * Paid quota guard: the scheduler stops calling the source once the HTTP requests of the last `periodDays`
   * (fd_collection_runs.pages_fetched) × unitsPerRequest reach the budget (env `envVar`, else defaultUnits).
   */
  unitBudget?: { unitsPerRequest: number; periodDays: number; envVar: string; defaultUnits: number };
}

export interface FetchContext {
  fetch: typeof fetch;
  now: () => Date;
  env: Record<string, string | undefined>;
  log: (event: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

/** The interface every airport/source connector implements. */
export interface SourceAdapter {
  info: SourceInfo;
  /** Missing configuration (e.g. an API key) as a human-readable reason, or null when ready. */
  notReady(env: Record<string, string | undefined>): string | null;
  /** The windows needed to cover one local day in one direction. */
  windows(airport: AirportInfo, direction: Direction, localDate: string): Window[];
  /** Fetches and parses one window. Must not throw for HTTP or parse errors: they are reported in the result. */
  fetchWindow(airport: AirportInfo, window: Window, ctx: FetchContext): Promise<WindowResult>;
}

export interface AirportInfo {
  iata: string;
  icao: string;
  name: string;
  tz: string;
  country: string;
  /** Terminal codes we expect (anything else is reported as an unexpected code, not dropped). */
  terminals: string[];
  /** Optional regular expression a gate must match; non-matching gates are kept and reported. */
  gatePattern?: string;
  /** Local collection times (HH:MM). */
  schedule: string[];
  /**
   * Gate designations known to be shared by several simultaneous departures (bus gates split into sub-gates), with
   * the evidence. Used only to classify same-time gate conflicts; nothing is changed in the data.
   */
  sharedGates?: Record<string, string>;
}

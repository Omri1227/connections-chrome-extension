// Transfer-time model (R-31, R-32): how uncertain time components combine into the time a connection needs, plus the
// sourced allowance tables the combination is fed with. Pure module: no browser APIs, no UI imports.
// Method and evidence: docs/research/TRANSFER_TIME_MODEL.md.
//
// Semantics of a component span {min, typical, max}:
//   min     = the fastest realistic value (lower bound, the shift of the distribution);
//   typical = the median (half of passengers are faster);
//   max     = a conservative planning value, read as the 90th percentile (MAX_QUANTILE), NOT an absolute worst case.
// Each component is modelled as a shifted lognormal through those three points (right-skewed: queues and waits have long
// upper tails). Components are grouped:
//   - parts in the same `correlated` group move together (comonotonic): their quantiles add exactly. Used for the walks of
//     one passenger (one walking pace, one amount of luggage) and for the queues at one airport at one hour (a common
//     peak / staffing factor);
//   - different groups are treated as independent and convolved numerically on an equiprobable quantile grid (exact up
//     to the grid resolution; no normality assumption, so the right skew is kept).
// This replaces `add()` in assess.ts (typical + RSS of every (max - typical), which assumes every step independent and
// lets the pessimistic value fall when a corridor is split into more steps) and avoids the opposite error, the sum of
// every maximum (all extremes at once).

export type Basis = 'published' | 'measured' | 'observed' | 'derived' | 'assumed';
export interface Span { min: number; typical: number; max: number; basis?: Basis; note?: string }

/** One component of a transfer. `group` names what it is (for the explanation); `correlated` names its dependence group. */
export interface Part { minutes: Span; group: string; correlated?: string; label?: string }

export interface Combined {
  min: number;          // sum of minima
  typical: number;      // sum of medians (the "usual" time; what a passenger with typical luck needs)
  high: number;         // MAX_QUANTILE of the sum under the dependence model (the conservative planning value)
  median: number;       // median of the sum (a few minutes above Σ typical when the parts are right-skewed)
  mean: number;         // mean of the sum
  basis: Basis;         // weakest evidence class that carries at least 10 % of the spread (see weakestBasis)
  basisMix: Record<Basis, number>;   // share of the spread (high - typical) contributed by each evidence class
  groups: { key: string; typical: number; high: number }[];
  method: 'comonotonic-groups+quantile-convolution';
}

/** Quantile that `max` stands for. */
export const MAX_QUANTILE = 0.9;
const Z = 1.2815515655446004;   // standard-normal quantile of MAX_QUANTILE

/** Default dependence groups (docs/research/TRANSFER_TIME_MODEL.md §4). */
export const CORRELATION = {
  walk: 'walk',          // every walk of one passenger: one pace, one luggage load
  queue: 'queue',        // passport / security / transfer-security queues at one airport and hour: one peak factor
} as const;

const BASIS_RANK: Basis[] = ['assumed', 'derived', 'observed', 'measured', 'published'];

interface LN { shift: number; mu: number; sigma: number }   // X = shift + exp(N(mu, sigma²)); sigma 0 = deterministic

/** Shifted lognormal through min (shift), typical (median) and max (MAX_QUANTILE). Degenerate inputs stay finite. */
export function fitLognormal(s: Span): LN {
  const lo = Math.min(s.min, s.typical, s.max), hi = Math.max(s.min, s.typical, s.max);
  if (hi - lo < 1e-9) return { shift: lo, mu: -Infinity, sigma: 0 };
  // typical == min would put the median on the shift (a point mass): keep a small positive median offset instead
  const med = Math.max(s.typical - lo, 0.02 * (hi - lo), 1e-3);
  const top = Math.max(hi - lo, med * 1.0001);
  return { shift: lo, mu: Math.log(med), sigma: Math.max(Math.log(top / med) / Z, 0) };
}
const lnQ = (d: LN, z: number) => (d.mu === -Infinity ? d.shift : d.shift + Math.exp(d.mu + z * d.sigma));

/** Points of the quantile grid (equiprobable mid-points). 100 keeps the 90th percentile within ~1.5 % (about 1 min) of a 20 000-draw
 *  Monte Carlo on the test routes while costing well under a millisecond per combination. */
export const GRID = 100;
const U = Array.from({ length: GRID }, (_, k) => (k + 0.5) / GRID);
const Zs = U.map(invNorm);

/**
 * Combine the parts of one connection into {min, typical, high}. Pure and deterministic.
 * 1. Parts sharing a `correlated` key are comonotonic: the group's quantile function is the sum of the parts' quantile
 *    functions (exact for comonotonic variables).
 * 2. Independent groups are convolved numerically on an equiprobable quantile grid (GRID points per group; each merge
 *    forms all GRID² sums, sorts them and keeps the GRID equiprobable mid-point quantiles).
 * 3. `high` = the MAX_QUANTILE quantile of the sum; `median` its median; `typical` = Σ part typicals (legacy meaning).
 * Drop-in for assess.ts: see docs/research/TRANSFER_TIME_MODEL.md §7.
 */
export function combine(parts: Part[]): Combined {
  const groups = new Map<string, Part[]>();
  parts.forEach((p, i) => {
    const k = p.correlated ? `c:${p.correlated}` : `i:${i}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  });
  let min = 0, typical = 0;
  const out: Combined['groups'] = [];
  let dist: number[] | null = null;
  for (const [key, ps] of groups) {
    const fits = ps.map((p) => fitLognormal(p.minutes));
    const q = Zs.map((z) => fits.reduce((s, d) => s + lnQ(d, z), 0));
    min += fits.reduce((s, d) => s + d.shift, 0);
    typical += ps.reduce((s, p) => s + p.minutes.typical, 0);
    out.push({ key, typical: round1(ps.reduce((s, p) => s + p.minutes.typical, 0)), high: round1(fits.reduce((s, d) => s + lnQ(d, Z), 0)) });
    dist = dist ? convolve(dist, q) : q;
  }
  const sorted = dist ?? [0];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const high = Math.max(quantile(sorted, MAX_QUANTILE), typical, min);
  const median = Math.max(quantile(sorted, 0.5), min);
  const basisMix = { published: 0, measured: 0, observed: 0, derived: 0, assumed: 0 } as Record<Basis, number>;
  const spread = parts.reduce((s, p) => s + Math.max(p.minutes.max - p.minutes.typical, 0), 0);
  for (const p of parts) basisMix[p.minutes.basis ?? 'assumed'] += spread > 0 ? Math.max(p.minutes.max - p.minutes.typical, 0) / spread : 1 / parts.length;
  return { min: round1(min), typical: round1(typical), median: round1(median), high: round1(high), mean: round1(mean), basis: weakestBasis(basisMix), basisMix, groups: out, method: 'comonotonic-groups+quantile-convolution' };
}

/** Sum of two independent variables given as equiprobable sorted samples; returns its GRID equiprobable mid-point quantiles. */
function convolve(a: number[], b: number[]): number[] {
  const all = new Float64Array(a.length * b.length);
  let k = 0;
  for (const x of a) for (const y of b) all[k++] = x + y;
  all.sort();
  const per = all.length / GRID, out: number[] = [];
  for (let i = 0; i < GRID; i++) out.push(all[Math.min(all.length - 1, Math.floor((i + 0.5) * per))]);
  return out;
}
/** Quantile of an equiprobable sorted sample (linear between mid-points). */
function quantile(xs: number[], p: number): number {
  const pos = p * xs.length - 0.5;
  if (pos <= 0) return xs[0];
  if (pos >= xs.length - 1) return xs[xs.length - 1];
  const i = Math.floor(pos), f = pos - i;
  return xs[i] * (1 - f) + xs[i + 1] * f;
}
/** Inverse standard-normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
function invNorm(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628274631];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Weakest evidence class carrying ≥ 10 % of the spread (a 1-min assumed allowance does not downgrade a measured route). */
export function weakestBasis(mix: Record<Basis, number>): Basis {
  for (const b of BASIS_RANK) if (mix[b] >= 0.1) return b;
  return BASIS_RANK.slice().reverse().find((b) => mix[b] > 0) ?? 'assumed';
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Reference combinations, for comparison and tests only (docs/research/TRANSFER_TIME_MODEL.md §5). */
export const reference = {
  /** The shipped `add()`: typical + RSS of every (max - typical) — assumes every part independent and normal. */
  rssAll: (xs: Span[]) => {
    const t = xs.reduce((s, x) => s + x.typical, 0);
    return { typical: t, high: t + Math.sqrt(xs.reduce((s, x) => s + (x.max - x.typical) ** 2, 0)) };
  },
  /** Every part at its max at once (fully comonotonic). An upper bound on any dependence structure's q90 only when all
   *  parts are comonotonic; for independent parts it overstates the q90 of the sum. */
  sumOfMax: (xs: Span[]) => ({ typical: xs.reduce((s, x) => s + x.typical, 0), high: xs.reduce((s, x) => s + x.max, 0) }),
};

/** Seeded Monte Carlo of the same model (validation and research only; not used at run time). */
export function monteCarlo(parts: Part[], n = 20000, seed = 1): { typical: number; high: number; mean: number } {
  let st = seed >>> 0;
  const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const keys = parts.map((p, i) => (p.correlated ? `c:${p.correlated}` : `i:${i}`));
  const fits = parts.map((p) => fitLognormal(p.minutes));
  const sums: number[] = [];
  for (let k = 0; k < n; k++) {
    const z = new Map<string, number>();
    let s = 0;
    fits.forEach((d, i) => { if (!z.has(keys[i])) z.set(keys[i], gauss()); s += lnQ(d, z.get(keys[i])!); });
    sums.push(s);
  }
  sums.sort((a, b) => a - b);
  return { typical: round1(sums[Math.floor(n / 2)]), high: round1(sums[Math.floor(n * MAX_QUANTILE)]), mean: round1(sums.reduce((a, b) => a + b, 0) / n) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Allowance tables (R-32). Every value carries its source and class; `assumed` values are generic planning defaults with
// no specific evidence and are flagged as such. Airline and airport tables are filled only where a source was read.
// ---------------------------------------------------------------------------------------------------------------------

export interface Allowance extends Span { basis: Basis; text: string; sources: string[] }

/** Generic defaults (the values assess.ts used before R-32), kept as flagged assumptions. */
export const GENERIC: Record<'deplaneContact' | 'deplaneBus' | 'gateClose' | 'baggage' | 'checkInClose' | 'bagDrop', Allowance> = {
  // calibrated 2026-11-02 (TRANSFER_TIME_CALIBRATION.md §6): door opening + aisle flow at a random seat. Aircraft type
  // unknown → the wide-body P90 (18) is kept; narrow-body alone would give 8 / 14.
  deplaneContact: { min: 4, typical: 8, max: 18, basis: 'derived', text: 'Leaving the aircraft at a contact stand (door opening plus walking out from your row; longer from the back rows of a wide-body)', sources: ['Airbus Aircraft Characteristics (A320 20 pax/min per door, A330/A350 25 pax/min per door, door +2–3 min)', 'ADR Carta dei Servizi FCO 2026 and SEA MXP 2026: first passenger off within about 6 min of block-on in 90 % of flights', 'docs/research/calibration/TIMING_EVIDENCE_REVIEW.md D5'] },
  deplaneBus: { min: 10, typical: 17, max: 30, basis: 'assumed', text: 'Leaving the aircraft at a remote stand: steps, waiting for the apron bus to fill, the ride and unloading', sources: [] },
  gateClose: { min: 15, typical: 20, max: 30, basis: 'assumed', text: 'Boarding gate closes before departure (airline-specific, often 15–30 min)', sources: [] },
  baggage: { min: 15, typical: 25, max: 45, basis: 'assumed', text: 'Waiting for checked bags (self-transfer)', sources: [] },
  checkInClose: { min: 40, typical: 60, max: 75, basis: 'assumed', text: 'Check-in / bag drop closes before departure (self-transfer, airline-specific)', sources: [] },
  bagDrop: { min: 2, typical: 8, max: 25, basis: 'assumed', text: 'Queue and drop of a checked bag at the departure hall (self-transfer)', sources: [] },
};

/** Published boarding-gate close (minutes before departure), read 2026-11-01. A gate close is a rule, not a random
 *  quantity: min = typical = max = the published value. Airlines not listed → GENERIC.gateClose (assumed). */
export const GATE_CLOSE: Record<string, Allowance> = {
  AF: { min: 20, typical: 20, max: 20, basis: 'published', text: 'Air France: boarding closes 20 min before departure (15 min only Orly – metropolitan France)', sources: ['https://wwws.airfrance.fr/en/information/aeroport/quand-arriver/fin-embarquement (captured 2026-10-27, docs/SOURCES.md af-deadlines)'] },
  KL: { min: 15, typical: 15, max: 15, basis: 'published', text: 'KLM: the gate closes about 15 min before departure (search excerpt of klm.com; page not fetched)', sources: ['https://www.klm.com/information/airport/check-in-times'] },
  LX: { min: 15, typical: 15, max: 15, basis: 'published', text: 'SWISS: the gate closes 15 min before departure (SWISS Media Guide 2025, search excerpt)', sources: ['https://www.swiss.com/content/dam/swiss-magazine/pdf/media-guide-2023/media-guide-2025.pdf'] },
  AZ: { min: 15, typical: 15, max: 15, basis: 'published', text: 'ITA Airways: the gate closes 15 min before departure, "may vary at some airports" (search excerpt)', sources: ['https://www.ita-airways.com/it/it/book-and-prepare/travel-information/check-in-information/check-in-deadlines'] },
  TK: { min: 20, typical: 20, max: 20, basis: 'published', text: 'Turkish Airlines: gates close no later than 20 min before departure (search excerpt of the TK FAQ)', sources: ['https://www.turkishairlines.com/en-us/any-questions/check-in/'] },
  BA: { min: 20, typical: 20, max: 20, basis: 'published', text: 'British Airways: be at the boarding gate at least 20 min before departure, after which boarding may close (Heathrow quoting BA, 22 Sep 2026)', sources: ['https://www.heathrow.com/heathrow-blog/top-tips-for-timing-your-airport-journey'] },
  LY: { min: 10, typical: 10, max: 10, basis: 'published', text: 'El Al: gates close no later than 10 min before departure, but the El Al security process must be finished much earlier (docs/research/SPECIAL_SCREENING_ISRAEL_US.md); 2018 conditions PDF', sources: ['https://book.elal.com/newBooking/pdfTicketLinks/ENGLISH.pdf'] },
};

/** Published check-in / bag-drop close (minutes before departure) by airline and flight type, read 2026-11-01. */
export const CHECKIN_CLOSE: Record<string, { short: Allowance; long: Allowance }> = {
  AF: {
    short: { min: 40, typical: 40, max: 40, basis: 'published', text: 'Air France at CDG: 40 min for France, Schengen, UK and Ireland', sources: ['https://wwws.airfrance.fr/en/information/aeroport/quand-arriver/fin-enregistrement (captured 2026-10-27)'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'Air France at CDG: 60 min for other destinations (90 min for Israel and most of Africa)', sources: ['https://wwws.airfrance.fr/en/information/aeroport/quand-arriver/fin-enregistrement (captured 2026-10-27)'] },
  },
  KL: {
    short: { min: 40, typical: 40, max: 40, basis: 'published', text: 'KLM: desks and bag drop close 40 min before European flights (search excerpt)', sources: ['https://www.klm.com/information/airport/check-in-times'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'KLM: 60 min before intercontinental flights (search excerpt)', sources: ['https://www.klm.com/information/airport/check-in-times'] },
  },
  LH: {
    short: { min: 45, typical: 45, max: 45, basis: 'published', text: 'Lufthansa: 45 min unless otherwise stated (Conditions of Carriage, search excerpt)', sources: ['https://www.lufthansa.com/content/dam/lh/documents/common/terms-and-conditions/terms-of-service/lufthansa-abb-03-2025-en.pdf'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'Lufthansa intercontinental from FRA/MUC: 60 min Economy / Premium Economy (40 min First / Business), since 19 Jul 2017', sources: ['https://irreg.lufthansaexperts.com/en/archiv-detail/increase-in-check-in-deadlines-for-lufthansa-intercontinental-flights.html'] },
  },
  AZ: {
    short: { min: 40, typical: 40, max: 40, basis: 'published', text: 'ITA Airways: 40 min domestic and Schengen (search excerpt)', sources: ['https://www.ita-airways.com/it/it/book-and-prepare/travel-information/check-in-information/check-in-deadlines'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'ITA Airways: 60 min long-haul and non-Schengen (search excerpt)', sources: ['https://www.ita-airways.com/it/it/book-and-prepare/travel-information/check-in-information/check-in-deadlines'] },
  },
  TK: {
    short: { min: 45, typical: 45, max: 45, basis: 'published', text: 'Turkish Airlines: counters close 45 min before domestic flights (search excerpt)', sources: ['https://www.turkishairlines.com/en-us/any-questions/check-in/'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'Turkish Airlines: 60 min before international flights; some stations differ (search excerpt)', sources: ['https://www.turkishairlines.com/en-us/any-questions/check-in/'] },
  },
  BA: {
    short: { min: 45, typical: 45, max: 45, basis: 'published', text: 'British Airways: check-in and bag drop close 45 min before UK domestic and short-haul flights (Business Traveller relaying BA, search excerpt; ba.com served a holding page)', sources: ['https://www.businesstraveller.com/news/ba-brings-in-standardised-check-inbag-drop-times/'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'British Airways: check-in and bag drop close 60 min before long-haul flights (Business Traveller relaying BA, search excerpt)', sources: ['https://www.businesstraveller.com/news/ba-brings-in-standardised-check-inbag-drop-times/'] },
  },
  VS: {
    short: { min: 60, typical: 60, max: 60, basis: 'published', text: 'Virgin Atlantic at Heathrow: check-in closes one hour before departure (Virgin Atlantic Heathrow guide)', sources: ['https://www.virginatlantic.com/where-we-fly/europe/uk/london/london-heathrow-airport-guide'] },
    long: { min: 60, typical: 60, max: 60, basis: 'published', text: 'Virgin Atlantic at Heathrow: check-in closes one hour before departure (Virgin Atlantic Heathrow guide)', sources: ['https://www.virginatlantic.com/where-we-fly/europe/uk/london/london-heathrow-airport-guide'] },
  },
  LY: {
    short: { min: 180, typical: 180, max: 180, basis: 'published', text: 'El Al: check-in (after the El Al security interview) must be complete 3 h before departure in Economy, 2 h in First/Business (2018 PDF; ZRH station page: Economy 3 h, Business 1.5 h)', sources: ['https://book.elal.com/newBooking/pdfTicketLinks/ENGLISH.pdf', 'https://www.elal.com/en/Switzerland/Pages/ZRH-Airport-Information.aspx'] },
    long: { min: 180, typical: 180, max: 180, basis: 'published', text: 'El Al: as above (every El Al flight goes to or from Israel)', sources: ['https://book.elal.com/newBooking/pdfTicketLinks/ENGLISH.pdf'] },
  },
};
/** Not found (owner capture): Virgin Atlantic gate close, El Al at Heathrow, Iberia deadlines (iberia.com blocked), Lufthansa gate close, SWISS counter deadlines. */

/** Taxi-in (landing → in-block), EUROCONTROL CODA summer 2024 (measured, airline-reported ALDT → AIBT). NOT added to a
 *  connection: the scheduled arrival is an in-block (gate) time by industry convention, so taxi-in is inside the schedule;
 *  a long taxi-in matters only as part of arrival delay, which the tool does not model. Reference values only. */
export const TAXI_IN: Record<string, { mean: number; p10: number; median: number; p90: number }> = {
  IST: { mean: 15.6, p10: 9, median: 14, p90: 24 }, MAD: { mean: 10.1, p10: 5, median: 10, p90: 15 },
  CDG: { mean: 9.9, p10: 6, median: 9, p90: 14 }, FCO: { mean: 9.8, p10: 6, median: 9, p90: 14 },
  FRA: { mean: 9.4, p10: 5, median: 9, p90: 14 }, AMS: { mean: 8.7, p10: 3, median: 8, p90: 15 },
  MUC: { mean: 6.0, p10: 4, median: 6, p90: 9 }, ZRH: { mean: 5.5, p10: 3, median: 5, p90: 8 },
};
export const TAXI_IN_SOURCE = 'https://www.eurocontrol.int/sites/default/files/2024-12/eurocontrol-taxi-in-times-summer-2024.xlsx';

/** Dependence group of a route step (CORRELATION). Waits for different lines, rides and the deplaning are independent;
 *  customs and boarding-pass scans are short and not queue-dominated, so they stay independent too. */
export function correlationOf(stepKind: string, control?: string): string | undefined {
  if (stepKind === 'walk' || stepKind === 'access' || stepKind === 'egress' || stepKind === 'intra-walk') return CORRELATION.walk;
  if (stepKind === 'control' || control) return control === 'customs' || control === 'boarding-pass' ? undefined : CORRELATION.queue;
  return undefined;
}

/** Gate close for an airline (IATA code), falling back to the flagged generic assumption. */
export const gateCloseFor = (airline?: string | null): Allowance => (airline && GATE_CLOSE[airline.toUpperCase()]) || GENERIC.gateClose;

/** Check-in close for an airline and flight type (long = intercontinental / non-Schengen long-haul). */
/** Airline deadlines that hold only at one airport ("IB@MAD"): used before the airline-wide table. */
export const CHECKIN_CLOSE_AT: Record<string, { short: Allowance; long: Allowance }> = {
  'IB@MAD': {
    short: { min: 45, typical: 45, max: 45, basis: 'published', text: 'Iberia at Madrid T4: check-in closes 45 min before short- and medium-haul flights', sources: ['https://www.iberia.com/il/time-limit/ (owner capture 2026-11-02; iberia.com blocks automated access)'] },
    long: { min: 55, typical: 55, max: 55, basis: 'published', text: 'Iberia at Madrid T4 Satellite: check-in closes 55 min before the international flights departing there (including Tel Aviv)', sources: ['https://www.iberia.com/il/time-limit/ (owner capture 2026-11-02; iberia.com blocks automated access)'] },
  },
};

/** Airline deadlines for being THROUGH security ("AIRLINE@AIRPORT"), a presence deadline at the end of the last screening
 *  step of the route: it applies in addition to the gate close (the later of the two decides). */
export const SECURITY_DEADLINE_AT: Record<string, Allowance> = {
  'BA@LHR': { min: 35, typical: 35, max: 35, basis: 'published', text: 'British Airways at Heathrow: clear Flight Connections and security at least 35 min before departure (BA connection guidance, search excerpt; ba.com served a holding page)', sources: ['https://www.britishairways.com/content/information/airport-information/flight-connections (search excerpt)'] },
};
export const securityDeadlineFor = (airline: string | null | undefined, airport: string): Allowance | null => (airline && SECURITY_DEADLINE_AT[`${airline.toUpperCase()}@${airport.toUpperCase()}`]) || null;

export function checkInCloseFor(airline: string | null | undefined, long: boolean, destinationCountry?: string, airport?: string): Allowance {
  const code = airline?.toUpperCase();
  const at = code && airport ? CHECKIN_CLOSE_AT[`${code}@${airport.toUpperCase()}`] : undefined;
  if (at) return long || destinationCountry === 'IL' ? at.long : at.short;
  const a = code ? CHECKIN_CLOSE[code] : undefined;
  if (code === 'AF' && destinationCountry === 'IL') return { ...a!.long, min: 90, typical: 90, max: 90, text: 'Air France at CDG: check-in closes 90 min before flights to Israel' };
  return a ? (long ? a.long : a.short) : GENERIC.checkInClose;
}

// ---------------------------------------------------------------------------------------------------------------------
// Special screenings without published minutes (verdict policy 2026-11-02, Example C). Every such entry of the airport
// models is classified here, so that no REQUIRED procedure silently counts as 0 min:
//   bound       required, duration not published: a conservative allowance justified by the cited evidence is added;
//   deadline    required, duration not published, no deadline at this station: a presence deadline derived from the
//               airline's own published deadlines elsewhere replaces boarding close (when later);
//   in-route    the procedure is already a timed step of the modelled route (no extra minutes);
//   has-deadline the model carries a published presence deadline that covers the procedure;
//   possible    whether any extra procedure exists is NOT established: a warning, no minutes (none can be defended);
//   informational  a document check done at check-in at origin, or another note that costs no transfer time.
// A required screening that is NOT listed here makes the area pair "not assessed" (time not established): see assess.ts.
// ---------------------------------------------------------------------------------------------------------------------

export type ScreeningPolicy =
  | { kind: 'bound'; minutes: Allowance }
  | { kind: 'deadline'; deadline: Allowance }
  | { kind: 'in-route' | 'has-deadline' | 'possible' | 'informational'; why: string };

export const SCREENING_POLICY: Record<string, ScreeningPolicy> = {
  'ss:fco-us-israel-t1': { kind: 'bound', minutes: { min: 1, typical: 3, max: 6, basis: 'derived', text: 'Separate traditional X-ray flow for USA / Israel flights of T1 airlines at Fiumicino: ADR reports the 90th percentile of the queue at this flow as 3 min 29 s in 2025 (Carta dei Servizi 2026); about 1–2 min are added for the screening itself (liquids and electronics out, assumed). Counted on top of any transfer security (conservative: ADR describes it as the screening flow of these flights).', sources: ['https://www.adr.it/documents/d/guest/adr_rel_cartaservizi_fco_2026_05_08-pdf (ADR Carta dei Servizi Fiumicino 2026; time-parameters.json ADR-CDS-2026)', 'airportmaps/data/fco/airport.json ss:fco-us-israel-t1'] } },
  'ss:mad-elal-t4s': { kind: 'deadline', deadline: { min: 50, typical: 85, max: 120, basis: 'derived', text: 'El Al at Madrid: its security questioning is reported but no deadline or duration is published for Madrid. Bounded by El Al\'s own published presence deadlines at other European stations: 50 min before departure at CDG (2023 notice) to 120 min at Zurich ("gate security finished 2 h before departure"); typical = their mid-point. A bound, not a Madrid figure.', sources: ['airportmaps/data/cdg/airport.json ss:cdg-elal-2b', 'airportmaps/data/zrh/airport.json ss:zrh-elal', 'docs/research/SPECIAL_SCREENING_ISRAEL_US.md'] } },
  'ss:muc-israel-hall-f': { kind: 'in-route', why: 'Hall F is reached through the public area and its own security checkpoint, which is a timed step of the route (assumed 10/25/60 min).' },
  'ss:lhr-elal-t4': { kind: 'deadline', deadline: { min: 50, typical: 85, max: 120, basis: 'derived', text: 'El Al at Heathrow T4: its own security questioning is reported (Business Traveller, Heathrow), but no deadline or duration is published for London (elal.com blocked). Bounded, as at Madrid, by El Al’s own published presence deadlines at other European stations: 50 min at CDG to 120 min at Zurich; typical = their mid-point. A bound, not a Heathrow figure.', sources: ['airportmaps/data/cdg/airport.json ss:cdg-elal-2b', 'airportmaps/data/zrh/airport.json ss:zrh-elal', 'airportmaps/data/lhr/airport.json ss:lhr-elal-t4'] } },
  'ss:cdg-elal-2b': { kind: 'has-deadline', why: 'Gate presence deadline 50 min (2023 notice relay).' },
  'ss:zrh-elal': { kind: 'has-deadline', why: 'Gate security finished 2 h before departure (El Al Switzerland, excerpt).' },
  'ss:mad-iberia-tlv': { kind: 'has-deadline', why: 'At the gate 90 min before departure (Iberia time-limit page).' },
  'ss:fra-israel-c': { kind: 'possible', why: 'Tel Aviv flights board in concourse C; no source says whether an extra screening takes place there.' },
  'ss:fra-us-documents': { kind: 'informational', why: 'US entry-data verification at check-in / bag drop, i.e. at the origin for a through-checked passenger.' },
  'ss:zrh-lx-us-documents': { kind: 'informational', why: 'Document check at the SWISS check-in desk (self-transfer: use a staffed desk); for through-checked passengers not established.' },
};

/** Policy of a special screening without minutes; unlisted entries: 'possible' when their certainty is unknown, else
 *  null (= required but not bounded → the pair is not assessed). */
export function screeningPolicy(s: { id: string; certainty: string; minutes?: unknown; deadline?: unknown }): ScreeningPolicy | null {
  if (s.minutes) return { kind: 'in-route', why: 'published minutes' };
  if (SCREENING_POLICY[s.id]) return SCREENING_POLICY[s.id];
  if (s.deadline) return { kind: 'has-deadline', why: 'published presence deadline' };
  return s.certainty === 'unknown' ? { kind: 'possible', why: 'whether an extra procedure exists is not established' } : null;
}

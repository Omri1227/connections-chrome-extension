// AeroDataBox 1–20 airport cost model (research only: makes no API request, changes nothing in the platform).
//
//   npx tsx flightdata/scripts/cost-model.ts            print the tables
//   npx tsx flightdata/scripts/cost-model.ts --write    also write the CSV and the generated tables into
//                                                        docs/FLIGHT_DATA_1_TO_20_AIRPORT_COST_MODEL.md
//   npx tsx flightdata/scripts/cost-model.ts --check    exit 1 if the doc or CSV differ from a fresh run
//   --params '{"windowHours":24,"retryRate":0.1}'       override any key of PARAMS (JSON)
//
// API-call counts are not estimated: they are counted by replaying the platform's own slot plan (DEFAULT_SLOTS,
// scheduler.ts) and window splitter (dayWindows, the one the AeroDataBox adapter uses) over real calendar days,
// so DST days are handled exactly as the collector would. Prices and limits: docs/AERODATABOX_PRICING_RESEARCH.md.
// [V] = read on a primary source 2026-10-30/31; [A] = assumption; [M] = measured in the FCO proof of concept.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SLOTS, type SlotSpec } from '../src/scheduler.ts';
import { dayWindows } from '../src/adapters/fixture.ts';
import { addDays } from '../src/time.ts';
import type { AirportInfo } from '../src/types.ts';

// ---------- Plans [V] https://aerodatabox.com/pricing/ (fetched 2026-10-31) ----------
type Caching = 'standard-7d' | 'extended-while-subscribed' | 'extended-plus-1y';
interface Plan { id: string; channel: 'API.Market' | 'RapidAPI' | 'Direct'; usd: number; units: number; maxWindowH: number; caching: Caching; commercial: boolean; overagePerUnit: number | null; rps: number }
export const PLANS: Plan[] = [
  { id: 'Basic (API.Market, 7-day trial)', channel: 'API.Market', usd: 0, units: 400, maxWindowH: 12, caching: 'standard-7d', commercial: false, overagePerUnit: null, rps: 1 },
  { id: 'Basic (RapidAPI, free)', channel: 'RapidAPI', usd: 0, units: 400, maxWindowH: 12, caching: 'standard-7d', commercial: false, overagePerUnit: null, rps: 1 },
  { id: 'Pro (API.Market)', channel: 'API.Market', usd: 7.5, units: 5_000, maxWindowH: 12, caching: 'standard-7d', commercial: true, overagePerUnit: null, rps: 1 },
  { id: 'Pro (RapidAPI)', channel: 'RapidAPI', usd: 8, units: 5_000, maxWindowH: 12, caching: 'standard-7d', commercial: true, overagePerUnit: null, rps: 2 },
  { id: 'Pro 2 (API.Market)', channel: 'API.Market', usd: 15, units: 15_000, maxWindowH: 12, caching: 'standard-7d', commercial: true, overagePerUnit: null, rps: 2 },
  { id: 'Starter (Direct)', channel: 'Direct', usd: 19, units: 40_000, maxWindowH: 12, caching: 'standard-7d', commercial: true, overagePerUnit: null, rps: 5 },
  { id: 'Ultra (API.Market)', channel: 'API.Market', usd: 37.5, units: 50_000, maxWindowH: 12, caching: 'standard-7d', commercial: true, overagePerUnit: null, rps: 3 },
  { id: 'Ultra (RapidAPI)', channel: 'RapidAPI', usd: 40, units: 50_000, maxWindowH: 12, caching: 'standard-7d', commercial: true, overagePerUnit: null, rps: 4 },
  { id: 'Ultra 2 (API.Market)', channel: 'API.Market', usd: 75, units: 150_000, maxWindowH: 24, caching: 'extended-while-subscribed', commercial: true, overagePerUnit: null, rps: 4 },
  { id: 'Growth (Direct)', channel: 'Direct', usd: 99, units: 400_000, maxWindowH: 24, caching: 'extended-while-subscribed', commercial: true, overagePerUnit: null, rps: 10 },
  { id: 'Mega (API.Market)', channel: 'API.Market', usd: 187.5, units: 500_000, maxWindowH: 24, caching: 'extended-while-subscribed', commercial: true, overagePerUnit: 0.00037, rps: 5 },
  { id: 'Mega (RapidAPI)', channel: 'RapidAPI', usd: 200, units: 500_000, maxWindowH: 24, caching: 'extended-while-subscribed', commercial: true, overagePerUnit: 0.0004, rps: 8 },
  { id: 'Scale (Direct)', channel: 'Direct', usd: 499, units: 4_000_000, maxWindowH: 48, caching: 'extended-plus-1y', commercial: true, overagePerUnit: null, rps: 20 },
];

// ---------- Airports in expansion order. Movements/day: [M] for FCO, otherwise [A] (≈ annual commercial
// movements / 365 from public traffic reports, ±15 %, NOT verified this session: replace with trial counts).
// livePct: AeroDataBox country-level "live" coverage [V] https://aerodatabox.com/data-coverage ("Last updated: June 3, 2026").
interface Ap { iata: string; tz: string; country: string; movementsPerDay: number; livePct: number; hub: 'large' | 'medium' | 'small' }
export const AIRPORTS: Ap[] = [
  { iata: 'CDG', tz: 'Europe/Paris', country: 'France', movementsPerDay: 1300, livePct: 79, hub: 'large' },
  { iata: 'FRA', tz: 'Europe/Berlin', country: 'Germany', movementsPerDay: 1200, livePct: 93, hub: 'large' },
  { iata: 'AMS', tz: 'Europe/Amsterdam', country: 'Netherlands', movementsPerDay: 1300, livePct: 100, hub: 'large' },
  { iata: 'MUC', tz: 'Europe/Berlin', country: 'Germany', movementsPerDay: 900, livePct: 93, hub: 'medium' },
  { iata: 'LHR', tz: 'Europe/London', country: 'United Kingdom', movementsPerDay: 1300, livePct: 71, hub: 'large' },
  { iata: 'MAD', tz: 'Europe/Madrid', country: 'Spain', movementsPerDay: 1150, livePct: 95, hub: 'large' },
  { iata: 'FCO', tz: 'Europe/Rome', country: 'Italy', movementsPerDay: 890, livePct: 57, hub: 'medium' },
  { iata: 'ZRH', tz: 'Europe/Zurich', country: 'Switzerland', movementsPerDay: 700, livePct: 100, hub: 'medium' },
  { iata: 'VIE', tz: 'Europe/Vienna', country: 'Austria', movementsPerDay: 650, livePct: 96, hub: 'medium' },
  { iata: 'CPH', tz: 'Europe/Copenhagen', country: 'Denmark', movementsPerDay: 680, livePct: 90, hub: 'medium' },
  { iata: 'BCN', tz: 'Europe/Madrid', country: 'Spain', movementsPerDay: 900, livePct: 95, hub: 'medium' },
  { iata: 'IST', tz: 'Europe/Istanbul', country: 'Turkey', movementsPerDay: 1400, livePct: 76, hub: 'large' },
  { iata: 'LIS', tz: 'Europe/Lisbon', country: 'Portugal', movementsPerDay: 600, livePct: 97, hub: 'medium' },
  { iata: 'DUB', tz: 'Europe/Dublin', country: 'Ireland', movementsPerDay: 630, livePct: 95, hub: 'medium' },
  { iata: 'BRU', tz: 'Europe/Brussels', country: 'Belgium', movementsPerDay: 550, livePct: 85, hub: 'small' },
  { iata: 'OSL', tz: 'Europe/Oslo', country: 'Norway', movementsPerDay: 600, livePct: 94, hub: 'small' },
  { iata: 'HEL', tz: 'Europe/Helsinki', country: 'Finland', movementsPerDay: 380, livePct: 81, hub: 'small' },
  { iata: 'ARN', tz: 'Europe/Stockholm', country: 'Sweden', movementsPerDay: 520, livePct: 81, hub: 'small' },
  { iata: 'ATH', tz: 'Europe/Athens', country: 'Greece', movementsPerDay: 650, livePct: 83, hub: 'small' },
  { iata: 'WAW', tz: 'Europe/Warsaw', country: 'Poland', movementsPerDay: 520, livePct: 39, hub: 'small' },
];

// ---------- Parameters (every one can be overridden with --params) ----------
export const PARAMS = {
  unitsPerFidsCall: 2,          // [V] FIDS is "TIER 2"; Tier 2 = 2 units (pricing page, OpenAPI summary)
  unitsPerStatusCall: 2,        // [V] Flight Status (single day) is TIER 2; the flight-plan ×2 surcharge needs a flight plan, offered for mainland U.S. flights only [V]
  windowHours: 12,              // as implemented (aerodatabox.ts: dayWindows(..., 12)); 24 is allowed only on Ultra 2 / Mega / Growth / Scale
  monthStart: '2026-11-01',     // a 30-day month without a DST change (nominal month)
  dstMonthStart: '2026-10-01',  // month containing the 25-h day (2026-10-25), used for the DST reserve in B and C
  usdIls: 3.1284,               // [V] ECB reference rate 2026-10-30 via https://api.frankfurter.dev/v1/2026-10-30?from=USD&to=ILS
  eurUsd: 1.1172,               // [V] same source, EUR→USD 2026-10-30
  gateGivenLive: 0.85,          // [A] share of live-covered flights whose board row already carries a gate
  // Infrastructure [V] https://docs.railway.com/reference/pricing/plans (read 2026-10-30): RAM $10/GB-mo, CPU $20/vCPU-mo,
  // volume $0.15/GB-mo (one reference page says $0.25: see the research doc), egress $0.05/GB; Hobby $5 minimum incl. $5 usage,
  // 5 GB volume cap; Pro $20 minimum incl. $20 usage, 50 GB default volume.
  ramUsdPerGbMonth: 10, cpuUsdPerVcpuMonth: 20, volumeUsdPerGbMonth: 0.15, egressUsdPerGb: 0.05,
  hobbyMinUsd: 5, proMinUsd: 20, hobbyVolumeGbUsable: 4.5,
  kbPerFlightDay: 3.5,          // [M+A] PoC: ≈ 0.8 MB per FCO direction-day of ≈ 445 flights with one observation (≈ 1.8 kB) + later observations and sightings
  derivedKbPerKeyMonth: 1.8,    // [A] ≈ 10 counter rows × 180 B per flight key and month
  keysPerMovement: 1.2,         // [A] distinct flight keys per month ÷ daily movements
  runMetaMbPerAirportMonth: 1.5,// [A] run diagnostics, findings, raw samples
  rawDaysKept: 8,               // raw window under the 7-day cap (rows are rolled up before day 7; one day in flight)
  extraRawGbPerYear: 0,         // set ≈ 2.5 to include the FCO (ADR) and ARN (Swedavia) raw collection in the same database
  horizonMonths: 12,            // storage is sized at this month of operation
  backupCompression: 0.3, backupsPerMonth: 4.33, dashboardEgressGb: 0.5,
  hetznerEurMonth: 5.99 + 1.198, // [V] CX23 €5.99/mo + backups €1.198/mo, excl. VAT (https://www.hetzner.com/cloud/, 2026-10-31; page showed "currently unavailable")
  hetznerUsableGb: 30,          // [A] of the 40 GB disk, after OS, PostgreSQL WAL and dumps
};
type Params = typeof PARAMS;

interface Scenario { id: 'A' | 'B' | 'C'; name: string; slots: SlotSpec[]; retryRate: number; rerunSlotsPerMonth: number; dstReserve: boolean; fixedDiagnosticCalls: number; headroom: number; gateLookups: boolean }
export const SCENARIOS: Scenario[] = [
  { id: 'A', name: 'Minimum viable', slots: DEFAULT_SLOTS.map((s) => ({ ...s, dayOffsets: [0] })), retryRate: 0, rerunSlotsPerMonth: 0, dstReserve: false, fixedDiagnosticCalls: 0, headroom: 1, gateLookups: false },
  { id: 'B', name: 'Realistic production (budget)', slots: DEFAULT_SLOTS, retryRate: 0.05, rerunSlotsPerMonth: 1, dstReserve: true, fixedDiagnosticCalls: 25, headroom: 0.85, gateLookups: false },
  { id: 'C', name: 'Enhanced gate coverage', slots: DEFAULT_SLOTS, retryRate: 0.05, rerunSlotsPerMonth: 1, dstReserve: true, fixedDiagnosticCalls: 25, headroom: 0.85, gateLookups: true },
];
type Retention = 'aggregate' | 'raw';

// ---------- Call counting: replays tick() — per due slot, per target date, arrival fetches the windows and the
// departure is served from the adapter's 10-minute cache (direction=Both), so calls = number of windows. ----------
const memo = new Map<string, number>();
export function fidsCallsInMonth(tz: string, slots: SlotSpec[], start: string, days: number, windowHours: number) {
  const key = JSON.stringify([tz, slots, start, days, windowHours]);
  if (!memo.has(key)) memo.set(key, countCalls(tz, slots, start, days, windowHours));
  return memo.get(key)!;
}
function countCalls(tz: string, slots: SlotSpec[], start: string, days: number, windowHours: number) {
  const a = { tz } as AirportInfo;
  let calls = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    for (const s of slots) for (const off of s.dayOffsets) calls += dayWindows(a, 'arrival', addDays(d, off), windowHours).length;
  }
  return calls;
}
function slotCalls(tz: string, slot: SlotSpec, date: string, windowHours: number) {
  return slot.dayOffsets.reduce((n, off) => n + dayWindows({ tz } as AirportInfo, 'arrival', addDays(date, off), windowHours).length, 0);
}

export function airportMonth(ap: Ap, sc: Scenario, p: Params, windowHours = p.windowHours) {
  const base = fidsCallsInMonth(ap.tz, sc.slots, p.monthStart, 30, windowHours);
  const dst = sc.dstReserve ? fidsCallsInMonth(ap.tz, sc.slots, p.dstMonthStart, 30, windowHours) - base : 0;
  const biggest = Math.max(...sc.slots.map((s) => slotCalls(ap.tz, s, p.monthStart, windowHours)));
  const fids = Math.ceil((base + Math.max(0, dst)) * (1 + sc.retryRate)) + sc.rerunSlotsPerMonth * biggest;
  const gateMissing = 1 - (ap.livePct / 100) * p.gateGivenLive;
  const status = sc.gateLookups ? Math.ceil(ap.movementsPerDay * gateMissing * 30 * (1 + sc.retryRate)) : 0;
  return { fids, status, calls: fids + status, units: fids * p.unitsPerFidsCall + status * p.unitsPerStatusCall, gateMissing };
}

function eligible(pl: Plan, retention: Retention, windowHours: number) {
  if (!pl.commercial) return false;                                   // Basic: "Commercial Use: Not allowed" [V]
  if (retention === 'raw' && pl.caching === 'standard-7d') return false; // raw history needs "Extended" caching [V]
  return pl.maxWindowH >= windowHours;
}
export function cheapestPlan(units: number, sc: Scenario, retention: Retention, windowHours: number, channels?: Plan['channel'][]) {
  let best: { plan: Plan; usd: number } | null = null;
  for (const pl of PLANS) {
    if (!eligible(pl, retention, windowHours) || (channels && !channels.includes(pl.channel))) continue;
    let usd = pl.usd;
    if (units > pl.units * sc.headroom) {
      if (pl.overagePerUnit === null) continue;                          // hard limit: calls are rejected [V FAQ]
      usd += (units - pl.units * sc.headroom) * pl.overagePerUnit;       // budget the headroom as paid overage
    }
    if (!best || usd < best.usd - 1e-9) best = { plan: pl, usd };
  }
  return best;
}

// ---------- Infrastructure (Railway; Hetzner as the alternative) ----------
export function storageGb(aps: Ap[], retention: Retention, p: Params) {
  let mb = 0;
  for (const ap of aps) {
    const flightDayMb = ap.movementsPerDay * p.kbPerFlightDay / 1024;
    mb += retention === 'raw' ? flightDayMb * 30.4 * p.horizonMonths : flightDayMb * p.rawDaysKept;
    mb += (ap.movementsPerDay * p.keysPerMovement * p.derivedKbPerKeyMonth / 1024 + p.runMetaMbPerAirportMonth) * p.horizonMonths;
  }
  return mb / 1024 + p.extraRawGbPerYear * p.horizonMonths / 12;
}
export function railway(aps: Ap[], statusCallsPerDay: number, retention: Retention, p: Params) {
  const n = aps.length, gb = storageGb(aps, retention, p);
  const pg = (0.15 + 0.005 * n + Math.min(0.01 * gb, 0.6)) * p.ramUsdPerGbMonth + (0.01 + 0.001 * n) * p.cpuUsdPerVcpuMonth;
  const collectorMinPerDay = 96 * 0.1 + n * 8 * 0.33 + statusCallsPerDay * 1.2 / 60;   // [A] ticks + 8 runs/airport/day + 1.1 s spacing per status call
  const collector = collectorMinPerDay * 30 / 43_200 * (0.3 * p.ramUsdPerGbMonth + 0.3 * p.cpuUsdPerVcpuMonth);
  const api = 0.12 * p.ramUsdPerGbMonth + 0.005 * p.cpuUsdPerVcpuMonth;
  const volume = gb * p.volumeUsdPerGbMonth;
  const egress = (p.dashboardEgressGb + gb * p.backupCompression * p.backupsPerMonth) * p.egressUsdPerGb;
  const usage = pg + collector + api + volume + egress;
  const plan = gb > p.hobbyVolumeGbUsable ? 'Pro' : 'Hobby';
  const bill = Math.max(plan === 'Pro' ? p.proMinUsd : p.hobbyMinUsd, usage);
  return { gb, usage, plan, bill };
}
export const hetznerUsd = (gb: number, p: Params) => (gb <= p.hetznerUsableGb ? p.hetznerEurMonth * p.eurUsd : NaN);

// ---------- Rows ----------
export interface Row { scenario: string; retention: Retention; channels: string; windowHours: number; airports: number; airportList: string; fidsCalls: number; statusCalls: number; calls: number; units: number; plan: string; apiUsd: number; infraPlan: string; infraUsd: number; storageGb: number; totalUsd: number; perAirportUsd: number; totalIls: number; upgrade: boolean; hetznerTotalUsd: number }
export function rows(sc: Scenario, retention: Retention, p: Params, opts: { channels?: Plan['channel'][]; windowHours?: number } = {}): Row[] {
  const wh = opts.windowHours ?? p.windowHours;
  const out: Row[] = [];
  let prevPlan = '';
  for (let n = 1; n <= 20; n++) {
    const aps = AIRPORTS.slice(0, n);
    const per = aps.map((ap) => airportMonth(ap, sc, p, wh));
    const fids = per.reduce((s, x) => s + x.fids, 0) + sc.fixedDiagnosticCalls;
    const status = per.reduce((s, x) => s + x.status, 0);
    const units = fids * p.unitsPerFidsCall + status * p.unitsPerStatusCall;
    const best = cheapestPlan(units, sc, retention, wh, opts.channels);
    const infra = railway(aps, status / 30, retention, p);
    const apiUsd = best ? best.usd : NaN;
    const total = apiUsd + infra.bill;
    const plan = best ? best.plan.id : 'none sufficient';
    out.push({
      scenario: sc.id, retention, channels: opts.channels?.join('+') ?? 'any', windowHours: wh, airports: n, airportList: aps.map((a) => a.iata).join(' '),
      fidsCalls: fids, statusCalls: status, calls: fids + status, units, plan, apiUsd: round2(apiUsd), infraPlan: `Railway ${infra.plan}`, infraUsd: round2(infra.bill),
      storageGb: round2(infra.gb), totalUsd: round2(total), perAirportUsd: round2(total / n), totalIls: round2(total * p.usdIls), upgrade: n > 1 && plan !== prevPlan,
      hetznerTotalUsd: round2(apiUsd + hetznerUsd(infra.gb, p)),
    });
    prevPlan = plan;
  }
  return out;
}
const round2 = (x: number) => Math.round(x * 100) / 100;
const usd = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : 'n/a');
const int = (x: number) => x.toLocaleString('en-US');

export function allTables(p: Params) {
  const [A, B, C] = SCENARIOS;
  return {
    A_agg: rows(A, 'aggregate', p), B_agg: rows(B, 'aggregate', p), C_agg: rows(C, 'aggregate', p),
    B_raw: rows(B, 'raw', p), C_raw: rows(C, 'raw', p), B_raw24: rows(B, 'raw', p, { windowHours: 24 }),
    B_rapid: rows(B, 'aggregate', p, { channels: ['RapidAPI'] }), B_direct: rows(B, 'aggregate', p, { channels: ['Direct'] }), B_apimarket: rows(B, 'aggregate', p, { channels: ['API.Market'] }),
  };
}

function mdTable(r: Row[]) {
  const head = '| Airports | Added | Monthly API calls | Monthly API units | Cheapest sufficient plan | API cost/month | Hosting + DB/month | Total/month | Avg per airport | Total ILS |\n|---:|---|---:|---:|---|---:|---:|---:|---:|---:|';
  return [head, ...r.map((x) => `| ${x.airports} | ${x.airportList.split(' ').pop()} | ${int(x.calls)} | ${int(x.units)} | ${x.upgrade ? `**${x.plan}** ⬆` : x.plan} | ${usd(x.apiUsd)} | ${usd(x.infraUsd)} (${x.infraPlan.replace('Railway ', '')}) | **${usd(x.totalUsd)}** | ${usd(x.perAirportUsd)} | ₪${x.totalIls.toFixed(2)} |`)].join('\n');
}
function perAirportTable(p: Params) {
  const [, B, C] = SCENARIOS;
  const head = '| # | Airport | Hub | Movements/day [A] | Live coverage (country) [V] | Gate missing in board, est. | B: FIDS calls/month | B: units | C: extra Flight Status calls | C: units for this airport |\n|---:|---|---|---:|---:|---:|---:|---:|---:|---:|';
  return [head, ...AIRPORTS.map((ap, i) => {
    const b = airportMonth(ap, B, p), c = airportMonth(ap, C, p);
    return `| ${i + 1} | ${ap.iata} | ${ap.hub} | ${int(ap.movementsPerDay)} | ${ap.livePct} % (${ap.country}) | ${Math.round(c.gateMissing * 100)} % | ${b.fids} | ${int(b.units)} | ${int(c.status)} | ${int(c.units)} |`;
  })].join('\n');
}
function channelTable(t: ReturnType<typeof allTables>) {
  const head = '| Airports | Any channel | API.Market only | RapidAPI only | Direct only |\n|---:|---|---|---|---|';
  return [head, ...t.B_agg.map((x, i) => `| ${x.airports} | ${x.plan} ${usd(x.apiUsd)} | ${t.B_apimarket[i].plan} ${usd(t.B_apimarket[i].apiUsd)} | ${t.B_rapid[i].plan} ${usd(t.B_rapid[i].apiUsd)} | ${t.B_direct[i].plan} ${usd(t.B_direct[i].apiUsd)} |`)].join('\n');
}
function infraTable(t: ReturnType<typeof allTables>, p: Params) {
  const head = '| Airports | Storage at month 12, aggregates (GB) | Railway, aggregates | Storage at month 12, raw kept (GB) | Railway, raw kept | Hetzner CX23 alternative (flat, ≤ 30 GB) |\n|---:|---:|---:|---:|---:|---:|';
  return [head, ...[1, 3, 5, 10, 15, 20].map((n) => { const a = t.B_agg[n - 1], r = t.B_raw[n - 1]; return `| ${n} | ${a.storageGb.toFixed(2)} | ${usd(a.infraUsd)} (${a.infraPlan.replace('Railway ', '')}) | ${r.storageGb.toFixed(2)} | ${usd(r.infraUsd)} (${r.infraPlan.replace('Railway ', '')}) | ${usd(hetznerUsd(r.storageGb, p))} |`; })].join('\n');
}
function summaryTable(t: ReturnType<typeof allTables>) {
  const head = '| Airports | A: min. viable | B: production (budget) | C: + gate lookups | B with raw kept while subscribed | C with raw kept |\n|---:|---:|---:|---:|---:|---:|';
  return [head, ...[1, 3, 5, 10, 15, 20].map((n) => `| ${n} | ${usd(t.A_agg[n - 1].totalUsd)} | **${usd(t.B_agg[n - 1].totalUsd)}** | ${usd(t.C_agg[n - 1].totalUsd)} | ${usd(t.B_raw[n - 1].totalUsd)} | ${usd(t.C_raw[n - 1].totalUsd)} |`)].join('\n');
}

export function generated(p: Params) {
  const t = allTables(p);
  return {
    t,
    blocks: {
      summary: summaryTable(t), perAirport: perAirportTable(p), A: mdTable(t.A_agg), B: mdTable(t.B_agg), C: mdTable(t.C_agg),
      Braw: mdTable(t.B_raw), Craw: mdTable(t.C_raw), channels: channelTable(t), infra: infraTable(t, p),
    } as Record<string, string>,
  };
}

function csv(t: ReturnType<typeof allTables>) {
  const cols: (keyof Row)[] = ['scenario', 'retention', 'channels', 'windowHours', 'airports', 'airportList', 'fidsCalls', 'statusCalls', 'calls', 'units', 'plan', 'apiUsd', 'infraPlan', 'infraUsd', 'storageGb', 'totalUsd', 'perAirportUsd', 'totalIls', 'upgrade', 'hetznerTotalUsd'];
  const all = [...t.A_agg, ...t.B_agg, ...t.C_agg, ...t.B_raw, ...t.C_raw, ...t.B_raw24, ...t.B_apimarket, ...t.B_rapid, ...t.B_direct];
  const esc = (v: unknown) => { const s = Number.isNaN(v) ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...all.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function fillDoc(doc: string, blocks: Record<string, string>) {
  return doc.replace(/<!-- gen:(\w+) -->[\s\S]*?<!-- \/gen -->/g, (m, k) => (k in blocks ? `<!-- gen:${k} -->\n${blocks[k]}\n<!-- /gen -->` : m));
}

const selfPath = fileURLToPath(import.meta.url);
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === selfPath;
if (isMain) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--params');
  const p: Params = { ...PARAMS, ...(pi >= 0 ? JSON.parse(argv[pi + 1]) : {}) };
  const { t, blocks } = generated(p);
  const root = path.resolve(path.dirname(selfPath), '..', '..');
  const docPath = path.join(root, 'docs', 'FLIGHT_DATA_1_TO_20_AIRPORT_COST_MODEL.md');
  const csvPath = path.join(root, 'data', 'research', 'flightdata', 'aerodatabox-cost-model-1-20.csv');
  if (argv.includes('--write') || argv.includes('--check')) {
    if (pi >= 0) { console.error('--write/--check use the published parameters only; drop --params'); process.exit(2); }
    const doc = fs.readFileSync(docPath, 'utf8'), newDoc = fillDoc(doc, blocks), newCsv = csv(t);
    if (argv.includes('--check')) {
      const oldCsv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : '';
      const ok = newDoc === doc && newCsv === oldCsv;
      console.log(ok ? 'cost model: doc tables and CSV match a fresh run' : 'cost model: doc or CSV is out of date: run with --write');
      process.exit(ok ? 0 : 1);
    }
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(docPath, newDoc);
    fs.writeFileSync(csvPath, newCsv);
    console.log(`wrote ${path.relative(root, docPath)} and ${path.relative(root, csvPath)}`);
  } else {
    for (const [k, v] of Object.entries(blocks)) console.log(`\n### ${k}\n${v}`);
  }
}

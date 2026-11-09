// Calibrated passport-control times by airport, direction and passenger status (Workstream 2, 2026-11-02).
// Evidence and the reasons for every value: docs/research/TRANSFER_TIME_CALIBRATION.md §3, built on
// docs/research/calibration/TIMING_EVIDENCE_REVIEW.md §B and §D1–D3. Pure module: no browser APIs.
//
// Scope, on purpose narrow:
//   - Only PASSPORT controls are replaced, and only where the review found airport-fed, lane-level evidence. Everywhere
//     else the airport model's own (assumed) value stays, so no value is invented.
//   - Security is NOT recalibrated: every published figure is queue time only, the screening/repacking time is not
//     published for any of the eight airports, so cutting the current totals to the queue values would drop a known
//     part of a mandatory procedure (TRANSFER_TIME_CALIBRATION.md §4).
//   - No general peak factor: the evidence contradicts one (§5). The peak lives in the conservative value.
// The router keeps choosing routes with the model values; only the timing of the chosen route's passport steps changes.
import type { Minutes, Zone } from '../../../airportmaps/src/types.ts';
import type { Step } from '../../../airportmaps/src/route.ts';

/** EES status of the traveller (review §B.4). 'ees-exempt' = EU/EEA/Swiss citizens, Schengen residence-permit and
 *  long-stay-visa holders, family members with a residence card, Andorra/Monaco/San Marino/Vatican nationals.
 *  'ees-registered' = every other passport (Israel, UK without a Withdrawal-Agreement document, USA…). */
export type PassengerStatus = 'ees-exempt' | 'ees-registered';
/** Not stated → the EES-registered values (conservative; also the status of an Israeli passport). */
export const DEFAULT_STATUS: PassengerStatus = 'ees-registered';

type Dir = 'entry' | 'exit';
type Table = Partial<Record<string, Partial<Record<`${Dir}:${PassengerStatus}`, Minutes & { source: string }>>>>;
const QS = 'Qsensor airport-fed queue pages, 3-week time averages and weekly maxima (TIMING_EVIDENCE_REVIEW.md §A, D1–D3)';
const v = (min: number, typical: number, max: number, source: string, note: string): Minutes & { source: string } => ({ min, typical, max, basis: 'derived', note, source });

/** typical = active-hours median estimate, max = conservative ≈ P90 that carries bank peaks (review §C.2). */
export const PASSPORT: Table = {
  AMS: { 'entry:ees-registered': v(3, 15, 45, QS, 'non-Schengen arrival, EES: active-hours mean 16 (Jul 2026), all-hours 12–13; peak hours and "one to two hours" reports kept in the tail') },
  CDG: {
    'entry:ees-registered': v(3, 14, 45, QS + '; ADP/PAF border barometer 2023', '"all passports" lanes 2B/2C/2E: day means 7–23, weekly max up to 119'),
    'entry:ees-exempt': v(1, 5, 20, QS, 'PARAFE "automated" lanes: day means 1–9, weekly max 2–38'),
    'exit:ees-exempt': v(1, 5, 20, QS, 'PARAFE "automated" lanes'),
  },
  FRA: {
    'entry:ees-registered': v(2, 7, 30, QS + ' (banded 5/10/20/30… readings: low confidence)', 'transfer passport control A L2: averages 7–9, weekly max 20–45'),
    'exit:ees-registered': v(2, 6, 20, QS + ' (banded readings)', 'departure passport controls A L2/L3, C L2, J L3: averages 5–7, weekly max 10–45'),
  },
  MUC: {
    'entry:ees-registered': v(2, 5, 20, QS + ' (weak: the airport value mixes emigration)', 'passport mean 4–7 (Oct), 2 (Jul/Aug)'),
    'exit:ees-registered': v(1, 3, 10, QS, 'T2 emigration, manual lanes: 2–4, weekly max 4–11'),
    'exit:ees-exempt': v(1, 2, 5, QS, 'T2 emigration, automatic lanes: 1–3, weekly max 1–7'),
  },
  ZRH: {
    'entry:ees-registered': v(2, 4, 20, QS, '"Immigration Passport Control Transfers": 2–3, weekly max 15–20; July 6'),
    'exit:ees-registered': v(1, 4, 15, QS, '"Emigration Passport Control": 3–4, weekly max 18–20'),
  },
  FCO: { 'entry:ees-registered': v(3, 15, 45, 'ADR via local press, 2026-07: UK nationals "from 7 minutes to 20 minutes on average" (TIMING_EVIDENCE_REVIEW.md D1)', 'mean for UK nationals; peak season may be higher') },
  // IST: Turkey is not in EES and every non-Turkish passport uses the same lanes: one value for both statuses
  IST: {
    'entry:ees-registered': v(3, 15, 40, QS, 'mixed lanes: Oct 12–15, busy daytime Jul 18 / Aug 20; landside / self-transfer only'),
    'entry:ees-exempt': v(3, 15, 40, QS, 'EU citizens use the same lanes as other foreign visitors in Turkey'),
  },
  // LHR: the UK is outside Schengen and EES. Heathrow MTI reports the UK border as passenger-weighted shares by lane
  // (TIMING_EVIDENCE_REVIEW.md §E): 'ees-exempt' (EU/EEA/Swiss passports) → the EEA lanes / eGates, every other passport
  // (Israel, …) → the non-EEA lanes. USA etc. may use eGates but are conservatively given the non-EEA value.
  LHR: {
    'entry:ees-registered': v(3, 12, 50, 'Heathrow MTI Jul–Sep 2026: non-EEA passengers < 45 min 82–98 % (T2/T3 July 82–83 %); Qsensor July 2026 average 10, 88 % < 15 min (TIMING_EVIDENCE_REVIEW.md §E)', 'non-EEA lanes: P90 about 45 in September, above 45 at T2/T3 in July'),
    'entry:ees-exempt': v(1, 5, 20, 'Heathrow MTI Jul–Sep 2026: EEA passengers < 25 min ≥ 99.08 % (TIMING_EVIDENCE_REVIEW.md §E); eGates for EU/EEA/Swiss passports (gov.uk)', 'EEA lanes and eGates: verified P90 below 25'),
  },
  // MAD: no airport-fed data (review D1) → the model value stays
};

const NS = (z: Zone | null) => z === 'non-schengen';
const SCH = (z: Zone | null) => z === 'schengen';

/**
 * The expected passport crossings of a connection in order (entry into / exit from the Schengen area, or into Turkey).
 * Protected Schengen hubs: non-Schengen → Schengen = one entry, Schengen → non-Schengen = one exit, anything else none
 * (an airside non-Schengen transit has no border check). Self-transfer: an entry when arriving from outside, then an
 * exit when leaving for outside. IST (international hub): only a landside route enters Turkey. LHR (asymmetric UK border,
 * no exit control): an international arrival enters the UK on an international → UK & Ireland connection or a
 * self-transfer; a UK & Ireland (domestic) arrival and every departure pass no passport control.
 */
export function expectedCrossings(hub: string, arrZone: Zone | null, depZone: Zone | null, selfTransfer: boolean): Dir[] {
  if (hub === 'LHR') return arrZone === 'domestic' ? [] : selfTransfer || depZone === 'domestic' ? ['entry'] : [];
  if (hub === 'IST') return selfTransfer ? ['entry'] : [];
  if (!selfTransfer) return NS(arrZone) && SCH(depZone) ? ['entry'] : SCH(arrZone) && NS(depZone) ? ['exit'] : [];
  const out: Dir[] = [];
  if (NS(arrZone)) out.push('entry');
  if (NS(depZone)) out.push('exit');
  return out;
}

export interface CalibratedSteps { steps: Step[]; applied: { step: number; dir: Dir; status: PassengerStatus; minutes: Minutes; source: string }[] }

/**
 * Replace the minutes of a route's passport steps with the calibrated value for this airport, direction and status.
 * Steps are matched in order to the expected crossings; when the route's crossings do not match the expectation (an
 * unusual or double crossing) nothing is changed — the model value stays.
 */
export function calibratePassport(hub: string, steps: Step[], ctx: { arrZone: Zone | null; depZone: Zone | null; selfTransfer: boolean; status?: PassengerStatus }): CalibratedSteps {
  const status = ctx.status ?? DEFAULT_STATUS;
  const idx = steps.map((s, i) => (s.control?.kind === 'passport' ? i : -1)).filter((i) => i >= 0);
  const want = expectedCrossings(hub, ctx.arrZone, ctx.depZone, ctx.selfTransfer);
  const table = PASSPORT[hub];
  if (!table || !idx.length || idx.length !== want.length) return { steps, applied: [] };
  const out = steps.slice(), applied: CalibratedSteps['applied'] = [];
  idx.forEach((i, k) => {
    const val = table[`${want[k]}:${status}`];
    if (!val) return;
    const { source, ...minutes } = val;
    out[i] = { ...steps[i], minutes, control: steps[i].control ? { ...steps[i].control!, minutes } : steps[i].control };
    applied.push({ step: i, dir: want[k], status, minutes, source });
  });
  return { steps: out, applied };
}

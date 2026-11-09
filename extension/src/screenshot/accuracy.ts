// Field-level accuracy of a screenshot reading against the ground truth of a fixture (used by the unit tests and by
// extension/scripts/screenshot-accuracy.ts). The safety metric is `silent`: a wrong value presented as read clearly.
// It must stay 0 — a wrong value the traveller is asked to check is a nuisance, a silent one is a false fact.
import type { Draft } from './types.ts';

export interface TruthLeg { from: string; to: string; flightNumber: string | null; depTime: string | null; arrTime: string | null; depDate: string | null; arrDate: string | null }
export interface Truth { journeys: { label: string; legs: TruthLeg[]; selfTransfer: boolean | null }[] }

export const SCORED = ['from', 'to', 'flightNumber', 'depTime', 'arrTime', 'depDate', 'arrDate'] as const;
export type Outcome = 'read' | 'check' | 'wrongChecked' | 'silent' | 'missing' | 'invented';
export interface Score { counts: Record<Outcome, number>; byField: Record<string, Record<Outcome, number>>; legsTruth: number; legsFound: number; details: string[] }

const zero = (): Record<Outcome, number> => ({ read: 0, check: 0, wrongChecked: 0, silent: 0, missing: 0, invented: 0 });

/** Legs are matched in order within each journey (journeys in order). */
export function score(d: Draft, t: Truth): Score {
  const s: Score = { counts: zero(), byField: Object.fromEntries(SCORED.map((k) => [k, zero()])), legsTruth: 0, legsFound: 0, details: [] };
  const add = (k: string, o: Outcome, note?: string) => { s.counts[o]++; s.byField[k][o]++; if (note && (o === 'silent' || o === 'invented' || o === 'wrongChecked' || o === 'missing')) s.details.push(`${o}: ${note}`); };
  t.journeys.forEach((tj, ji) => {
    const dj = d.journeys[ji];
    s.legsTruth += tj.legs.length;
    tj.legs.forEach((tl, li) => {
      const dl = dj?.legs[li];
      if (dl) s.legsFound++;
      for (const k of SCORED) {
        const want = tl[k], f = dl?.f[k];
        const where = `J${ji + 1} L${li + 1} ${k}`;
        if (want === null) { if (f?.value && f.state === 'read') add(k, 'invented', `${where} = ${f.value} (not visible)`); continue; }
        if (!f || !f.value) { add(k, 'missing', `${where} (want ${want})`); continue; }
        if (f.value === want) add(k, f.state === 'read' ? 'read' : 'check');
        else add(k, f.state === 'read' ? 'silent' : 'wrongChecked', `${where} = ${f.value} (want ${want}${f.why ? `; ${f.why}` : ''})`);
      }
    });
    if (dj && dj.legs.length > tj.legs.length) s.details.push(`extra: journey ${ji + 1} has ${dj.legs.length} legs, ${tj.legs.length} visible`);
    if (tj.selfTransfer && dj && !dj.selfTransferAt.some((x) => x === true)) s.details.push(`self-transfer label of journey ${ji + 1} not found`);
  });
  if (d.journeys.length > t.journeys.length) s.details.push(`extra: ${d.journeys.length - t.journeys.length} journey(s) not in the image`);
  return s;
}

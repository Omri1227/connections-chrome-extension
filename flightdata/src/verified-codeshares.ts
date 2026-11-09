// Operating-flight / codeshare relationships checked by hand against an independent public source, for flight-days on
// which the collected source listed a codeshare as an operating flight of its own (or gave it a wrong route). Applied by
// store.ts markDuplicates: the marketing flight-day is marked as a duplicate of the operating one (never deleted).
//
// Each entry is valid only for the date it was checked on. A codeshare agreement usually lasts a season, but extending
// an entry to other dates is an owner decision (docs/FLIGHT_DATA_OPERATIONS.md §0.8), not something inferred here.
import type { Direction } from './types.ts';

export interface VerifiedCodeshare {
  airport: string;
  direction: Direction;
  date: string;            // local date at the airport
  operating: string;       // operating flight number
  marketing: string[];     // numbers that are codeshares of it on that date
  evidence: string;
  checked: string;         // when the evidence was read
}

export const VERIFIED_CODESHARES: VerifiedCodeshare[] = [
  {
    airport: 'AMS', direction: 'departure', date: '2026-11-01', operating: 'KL807', marketing: ['CI9388', 'AF8414'],
    evidence: 'FlightStats flight tracker CI/9388 for 2026-11-01: "Operated by KLM 807", AMS–TPE; KL/807 lists codeshares AF8414, CI9388, SK6844. CI74 (China Airlines\' own AMS–TPE) does not fly that day.',
    checked: '2026-11-01',
  },
  {
    airport: 'AMS', direction: 'departure', date: '2026-11-01', operating: 'DL237', marketing: ['AF3588'],
    evidence: 'FlightStats flight tracker AF/3588 for 2026-11-01: "Operated by Delta Air Lines 237", AMS–TPA (the source gave this row FCO).',
    checked: '2026-11-01',
  },
  {
    airport: 'AMS', direction: 'departure', date: '2026-11-01', operating: 'KL461', marketing: ['AF8425', 'LY8854', 'KQ1461'],
    evidence: 'FlightStats flight tracker KL/461 for 2026-11-01: codeshares AF8425, DL9575, KQ1461, LY8854; two legs AMS–OTP–TLV (the codeshare rows give the final destination TLV).',
    checked: '2026-11-01',
  },
];

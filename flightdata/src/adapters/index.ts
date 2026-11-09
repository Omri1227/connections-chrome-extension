// Registry of source adapters. A source is only scheduled when FD_ASSIGNMENTS names it for an airport AND its
// configuration (keys) is present; sources whose terms rule them out are not implemented at all (see the research doc).
import { AIRPORTS } from '../airports.ts';
import type { AirportInfo, SourceAdapter } from '../types.ts';
import { adrFco } from './adr-fco.ts';
import { aerodatabox } from './aerodatabox.ts';
import { swedavia } from './swedavia.ts';

export const ADAPTERS: Record<string, SourceAdapter> = {
  [adrFco.info.id]: adrFco,
  [aerodatabox.info.id]: aerodatabox,
  [swedavia.info.id]: swedavia,
};

/** Recommended pairing (selected in docs/FLIGHT_DATA_SOURCE_RESEARCH.md §5). */
export const RECOMMENDED = 'CDG:aerodatabox,FCO:adr-fco-web,ARN:swedavia';

export function resolveAssignments(list: { airport: string; source: string }[]): { airport: AirportInfo; adapter: SourceAdapter }[] {
  return list.map(({ airport, source }) => {
    const a = AIRPORTS[airport], ad = ADAPTERS[source];
    if (!a) throw new Error(`unknown airport ${airport} (known: ${Object.keys(AIRPORTS).join(', ')})`);
    if (!ad) throw new Error(`unknown source ${source} (known: ${Object.keys(ADAPTERS).join(', ')})`);
    if (!ad.info.airports.includes('*') && !ad.info.airports.includes(airport)) throw new Error(`source ${source} does not cover ${airport}`);
    return { airport: a, adapter: ad };
  });
}

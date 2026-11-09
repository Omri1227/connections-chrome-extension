// Airports the extension can analyse (those with both a schematic model in airportmaps/ and flight-data collection),
// the country of any airport (OurAirports, Public Domain) and the border zone a flight from/to it uses.
import COUNTRIES from '../../data/airport-countries.json';
import type { Zone } from '../../../airportmaps/src/types.ts';

/** Connecting airports with a schematic model and historical terminal/gate collection. Owner decision 2026-11-02: LHR
 *  replaces IST (IST's model and tests stay in the repo for history, but it is not analysed). */
export const SUPPORTED = ['AMS', 'CDG', 'FCO', 'FRA', 'LHR', 'MAD', 'MUC', 'ZRH'] as const;

/** UK and the Common Travel Area (Ireland, Channel Islands, Isle of Man): Heathrow's UK & Ireland (domestic) flights.
 *  Heathrow treats UK and Republic of Ireland flights alike ("Flying within the UK and Ireland"); the Crown Dependencies
 *  (JE, GG, IM) are inferred from the Common Travel Area (docs/research/LHR_FEASIBILITY_AND_MAPPING.md). */
export const UK_CTA = new Set(['GB', 'IE', 'JE', 'GG', 'IM']);
export type Supported = (typeof SUPPORTED)[number];
export const isSupported = (iata: string): iata is Supported => (SUPPORTED as readonly string[]).includes(iata);

/** Schengen area members on 2026-10-31 (Bulgaria and Romania fully since 2025-01-01; Cyprus and Ireland are not members). */
export const SCHENGEN = new Set(['AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'CH']);

const TABLE = (COUNTRIES as unknown as { airports: Record<string, [string, string]> }).airports;
export const countryOf = (iata: string): string | null => TABLE[iata]?.[0] ?? null;
export const cityOf = (iata: string): string | null => TABLE[iata]?.[1] ?? null;
export const isKnownAirport = (iata: string) => iata in TABLE;

/**
 * Border zone used at `hub` by a flight from/to `other`: Schengen hubs split schengen / non-schengen by the other
 * airport's country; LHR splits UK & Ireland (domestic) / international; IST (inactive) domestic / international. null when
 * the other airport's country is unknown.
 * French overseas regions (RE, GP, MQ, GF, YT …) have their own ISO codes and are outside Schengen.
 */
export function zoneFor(hub: string, other: string): Zone | null {
  const c = countryOf(other);
  if (!c) return null;
  if (hub === 'LHR') return UK_CTA.has(c) ? 'domestic' : 'international';
  if (hub === 'IST') return c === 'TR' ? 'domestic' : 'international';
  return SCHENGEN.has(c) ? 'schengen' : 'non-schengen';
}

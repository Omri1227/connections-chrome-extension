// Airport metadata used for validation and scheduling. Terminal lists are what we expect today; a code outside the
// list is stored and reported (terminals get renamed: CDG's Terminal 2 renaming is due on 2027-03-16), never dropped.
import type { AirportInfo } from './types.ts';

const SCHEDULE = ['07:00', '15:00', '23:30'];

export const AIRPORTS: Record<string, AirportInfo> = {
  CDG: { iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle', tz: 'Europe/Paris', country: 'FR', terminals: ['1', '2A', '2B', '2C', '2D', '2E', '2F', '2G', '3'], gatePattern: '^[A-Z]{1,2}\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  FRA: { iata: 'FRA', icao: 'EDDF', name: 'Frankfurt am Main', tz: 'Europe/Berlin', country: 'DE', terminals: ['1', '2', '3'], gatePattern: '^[A-Z]{1,2}(\\d{1,3}[A-Z]?)?$', schedule: SCHEDULE }, // AeroDataBox sometimes gives only the pier ("J", seen 2026-10-31)
  MUC: { iata: 'MUC', icao: 'EDDM', name: 'Munich', tz: 'Europe/Berlin', country: 'DE', terminals: ['1', '1A', '1B', '1C', '1D', '1E', '1Z', '2'], gatePattern: '^[A-Z]\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  AMS: { iata: 'AMS', icao: 'EHAM', name: 'Amsterdam Schiphol', tz: 'Europe/Amsterdam', country: 'NL', terminals: ['1', '2', '3', '4'], gatePattern: '^[A-Z]{1,2}\\d{1,3}[A-Z]?$', schedule: SCHEDULE,
    // D6: 32 of 32 departures on 2026-10-31 kept D6 through departure, all KLM Embraer flights to non-Schengen
    // destinations (UK, Ireland, Serbia), up to 3 in the same minute. Traveller reports (businesstraveller.com
    // forum "KLM Cityhopper Fokker 70", flight-report.com KL1027) describe D6 as a bus-gate area split into D6a/b/c…
    // Low confidence: no official Schiphol source checked.
    sharedGates: { D6: 'bus-gate area (sub-gates D6a, D6b, …) for KLM Cityhopper non-Schengen departures; traveller reports, not official' } },
  LHR: { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow', tz: 'Europe/London', country: 'GB', terminals: ['2', '3', '4', '5'], gatePattern: '^[A-Z]?\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  FCO: { iata: 'FCO', icao: 'LIRF', name: 'Rome Fiumicino', tz: 'Europe/Rome', country: 'IT', terminals: ['1', '3'], gatePattern: '^[A-Z]\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  MAD: { iata: 'MAD', icao: 'LEMD', name: 'Madrid Barajas', tz: 'Europe/Madrid', country: 'ES', terminals: ['1', '2', '3', '4', '4S'], gatePattern: '^[A-Z]\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  ZRH: { iata: 'ZRH', icao: 'LSZH', name: 'Zurich', tz: 'Europe/Zurich', country: 'CH', terminals: ['1', '2', 'E'], gatePattern: '^[A-Z]\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  ARN: { iata: 'ARN', icao: 'ESSA', name: 'Stockholm Arlanda', tz: 'Europe/Stockholm', country: 'SE', terminals: ['2', '3', '4', '5'], gatePattern: '^[A-Z]?\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  // Istanbul Airport: one terminal building, piers A–G (no year-round DST since 2016: Europe/Istanbul is UTC+3).
  IST: { iata: 'IST', icao: 'LTFM', name: 'Istanbul', tz: 'Europe/Istanbul', country: 'TR', terminals: ['1'], gatePattern: '^[A-Z]\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
  VIE: { iata: 'VIE', icao: 'LOWW', name: 'Vienna', tz: 'Europe/Vienna', country: 'AT', terminals: ['1', '1A', '2', '3'], gatePattern: '^[A-Z]\\d{1,3}[A-Z]?$', schedule: SCHEDULE },
};

// The eight airport models of the maps layer (airportmaps/data/<iata>/airport.json), bundled into the extension. LHR replaced
// IST on 2026-11-02 (owner decision); airportmaps/data/ist stays in the repo for history but is not bundled.
// The maps layer is developed in its own branch (airportmaps/eight-airports); merge it to pick up new data.
import type { AirportModel } from '../../../airportmaps/src/types.ts';
import AMS from '../../../airportmaps/data/ams/airport.json';
import CDG from '../../../airportmaps/data/cdg/airport.json';
import FCO from '../../../airportmaps/data/fco/airport.json';
import FRA from '../../../airportmaps/data/fra/airport.json';
import LHR from '../../../airportmaps/data/lhr/airport.json';
import MAD from '../../../airportmaps/data/mad/airport.json';
import MUC from '../../../airportmaps/data/muc/airport.json';
import ZRH from '../../../airportmaps/data/zrh/airport.json';

export const MODELS: Record<string, AirportModel> = { AMS, CDG, FCO, FRA, LHR, MAD, MUC, ZRH } as unknown as Record<string, AirportModel>;

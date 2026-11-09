// Loads every airport model bundled under airportmaps/data/<iata>/ (an airport appears as soon as its files exist).
import type { AirportModel, EvidenceFile } from '../src/types.ts';

const models = import.meta.glob('../data/*/airport.json', { eager: true, import: 'default' }) as Record<string, AirportModel>;
const evidence = import.meta.glob('../data/*/evidence.json', { eager: true, import: 'default' }) as Record<string, EvidenceFile>;

const code = (p: string) => p.split('/').at(-2)!.toLowerCase();
export const AIRPORTS: Record<string, AirportModel> = Object.fromEntries(Object.entries(models).map(([p, m]) => [code(p), m]));
export const EVIDENCE: Record<string, EvidenceFile> = Object.fromEntries(Object.entries(evidence).map(([p, e]) => [code(p), e]));

// The research evidence files (airportmaps/data/<iata>/evidence.json) are kept in the private research repository
// only; the public snapshot ships the airport models without them. Tests that check evidence skip when it is absent.
import fs from 'node:fs';
import path from 'node:path';
import type { EvidenceFile } from '../../airportmaps/src/types.ts';

export function loadEvidence(iata: string): EvidenceFile | undefined {
  const p = path.join(import.meta.dirname, '..', '..', 'airportmaps', 'data', iata.toLowerCase(), 'evidence.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as EvidenceFile) : undefined;
}

/** The evidence file, or an empty one with the same shape (for code paths that only filter its items). */
export const evidenceOrEmpty = (iata: string): { file: EvidenceFile | undefined; ev: EvidenceFile } => {
  const file = loadEvidence(iata);
  return { file, ev: file ?? ({ iata: iata.toUpperCase(), items: [] } as unknown as EvidenceFile) };
};

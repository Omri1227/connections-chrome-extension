// Shared by the CLI and the server.
import { ADAPTERS } from './adapters/index.ts';
import { AIRPORTS } from './airports.ts';
import type { Db } from './db.ts';
import { upsertAirport, upsertSource } from './store.ts';

/** Writes airport and source metadata (idempotent), so the dashboard can show terms and capabilities. */
export async function syncMetadata(db: Db, enabled: string[]) {
  for (const a of Object.values(AIRPORTS)) await upsertAirport(db, a, enabled.includes(a.iata));
  for (const s of Object.values(ADAPTERS)) await upsertSource(db, s.info);
}

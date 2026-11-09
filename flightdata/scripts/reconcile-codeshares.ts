// One-off repair (2026-11-01) of flight-days stored before reconcileSuperseded ran after every collection: codeshare
// listings that one snapshot could not link (a duplicated operator row in that response) or marked as an operator,
// while a later snapshot linked them to another movement at the same instant (AMS 2026-10-31: VS6991 → KL941,
// KL209 → CI74). Prints what would be removed; --apply removes it. Run with the server stopped (PGlite: one process).
//   npx tsx flightdata/scripts/reconcile-codeshares.ts [--apply]
import { localDataDir } from '../src/config.ts';
import { migrate, openDb } from '../src/db.ts';
import { markDuplicates, reconcileSuperseded } from '../src/store.ts';

const apply = process.argv.includes('--apply');
const db = await openDb(process.env.FD_PGLITE_DIR ?? localDataDir('pg'));
await migrate(db);
const airports = (await db.query<{ airport: string }>('SELECT DISTINCT airport FROM fd_flights ORDER BY 1')).map((r) => r.airport);
let total = 0;
for (const airport of airports) {
  // Repeated until stable: a chain (A superseded by B, B by C) is resolved one link per pass.
  for (let pass = 1; pass <= 5; pass++) {
    const xs = await reconcileSuperseded(db, { airport, dryRun: !apply });
    if (!xs.length) break;
    total += xs.length;
    console.log(`${airport} pass ${pass}: ${xs.length} superseded flight-days`, xs.slice(0, 15).map((x) => `${x.flightKey}@${x.scheduledUtc.slice(0, 16)} → ${x.by}`).join(', '));
    if (!apply) break;
  }
}
console.log(apply ? `removed ${total} flight-days` : `${total} flight-days would be removed (dry run; --apply to remove)`);
// Duplicate marks (migration 005) for every stored date: verified codeshares and same-aircraft groups. Marks only, no
// deletion; collection recomputes them for each date it collects, so this matters only for dates not collected again.
if (apply) {
  const days = await db.query<{ airport: string; direction: string; d: string }>('SELECT DISTINCT airport, direction, local_date::text AS d FROM fd_flights ORDER BY 1, 2, 3');
  const marks = [];
  for (const k of new Set(days.map((x) => `${x.airport}|${x.direction}`))) {
    const [airport, direction] = k.split('|');
    marks.push(...await markDuplicates(db, { airport, direction, dates: days.filter((x) => x.airport === airport && x.direction === direction).map((x) => x.d) }));
  }
  console.log(`marked ${marks.length} duplicate flight-days`, marks.slice(0, 15).map((m) => `${m.flightKey} = ${m.of} (${m.reason})`).join(', '));
}
await db.close();

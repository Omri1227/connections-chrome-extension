// One-off repair (2026-10-31): the first AeroDataBox runs stored route-less codeshare rows (AMS: ~1,200 a run) as
// separate 'listed' flights because the parser could only link codeshares by route. The parser now links them by
// time + terminal + gate, so these rows duplicate operating flights. This deletes listed flights that have no other
// airport and only marketing observations. Run with the server stopped (PGlite: one process).
//   npx tsx flightdata/scripts/cleanup-routeless-codeshares.ts [--apply]
import { openDb } from '../src/db.ts';
import { localDataDir } from '../src/config.ts';

const db = await openDb(process.env.FD_PGLITE_DIR ?? localDataDir('pg'));
const sel = `SELECT f.id FROM fd_flights f
  WHERE f.identity='listed' AND (CASE WHEN f.direction='arrival' THEN f.origin ELSE f.destination END) IS NULL
    AND NOT EXISTS (SELECT 1 FROM fd_observations o WHERE o.flight_id=f.id AND o.role <> 'marketing')`;
const by = await db.query(`SELECT airport, count(*)::int AS n FROM fd_flights WHERE id IN (${sel}) GROUP BY 1 ORDER BY 2 DESC`);
console.log('route-less listed codeshare flights:', by);
if (process.argv.includes('--apply')) {
  await db.tx(async (t) => {
    const ids = (await t.query<{ id: string }>(sel)).map((r) => Number(r.id));
    await t.query('DELETE FROM fd_observations WHERE flight_id = ANY($1::bigint[])', [ids]);
    await t.query('DELETE FROM fd_flight_codes WHERE flight_id = ANY($1::bigint[])', [ids]);
    await t.query('DELETE FROM fd_flights WHERE id = ANY($1::bigint[])', [ids]);
    console.log(`deleted ${ids.length} flights`);
  });
}
await db.close();

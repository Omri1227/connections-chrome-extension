// Proof-of-concept collection for one airport/source: runs the real collector (both directions, the given dates) into a
// separate PoC database and writes coverage metrics (no raw content) to data/research/flightdata/poc-<airport>.json.
//   npx tsx flightdata/scripts/poc.ts --airport FCO --source adr-fco-web --dates 2026-10-29,2026-10-30
// Only for sources whose terms allow it (research doc §4); keyed sources need their key in the environment.
import fs from 'node:fs';
import path from 'node:path';
import { resolveAssignments } from '../src/adapters/index.ts';
import { syncMetadata } from '../src/cli-shared.ts';
import { collect } from '../src/collector.ts';
import { loadConfig, localDataDir, ROOT } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { acquireLock } from '../src/lock.ts';
import type { Direction } from '../src/types.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const airport = (arg('airport') ?? '').toUpperCase(), source = arg('source') ?? '';
const dates = (arg('dates') ?? '').split(',').filter(Boolean);
const dir = arg('db', localDataDir('poc'))!;

async function main() {
  if (!airport || !source || !dates.length) throw new Error('usage: --airport FCO --source adr-fco-web --dates YYYY-MM-DD[,YYYY-MM-DD]');
  const cfg = loadConfig();
  const [{ airport: a, adapter }] = resolveAssignments([{ airport, source }]);
  const why = adapter.notReady(cfg.env); if (why) throw new Error(why);
  const release = acquireLock(dir, 'poc');
  const db = await openDb(dir);
  await syncMetadata(db, []);
  const log = (e: string, d: Record<string, unknown> = {}) => console.log(JSON.stringify({ e, ...d }));
  const started = new Date();
  const runs = [];
  for (const date of dates) for (const direction of ['arrival', 'departure'] as Direction[])
    runs.push(await collect(db, { airport: a, adapter, direction, targetDate: date, slot: `test:${started.toISOString()}`, trigger: 'test' }, { fetch, now: () => new Date(), env: cfg.env, log }));

  // Metrics per date × direction, from what was stored.
  const per = await db.query(`
    WITH d AS (
      SELECT f.id, f.direction, f.local_date::text AS date, f.identity,
        (array_agg(o.terminal ORDER BY o.last_seen_at DESC) FILTER (WHERE o.terminal IS NOT NULL))[1] AS terminal,
        (array_agg(o.gate ORDER BY o.last_seen_at DESC) FILTER (WHERE o.gate IS NOT NULL))[1] AS gate,
        (array_agg(o.status ORDER BY o.last_seen_at DESC))[1] AS status
      FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id WHERE f.airport=$1 AND o.source_id=$2 GROUP BY f.id)
    SELECT date, direction, count(*)::int AS physical_flights,
      count(*) FILTER (WHERE identity='listed')::int AS unlinked_listings,
      count(*) FILTER (WHERE terminal IS NOT NULL)::int AS with_terminal,
      count(*) FILTER (WHERE gate IS NOT NULL)::int AS with_gate,
      count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      json_object_agg(COALESCE(terminal,'(none)'), 1) AS terminals_seen
    FROM d GROUP BY date, direction ORDER BY date, direction`, [airport, source]);
  const terminals = await db.query(`SELECT f.direction, o.terminal, count(DISTINCT f.id)::int n FROM fd_flights f JOIN fd_observations o ON o.flight_id=f.id WHERE f.airport=$1 GROUP BY 1,2 ORDER BY 1,3 DESC`, [airport]);
  const codes = await db.query(`SELECT role, count(*)::int n FROM fd_flight_codes c JOIN fd_flights f ON f.id=c.flight_id WHERE f.airport=$1 GROUP BY 1`, [airport]);
  const findings = await db.query(`SELECT kind, severity, detail->>'pattern' AS pattern, (detail->>'count')::int AS count FROM fd_quality_findings q JOIN fd_collection_runs r ON r.id=q.run_id WHERE r.slot=$1 ORDER BY kind`, [`test:${started.toISOString()}`]);
  const runRows = await db.query(`SELECT direction, target_date::text date, status, windows_ok, windows_expected, pages_fetched, bytes_fetched, rows_raw, rows_normalised, rows_rejected, flights_seen, completeness->'duplicates' AS duplicates, warnings, diagnostics->'windows' AS windows FROM fd_collection_runs WHERE slot=$1 ORDER BY id`, [`test:${started.toISOString()}`]);
  const report = {
    airport, source, generatedAt: new Date().toISOString(), dates,
    note: 'Metrics only (no raw content). physical_flights = stored movements after codeshare linking; rows_raw = board rows incl. codeshare rows.',
    runs: runRows, perDay: per.map((p: any) => ({ ...p, pctTerminal: pct(p.with_terminal, p.physical_flights), pctGate: pct(p.with_gate, p.physical_flights) })),
    terminals, codes, findings, summaries: runs,
  };
  const out = path.join(ROOT, 'data', 'research', 'flightdata', `poc-${airport}-${source}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ e: 'poc.written', out, perDay: report.perDay }, null, 1));
  await db.close(); release();
}
const pct = (k: number, n: number) => (n ? Number(((100 * k) / n).toFixed(1)) : null);
main().catch((e) => { console.error(e); process.exitCode = 1; });

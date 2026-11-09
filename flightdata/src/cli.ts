// Flight-data command line (npm run fd -- <command>):
//   status                                     airports, sources, recent runs
//   collect --airport FCO [--source id] [--date YYYY-MM-DD] [--direction arrival|departure|both] [--trigger manual|test]
//   tick                                       collect every due slot once (what cron runs)
//   loop [--minutes 15]                        tick forever (local operation; Ctrl-C to stop)
//   sweep                                      licence-driven retention (roll up + purge)
//   export --out file.jsonl | import --in file.jsonl     move data between databases (e.g. local PGlite → PostgreSQL)
//   restore --in fd-backup-YYYY-MM-DD.tar.gz --to <new dir>   rebuild a PGlite directory from a daily backup
//   import-counters --in fd-counters-YYYY-MM-DD.json.gz        add monthly counters from a counters backup (existing kept)
// Logs are JSON lines on stdout. Secrets are never printed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ADAPTERS, resolveAssignments } from './adapters/index.ts';
import { importCounters } from './backup.ts';
import { syncMetadata } from './cli-shared.ts';
import { collect } from './collector.ts';
import { describeDb, loadConfig } from './config.ts';
import { openDb, restorePglite, type Db } from './db.ts';
import { acquireLock } from './lock.ts';
import { sweepRetention } from './retention.ts';
import { tick } from './scheduler.ts';
import { localDate } from './time.ts';
import type { Direction, FetchContext } from './types.ts';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d; };
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

export async function openForCli(what: string): Promise<{ db: Db; release: () => void }> {
  const cfg = loadConfig();
  const release = /^postgres/.test(cfg.database) || cfg.database === ':memory:' ? () => {} : acquireLock(cfg.database, what);
  const db = await openDb(cfg.database);
  log('db.open', { target: describeDb(cfg.database), kind: db.kind });
  return { db, release };
}


const TABLES = ['fd_airports', 'fd_airlines', 'fd_sources', 'fd_collection_runs', 'fd_flights', 'fd_flight_codes', 'fd_observations', 'fd_sightings', 'fd_quality_findings', 'fd_derived_counts'];

async function main() {
  const cfg = loadConfig();
  const ctx: FetchContext = { fetch, now: () => new Date(), env: cfg.env, log };
  if (cmd === 'help' || cmd === '--help') { console.log(fs.readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); return; }
  if (cmd === 'restore') {
    // Into a NEW directory, never over the live database; then point FD_PGLITE_DIR at it (or swap directories by hand).
    const inFile = opt('in'), to = opt('to');
    if (!inFile || !to) throw new Error('restore needs --in <fd-backup-….tar.gz> and --to <new directory>');
    await restorePglite(new Uint8Array(fs.readFileSync(inFile)), to);
    const db = await openDb(to);
    const n = await db.query<{ t: string; n: number }>(`SELECT 'flights' t, count(*)::int n FROM fd_flights UNION ALL SELECT 'observations', count(*)::int FROM fd_observations UNION ALL SELECT 'runs', count(*)::int FROM fd_collection_runs UNION ALL SELECT 'derived counters', count(*)::int FROM fd_derived_counts`);
    await db.close();
    log('restore.done', { to, counts: Object.fromEntries(n.map((r) => [r.t, r.n])) });
    return;
  }
  const { db, release } = await openForCli(cmd);
  try {
    await syncMetadata(db, cfg.assignments.map((x) => x.airport));
    if (cmd === 'status') {
      const runs = await db.query(`SELECT airport, source_id, direction, target_date::text d, slot, status, flights_seen, with_terminal, with_gate, started_at FROM fd_collection_runs ORDER BY started_at DESC LIMIT 12`);
      const counts = await db.query(`SELECT airport, direction, count(*)::int flights FROM fd_flights GROUP BY 1,2 ORDER BY 1,2`);
      const assignments = cfg.assignments.map((a) => ({ ...a, notReady: ADAPTERS[a.source]?.notReady(cfg.env) ?? 'unknown source' }));
      console.log(JSON.stringify({ database: describeDb(cfg.database), assignments, flights: counts, recentRuns: runs }, null, 2));
    } else if (cmd === 'collect') {
      const airport = (opt('airport') ?? '').toUpperCase();
      const source = opt('source') ?? cfg.assignments.find((x) => x.airport === airport)?.source;
      if (!airport || !source) throw new Error('collect needs --airport and --source (or an FD_ASSIGNMENTS entry)');
      const [{ airport: a, adapter }] = resolveAssignments([{ airport, source }]);
      const why = adapter.notReady(cfg.env);
      if (why) throw new Error(why);
      const date = opt('date') ?? localDate(new Date(), a.tz);
      const dirs: Direction[] = (opt('direction', 'both') === 'both' ? ['arrival', 'departure'] : [opt('direction') as Direction]);
      const trigger = (opt('trigger', 'manual') as 'manual' | 'test');
      for (const direction of dirs) {
        const r = await collect(db, { airport: a, adapter, direction, targetDate: date, slot: `${trigger}:${new Date().toISOString()}`, trigger }, ctx);
        log('collect.result', r as any);
      }
    } else if (cmd === 'tick' || cmd === 'loop') {
      const assignments = resolveAssignments(cfg.assignments);
      if (!assignments.length) log('tick.nothing-assigned', { hint: 'set FD_ASSIGNMENTS (see .env.example); only approved sources should be listed' });
      const once = async () => {
        const r = await tick(db, assignments, { ...ctx, now: () => new Date() }, { graceHours: cfg.graceHours });
        const swept = await sweepRetention(db, new Date(), { rawSampleDays: cfg.rawRetentionDays });
        log('tick.done', { due: r.due, runs: r.runs.map((x) => `${x.key}: ${x.status}`), notReady: r.notReady, reaped: r.reaped, retention: swept.filter((s) => s.flightsRolled || s.rawSamplesDeleted) });
      };
      await once();
      if (cmd === 'loop') {
        const minutes = Number(opt('minutes', String(cfg.tickMinutes)));
        log('loop.start', { minutes });
        let busy = false;
        await new Promise<void>((resolve) => {
          const timer = setInterval(async () => { if (busy) return; busy = true; try { await once(); } catch (e) { log('tick.error', { error: (e as Error).message }); } finally { busy = false; } }, minutes * 60_000);
          const stop = () => { clearInterval(timer); resolve(); };
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
        });
      }
    } else if (cmd === 'sweep') {
      log('sweep.done', { result: await sweepRetention(db, new Date(), { rawSampleDays: cfg.rawRetentionDays }) });
    } else if (cmd === 'export') {
      const out = opt('out'); if (!out) throw new Error('--out file.jsonl');
      const fd = fs.openSync(out, 'w');
      for (const t of TABLES) for (const row of await db.query(`SELECT * FROM ${t}`)) fs.writeSync(fd, JSON.stringify({ table: t, row }) + '\n');
      fs.closeSync(fd);
      log('export.done', { out });
    } else if (cmd === 'import') {
      const inp = opt('in'); if (!inp) throw new Error('--in file.jsonl');
      const lines = fs.readFileSync(inp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      await db.tx(async (t) => {
        for (const tb of TABLES) for (const { row } of lines.filter((l) => l.table === tb)) {
          const cols = Object.keys(row);
          await t.query(`INSERT INTO ${tb} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`, cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
        }
        for (const [tb, col] of [['fd_collection_runs', 'id'], ['fd_flights', 'id'], ['fd_observations', 'id'], ['fd_quality_findings', 'id']])
          await t.query(`SELECT setval(pg_get_serial_sequence('${tb}','${col}'), GREATEST((SELECT COALESCE(max(${col}),0) FROM ${tb}),1))`);
      });
      log('import.done', { rows: lines.length });
    } else if (cmd === 'import-counters') {
      const inp = opt('in'); if (!inp) throw new Error('--in fd-counters-YYYY-MM-DD.json.gz');
      log('import-counters.done', await importCounters(db, JSON.parse(zlib.gunzipSync(fs.readFileSync(inp)).toString('utf8'))));
    } else throw new Error(`unknown command ${cmd} (try: help)`);
  } finally {
    await db.close();
    release();
  }
}

main().catch((e) => { log('error', { error: (e as Error).message }); process.exitCode = 1; });

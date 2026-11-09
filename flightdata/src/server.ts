// Flight-data research server: the read-only research API (+ the built dashboard) and, with FD_SCHEDULER=on, the
// collection tick loop in the same process (needed locally: PGlite allows one process per database directory).
// npm run fd:server   →   http://127.0.0.1:8790 (dashboard dev server: npm run fd:dashboard → http://localhost:5174)
import http from 'node:http';
import path from 'node:path';
import { resolveAssignments } from './adapters/index.ts';
import { createFdApp } from './api.ts';
import { dailyBackup } from './backup.ts';
import { syncMetadata } from './cli-shared.ts';
import { describeDb, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { acquireLock } from './lock.ts';
import { sweepRetention } from './retention.ts';
import { tick } from './scheduler.ts';

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

async function main() {
  const cfg = loadConfig();
  const pglite = !/^postgres/.test(cfg.database);
  const release = pglite ? acquireLock(cfg.database, 'fd server') : () => {};
  const db = await openDb(cfg.database);
  await syncMetadata(db, cfg.assignments.map((x) => x.airport));
  const assignments = resolveAssignments(cfg.assignments);
  const server = http.createServer(createFdApp({ db, adminToken: cfg.adminToken, staticDir: cfg.staticDir, assignments: cfg.assignments, env: cfg.env, dbDir: /^postgres/.test(cfg.database) ? null : cfg.database }));
  server.listen(cfg.port, cfg.host, () => log('server.listen', { url: `http://${cfg.host}:${cfg.port}`, db: describeDb(cfg.database), scheduler: cfg.scheduler, assignments: cfg.assignments, tokenGenerated: cfg.adminTokenGenerated }));
  if (cfg.adminTokenGenerated) console.log(`No FD_ADMIN_TOKEN/ADMIN_TOKEN set; this run's token is: ${cfg.adminToken}`);

  let timer: NodeJS.Timeout | null = null;
  if (cfg.scheduler) {
    let busy = false;
    const once = async () => {
      if (busy) return; busy = true;
      try {
        const r = await tick(db, assignments, { fetch, now: () => new Date(), env: cfg.env, log }, { graceHours: cfg.graceHours });
        const swept = await sweepRetention(db, new Date(), { rawSampleDays: cfg.rawRetentionDays });
        // Only real work is logged: slots already collected come back as 'skipped' on every tick of the grace window.
        const runs = r.runs.filter((x) => x.status !== 'skipped');
        if (runs.length || r.notReady.length || swept.some((s) => s.flightsRolled)) log('tick.done', { runs: runs.map((x) => `${x.key}: ${x.status}`), notReady: r.notReady, retention: swept.filter((s) => s.flightsRolled) });
        const b = await dailyBackup(db, new Date(), { dataDir: pglite ? path.dirname(cfg.database) : null });
        if (b.written || b.countersWritten || b.removed.length || b.error) log('backup', { ...b });
      } catch (e) { log('tick.error', { error: (e as Error).message }); } finally { busy = false; }
    };
    void once();
    timer = setInterval(once, cfg.tickMinutes * 60_000);
  }
  const stop = async () => { if (timer) clearInterval(timer); server.close(); await db.close(); release(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

main().catch((e) => { log('error', { error: (e as Error).message }); process.exit(1); });

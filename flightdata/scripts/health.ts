// Operational health check: npm run fd:health   (add --json for the raw report)
// Asks the running server (http://127.0.0.1:FD_PORT/fd-api/ops, token from .env, never printed); if no server
// answers, opens the database directly. Exit code 1 when something needs attention (missed slots, failures,
// budget ≥ 90 %, no backup in 2 days, duplicate runs, nothing collected in 24 h).
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { acquireLock } from '../src/lock.ts';
import { opsHealth } from '../src/ops.ts';

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
let report: any, via: string;
try {
  const live = await fetch(`${base}/fd-api/health`, { signal: AbortSignal.timeout(3000) });
  if (!live.ok) throw new Error('not ok');
  const r = await fetch(`${base}/fd-api/ops`, { headers: { Authorization: `Bearer ${cfg.adminToken}` } });
  if (!r.ok) throw new Error(`server answered HTTP ${r.status} for /fd-api/ops`);
  report = await r.json(); via = `running server ${base}`;
} catch (e) {
  if ((e as Error).message.startsWith('server answered')) throw e;
  const release = /^postgres/.test(cfg.database) ? () => {} : acquireLock(cfg.database, 'health check');
  const db = await openDb(cfg.database);
  report = await opsHealth(db, { assignments: cfg.assignments, env: cfg.env, now: new Date(), graceHours: cfg.graceHours, dbDir: cfg.database });
  await db.close(); release(); via = 'database (no server running: COLLECTION IS NOT RUNNING)';
}
if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : '—');
const ago = (iso: string | null) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 60_000)} min ago` : 'never');
const problems: string[] = [];
console.log(`Flight-data collector health — ${new Date(report.now).toLocaleString('en-GB')} (via ${via})\n`);
// Coverage over completed days only (collected again after the day ended): today's gates are still incomplete.
console.log('Airport  Last success     Next slot (UTC)    Flight-days  Dep T/G done Arr T/G done Slots ok/late/partial/missed/pending  Failed 24h');
for (const a of report.airports) {
  const none = { flightDays: 0, withTerminal: 0, withGate: 0 }, cov = a.coverageFinal ?? a.coverage7d;
  const d = cov.departure ?? none, r = cov.arrival ?? none;
  const s = a.slots;
  console.log([a.airport.padEnd(8), ago(a.lastSuccess).padEnd(16), (a.nextSlot ?? '—').slice(5, 16).replace('T', ' ').padEnd(18), String(a.flightDaysTotal).padStart(11),
    `  ${pct(d.withTerminal, d.flightDays)}/${pct(d.withGate, d.flightDays)}`.padEnd(13), ` ${pct(r.withTerminal, r.flightDays)}/${pct(r.withGate, r.flightDays)}`.padEnd(13),
    `  ${s.collected}/${s.late}/${s.partial}/${s.missed}/${s.pending}`.padEnd(38), String(a.failedRuns24h).padStart(10)].join(' '));
  if (s.missed || s.partial) problems.push(`${a.airport}: ${s.missed} missed, ${s.partial} partial slot(s): ${a.problemSlots.filter((x: any) => x.state !== 'late').map((x: any) => x.slot).join(', ')}`);
  if (!a.lastSuccess || Date.now() - Date.parse(a.lastSuccess) > 24 * 36e5) problems.push(`${a.airport}: no successful run in 24 h`);
  if (a.failedRuns24h) problems.push(`${a.airport}: ${a.failedRuns24h} failed run(s) in 24 h (see dashboard → Collection runs)`);
}
console.log('');
for (const b of report.budgets) {
  console.log(`API units (${b.source}): ${b.used} of ${b.budget} in the last ${b.periodDays} days (${pct(b.used, b.budget)}); plan hard limit 5,000 — compare with the API.Market dashboard`);
  if (b.used >= b.budget * 0.9) problems.push(`${b.source}: ${b.used} of ${b.budget} units used`);
}
const lastBackup = report.backups.at(-1);
console.log(`Backups: ${report.backups.length} (latest ${lastBackup ? `${lastBackup.file}, ${(lastBackup.bytes / 1e6).toFixed(1)} MB` : 'none'})   Database: ${report.databaseBytes ? `${(report.databaseBytes / 1e6).toFixed(0)} MB` : '—'}   Duplicate runs: ${report.duplicateRuns}`);
if (!lastBackup || Date.now() - Date.parse(lastBackup.at) > 48 * 36e5) problems.push('no backup in the last 2 days');
const rt = report.retention;
if (rt) {
  const age = rt.oldestRawRow ? (Date.now() - Date.parse(rt.oldestRawRow)) / 864e5 : 0;
  console.log(`Raw data: oldest row ${age.toFixed(1)} days (rolled up after ${rt.rawRollupDays} d; licence limit ${rt.rawLimitDays} d; ${rt.fullBackupsKept} full backups kept)   Counter backups: ${(report.counterBackups ?? []).length}`);
  if (age > rt.rawRollupDays + 1) problems.push(`raw rows ${age.toFixed(1)} days old: the retention sweep is not keeping up`);
}
for (const c of report.manualCopies ?? []) console.log(`Manual database copy ${c.dir}: contains raw rows; deleted automatically on ${c.deleteBy.slice(0, 16).replace('T', ' ')} UTC`);
if (report.duplicateRuns) problems.push(`${report.duplicateRuns} slot(s) collected twice`);
if (via.startsWith('database')) problems.push('the collector is not running (start: Start-ScheduledTask -TaskName "CDG Navigator flight data")');
console.log(problems.length ? `\nNEEDS ATTENTION:\n- ${problems.join('\n- ')}` : '\nAll OK.');
process.exit(problems.length ? 1 : 0);

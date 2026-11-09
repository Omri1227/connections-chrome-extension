// Daily local backups in %LOCALAPPDATA%\cdg-navigator\flightdata\backups, taken by the server between ticks:
//   - fd-backup-YYYY-MM-DD.tar.gz    the whole PGlite database (restore: `npm run fd -- restore`). It contains raw
//     AeroDataBox rows, so only the newest BACKUP_KEEP are kept (see RAW_LIMIT below);
//   - fd-counters-YYYY-MM-DD.json.gz the monthly counters (fd_derived_counts) only: no raw rows, no dates, so they may
//     be kept longer (COUNTERS_KEEP) and copied off the machine (restore: `npm run fd -- import-counters`).
//
// Licence (AeroDataBox Terms §5.5): raw Contents at most 7 consecutive days. Raw rows are rolled up when older than
// RAW_ROLLUP_DAYS, and a full backup is deleted before it is BACKUP_KEEP days old, so no copy of a raw row is ever older
// than RAW_ROLLUP_DAYS + BACKUP_KEEP (+ one tick) = 6 days < 7. Manual database copies (pg.backup-YYYY-MM-DD…) made next
// to the live database expire on the same rule: they are deleted once they could contain a raw row 6 days old.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Db } from './db.ts';
import { localDataDir } from './config.ts';
import { BACKUP_KEEP, DEFAULT_SAFETY_DAYS } from './retention.ts';

export { BACKUP_KEEP };
export const BACKUP_DIR = localDataDir('backups');
export const RAW_LIMIT_DAYS = 7;
export const RAW_ROLLUP_DAYS = RAW_LIMIT_DAYS - DEFAULT_SAFETY_DAYS;
export const COUNTERS_KEEP = 60;
const NAME = /^fd-backup-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
const COUNTERS = /^fd-counters-(\d{4}-\d{2}-\d{2})\.json\.gz$/;
const MANUAL = /^pg\.backup-(\d{4}-\d{2}-\d{2})/;
const DAY = 86_400_000;

const list = (dir: string, re: RegExp) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, date: re.exec(f)![1], bytes: st.size, at: st.mtime.toISOString() };
  });
};
export const listBackups = (dir = BACKUP_DIR) => list(dir, NAME);
export const listCounterBackups = (dir = BACKUP_DIR) => list(dir, COUNTERS);

/**
 * Manual full-database copies next to the live database (e.g. pg.backup-2026-10-31-before-codeshare-cleanup). The
 * oldest raw row a copy can hold is RAW_ROLLUP_DAYS older than the copy, but never older than the first collection.
 */
export function manualCopies(dataDir: string, firstCollection: Date | null, now: Date) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory() && MANUAL.test(e.name)).map((e) => {
    const made = fs.statSync(path.join(dataDir, e.name)).mtime;
    const oldest = Math.max(made.getTime() - RAW_ROLLUP_DAYS * DAY, firstCollection?.getTime() ?? 0);
    const deleteBy = new Date(oldest + (RAW_LIMIT_DAYS - 1) * DAY);
    return { dir: e.name, made: made.toISOString(), deleteBy: deleteBy.toISOString(), expired: now >= deleteBy };
  });
}

export interface BackupResult { written: string | null; countersWritten: string | null; removed: string[]; error: string | null }

/** Writes today's backups if they do not exist yet, rotates, expires manual copies. Never throws (errors are returned). */
export async function dailyBackup(db: Db, now: Date, opts: { dir?: string; keep?: number; countersKeep?: number; dataDir?: string | null } = {}): Promise<BackupResult> {
  const dir = opts.dir ?? BACKUP_DIR, keep = opts.keep ?? BACKUP_KEEP, countersKeep = opts.countersKeep ?? COUNTERS_KEEP;
  const out: BackupResult = { written: null, countersWritten: null, removed: [], error: null };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const day = now.toISOString().slice(0, 10);
    const write = (file: string, bytes: Uint8Array) => { const tmp = path.join(dir, `${file}.tmp`); fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, path.join(dir, file)); };
    const cfile = `fd-counters-${day}.json.gz`;
    if (!fs.existsSync(path.join(dir, cfile))) {
      write(cfile, zlib.gzipSync(JSON.stringify(await exportCounters(db))));
      out.countersWritten = cfile;
    }
    if (db.dumpDataDir) {   // PostgreSQL server: use pg_dump instead
      const file = `fd-backup-${day}.tar.gz`;
      if (!fs.existsSync(path.join(dir, file))) { write(file, await db.dumpDataDir()); out.written = file; }
    }
    for (const [all, n] of [[listBackups(dir), keep], [listCounterBackups(dir), countersKeep]] as const) {
      for (const b of all.slice(0, Math.max(all.length - n, 0))) { fs.unlinkSync(path.join(dir, b.file)); out.removed.push(b.file); }
    }
    if (opts.dataDir) {
      const first = (await db.query<{ t: Date | null }>('SELECT min(started_at) AS t FROM fd_collection_runs'))[0]?.t ?? null;
      for (const c of manualCopies(opts.dataDir, first ? new Date(first) : null, now).filter((x) => x.expired)) {
        fs.rmSync(path.join(opts.dataDir, c.dir), { recursive: true, force: true });
        out.removed.push(c.dir);
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

export interface CountersFile { format: 'fd-counters-v1'; exportedAt: string; rows: Record<string, unknown>[] }

export async function exportCounters(db: Db): Promise<CountersFile> {
  const rows = await db.query(`SELECT source_id, airport, direction, flight_key, carrier, other, month::text AS month, field, value, n FROM fd_derived_counts ORDER BY source_id, airport, direction, flight_key, other, month, field, value`);
  return { format: 'fd-counters-v1', exportedAt: new Date().toISOString(), rows };
}

/** Restores counters into a database that has none for the same keys (existing keys are left as they are). */
export async function importCounters(db: Db, file: CountersFile): Promise<{ inserted: number; skipped: number }> {
  if (file.format !== 'fd-counters-v1') throw new Error('not an fd-counters-v1 file');
  let inserted = 0;
  await db.tx(async (t) => {
    for (const r of file.rows as any[]) {
      const x = await t.query(`INSERT INTO fd_derived_counts (source_id, airport, direction, flight_key, carrier, other, month, field, value, n) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (source_id, airport, direction, flight_key, other, month, field, value) DO NOTHING RETURNING 1`,
        [r.source_id, r.airport, r.direction, r.flight_key, r.carrier, r.other, r.month, r.field, r.value, r.n]);
      inserted += x.length;
    }
  });
  return { inserted, skipped: file.rows.length - inserted };
}

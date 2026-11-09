// Database access. One SQL dialect (PostgreSQL) everywhere:
//   - FD_DATABASE_URL=postgres://…   → a PostgreSQL server through `pg` (production, e.g. Railway);
//   - otherwise FD_PGLITE_DIR (default data/flightdata/pg) → PGlite, PostgreSQL compiled to WASM, in-process (local);
//   - ':memory:' → in-memory PGlite (tests).
// PGlite allows one process per data directory, so local use takes a lock file (see lock.ts).
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'migrations');

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs fn in a transaction on one connection; fn must use the Db it is given. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'pglite' | 'postgres';
  /** PGlite only: a consistent gzip tarball of the whole data directory (restorable with restorePglite). */
  dumpDataDir?: () => Promise<Uint8Array>;
}

/** Creates a PGlite data directory from a dumpDataDir() tarball. The target directory must not exist yet. */
export async function restorePglite(tarball: Uint8Array, dir: string): Promise<void> {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty: restore into a new directory`);
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite(dir, { loadDataDir: new Blob([tarball]) });
  await pg.waitReady;
  await pg.close();
}

export async function openDb(target: string): Promise<Db> {
  const db = /^postgres(ql)?:\/\//.test(target) ? await openPg(target) : await openPglite(target);
  await migrate(db);
  return db;
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== ':memory:') fs.mkdirSync(dir, { recursive: true });
  const pg = dir === ':memory:' ? new PGlite() : new PGlite(dir);
  await pg.waitReady;
  let chain: Promise<unknown> = Promise.resolve();
  // PGlite is single-connection: serialise transactions so concurrent callers cannot interleave inside one.
  const wrap = (q: { query: typeof pg.query; exec: typeof pg.exec }, inTx: boolean): Db => ({
    kind: 'pglite',
    async query(sql, params = []) { return (await q.query(sql, params as any[])).rows as any[]; },
    async exec(sql) { await q.exec(sql); },
    async tx(fn) {
      if (inTx) return fn(this);
      const run = chain.then(() => pg.transaction(async (t) => fn(wrap(t as any, true))));
      chain = run.catch(() => undefined);
      return run as any;
    },
    async close() { if (!inTx) await pg.close(); },
  });
  const db = wrap(pg, false);
  // Serialised with transactions, so the tarball is never taken in the middle of a write.
  db.dumpDataDir = async () => {
    const run = chain.then(async () => new Uint8Array(await (await pg.dumpDataDir('gzip')).arrayBuffer()));
    chain = run.catch(() => undefined);
    return run;
  };
  return db;
}

async function openPg(url: string): Promise<Db> {
  const { default: pgmod } = await import('pg');
  const pool = new pgmod.Pool({ connectionString: url, max: 4, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }, inTx: boolean): Db => ({
    kind: 'postgres',
    async query(sql, params = []) { return (await q.query(sql, params)).rows; },
    async exec(sql) { await q.query(sql); },
    async tx(fn) {
      if (inTx) return fn(this);
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(wrap(c, true)); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
      finally { c.release(); }
    },
    async close() { if (!inTx) await pool.end(); },
  });
  return wrap(pool, false);
}

/** Applies the numbered .sql files in flightdata/migrations once each, in order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS fd_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM fd_schema_migrations')).map((r) => r.version));
  const applied: string[] = [];
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    await db.tx(async (t) => { await t.exec(sql); await t.query('INSERT INTO fd_schema_migrations (version) VALUES ($1)', [f]); });
    applied.push(f);
  }
  return applied;
}

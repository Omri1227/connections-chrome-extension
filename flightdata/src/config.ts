// Flight-data platform configuration (environment variables, optionally from the repository's git-ignored .env).
// Secrets (API keys, tokens, database URLs) are only ever read from the environment, never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

export interface FdConfig {
  database: string;              // postgres:// URL, a PGlite directory, or ':memory:'
  port: number;
  host: string;
  adminToken: string;
  adminTokenGenerated: boolean;
  /** "CDG:aerodatabox,FRA:aerodatabox" — which source collects which airport. Empty = nothing scheduled. */
  assignments: { airport: string; source: string }[];
  scheduler: boolean;            // run the tick loop inside the server process
  tickMinutes: number;
  graceHours: number;
  rawRetentionDays: number;
  staticDir: string | null;
  env: Record<string, string | undefined>;
}

export function loadConfig(over: Partial<FdConfig> = {}): FdConfig {
  loadDotEnv();
  const e = process.env;
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  const token = e.FD_ADMIN_TOKEN || e.ADMIN_TOKEN;
  const dist = path.join(ROOT, 'flightdata', 'dist');
  return {
    database: e.FD_DATABASE_URL || e.FD_PGLITE_DIR || localDataDir('pg'),
    // Not PORT: the passenger server uses PORT locally. On Railway set FD_PORT=${{PORT}} and FD_HOST=0.0.0.0.
    port: num(e.FD_PORT, 8790),
    host: e.FD_HOST ?? '127.0.0.1',
    adminToken: token ?? crypto.randomBytes(18).toString('base64url'),
    adminTokenGenerated: !token,
    assignments: parseAssignments(e.FD_ASSIGNMENTS ?? ''),
    scheduler: e.FD_SCHEDULER === 'on',
    tickMinutes: num(e.FD_TICK_MINUTES, 15),
    graceHours: num(e.FD_GRACE_HOURS, 6),
    rawRetentionDays: num(e.FD_RAW_RETENTION_DAYS, 14),
    staticDir: fs.existsSync(path.join(dist, 'index.html')) ? dist : null,
    env: e,
    ...over,
  };
}

/**
 * Local database directory, deliberately OUTSIDE the repository: the repository lives in a OneDrive-synced folder,
 * and OneDrive's sync of PostgreSQL data files left the directory unopenable ("could not create lock file
 * postmaster.pid: Permission denied", observed 2026-10-30). %LOCALAPPDATA% (Windows) or ~/.local/share is not synced.
 */
export function localDataDir(name: string): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'cdg-navigator', 'flightdata', name);
}

export function parseAssignments(s: string) {
  return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [airport, source] = x.split(':').map((y) => y.trim());
    if (!airport || !source) throw new Error(`FD_ASSIGNMENTS entry "${x}" must look like CDG:sourceid`);
    return { airport: airport.toUpperCase(), source };
  });
}

/** Database target without credentials, for logs. */
export const describeDb = (t: string) => (/^postgres/.test(t) ? t.replace(/\/\/[^@]*@/, '//***@') : t);

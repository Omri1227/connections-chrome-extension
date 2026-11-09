// Writes the public gate snapshot (docs/PUBLIC_GATE_SERVICE.md) from the RUNNING flight-data server, read-only.
// It never opens the database (PGlite allows one process: the live collector owns it).
//
//   npm run fd:public-snapshot [-- --out flightdata/public/data/gates.json] [--server http://127.0.0.1:8790]
//
// Uses /fd-api/v1/public-snapshot (servers with this code); an older running server answers 404, and the snapshot is
// then built from /fd-api/stats/distribution (operating flight numbers only, no codeshare numbers).
import fs from 'node:fs';
import path from 'node:path';
import { buildPublicSnapshot, type GateSource, type PublicSnapshot } from '../src/public-gates.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(import.meta.dirname, '..', '..');
const out = path.resolve(arg('--out', path.join(root, 'flightdata', 'public', 'data', 'gates.json')));
const server = arg('--server', process.env.FD_SERVER ?? 'http://127.0.0.1:8790');

function token(): string {
  if (process.env.FD_ADMIN_TOKEN || process.env.ADMIN_TOKEN) return (process.env.FD_ADMIN_TOKEN || process.env.ADMIN_TOKEN)!;
  // the main checkout's .env (this script may run from a worktree): read only the token line
  for (let d = root, i = 0; i < 5; i++, d = path.dirname(d)) {
    const f = path.join(d, '.env');
    if (fs.existsSync(f)) { const m = /^(?:FD_)?ADMIN_TOKEN=["']?([^"'\r\n]+)/m.exec(fs.readFileSync(f, 'utf8')); if (m) return m[1]; }
  }
  throw new Error('No admin token: set FD_ADMIN_TOKEN or ADMIN_TOKEN.');
}

const get = async (p: string) => fetch(new URL(p, server), { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(120_000) });

export const httpSource = (): GateSource => ({
  async distribution(airport, direction, from, to) {
    const r = await get(`/fd-api/stats/distribution?airport=${airport}&direction=${direction}&from=${from}&to=${to}&field=gate&groupBy=flight_key`);
    if (!r.ok) throw new Error(`distribution ${airport} ${direction}: HTTP ${r.status}`);
    return (await r.json()).groups;
  },
  codes: async () => null,
});

async function main() {
  let snap: PublicSnapshot;
  const r = await get('/fd-api/v1/public-snapshot');
  if (r.ok) snap = await r.json();
  else if (r.status === 404) { console.log('The running server predates /fd-api/v1/public-snapshot: building from the statistics API (no codeshare numbers).'); snap = await buildPublicSnapshot(httpSource()); }
  else throw new Error(`public-snapshot: HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, out);   // atomic: a running public server never reads a half-written file
  const entries = Object.values(snap.flights).reduce((s, x) => s + x.length, 0);
  console.log(`public snapshot: ${Object.keys(snap.flights).length} flight numbers, ${entries} airport × direction gates, window ${snap.window.from} → ${snap.window.to} → ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main().catch((e) => { console.error((e as Error).message); process.exit(1); });

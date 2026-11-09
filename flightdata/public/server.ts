// Public gate service (docs/PUBLIC_GATE_SERVICE.md): answers, for a flight number, the gate it used most in the last
// 30 days. It serves ONLY the snapshot file written by `npm run fd:public-snapshot`: no database, no admin token, no
// connection to the collector. Safe to run on a separate public host.
//
//   GET /v1/gate?flight=LH400[&airport=FRA][&direction=departure]   → { flight, found, results: [{ airport, direction, gate, flightDays }], window, updated }
//   GET /v1/health                                                  → { ok, updated, flights }
//
// Env: PUBLIC_PORT (8791), PUBLIC_HOST (127.0.0.1; 0.0.0.0 on a public host), PUBLIC_SNAPSHOT (data/gates.json),
//      PUBLIC_API_KEYS (comma-separated; when set, every /v1/gate call needs header X-API-Key), PUBLIC_RATE (requests per
//      minute per client, 60), PUBLIC_TRUST_PROXY=1 (behind a reverse proxy: client = first X-Forwarded-For address).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { publicAnswer, type PublicSnapshot } from '../src/public-gates.ts';

const FLIGHT = /^[A-Z0-9]{2}[A-Z]?\d{1,4}[A-Z]?$/;
/** "LH 0400", "lh-400" → "LH400" (the stored form). */
export const normFlight = (s: string) => s.toUpperCase().replace(/[\s-]+/g, '').replace(/^([A-Z]{3}|[A-Z0-9]{2})0+(?=\d)/, '$1');

export interface PublicOptions { load: () => PublicSnapshot | null; apiKeys?: string[]; ratePerMinute?: number; trustProxy?: boolean; now?: () => number }

export function createPublicApp(o: PublicOptions) {
  const rate = o.ratePerMinute ?? 60, now = o.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; t: number }>();
  const keys = (o.apiKeys ?? []).filter(Boolean).map((k) => Buffer.from(k));
  const keyOk = (req: IncomingMessage) => {
    if (!keys.length) return true;
    const got = Buffer.from(String(req.headers['x-api-key'] ?? ''));
    return keys.some((k) => k.length === got.length && crypto.timingSafeEqual(k, got));
  };
  const allow = (client: string) => {
    const t = now(), b = buckets.get(client) ?? { tokens: rate, t };
    b.tokens = Math.min(rate, b.tokens + ((t - b.t) / 60_000) * rate); b.t = t;
    if (buckets.size > 50_000) buckets.clear();   // bounded memory
    if (b.tokens < 1) { buckets.set(client, b); return false; }
    b.tokens -= 1; buckets.set(client, b); return true;
  };
  return function handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-API-Key',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store', ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-API-Key', 'Access-Control-Allow-Methods': 'GET' }); return res.end(); }
    if (req.method !== 'GET') return send(405, { error: 'read-only service: GET only' });
    const snap = o.load();
    if (u.pathname === '/v1/health') return send(snap ? 200 : 503, { ok: !!snap, updated: snap?.generatedAt ?? null, flights: snap ? Object.keys(snap.flights).length : 0 }, { 'Cache-Control': 'no-store' });
    if (u.pathname !== '/v1/gate') return send(404, { error: 'not found: use /v1/gate?flight=LH400' });
    const client = (o.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
    if (!allow(client)) return send(429, { error: `rate limit: ${rate} requests per minute` }, { 'Retry-After': '60' });
    if (!keyOk(req)) return send(401, { error: 'API key required (header X-API-Key)' });
    if (!snap) return send(503, { error: 'no data available yet' });
    const flight = normFlight(u.searchParams.get('flight') ?? '');
    if (!FLIGHT.test(flight)) return send(400, { error: 'flight is required, e.g. flight=LH400' });
    const airport = (u.searchParams.get('airport') ?? '').toUpperCase() || undefined;
    if (airport && !/^[A-Z]{3}$/.test(airport)) return send(400, { error: 'airport must be an IATA code' });
    const direction = (u.searchParams.get('direction') ?? '').toLowerCase() || undefined;
    if (direction && direction !== 'arrival' && direction !== 'departure') return send(400, { error: 'direction must be arrival or departure' });
    return send(200, publicAnswer(snap, { flight, airport, direction }));
  };
}

/** Loads the snapshot file, re-reading it when it changes (checked at most every 30 s). */
export function fileLoader(file: string, minCheckMs = 30_000) {
  let snap: PublicSnapshot | null = null, mtime = 0, checked = 0;
  return () => {
    const t = Date.now();
    if (t - checked >= minCheckMs || !snap) {
      checked = t;
      try { const m = fs.statSync(file).mtimeMs; if (m !== mtime) { snap = JSON.parse(fs.readFileSync(file, 'utf8')); mtime = m; } } catch { /* keep the last good snapshot */ }
    }
    return snap;
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const e = process.env;
  const file = path.resolve(e.PUBLIC_SNAPSHOT ?? path.join(import.meta.dirname, 'data', 'gates.json'));
  const app = createPublicApp({ load: fileLoader(file), apiKeys: (e.PUBLIC_API_KEYS ?? '').split(','), ratePerMinute: Number(e.PUBLIC_RATE) || 60, trustProxy: e.PUBLIC_TRUST_PROXY === '1' });
  const port = Number(e.PUBLIC_PORT) || 8791, host = e.PUBLIC_HOST ?? '127.0.0.1';
  http.createServer(app).listen(port, host, () => console.log(JSON.stringify({ event: 'public.listen', url: `http://${host}:${port}`, snapshot: file, apiKeys: !!e.PUBLIC_API_KEYS })));
}

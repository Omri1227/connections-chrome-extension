// Research API of the flight-data platform (node:http, no framework). Everything requires the admin token: this is a
// research tool, separate from the passenger app, and its data is not for public display.
//
// GET  /fd-api/health                                   liveness (no token)
// GET  /fd-api/overview                                 airports, collection health, sources, next slots
// GET  /fd-api/runs?airport=&status=&limit=             collection-run history
// GET  /fd-api/runs/:id                                 one run with its findings and raw-sample metadata
// GET  /fd-api/flights?airport=&direction=&from=&to=&carrier=&flight=&other=&limit=&offset=
// GET  /fd-api/flights/:id                              observation timeline, codes, sightings
// GET  /fd-api/stats/distribution?…&field=terminal|gate&groupBy=carrier|other|flight_key|none
// GET  /fd-api/stats/completeness?airport=&direction=&from=&to=
// GET  /fd-api/stats/gates?airport=&direction=&from=&to=&limit=   initial / updated / final gate assignments
// GET  /fd-api/stats/cross-airport?date=                 departures A→B vs arrivals at B from A (collected airports)
// GET  /fd-api/ops                                      operational health (slots collected/missed, units, backups)
// GET  /fd-api/stats/summary                           every airport × direction: flight-days, terminal/gate shares
// GET  /fd-api/quality?airport=&kind=&limit=
// GET  /fd-api/predict?airport=&flight=&date=&direction=    integration boundary for CDG Navigator
// GET  /fd-api/v1/flight?airport=&flight=&date=&direction=  versioned lookup for the Chrome extension (lookup.ts)
// GET  /fd-api/v1/public-snapshot                     most-used gate per flight, last 30 days (input of the public service)
// GET  /fd-api/v1/connection?arr=&dep=&date=[&depDate=][&airport=][&days=]  (days: history window, default 30, max 120)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADAPTERS } from './adapters/index.ts';
import { completeness, countFlights, distribution, flightHistory, gateHistory, health, listFlights, predict, summary, type Filters } from './analysis.ts';
import { crossAirportCheck } from './crosscheck.ts';
import { AIRPORTS } from './airports.ts';
import type { Db } from './db.ts';
import { lookupConnection, lookupFlight } from './lookup.ts';
import { opsHealth } from './ops.ts';
import { buildPublicSnapshot, dbSource } from './public-gates.ts';
import { DEFAULT_SLOTS, nextSlot, unitsUsed } from './scheduler.ts';

export interface FdAppDeps { db: Db; adminToken: string; staticDir?: string | null; now?: () => Date; assignments?: { airport: string; source: string }[]; env?: Record<string, string | undefined>; dbDir?: string | null }

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9]{2,8}$/;
const FLIGHT = /^[A-Z0-9]{2}[A-Z]?\d{1,4}[A-Z]?$/;

export function parseFilters(u: URL): Filters {
  const airport = (u.searchParams.get('airport') ?? '').toUpperCase();
  if (!CODE.test(airport)) throw new HttpError(400, 'airport is required (IATA code)');
  const direction = u.searchParams.get('direction') ?? 'departure';
  if (direction !== 'arrival' && direction !== 'departure') throw new HttpError(400, 'direction must be arrival or departure');
  const f: Filters = { airport, direction };
  for (const k of ['from', 'to'] as const) { const v = u.searchParams.get(k); if (v) { if (!DATE.test(v)) throw new HttpError(400, `${k} must be YYYY-MM-DD`); f[k] = v; } }
  for (const k of ['carrier', 'flight', 'other'] as const) { const v = u.searchParams.get(k)?.toUpperCase().replace(/\s+/g, ''); if (v) { if (!CODE.test(v)) throw new HttpError(400, `${k} is not a valid code`); f[k] = v; } }
  return f;
}

export function createFdApp({ db, adminToken, staticDir, now = () => new Date(), assignments = [], env = {}, dbDir = null }: FdAppDeps) {
  const ok = (req: IncomingMessage) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const got = Buffer.from(m?.[1] ?? ''), want = Buffer.from(adminToken);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  async function api(req: IncomingMessage, res: ServerResponse, u: URL) {
    const p = u.pathname;
    if (p === '/fd-api/health') return json(res, 200, { ok: true, db: db.kind, time: now().toISOString() });
    if (!ok(req)) throw new HttpError(401, 'admin token required (Authorization: Bearer …)');
    if (req.method !== 'GET') throw new HttpError(405, 'read-only API');
    const lim = (d: number) => Math.min(Math.max(Number(u.searchParams.get('limit') ?? d) | 0, 1), 1000);

    if (p === '/fd-api/overview') {
      const airports = await health(db);
      const sources = await db.query('SELECT id, name, kind, base_url, terms_url, terms_summary, permission, retention, cost_note, capabilities, airports FROM fd_sources ORDER BY id');
      const t = now();
      return json(res, 200, {
        now: t.toISOString(), assignments,
        airports: airports.map((a: any) => ({ ...a, nextSlot: AIRPORTS[a.iata] ? nextSlot(AIRPORTS[a.iata], DEFAULT_SLOTS, t)?.toISOString() ?? null : null })),
        sources,
        schedule: DEFAULT_SLOTS,
        budgets: (await Promise.all([...new Set(assignments.map((x) => x.source))].map((id) => ADAPTERS[id] ? unitsUsed(db, ADAPTERS[id].info, env, t) : null))).filter(Boolean),
      });
    }
    if (p === '/fd-api/stats/summary') return json(res, 200, { lines: await summary(db) });
    if (p === '/fd-api/ops') return json(res, 200, await opsHealth(db, { assignments, env, now: now(), graceHours: Number(env.FD_GRACE_HOURS) || 6, dbDir }));
    if (p === '/fd-api/runs') {
      const w: string[] = [], prm: unknown[] = [];
      const a = u.searchParams.get('airport'); if (a) { prm.push(a.toUpperCase()); w.push(`airport=$${prm.length}`); }
      const s = u.searchParams.get('status'); if (s) { prm.push(s); w.push(`status=$${prm.length}`); }
      const rows = await db.query(`SELECT id, airport, source_id, direction, target_date::text AS target_date, slot, trigger, started_at, finished_at, status, windows_expected, windows_ok, pages_fetched, rows_raw, rows_normalised, rows_rejected, flights_seen, flights_new, observations_new, observations_unchanged, with_terminal, with_gate, warnings, error FROM fd_collection_runs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ${lim(100)}`, prm);
      return json(res, 200, { runs: rows });
    }
    let m = /^\/fd-api\/runs\/(\d+)$/.exec(p);
    if (m) {
      const run = (await db.query('SELECT *, target_date::text AS target_date FROM fd_collection_runs WHERE id=$1', [Number(m[1])]))[0];
      if (!run) throw new HttpError(404, 'no such run');
      const findings = await db.query('SELECT * FROM fd_quality_findings WHERE run_id=$1 ORDER BY id', [run.id]);
      const samples = await db.query('SELECT id, window_label, http_status, bytes, created_at FROM fd_raw_samples WHERE run_id=$1 ORDER BY id', [run.id]);
      return json(res, 200, { run, findings, samples });
    }
    if (p === '/fd-api/flights') { const f = parseFilters(u); return json(res, 200, { flights: await listFlights(db, f, lim(200), Number(u.searchParams.get('offset') ?? 0)), ...(await countFlights(db, f)) }); }
    m = /^\/fd-api\/flights\/(\d+)$/.exec(p);
    if (m) { const h = await flightHistory(db, Number(m[1])); if (!h) throw new HttpError(404, 'no such flight'); return json(res, 200, h); }
    if (p === '/fd-api/stats/distribution') {
      const fp = u.searchParams.get('field');
      const field = fp === 'gate' || fp === 'gateArea' ? fp : 'terminal';
      const g = u.searchParams.get('groupBy') ?? 'carrier';
      if (!['carrier', 'other', 'flight_key', 'none'].includes(g)) throw new HttpError(400, 'groupBy must be carrier, other, flight_key or none');
      return json(res, 200, { field, groupBy: g, groups: await distribution(db, parseFilters(u), field, g as any) });
    }
    if (p === '/fd-api/stats/completeness') return json(res, 200, { days: await completeness(db, parseFilters(u)) });
    if (p === '/fd-api/stats/gates') return json(res, 200, await gateHistory(db, parseFilters(u), { examples: lim(50) }));
    if (p === '/fd-api/stats/cross-airport') {
      const d = u.searchParams.get('date') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'date must be YYYY-MM-DD');
      return json(res, 200, await crossAirportCheck(db, { date: d }));
    }
    if (p === '/fd-api/quality') {
      const w: string[] = [], prm: unknown[] = [];
      const a = u.searchParams.get('airport'); if (a) { prm.push(a.toUpperCase()); w.push(`airport=$${prm.length}`); }
      const k = u.searchParams.get('kind'); if (k) { prm.push(k); w.push(`kind=$${prm.length}`); }
      return json(res, 200, { findings: await db.query(`SELECT *, target_date::text AS target_date FROM fd_quality_findings ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ${lim(200)}`, prm) });
    }
    if (p === '/fd-api/predict') {
      const f = parseFilters(u);
      const date = u.searchParams.get('date') ?? '';
      if (!DATE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
      if (!f.flight) throw new HttpError(400, 'flight is required');
      return json(res, 200, await predict(db, { airport: f.airport, flight: f.flight, date, direction: f.direction }));
    }
    // Input of the public gate service (admin only; the public server never reaches this API). docs/PUBLIC_GATE_SERVICE.md
    if (p === '/fd-api/v1/public-snapshot') return json(res, 200, await buildPublicSnapshot(dbSource(db), { now: now() }));
    // Stable, versioned read-only lookup for the future Chrome extension (docs/FLIGHT_DATA_EXTENSION_API.md).
    if (p === '/fd-api/v1/flight' || p === '/fd-api/v1/connection') {
      const param = (k: string, re: RegExp, required: boolean) => {
        const v = (u.searchParams.get(k) ?? '').toUpperCase().replace(/\s+/g, '');
        if (!v) { if (required) throw new HttpError(400, `${k} is required`); return undefined; }
        if (!re.test(v)) throw new HttpError(400, `${k} is not valid`);
        return v;
      };
      const date = param('date', DATE, true)!;
      const airport = param('airport', /^[A-Z]{3}$/, p === '/fd-api/v1/flight');
      const days = param('days', /^\d{1,3}$/, false);
      const lookbackDays = days ? Number(days) : undefined;
      if (p === '/fd-api/v1/flight') {
        const direction = (u.searchParams.get('direction') ?? '').toLowerCase();
        if (direction !== 'arrival' && direction !== 'departure') throw new HttpError(400, 'direction must be arrival or departure');
        return json(res, 200, await lookupFlight(db, { airport: airport!, flight: param('flight', FLIGHT, true)!, date, direction, now: now(), lookbackDays }));
      }
      return json(res, 200, await lookupConnection(db, { arrivalFlight: param('arr', FLIGHT, true)!, departureFlight: param('dep', FLIGHT, true)!, date, departureDate: param('depDate', DATE, false), airport, now: now(), lookbackDays }));
    }
    throw new HttpError(404, 'not found');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (u.pathname.startsWith('/fd-api/')) return await api(req, res, u);
      if (staticDir) return serveStatic(res, staticDir, u.pathname);
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(JSON.stringify({ event: 'api.error', path: u.pathname, error: (e as Error).message }));
      json(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveStatic(res: ServerResponse, dir: string, p: string) {
  const file = path.normalize(path.join(dir, decodeURIComponent(p === '/' ? '/index.html' : p)));
  const target = file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dir, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
  fs.createReadStream(target).pipe(res);
}

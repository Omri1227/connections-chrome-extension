// npx tsx airportmaps/scripts/audit.ts <iata>[,<iata>…] | all  [--json=<file>] [--verbose]
// Transport and travel-time audit (phase 2): evidence basis of every time value, matrix coverage by time of day,
// and suspicious routes (double security / passport, very short cross-terminal hops, long routes, transport slower
// than walking, routes leaning on assumed minutes). Writes a JSON snapshot for before/after comparisons.
import fs from 'node:fs';
import path from 'node:path';
import { buildMatrix, rideSeg, type Route } from '../src/route.ts';
import type { AirportModel, Minutes } from '../src/types.ts';

type Basis = Minutes['basis'];
const BASES: Basis[] = ['published', 'measured', 'observed', 'derived', 'assumed'];
const arg = (process.argv[2] ?? '').toLowerCase();
if (!arg) { console.error('usage: audit.ts <iata>[,…] | all [--json=<file>] [--verbose]'); process.exit(2); }
const root = path.join(import.meta.dirname, '..', 'data');
const list = arg === 'all' ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'airport.json'))).sort() : arg.split(',');
const verbose = process.argv.includes('--verbose');
const jsonOut = process.argv.find((x) => x.startsWith('--json='))?.slice(7);
/** Times of day for the coverage check: daytime, late evening, night. */
const TIMES = ['10:00', '23:30', '03:00'];

export interface AirportAudit {
  iata: string;
  lines: { total: number; routed: number; notRouted: number; withStatus: number; withWindows: number; withRideRanges: number; confidence: Record<string, number> };
  stops: number;
  walks: { total: number; confidence: Record<string, number> };
  /** Count of time values by basis, per kind (walks, platform access, rides, waits). */
  basis: Record<'walk' | 'access' | 'ride' | 'wait', Partial<Record<Basis, number>>>;
  /** Share of typical matrix movement minutes by basis (day matrix). */
  matrixBasisShare: Partial<Record<Basis, number>>;
  matrix: Record<string, { pairs: number; routed: number; unroutable: string[] }>;
  routeConfidence: Record<string, number>;
  flags: { doubleSecurity: string[]; multiPassport: string[]; shortCrossTerminal: string[]; long: string[]; walkFaster: string[]; mostlyAssumed: string[]; hoursUnpublished: string[] };
}

const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const label = (r: Route) => `${r.from} → ${r.to}`;

function audit(m: AirportModel): AirportAudit {
  const basis: AirportAudit['basis'] = { walk: {}, access: {}, ride: {}, wait: {} };
  for (const w of m.walks) inc(basis.walk, w.minutes.basis);
  for (const s of m.stops) inc(basis.access, s.accessMinutes.basis);
  for (const l of m.lines) {
    l.rideMin.forEach((_, i) => inc(basis.ride, rideSeg(l, i).basis));
    for (const sv of l.service) inc(basis.wait, sv.waitMin.basis);
  }
  const lc: Record<string, number> = {}, wc: Record<string, number> = {};
  m.lines.forEach((l) => inc(lc, l.confidence)); m.walks.forEach((w) => inc(wc, w.confidence));
  const matrix: AirportAudit['matrix'] = {};
  const flags: AirportAudit['flags'] = { doubleSecurity: [], multiPassport: [], shortCrossTerminal: [], long: [], walkFaster: [], mostlyAssumed: [], hoursUnpublished: [] };
  const routeConfidence: Record<string, number> = {};
  const share: Record<string, number> = {};
  const day = buildMatrix(m);
  const term = (id: string) => m.areas.find((a) => a.id === id)?.terminal;
  for (const c of day.cells) {
    if (c.from === c.to || !c.route) continue;
    const r = c.route;
    inc(routeConfidence, r.confidence);
    for (const [b, v] of Object.entries(r.basisMix)) inc(share, b, v!);
    const sec = r.controls.filter((k) => k === 'security' || k === 'transfer-security').length;
    if (sec > 1) flags.doubleSecurity.push(`${label(r)} (${r.controls.join(', ')})`);
    if (r.borderCrossings > 1) flags.multiPassport.push(`${label(r)} ×${r.borderCrossings}`);
    const tf = term(c.from), tt = term(c.to);
    if (tf && tt && tf !== tt && r.movement.typical < 4) flags.shortCrossTerminal.push(`${label(r)} ${r.movement.typical.toFixed(1)} min movement`);
    if (r.total.typical >= 60) flags.long.push(`${label(r)} ${Math.round(r.total.typical)} min (${r.summary})`);
    const walk = c.alternatives.find((a) => a.label === 'Walking only')?.route;
    if (walk && r.lines.length && walk.total.typical < r.total.typical) flags.walkFaster.push(`${label(r)} walk ${Math.round(walk.total.typical)} < transport ${Math.round(r.total.typical)}`);
    const assumed = r.basisMix.assumed ?? 0;
    if (r.movement.typical > 0 && assumed / r.movement.typical > 0.5) flags.mostlyAssumed.push(`${label(r)} ${Math.round((100 * assumed) / r.movement.typical)}% assumed`);
  }
  const tot = Object.values(share).reduce((s, v) => s + v, 0) || 1;
  const matrixBasisShare: AirportAudit['matrixBasisShare'] = {};
  for (const b of BASES) if (share[b]) matrixBasisShare[b] = Math.round((1000 * share[b]) / tot) / 10;
  for (const t of ['day', ...TIMES]) {
    const mx = t === 'day' ? day : buildMatrix(m, { transfer: true, time: t });
    const cells = mx.cells.filter((c) => c.from !== c.to);
    matrix[t] = { pairs: cells.length, routed: cells.filter((c) => c.route).length, unroutable: cells.filter((c) => !c.route).map((c) => `${c.from} → ${c.to}`) };
    if (t !== 'day') for (const c of cells) if (c.route?.warnings.some((w) => w.startsWith('Operating hours not published'))) flags.hoursUnpublished.push(`${t} ${c.from} → ${c.to}`);
  }
  return {
    iata: m.iata,
    lines: { total: m.lines.length, routed: m.lines.filter((l) => !l.notRouted && l.access !== 'restricted').length, notRouted: m.lines.filter((l) => l.notRouted).length, withStatus: m.lines.filter((l) => l.status?.length).length, withWindows: m.lines.filter((l) => l.service.some((s) => s.windows?.length)).length, withRideRanges: m.lines.filter((l) => l.ride?.length).length, confidence: lc },
    stops: m.stops.length,
    walks: { total: m.walks.length, confidence: wc },
    basis, matrixBasisShare, matrix, routeConfidence, flags,
  };
}

const out: AirportAudit[] = [];
for (const iata of list) {
  const m = JSON.parse(fs.readFileSync(path.join(root, iata, 'airport.json'), 'utf8')) as AirportModel;
  const a = audit(m); out.push(a);
  const fmt = (o: Partial<Record<string, number>>) => BASES.filter((b) => o[b]).map((b) => `${b} ${o[b]}`).join(', ') || '—';
  console.log(`${a.iata}: lines ${a.lines.total} (${a.lines.notRouted} not routed, ${a.lines.withWindows} with hour windows, ${a.lines.withRideRanges} with ride ranges), stops ${a.stops}, walks ${a.walks.total}`);
  console.log(`  basis  walk: ${fmt(a.basis.walk)} | access: ${fmt(a.basis.access)} | ride: ${fmt(a.basis.ride)} | wait: ${fmt(a.basis.wait)}`);
  console.log(`  matrix movement minutes by basis (%): ${fmt(a.matrixBasisShare)}`);
  console.log(`  coverage: ${Object.entries(a.matrix).map(([t, x]) => `${t} ${x.routed}/${x.pairs}`).join(' · ')}`);
  console.log(`  route confidence: ${Object.entries(a.routeConfidence).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [k, v] of Object.entries(a.flags)) if (v.length) {
    console.log(`  flag ${k}: ${v.length}`);
    if (verbose) for (const x of v) console.log(`     ${x}`);
  }
  if (verbose) for (const [t, x] of Object.entries(a.matrix)) for (const u of x.unroutable) console.log(`     no route at ${t}: ${u}`);
}
// --compare=<baseline.json>: markdown before → after table per airport
const cmp = process.argv.find((x) => x.startsWith('--compare='))?.slice(10);
if (cmp) {
  const base = JSON.parse(fs.readFileSync(cmp, 'utf8')).airports as AirportAudit[];
  const strong = (o: Partial<Record<Basis, number>>) => (o.published ?? 0) + (o.measured ?? 0);
  const all = (o: Partial<Record<Basis, number>>) => Object.values(o).reduce((s, v) => s + (v ?? 0), 0);
  const kinds = ['walk', 'access', 'ride', 'wait'] as const;
  const sum = (a: AirportAudit, f: (o: Partial<Record<Basis, number>>) => number) => kinds.reduce((s, k) => s + f(a.basis[k]), 0);
  console.log('\n| Airport | Lines (not routed) | Hour windows | Ride ranges | Time values published+measured | Assumed values | Matrix minutes assumed % | 03:00 routed | Route conf. verified/probable/inferred | Flags (dblSec/multiPass/short/long/walkFaster/assumed) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const a of out) {
    const b = base.find((x) => x.iata === a.iata); if (!b) continue;
    const arrow = (x: string | number, y: string | number) => (String(x) === String(y) ? `${y}` : `${x} → ${y}`);
    const asm = (z: AirportAudit) => sum(z, (o) => o.assumed ?? 0);
    const rc = (z: AirportAudit) => `${z.routeConfidence.verified ?? 0}/${z.routeConfidence.probable ?? 0}/${z.routeConfidence.inferred ?? 0}`;
    const fl = (z: AirportAudit) => [z.flags.doubleSecurity, z.flags.multiPassport, z.flags.shortCrossTerminal, z.flags.long, z.flags.walkFaster, z.flags.mostlyAssumed].map((x) => x.length).join('/');
    const n3 = (z: AirportAudit) => `${z.matrix['03:00'].routed}/${z.matrix['03:00'].pairs}`;
    console.log(`| ${a.iata} | ${arrow(`${b.lines.total} (${b.lines.notRouted})`, `${a.lines.total} (${a.lines.notRouted})`)} | ${arrow(b.lines.withWindows, a.lines.withWindows)} | ${arrow(b.lines.withRideRanges, a.lines.withRideRanges)} | ${arrow(`${sum(b, strong)}/${sum(b, all)}`, `${sum(a, strong)}/${sum(a, all)}`)} | ${arrow(asm(b), asm(a))} | ${arrow(b.matrixBasisShare.assumed ?? 0, a.matrixBasisShare.assumed ?? 0)} | ${arrow(n3(b), n3(a))} | ${arrow(rc(b), rc(a))} | ${arrow(fl(b), fl(a))} |`);
  }
}
if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), airports: out }, null, 1) + '\n'); console.log(`wrote ${jsonOut}`); }

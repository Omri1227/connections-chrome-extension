// npx tsx airportmaps/scripts/validate.ts <iata>[,<iata>…] | all  [--quiet]
// Validates airportmaps/data/<iata>/airport.json (+ evidence.json) and the transfer matrix
// (every pair of matrix areas must have a route or an explicit reason why not), and lists suspicious routes.
import fs from 'node:fs';
import path from 'node:path';
import { validateAirport } from '../src/validate.ts';
import { buildMatrix } from '../src/route.ts';
import type { AirportModel, EvidenceFile } from '../src/types.ts';

const arg = (process.argv[2] ?? '').toLowerCase();
if (!arg) { console.error('usage: validate.ts <iata>[,<iata>…] | all [--quiet]'); process.exit(2); }
const root = path.join(import.meta.dirname, '..', 'data');
const list = arg === 'all' ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'airport.json'))).sort() : arg.split(',');

let failed = 0;
for (const iata of list) {
  const dir = path.join(root, iata);
  const model = JSON.parse(fs.readFileSync(path.join(dir, 'airport.json'), 'utf8')) as AirportModel;
  const evPath = path.join(dir, 'evidence.json');
  const ev = fs.existsSync(evPath) ? JSON.parse(fs.readFileSync(evPath, 'utf8')) as EvidenceFile : undefined;
  const { errors, warnings } = validateAirport(model, ev);

  const mx = buildMatrix(model);
  const missing = mx.cells.filter((c) => c.from !== c.to && !c.route);
  const routed = mx.cells.filter((c) => c.route && c.from !== c.to);
  for (const c of missing) warnings.push(`no route ${c.from} → ${c.to}${c.reason ? ` (${c.reason})` : ''}`);
  for (const c of routed) {
    const r = c.route!;
    if (r.total.typical >= 90) warnings.push(`long route ${c.from} → ${c.to}: ${Math.round(r.total.typical)} min (${r.summary})`);
    if (r.borderCrossings > 1) warnings.push(`route ${c.from} → ${c.to} crosses passport control ${r.borderCrossings}×`);
  }
  const conf = (k: string) => routed.filter((c) => c.route!.confidence === k).length;
  const gates = model.gateGroups.reduce((n, g) => n + g.gates.length, 0);
  console.log(`${model.iata}: ${model.areas.length} areas, ${model.gateGroups.length} gate groups / ${gates} gates, ${model.walks.length} walks, ${model.lines.length} lines / ${model.stops.length} stops, ${model.sources.length} sources, ${ev?.items.length ?? 0} evidence items; matrix ${mx.areas.length}×${mx.areas.length}: ${routed.length} routed, ${missing.length} without route; route confidence verified ${conf('verified')} / probable ${conf('probable')} / inferred ${conf('inferred')} / unknown ${conf('unknown')}`);
  if (!process.argv.includes('--quiet')) for (const w of warnings) console.log(`  warn: ${w}`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
  console.log(errors.length ? `${errors.length} error(s)` : 'OK');
  if (errors.length) failed++;
}
process.exit(failed ? 1 : 0);

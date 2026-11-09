// npx tsx airportmaps/scripts/route.ts <iata> <fromAreaOrGate> <toAreaOrGate> [--public] [--date=YYYY-MM-DD]
// Prints the recommended route and its alternatives (debug / audit helper).
import fs from 'node:fs';
import path from 'node:path';
import { findGate, routeWithAlternatives, type Route } from '../src/route.ts';
import type { AirportModel } from '../src/types.ts';

const [iata, a, b] = process.argv.slice(2);
if (!iata || !a || !b) { console.error('usage: route.ts <iata> <from> <to> [--public] [--date=YYYY-MM-DD]'); process.exit(2); }
const m = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'data', iata.toLowerCase(), 'airport.json'), 'utf8')) as AirportModel;
const resolve = (x: string) => m.areas.find((ar) => ar.id === x)?.id ?? findGate(m, x)?.area.id ?? (() => { console.error(`unknown area/gate ${x}`); process.exit(2); })();
const date = process.argv.find((x) => x.startsWith('--date='))?.slice(7);
const cell = routeWithAlternatives(m, resolve(a), resolve(b), { transfer: !process.argv.includes('--public'), date });
const show = (label: string, r: Route) => {
  console.log(`${label}: ${Math.round(r.total.typical)} min (${Math.round(r.total.min)}–${Math.round(r.total.max)}), ${r.confidence}, passport ×${r.borderCrossings} — ${r.summary}`);
  for (const s of r.steps) console.log(`   ${s.kind.padEnd(13)} ${String(Math.round(s.minutes.typical)).padStart(3)}′  ${s.text}`);
  for (const w of r.warnings) console.log(`   ⚠ ${w}`);
};
if (!cell.route) console.log(`no route (${cell.reason})`);
else { show('Recommended', cell.route); for (const x of cell.alternatives) show(x.label, x.route); }

// Builds extension/data/airport-countries.json (IATA → [ISO country, city]) from the OurAirports airports.csv
// (https://davidmegginson.github.io/ourairports-data/airports.csv, released to the Public Domain by OurAirports).
// Only airports with scheduled service and an IATA code. Used to decide Schengen / non-Schengen (and IST domestic /
// international) zones of the other end of a flight.
//   npx tsx extension/scripts/build-airport-countries.ts <path to airports.csv>
import fs from 'node:fs';
import path from 'node:path';

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const file = process.argv[2];
if (!file) throw new Error('usage: build-airport-countries.ts <airports.csv>');
const [head, ...rows] = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const h = parseCsvLine(head);
const col = (n: string) => h.indexOf(n);
const [iI, cI, mI, sI, tI] = [col('iata_code'), col('iso_country'), col('municipality'), col('scheduled_service'), col('type')];
const out: Record<string, [string, string]> = {};
for (const r of rows) {
  const f = parseCsvLine(r);
  const iata = f[iI];
  if (!/^[A-Z]{3}$/.test(iata) || f[sI] !== 'yes' || !/airport/.test(f[tI])) continue;
  // Prefer the larger airport when two rows share a code (rare)
  if (out[iata] && f[tI] !== 'large_airport') continue;
  out[iata] = [f[cI], f[mI]];
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
const target = path.join(import.meta.dirname, '..', 'data', 'airport-countries.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ source: 'OurAirports airports.csv (Public Domain), scheduled-service airports with an IATA code', built: new Date().toISOString().slice(0, 10), airports: sorted }) + '\n');
console.log(`${Object.keys(sorted).length} airports → ${target}`);

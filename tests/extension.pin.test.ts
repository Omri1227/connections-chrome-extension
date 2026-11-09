// R-01: the extension bundles THIS tree's airport models and the single shared router, and records what it bundles.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_INFO } from '../extension/src/core/bundle-info.ts';
import { MODELS } from '../extension/src/core/models.ts';
import { computePin, modelFiles } from '../extension/scripts/pin.ts';

const ROOT = path.join(import.meta.dirname, '..');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe('bundle pin (R-01)', () => {
  it('matches the current airport models, router and flight-data contract (regenerate: npx tsx extension/scripts/pin.ts)', () => {
    const now = computePin();
    expect(now.files, 'airportmaps/data or airportmaps/src changed without updating extension/src/core/bundle-info.ts').toEqual(BUNDLE_INFO.files);
    expect(now.mapsHash).toBe(BUNDLE_INFO.mapsHash);
    expect(now.contractHash, 'the flight-data contract types (flightdata/src/lookup.ts) changed: update the extension and the pin').toBe(BUNDLE_INFO.contractHash);
    expect(now.models).toEqual(BUNDLE_INFO.models);
  });
  it('the extension bundles every airport model of the maps layer (same objects as the files)', () => {
    expect(Object.keys(MODELS).sort()).toEqual(modelFiles().map((f) => f.split('/')[2].toUpperCase()).sort());
    for (const [k, m] of Object.entries(MODELS)) expect(m.asOf).toBe(JSON.parse(fs.readFileSync(path.join(ROOT, 'airportmaps', 'data', k.toLowerCase(), 'airport.json'), 'utf8')).asOf);
  });
  it('there is one router: extension code imports airportmaps/src/route.ts and contains no copy of it', () => {
    const src = walk(path.join(ROOT, 'extension', 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of src) {
      const t = fs.readFileSync(f, 'utf8');
      expect(/function (findRoute|buildGraph|findSelfTransfer)\b/.test(t), `${f} defines a router function`).toBe(false);
      for (const m of t.matchAll(/from '([^']*route(?:\.ts)?)'/g)) expect(path.resolve(path.dirname(f), m[1])).toBe(path.join(ROOT, 'airportmaps', 'src', 'route.ts'));
    }
    expect(fs.readFileSync(path.join(ROOT, 'extension', 'src', 'core', 'models.ts'), 'utf8')).toMatch(/airportmaps\/data\/cdg\/airport\.json/);
  });
});

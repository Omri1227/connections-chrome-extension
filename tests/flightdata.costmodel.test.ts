// The AeroDataBox cost model (flightdata/scripts/cost-model.ts) counts calls by replaying the collector's own slot plan
// and window splitter. These tests pin the counts the published tables rely on, and check the doc/CSV are current.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AIRPORTS, PARAMS, SCENARIOS, airportMonth, cheapestPlan, fidsCallsInMonth, generated } from '../flightdata/scripts/cost-model.ts';
import { DEFAULT_SLOTS } from '../flightdata/src/scheduler.ts';

const [A, B, C] = SCENARIOS;

describe('AeroDataBox cost model', () => {
  it('counts 8 FIDS calls per airport-day with the default slots and 12-h windows (one call serves both directions)', () => {
    expect(fidsCallsInMonth('Europe/Paris', DEFAULT_SLOTS, '2026-11-01', 30, 12)).toBe(240);
    expect(fidsCallsInMonth('Europe/Paris', DEFAULT_SLOTS, '2026-11-01', 30, 24)).toBe(120);
  });

  it('adds one window for each of the 4 collections of the 25-hour day, none where there is no DST', () => {
    expect(fidsCallsInMonth('Europe/Paris', DEFAULT_SLOTS, '2026-10-01', 30, 12)).toBe(244);
    expect(fidsCallsInMonth('Europe/Istanbul', DEFAULT_SLOTS, '2026-10-01', 30, 12)).toBe(240);
  });

  it('scenario budgets per airport: A 180 calls, B 261 calls (DST + 5 % retries + one slot re-run)', () => {
    const cdg = AIRPORTS[0];
    expect(airportMonth(cdg, A, PARAMS).calls).toBe(180);
    expect(airportMonth(cdg, B, PARAMS)).toMatchObject({ fids: 261, status: 0, units: 522 });
    expect(airportMonth(cdg, C, PARAMS).status).toBeGreaterThan(10_000);
  });

  it('never picks the non-commercial free plan and only extended-caching plans for raw history', () => {
    expect(cheapestPlan(300, A, 'aggregate', 12)?.plan.id).toBe('Pro (API.Market)');
    expect(cheapestPlan(300, B, 'raw', 12)?.plan.id).toBe('Ultra 2 (API.Market)');
    expect(cheapestPlan(4_250, B, 'aggregate', 12)?.plan.id).toBe('Pro (API.Market)');
    expect(cheapestPlan(4_251, B, 'aggregate', 12)?.plan.id).toBe('Pro 2 (API.Market)');
    expect(cheapestPlan(4_251, B, 'aggregate', 12, ['RapidAPI'])?.plan.id).toBe('Ultra (RapidAPI)');
  });

  // The cost-model doc and CSV are research outputs kept in the private repository; skipped in the public snapshot.
  it.skipIf(!fs.existsSync(path.resolve(__dirname, '..', 'docs', 'FLIGHT_DATA_1_TO_20_AIRPORT_COST_MODEL.md')))('the published doc tables and CSV match a fresh run', () => {
    const root = path.resolve(__dirname, '..');
    const doc = fs.readFileSync(path.join(root, 'docs', 'FLIGHT_DATA_1_TO_20_AIRPORT_COST_MODEL.md'), 'utf8');
    const { blocks } = generated(PARAMS);
    for (const [k, v] of Object.entries(blocks)) expect(doc).toContain(`<!-- gen:${k} -->\n${v}\n<!-- /gen -->`);
    const csvText = fs.readFileSync(path.join(root, 'data', 'research', 'flightdata', 'aerodatabox-cost-model-1-20.csv'), 'utf8');
    expect(csvText.trim().split('\n')).toHaveLength(1 + 9 * 20);
  });
});

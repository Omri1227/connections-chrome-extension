// Skyscanner itinerary extraction from visible text (tests/fixtures/extension/*.txt).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkyscannerText, scheduledConnectionMinutes } from '../extension/src/core/skyscanner.ts';
import { connectionsOf } from '../extension/src/core/analyze.ts';
import { zoneFor } from '../extension/src/core/airports.ts';

const fx = (f: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'extension', f), 'utf8').replace(/^﻿/, '');
const TODAY = '2026-10-31';
const route = (it: ReturnType<typeof parseSkyscannerText>) => it.journeys.map((j) => [j.legs[0].from, ...j.legs.map((l) => l.to)].join('-'));

describe('Skyscanner results cards (no flight numbers)', () => {
  it('one stop: legs through the stop airport, missing numbers and connection times reported', () => {
    const it = parseSkyscannerText(fx('card-one-stop.txt'), TODAY);
    expect(route(it)).toEqual(['TLV-CDG-AMS']);
    const [a, b] = it.journeys[0].legs;
    expect(a).toMatchObject({ depTime: '08:15', arrTime: null, flightNumber: null });
    expect(b).toMatchObject({ depTime: null, arrTime: '15:20' });
    expect(it.missing).toContain('Journey, flight 1 (TLV→CDG): flight number');
    expect(it.missing).toContain('Journey, flight 1 (TLV→CDG): arrival time');
    expect(connectionsOf(it).map((c) => c.airport)).toEqual(['CDG']);
  });
  it('return card: outbound with a stop and a direct return are two journeys', () => {
    const it = parseSkyscannerText(fx('card-return.txt'), TODAY);
    expect(route(it)).toEqual(['TLV-FRA-LIS', 'LIS-TLV']);
    expect(it.journeys.map((j) => j.label)).toEqual(['Outbound', 'Return']);
    expect(connectionsOf(it).map((c) => c.airport)).toEqual(['FRA']);
  });
  it('two stops and self transfer', () => {
    const it = parseSkyscannerText(fx('card-two-stops.txt'), TODAY);
    expect(route(it)).toEqual(['TLV-IST-ZRH-BCN']);
    expect(it.journeys[0].selfTransfer).toBe(true);
    expect(connectionsOf(it).map((c) => c.airport)).toEqual(['IST', 'ZRH']);
  });
});

describe('Skyscanner itinerary details', () => {
  it('one connection with flight numbers, dates and operated-by', () => {
    const it = parseSkyscannerText(fx('details-one-stop.txt'), TODAY);
    expect(it.missing).toEqual([]);
    const [a, b] = it.journeys[0].legs;
    expect(a).toMatchObject({ flightNumber: 'AF1621', from: 'TLV', to: 'CDG', depDate: '2026-11-04', depTime: '08:15', arrDate: '2026-11-04', arrTime: '12:05' });
    expect(b).toMatchObject({ flightNumber: 'AF1240', from: 'CDG', to: 'AMS', depDate: '2026-11-04', depTime: '13:40', arrTime: '15:05', operatedBy: 'HOP!' });
    expect(scheduledConnectionMinutes(a, b)).toBe(95);
    expect(it.journeys[0].selfTransfer).toBeNull();
  });
  it('overnight +1, two connections, year inferred, self transfer', () => {
    const it = parseSkyscannerText(fx('details-overnight-self-transfer.txt'), TODAY);
    const [a, b, c] = it.journeys[0].legs;
    expect(a).toMatchObject({ flightNumber: 'LH691', depDate: '2026-11-13', arrDate: '2026-11-14', arrTime: '00:30' });
    expect(b).toMatchObject({ flightNumber: 'TK1588', from: 'FRA', to: 'IST', depDate: '2026-11-14', depTime: '02:40' });
    expect(c).toMatchObject({ flightNumber: 'TK1861', from: 'IST', to: 'LIS', depDate: '2026-11-14' });
    expect(scheduledConnectionMinutes(a, b)).toBe(130);
    expect(scheduledConnectionMinutes(b, c)).toBe(195);
    expect(it.journeys[0].selfTransfer).toBe(true);
    expect(connectionsOf(it).map((x) => x.airport)).toEqual(['FRA', 'IST']);
  });
  it('a direct flight has no connection', () => {
    const it = parseSkyscannerText(fx('details-direct.txt'), TODAY);
    expect(route(it)).toEqual(['TLV-LHR']);
    expect(it.journeys[0].legs[0].flightNumber).toBe('LY315');
    expect(connectionsOf(it)).toEqual([]);
  });
  it('en-US dates and 12-hour times; leading zeros dropped from flight numbers', () => {
    const it = parseSkyscannerText(fx('details-us-format.txt'), TODAY);
    const [a, b] = it.journeys[0].legs;
    expect(a).toMatchObject({ depTime: '08:15', arrTime: '12:05', depDate: '2026-11-04' });
    expect(b).toMatchObject({ flightNumber: 'AF10', depTime: '14:30', arrTime: '16:45' });
    expect(scheduledConnectionMinutes(a, b)).toBe(145);
  });
  it('outbound and return headings: one connection each', () => {
    const it = parseSkyscannerText(fx('details-return.txt'), TODAY);
    expect(it.journeys.map((j) => j.label)).toEqual(['Outbound', 'Return']);
    expect(route(it)).toEqual(['TLV-MUC-CDG', 'CDG-ZRH-TLV']);
    expect(it.journeys[1].legs[0]).toMatchObject({ flightNumber: 'LX633', depDate: '2026-11-15', operatedBy: 'Helvetic Airways' });
    expect(connectionsOf(it).map((c) => [c.airport, scheduledConnectionMinutes(c.inbound, c.outbound)])).toEqual([['MUC', 65], ['ZRH', 50]]);
  });
  it('an unsupported connecting airport is still parsed', () => {
    expect(connectionsOf(parseSkyscannerText(fx('details-unsupported.txt'), TODAY)).map((c) => c.airport)).toEqual(['ATH']);
  });
  it('text without an itinerary gives a warning, not a guess', () => {
    const it = parseSkyscannerText(fx('noise.txt'), TODAY);
    expect(it.journeys).toEqual([]);
    expect(it.warnings.join(' ')).toMatch(/No flight times/);
  });
});

describe('border zones', () => {
  it('Schengen by country of the other airport; IST domestic / international', () => {
    expect(zoneFor('CDG', 'TLV')).toBe('non-schengen');
    expect(zoneFor('CDG', 'AMS')).toBe('schengen');
    expect(zoneFor('FRA', 'OTP')).toBe('schengen');     // Romania, full member since 2025
    expect(zoneFor('FRA', 'DUB')).toBe('non-schengen');
    expect(zoneFor('IST', 'ESB')).toBe('domestic');
    expect(zoneFor('IST', 'LHR')).toBe('international');
    expect(zoneFor('CDG', 'XXX')).toBeNull();
  });
});

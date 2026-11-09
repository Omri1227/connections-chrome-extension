// Owner evidence batch of 2026-11-02 (docs/research/EVIDENCE_2026-11-02.md): AMS transfer-filter hours and one-stop
// origins, Iberia Tel Aviv deadlines at Madrid, SWISS check-in facilities at Zurich, MUC transfer services, Schengen list.
import { describe, expect, it } from 'vitest';
import ams from '../airportmaps/data/ams/airport.json';
import mad from '../airportmaps/data/mad/airport.json';
import muc from '../airportmaps/data/muc/airport.json';
import zrh from '../airportmaps/data/zrh/airport.json';
import type { AirportModel } from '../airportmaps/src/types.ts';
import { facilityState, findRoute, findSelfTransfer, oneStopCovered, specialScreeningFor } from '../airportmaps/src/route.ts';
import { checkInCloseFor, GENERIC } from '../extension/src/core/timing.ts';
import { SCHENGEN } from '../extension/src/core/airports.ts';

const A = ams as unknown as AirportModel, M = mad as unknown as AirportModel, U = muc as unknown as AirportModel, Z = zrh as unknown as AirportModel;
const D = '2026-11-04';
const codes = (r: ReturnType<typeof findRoute>) => r!.issues.map((i) => i.code);
const ctl = (r: ReturnType<typeof findRoute>) => r!.steps.filter((s) => s.control).map((s) => s.control!.kind);

describe('AMS one-stop security origins (Schiphol transfer page; EU 2025/920)', () => {
  it('US, Canada, UK, Ireland, Singapore, Cyprus, Belgrade and Schengen are exempt; Israel and other Serbian airports are not', () => {
    for (const [c, a] of [['US', 'JFK'], ['CA', 'YYZ'], ['GB', 'LHR'], ['IE', 'DUB'], ['SG', 'SIN'], ['CY', 'LCA'], ['RS', 'BEG'], ['FR', 'CDG'], ['CH', 'ZRH']])
      expect(oneStopCovered(A, { originCountry: c, originAirport: a }), `${a}`).toBe(true);
    expect(oneStopCovered(A, { originCountry: 'IL', originAirport: 'TLV' })).toBe(false);
    expect(oneStopCovered(A, { originCountry: 'RS', originAirport: 'INI' })).toBe(false);   // Serbia: Belgrade only
  });
  it('TLV arrival at pier G → D non-Schengen passes the transfer filter; a JFK arrival does not', () => {
    const tlv = findRoute(A, 'ams-g', 'ams-d-n', { transfer: true, originAirport: 'TLV', originCountry: 'IL', date: D, time: '14:00' });
    expect(ctl(tlv)).toContain('transfer-security');
    const jfk = findRoute(A, 'ams-g', 'ams-d-n', { transfer: true, originAirport: 'JFK', originCountry: 'US', date: D, time: '14:00' });
    expect(ctl(jfk)).not.toContain('transfer-security');
    expect(codes(jfk)).toContain('one-stop-exempt');
  });
  it('Schengen ↔ non-Schengen transfers pass passport control (security is separate)', () => {
    const r = findRoute(A, 'ams-b', 'ams-d-n', { transfer: true, originAirport: 'CDG', originCountry: 'FR', date: D, time: '14:00' });
    expect(ctl(r)).toContain('passport');
    expect(ctl(r)).not.toContain('transfer-security');
  });
});

describe('AMS transfer filter hours (EF 24/7, GH 04:30–23:30)', () => {
  const tlv = (time: string) => findRoute(A, 'ams-g', 'ams-d-n', { transfer: true, originAirport: 'TLV', originCountry: 'IL', date: D, time });
  it('GH is used up to its closing time; after 23:30 the airside way is closed for passengers who need the filter', () => {
    expect(r0(tlv('23:00'))).toBe(false);
    for (const t of ['23:40', '00:30', '04:00']) {
      const r = tlv(t)!;
      expect(r.entersCountry, t).toBe(true);
      expect(codes(r), t).toContain('checkpoint-closed');
    }
    expect(r0(tlv('04:40'))).toBe(false);
  });
  it('passengers exempt from transfer security are not affected by the GH hours', () => {
    const r = findRoute(A, 'ams-g', 'ams-d-n', { transfer: true, originAirport: 'JFK', originCountry: 'US', date: D, time: '00:30' })!;
    expect(r.entersCountry).toBe(false);
    expect(codes(r)).not.toContain('checkpoint-closed');
  });
  it('EF (piers E/F) is open 24/7: a TLV arrival at E connects airside at night', () => {
    const r = findRoute(A, 'ams-e', 'ams-d-n', { transfer: true, originAirport: 'TLV', originCountry: 'IL', date: D, time: '01:00' })!;
    expect(r.entersCountry).toBe(false);
    expect(ctl(r)).toContain('transfer-security');
  });
  it('untimed routes say the filter hours are assumed open', () => {
    const r = findRoute(A, 'ams-g', 'ams-d-n', { transfer: true, originAirport: 'TLV', originCountry: 'IL', date: D })!;
    expect(codes(r)).toContain('control-hours-assumed');
  });
  function r0(r: ReturnType<typeof findRoute>) { return !!r?.entersCountry; }
});

describe('MAD Iberia Tel Aviv (gate deadline, not a screening duration)', () => {
  it('a 90-min gate-presence deadline for Iberia flights to Israel only; no screening minutes are added', () => {
    const ib = specialScreeningFor(M, { destinationCountry: 'IL', airline: 'IB' }).find((s) => s.id === 'ss:mad-iberia-tlv')!;
    expect(ib.deadline?.minutesBeforeDeparture).toBe(90);
    expect(ib.deadline?.text).toMatch(/not the duration/);
    expect((ib as any).minutes).toBeUndefined();
    expect(specialScreeningFor(M, { destinationCountry: 'IL', airline: 'UX' }).some((s) => s.id === 'ss:mad-iberia-tlv')).toBe(false);
    expect(specialScreeningFor(M, { destinationCountry: 'US', airline: 'IB' }).some((s) => s.id === 'ss:mad-iberia-tlv')).toBe(false);
  });
  it('Iberia check-in closes 45 min (T4) / 55 min (T4S, incl. Tel Aviv) at Madrid only', () => {
    expect(checkInCloseFor('IB', false, 'FR', 'MAD').typical).toBe(45);
    expect(checkInCloseFor('IB', false, 'IL', 'MAD').typical).toBe(55);
    expect(checkInCloseFor('IB', true, 'US', 'MAD').typical).toBe(55);
    expect(checkInCloseFor('IB', false, 'ES', 'FRA')).toBe(GENERIC.checkInClose);   // not Madrid: unknown, generic
  });
});

describe('ZRH SWISS check-in facilities (Zurich Airport SWISS page)', () => {
  const hall = (id: string) => Z.areas.find((a) => a.id === id)!;
  const st = (t: string, al = 'LX', from = 'zrh-a') => findSelfTransfer(Z, from, 'zrh-e', { originAirport: 'CDG', originCountry: 'FR', destinationCountry: 'GB', airline: al, date: D, time: t })!;
  it('records desk and self-bag-drop hours separately, with the published qualifiers and the 04:00 / 04:30 conflict', () => {
    const f = hall('zrh-centre').checkIn!.facilities![0];
    expect(f).toMatchObject({ kind: 'self-bag-drop', hours: [{ from: '04:30', until: '17:30' }] });
    expect(f.hoursNote).toMatch(/04:00.*04:30/);
    expect(hall('zrh-t1').checkIn!.facilities![0]).toMatchObject({ kind: 'desk', hours: [{ from: '04:00', until: '22:00' }] });
  });
  it('a SWISS self-transfer reaching check-in after 22:00 or before 04:00 is told check-in is closed; other airlines are not', () => {
    expect(st('10:00').issues.map((i) => i.code)).not.toContain('check-in-closed');
    expect(st('22:30').issues.map((i) => i.code)).toContain('check-in-closed');
    expect(st('03:00').issues.map((i) => i.code)).toContain('check-in-closed');
    expect(st('22:30', 'U2').issues.map((i) => i.code)).not.toContain('check-in-closed');
  });
  it('only a self bag drop open → material note that a boarding pass from online check-in is needed', () => {
    const s = facilityState({ ...hall('zrh-t1'), checkIn: { ...hall('zrh-t1').checkIn!, facilities: hall('zrh-t2').checkIn!.facilities } }, 'LX', 20 * 60);
    expect(s.issues[0]).toMatchObject({ level: 'material', code: 'self-bag-drop-only' });
  });
  it('US flights on SWISS: a document check at check-in (no minutes invented)', () => {
    const s = specialScreeningFor(Z, { destinationCountry: 'US', airline: 'LX' }).find((x) => x.id === 'ss:zrh-lx-us-documents')!;
    expect(s.certainty).toBe('verified');
    expect(s.deadline).toBeUndefined();
  });
});

describe('MUC transfer services (official connecting-flights page, owner screenshots 2026-11-02)', () => {
  const line = (id: string) => U.lines.find((l) => l.id === id)!;
  it('T1–T2 shuttle bus: every 10 min 07:00–17:00, every 20 min 06:00–07:00 and 17:00–23:00, Schengen and non-Schengen stops', () => {
    for (const id of ['l:muc-bus-schengen', 'l:muc-bus-nonschengen']) {
      expect(line(id).service.map((s) => [s.windows, s.headwayMin.max])).toEqual([[[{ from: '07:00', until: '17:00' }], 10], [[{ from: '06:00', until: '07:00' }, { from: '17:00', until: '23:00' }], 20]]);
    }
    expect(line('l:muc-bus-schengen').stops).toEqual(['s:muc-bus-t1-c08', 's:muc-bus-t2-g83']);
    expect(line('l:muc-bus-nonschengen').stops).toEqual(['s:muc-bus-t1-a28', 's:muc-bus-t2-ns']);
  });
  it('PTS T2 ↔ Satellite: 04:00–24:00 every 4 min', () => {
    for (const id of ['l:muc-pts-schengen', 'l:muc-pts-nonschengen']) expect(line(id).service[0]).toMatchObject({ windows: [{ from: '04:00', until: '24:00' }], headwayMin: { min: 4, max: 4 } });
  });
});

describe('AMS Schengen exit passport filter (Departures Schengen S/NS 05:00–22:00; NS/S 24/7)', () => {
  const p = (time: string) => ({ transfer: true, originAirport: 'CDG', originCountry: 'FR', date: D, time });
  it('Schengen → non-Schengen uses the Lounge 1 → 2 filter by day; after 22:00 the route is flagged as avoiding a closed checkpoint', () => {
    const day = findRoute(A, 'ams-b', 'ams-d-n', p('21:00'))!;
    expect(day.steps.some((s) => s.refId === 'w:ams-l1-l2')).toBe(true);
    expect(codes(day)).not.toContain('checkpoint-closed');
    const night = findRoute(A, 'ams-b', 'ams-d-n', p('22:30'));
    expect(night === null || codes(night).includes('checkpoint-closed')).toBe(true);
  });
  it('non-Schengen → Schengen (entry filter, 24/7) is unaffected at night', () => {
    const r = findRoute(A, 'ams-e', 'ams-b', { ...p('23:30'), originAirport: 'JFK', originCountry: 'US' })!;
    expect(codes(r)).not.toContain('checkpoint-closed');
    expect(ctl(r)).toContain('passport');
  });
});

describe('EU one-stop list: Belgrade (Reg. 2020/111, not removed by 2025/920)', () => {
  it('BEG is exempt at FRA, MUC, ZRH and AMS; TLV is excluded everywhere', async () => {
    for (const iata of ['fra', 'muc', 'zrh']) {
      const m = (await import(`../airportmaps/data/${iata}/airport.json`)).default as AirportModel;
      expect(oneStopCovered(m, { originCountry: 'RS', originAirport: 'BEG' }), iata).toBe(true);
      expect(oneStopCovered(m, { originCountry: 'IL', originAirport: 'TLV' }), iata).toBe(false);
    }
    expect(oneStopCovered(A, { originCountry: 'RS', originAirport: 'BEG' })).toBe(true);
  });
});

describe('Schengen membership (EU Council)', () => {
  it('Bulgaria and Romania are members since 1 Jan 2025; Cyprus and Ireland are not; Switzerland, Norway, Iceland, Liechtenstein are', () => {
    for (const c of ['BG', 'RO', 'CH', 'NO', 'IS', 'LI', 'HR']) expect(SCHENGEN.has(c), c).toBe(true);
    for (const c of ['CY', 'IE', 'GB', 'IL', 'RS']) expect(SCHENGEN.has(c), c).toBe(false);
    expect(SCHENGEN.size).toBe(29);
  });
});

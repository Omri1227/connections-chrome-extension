// End-to-end scenario matrix (diagnostic, read-only): representative itineraries at all 8 airports through the real
// pipeline (analyzeConnection → resolver → router → timing → risk). History is a fixture built from real gate numbers of
// each model, so the run is deterministic and needs no server.
//   npx tsx extension/scripts/scenario-matrix.ts [--md]
import { analyzeConnection } from '../src/core/analyze.ts';
import { FixtureHistory, type ConnectionAnswer, type FieldAnswer, type FlightAnswer } from '../src/core/history.ts';
import { MODELS } from '../src/core/models.ts';
import { bestRoute } from '../src/core/summary.ts';
import type { ConnectionInput, Leg } from '../src/core/types.ts';

const D = '2026-11-18';
const MD = process.argv.includes('--md');
const field = (dist: [string, number][]): FieldAnswer => {
  const sample = dist.reduce((s, [, n]) => s + n, 0);
  return { status: sample >= 5 ? 'predicted' : sample ? 'insufficient-data' : 'no-data', value: sample >= 5 ? dist[0][0] : null, confidence: sample >= 5 ? 'medium' : null, confidenceScore: null, interval: null, sample,
    distribution: dist.map(([value, n]) => ({ value, n, share: sample >= 5 ? n / sample : null })), alternatives: [] } as FieldAnswer;
};
const flight = (fl: string, airport: string, direction: 'arrival' | 'departure', gates: [string, number][]): FlightAnswer => ({
  flight: fl, airport, direction, status: 'ok', date: D, terminal: field([]), gateArea: field([]), gate: field(gates), sameDay: null,
  basis: { flightDays: 30, fromCounters: 0, cancelled: 0, period: { from: '2026-10-15', to: '2026-11-14' }, sources: ['fixture'], lastRefresh: null }, notes: [] } as unknown as FlightAnswer);
/** History at terminal level only (LHR: the feed carries terminals, never gates). */
const terminalFlight = (fl: string, airport: string, direction: 'arrival' | 'departure', terms: [string, number][]): FlightAnswer => ({ ...flight(fl, airport, direction, []), terminal: field(terms) } as FlightAnswer);
const leg = (fn: string, from: string, to: string, dep: string, arr: string, depDate = D, arrDate = D): Leg => ({ flightNumber: fn, altNumbers: [], airline: null, operatedBy: null, from, to, depDate, depTime: dep, arrDate, arrTime: arr });

/** First gate of the first active gate group in an area of the given zone (excluding `not`). */
function gateIn(iata: string, zone: string, not?: string): { gate: string; area: string } | null {
  const m = MODELS[iata];
  for (const g of m.gateGroups) {
    const a = m.areas.find((x) => x.id === g.area)!;
    if (!g.gates.length || g.area === not || a.side !== 'airside') continue;
    if (a.zone === zone || (zone === 'non-schengen' && a.zone === 'international') || (zone === 'schengen' && a.zone === 'international' && (iata === 'IST' || iata === 'LHR'))) return { gate: g.gates[0], area: g.area };
  }
  return null;
}
type Sc = { name: string; c: ConnectionInput; arr?: [string, number][]; dep?: [string, number][]; byTerminal?: boolean };
/** LHR-specific cases (terminal-level history, the only level the feed carries at LHR): docs/research/LHR_FEASIBILITY_AND_MAPPING.md §8. */
const lhrCases = (): Sc[] => [
  { name: 'LHR T3→T5 BA, 120 min', c: { airport: 'LHR', inbound: leg('VS4', 'JFK', 'LHR', '18:00', '06:30', '2026-11-17'), outbound: leg('BA432', 'LHR', 'AMS', '08:30', '10:45'), selfTransfer: false }, arr: [['3', 20]], dep: [['5', 20]], byTerminal: true },
  { name: 'LHR T2→T4 El Al TLV, 180 min', c: { airport: 'LHR', inbound: leg('LH900', 'FRA', 'LHR', '07:00', '07:45'), outbound: leg('LY316', 'LHR', 'TLV', '10:45', '17:45'), selfTransfer: false }, arr: [['2', 20]], dep: [['4', 20]], byTerminal: true },
  { name: 'LHR intl→UK domestic T5, 120 min', c: { airport: 'LHR', inbound: leg('BA178', 'JFK', 'LHR', '18:00', '06:30', '2026-11-17'), outbound: leg('BA1432', 'LHR', 'EDI', '08:30', '09:55'), selfTransfer: false }, arr: [['5', 20]], dep: [['5', 20]], byTerminal: true },
  { name: 'LHR UK domestic→intl T5, 90 min', c: { airport: 'LHR', inbound: leg('BA1431', 'EDI', 'LHR', '06:00', '07:25'), outbound: leg('BA117', 'LHR', 'JFK', '08:55', '11:40'), selfTransfer: false }, arr: [['5', 20]], dep: [['5', 20]], byTerminal: true },
  { name: 'LHR self-transfer T4→T5, 210 min', c: { airport: 'LHR', inbound: leg('KL1001', 'AMS', 'LHR', '08:00', '08:30'), outbound: leg('BA404', 'LHR', 'TLV', '12:00', '18:50'), selfTransfer: true }, arr: [['4', 20]], dep: [['5', 20]], byTerminal: true },
];
const ORIGIN_NS = 'TLV', DEST_S = (iata: string) => (iata === 'IST' ? 'JFK' : iata === 'CDG' ? 'AMS' : 'CDG');
const rows: string[][] = [];
for (const iata of Object.keys(MODELS)) {
  const ns = gateIn(iata, 'non-schengen'), s = gateIn(iata, iata === 'IST' || iata === 'LHR' ? 'international' : 'schengen', ns?.area);
  const sc: Sc[] = [
    { name: 'protected, no history, 90 min', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), outbound: leg('XX200', iata, DEST_S(iata), '11:30', '13:00'), selfTransfer: false } },
    { name: 'protected, gates known, 90 min', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), outbound: leg('XX200', iata, DEST_S(iata), '11:30', '13:00'), selfTransfer: false }, arr: ns ? [[ns.gate, 20]] : [], dep: s ? [[s.gate, 20]] : [] },
    { name: 'same area (gate history), 60 min', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), outbound: leg('XX200', iata, ORIGIN_NS === 'TLV' ? 'JFK' : 'JFK', '11:00', '19:00'), selfTransfer: false }, arr: ns ? [[ns.gate, 20]] : [], dep: ns ? [[ns.gate, 20]] : [] },
    { name: 'self-transfer, 150 min', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), outbound: leg('XX200', iata, DEST_S(iata), '12:30', '14:00'), selfTransfer: true } },
    { name: 'ticket type unknown, 120 min', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), outbound: leg('XX200', iata, DEST_S(iata), '12:00', '13:30'), selfTransfer: null } },
    { name: 'night arrival 01:30, 120 min', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '21:00', '01:30', D, '2026-11-19'), outbound: leg('XX200', iata, DEST_S(iata), '03:30', '05:00', '2026-11-19', '2026-11-19'), selfTransfer: false } },
    { name: 'to Tel Aviv, 120 min', c: { airport: iata, inbound: leg('XX100', 'JFK', iata, '18:00', '08:00', '2026-11-17'), outbound: leg('XX200', iata, 'TLV', '10:00', '15:00'), selfTransfer: false } },
    { name: 'overnight +1 (22 h)', c: { airport: iata, inbound: leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), outbound: leg('XX200', iata, DEST_S(iata), '08:00', '09:30', '2026-11-19', '2026-11-19'), selfTransfer: false } },
    ...(iata === 'LHR' ? lhrCases() : []),
    { name: 'missing arrival date', c: { airport: iata, inbound: { ...leg('XX100', ORIGIN_NS, iata, '06:00', '10:00'), arrDate: null, depDate: null }, outbound: leg('XX200', iata, DEST_S(iata), '11:30', '13:00'), selfTransfer: false } },
  ];
  for (const x of sc) {
    const mk = x.byTerminal ? terminalFlight : flight;
    const ans: ConnectionAnswer | null = x.arr || x.dep ? ({ query: {} as never, status: 'ok', airport: iata, airportCandidates: [iata], arrival: mk('XX100', iata, 'arrival', x.arr ?? []), departure: mk('XX200', iata, 'departure', x.dep ?? []), sameTerminalHistorically: null, notes: [] } as unknown as ConnectionAnswer) : null;
    const r = await analyzeConnection(x.c, { models: MODELS, history: new FixtureHistory(() => ans), today: '2026-11-14' });
    const a = r.assessment;
    const b = a ? bestRoute(MODELS[iata], r) : null;
    const route = b && (b as any).combo ? `${(b as any).combo.arrival.area.id.replace(/^[a-z]+-/, '')}→${(b as any).combo.departure.area.id.replace(/^[a-z]+-/, '')}${b.illustrative ? ' (illustrative)' : ''}` : '–';
    const needed = a?.combos?.length ? (() => { const c = (b as any)?.combo ?? a.combos[0]; return c?.needed ? `${c.needed.typical}/${c.needed.high ?? c.needed.max}` : '–'; })() : '–';
    const issues = new Set<string>();
    for (const c of b ? [b.combo] : []) for (const i of (c.route?.issues ?? []) as { level: string; code: string }[]) if (i.level !== 'secondary') issues.add(`${i.level[0]}:${i.code}`);
    rows.push([iata, x.name, r.status, a?.verdict ?? '–', route, needed, [...issues].slice(0, 4).join(' ') + (r.notAssessed ? ` [${r.notAssessed.code}]` : '') + (r.caveats.length ? ` caveats:${r.caveats.length}` : '')]);
  }
}
const head = ['Airport', 'Scenario', 'Status', 'Verdict', 'Displayed route', 'Needed typ/high', 'Material issues / notes'];
if (MD) { console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`); for (const r of rows) console.log(`| ${r.join(' | ')} |`); }
else for (const r of rows) console.log(r.join('\t'));

// Rome Fiumicino (FCO) — the public real-time flight board of Aeroporti di Roma (adr.it), server-rendered HTML.
//
// Why this source is allowed (docs/FLIGHT_DATA_SOURCE_RESEARCH.md §FCO): robots.txt allows everything; the legal notice
// (https://www.adr.it/azn-note-legali) permits saving extracts "per uso strettamente personale o per le finalità riferite
// alla propria organizzazione aziendale" and forbids commercial disposal of the content without ADR's authorisation.
// So: research collection for our own organisation is permitted; using the content (or statistics derived from it) in a
// commercial passenger product needs ADR's written authorisation first.
//
// What the list gives: listed flight number, carrier name, "Operated by" link for codeshare rows, other airport,
// scheduled time (struck through when changed), effective time, terminal (T1/T3), status, ADR flight id.
// No gate in the list: gates only appear on per-flight detail pages (~670 kB each), which are NOT fetched by default
// (FD_FCO_DETAIL_MAX, default 0) to keep the load on ADR small.
import { politeGet } from '../http.ts';
import { normFlightNumber, normStatus, normTerminal } from '../normalize.ts';
import { addDays, zonedInstant } from '../time.ts';
import type { AirportInfo, Direction, FetchContext, NormalizedFlight, ParseIssue, SourceAdapter, Window, WindowResult } from '../types.ts';

const BASE = 'https://www.adr.it/web/aeroporti-di-roma-en/pax-fco-realtime-flight';
const DETAIL = 'https://www.adr.it/web/aeroporti-di-roma-en/fco-flight-detail';
const PAGE_SIZE = 200; // the portlet caps a page at 200 rows whatever "delta" asks for
const MAX_PAGES = 15;  // ~1,450 rows a day → 8 pages; the cap protects against a pagination loop

export function listUrl(direction: Direction, date: string, page: number) {
  const P = '_3_WAR_realtimeflightsportlet_';
  const q = new URLSearchParams({ p_p_id: '3_WAR_realtimeflightsportlet', p_p_lifecycle: '0', p_p_state: 'normal', p_p_mode: 'view',
    [`${P}tab`]: direction === 'arrival' ? 'arrival' : 'departure', [`${P}date`]: date, [`${P}orario`]: '00:00-24:00',
    [`${P}searchType`]: 'completeSmall', [`${P}delta`]: String(PAGE_SIZE), [`${P}cur`]: String(page) });
  return `${BASE}?${q}`;
}
export const detailUrl = (id: string) => `${DETAIL}?p_p_id=4_WAR_realtimeflightsportlet&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&_4_WAR_realtimeflightsportlet_idFlight=${encodeURIComponent(id)}`;

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export interface FcoRow { idFlight: string | null; listed: string; carrierName: string | null; operatedBy: string | null; otherName: string | null; other: string | null;
  scheduled: string | null; effective: string | null; terminal: string | null; status: string | null }

/** Total entries reported by the board ("Showing 1 to 200 of 1,456 entries."), or null if the text is missing. */
export function totalEntries(html: string): number | null {
  const m = /of\s+([\d.,]+)\s+entries/i.exec(html);
  return m ? Number(m[1].replace(/[.,]/g, '')) : null;
}

export function parseRows(html: string): { rows: FcoRow[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const chunks = html.split(/<tr[\s>]/).slice(1).filter((r) => r.includes('flight-numb'));
  const rows: FcoRow[] = [];
  for (const c of chunks) {
    // Cell content: from the end of the <td …> opening tag that carries the class to its closing </td>.
    const cell = (cls: string) => { const i = c.indexOf(cls); if (i < 0) return null; const open = c.indexOf('>', i); const end = c.indexOf('</td>', open); return c.slice(open + 1, end < 0 ? undefined : end); };
    const time = cell('lfr-scheduled-time-column');
    const code = cell('lfr-departure-column-column') ?? cell('lfr-arrival-column-column') ?? cell('-column-column');
    // The other airport: "lfr-flight-destination-column" on departures, "lfr-flight-departure-column" on arrivals.
    const dest = cell('lfr-flight-destination-column') ?? cell('lfr-flight-departure-column') ?? cell('lfr-flight-origin-column');
    const term = cell('lfr-terminal-column');
    const stat = cell('lfr-flight-status-column');
    if (!time || !code) { issues.push({ kind: 'format-change', detail: 'row without the expected time/flight columns', sample: strip(c).slice(0, 160) }); continue; }
    const nums = [...code.matchAll(/<strong>\s*([^<]+?)\s*<\/strong>/g)].map((m) => m[1].trim());
    const op = /Operated by:?\s*<\/?[^>]*>?[\s\S]*?<strong>\s*([^<]+?)\s*<\/strong>/i.exec(code);
    const otherTxt = dest ? strip(dest) : null;
    rows.push({
      idFlight: /idFlight=(\d+)/.exec(c)?.[1] ?? null,
      listed: nums[0] ?? '',
      carrierName: /<span>([^<]+)<\/span>/.exec(code)?.[1]?.trim() ?? null,
      operatedBy: /Operated by/i.test(code) ? (op?.[1] ?? nums[1] ?? null) : null,
      otherName: otherTxt, other: otherTxt ? /\(([A-Z0-9]{3,4})\)\s*$/.exec(otherTxt)?.[1] ?? null : null,
      scheduled: /date-estimated__time[^>]*>\s*(\d{1,2}:\d{2})/.exec(time)?.[1] ?? null,
      effective: /date-actual__time[^>]*>\s*(\d{1,2}:\d{2})/.exec(time)?.[1] ?? null,
      terminal: term ? /terminal-icon[^>]*>\s*([^<]+)</.exec(term)?.[1]?.trim() ?? null : null,
      status: stat ? strip(stat).replace(/^Flight status:\s*/i, '').replace(/\s*Details\s*$/i, '').trim() || null : null,
    });
  }
  return { rows, issues };
}

/**
 * Resolves an HH:MM on the board to an instant. The scheduled time belongs to the board's date. An effective time can
 * fall on the previous or next day (an arrival scheduled 00:05 landing 23:58): the instant nearest the schedule is used.
 */
export function resolveTimes(date: string, scheduled: string, effective: string | null, tz: string) {
  const s = zonedInstant(date, scheduled.padStart(5, '0'), tz);
  if (!effective) return { scheduled: s, effective: null };
  const cands = [-1, 0, 1].map((d) => zonedInstant(addDays(date, d), effective.padStart(5, '0'), tz));
  const e = cands.sort((a, b) => Math.abs(a.getTime() - s.getTime()) - Math.abs(b.getTime() - s.getTime()))[0];
  return { scheduled: s, effective: e };
}

export function toRecord(r: FcoRow, airport: AirportInfo, direction: Direction, date: string): { record: NormalizedFlight | null; issue?: ParseIssue } {
  const fn = normFlightNumber(r.listed);
  if (!fn) return { record: null, issue: { kind: 'rejected-row', detail: `unreadable flight number "${r.listed}"` } };
  if (!r.scheduled) return { record: null, issue: { kind: 'rejected-row', detail: `no scheduled time (${fn.number})` } };
  const op = r.operatedBy ? normFlightNumber(r.operatedBy) : null;
  const status = /tracking/i.test(r.status ?? '') ? 'unknown' : normStatus(r.status);
  const t = resolveTimes(date, r.scheduled, r.effective, airport.tz);
  const moved = ['departed', 'landed', 'arrived'].includes(status);
  return {
    record: {
      airport: airport.iata, direction, flightNumber: fn.number, carrier: fn.carrier,
      // The board lists codeshares as separate rows with "Operated by"; a row without it is the operating flight.
      operatingFlightNumber: op?.number ?? null, role: op ? 'marketing' : 'operating', codeshares: [],
      airlineName: r.carrierName, origin: direction === 'arrival' ? r.other : airport.iata, destination: direction === 'departure' ? r.other : airport.iata,
      scheduledUtc: t.scheduled.toISOString(),
      estimatedUtc: t.effective && !moved ? t.effective.toISOString() : null,
      actualUtc: t.effective && moved ? t.effective.toISOString() : null,
      terminal: normTerminal(r.terminal), gate: null, stand: null, baggageBelt: null,
      status, statusRaw: r.status, aircraftType: null, sourceRecordId: r.idFlight,
      extra: r.other ? undefined : { otherName: r.otherName },
    },
  };
}

/** Gate from a detail page ("Gate: A82"); null when absent or "-" (not yet assigned). */
export function parseDetailGate(html: string): { gate: string | null; terminal: string | null } {
  const s = strip(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, ''));
  const g = /Gate:\s*([A-Z]{0,2}\d{0,3}[A-Z]?|-)\b/.exec(s)?.[1] ?? null;
  const t = /Terminal:\s*(\d)/.exec(s)?.[1] ?? null;
  return { gate: g && g !== '-' && g.length ? g : null, terminal: t };
}

export const adrFco: SourceAdapter = {
  info: {
    id: 'adr-fco-web', name: 'Aeroporti di Roma — FCO real-time flight board (adr.it)', kind: 'website-json', airports: ['FCO'],
    baseUrl: BASE, termsUrl: 'https://www.adr.it/azn-note-legali',
    termsSummary: 'robots.txt allows all paths. Legal notice: saving extracts is permitted for strictly personal use or for one\'s own organisation; any commercial disposal of the content needs ADR\'s express authorisation. No clause on automated retrieval.',
    permission: 'pending-owner-approval',
    retention: 'Own-organisation research use; commercial use of the data or derived statistics requires ADR authorisation',
    costNote: 'Free. ≈ 8 list pages (~1.3 MB each) per direction-day.',
    capabilities: { fields: { terminal: true, gate: false, stand: false, estimatedTime: true, actualTime: true, status: true, codeshares: true, operatingFlag: true }, maxWindowHours: 24, pastDays: 1, futureDays: 3, requiresKey: false },
  },
  notReady: () => null,
  windows(a, direction, date) {
    return [{ direction, localDate: date, fromUtc: zonedInstant(date, '00:00', a.tz).toISOString(), toUtc: zonedInstant(addDays(date, 1), '00:00', a.tz).toISOString(), label: `${direction}:${date}` }];
  },
  async fetchWindow(airport: AirportInfo, w: Window, ctx: FetchContext): Promise<WindowResult> {
    const out: WindowResult = { window: w, ok: false, httpStatus: null, pages: 0, rawCount: 0, records: [], issues: [], error: null, bytes: 0 };
    let total: number | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await politeGet(ctx.fetch, listUrl(w.direction, w.localDate, page), { minSpacingMs: 3000, timeoutMs: 60_000, headers: { Accept: 'text/html' } });
      out.httpStatus = r.status; out.bytes += r.bytes; out.pages++;
      if (!r.ok) { out.error = `page ${page}: ${r.error}`; return out; }
      if (/_Incapsula_Resource|captcha/i.test(r.body.slice(0, 5000))) { out.error = 'bot protection page returned: stopping (not circumvented)'; return out; }
      const t = totalEntries(r.body);
      if (page === 1) total = t;
      const { rows, issues } = parseRows(r.body);
      out.issues.push(...issues);
      out.rawCount += rows.length;
      for (const row of rows) { const x = toRecord(row, airport, w.direction, w.localDate); if (x.record) out.records.push(x.record); if (x.issue) out.issues.push(x.issue); }
      if (page === 1) out.rawSample = { url: listUrl(w.direction, w.localDate, 1), totalEntries: t, firstRows: rows.slice(0, 3) };
      if (!rows.length || total === null || out.rawCount >= total) break;
    }
    if (total === null) out.issues.push({ kind: 'format-change', detail: 'entry count text ("of N entries") not found: completeness cannot be checked' });
    else if (out.rawCount < total) out.issues.push({ kind: 'format-change', detail: `board reports ${total} entries but ${out.rawCount} rows were read` });
    // Optional, capped gate sampling from detail pages (off by default).
    const maxDetail = Number(ctx.env.FD_FCO_DETAIL_MAX ?? 0) | 0;
    if (maxDetail > 0) {
      const cands = out.records.filter((r) => r.role === 'operating' && r.sourceRecordId).slice(0, maxDetail);
      for (const rec of cands) {
        const d = await politeGet(ctx.fetch, detailUrl(rec.sourceRecordId!), { minSpacingMs: 3000, timeoutMs: 60_000, headers: { Accept: 'text/html' } });
        out.bytes += d.bytes; out.pages++;
        if (d.ok) rec.gate = parseDetailGate(d.body).gate;
      }
    }
    out.ok = true;
    return out;
  },
};

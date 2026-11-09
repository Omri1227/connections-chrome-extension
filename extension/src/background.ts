// Service worker: runs the connection analysis (bundled airport models + routing) and talks to the flight-data server.
// The only network request the extension makes is to the configured flight-data server, and only with the two flight
// numbers, the date(s) and the connecting airport, after the traveller asked for an analysis.
import { analyzeConnection } from './core/analyze.ts';
import { LocalServerHistory, type HistoryProvider } from './core/history.ts';
import { MODELS } from './core/models.ts';
import { DEFAULT_SETTINGS, originPattern, type Request, type Response, type Settings } from './messages.ts';

async function settings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['serverUrl', 'token', 'passenger']);
  return { serverUrl: s.serverUrl || DEFAULT_SETTINGS.serverUrl, token: s.token || '', passenger: s.passenger === 'ees-exempt' || s.passenger === 'ees-registered' ? s.passenger : undefined };
}

async function provider(): Promise<HistoryProvider> {
  const s = await settings();
  if (!s.token) return new LocalServerHistory('', '');
  let allowed = false;
  try { allowed = await chrome.permissions.contains({ origins: [originPattern(s.serverUrl)] }); } catch { allowed = false; }
  if (!allowed) return { connection: async () => ({ ok: false, reason: 'no-permission', detail: 'Access to the flight-data server has not been allowed yet (extension settings → Allow access).' }) };
  return new LocalServerHistory(s.serverUrl, s.token);
}

async function handle(msg: Request): Promise<Response> {
  if (msg.type === 'analyze') {
    const history = await provider();
    const { passenger } = await settings();
    const views = [];
    for (const c of msg.connections) {
      const analysis = await analyzeConnection(c, { models: MODELS, history, today: msg.today, passenger });
      views.push({ analysis, model: MODELS[c.airport] ?? null });
    }
    return { type: 'analysis', views };
  }
  if (msg.type === 'test-server') {
    const s = await settings();
    try {
      const r = await fetch(new URL('/fd-api/health', s.serverUrl), { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { type: 'server', ok: false, detail: `HTTP ${r.status}` };
      const auth = await fetch(new URL('/fd-api/v1/flight?airport=CDG&flight=AF1&date=2026-01-01&direction=arrival', s.serverUrl), { headers: { Authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(4000) });
      return { type: 'server', ok: auth.ok, detail: auth.ok ? 'Connected: the server answers and accepts the token.' : auth.status === 401 ? 'The server answers but rejects the token.' : `The server answered HTTP ${auth.status}.` };
    } catch (e) { return { type: 'server', ok: false, detail: `Not reachable: ${(e as Error).message}` }; }
  }
  return { type: 'error', detail: 'unknown request' };
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  handle(msg as Request).then(send, (e) => send({ type: 'error', detail: (e as Error).message } satisfies Response));
  return true;   // answer asynchronously
});

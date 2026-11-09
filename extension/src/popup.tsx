// Extension popup (also opened as a tab: popup.html?view=tab). Two input modes, one analysis engine:
//   "Read the Skyscanner page" — the in-page "Analyze connection" button (content script), or manual entry here;
//   "Paste a screenshot"       — a screenshot read on this computer, confirmed by the traveller, then analysed.
// Plus the settings of the flight-data server.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import panelCssModule from './ui/panel.css';
import shotCssModule from './ui/screenshot.css';
import mapCssModule from '../../airportmaps/app/app.css';
import { localToday } from './core/time.ts';
// esbuild loads .css as text (scripts/build.ts); the vite/client typing of *.css does not know that
const panelCss = panelCssModule as unknown as string, mapCss = mapCssModule as unknown as string, shotCss = shotCssModule as unknown as string;
import { Badge, Panel, type AnalysisView } from './ui/Panel.tsx';
import { ManualForm, blankConnection } from './ui/ManualForm.tsx';
import { ScreenshotMode } from './ui/ScreenshotMode.tsx';
import { connectionsOf } from './core/analyze.ts';
import { DEFAULT_SETTINGS, originPattern, type Response } from './messages.ts';
import type { ConnectionInput, Itinerary } from './core/types.ts';
import type { Draft } from './screenshot/types.ts';

type Mode = 'page' | 'screenshot';
const params = new URLSearchParams(location.search);
const inTab = params.get('view') === 'tab';

function Settings() {
  const [url, setUrl] = useState(DEFAULT_SETTINGS.serverUrl);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [passenger, setPassenger] = useState('');
  useEffect(() => { chrome.storage.local.get(['serverUrl', 'token', 'passenger']).then((s) => { if (s.serverUrl) setUrl(s.serverUrl); if (s.token) setToken(s.token); if (s.passenger) setPassenger(s.passenger); }); }, []);
  const savePassenger = async (v: string) => { setPassenger(v); await chrome.storage.local.set({ passenger: v }); };
  const save = async () => {
    try { new URL(url); } catch { return setMsg('Not a valid address.'); }
    await chrome.storage.local.set({ serverUrl: url, token });
    // Optional host permission: asked only for this server, only when the traveller clicks.
    const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
    if (!granted) return setMsg('Saved, but access to the server was not allowed: history will be unavailable.');
    const r = await chrome.runtime.sendMessage<Response>({ type: 'test-server' });
    setMsg(r.type === 'server' ? r.detail : 'Saved.');
  };
  return (
    <div className="cx-form">
      <p className="cx-small cx-muted">Historical terminal and gate data comes from the Connections Analyst flight-data server (pilot: on this computer). Only the two flight numbers, the date and the connecting airport are sent to it.</p>
      <label>Flight-data server <input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      <label>Access token <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
      <button type="submit" onClick={(e) => { e.preventDefault(); void save(); }}>Save and allow access</button>
      <label>Passport (for passport-control times; stays on this computer)
        <select value={passenger} onChange={(e) => void savePassenger(e.target.value)}>
          <option value="">Not set (times for non-EU passports)</option>
          <option value="ees-registered">Non-EU passport, e.g. Israeli, UK, US (registered in the EU Entry/Exit System)</option>
          <option value="ees-exempt">EU / EEA / Swiss citizen, or Schengen residence permit (not registered in EES)</option>
        </select>
      </label>
      {msg && <p className="cx-note cx-small">{msg}</p>}
    </div>
  );
}

function ModeSwitch({ mode, set }: { mode: Mode; set: (m: Mode) => void }) {
  return (
    <div className="cx-modes" role="radiogroup" aria-label="How to enter the itinerary">
      <button role="radio" aria-checked={mode === 'page'} className={mode === 'page' ? 'on' : ''} onClick={() => set('page')}>Read the Skyscanner page</button>
      <button role="radio" aria-checked={mode === 'screenshot'} className={mode === 'screenshot' ? 'on' : ''} onClick={() => set('screenshot')}>Paste a screenshot</button>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<'analyze' | 'settings'>('analyze');
  const [mode, setModeState] = useState<Mode | null>(params.get('mode') === 'screenshot' ? 'screenshot' : null);
  const [views, setViews] = useState<AnalysisView[] | null>(null);
  const [source, setSource] = useState<'manual' | 'screenshot'>('manual');
  const [busy, setBusy] = useState(false);
  const [initial, setInitial] = useState<ConnectionInput>(blankConnection());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resume, setResume] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  // the chosen mode is remembered on this computer (chrome.storage.local); the screenshot itself never is
  useEffect(() => { if (!mode) chrome.storage.local.get(['inputMode']).then((s) => setModeState(s.inputMode === 'screenshot' ? 'screenshot' : 'page')); }, []);
  const setMode = (m: Mode) => { setModeState(m); setViews(null); setErr(''); setResume(null); void chrome.storage.local.set({ inputMode: m }); };

  const analyse = async (cs: ConnectionInput[], src: 'manual' | 'screenshot') => {
    setBusy(true); setErr('');
    const r = await chrome.runtime.sendMessage<Response>({ type: 'analyze', connections: cs, today: localToday() });
    setBusy(false);
    if (r.type === 'analysis') { setViews(r.views); setSource(src); } else setErr(r.type === 'error' ? r.detail : 'unexpected answer');
  };
  const runManual = (c: ConnectionInput) => { setInitial(c); void analyse([c], 'manual'); };
  const runScreenshot = (it: Itinerary, d: Draft) => { setDraft(d); setResume(null); void analyse(connectionsOf(it), 'screenshot'); };

  return (
    <div className={`cx-root cx-popup${inTab ? ' cx-tabview' : ''}`}>
      <nav className="cx-tabs"><button className={tab === 'analyze' ? 'on' : ''} onClick={() => setTab('analyze')}>Analyze</button><button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button></nav>
      {tab === 'settings' ? <Settings /> : !mode ? null : views ? <>
        <button className="cx-link" onClick={() => { setViews(null); setResume(null); }}>← New analysis</button>
        {source === 'screenshot' && <p className="cx-small cx-provenance"><Badge k="observed" /> Itinerary read from your screenshot and confirmed by you (read on this computer, not stored).</p>}
        <Panel views={views}
          onEdit={(v) => { if (source === 'screenshot') { setResume(draft); setViews(null); } else { setInitial(v.analysis.input); setViews(null); } }}
          onTicketType={(v, selfTransfer) => void analyse(views.map((x) => (x === v ? { ...x.analysis.input, selfTransfer } : x.analysis.input)), source)} />
      </> : <>
        <ModeSwitch mode={mode} set={setMode} />
        {mode === 'page' ? <>
          <p className="cx-small cx-muted">On Skyscanner, use the “Analyze connection” button on the page. Or enter a connection here.</p>
          <ManualForm initial={initial} onSubmit={runManual} busy={busy} />
        </> : <ScreenshotMode inTab={inTab} busy={busy} onAnalyse={runScreenshot} resume={resume} />}
        {err && <p className="cx-note">{err}</p>}
      </>}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = mapCss + '\n' + panelCss + '\n' + shotCss + `\nbody { ${inTab ? 'max-width: 860px; margin: 0 auto; padding: 16px 20px;' : 'width: 600px; min-height: 420px; padding: 10px 12px;'} }`;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<App />);

// Browser-test build only: hooks for extension/scripts/screenshot-ocr.mjs (OCR accuracy runs on the packaged engine).
if (__TEST_BUILD__) {
  (window as any).__cdgxShot = {
    read: async (dataUrl: string, psm?: string, scale?: number, gamma?: number) => { const { readImage } = await import('./screenshot/ocr.ts'); return readImage(await (await fetch(dataUrl)).blob(), { psm, scale, gamma }); },
  };
}

// Content script on Skyscanner pages. Nothing is read until the traveller clicks "Analyze connection" and then clicks an
// itinerary (or has selected its text). Only that element's visible text is parsed, in the page; nothing is sent to
// Skyscanner or stored. Everything is drawn inside a closed shadow root so the page's styles and ours do not mix.
import { createRoot } from 'react-dom/client';
import { Component, useState, type ReactNode } from 'react';
import panelCssModule from './ui/panel.css';
import mapCssModule from '../../airportmaps/app/app.css';
// esbuild loads .css as text (scripts/build.ts); the vite/client typing of *.css does not know that
const panelCss = panelCssModule as unknown as string, mapCss = mapCssModule as unknown as string;
import { connectionsOf } from './core/analyze.ts';
import { parseSkyscannerText } from './core/skyscanner.ts';
import type { ConnectionInput, Itinerary } from './core/types.ts';
import { Panel, type AnalysisView } from './ui/Panel.tsx';
import { ManualForm, blankConnection } from './ui/ManualForm.tsx';
import type { Request, Response } from './messages.ts';

import { localToday } from './core/time.ts';

const today = () => localToday();   // the device's local date, not UTC (R-40)
const TIME = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;
const CODE = /\b[A-Z]{3}\b/g;

/** The smallest ancestor of `el` that looks like a whole itinerary: ≥ 2 times and ≥ 2 airport-like codes. */
export function itineraryElement(el: Element | null): HTMLElement | null {
  for (let e = el as HTMLElement | null, depth = 0; e && e !== document.body && depth < 25; e = e.parentElement, depth++) {
    const t = e.innerText ?? '';
    if (t.length > 6000) return null;
    if ((t.match(TIME)?.length ?? 0) >= 2 && (t.match(CODE)?.length ?? 0) >= 2) return e;
  }
  return null;
}

async function ask(req: Request): Promise<Response> {
  try { return await chrome.runtime.sendMessage<Response>(req); }
  catch (e) {
    // after the extension is reloaded or updated, scripts already in open tabs lose their connection to it
    const m = (e as Error).message ?? String(e);
    return { type: 'error', detail: /context invalidated|Receiving end does not exist/i.test(m) ? 'The extension was reloaded or updated. Reload this page, then try again.' : m };
  }
}

/** Keeps a rendering error inside the drawer: without it React unmounts the whole tree and the button disappears. */
class Boundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <aside className="cx-drawer" role="dialog" aria-label="Connection analysis">
      <button className="cx-close" onClick={() => { this.setState({ error: null }); this.props.onReset(); }} aria-label="Close">✕</button>
      <p className="cx-note">Something went wrong while showing the result: {this.state.error.message}</p>
    </aside>;
  }
}

// While the traveller picks an itinerary, the page must not also react to that press: Skyscanner opens or re-renders a
// card on pointer/mouse down, which tore our host out of the page (2026-11-09 owner report). The click itself is
// handled by us; the presses before it are stopped (touch is not preventDefault-ed, or the browser sends no click).
const SHIELDED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'auxclick', 'dblclick'] as const;
const shield = (e: Event) => { e.stopImmediatePropagation(); if (!e.type.startsWith('touch')) e.preventDefault(); };

type State =
  | { k: 'idle' } | { k: 'picking' } | { k: 'busy'; note: string }
  | { k: 'result'; views: AnalysisView[]; itinerary: Itinerary | null }
  | { k: 'manual'; initial: ConnectionInput; note: string }
  | { k: 'error'; detail: string };

function App() {
  const [s, set] = useState<State>({ k: 'idle' });
  const [hl, setHl] = useState<DOMRect | null>(null);

  const analyse = async (cs: ConnectionInput[], itinerary: Itinerary | null) => {
    set({ k: 'busy', note: 'Analysing…' });
    const r = await ask({ type: 'analyze', connections: cs, today: today() });
    if (r.type === 'analysis') set({ k: 'result', views: r.views, itinerary });
    else set({ k: 'error', detail: r.type === 'error' ? r.detail : 'unexpected answer' });
  };
  const fromText = (text: string) => {
    const it = parseSkyscannerText(text, today());
    const cs = connectionsOf(it);
    if (!cs.length) {
      const why = it.journeys.length ? 'This itinerary has no change of plane (direct flight).' : it.warnings.join(' ') || 'No itinerary was recognised.';
      return set({ k: 'manual', initial: blankConnection(), note: `${why} You can enter the connection by hand.` });
    }
    void analyse(cs, it);
  };
  const start = () => {
    const sel = window.getSelection()?.toString() ?? '';
    if (sel.trim().length > 20) return fromText(sel);
    set({ k: 'picking' });
    const move = (e: MouseEvent) => { const el = itineraryElement(e.target as Element); setHl(el ? el.getBoundingClientRect() : null); };
    const done = () => {
      document.removeEventListener('mousemove', move, true); window.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true);
      // the press events of this click are already dispatched; release the shield after them
      setTimeout(() => SHIELDED.forEach((t) => window.removeEventListener(t, shield, true)), 0);
      setHl(null);
    };
    const click = (e: MouseEvent) => {
      e.preventDefault(); e.stopImmediatePropagation(); done();
      const el = itineraryElement(e.target as Element);
      if (el) fromText(el.innerText); else set({ k: 'manual', initial: blankConnection(), note: 'That part of the page does not look like an itinerary. Try clicking inside a flight card or the itinerary details, or enter the connection by hand.' });
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { done(); set({ k: 'idle' }); } };
    // window (capture) runs before any listener of the page, including its own document/root capture listeners
    SHIELDED.forEach((t) => window.addEventListener(t, shield, true));
    document.addEventListener('mousemove', move, true); window.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
  };
  const close = () => set({ k: 'idle' });

  return (
    <Boundary onReset={close}>
    <div className="cx-root">
      {s.k === 'idle' && <button className="cx-fab" onClick={start} title="Click, then click an itinerary on the page">Analyze connection</button>}
      {s.k === 'picking' && <div className="cx-hint">Click the itinerary to analyse · Esc to cancel</div>}
      {hl && <div className="cx-hl" style={{ left: hl.left - 3, top: hl.top - 3, width: hl.width + 6, height: hl.height + 6 }} />}
      {(s.k === 'busy' || s.k === 'result' || s.k === 'manual' || s.k === 'error') && (
        <aside className="cx-drawer" role="dialog" aria-label="Connection analysis">
          <button className="cx-close" onClick={close} aria-label="Close">✕</button>
          {s.k === 'busy' && <p>{s.note}</p>}
          {s.k === 'error' && <p className="cx-note">Something went wrong: {s.detail}</p>}
          {s.k === 'manual' && <><h3>Enter the connection</h3><p className="cx-note cx-small">{s.note}</p><ManualForm initial={s.initial} onSubmit={(c) => analyse([c], null)} /></>}
          {s.k === 'result' && <>
            {s.itinerary && s.itinerary.warnings.length > 0 && <p className="cx-note cx-small">{s.itinerary.warnings.join(' ')}</p>}
            <Panel views={s.views} onEdit={(v) => set({ k: 'manual', initial: v.analysis.input, note: 'Correct or complete what was read from the page.' })}
              onTicketType={(v, selfTransfer) => { const cs = s.views.map((x) => (x === v ? { ...x.analysis.input, selfTransfer } : x.analysis.input)); void analyse(cs, s.itinerary); }} />
          </>}
        </aside>
      )}
    </div>
    </Boundary>
  );
}

function mount() {
  if (document.getElementById('cdgx-host')) return;
  const host = document.createElement('div');
  host.id = 'cdgx-host';
  const shadow = host.attachShadow({ mode: __TEST_BUILD__ ? 'open' : 'closed' });
  const style = document.createElement('style');
  // the map stylesheet targets :root/body in the maps viewer; inside the shadow root those are the host and the root div
  style.textContent = mapCss.replace(/:root/g, ':host').replace(/(^|\})\s*body\s*\{[^}]*\}/g, '$1') + '\n' + panelCss;
  const root = document.createElement('div');
  shadow.append(style, root);
  document.documentElement.append(host);
  createRoot(root).render(<App />);
  // Single-page sites re-render and may drop nodes they did not create (the page does not reload, so the content script
  // is not injected again). Re-attaching the same host keeps the React tree and its state (an open drawer survives).
  const reattach = () => { if (!host.isConnected) document.documentElement.append(host); };
  new MutationObserver(reattach).observe(document.documentElement, { childList: true });
  new MutationObserver(reattach).observe(document, { childList: true });   // the whole <html> element replaced
  setInterval(reattach, 1500);   // safety net for removals the observers above cannot see
}
mount();

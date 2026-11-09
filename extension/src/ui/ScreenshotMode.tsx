// Screenshot input mode: paste (Ctrl+V / Paste button) or choose an image, read it on this computer, confirm, analyse.
// The OCR code is loaded only here, on first use (dynamic import → separate chunk), and the OCR worker lives only while
// one image is read. The image is kept in memory only while the traveller compares it with the confirmation view; it
// is never stored, logged or sent anywhere.
import { useCallback, useEffect, useRef, useState } from 'react';
import { localToday } from '../core/time.ts';
import type { Itinerary } from '../core/types.ts';
import { extractDraft, toItinerary } from '../screenshot/extract.ts';
import type { Draft } from '../screenshot/types.ts';
import { ConfirmItinerary } from './ConfirmItinerary.tsx';

type S =
  | { k: 'empty'; note?: string }
  | { k: 'reading'; stage: string; p: number }
  | { k: 'confirm'; draft: Draft };

/** The image on the clipboard of a paste event, or why there is none. */
export function imageFromPaste(e: ClipboardEvent): { file: File | null; why: string } {
  const items = [...(e.clipboardData?.items ?? [])];
  const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (img) return { file: img.getAsFile(), why: '' };
  if (items.some((i) => i.kind === 'string')) return { file: null, why: 'The clipboard holds text, not an image. Take a screenshot first (Windows: Win+Shift+S), then press Ctrl+V here.' };
  if (items.some((i) => i.kind === 'file')) return { file: null, why: 'The clipboard holds a file that is not an image.' };
  return { file: null, why: 'There is no image on the clipboard. Take a screenshot first (Windows: Win+Shift+S), then press Ctrl+V here.' };
}

export function ScreenshotMode({ inTab, onAnalyse, busy, resume }: {
  inTab: boolean; busy?: boolean;
  /** Called with the confirmed itinerary. */
  onAnalyse: (it: Itinerary, draft: Draft) => void;
  /** A draft to go back to ("Edit details" on the result). */
  resume?: Draft | null;
}) {
  const [s, set] = useState<S>(resume ? { k: 'confirm', draft: resume } : { k: 'empty' });
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const dropPreview = useCallback(() => setPreview((u) => { if (u) URL.revokeObjectURL(u); return null; }), []);
  useEffect(() => () => dropPreview(), [dropPreview]);

  const read = useCallback(async (blob: Blob) => {
    if (busyRef.current) return;
    busyRef.current = true;
    dropPreview();
    set({ k: 'reading', stage: 'Opening the image', p: 0 });
    try {
      const { readImage } = await import('../screenshot/ocr.ts');   // lazy: OCR code only in this mode
      const r = await readImage(blob, { onProgress: (stage, p) => set({ k: 'reading', stage, p }) });
      const { draft } = extractDraft(r.words, localToday());
      if (!draft.journeys.length) set({ k: 'empty', note: 'No itinerary was recognised in this image. Snip just the itinerary (times and airport codes visible), at normal zoom, and paste again. Or switch to “Read the Skyscanner page” to enter it by hand.' });
      else { setPreview(URL.createObjectURL(blob)); set({ k: 'confirm', draft }); }
    } catch (e) {
      set({ k: 'empty', note: (e as { userFacing?: boolean }).userFacing ? (e as Error).message : `The screenshot could not be read: ${(e as Error).message}` });
    } finally { busyRef.current = false; }
  }, [dropPreview]);

  // Ctrl+V anywhere on the page (except while typing in a field of the confirmation view)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault();
      const { file, why } = imageFromPaste(e);
      if (file) void read(file); else set((x) => (x.k === 'reading' ? x : { k: 'empty', note: why }));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [read]);

  const pasteButton = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) { const type = it.types.find((t) => t.startsWith('image/')); if (type) return void read(await it.getType(type)); }
      set({ k: 'empty', note: 'There is no image on the clipboard. Take a screenshot first (Windows: Win+Shift+S), then paste.' });
    } catch { set({ k: 'empty', note: 'The browser did not let the button read the clipboard. Press Ctrl+V instead.' }); }
  };
  const openTab = () => { void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab&mode=screenshot') }); window.close(); };

  if (s.k === 'reading') return (
    <div className="cx-shot cx-shot-busy" role="status">
      <p><strong>Reading the screenshot on this computer…</strong></p>
      <p className="cx-small cx-muted">{s.stage}{s.p > 0 && s.p < 1 ? ` · ${Math.round(s.p * 100)} %` : ''}</p>
      <progress max={1} value={s.p || undefined} />
    </div>
  );
  if (s.k === 'confirm') return (
    <div className="cx-shot">
      <div className="cx-shot-bar">
        <strong>Read from your screenshot</strong>
        {preview && <button type="button" className="cx-link cx-small" onClick={() => setShowPreview((v) => !v)}>{showPreview ? 'hide screenshot' : 'show screenshot'}</button>}
        <button type="button" className="cx-link cx-small" onClick={() => { dropPreview(); set({ k: 'empty' }); }}>paste another</button>
      </div>
      {preview && showPreview && <img className="cx-shot-img" src={preview} alt="Your screenshot" />}
      <ConfirmItinerary draft={s.draft} busy={busy} onChange={(draft) => set({ k: 'confirm', draft })}
        onAnalyse={() => { dropPreview(); setShowPreview(false); onAnalyse(toItinerary(s.draft), s.draft); }} />
    </div>
  );
  return (
    <div className="cx-shot">
      <div className="cx-drop" tabIndex={0} onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) void read(f); else set({ k: 'empty', note: 'Drop an image file (PNG or JPEG).' }); }}>
        <p><strong>Press Ctrl+V</strong> to paste a screenshot of the itinerary</p>
        <p className="cx-small cx-muted">Windows: Win+Shift+S, drag over the flight card or itinerary details, then open this and press Ctrl+V.</p>
        <div className="cx-drop-btns">
          <button type="button" onClick={() => void pasteButton()}>Paste</button>
          {inTab ? <button type="button" onClick={() => fileRef.current?.click()}>Choose an image file…</button>
            : <button type="button" onClick={openTab} title="The popup closes when a file dialog takes the focus, so files are chosen in a tab">Choose a file (opens a tab)…</button>}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
        </div>
      </div>
      {s.note && <p className="cx-note cx-small" role="alert">{s.note}</p>}
      <p className="cx-small cx-muted">The image is read on this computer and is not stored or sent anywhere. You confirm every value before the analysis.{!inTab && <> · <button type="button" className="cx-link" onClick={openTab}>open in a tab</button> (stays open if you switch windows)</>}</p>
    </div>
  );
}

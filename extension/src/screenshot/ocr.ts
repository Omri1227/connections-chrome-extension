// Local OCR of a pasted screenshot (extension pages only: popup / tab). Tesseract (tesseract.js, WebAssembly) runs in a
// Web Worker; its worker script, WebAssembly core and English model are packaged with the extension under ocr/ (MV3
// forbids remotely hosted code, and nothing is downloaded). Nothing leaves this computer, nothing is cached or stored:
// the worker is created for one image and terminated right after, and the canvases are released.
import { createWorker, OEM } from 'tesseract.js';
import { MAX_FILE_BYTES, MAX_INPUT_PIXELS, ocrScale, toGray } from './preprocess.ts';
import type { OcrResult, OcrWord } from './types.ts';

export interface OcrAssets { workerPath: string; corePath: string; langPath: string }
/** The packaged OCR files (see extension/scripts/build.ts). */
export const packagedAssets = (): OcrAssets => ({
  workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
  corePath: chrome.runtime.getURL('ocr/tesseract-core-simd-lstm.js'),
  langPath: chrome.runtime.getURL('ocr'),
});

export class ImageError extends Error { readonly userFacing = true; }

export interface ReadOptions { assets?: OcrAssets; onProgress?: (stage: string, p: number) => void; psm?: string; /** test runs only: overrides the scale factor / contrast curve */ scale?: number; gamma?: number }

/** Reads the words of an image. Throws ImageError for files that are not usable images. */
export async function readImage(blob: Blob, opts: ReadOptions = {}): Promise<OcrResult> {
  const t0 = performance.now();
  if (blob.type && !blob.type.startsWith('image/')) throw new ImageError('That is not an image. Paste a screenshot (Win+Shift+S, then Ctrl+V) or choose a PNG or JPEG file.');
  if (blob.size > MAX_FILE_BYTES) throw new ImageError(`The image is too large (${Math.round(blob.size / 1048576)} MB). Take a screenshot of just the itinerary.`);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(blob); } catch { throw new ImageError('The image could not be opened. Paste a screenshot or choose a PNG or JPEG file.'); }
  const t1 = performance.now();
  let canvas: OffscreenCanvas | null = null;
  const { width: iw, height: ih } = bmp;
  try {
    if (iw * ih > MAX_INPUT_PIXELS) throw new ImageError('The image is too large. Take a screenshot of just the itinerary.');
    if (iw < 120 || ih < 40) throw new ImageError('The image is too small to read.');
    const s = opts.scale ?? ocrScale(iw, ih);
    const w = Math.round(iw * s), h = Math.round(ih * s);
    canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    toGray(img.data, opts.gamma);
    ctx.putImageData(img, 0, 0);
    const t2 = performance.now();
    opts.onProgress?.('Starting the text reader', 0);
    const a = opts.assets ?? packagedAssets();
    const worker = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: a.workerPath, corePath: a.corePath, langPath: a.langPath, workerBlobURL: false, cacheMethod: 'none', gzip: true,
      logger: (m: { status: string; progress: number }) => opts.onProgress?.(m.status === 'recognizing text' ? 'Reading the text' : 'Starting the text reader', m.progress),
    });
    const t3 = performance.now();
    try {
      if (opts.psm) await worker.setParameters({ tessedit_pageseg_mode: opts.psm as any });
      const r = await worker.recognize(canvas, {}, { blocks: true, text: false });
      const t4 = performance.now();
      const words: OcrWord[] = [];
      for (const b of r.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words)
        words.push({ text: wd.text, conf: wd.confidence, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
      return { words, width: w, height: h, scale: s, inputWidth: iw, inputHeight: ih, ms: { decode: t1 - t0, preprocess: t2 - t1, init: t3 - t2, recognize: t4 - t3, total: t4 - t0 } };
    } finally { await worker.terminate(); }
  } finally {
    try { bmp.close(); } catch { /* already closed */ }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

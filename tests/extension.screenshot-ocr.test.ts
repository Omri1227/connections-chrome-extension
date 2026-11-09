// SLOW (runs real OCR): the same OCR engine and English model as the extension (tesseract.js 7, LSTM, eng
// 4.0.0_best_int), in Node, on two synthetic fixture images rendered at 2× (Node has no canvas, so the extension's
// upscaling / grey preprocessing is skipped; 2× renderings need none). Off by default:
//   CDGX_OCR=1 npx vitest run tests/extension.screenshot-ocr.test.ts
// The full pipeline as packaged (worker, preprocessing, CSP) is measured in the browser by extension/scripts/screenshot-ocr.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { score, type Truth } from '../extension/src/screenshot/accuracy.ts';
import { extractDraft, problems } from '../extension/src/screenshot/extract.ts';
import type { OcrWord } from '../extension/src/screenshot/types.ts';

const ROOT = path.join(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'tests', 'fixtures', 'extension', 'screenshots');
const manifest = JSON.parse(fs.readFileSync(path.join(SHOTS, 'manifest.json'), 'utf8')) as { images: { file: string; truth: Truth }[] };

describe.skipIf(!process.env.CDGX_OCR)('real OCR on fixture images (slow)', () => {
  const T = createRequire(import.meta.url)('tesseract.js');
  const ocr = async (file: string): Promise<OcrWord[]> => {
    const worker = await T.createWorker('eng', 1, { langPath: path.join(ROOT, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'), cacheMethod: 'none' });
    try {
      const r = await worker.recognize(path.join(SHOTS, file), {}, { blocks: true, text: false });
      return r.data.blocks.flatMap((b: any) => b.paragraphs.flatMap((p: any) => p.lines.flatMap((l: any) => l.words.map((w: any) => ({ text: w.text, conf: w.confidence, ...w.bbox })))));
    } finally { await worker.terminate(); }
  };
  for (const file of ['details-one-stop@2x.png', 'card-one-stop-narrow@2x.png']) {
    it(`${file}: every visible field correct, none silently wrong`, async () => {
      const words = await ocr(file);
      const { draft } = extractDraft(words, '2026-11-02');
      const s = score(draft, manifest.images.find((i) => i.file === file)!.truth);
      expect(s.counts.silent).toBe(0);
      expect(s.counts.wrongChecked + s.counts.missing, s.details.join('\n')).toBe(0);
      if (file.startsWith('details')) expect(problems(draft)).toEqual([]);
    }, 120_000);
  }
});

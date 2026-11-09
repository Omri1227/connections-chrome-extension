// Image preparation for OCR (pure functions on pixel arrays; the canvas work is in ocr.ts).
// Measured on the synthetic fixtures (docs in extension/README.md): UI text at 100 % zoom is ~12–16 px high, too small
// for reliable recognition of grey 13 px airport codes ("TLV" read as "Tw"); scaling the image so the narrow side of a
// typical itinerary snip is ~2000–2600 px wide fixes that. Huge images are scaled down to bound memory and time.

/** Images larger than this (bytes) are refused before decoding. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Decoded images with more pixels than this are refused (a screenshot of several 8K monitors is not an itinerary). */
export const MAX_INPUT_PIXELS = 60e6;
/** The image handed to OCR stays within these bounds. */
export const MAX_OCR_SIDE = 5000;
export const MAX_OCR_PIXELS = 12e6;
/** Target width after upscaling small snips, and the largest upscale factor. */
export const TARGET_WIDTH = 2400;
export const MAX_UPSCALE = 3;
/** Contrast curve applied to the grey image (1 = none). */
export const GAMMA = 1;

/** Scale factor applied before OCR: up for small snips, down for huge screenshots. */
export function ocrScale(w: number, h: number): number {
  let s = Math.min(MAX_UPSCALE, Math.max(1, TARGET_WIDTH / w));
  s = Math.min(s, MAX_OCR_SIDE / w, MAX_OCR_SIDE / h, Math.sqrt(MAX_OCR_PIXELS / (w * h)));
  return Math.round(s * 100) / 100;
}

/** RGBA → grey, in place (alpha flattened onto white). Dark backgrounds (dark mode) are inverted to dark-on-light. */
export function toGray(px: Uint8ClampedArray, gamma = GAMMA): { inverted: boolean; mean: number } {
  let sum = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    const y = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * a + 255 * (1 - a);
    px[i] = px[i + 1] = px[i + 2] = y; px[i + 3] = 255;
    sum += y;
  }
  const mean = n ? sum / n : 255;
  const inverted = mean < 110;
  // dark-on-light, then a gamma curve that darkens grey text (secondary labels, airport codes) and keeps white white
  const lut = new Uint8ClampedArray(256).map((_, v) => 255 * Math.pow((inverted ? 255 - v : v) / 255, gamma));
  for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = lut[px[i]];
  return { inverted, mean };
}

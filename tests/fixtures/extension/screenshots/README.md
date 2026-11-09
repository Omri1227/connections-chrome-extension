# Screenshot fixtures (synthetic) and measurements of the screenshot mode

**All images here are SYNTHETIC renderings**: Skyscanner-like layouts written as HTML in
`extension/scripts/screenshot-fixtures.mjs` (modelled on the public look of result cards, itinerary details and a
booking summary, and on the text fixtures in `../*.txt`), rendered in headless Edge. They are not captures of the
live site, which is never fetched or automated. `manifest.json` holds the ground truth of every visible field.

| Kind | Images |
|---|---|
| Details (two-column timeline) | `details-one-stop` at device scale 1, 1.25, 1.5, 2 and a wide 1× · `details-return` 1×, 1.25× · `details-overnight-self` (3 flights, +1 day, self transfer) 1×, 2× · `details-to-tlv` 1.5× · `details-us-format` (12-hour) · `details-airport-change` |
| Booking summary (times in a row, codes under them) | `booking-one-stop` 1× · `booking-return` 2× |
| Result cards (no flight numbers / dates / connection times) | `card-one-stop` 1×, 1.5×, narrow 2× · `card-return` 1.25× · `card-two-stops-self` |
| Cropped / partial | right part cut · only the first flight · airline column cut · only the outbound |
| Degraded | browser zoom 80 % (details, return card) · JPEG quality 55 · dark mode |
| Not an itinerary | `noise@1x` |

`ocr/*.json`: the words found by the **packaged** OCR (extension test build in Edge: same worker, WebAssembly core,
English model, preprocessing) — recorded with `node extension/scripts/screenshot-ocr.mjs`. The unit tests
(`tests/extension.screenshot.test.ts`) run the parser on these recordings.

## Accuracy (2026-11-02, recorded OCR, default settings: page segmentation 3, upscale to ~2400 px wide, max ×3)

`npx tsx extension/scripts/screenshot-accuracy.ts` — per visible field (from, to, flight number, departure/arrival
time, departure/arrival date): *read* = correct and shown as read clearly; *check* = correct but flagged for the
traveller to confirm; *wrong✓* = wrong but flagged; **SILENT = wrong and shown as read (must be 0)**; *missing* = not
read (the traveller types it). "same" = the reading gives the same connections as the page-text parser on the
matching text fixture **without any correction** (after the confirmation step all of them do: unit tests).

| Image | fields | read | check | wrong✓ | SILENT | missing | legs | same |
|---|---|---|---|---|---|---|---|---|
| details-one-stop @1×, @1.25×, @1.5×, @2×, wide @1× | 5 × 14 | 5 × 14 | 0 | 0 | 0 | 0 | 2/2 | yes |
| details-return @1.25× | 28 | 27 | 1 | 0 | 0 | 0 | 4/4 | yes |
| details-return @1× | 28 | 24 | 3 | 0 | 0 | 1 (flight no. "LX" read as "1x") | 4/4 | no (until typed) |
| details-overnight-self @1×, @2× | 2 × 21 | 2 × 15 | 2 × 6 (dates without a year / next day) | 0 | 0 | 0 | 3/3 | yes |
| details-to-tlv @1.5× | 14 | 12 | 2 | 0 | 0 | 0 | 2/2 | yes |
| details-us-format @1× | 14 | 13 | 1 | 0 | 0 | 0 | 2/2 | yes |
| details-airport-change @1.25× | 14 | 14 | 0 | 0 | 0 | 0 | 2/2 | yes |
| booking-one-stop @1× | 14 | 14 | 0 | 0 | 0 | 0 | 2/2 | yes |
| booking-return @2× | 28 | 26 | 2 | 0 | 0 | 0 | 4/4 | yes |
| card-one-stop @1×, @1.5×, narrow @2× | 3 × 6 | 3 × 6 | 0 | 0 | 0 | 0 | 2/2 | yes |
| card-return @1.25× | 10 | 6 | 0 | 0 | 0 | 4 (return row: codes not found → row reported, left out) | 2/3 | yes |
| card-two-stops-self @1× | 8 | 7 | 1 | 0 | 0 | 0 | 3/3 | yes |
| crop: details right cut / first flight only / card airline column cut / outbound only | 14 / 7 / 10 / 14 | 14 / 7 / 8 / 14 | 0 / 0 / 2 / 0 | 0 | 0 | 0 | all | – |
| details-one-stop zoom 80 % | 14 | 14 | 0 | 0 | 0 | 0 | 2/2 | yes |
| card-return zoom 80 % | 10 | 5 | 1 | 0 | 0 | 4 (return row) | 2/3 | yes |
| details-return JPEG q55 | 28 | 26 | 2 | 0 | 0 | 0 | 4/4 | yes |
| details-to-tlv dark mode | 14 | 14 | 0 | 0 | 0 | 0 | 2/2 | yes |
| noise (not an itinerary) | – | – | – | – | – | – | 0 | "No itinerary was recognised" |
| **All 28 images** | **399** | **363 (91 %)** | **27** | **0** | **0** | **9** | | |

By field: from 63/67 read, to 64/67, flight number 43/49, departure time 54/59, arrival time 53/59, dates 43/49 each
(the rest flagged or missing; none silently wrong). Airport codes and times in the details layout are read reliably
at every scale tested; the weak spot is small grey airport codes in a **second result-card row** at ≤ 1.25× / 80 %
zoom, which the OCR engine sometimes drops entirely: that row is then reported as unreadable and left out, never
guessed.

Same parser, other OCR settings (all recorded the same way, used to choose the defaults; 0 silent errors in every
set after the structural checks): page segmentation 11 (sparse text) — 303/333 read, 1 wrong-but-flagged;
fixed ×2 upscaling on the 1× images — 184/209 read vs 188/209 at the default (×3), 2–3× faster; a contrast curve
(gamma 2) on the cards — worse (36/56 vs 44/56 read), so not used.

## Time, memory, size (this machine: Windows 11, shared with the live flight-data collector and other agents)

- **Time** per screenshot, worker start + recognition, default settings: median ~3.7 s, 90th percentile ~10 s,
  range 2–13 s on a moderately loaded machine (24 images); under heavy load (parallel builds/tests) 10–33 s.
  Worker start (loading the 2.9 MB WebAssembly core and the model) ~0.5–2 s of that. Upscaling ×2 instead of ×3 would
  halve the time (median 2.1 s) at a small accuracy cost (above).
- **Memory** (Edge, all processes of the test browser, private bytes): ~305 MB idle with the extension page open;
  peak 412–459 MB while reading (+105–150 MB); back to ~323 MB after (the worker is terminated after every image).
- **Size**: `ocr/` in the build is 5.9 MB (model 2.95 MB gz, WebAssembly 2.86 MB, worker 111 kB, core glue 89 kB);
  the OCR glue chunk loaded on first use is 20 kB; `popup.js` 306 → 337 kB; `content.js` unchanged (315,051 bytes).
- Chrome's Shape Detection `TextDetector` is not available in this Edge (`typeof TextDetector` = `undefined`), so it
  is not used.

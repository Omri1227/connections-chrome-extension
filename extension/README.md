# Connections Analyst: Chrome extension (pilot)

Analyses a flight connection read from a Skyscanner page or from a pasted screenshot of an itinerary. It shows the likely terminals and gate areas from earlier flights, a schematic airport map with the route between them, and an indicative transfer time. Airports: AMS, CDG, FCO, FRA, LHR, MAD, MUC, ZRH (LHR at terminal level only; IST was replaced on 2026-11-02 and is kept in the repo for history).

**Pilot:** not published in the Chrome Web Store. See the root [README](../README.md) for the overview, the limits and the licence.

## 1. Build

```powershell
npm run ext:build          # → extension\dist   (load this folder)
npm run ext:test           # extension unit tests (parser, analysis, risk, timing, remediation, pin, screenshot mode)
npm run ext:scenarios      # end-to-end scenario matrix, all 8 airports (diagnostic)
```

## 2. Load it in Chrome (or Edge)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder `extension\dist` of your checkout.
4. Pin "Connections Analyst (pilot)" from the puzzle-piece menu.
5. **Settings (history):**
   - click the extension icon → **Settings**;
   - server `http://127.0.0.1:8790`;
   - token = the `ADMIN_TOKEN` value in the main checkout's `.env`;
   - click **Save and allow access**, and accept Chrome's prompt for 127.0.0.1;
   - the message should read "Connected: the server answers and accepts the token".
   - Without this step everything works except the predictions, which then show as "Unknown".

After a rebuild, click the circular **reload** arrow on the extension's card in `chrome://extensions`.

## 3. Test it on Skyscanner (manual; the live site is never automated)

1. Search a trip with a connection at one of the 8 airports, e.g. Tel Aviv → Amsterdam.
2. **Results list:** click **Analyze connection** (bottom right), then click a result card.
   - Expected: the connection airport is found. "Missing from the page: … flight number …" appears, because cards do not show flight numbers.
   - **Edit details** lets you type them.
3. **Itinerary details:** open a result's details (where flight numbers are shown), click **Analyze connection**, then click inside the details.
   - Expected: flights, times and the scheduled connection read correctly.
   - Predictions appear for flights with ≥ 5 earlier flight-days (from about 4 Nov 2026).
   - The map and route appear; the verdict is labelled *Estimated*.
4. Also try:
   - a direct flight → "no change of plane", manual form;
   - a connection elsewhere (e.g. Athens) → "not one of the supported airports";
   - a "Self transfer" itinerary → self-transfer times (bags, check-in);
   - selecting the itinerary's text with the mouse first, then **Analyze connection** → the selection is used.
5. If something is read wrongly, capture a fixture (below) and report it.

**Capturing a fixture** (for parser fixes):
1. On the itinerary, open DevTools (F12) → Console.
2. Run `copy(document.querySelector('[aria-label*="tinerary"], article')?.innerText)`, or select the text and copy it.
3. Paste it into `tests/fixtures/extension/real-<description>.txt`.
4. Remove names, booking references and prices.

## 4. Automated browser check (Edge, local fixture page)

```powershell
npm run ext:build -- --test        # test build in extension\dist-test (runs on 127.0.0.1 pages too; never distribute)
npm run ext:e2e                     # puppeteer-core is a devDependency; .env: this checkout's, else the main checkout's (worktree); override with --env / --puppeteer
```

- **What it does:** it loads the real extension in headless Edge and opens a local page with the fixture itineraries. It clicks through each layout and the popup (21 checks), then the screenshot mode (14 checks: paste, file upload, confirmation, missing fields, mode switch, same verdict as the page reading; `--os-clipboard` adds a real Windows clipboard paste in a visible window). 35/35 (36 with `--os-clipboard`) on 2026-11-02. Screenshots go to `%TEMP%\cdgx-e2e`.
- **Chrome:** branded Chrome (137+) ignores `--load-extension`, so the automated run uses Edge. Chrome is checked by hand (§2–3).

## 5. Privacy and permissions

| Permission | Why |
|---|---|
| `storage` | the server address and token, on this computer only |
| content script on Skyscanner domains | the button. It reads the page only after you click it, and only the itinerary you click |
| optional `http://127.0.0.1/*`, `http://localhost/*` | the flight-data server, requested when you save the settings |

- Only the two flight numbers, the date(s) and the connecting airport are sent, to your flight-data server.
- Nothing is sent to Skyscanner or anyone else.
- Page text is not stored.
- Screenshot mode: no new permission. The extension pages' CSP adds `'wasm-unsafe-eval'` (needed to run the packaged
  WebAssembly OCR engine; no remote code). Images are read on this computer and never stored, logged or sent.

## 6. Screenshot mode ("Paste a screenshot")

A second way in, for any booking page or app: paste a screenshot of the itinerary. The extension reads it **on this
computer** (packaged OCR, nothing uploaded), shows what it read for you to confirm or correct, and then runs the same
analysis as the page reading.

**Steps (Windows):**
1. On the itinerary (Skyscanner result card, itinerary details or booking page), press **Win+Shift+S** and drag over
   the itinerary. The snip goes to the clipboard.
2. Click the extension icon. Choose **Paste a screenshot** (the choice is remembered).
3. Press **Ctrl+V** (or click **Paste**). Reading takes a few seconds.
4. Check the confirmation view against your screenshot (**show screenshot** displays it):
   - green = read clearly; **amber = Check**: click ✓ if it matches, or type the right value; dashed = missing;
   - fill in what the screenshot does not show: result cards have no flight numbers, dates or connection times —
     the connection times are required; without dates the connection is shown as *not assessed*, without flight
     numbers no terminal/gate history is looked up;
   - choose the ticket type per connection if the screenshot does not say "Self transfer";
   - **+ add a flight** if the snip cut a flight off.
5. **Analyze connection** is enabled once nothing is left to check. The result says *read from your screenshot and
   confirmed by you*; **Edit details** returns to the confirmation view.

Other ways in: drag an image onto the box; **Choose a file** (opens the mode in a tab, where the file dialog cannot
close the popup); **open in a tab** if you want the view to stay open while switching windows.

**Good screenshots:** normal zoom (100 %), the whole itinerary (times with their airport codes), not a whole-screen
capture with other content. Dark mode is handled.

**Developer notes:** code in `src/screenshot/` (pure: `layout.ts`, `normalize.ts`, `extract.ts`, `preprocess.ts`;
browser: `ocr.ts`) and `src/ui/ScreenshotMode.tsx`, `src/ui/ConfirmItinerary.tsx`. The OCR text is parsed by the
same `core/skyscanner.ts` parser as the page reading. Fixtures (synthetic renderings, never live Skyscanner):
`node extension/scripts/screenshot-fixtures.mjs`; record OCR on them with the packaged engine:
`npm run ext:build -- --test` then `node extension/scripts/screenshot-ocr.mjs`; accuracy report:
`npx tsx extension/scripts/screenshot-accuracy.ts`. Measurements: see `tests/fixtures/extension/screenshots/README.md`.

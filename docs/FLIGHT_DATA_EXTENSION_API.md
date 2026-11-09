# Flight-data lookup API for the Chrome extension (v1)

_Status 2026-10-31: implemented and served by the local flight-data server (`flightdata/src/lookup.ts`, `api.ts`); tests in `tests/flightdata.lookup.test.ts`. **Not public:** the server listens on 127.0.0.1 only and every call needs the admin token. Separate from the passenger app; nothing here feeds passenger routing._

## Question it answers

> Given two connecting flight numbers and a date, what are their likely arrival and departure terminals or gate areas, based on the historical observations we hold?

## Endpoints

All `GET`, header `Authorization: Bearer <ADMIN_TOKEN>`, JSON, `Cache-Control: no-store`. Flight numbers are IATA style, spaces ignored (`AF 1234` = `AF1234`). A codeshare number finds the operating flight.

| Endpoint | Parameters |
|---|---|
| `/fd-api/v1/connection` | `arr` (arriving flight), `dep` (departing flight), `date` (local date of the arrival, `YYYY-MM-DD`), optional `depDate` (local date of the departure; default `date`; give the next day for an overnight connection), optional `airport` (IATA; default: inferred) |
| `/fd-api/v1/flight` | `airport`, `flight`, `date`, `direction` (`arrival` or `departure`) |

**Airport inference:** without `airport`, the connecting airport is the single collected airport where `arr` has been seen arriving and `dep` departing. Several candidates give `ambiguous-airport` with `airportCandidates`; none gives `no-data`.

## Response: one flight (`FlightAnswer`)

```jsonc
{
  "flight": "AF1234", "airport": "CDG", "direction": "arrival", "date": "2026-12-01",
  "status": "ok",                       // ok | insufficient-data | no-data | airport-not-covered
  "terminal": FieldAnswer, "gateArea": FieldAnswer, "gate": FieldAnswer,
  "sameDay": null,                      // or what the source published for the requested date itself (may still change)
  "basis": {
    "flightDays": 37, "fromCounters": 30, "cancelled": 1,
    "period": { "from": "2026-11-01", "to": "2026-11-30" },
    "sources": ["aerodatabox"], "lastRefresh": "2026-12-01T06:12:00Z"
  },
  "notes": ["Values are the last terminal and gate the source published …", "…"]
}
```

**`FieldAnswer`**, for `terminal`, `gateArea` and `gate`:

| Key | Meaning |
|---|---|
| `status` | `predicted`; `insufficient-data` (fewer than 5 flight-days with a value); `not-published` (the source publishes this field for under 20 % of the airport's flight-days in this direction, judged from at least 50); `no-data` |
| `value` | the leading value, only when `predicted` |
| `distribution` | `[{ value, n, share }]` over flight-days with a value. **`share` is `null` below 5 flight-days**, so no percentage is shown from a tiny sample |
| `sample` | flight-days with this field known |
| `confidence` | `high` (≥ 10 flight-days and Wilson lower bound ≥ 0.8), `medium` (lower bound ≥ 0.5), `low`. A ranking, not a calibrated probability: 10 out of 10 is only `medium` |
| `confidenceScore`, `interval` | Wilson 95 % lower bound, and the interval, of the leading value's share |
| `alternatives` | other values with share ≥ 10 % |

**Connection response:** `{ query, status, airport, airportCandidates, arrival: FlightAnswer, departure: FlightAnswer, sameTerminalHistorically, notes }`.
- `status` is `ok` only when both flights are `ok`.
- `sameTerminalHistorically` is `true` or `false` only when both terminals are `predicted`. No joint probability is claimed; the two flights are looked up independently.

## Rules

1. **Only earlier flight-days.** A flight-day counts only if it is strictly before the requested date and within 120 days. The requested date itself appears only in `sameDay`.
2. **One flight-day, one vote.** A day votes with its last reported value. Cancelled days are excluded and counted in `basis.cancelled`.
3. **Monthly counters count too.**
   - AeroDataBox raw rows are deleted after 4 days (licence); the monthly counters keep the votes, without dates.
   - For a past date, only months before the date's month are used (no leakage into a backtest).
   - For a live query (date not before the day before yesterday), the current month is used too.
4. **Gate area** is the letter group the gate starts with:
   - examples: `K45` → `K`, `A1A` → `A`, `C44,C43` → `C`;
   - purely numeric gates have no area;
   - it names the pier, concourse or hall at the 8 airports; no further physical meaning is claimed.
5. **Nothing is invented.** A field the source does not publish is `not-published`, never guessed from other airports.

## What to expect today (coverage on completed days, 2026-10-30)

| Airport | Arrivals: terminal / gate | Departures: terminal / gate | Lookup can give |
|---|---|---|---|
| CDG | 97 % / 0 % | 96 % / 0 % | terminal only. AeroDataBox's CDG live feed is "Down" (checked 2026-10-31) |
| FRA | 96 % / 96 % | 96 % / 96 % | terminal, gate area, gate |
| FCO | 95 % / 0 % | 95 % / 0 % | terminal only. No gates in the source; its live feed is OK |
| AMS | 95 % / 92 % | 97 % / 95 % | terminal, gate area, gate |
| MUC | 94 % / 0 % | 93 % / 0 % | terminal only. No gates in the source; its live feed is OK |
| MAD | 95 % / 0 % | 97 % / 96 % | terminal; gate area for departures |
| IST | 0 % / 0 % | 0 % / 100 % | gate area for departures (single terminal) |
| ZRH | 96 % / 0 % | 0 % / 95 % | arrival terminal; departure gate area (A, B, D, E) |

The first `predicted` answers need 5 earlier flight-days of the same flight number: from 4 November 2026 for daily flights (collected since 30 October).

## For the extension later (not built)

- **Hosting.** The extension cannot reach 127.0.0.1 on another computer. Before public use it needs a hosted read-only endpoint with its own key (not the admin token) and rate limits. That requires an owner decision and, for AeroDataBox-derived values, a licence answer: `AERODATABOX_LICENSING_EMAIL_DRAFT.md`, Q1 and Q3.
- **Display rules.** Show `value` with the sample and period (for example "Usually 2E · 34 of 37 days, Nov 2026"). Show `alternatives` as alternatives. Show `insufficient-data` and `not-published` as "no reliable history", never as a guess.

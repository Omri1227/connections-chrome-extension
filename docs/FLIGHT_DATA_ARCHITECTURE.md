# Flight-data platform: architecture

_2026-10-30. Code: `flightdata/`. (Source research and operations notes are kept in the private research repository.)_

## 1. Position in the repository

The platform is **operationally independent** of the passenger app:
- its own code (`flightdata/`), server (port 8790), database and dashboard (port 5174 in development);
- no import from `src/plan`, `server/` or the route database, and nothing in the passenger app imports it;
- the passenger build (`npm run build`) does not include it.

The only planned link is the prediction boundary (§8). It is read-only and **not** connected to routing.

```
flightdata/
  migrations/           001_init.sql, 002_retention.sql (PostgreSQL)
  src/
    types.ts            NormalizedFlight, SourceAdapter, Window… (the adapter contract)
    time.ts             zone/DST helpers (Intl), local-day windows
    normalize.ts        flight numbers, statuses, terminals, validation, de-duplication, identity
    http.ts             polite GET: spacing, timeout, bounded retries, backoff, Retry-After
    db.ts               one Db interface: PGlite (local/tests) or pg (PostgreSQL server); migrations
    store.ts            flights, append-only observations, sightings, codes, runs, findings
    collector.ts        one run = airport × source × direction × local date
    quality.ts          completeness verdict against the source's own history
    scheduler.ts        tick: due slots in local time, idempotent, catch-up
    retention.ts        licence-driven roll-up into monthly counters, then purge
    analysis.ts         lists, histories, distributions, completeness, predict()
    api.ts / server.ts  research API (+ built dashboard), optional in-process scheduler
    cli.ts              status | collect | tick | loop | sweep | export | import
    adapters/           adr-fco.ts, aerodatabox.ts, swedavia.ts, fixture.ts, index.ts (registry)
  dashboard/            React research dashboard (own Vite config)
  scripts/poc.ts        proof-of-concept collection + coverage metrics
  deploy/               Railway / GitHub Actions templates (not activated)
```

## 2. Database

**One dialect: PostgreSQL.**
- **Locally and in tests:** PGlite (PostgreSQL 18 compiled to WASM, in-process, persistent directory). It allows one process per data directory, so `lock.ts` holds a lock file.
- **Production:** a managed PostgreSQL through `pg` (`FD_DATABASE_URL`).
- **Moving data:** the same SQL and migrations run on both, so data moves without conversion (`fd export` / `fd import`, JSON lines).
- **Local location:** the local data directory is outside the OneDrive-synced repository (`%LOCALAPPDATA%\cdg-navigator\flightdata\`). OneDrive's sync left a Postgres directory unopenable ("could not create lock file postmaster.pid: Permission denied", 2026-10-30).

| Table | Content | Key points |
|---|---|---|
| `fd_airports` | IATA/ICAO, name, time zone, expected terminals, gate pattern, schedule, enabled | metadata from `airports.ts`, synced at start |
| `fd_airlines` | carrier code, name | filled from observations |
| `fd_sources` | id, kind, URLs, terms summary, **permission**, retention text, **raw_retention_days**, capabilities (which fields the source provides) | synced from adapters; capabilities make "missing" distinguishable from "not provided" |
| `fd_collection_runs` | airport, source, direction, target local date, slot, trigger, status, windows expected/ok, pages, bytes, row counts, flights, terminal/gate counts, completeness verdict, warnings, error, diagnostics (per-window results, local-hour histogram) | **unique partial index on `run_key` where status ≠ failed**: a slot runs once; a failed slot can be retried |
| `fd_flights` | one **physical movement**: airport, direction, `flight_key`, `leg`, local date, carrier, identity (`operating`/`listed`), origin, destination, scheduled UTC | unique (airport, direction, flight_key, local_date, leg) |
| `fd_flight_codes` | every number seen for a movement, with role (operating / marketing / listed) and source | codeshares counted once, searchable by any number |
| `fd_observations` | each **distinct state** of a flight from a source: stage, status (+ raw), terminal, gate, stand, belt, scheduled/estimated/actual, aircraft, listed number, role, first/last seen, seen count, content hash | **append-only**; identical states only extend `last_seen_at` |
| `fd_sightings` | (run, flight) → observation | run coverage survives de-duplication |
| `fd_quality_findings` | run, airport, source, kind, severity, detail | one finding per pattern with examples, not one per row |
| `fd_raw_samples` | small response excerpts per window | purged after `FD_RAW_RETENTION_DAYS` (and within a licence limit) |
| `fd_derived_counts` | monthly counters per flight number: flight-days, terminal values, gate values, cancellations | the long-term form of time-limited sources; no dates or per-day values |
| views `fd_assignment_history`, `fd_latest` | each observation with the previous terminal/gate of the same flight and source; latest state | change analysis |

### Historical preservation (the example from the brief)

| Run (local) | Stored |
|---|---|
| 08:00 XX123 2E/K31 | observation #1 (K31, pre-movement) |
| 15:00 XX123 2E/K42 | observation #2 (K42); history marks `gate_changed`, `prev_gate = K31` |
| 23:30 XX123 departed, 2E/K42 | observation #3 (K42, **post-movement** = last reported) |
| another 23:30 identical snapshot | #3 `seen_count` + 1, `last_seen_at` moves, new sighting row |

This is tested in `tests/flightdata.core.test.ts`.

### Assignment provenance

`stage` is one of:
- `pre-movement`: scheduled or updated assignment;
- `post-movement`: the last assignment reported after the actual time or a departed/landed status;
- `cancelled` or `unknown`.

**Nothing is ever labelled "independently confirmed actual":**
- no source we can use observes the stand or gate the aircraft really used;
- confirmation would need two independent sources agreeing after the movement, and that is a future derived check, not a stored claim;
- the API notes and the dashboard say "last reported".

### Identity and codeshares

`flight_key` is the operating flight number when the source states it:
- the FCO "Operated by" row;
- AeroDataBox `IsOperator`, with codeshare rows linked only when exactly one operator row has the same scheduled instant and the same other airport;
- Swedavia `FlightId` + `CodeShareData`.

Otherwise the listed number is kept with `identity = 'listed'`, so an unresolved codeshare is **never merged on a guess**. Two movements with one number on one date are separate `leg`s when their schedules are more than 4 hours apart.

## 3. Source adapters

Contract (`types.ts`):
- `info`: id, kind, terms summary, permission, retention, `rawRetentionDays`, capabilities;
- `notReady(env)`: e.g. a missing key;
- `windows(airport, direction, localDate)`: the requests that cover one local day;
- `fetchWindow(...)`: fetch and parse one window. It **never throws** for HTTP or parse errors; it returns `ok`, `httpStatus`, `rawCount`, `records`, `issues` and `error`.

Implemented:

| Adapter | Windows per local day | Notes |
|---|---|---|
| `adr-fco-web` | 1 (full day), paged by 200 rows until the board's "of N entries" | HTML parsing by class names; bot-protection pages stop the run (not circumvented); optional capped gate detail pages |
| `aerodatabox` | 2 × 12 h (3 on a 25-hour day), local-time windows | one call answers both directions (10-minute cache), so each window costs one call; key only in headers |
| `swedavia` | 2 (the API is keyed by UTC date; the local day spans two) | case-insensitive field access (documented PascalCase, likely camelCase JSON) |
| `fixture` | configurable | scripted answers for tests |

Not implemented, on purpose: every source rejected for permission reasons.

## 4. Collection run (collector.ts)

1. `startRun`: insert with the slot's `run_key`. If a non-failed run already exists, the run is **skipped**; this is how overlap and double collection are prevented.
2. Fetch every window through `http.ts`:
   - per-host spacing;
   - 30–60 s timeout;
   - ≤ 3 retries for 408/425/429/5xx and network errors, exponential backoff with jitter, `Retry-After` honoured;
   - other 4xx responses are final.
3. Validate every record:
   - wrong airport or direction, no schedule → reject;
   - unknown terminal, odd gate, unmapped status → keep and report.
4. Keep only flights scheduled on the target local date, then de-duplicate.
5. **Store everything in one transaction.** On error nothing is written and the run is `failed`. If every window failed, nothing is stored: no "zero-flight day" exists.
6. Judge completeness (§5), write findings (grouped) and the run row: counts, verdict, per-window diagnostics, local-hour histogram.

## 5. Completeness and anomalies (quality.ts)

Every run gets one of four statuses:

| Status | Meaning |
|---|---|
| `failed` | No window answered. |
| `partial` | Some windows failed. |
| `suspect` | All windows answered, but something is off: an empty window that history says is normally busy, a high validation-reject share (> 5 %, a possible format change), a count far below the source's own median, or empty local hours that are normally busy. |
| `success` | None of the above. |

**Baseline.** The baseline is the same airport, source, direction, slot time and day offset over the last 35 days (≥ 5 runs). The test uses the median and the MAD:
- "far below" means below median − 3 × max(1.4826·MAD, 10 % of the median);
- per-hour medians come from each run's stored histogram, so they survive licence purges.

**Low counts.** A low count is labelled with its evidence:
- "operational disruption more likely" when cancellations are > 15 % and all windows answered;
- "collection failure more likely" when windows failed or came back empty;
- otherwise "undetermined".

With fewer than 5 earlier runs the count is explicitly **not judged** (`baselineNote`). There are no universal hard thresholds.

## 6. Scheduling (scheduler.ts)

The default slots are 07:00 (today and yesterday), 15:00 (today) and 23:30 (today), local time at each airport.

- **Tick model.** A tick, every 15 min by default, collects every slot whose local time has passed within the grace period (6 h).
- **Time zones.** Slots are resolved in the airport's zone, so DST is handled (tested for both Paris transitions).
- **Restarts.** A restart or a late tick catches up. Overlapping ticks cannot double-collect, because of the unique `run_key` index (across processes too, on PostgreSQL).
- **Crashed runs.** Runs left `running` by a crashed process are marked failed after 60 min, and their slot is retried.
- **Yesterday.** Yesterday is requested only from sources that serve past days (`capabilities.pastDays`).

**Is three times a day enough?** It depends on what the source serves:

| Source | Coverage with 3 snapshots | Why |
|---|---|---|
| Full-day sources with yesterday (FCO, AeroDataBox, Swedavia) | **Complete for the schedule.** | Every flight of the day is listed in every snapshot. |
| Same sources, assignments | The gate seen is the one published at the snapshot. | Gates published late (often < 1 h before departure) are captured only when a snapshot falls after publication: the 23:30 run for evening flights, and the next-morning "yesterday" run for the final state. |

An intra-day gate *change* between snapshots can be missed, and that is accepted: it only affects change statistics, never the last reported value of the day. Month one measures this (docs/FLIGHT_DATA_MONTH_ONE_PLAN.md, days 8–14). If changes matter, the low-cost alternative is a fourth slot around the evening departure bank (≈ 19:00) for CDG only; with AeroDataBox that adds 2 units a day.

## 7. Licence-driven retention (retention.ts)

For sources with `raw_retention_days` (AeroDataBox: 7):
1. Every tick rolls each flight-day whose first observation is older than limit − 1 day into `fd_derived_counts`. The counters are: month, flight number, carrier, other airport, `flight-days`, terminal value counts, gate value counts and cancellations. They hold no dates and no per-day values.
2. The raw observations, codes and (if nothing else remains) the flight row are then deleted.

The sweep is idempotent and tested. Sources without a limit (FCO, Swedavia) are never purged. Raw response samples are purged after `FD_RAW_RETENTION_DAYS` (14), or sooner under a licence limit.

## 8. API and the CDG Navigator boundary

`/fd-api/*` needs the admin token, except `health`; `api.ts` lists the endpoints. It is read-only.

The prediction boundary is `GET /fd-api/predict?airport=CDG&flight=AF1234&date=YYYY-MM-DD&direction=departure`. It returns:
- the most likely terminal, other observed terminals and the gate distribution;
- the sample (flight-days), the observation date range and the last refresh;
- the basis: `current-flight-status` (an observation exists for that date), `historical-pattern`, or `none`;
- notes, including "last reported, not confirmed".

The rules (`PREDICTION_RULES` in `analysis.ts`):
- history uses flight-days strictly **before** the date, with a 120-day lookback;
- below 5 flight-days there is **no prediction**;
- `high` needs n ≥ 10 and a Wilson lower bound ≥ 0.8; `medium` needs ≥ 0.5;
- the score is uncalibrated and labelled as such.

Codeshare numbers resolve to the operating flight, also after a purge: counters keep a `code` field. `predict()` adds `fd_derived_counts` of months strictly before the requested date's month, so a backtest never sees later days of the same month, and a note says how many flight-days came from counters. The passenger app does not call this endpoint; wiring it in is a later, owner-approved step, and unvalidated predictions are never fed into routing.

## 9. Dashboard

`flightdata/dashboard/` is a separate Vite app (`npm run fd:dashboard`, or built by `npm run fd:build` and served by the fd server). It has six pages:
- **Overview:** health per airport, last success, next slot, runs per status, and sources with permission, retention and fields.
- **Collection runs:** status, windows, counts, terminal/gate shares, warnings, and per-window diagnostics and findings.
- **Flights:** filters, last reported terminal and gate, change markers, and the full observation timeline with provenance.
- **Statistics:** terminal or gate distribution by airline, route or flight, with sample sizes and "small sample" flags; completeness by day (terminal, gate, both, neither, changes, operator unknown).
- **Quality:** findings.
- **Prediction check:** the boundary above.

Observations and derived predictions are on separate pages.

## 10. Security and privacy

- Secrets are read only from the environment: keys, `FD_DATABASE_URL` and the admin token. They are never logged; database URLs are logged with credentials masked.
- Keys go in request headers, never in URLs (tested).
- Flight boards contain no personal data. Raw samples are small and short-lived.
- The API is token-protected, read-only and input-validated (whitelisted `groupBy`, code and date formats), and parameterised throughout.

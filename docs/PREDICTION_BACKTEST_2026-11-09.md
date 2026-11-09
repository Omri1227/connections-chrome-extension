# Prediction back-test, first run (2026-11-09)

_Roadmap P1-4 / Gate A4; checklist item S3._

**Method:** `docs/research/tools/prediction-backtest.mts`, run read-only against the live server.
- For each airport and direction, 60 flights were sampled from the held-out day.
- Each flight was predicted from the history **before** that day only, with the same lookup and resolver as the extension and the same-day value removed.
- The prediction was scored against what the feed reported that day.

**What is committed:** only these summary counts. The per-flight rows come from licensed feed data and stay outside the repository.

## Held-out day 2026-11-06: no result

All 840 sampled flights came back `insufficient-data` (fewer than 5 earlier flight-days). This is a limit of the method, not a prediction error:
- raw rows are kept for 4 days (licence);
- to avoid leakage, a past date may use only the counters of earlier months;
- collection started at the end of October.

## Held-out day 2026-11-08

| Airport | Direction | Predicted | Terminal correct | Top gate area correct | Actual area among listed areas (≥ 5 %) |
|---|---|---|---|---|---|
| AMS | arrival | 51/60 | 42/51 (82 %) | 29/41 (71 %) | 40/41 |
| AMS | departure | 55/60 | 55/55 (100 %) | 43/53 (81 %) | 52/53 |
| CDG | arrival | 52/60 | 39/52 (75 %) | – (no gates in the feed) | – |
| CDG | departure | 54/60 | 49/54 (91 %) | – | – |
| FCO | arrival | 53/60 | 53/53 (100 %) | – (no gates) | – |
| FCO | departure | 49/60 | 49/49 (100 %) | – | – |
| FRA | arrival | 50/60 | 50/50 (100 %) | 31/42 (74 %) | 40/42 |
| FRA | departure | 52/60 | 52/52 (100 %) | 37/40 (93 %) | 38/40 |
| MAD | arrival | 50/60 | 50/50 (100 %) | – (no arrival gates) | – |
| MAD | departure | 54/60 | 54/54 (100 %) | 43/45 (96 %) | 45/45 |
| MUC | arrival | 50/60 | 44/50 (88 %) | – (no gates) | – |
| MUC | departure | 50/60 | 50/50 (100 %) | – | – |
| ZRH | arrival | 48/60 | 40/48 (83 %) | – (no arrival gates) | – |
| ZRH | departure | 49/60 | – (feed publishes no terminal) | 42/49 (86 %) | 49/49 |

LHR is not included: its history starts on 2026-11-09.

## Reading against Gate A4

**Thresholds:** top area ≥ 60 % correct, and feed coverage ≥ 50 %.
- **Every scored airport/direction passes the 60 % top-area bar.** The lowest is AMS arrivals at 71 %.
- **The actual area is almost always among the listed areas** (264 of 270). The panel's "possible areas" list is therefore well calibrated.

**Not yet sufficient for Gate A4:**
- one held-out day and 60 flights per cell;
- about 8 days of history;
- the 95 % intervals are wide (for example 29/41 → about 55–83 %).

**Next:** repeat weekly, holding out several days, once the counters hold a full month (from early December). Watch CDG arrivals (terminal 75 %) and AMS arrivals.

-- A flight-day the source listed as its own operating flight although it is the same physical movement as another
-- flight-day (AMS 2026-11-01: KL807, CI9388 and AF8414 → TPE, all three rows flagged "operator"). Such flight-days are
-- marked, never deleted: their observations stay and they are still found by their own number, but physical counts and
-- pooled statistics skip them. The mark is recomputed on every collection of the date (store.ts markDuplicates), so it
-- disappears as soon as its evidence does.
--   verified-codeshare  an operating/marketing relationship checked by hand against an independent source
--                       (src/verified-codeshares.ts, evidence recorded there);
--   same-aircraft       same scheduled instant, same other airport and the same aircraft registration (one airframe
--                       cannot make two departures at one instant).
ALTER TABLE fd_flights ADD COLUMN duplicate_of bigint REFERENCES fd_flights(id) ON DELETE SET NULL;
ALTER TABLE fd_flights ADD COLUMN duplicate_reason text CHECK (duplicate_reason IN ('verified-codeshare', 'same-aircraft'));
CREATE INDEX fd_flights_duplicate ON fd_flights (duplicate_of) WHERE duplicate_of IS NOT NULL;

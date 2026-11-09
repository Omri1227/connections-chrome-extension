-- Per-source retention. Some licences cap how long raw records may be kept (AeroDataBox: 7 days unless the plan has
-- extended caching; FlightAware Standard: 30 days) but allow derived statistics without limit. Before raw rows of such a
-- source expire, each flight-day is rolled into monthly counters (no dates, no per-day values), then deleted.
ALTER TABLE fd_sources ADD COLUMN raw_retention_days int;           -- NULL = no licence limit
ALTER TABLE fd_flights ADD COLUMN rolled_up boolean NOT NULL DEFAULT false;

CREATE TABLE fd_derived_counts (
  source_id   text NOT NULL REFERENCES fd_sources(id),
  airport     text NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('arrival','departure')),
  flight_key  text NOT NULL,                 -- operating (or listed) number
  carrier     text,
  other       text NOT NULL DEFAULT '',      -- origin for arrivals, destination for departures ('' = unknown)
  month       date NOT NULL,                 -- first day of the local month
  field       text NOT NULL CHECK (field IN ('terminal','gate','flight-days','cancelled')),
  value       text NOT NULL,                 -- the terminal/gate value, '' = not reported; 'all' for flight-days/cancelled
  n           int NOT NULL,
  PRIMARY KEY (source_id, airport, direction, flight_key, other, month, field, value)
);
CREATE INDEX fd_derived_lookup ON fd_derived_counts (flight_key, direction, airport, month);
CREATE INDEX fd_derived_carrier ON fd_derived_counts (airport, direction, carrier, month);

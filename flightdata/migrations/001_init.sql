-- Flight-data platform schema (PostgreSQL; PGlite locally, a managed PostgreSQL in production).
-- Principles: observations are append-only (a changed gate is a new row, never an update of the old one); identical
-- repeated snapshots only extend last_seen_at and add a sighting row; unknown values are NULL, and whether a source
-- supports a field at all is recorded on the source (capabilities), so NULL can be read as "missing" or "not provided".

CREATE TABLE fd_airports (
  iata        text PRIMARY KEY,
  icao        text NOT NULL UNIQUE,
  name        text NOT NULL,
  tz          text NOT NULL,
  country     text NOT NULL,
  terminals   jsonb NOT NULL DEFAULT '[]',
  gate_pattern text,
  schedule    jsonb NOT NULL DEFAULT '[]',   -- local collection times, e.g. ["07:00","15:00","23:30"]
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fd_airlines (
  code        text PRIMARY KEY,               -- IATA code as listed in flight numbers (or ICAO when no IATA)
  icao        text,
  name        text,
  first_seen  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fd_sources (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('official-api','aggregator-api','website-json','fixture')),
  base_url      text NOT NULL,
  airports      jsonb NOT NULL DEFAULT '[]',
  terms_url     text,
  terms_summary text NOT NULL,
  permission    text NOT NULL CHECK (permission IN ('approved','pending-owner-approval','test-only','rejected')),
  retention     text NOT NULL,
  cost_note     text NOT NULL,
  capabilities  jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One collection run = one airport × source × direction × target local date, started by one schedule slot.
CREATE TABLE fd_collection_runs (
  id               bigserial PRIMARY KEY,
  run_key          text NOT NULL,             -- airport|source|direction|target_date|slot — idempotency key
  airport          text NOT NULL REFERENCES fd_airports(iata),
  source_id        text NOT NULL REFERENCES fd_sources(id),
  direction        text NOT NULL CHECK (direction IN ('arrival','departure')),
  target_date      date NOT NULL,             -- local date at the airport
  slot             text NOT NULL,             -- e.g. "2026-10-30 07:00" local, or "manual:<iso>"
  trigger          text NOT NULL CHECK (trigger IN ('schedule','manual','backfill','test')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL CHECK (status IN ('running','success','partial','suspect','failed','skipped')),
  windows_expected int NOT NULL DEFAULT 0,
  windows_ok       int NOT NULL DEFAULT 0,
  pages_fetched    int NOT NULL DEFAULT 0,
  bytes_fetched    bigint NOT NULL DEFAULT 0,
  rows_raw         int NOT NULL DEFAULT 0,
  rows_normalised  int NOT NULL DEFAULT 0,
  rows_rejected    int NOT NULL DEFAULT 0,
  flights_seen     int NOT NULL DEFAULT 0,
  flights_new      int NOT NULL DEFAULT 0,
  observations_new int NOT NULL DEFAULT 0,
  observations_unchanged int NOT NULL DEFAULT 0,
  with_terminal    int NOT NULL DEFAULT 0,
  with_gate        int NOT NULL DEFAULT 0,
  completeness     jsonb NOT NULL DEFAULT '{}', -- verdict + reasons from quality checks
  error            text,
  warnings         jsonb NOT NULL DEFAULT '[]',
  diagnostics      jsonb NOT NULL DEFAULT '{}'
);
-- A slot may only have one non-failed run; a failed run can be retried with the same key.
CREATE UNIQUE INDEX fd_runs_key_once ON fd_collection_runs (run_key) WHERE status NOT IN ('failed');
CREATE INDEX fd_runs_airport_time ON fd_collection_runs (airport, started_at DESC);
CREATE INDEX fd_runs_target ON fd_collection_runs (airport, direction, target_date);

-- A physical movement at an airport. flight_key is the operating flight number when known, otherwise the listed number
-- (identity = 'listed'), so an unresolved codeshare is never merged into another flight.
CREATE TABLE fd_flights (
  id              bigserial PRIMARY KEY,
  airport         text NOT NULL REFERENCES fd_airports(iata),
  direction       text NOT NULL CHECK (direction IN ('arrival','departure')),
  flight_key      text NOT NULL,
  leg             smallint NOT NULL DEFAULT 1,  -- >1 when the same number has two movements on one local date
  local_date      date NOT NULL,                -- scheduled local date at this airport
  carrier         text,
  identity        text NOT NULL CHECK (identity IN ('operating','listed')),
  origin          text,
  destination     text,
  scheduled_utc   timestamptz NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  UNIQUE (airport, direction, flight_key, local_date, leg)
);
CREATE INDEX fd_flights_lookup ON fd_flights (flight_key, direction, airport, local_date);
CREATE INDEX fd_flights_day ON fd_flights (airport, direction, local_date);
CREATE INDEX fd_flights_carrier ON fd_flights (carrier, airport, direction);

-- Marketing numbers seen for a flight, per source.
CREATE TABLE fd_flight_codes (
  flight_id   bigint NOT NULL REFERENCES fd_flights(id) ON DELETE CASCADE,
  code        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('operating','marketing','listed')),
  source_id   text NOT NULL REFERENCES fd_sources(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flight_id, code, source_id)
);
CREATE INDEX fd_codes_code ON fd_flight_codes (code);

-- Every distinct state of a flight reported by a source. content_hash covers the meaningful fields; an identical state
-- seen again only moves last_seen_at / seen_count (and gets a sighting row), so changes are never overwritten.
CREATE TABLE fd_observations (
  id              bigserial PRIMARY KEY,
  flight_id       bigint NOT NULL REFERENCES fd_flights(id) ON DELETE CASCADE,
  source_id       text NOT NULL REFERENCES fd_sources(id),
  first_run_id    bigint NOT NULL REFERENCES fd_collection_runs(id),
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  seen_count      int NOT NULL DEFAULT 1,
  content_hash    text NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('pre-movement','post-movement','cancelled','unknown')),
  status          text NOT NULL,
  status_raw      text,
  terminal        text,
  gate            text,
  stand           text,
  baggage_belt    text,
  scheduled_utc   timestamptz NOT NULL,
  estimated_utc   timestamptz,
  actual_utc      timestamptz,
  aircraft_type   text,
  listed_as       text NOT NULL,               -- the flight number of the row this came from
  role            text NOT NULL CHECK (role IN ('operating','marketing','unknown')),
  source_record_id text,
  extra           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX fd_obs_flight ON fd_observations (flight_id, first_seen_at);
CREATE INDEX fd_obs_source_hash ON fd_observations (flight_id, source_id, content_hash);

-- Which run saw which flight in which state: run coverage survives deduplication.
CREATE TABLE fd_sightings (
  run_id          bigint NOT NULL REFERENCES fd_collection_runs(id) ON DELETE CASCADE,
  flight_id       bigint NOT NULL REFERENCES fd_flights(id) ON DELETE CASCADE,
  observation_id  bigint NOT NULL REFERENCES fd_observations(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, flight_id)
);
CREATE INDEX fd_sightings_obs ON fd_sightings (observation_id);

CREATE TABLE fd_quality_findings (
  id          bigserial PRIMARY KEY,
  run_id      bigint REFERENCES fd_collection_runs(id) ON DELETE CASCADE,
  airport     text,
  source_id   text,
  direction   text,
  target_date date,
  flight_id   bigint REFERENCES fd_flights(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('info','warning','error')),
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fd_quality_airport ON fd_quality_findings (airport, created_at DESC);
CREATE INDEX fd_quality_kind ON fd_quality_findings (kind);

-- Short-lived raw response excerpts for parser debugging (purged after FD_RAW_RETENTION_DAYS).
CREATE TABLE fd_raw_samples (
  id          bigserial PRIMARY KEY,
  run_id      bigint NOT NULL REFERENCES fd_collection_runs(id) ON DELETE CASCADE,
  window_label text NOT NULL,
  http_status int,
  bytes       int NOT NULL,
  sample      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Assignment history: each observation with the previous state of the same flight (any source), for change analysis.
CREATE VIEW fd_assignment_history AS
SELECT o.id, o.flight_id, o.source_id, o.first_seen_at, o.last_seen_at, o.stage, o.status, o.terminal, o.gate, o.stand,
       LAG(o.terminal) OVER w AS prev_terminal, LAG(o.gate) OVER w AS prev_gate,
       (LAG(o.id) OVER w IS NOT NULL AND o.terminal IS DISTINCT FROM LAG(o.terminal) OVER w) AS terminal_changed,
       (LAG(o.id) OVER w IS NOT NULL AND o.gate IS DISTINCT FROM LAG(o.gate) OVER w) AS gate_changed
FROM fd_observations o
WINDOW w AS (PARTITION BY o.flight_id, o.source_id ORDER BY o.first_seen_at, o.id);

-- Latest state per flight and source.
CREATE VIEW fd_latest AS
SELECT DISTINCT ON (o.flight_id, o.source_id) o.*
FROM fd_observations o
ORDER BY o.flight_id, o.source_id, o.last_seen_at DESC, o.id DESC;

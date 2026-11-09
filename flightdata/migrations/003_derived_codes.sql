-- Derived counters also record which marketing numbers were seen for a flight number (field 'code', n = flight-days),
-- so a codeshare number still resolves to its operating flight after the raw rows of a time-limited source are purged.
ALTER TABLE fd_derived_counts DROP CONSTRAINT fd_derived_counts_field_check;
ALTER TABLE fd_derived_counts ADD CONSTRAINT fd_derived_counts_field_check CHECK (field IN ('terminal','gate','flight-days','cancelled','code'));
CREATE INDEX fd_derived_code ON fd_derived_counts (value) WHERE field = 'code';

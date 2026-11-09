#!/usr/bin/env sh
# Logical backup of the production flight-data database (TEMPLATE; run by the owner or a scheduled job).
#   FD_DATABASE_URL=postgres://… sh flightdata/deploy/backup.sh /path/to/backups
# Two independent forms: pg_dump (full, restorable with pg_restore) and the platform's JSON-lines export
# (restorable into any PostgreSQL or PGlite with `npm run fd -- import --in <file>`).
set -eu
OUT="${1:-./fd-backups}"; mkdir -p "$OUT"; STAMP=$(date -u +%Y%m%dT%H%MZ)
pg_dump --format=custom --no-owner "$FD_DATABASE_URL" > "$OUT/flightdata-$STAMP.dump"
npm run --silent fd -- export --out "$OUT/flightdata-$STAMP.jsonl"
gzip -f "$OUT/flightdata-$STAMP.jsonl"
ls -la "$OUT" | tail -5

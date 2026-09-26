#!/bin/bash
# Create this node's city schemas on first boot.
#
# Why render the migrations instead of shipping per-city SQL copies: the DDL in
# db/migrations/shard/*.sql stays the single source of truth, and the {{HOT}} /
# {{HIST}} / {{READ}} tokens are replaced here exactly the way scripts/migrate.js
# replaces them. No duplication, so no drift.
#
# Only mounted into the three city containers. CITY_CODE is set per container in
# docker-compose.yml.
set -euo pipefail

CITY="${CITY_CODE:?CITY_CODE must be set by the container environment}"
CITY_LOWER="$(printf '%s' "$CITY" | tr '[:upper:]' '[:lower:]')"
HOT="${CITY_LOWER}_hot"
HIST="${CITY_LOWER}_history"
READ="${CITY_LOWER}_read"
MIGRATIONS="${MIGRATIONS_DIR:-/migrations}"

case "$CITY" in
  KHI|LHE|ISB) ;;
  *) echo "[init-city] unsupported CITY_CODE='$CITY' (expected KHI, LHE or ISB)" >&2; exit 1 ;;
esac

echo "[init-city] applying city schemas for $CITY (hot=$HOT hist=$HIST read=$READ)"

shopt -s nullglob
for file in "$MIGRATIONS"/shard/*.sql; do
  name="$(basename "$file")"
  echo "[init-city] rendering $name"
  sed -e "s/{{HOT}}/$HOT/g" -e "s/{{HIST}}/$HIST/g" -e "s/{{READ}}/$READ/g" "$file" \
    | psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc \
        --dbname "${PGDATABASE}" --username "${PGUSER}"
done

echo "[init-city] $CITY ready"

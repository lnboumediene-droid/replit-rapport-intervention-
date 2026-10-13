#!/usr/bin/env bash
# Restore ONE MSB-BAT export into a NEW EMPTY PostgreSQL database.
#
# Usage:
#   DATABASE_URL="postgresql://user:pass@host:5432/msb_production" \
#     scripts/restore-msb-db.sh donnees/production.sql
#
# The export scripts create their own tables and contain no DROP/REPLACE, so
# they must only ever run against a fresh database. This wrapper refuses to run
# if the target already contains any msb_ table, so a production and a
# development export can never be merged or overwritten by accident.
set -euo pipefail

SQL_FILE="${1:?usage: restore-msb-db.sh <export.sql>}"
: "${DATABASE_URL:?DATABASE_URL must point at the NEW EMPTY database}"

TABLES=(msb_clients msb_erased_names msb_pdf_imports msb_report_photos \
  msb_report_status_history msb_report_versions msb_report_zones \
  msb_reports msb_sites msb_user_profiles)

existing="$(psql "$DATABASE_URL" -X -tAc \
  "SELECT count(*) FROM information_schema.tables
   WHERE table_schema='public' AND table_name LIKE 'msb\_%';")"
if [ "$existing" != "0" ]; then
  echo "Refusing to restore: the target already has $existing msb_ table(s)." >&2
  echo "Use a NEW EMPTY database so production and development stay separate." >&2
  exit 1
fi

echo "Restoring $(basename "$SQL_FILE") into a fresh database..."
psql "$DATABASE_URL" -X --set ON_ERROR_STOP=1 --file "$SQL_FILE"

echo
echo "Row counts (compare with MANIFESTE.json):"
for table in "${TABLES[@]}"; do
  count="$(psql "$DATABASE_URL" -X -tAc "SELECT count(*) FROM public.\"$table\";")"
  printf '  %-28s %s\n' "$table" "$count"
done

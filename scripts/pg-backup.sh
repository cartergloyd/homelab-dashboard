#!/usr/bin/env bash
# Dump every database on the homelab PostgreSQL (the personal one and each app's) to
# PG_BACKUP_DIR as <db>-YYYYMMDD-HHMMSS.sql.gz and keep PG_BACKUP_KEEP days. Runs
# `pg_dump` inside the postgres container, so nothing needs installing on the host.
#
#   scripts/pg-backup.sh                       # all databases
#   scripts/pg-backup.sh fam                   # one database
#
# Schedule it from the dashboard (Maintenance → New job → Run a script, after copying it
# into SCRIPTS_DIR) or from a systemd timer wrapped with hl-run; either way the output
# lands in Live server alerts and the Database tab shows the newest dump per database.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
envfile="${COMPOSE_ENV:-$here/.env}"
if [ -f "$envfile" ]; then
  # shellcheck disable=SC1090
  set -a; . "$envfile"; set +a
fi
: "${POSTGRES_USER:?POSTGRES_USER not set (COMPOSE_ENV=… or run from the repo)}"
container="${POSTGRES_CONTAINER:-homelab-postgres}"
out="${PG_BACKUP_DIR:-/var/backups/postgres}"
keep="${PG_BACKUP_KEEP:-14}"
only="${1:-}"

mkdir -p "$out"
if [ -n "$only" ]; then
  dbs="$only"
else
  dbs="$(docker exec "$container" psql -U "$POSTGRES_USER" -d postgres -At -c "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1")"
fi

stamp="$(date +%Y%m%d-%H%M%S)"
status=0
for db in $dbs; do
  file="$out/$db-$stamp.sql.gz"
  if docker exec "$container" pg_dump -U "$POSTGRES_USER" -d "$db" --no-owner --no-privileges | gzip > "$file"; then
    echo "pg-backup: $db → $file ($(du -h "$file" | cut -f1))"
  else
    echo "pg-backup: FAILED dumping $db" >&2
    rm -f "$file"
    status=1
  fi
done

removed="$(find "$out" -name '*.sql.gz' -mtime "+$keep" -print -delete | wc -l | tr -d ' ')"
echo "pg-backup: kept $keep days, removed $removed old dump(s)"
exit "$status"

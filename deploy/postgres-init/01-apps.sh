#!/bin/bash
# Runs inside the postgres container on FIRST start only (the official image executes
# /docker-entrypoint-initdb.d/* when the data directory is empty). Creates one login role
# and one database per app named in $APPS, each owned by its role, so apps are
# segregated: fam's role cannot see ai's tables and vice versa. Passwords come from
# APP_<NAME>_DB_PASSWORD (name upper-cased, "-" → "_").
#
# Adding an app to an existing cluster: scripts/add-app.sh <name> (same statements, idempotent).
set -euo pipefail

IFS=',' read -ra apps <<< "${APPS:-}"
for raw in "${apps[@]}"; do
  app="$(echo "$raw" | tr -d '[:space:]')"
  [ -z "$app" ] && continue
  if ! [[ "$app" =~ ^[a-z][a-z0-9_-]{0,30}$ ]]; then
    echo "init-apps: '$app' is not a valid app name (lowercase letters, digits, - _); skipping" >&2
    continue
  fi
  var="APP_$(echo "$app" | tr '[:lower:]-' '[:upper:]_')_DB_PASSWORD"
  pw="${!var:-}"
  if [ -z "$pw" ]; then
    echo "init-apps: $var is not set; skipping $app" >&2
    continue
  fi
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v app="$app" -v pw="$pw" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app', :'pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app', :'app') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app') \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'app', '60s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'app', '60s') \gexec
SQL
  echo "init-apps: database and role '$app' ready"
done

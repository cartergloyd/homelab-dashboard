#!/usr/bin/env bash
# Add an app (its own database + role, and the snippets for its own Directus + hostname).
# Hostnames: the Directus (API + /admin) is <name>-api.<domain> through the tunnel (single level —
# the free Universal SSL cert covers *.<domain> only); <name>.<domain>
# is left for the app's front-end (GitHub Pages or wherever it is hosted).
#
#   scripts/add-app.sh <name>            e.g. scripts/add-app.sh shop
#
# Creates the role and database in the RUNNING postgres container (idempotent), generates
# secrets, and PRINTS what to paste: .env lines, the docker-compose service block, the
# Cloudflare public hostname, and the dashboard env. It edits nothing itself — review,
# paste, then `docker compose up -d`.
set -euo pipefail

name="${1:-}"
if ! [[ "$name" =~ ^[a-z][a-z0-9_-]{0,30}$ ]]; then
  echo "usage: scripts/add-app.sh <name>   (lowercase letters, digits, - _)" >&2
  exit 64
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
envfile="${COMPOSE_ENV:-$here/.env}"
if [ ! -f "$envfile" ]; then
  echo "add-app: $envfile not found (copy .env.example to .env first)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$envfile"; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing in $envfile}"
: "${PUBLIC_DOMAIN:?PUBLIC_DOMAIN missing in $envfile}"
container="${POSTGRES_CONTAINER:-homelab-postgres}"
upper="$(echo "$name" | tr '[:lower:]-' '[:upper:]_')"

pw="$(openssl rand -hex 24)"
secret="$(openssl rand -hex 32)"
admin_pw="$(openssl rand -base64 18 | tr -d '/+=')"

# next free loopback port after the existing directus-* services
port=$(( 8055 + 1 + $(grep -cE '^\s*directus-[a-z0-9_-]+:\s*$' "$here/docker-compose.yml") ))

echo "Creating role and database '$name' in $container …"
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v app="$name" -v pw="$pw" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app', :'pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'app', :'pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app', :'app') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app') \gexec
SQL
echo "done."

cat <<EOF

================ 1. append to $envfile ================
APP_${upper}_DB_PASSWORD=$pw
APP_${upper}_SECRET=$secret
APP_${upper}_ADMIN_EMAIL=${DIRECTUS_ADMIN_EMAIL:-you@example.com}
APP_${upper}_ADMIN_PASSWORD=$admin_pw
# APP_${upper}_CORS_ORIGIN=https://$name.$PUBLIC_DOMAIN     (the app's front-end origin; this is the default)
(and add "$name" to APPS=… so a fresh cluster would recreate it)

================ 2. add to docker-compose.yml (under services:) ================
  directus-$name:
    image: directus/directus:11.9.3
    container_name: homelab-directus-$name
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      SECRET: \${APP_${upper}_SECRET}
      DB_CLIENT: pg
      DB_HOST: postgres
      DB_PORT: 5432
      DB_DATABASE: $name
      DB_USER: $name
      DB_PASSWORD: \${APP_${upper}_DB_PASSWORD}
      ADMIN_EMAIL: \${APP_${upper}_ADMIN_EMAIL}
      ADMIN_PASSWORD: \${APP_${upper}_ADMIN_PASSWORD}
      PUBLIC_URL: https://$name-api.\${PUBLIC_DOMAIN}
      IP_TRUST_PROXY: "true"
      RATE_LIMITER_ENABLED: "true"
      RATE_LIMITER_POINTS: "50"
      RATE_LIMITER_DURATION: "1"
      CORS_ENABLED: "true"
      CORS_ORIGIN: \${APP_${upper}_CORS_ORIGIN:-https://$name.\${PUBLIC_DOMAIN}}
      REFRESH_TOKEN_COOKIE_SECURE: "true"
      REFRESH_TOKEN_COOKIE_SAME_SITE: lax
      SESSION_COOKIE_SECURE: "true"
      SESSION_COOKIE_SAME_SITE: lax
      WEBSOCKETS_ENABLED: "true"
      TELEMETRY: "false"
    volumes:
      - \${APPS_DATA_DIR:-./apps}/$name/uploads:/directus/uploads
      - \${APPS_DATA_DIR:-./apps}/$name/extensions:/directus/extensions
    ports:
      - "127.0.0.1:$port:8055"
  … and add "- directus-$name" under cloudflared → depends_on.

================ 3. Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public Hostname ================
  Add route → Published application: Subdomain: $name-api   Domain: $PUBLIC_DOMAIN   Service URL: http://127.0.0.1:$port
  (cloudflared runs on the host network, so it reaches the loopback port directly)
  (optional) Access → Applications: protect https://$name-api.$PUBLIC_DOMAIN/admin* with your login
  Front-end: point $name.$PUBLIC_DOMAIN at wherever the site is hosted (plain DNS record, not a tunnel hostname)

================ 4. dashboard env (/etc/homelab-dashboard.env or the real env file) ================
APPS=…,$name          (append)
APP_${upper}_URL=http://127.0.0.1:$port
# APP_${upper}_PUBLIC_URL defaults to https://$name-api.$PUBLIC_DOMAIN and APP_${upper}_SITE_URL to https://$name.$PUBLIC_DOMAIN

Then: docker compose up -d && sudo systemctl restart homelab-dashboard && npm run audit:install
EOF

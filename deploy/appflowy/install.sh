#!/usr/bin/env bash
# Install or update self-hosted AppFlowy (AppFlowy-Cloud) on gold-server, as its own compose project.
# Copy deploy/appflowy/* to ~/server-platform/appflowy/ and run ./install.sh there.
# Safe to re-run: an existing .env (and its secrets) is kept. Secrets never leave that folder.
set -euo pipefail
cd "$(dirname "$0")"
# AppFlowy-Cloud's own release tags stop at 0.9.64 (Jul 2025); the Docker images moved on, so the
# wiring is pinned by commit and the images by version (bump both deliberately, then ./dc up -d).
COMMIT=c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da
FQDN=${FQDN:-notes.xgold.tech}

if [ ! -d upstream ]; then
  git clone --quiet https://github.com/AppFlowy-IO/AppFlowy-Cloud.git upstream
  git -C upstream -c advice.detachedHead=false checkout --quiet "$COMMIT"
fi

if [ ! -f .env ]; then
  umask 077
  cp upstream/deploy.env .env
  # edit in place: later lines interpolate earlier ones, so appending overrides would not reach them
  set_kv() { sed -i "s|^$1=.*|$1=$2|" .env; }
  PW=$(openssl rand -hex 16)
  set_kv FQDN "$FQDN"; set_kv SCHEME https
  set_kv POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_kv GOTRUE_JWT_SECRET "$(openssl rand -hex 32)"
  set_kv GOTRUE_ADMIN_EMAIL "owner@$FQDN"; set_kv GOTRUE_ADMIN_PASSWORD "$PW"
  set_kv GOTRUE_DISABLE_SIGNUP true
  set_kv AWS_ACCESS_KEY appflowy; set_kv AWS_SECRET "$(openssl rand -hex 24)"
  cat >> .env <<ENV
AI_ENABLED=false
GOTRUE_VERSION=0.20.6
APPFLOWY_CLOUD_VERSION=0.20.7
APPFLOWY_WORKER_VERSION=0.20.7
APPFLOWY_SEARCH_VERSION=0.20.7
APPFLOWY_WEB_VERSION=0.20.12
ENV
  printf 'AppFlowy sign-in (self-hosted, no e-mail is ever sent)\nURL:      https://%s\nEmail:    owner@%s\nPassword: %s\n' "$FQDN" "$FQDN" "$PW" > ADMIN-CREDENTIALS.txt
fi

chmod +x dc
./dc up -d --no-build   # --no-build: a missing image must fail, never start a Rust compile on this box
echo "waiting for AppFlowy…"
for _ in $(seq 60); do
  curl -fsS -o /dev/null -H "Host: $FQDN" http://127.0.0.1:8070/api/health && { echo "AppFlowy is up on 127.0.0.1:8070"; exit 0; }
  sleep 5
done
./dc ps; echo "not healthy after 5 min — ./dc logs appflowy_cloud" >&2; exit 1

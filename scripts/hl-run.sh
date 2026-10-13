#!/usr/bin/env bash
# Run any command and mirror its output into the dashboard's Live Server Alerts,
# for scripts you still launch from a terminal (double-click, cron, SSH).
#
#   export HOMELAB_URL=https://homeserver.tail1234.ts.net   # or http://127.0.0.1:3000 on the server
#   export HOMELAB_KEY=...                                  # DASHBOARD_KEY from /etc/homelab-dashboard.env
#   hl-run.sh python3 /opt/homelab-scripts/backup_world.py
#
# Output still prints to your terminal; the exit code of your command is preserved.
set -uo pipefail
: "${HOMELAB_URL:=http://127.0.0.1:3000}"

if [ $# -eq 0 ]; then
  echo "usage: hl-run.sh <command> [args...]" >&2
  exit 64
fi
if [ -z "${HOMELAB_KEY:-}" ]; then
  echo "hl-run: HOMELAB_KEY is not set — running without the dashboard feed" >&2
  exec "$@"
fi

# label = the script name: "python3 foo.py" → foo.py, "./foo.sh" → foo.sh, "bash -c ..." → bash
case "$1" in
  python*|bash|sh|node|perl) target="${2:-$1}" ;;
  *) target="$1" ;;
esac
case "$target" in -*) target="$1" ;; esac
label="${target##*/}"
label="$(printf '%s' "$label" | sed 's/[^A-Za-z0-9._-]/_/g')"

"$@" 2>&1 | tee >(curl -sS -X POST -T - \
  -H "Authorization: Bearer $HOMELAB_KEY" \
  "$HOMELAB_URL/api/alerts/ingest?label=$label" >/dev/null || echo "hl-run: could not reach $HOMELAB_URL" >&2)
status="${PIPESTATUS[0]}"
# tell the dashboard how it ended, so mirrored (external) jobs can be marked OK / failed
curl -sS -X POST -H "Authorization: Bearer $HOMELAB_KEY" \
  "$HOMELAB_URL/api/alerts/ingest/exit?label=$label&code=$status" >/dev/null 2>&1 || true
exit "$status"

#!/usr/bin/env bash
# Run any command and mirror its output into the dashboard's Live Server Alerts,
# for scripts launched outside the dashboard (double-click, cron, systemd timer, SSH).
#
#   export HOMELAB_URL=https://homeserver.tail1234.ts.net   # or http://127.0.0.1:3000 on the server
#   export HOMELAB_KEY=...                                  # DASHBOARD_KEY from /etc/homelab-dashboard.env
#   hl-run python3 "/home/gold/Minecraft Server/backup_world.py"
#
# cron and systemd units have no environment of their own: `sudo npm run wrap-service --
# --install-hl-run` writes /etc/homelab-hl-run.env (HOMELAB_URL + HOMELAB_KEY) and this
# script reads it when the variables are missing. Output still prints to the terminal /
# journal; the exit code of your command is preserved and reported to the dashboard.
set -uo pipefail
# From a systemd unit with EnvironmentFile=/etc/homelab-dashboard.env the dashboard's own
# variable names are present instead of HOMELAB_*; accept both.
: "${HOMELAB_KEY:=${DASHBOARD_KEY:-}}"
HL_RUN_ENV="${HL_RUN_ENV:-/etc/homelab-hl-run.env}"
if [ -z "$HOMELAB_KEY" ] && [ -r "$HL_RUN_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$HL_RUN_ENV"
  set +a
  : "${HOMELAB_KEY:=${DASHBOARD_KEY:-}}"
fi
: "${HOMELAB_URL:=http://127.0.0.1:${PORT:-3000}}"

if [ $# -eq 0 ]; then
  echo "usage: hl-run <command> [args...]" >&2
  exit 64
fi
if [ -z "${HOMELAB_KEY:-}" ]; then
  echo "hl-run: HOMELAB_KEY is not set and $HL_RUN_ENV is not readable — running without the dashboard feed" >&2
  exec "$@"
fi

# Python buffers stdout when it is a pipe; without this its output would only reach
# the feed when the script exits instead of line by line.
export PYTHONUNBUFFERED=1

# label = the script name: "python3 foo.py" → foo.py, "./foo.sh" → foo.sh, "bash -c ..." → bash
case "$1" in
  python*|bash|sh|node|perl) target="${2:-$1}" ;;
  *) target="$1" ;;
esac
case "$target" in -*) target="$1" ;; esac
label="${target##*/}"
label="$(printf '%s' "$label" | sed 's/[^A-Za-z0-9._-]/_/g')"

# fd 3 = the original stdout, so tee can echo to the terminal while piping to curl.
# curl runs in the foreground stage of the pipeline, so all output has been delivered
# before the exit code is reported below (no race). If the dashboard is unreachable,
# `cat` keeps draining so tee — and therefore your script — never gets SIGPIPE.
exec 3>&1
"$@" 2>&1 | tee /dev/fd/3 | {
  curl -sS -X POST -T - \
    -H "Authorization: Bearer $HOMELAB_KEY" \
    "$HOMELAB_URL/api/alerts/ingest?label=$label" >/dev/null 2>&1 \
    || { echo "hl-run: could not reach $HOMELAB_URL — output not mirrored" >&2; cat >/dev/null; }
}
status="${PIPESTATUS[0]}"
exec 3>&-
# tell the dashboard how it ended, so mirrored (external) jobs can be marked OK / failed
curl -sS -X POST -H "Authorization: Bearer $HOMELAB_KEY" \
  "$HOMELAB_URL/api/alerts/ingest/exit?label=$label&code=$status" >/dev/null 2>&1 || true
exit "$status"

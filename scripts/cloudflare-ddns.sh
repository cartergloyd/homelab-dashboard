#!/usr/bin/env bash
# Keep the DNS-only "home IP" records (mc, streaming, …) pointing at this house's current public
# address. AT&T hands out dynamic addresses; when it changes, players and the Jellyfin app lose
# the server until these records follow.
#
#   /etc/homelab-ddns.env (0600, root):
#     CLOUDFLARE_DDNS_TOKEN=…     API token scoped to THIS zone only: Zone·DNS·Edit (+ Zone·Zone·Read)
#     DDNS_ZONE=xgold.tech
#     DDNS_HOSTS=mc.xgold.tech,streaming.xgold.tech
#   cron (root), every 5 minutes:
#     */5 * * * * /usr/local/bin/hl-run cloudflare-ddns /opt/homelab-dashboard/scripts/cloudflare-ddns.sh
#
# This is the ONE place that writes DNS. The dashboard only reads (CLAUDE.md decisions). The script
# changes nothing when the address is unchanged, never touches proxied records or any host not in
# DDNS_HOSTS, and prints one line per decision so hl-run can put it in the alerts feed.
set -euo pipefail
envfile="${DDNS_ENV:-/etc/homelab-ddns.env}"
[ -f "$envfile" ] && { set -a; . "$envfile"; set +a; }
: "${CLOUDFLARE_DDNS_TOKEN:?CLOUDFLARE_DDNS_TOKEN missing (in $envfile)}"
: "${DDNS_ZONE:?DDNS_ZONE missing}"
: "${DDNS_HOSTS:?DDNS_HOSTS missing (comma-separated hostnames)}"

api() { curl -sS -m 15 -H "Authorization: Bearer $CLOUDFLARE_DDNS_TOKEN" -H "Content-Type: application/json" "$@"; }

# the address the internet sees for this host (two independent sources; they must agree)
ip1="$(curl -sS -m 10 https://api.ipify.org || true)"
ip2="$(curl -sS -m 10 https://cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p' || true)"
if ! [[ "$ip1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ "$ip1" != "$ip2" ]; then
  echo "ddns: could not determine the public IPv4 reliably (ipify='$ip1' cloudflare='$ip2') — no change made" >&2
  exit 1
fi

zone_id="$(api "https://api.cloudflare.com/client/v4/zones?name=$DDNS_ZONE&status=active" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')"
[ -n "$zone_id" ] || { echo "ddns: zone $DDNS_ZONE not visible to this token" >&2; exit 1; }

changed=0
IFS=',' read -ra hosts <<< "$DDNS_HOSTS"
for h in "${hosts[@]}"; do
  h="$(echo "$h" | tr -d ' ')"; [ -n "$h" ] || continue
  rec="$(api "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records?type=A&name=$h")"
  read -r rid cur proxied < <(echo "$rec" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"], r[0]["content"], r[0]["proxied"]) if r else print("", "", "")')
  if [ -z "$rid" ]; then echo "ddns: $h has no A record — skipped (create it in Cloudflare first)"; continue; fi
  if [ "$proxied" = "True" ]; then echo "ddns: $h is proxied — skipped (a home-IP record must be DNS only)"; continue; fi
  if [ "$cur" = "$ip1" ]; then echo "ddns: $h = $ip1 (unchanged)"; continue; fi
  api -X PATCH "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records/$rid" --data "{\"content\":\"$ip1\"}" >/dev/null
  echo "ddns: $h $cur → $ip1 (updated)"
  changed=$((changed + 1))
done
[ "$changed" -gt 0 ] && echo "ddns: $changed record(s) updated to $ip1" || true

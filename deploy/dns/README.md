# deploy/dns — the owner's public DNS, as data

`xgold.tech.zone` is the exact record set Squarespace served for `xgold.tech` on
2026-10-20, in BIND format, so the Cloudflare zone can be made identical with one
**Import** instead of ten hand edits. The cutover runbook is `SERVER_SETUP.md § 5.0a`;
the invariants it protects are:

| Record | Must be | Why |
|---|---|---|
| `mc`, `streaming` (A → home IP) | **DNS only** | Minecraft (TCP 25565) and Jellyfin are not HTTP on 80/443; Cloudflare's proxy would break them |
| `@`, `www`, `fam` (GitHub Pages) | DNS only for the cutover | identical behaviour to today; proxying is an optional later step (needs SSL/TLS mode *Full*) |
| `fam-api`, `ai-api`, later `dash` | **proxied CNAMEs created by the tunnel** | the only records Cloudflare should proxy; never A records to the home IP. Single-level names: Universal SSL covers `*.xgold.tech` only |
| `api.fam` (A → home IP) | legacy, DNS only | the pre-tunnel API host; delete once nothing uses it |
| `_minecraft._tcp.mc` SRV, the TXTs | unchanged | |

`scripts/cloudflare-ddns.sh` (SERVER_SETUP § 8c) is the only writer: it moves the `mc` / `streaming`
A records when the house's public address changes. `npm run audit:install` → `[dns]` verifies the nameservers are Cloudflare's, DNSSEC is
consistent, each `<app>-api` resolves to Cloudflare (proxied) and the Minecraft host does
**not**.

This is real data about the owner's domain, not an `[INSTALLER]` placeholder. When a record
changes on purpose, change it here too — the Dashboard's **Domain & hostnames** card reads this
file when no read-only `CLOUDFLARE_API_TOKEN` is configured (SERVER_SETUP § 6h), and the audit's
`[dns]` section is independent of both.

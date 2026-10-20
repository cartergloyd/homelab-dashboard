# deploy/dns — the owner's public DNS, as data

`xgold.tech.zone` is the exact record set Squarespace served for `xgold.tech` on
2026-10-20, in BIND format, so the Cloudflare zone can be made identical with one
**Import** instead of ten hand edits. The cutover runbook is `SERVER_SETUP.md § 5.0a`;
the invariants it protects are:

| Record | Must be | Why |
|---|---|---|
| `mc`, `streaming` (A → home IP) | **DNS only** | Minecraft (TCP 25565) and Jellyfin are not HTTP on 80/443; Cloudflare's proxy would break them |
| `@`, `www`, `fam` (GitHub Pages) | DNS only for the cutover | identical behaviour to today; proxying is an optional later step (needs SSL/TLS mode *Full*) |
| `api.fam`, `api.ai`, later `dash` | **proxied CNAMEs created by the tunnel** | the only records Cloudflare should proxy; never A records to the home IP |
| `_minecraft._tcp.mc` SRV, the TXTs | unchanged | |

`npm run audit:install` → `[dns]` verifies the nameservers are Cloudflare's, DNSSEC is
consistent, each `api.<app>` resolves to Cloudflare (proxied) and the Minecraft host does
**not**.

This is real data about the owner's domain, not an `[INSTALLER]` placeholder. When a record
changes on purpose, change it here too.

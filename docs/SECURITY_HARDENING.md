# Installed security controls and remaining issue #10 work

Verified on the gold server on 2026-10-20 (America/Chicago).

## Database controls

The `fam` and `ai` login roles have no superuser, database/role creation,
replication or RLS-bypass privileges. Each has a 60-second statement timeout
and a 60-second idle-in-transaction timeout. These are role defaults for new
connections; the apps were recreated to replace their connection pools.
Long imports or future migrations may need an explicitly reviewed larger limit.

`PUBLIC` has no access to either app database, and no CONNECT grant on the
personal database or maintenance database. Fresh connections were tested for
both app roles, including actual query cancellation and cross-database denials.
The administrator remains available for maintenance and backups.

PostgreSQL logs connections and uses SCRAM passwords. The installed HBA allows
authenticated app/database pairs and administrator connections from the
`server-platform_default` bridge (172.20.0.0/16), rejects other TCP connections,
and keeps socket-only trust inside the PostgreSQL container for existing backup
jobs. Port 5432 is published only on 127.0.0.1.

`deploy/postgres-app-hardening.sql` and `deploy/pg_hba.homelab.conf` record this
particular server's settings. Check role/database names and the bridge subnet
before applying them elsewhere. Initialization and add-app scripts also set the
two app-role timeouts for future apps.

Both public Directus apps explicitly set 15-minute access tokens, seven-day
refresh tokens, one-day sessions, secure cookies and HSTS. They trust private
proxy hops rather than arbitrary forwarding chains. Registration is disabled,
password changes require at least 12 characters, and the login-attempt limit is
five. Administrator MFA remains enforced. No collection permissions currently
exist; review per-user ownership filters before granting app permissions.

## Dashboard controls

Public browser requests still require a valid Cloudflare Access JWT. A remote
bearer-key request now requires a **service-token JWT**; a human JWT plus the
dashboard key is rejected. A service JWT without the dashboard key is rejected.
Direct bearer requests require the loopback proxy connection. This also covers
WebSockets because they use the same identity resolver.

The MCP client accepts `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
alongside `HOMELAB_KEY` and an HTTPS `HOMELAB_URL`. It refuses HTTP service
credentials and redirects. Provisioning a Cloudflare Service Auth policy/token
and testing it externally remains separate work; local MCP needs neither.

Responses include HSTS, CSP, anti-framing and nosniff headers. APIs use
`Cache-Control: no-store`, including configuration responses. Security and
approval mutations have a shared 30-per-minute limit per authenticated login;
authenticator verification retains its stricter five-failure limit.

## Backup and audit evidence

The encrypted OneDrive job writes `last-verified.json` only after downloading
the uploaded encrypted files, checking their hashes and restoring each database
in an isolated container. `OFFSITE_BACKUP_RECEIPT` points the install audit to
this receipt. The audit fails if it is missing, older than 30 hours, or lacks an
app database. The encrypted archive also includes dashboard authenticator state
and its key, protected by the separate off-server recovery key.

`npm run audit:install -- --env /home/gold/server-platform/homelab-dashboard.env`
now checks database role restrictions, timeouts, isolation, TCP authentication,
connection logging, Directus enrollment and policies, token/cookie settings,
admin Access walls, security headers and offsite restore evidence.

## Remaining work: do not close issue #10 yet

- Verify Cloudflare's actual IdP MFA requirement, owner-only policies and
  account MFA. GitHub login alone does **not** prove that MFA was required.
- Configure and externally test the automation Service Auth policy/token.
- Verify zone TLS, HTTPS, WAF/Bot settings and edge rate-limiting rules.
- Add separate per-app/tunnel alert sources and database-image version tracking.
- Implement coordinated secret rotation and review personal Directus's use of
  the database administrator account.
- Finish the older install-audit failures: Tailscale is unavailable, several
  timers have no mirror, and maintenance output is not wrapped with hl-run.
  No timers were rescheduled or maintenance jobs triggered by this change.

## Rollback

Private original PostgreSQL HBA/auto-conf, role settings/database ACLs, Directus
settings and compose configuration are saved under
`/home/gold/server-platform/backup-private/security-hardening/` (not in Git).
Restore the original HBA/auto-conf and reload PostgreSQL to undo the network
rules/logging changes. Restore role defaults/ACLs from the recorded snapshot,
and restore the compose/settings snapshots before recreating Directus if needed.
Use a localhost administrator connection for recovery; do not publish PostgreSQL.

References: [PostgreSQL role/session timeouts](https://www.postgresql.org/docs/16/runtime-config-client.html),
[Directus token and cookie settings](https://directus.com/docs/configuration/security-limits),
[Cloudflare application/service JWT claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

# Dash: live deployment and data connections

The Dash layout is implemented in the existing React/Express application. The design reference was version 8 of the private Dash server design preview. Its JavaScript, fixtures, mock commands, sample charts, and simulated mutations are **not** production application code.

## Navigation and preserved functions

| Location | Real connection / existing data |
|---|---|
| Overview | `/overview`, `/host`, `/jobs`, live alerts, maintenance reports. CPU/memory history contains actual one-minute host samples only. |
| Minecraft | Existing systemd/RCON controls, shared player updates, console, scripts, live alerts, assistant approvals/context/incident investigation, Paper/plugin staged updates, backups and maintenance reports. |
| Jellyfin | Existing server/session/user/library counts and scan/restart controls, live paginated library search, qBittorrent queue controls, media file management. |
| Files & storage | Inline Directus collection/field/record management, CSV/JSON record imports, existing app/database health and private file/image uploads, existing media file operations and disk inventory/scans/reclaim analysis. |
| Network | Existing hostname/DNS probes, Cloudflare tunnel status, router link, service health, Tailscale devices, VPN routing diagnostics. |
| Terminal | Actual bounded bash commands run as the dashboard service account; service logs remain available. Each command uses a fresh shell with an explicit working directory. Interactive programs still need SSH. |
| Automation | All existing scheduled jobs and history, world backups, configured scripts, persisted followed repositories and activity. |
| Access | Existing authenticator enrollment, recovery and confirmation settings. |
| xGold AI | Business navigation, actual Twenty CRM status/link and configured application databases, assistant tools, plus the same host controls. |

Workspaces organize navigation and repository subscriptions on **one shared host**. They are not tenant security boundaries or separate machines. Jobs and host storage remain shared and visible. Existing Directus databases remain separate instances with their existing roles and permissions. Twenty opens the running CRM; this dashboard does not claim to proxy CRM contact editing.

Old `/database`, `/system`, `/vpn` URLs still work. Older media/maintenance/security/status/storage paths redirect to their new locations. Raw logs, report review, assistant conversation, and context history are retained.

## New persistent data

- `DATA_DIR/host-metrics.json`: up to seven days of actual CPU/memory samples. Empty history stays empty until measurements exist. No interpolation across missing samples is presented as collected history.
- `DATA_DIR/repositories.json`: explicitly followed GitHub repositories, owner-entered installed versions, workspace tags and real release/tag check results. No starter entries. Checks flag a **different tag**, not a proven upgrade, and never install software. Network failures are shown. Checks are coalesced and run in the background; automatic checks are due daily.
- Existing `jobs.json`, job/script runs, reports, alert rules/logs, sidecar state, security encryption key, approvals, context history, disk scans and `database-uploads.json` remain in their original directory.
- Media, world data, PostgreSQL databases, Directus files, app databases, and backups are not migrated or recreated by this UI deployment.

## Authentication and writes

Cloudflare Access validation, loopback-only trusted Tailscale headers, bearer-agent identity and existing authenticator confirmations remain in force. Terminal execution, Directus data/schema changes and torrent removal participate in central step-up protection. Host command credentials and output are not copied into the audit feed. Shell children do not inherit dashboard integration secrets from the server environment. Commands have a 30-second deadline, a 256 KB combined output limit and a two-command concurrency limit.

Directus record editing uses a user's existing Directus email/password and optional authenticator code. The dashboard proxies only configured instances. Tokens remain in memory on the server behind an owner-bound, HttpOnly, SameSite=Strict session cookie; they are not returned to JavaScript or written to disk. Mutations enforce origin checks. The actual Directus account permissions and validation apply. Restarting the dashboard ends these Directus editing sessions; sign in again. Existing private file uploads continue to use their separate configured service tokens.

Record imports are explicit creates, limited to 500 records / 750 KB. JSON preserves its data types; CSV preserves text (including leading-zero IDs) and Directus validates fields. A preview and confirmation precede submission. Duplicate IDs are not silently treated as updates. Singleton collections are readable; use the existing Directus admin for singleton editing.

qBittorrent queue responses omit tracker/magnet secrets. Start/stop use the 5.x API with 4.x resume/pause fallback. Removing a torrent keeps downloaded files. Existing download locations remain controlled by qBittorrent.

## Production and rollback

Build with `npm run build`, then run `npm test`. Production must use its existing environment and `DATA_DIR`; do not run the demo command or point production to a development data directory.

Before changing the unit, save its content, the environment file, the built assets and the persistent dashboard directory to a private backup outside the repository. Compare effective configuration between old and new builds, including media roots, scripts, backups, context file, authentication and ports. Stop the old dashboard by restarting the **same** systemd service against the new build; do not start a second scheduler against the live data directory.

For this installation, the user unit is `gold-dashboard.service`, the endpoint is loopback port 8088, and the environment/data remain under `/home/gold/server-platform/`. Only its WorkingDirectory and ExecStart change to the new build. Other services, the tunnel, DNS, Minecraft and Jellyfin are not restarted by deployment.

To roll back code, restore the saved user-unit file to `~/.config/systemd/user/gold-dashboard.service`, run `systemctl --user daemon-reload`, then `systemctl --user restart gold-dashboard.service`. The original source/build remain available. Keep the current data directory in place: restoring a data snapshot would discard subsequent real activity and is not needed for a code rollback.

Verification covers production health (`demo:false`), unchanged saved jobs and security/configuration hashes, preserved report IDs, actual integration reads, desktop/mobile navigation, and live WebSocket feeds. Unit tests create temporary fixtures outside production and delete them afterward. No test records, repositories, torrents or uploads are created in production.

## Version-8 page implementation

The production page layouts live in `web/src/design/`. They use the approved
preview's scoped stylesheet and icon paths, with locally hosted DM Sans and
Manrope fonts (licenses in `web/public/fonts`). `App.tsx` mounts these page
components directly. Do not substitute the old page components and a theme:
the section order, task placement and panel structure are part of the design.

- Minecraft: console, quick commands, paired mods/update hub, backups, settings.
- Jellyfin: downloads, folder browser/moves, media settings. Completed torrents
  remain accessible through the queue's view-all control.
- Storage: inline Directus, drive cards, workspace files, uploads, connection map.
  The business workspace defaults to its actual `ai` Directus/file connection.
- Network: hostname table, tunnel, VPN/Tailscale pair, router.
- Automation: metrics, schedules, update hub, scripts, activity.
- Access: users and connections; existing authenticator controls are in a dialog.
- Terminal: host shell and sessions. Advanced logs, reports, assistant tools,
  job editing, backups, database details and storage scans remain available in
  focused dialogs; none of the old page stacks is mounted in a main layout.

`web/test-design-browser.mjs` guards the 16 page layouts against the approved
section order and rejects old `.card` page content. It also checks desktop,
850 px and 390 px layouts, navigation, dialogs, workspace database defaults and
dark mode. Command payload and cancellation checks intercept all writes inside
an isolated browser context. They never send production write requests. Run it
against a local read-only preview using `DASH_QA_URL` and an installed Playwright
module (`PLAYWRIGHT_MODULE` can supply its absolute module path).

Minecraft's settings panel reads a strict allowlist from the real server
properties. RCON passwords and unrelated configuration never enter the response.

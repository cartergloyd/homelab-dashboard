# Server setup — handoff notes

These instructions are written for an AI assistant (or a person) installing this
dashboard on the owner's Linux home server. Work through them in order, confirm
each verification step, and ask the owner before anything destructive.

## What you are installing

`homelab-dashboard` is a Node.js web app (React UI + Express API) that gives the
owner one page, reachable only over Tailscale, to manage:

- **Jellyfin** (already running, in Docker) — status, sessions, library scan, container restart
- **Jellyfin media files** — browse/upload/rename/move/delete under the media folders
- **Minecraft** (Paper, installed natively, *not* in Docker) — start/stop/restart via systemd, RCON console, live log
- **Minecraft maintenance** — scheduled restarts with in-game countdown, world backups, recurring commands
- **Directus + PostgreSQL** (new, from `docker-compose.yml` in this repo) — the owner's personal database with a web UI
- **Logs, service status, storage, Tailscale peers**

The dashboard runs **natively as a systemd service** (not in Docker) so it can call
`systemctl`/`journalctl` for the Paper server. Only Postgres + Directus run in Docker.

Acceptance criteria the owner set:
1. Dashboard returns **200 OK** at its Tailscale address.
2. Directus UI is **reachable** over the tailnet.
3. **PostgreSQL stays private** on the server (published on `127.0.0.1` only — never LAN/tailnet).

## 0. Placeholders — find and replace every one

This repo was built on a laptop against a **demo** of the server, not the server. Every
assumption that could not be verified is marked in the code and config with the tag
`[INSTALLER]`. Before anything else, list them:

```bash
grep -rn "\[INSTALLER\]" --include="*.ts" --include="*.yml" --include="*.example" --include="*.service" --include="sudoers-*" . | grep -v node_modules
```

Resolve each hit against the live server and tick it off. The main ones:

| Where | What is placeholder | Replace with |
|---|---|---|
| `server/src/config.ts` | every `.default(...)` (container names, unit name, paths, ports) | real values in `/etc/homelab-dashboard.env` |
| `server/src/services/scheduler.ts` `defaultJobs()` | demo-only seeds (a real install starts with zero jobs) | `npm run discover -- --apply` to mirror the real timers (§ 6c); `npm run clear-demo-data` if seeds leaked |
| `server/src/demo.ts` | fake players/peers/filesystems, demo key, 3 sample scripts | nothing — never set `DEMO`; real scripts live in cron / `SCRIPTS_DIR` |
| `server/src/services/backups.ts` `worldFolders()` | reads `level-name` from `MC_DIR/server.properties`, falls back to `world` | nothing, unless the world folders live outside `MC_DIR` |
| `server/src/services/alerts.ts` `DEFAULT_RULES` | keyword rules tuned on demo logs | tune `data/alert-rules.json` after a day of real logs |
| `server/src/services/systemd.ts`, `deploy/sudoers-homelab` | `minecraft.service`, `/usr/bin/systemctl` | real unit name, real systemctl path |
| `deploy/minecraft.service` | user, folder, jar, memory | only if Paper is not already a unit — otherwise don't install it |
| `deploy/homelab-dashboard.service` | `/opt/homelab-dashboard`, `/usr/bin/node` | real install path, `which node` |
| `deploy/homelab-dashboard.env.example`, `.env.example` | every value | real values |
| `docker-compose.yml` | ports, image tags, container names | check free ports and current tags; names must match the dashboard env |
| `server/src/services/vpn.ts`, `VPN_*` env | provider probing, interface names, service list for the traffic map | the real VPN client/interface and how its exceptions are implemented (§ 6d) |

The demo you may have seen running is **not** a picture of this server. When the demo and
the live machine disagree, the live machine is right and the code/config gets corrected.

## Facts to discover first (ask or inspect; don't guess)

| Fact | How to find it | Used for |
|---|---|---|
| Linux distro & Node availability | `cat /etc/os-release`, `node --version` | step 1 |
| Jellyfin container name | `docker ps --format '{{.Names}} {{.Image}}'` | `JELLYFIN_CONTAINER` |
| Host paths of Jellyfin media | `docker inspect <jellyfin> --format '{{json .Mounts}}'` | `MEDIA_ROOTS` |
| Minecraft install dir, user, how it's started | `ps -ef \| grep -i paper`, `systemctl list-units \| grep -i mine`, check for screen/tmux | step 2, `MC_DIR`, `MC_SERVICE` |
| Server's Tailscale name / IP | `tailscale status`, `tailscale status --json \| jq .Self.DNSName` | public URLs |
| Owner's Tailscale login(s) | `tailscale status` (right-hand column) or `tailscale whois <their-ip>` | `ALLOWED_LOGINS` |
| Is ufw/firewalld active? | `sudo ufw status` | step 8 |

## 1. Install Node and the app

```bash
# Node 22 LTS (Debian/Ubuntu; skip if `node --version` is already >= 20.19)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

```bash
sudo mkdir -p /opt/homelab-dashboard
sudo rsync -a --exclude node_modules --exclude data --exclude .env <path-to-this-repo>/ /opt/homelab-dashboard/
cd /opt/homelab-dashboard && sudo npm ci && sudo npm run build
```

`npm run build` compiles `web/` (Vite) and `server/` (tsc). Expected output ends with no errors.

## 2. Paper: enable RCON and make sure systemd manages it

In the Paper directory's `server.properties`, set:

```
enable-rcon=true
rcon.port=25575
rcon.password=<generate: openssl rand -hex 16>
```

If Paper is **already a systemd unit**, note its unit name (`MC_SERVICE`) and make
sure it has `KillSignal=SIGINT` and `TimeoutStopSec=120` so restarts save cleanly
(`sudo systemctl edit <unit>` to add them). Restart it to apply the RCON change.

If Paper runs from **screen/tmux or a shell script**, migrate it:

```bash
sudo cp deploy/minecraft.service /etc/systemd/system/minecraft.service
sudo nano /etc/systemd/system/minecraft.service   # fix User, WorkingDirectory, jar name, -Xmx
```

Stop the existing Paper process (`stop` in its console), then:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now minecraft && systemctl status minecraft
```

Verify: `nc -zv 127.0.0.1 25565` connects and `journalctl -u minecraft -n 20` shows Paper output.

## 3. Create the service user and grant exactly what it needs

```bash
sudo useradd --system --home /opt/homelab-dashboard --shell /usr/sbin/nologin homelab
sudo usermod -aG docker,systemd-journal homelab
```

Give it access to the Minecraft directory (replace `minecraft` with the group
that owns `MC_DIR`, from `stat -c %G /opt/minecraft`):

```bash
sudo usermod -aG minecraft homelab && sudo chmod -R g+rwX /opt/minecraft
```

Give it read/write on each media root (replace with the real paths from `MEDIA_ROOTS`):

```bash
sudo setfacl -R -m u:homelab:rwX /srv/media && sudo setfacl -R -d -m u:homelab:rwX /srv/media
```

Install the sudoers rule (check `which systemctl`; edit the file if it is `/bin/systemctl`):

```bash
sudo visudo -cf deploy/sudoers-homelab && sudo install -m 0440 deploy/sudoers-homelab /etc/sudoers.d/homelab
```

```bash
sudo mkdir -p /var/backups/minecraft /opt/homelab-dashboard/data && sudo chown homelab:homelab /var/backups/minecraft /opt/homelab-dashboard/data && sudo chown -R homelab:homelab /opt/homelab-dashboard
```

## 4. Jellyfin API key

In Jellyfin's web UI: **Dashboard → Advanced → API Keys → +**, name it `homelab-dashboard`,
copy the key for `JELLYFIN_API_KEY`. (Jellyfin 12+ requires the modern
`Authorization: MediaBrowser Token=` header, which the app uses.)

## 5. PostgreSQL + Directus-per-app + Cloudflare Tunnel

What this gives the owner: **one PostgreSQL** (bound to 127.0.0.1, never reachable from
anywhere else), the **personal Directus** over Tailscale (port 8055, unchanged), and **one
Directus per public app** — `fam` and `ai` to start — each with its **own database, own
login role, own users, own files and own admin**, published at `https://api.fam.xgold.tech`
and `https://api.ai.xgold.tech` through a **Cloudflare Tunnel**. The bare `fam.xgold.tech` /
`ai.xgold.tech` names stay the apps' **front-ends** (GitHub Pages today) — the convention is
`<app>` = site, `api.<app>` = that app's Directus. Nothing is port-forwarded on the
router: `cloudflared` makes outbound connections to Cloudflare, Cloudflare terminates TLS
and routes each hostname to the right container. Apps use Directus's auth, REST/GraphQL,
realtime and files like they would use Supabase; they never see the database port.

### 5.0 Before you start

- The domain (`xgold.tech`) must use **Cloudflare DNS** (nameservers at Cloudflare; the free
  plan is enough) and the account needs **Zero Trust** activated (free for up to 50 users).
  As of 2026-10-20 neither is done yet — § 5.0a is the one-time cutover.
- Pick data folders outside the source checkout and create them:
  ```bash
  sudo mkdir -p /srv/homelab/pgdata /srv/homelab/apps /var/backups/postgres
  sudo chown -R homelab:homelab /srv/homelab/apps /var/backups/postgres
  ```
  (`pgdata` is owned by the postgres container itself.)
- Check nothing already uses the ports: `ss -ltnp | grep -E ':(5432|805[5-7]|2000)\b'`.

### 5.0a Move `xgold.tech`'s DNS from Squarespace to Cloudflare (one-time)

State found on 2026-10-20 in the owner's logged-in Cloudflare and Squarespace accounts:

- The domain is **registered at Squarespace** (active until 2029-06-08) and Squarespace still
  **serves its DNS** (`nsa1-4.squarespacedns.com`) with **DNSSEC on**.
- The Cloudflare account already holds the zone `xgold.tech` (Free plan), status **Pending
  nameserver update**, assigned `robin.ns.cloudflare.com` and `rory.ns.cloudflare.com`.
- Cloudflare's automatic import copied 11 of the 13 live records and got the proxy status
  wrong: `mc` (Minecraft) came in **Proxied**, which would break the game server the moment
  the nameservers switch; `api.fam`, `streaming` and `fam` were not copied at all.
- Zero Trust is **not** activated yet. Activation (Free, $0) asks for a payment method, a
  billing address and the Terms of Service — an owner-only step.

Do these in order; visitors notice nothing until step 3, and nothing at all if step 1 is exact.

1. **Make the Cloudflare zone identical to Squarespace.** Cloudflare → `xgold.tech` → DNS →
   Records. Cleanest: delete the 11 imported records, then **Import** `deploy/dns/xgold.tech.zone`
   with *Proxy imported records* **unchecked**. By hand instead: switch `mc`, the four `@` A
   records and `www` to **DNS only** (grey cloud); add `A api.fam → 99.116.141.110`,
   `A streaming → 99.116.141.110` and `CNAME fam → cartergloyd.github.io` (DNS only); delete
   `_domainconnect` (it only works while Squarespace serves DNS). End state: **13 records, none
   proxied** — `mc` and `streaming` carry TCP/UDP services the Cloudflare proxy cannot pass.
2. **Turn DNSSEC off at Squarespace** (Domains → `xgold.tech` → DNS → DNSSEC → toggle off) and
   wait until the `.tech` registry has dropped the DS record:
   ```bash
   dig +short DS xgold.tech @1.1.1.1      # must print NOTHING before step 3 (can take up to 24 h)
   ```
   Skipping this makes every validating resolver answer SERVFAIL for the whole domain after
   the switch — site, Minecraft and apps all vanish until the stale DS expires.
3. **Switch the nameservers**: Squarespace → Domains → `xgold.tech` → DNS → Domain Nameservers
   → *Use custom nameservers* → `robin.ns.cloudflare.com` and `rory.ns.cloudflare.com`, remove
   the four `squarespacedns.com` entries, save. Cloudflare's overview turns **Active** within
   minutes to a few hours (it also e-mails).
4. **Verify nothing moved but the nameservers:**
   ```bash
   dig +short NS xgold.tech                        # robin/rory.ns.cloudflare.com
   dig +short mc.xgold.tech                        # 99.116.141.110 — NOT a 104.x / 172.6x Cloudflare address
   dig +short SRV _minecraft._tcp.mc.xgold.tech    # 0 5 25565 mc.xgold.tech.
   dig +short fam.xgold.tech www.xgold.tech        # cartergloyd.github.io + GitHub's 185.199.x
   curl -sI https://fam.xgold.tech | head -1       # the GitHub Pages site still answers
   ```
   `npm run audit:install` → `[dns]` repeats this from the server (nameservers, DNSSEC
   consistency, proxied-vs-DNS-only per hostname) and fails on exactly the `mc`-proxied mistake.
5. **Activate Zero Trust** (owner): Cloudflare → Zero Trust → *Zero Trust Free* → payment
   method + billing address + Terms ($0 due). Team name `xgold` → `xgold.cloudflareaccess.com`
   becomes the Access login page. Then continue with § 5.2.
6. **Optional, later:** enable DNSSEC in Cloudflare (DNS → Settings) and paste its DS record at
   Squarespace; proxy `@` / `www` / `fam` (orange cloud) with SSL/TLS mode *Full*.

### 5.1 Compose environment

```bash
cd /opt/homelab-dashboard && sudo cp .env.example .env && sudo chmod 600 .env && sudo nano .env
```

Fill every `CHANGE-ME` (`openssl rand -hex 32` for each secret/password — hex only, so no
quoting issues), set `PGDATA_DIR`, `APPS_DATA_DIR`, `PUBLIC_DOMAIN=xgold.tech`, `APPS=fam,ai`,
the admin e-mails, and leave `CLOUDFLARE_TUNNEL_TOKEN` for the next step. One
`APP_<NAME>_DB_PASSWORD` / `_SECRET` / `_ADMIN_*` group per app.

### 5.2 Create the tunnel and its hostnames (Cloudflare dashboard)

1. Zero Trust (`one.dash.cloudflare.com`) → **Networks → Tunnels → Create a tunnel →
   Cloudflared**, name it `homelab`.
2. On "Install and run a connector" choose **Docker** and copy **only the token** — the long
   string after `--token` — into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`. Do not run their
   command; compose runs the connector (on the host network, so it reaches the loopback ports).
3. **Public Hostname** tab → Add: subdomain `api.fam`, domain `xgold.tech`, type **HTTP**, URL
   `127.0.0.1:8056`. Add another: `api.ai` → `127.0.0.1:8057`. Cloudflare creates a proxied
   CNAME per hostname. If `api.fam` still has the A record from § 5.0a, delete that record
   first — Cloudflare refuses to add a hostname over an existing record.
4. Do **not** add `fam` / `ai` themselves — those are the apps' front-ends (GitHub Pages). The
   dashboard's own hostname (`dash` → `127.0.0.1:3000`) belongs to issue #10: add it only once
   that PR's Access-token validation is deployed (until then the dashboard answers 401 to
   anything arriving through the tunnel anyway).

### 5.3 Start and verify

```bash
sudo docker compose up -d && sudo docker compose ps
sudo docker logs homelab-cloudflared 2>&1 | grep -i "registered tunnel connection" | head -4   # expect 4 lines
curl -s https://api.fam.xgold.tech/server/health ; echo                                    # {"status":"ok"}
curl -s https://api.ai.xgold.tech/server/health ; echo
sudo ss -ltnp | grep -E ':(5432|805[67]|2000)\b'                                           # every line 127.0.0.1 (acceptance criterion 3)
```

Open `https://api.fam.xgold.tech/admin`, sign in with `APP_FAM_ADMIN_*`, change the password,
create the first collection and a role for app users. Same for `ai`. The personal Directus
is still `http://<tailscale-name>:8055` only.

Postgres init runs **once**, on an empty `PGDATA_DIR` — it creates the `fam` and `ai`
roles/databases from `APPS`. If you add names to `APPS` later, run
`scripts/add-app.sh <name>` instead (idempotent; also prints the compose block, hostname and
dashboard env to paste).

### 5.4 Protect the admin UIs (recommended)

Zero Trust → **Access → Applications → Add → Self-hosted**: domain `api.fam.xgold.tech`, path
`admin*` → policy "Allow" for the owner's e-mail(s) with One-time PIN (or Google). Repeat for
`api.ai`. The API paths stay reachable for the apps; only the admin panel gets a login wall. The
dashboard shows "behind Cloudflare Access" for the public check when this is on. Each
Directus also runs with the rate limiter on, secure cookies, and CORS limited to the app's
site origin (`https://fam.xgold.tech`; `APP_<NAME>_CORS_ORIGIN` to add more, e.g. a dev origin).

### 5.5 Backups of every database

`scripts/pg-backup.sh` dumps each database (personal, fam, ai, …) with `pg_dump` inside
the container to `PG_BACKUP_DIR` and keeps `PG_BACKUP_KEEP` days. Schedule it from the
dashboard: copy it into `SCRIPTS_DIR`, set `COMPOSE_ENV=/opt/homelab-dashboard/.env`,
`PG_BACKUP_DIR` and `PG_BACKUP_KEEP` in the dashboard env, then Minecraft → Maintenance →
New job → **Run a script** → `pg-backup.sh`, daily at 04:30. Output lands in Live server
alerts; the Database tab shows the newest dump per app and the audit warns when one is older
than 48 h.

### 5.6 Dashboard env (`/etc/homelab-dashboard.env` or the real env file)

```
PG_URL=postgres://homelab:<POSTGRES_PASSWORD>@127.0.0.1:5432/personal
APPS=fam,ai
PUBLIC_DOMAIN=xgold.tech
PG_BACKUP_DIR=/var/backups/postgres
COMPOSE_ENV=/opt/homelab-dashboard/.env
```

Restart the dashboard. **Database & apps** must show: PostgreSQL connected with the
"127.0.0.1 only" pill, the tunnel connected with both hostnames, and a green card per app
(Directus healthy, public HTTPS ok, database present, users, backup). `npm run audit:install`
→ `[apps]` and `[dns]` all ✔ (5432 loopback-only, each app's container/health/database, Cloudflare
nameservers, a consistent DNSSEC state and a non-proxied Minecraft record are gates).

### 5.7 Connecting an app

```ts
import { createDirectus, authentication, rest, realtime } from "@directus/sdk";
const fam = createDirectus("https://api.fam.xgold.tech").with(authentication()).with(rest()).with(realtime()); // called from the site at https://fam.xgold.tech (CORS already allows it)
await fam.login({ email, password });            // users you created in fam's admin
const items = await fam.request(readItems("chores"));
```

Give each app's users a role whose policies restrict them to their own rows (Directus
permissions with `$CURRENT_USER` filters) — that is the Supabase row-level-security
equivalent here.

## 6. Configure and start the dashboard

```bash
sudo cp deploy/homelab-dashboard.env.example /etc/homelab-dashboard.env && sudo chown root:homelab /etc/homelab-dashboard.env && sudo chmod 0640 /etc/homelab-dashboard.env && sudo nano /etc/homelab-dashboard.env
```

Fill in: `JELLYFIN_API_KEY`, `JELLYFIN_CONTAINER`, `MEDIA_ROOTS`, `MC_DIR`,
`MC_SERVICE`, `RCON_PASSWORD`, `PG_URL` (same credentials as compose `.env`),
the three `*_PUBLIC_URL`/`MC_PUBLIC_ADDRESS` values with the server's Tailscale
name, `ALLOWED_LOGINS`, and `TZ`.

```bash
sudo cp deploy/homelab-dashboard.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now homelab-dashboard && systemctl status homelab-dashboard
```

Verify locally (auth will refuse direct requests, which is correct — only the
Tailscale proxy may talk to it):

```bash
curl -i http://127.0.0.1:3000/api/health
```

Expect `401` with `"No Tailscale identity on this request"`. A `200` here means
`AUTH_DISABLED` is set — remove it.

## 6b. Live Server Alerts, scripts and agents

**Dashboard key.** Generate one and put it in `/etc/homelab-dashboard.env` as `DASHBOARD_KEY`:

```bash
openssl rand -hex 24
```

It is a password for the dashboard's own API (scripts, the MCP connector). It is **not**
an Anthropic/OpenAI key and costs nothing.

**Scripts folder.** Move the owner's Python/shell maintenance scripts (restart, backup, …)
into `SCRIPTS_DIR` (default `/opt/homelab-scripts`):

```bash
sudo mkdir -p /opt/homelab-scripts && sudo chown homelab:homelab /opt/homelab-scripts
```

They run as the `homelab` user. If a script needs root (e.g. `systemctl` for other units),
add an exact-argument rule for it to `/etc/sudoers.d/homelab` rather than running the
dashboard as root. Scripts that still get launched from a terminal can be wrapped so their
output lands in the feed:

```bash
sudo install -m 0755 scripts/hl-run.sh /usr/local/bin/hl-run
```

Then `HOMELAB_KEY=… hl-run python3 /opt/homelab-scripts/backup_world.py` (set `HOMELAB_URL`
too when not on the server; it defaults to `http://127.0.0.1:3000`).

**Alert rules.** Keyword rules live in `/opt/homelab-dashboard/data/alert-rules.json`
(created on first start, hot-reloaded on edit). Three lists: `error`, `warn`, `maintenance`.

**Connect a terminal agent (MCP).** The owner runs Claude Code / Codex in a terminal on
their existing subscription; no API keys. Register the connector once per machine:

```bash
claude mcp add homelab -e HOMELAB_URL=http://127.0.0.1:3000 -e HOMELAB_KEY=<DASHBOARD_KEY> -- node /opt/homelab-dashboard/server/dist/mcp.js
```

From the owner's Mac over the tailnet use `HOMELAB_URL=https://<server>.<tailnet>.ts.net`
and either clone the repo there too or wrap the command as
`ssh <server> node /opt/homelab-dashboard/server/dist/mcp.js`.

Codex CLI (syntax per the official MCP page, developers.openai.com/codex/mcp):

```bash
codex mcp add homelab --env HOMELAB_URL=http://127.0.0.1:3000 --env HOMELAB_KEY=<DASHBOARD_KEY> -- node /opt/homelab-dashboard/server/dist/mcp.js
```

or the equivalent block in `~/.codex/config.toml` (`codex mcp list` / `codex mcp get homelab` to check):

```toml
[mcp_servers.homelab]
command = "node"
args = ["/opt/homelab-dashboard/server/dist/mcp.js"]
env = { HOMELAB_URL = "http://127.0.0.1:3000", HOMELAB_KEY = "<DASHBOARD_KEY>" }
```

Running `claude` inside `/opt/homelab-dashboard` picks the connector up automatically from
`.mcp.json` (export `HOMELAB_KEY` first).

The connector's tools can restart Minecraft, run scripts and edit `CLAUDE.md` — that is the
owner's explicit choice. Every call is attributed in the alerts feed and the Assistant widget.

**Assistant sidecar (issue #5).** The Assistant panel on the Minecraft tab can run the
agent *for* the owner: new errors, failed jobs/scripts and repeated warnings become
incidents, and the sidecar launches the chosen CLI headlessly on the server, one incident at
a time, with the owner's approval required before restart/stop/destructive RCON. For that
to work on the server:

1. Install the CLI **for the service user** and log it in once (interactive):
   `sudo -u homelab -H codex login` (or `claude` once and sign in). Codex is the default;
   switch in Settings & connect. The CLI must be on the unit's PATH — add
   `Environment=PATH=/usr/local/bin:/usr/bin:/bin:<folder>` to `homelab-dashboard.service`
   if `which codex` says somewhere else. The panel shows "not on the dashboard's PATH" with
   the exact path list when this is wrong.
2. Codex is launched as `codex exec --json -C "<MC_DIR>" --sandbox workspace-write
   --skip-git-repo-check <prompt>` and resumed with `codex exec resume --json <thread_id>
   <prompt>`; Claude Code as `claude -p --output-format stream-json --verbose
   --permission-mode bypassPermissions --mcp-config data/sidecar-mcp.json [--resume <id>]`.
   **Verify `codex exec --help` on the installed version**: if `--json` or `resume` is
   missing, remove them in `services/agentRunner.ts` `commandFor()` — plain-text output
   still streams into the feed; only the tidy conversation and session resume are lost.
3. Turn it on in the panel (Settings & connect → "Assistant on"). Settings live in
   `data/sidecar.json`; incidents in `data/incidents.json`; approvals in
   `data/approvals.json`; the conversation in `data/sidecar-conversation.jsonl`. The agent's
   workspace is `MC_DIR`.
4. Test: in Settings → "Run a one-off task now" with a harmless task ("list the players and
   file a short report"). The panel should show the agent's messages, the feed its tool
   calls, and a report should appear on the Dashboard with the incident/run link.

Smoke test from the server: `cd /opt/homelab-dashboard/server && HOMELAB_KEY=… node test-mcp.mjs`.

## 6c. Scheduled jobs (Minecraft → Maintenance)

Jobs are **data, not code**: `/opt/homelab-dashboard/data/jobs.json`, edited through the
Maintenance card (create / edit / enable / disable / delete / Run now). Run history is in
`data/job-runs.json` (last 200). Times use the `TZ` in `/etc/homelab-dashboard.env`.

A non-demo install starts with **zero jobs** (nothing is seeded; issue #2). Five job
types exist: `backup` (RCON `save-off` → `save-all flush` → tar the worlds into
`BACKUP_DIR` → `save-on`, retention only over backups the dashboard made), `restart`
(in-game countdown → `save-all` → `systemctl restart`, skips if players are online),
`command` (one RCON command), `script` (runs a file from `SCRIPTS_DIR`, output into the
alerts feed) and `external` (**mirror only** — something cron or a systemd timer already
runs; the dashboard never runs it, just marks the feed when it is due and checks that
output arrived). On this server everything that matters is `external`.

**The owner's instruction for this install: the live server already restarts and backs up
on a semi-weekly schedule (systemd timers + Python scripts), and that must keep working
exactly as it does. Do not delete, move or re-time those timers.** A non-demo install
starts with **zero** jobs; make the dashboard *reflect* reality with the tools:

1. **Discover.** `npm run discover` (= `audit:install --propose`) finds the real
   schedule and prints what to configure, without changing anything:
   - **systemd timers** (`systemctl list-timers`, JSON or text on old systemd): each
     relevant timer's `OnCalendar` is translated to cron and **verified against
     systemd's own next-elapse time** — a translation that disagrees is flagged "set by
     hand" instead of being trusted. The service's `ExecStart` (via `systemctl cat`, so
     quoting survives) becomes the displayed command and the script name to watch for.
   - **crontabs**: `crontab -l` for the service user, `/etc/crontab`, `/etc/cron.d/*`,
     and — through `sudo -n crontab -l -u <user>` — root's and the Minecraft folder
     owner's. Only Minecraft-looking lines (backup / restart / update / world / the
     server folder) are kept. If sudo refuses, the audit says so and names the command
     to run by hand.
   - **script folders** (where the timer/cron commands' `*.py`/`*.sh` actually live) and
     **backup roots** (folders holding `mcworld_YYYY_MM_DD/`, `mc-*.tar.gz` or
     world/minecraft archives, searched under the Minecraft folder, `/home`, `/mnt`,
     `/media`, `/srv`, `/opt`, `/var/backups` and any path the scripts mention).
   Output: a "Proposed /etc/homelab-dashboard.env changes" block (`SCRIPTS_DIR`,
   `BACKUP_DIR`, `BACKUP_FORMAT`, `BACKUP_METHOD=script:<name>` when a backup script was
   found) and one proposed `external` mirror job per timer / cron line with the real
   name, schedule, command, script and — for cron — the exact wrapped line to paste.
2. **Review, then apply.** Put the env suggestions in `/etc/homelab-dashboard.env`
   (restart the dashboard), fix any schedule marked "set by hand", then
   `npm run discover -- --apply` creates the mirror jobs in the running dashboard. They
   are display-only: the dashboard never runs them, it marks "Due now" in the feed and
   checks the output arrived.
3. **Install hl-run and wrap the real jobs** so their output and exit code reach the feed:
   ```bash
   sudo npm run wrap-service -- --install-hl-run      # /usr/local/bin/hl-run + /etc/homelab-hl-run.env (URL + key only, 0600)
   sudo npm run wrap-service -- <unit>.service --apply --test    # once per timer-backed service
   ```
   The drop-in prefixes the original `ExecStart` with hl-run (quoting preserved from
   `systemctl cat`, so paths with spaces survive), reloads systemd, and `--test` proves a
   test event reaches the feed *using only the env file*, exactly as the unit will. The
   timer and schedule are untouched. For a **cron** line, paste the wrapped line that
   `discover` printed (`… /usr/local/bin/hl-run <original command>`) into that crontab;
   if the crontab belongs to a user other than root, make `/etc/homelab-hl-run.env`
   readable to them (`chown root:<user>`, `chmod 0640`) or put `HOMELAB_KEY=…` at the top
   of the crontab. Until this is done the job row says "Output not tracked — wrap with
   hl-run" and the audit fails that job.
4. **Point the dashboard at the real folders** if step 2 did not already: `SCRIPTS_DIR`
   (comma-separated), `BACKUP_DIR` (where the existing `mcworld_YYYY_MM_DD/` folders are),
   and if "Back up now" should run the owner's own script, `BACKUP_METHOD=script:<name>`
   (the script must be in `SCRIPTS_DIR`). Otherwise `BACKUP_FORMAT=dated-folder` makes the
   built-in backup write the same layout. The built-in backup reads `level-name` from
   `server.properties`, so a world not called `world` needs no configuration.
5. **Audit.** `npm run audit:install` must end with `FULLY CONNECTED`. It gates on: env
   sane (no DEMO, real key), unit + sudo rule, Docker + Jellyfin, RCON, Tailscale, scripts
   folders exist, backup roots exist, no demo data, every relevant timer **and cron entry**
   mirrored, each timer mirror's cron expression agreeing with systemd's next run, output
   tracking connected for every mirror, hl-run installed, and a live alerts-ingestion test.
   Record what you found in `CLAUDE.md` → Decisions log.

Verify in the UI: the Dashboard's "Next scheduled job" tile shows the next real timer
time; the Maintenance table shows each mirror with its timer name and a green "Output
tracking connected" pill; when the timer fires, the feed shows `Due now: "…"`, the
script's lines, `✔ … exited 0`, and the job's last run reads `OK — Ran via systemd timer`.
`Run now` is intentionally absent for external jobs.

## 6c½. Paths with spaces

The owner's Minecraft folder is `/home/gold/Minecraft Server`. Everything accepts spaces
if you quote in the right place:

- Env file: `MC_DIR="/home/gold/Minecraft Server"` and for lists
  `SCRIPTS_DIR="/home/gold/Minecraft Server/scripts,/opt/other-scripts"` (quote the whole
  value; systemd `EnvironmentFile=` strips the outer quotes).
- Shell: `hl-run python3 "/home/gold/Minecraft Server/backup.py"`.
- systemd `ExecStart=`: `ExecStart=/usr/bin/python3 "/home/gold/Minecraft Server/backup.py"`.
  `wrap-service` preserves this quoting because it reads `systemctl cat`, not `systemctl show`.
- The dashboard itself never splits paths on spaces (only on commas for lists) and passes
  them to `tar`, `du`, `python3` as single arguments.

## 6e. Tools (run from /opt/homelab-dashboard)

| Command | What it does |
|---|---|
| `npm run audit:install` | Production audit; `FULLY CONNECTED` only when all gated checks pass. `-- --json` for agents. Exit 1 on failure. |
| `npm run discover` | Audit + discovery: systemd timers, crontabs, script folders, backup roots → proposed env values and `external` mirror jobs (cron translations verified against systemd). `-- --apply` creates the jobs. |
| `npm run clear-demo-data` | Dry run listing seeded jobs/runs, the demo folder and demo reports; `-- --yes` removes them. Never touches user data. |
| `npm run wrap-service -- --install-hl-run` | (root) Installs `/usr/local/bin/hl-run` and writes `/etc/homelab-hl-run.env` (dashboard URL + key only). |
| `npm run wrap-service -- <unit>` | Prints the hl-run drop-in for a service; `--apply` (root) writes + reloads; `--test` sends a test event through hl-run the way cron/systemd would (env file only). |
| `node server/test-discover.mjs` | Unit checks for the schedule translation / crontab parsing used by `discover`. |

All read `/etc/homelab-dashboard.env` (override with `--env FILE`). None of them ever
edits a timer, a crontab or a script — they print; you apply.

## 6f. Storage explorer (System → Storage)

The TreeSize-style view is fed by a **real scanner**, not by the dashboard crawling the
disk itself:

```bash
sudo apt install ncdu          # preferred: documented JSON export, file ages + owners
# or: sudo apt install gdu     # faster parallel scanner, same export format (no ages/owners)
```

`services/diskscan.ts` runs `ncdu -x -e -0 --exclude-kernfs -o - <root>` (or `gdu -n -p -x
-o -`, or `du -x -a` if neither is installed) for every mounted filesystem from `df`, parses
the export as a stream, and keeps the folder tree, the largest files per folder and
type/age/owner statistics for the top three levels in memory and under `data/diskscan/`.
Browsing is instant; scans run one at a time in the background and repeat every
`DISK_SCAN_INTERVAL_HOURS` (default 24; 0 = only on request). Env:

| Variable | Meaning |
|---|---|
| `DISK_SCANNER` | `auto` (ncdu → gdu → du), or force `ncdu` / `gdu` / `du` |
| `DISK_SCAN_ROOTS` | folders to scan, comma-separated (default: every `df` mount) |
| `DISK_SCAN_INTERVAL_HOURS` | automatic re-scan period |
| `DISK_SCAN_EXCLUDE` | extra exclude patterns (ncdu `--exclude`, gdu `--ignore-dirs-pattern`, du `--exclude`) |

Folders the service user cannot read are flagged (`read_error`) and their size is a
lower bound; the usual gap is `/var/lib/docker` and other users' home folders. Do **not**
add a sudo rule for the scanner to close that gap — ncdu can spawn a shell and `find -exec`
is code execution; if the owner wants the full picture, add the service user to the
groups that own those folders. `npm run audit:install` reports which engine is present
(`[storage] disk scanner`). Verify in the UI: the engine badge shows `ncdu <version>`,
a scan of `/` finishes, and drilling into `/home/gold/Minecraft Server` shows the worlds.
The "Reclaimable space" card never deletes anything: each line carries the command to run
by hand (or to hand to an agent).

## 6g. Staged update widget (Minecraft tab)

Read-only view of Paper and every plugin: **installed** (version from each jar's
`plugin.yml`, date = jar file date), **staged** (jars waiting in the staging folder that
the owner's update-fetch job fills), and **latest upstream** with release dates (PaperMC
API for Paper builds; Modrinth, Hangar or GitHub for plugins). It never downloads or
applies anything — the existing update + restart timer does. Configure:

| Variable | Meaning |
|---|---|
| `UPDATE_STAGING_DIR` | `[INSTALLER]` where the fetch job puts new jars. Unset = look for `plugins/update` (Bukkit applies it on restart), `updates`, `staged`, `staging` under `MC_DIR`. Read the fetch script to find the real folder. |
| `PLUGIN_SOURCES` | per-plugin upstream, e.g. `EssentialsX=modrinth:essentialsx,Chunky=hangar:pop4959/Chunky,Vault=github:MilkBowl/Vault,GoldsPlugin=none`. Unlisted plugins are searched on Modrinth by exact name. |
| `UPDATE_CHECK` | `0` disables all upstream lookups (air-gapped / privacy). |

The panel's "Applied by" line is the dashboard job (the mirrored update/restart timer)
that runs next; if it says none, the mirror from § 6c is missing. Verify: installed Paper
shows the build from the jar name, each plugin shows a version, and anything in the
staging folder appears in the Staged column.

## 6d. VPN tab

The owner runs a VPN on this server with split-tunnel exceptions (at least Minecraft and
Jellyfin bypass it). **Which VPN software, and how the exceptions are implemented, is
unknown** — the VPN page is built to probe and will say "Unknown" where it cannot see.
Make it accurate:

1. Identify the client: `which mullvad nordvpn protonvpn-cli protonvpn expressvpn wg openvpn`,
   `ip -d link` (look for `wireguard` / `tun` interfaces that are not `tailscale0`),
   `systemctl list-units | grep -i -E "vpn|wg-quick|openvpn"`. Set `VPN_PROVIDER` and
   `VPN_INTERFACE` in `/etc/homelab-dashboard.env`; set `VPN_LAN_INTERFACE` to the
   physical NIC (`ip route show default` when the VPN is down).
2. Grant read-only inspection in `/etc/sudoers.d/homelab` (uncomment the matching lines in
   `deploy/sudoers-homelab`): `wg show all dump` for handshake/endpoint/transfer, and
   `nft list ruleset` or `iptables -t mangle -S` so port-based bypass rules are detected.
3. Find how the exceptions are done today: `ip rule show` (fwmark rules), the firewall
   mangle table (marks on `--sport 25565` / `8096`), the provider's own allowlist
   (`nordvpn settings`, `mullvad split-tunnel …`), or a per-user routing table. If the
   dashboard cannot see them, declare them: `VPN_EXCEPTIONS=Minecraft=25565/tcp,Jellyfin=8096/tcp`.
   Record the mechanism in `CLAUDE.md` → Decisions log.
4. **Check Tailscale is outside the VPN.** The dashboard, Directus and remote SSH all ride
   on Tailscale; a VPN kill switch that blocks `tailscale0`, UDP 41641 or `100.64.0.0/10`
   takes them all down. Verify from another tailnet device that the dashboard stays
   reachable with the VPN connected *and* right after a VPN reconnect.
5. Geolocation: the page calls `VPN_GEO_URL` (default ipinfo.io) once per IP, cached an
   hour. It sends only the IP being looked up. If the owner prefers no third-party calls,
   point it at a self-hosted service or leave the fields showing "–".

Verify: VPN page shows Connected, an exit location that is **not** the home city, the
endpoint's datacenter, a recent handshake, and the traffic map marks Minecraft, Jellyfin
and Tailscale as *Bypasses VPN* with no red "exception missing" pill.

## 7. Expose over Tailscale (HTTPS + identity)

```bash
sudo tailscale serve --bg 3000
```

Then from a tailnet device open `https://<server-name>.<tailnet>.ts.net`. The sidebar
footer shows the signed-in Tailscale user. `curl -I` of that URL from a tailnet
device returns **200** (acceptance criterion 1). Do **not** use `tailscale funnel`;
the app refuses Funnel requests by design.

Optional: `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8055` gives
Directus HTTPS too (then set `DIRECTUS_PUBLIC_URL` accordingly).

## 8. Firewall

```bash
sudo ufw default deny incoming && sudo ufw allow in on tailscale0 && sudo ufw allow OpenSSH
```

Only if players join Minecraft from the public internet: `sudo ufw allow 25565/tcp`.
Then `sudo ufw enable`. Confirm from a non-tailnet device that ports 3000, 8055 and
5432 are **not** reachable.

## 8b. Router settings (suggestions)

The database platform needs **no port forwarding at all** — the tunnel only makes outbound
HTTPS connections to Cloudflare. Recommended home-router settings:

| Setting | Recommendation | Why |
|---|---|---|
| Port forwards for 5432, 8055–8057, 2000, 3000 | **None.** Remove any that exist. | Postgres, the app Directuses, cloudflared's metrics and the dashboard must stay unreachable from the internet; the tunnel and Tailscale carry everything. |
| Minecraft 25565/TCP → server | Keep as it is today. | Players join directly; the VPN's Minecraft exception is what makes this work. |
| Bedrock / Geyser 19132/UDP → server | Keep if Bedrock players join (the Geyser plugin is installed). | Geyser listens on UDP 19132 by default. |
| UPnP / NAT-PMP | **Off.** | Plugins, consoles and random devices can open ports silently; with UPnP off, only the forwards above exist. |
| DMZ host | **Off.** | Never put the server in the DMZ. |
| DHCP reservation for the server | **On** (fixed LAN IP, e.g. 192.168.1.10). | Forwards and Tailscale subnet routes break when the server's address changes. |
| Router admin from WAN | **Off**; change the default admin password; keep firmware updated. | Standard hygiene — the router is the only thing between the internet and the LAN besides Cloudflare/Tailscale. |
| IPv6 firewall | **On** (default deny inbound) if the ISP provides IPv6. | Inbound IPv6 bypasses NAT; the firewall must do the job NAT does for IPv4. |
| Tailscale | No forward needed. Optional: forward one UDP port and run `tailscaled` with `--port=<that port>` for more direct connections. | Tailscale traverses NAT by itself and falls back to relays; a fixed forwarded port avoids relays on strict NATs. |
| Local DNS filters (Pi-hole etc.) | Don't block `*.cloudflareaccess.com`, `*.argotunnel.com`, `*.cfargotunnel.com`, `region1.v2.argotunnel.com`, `api.cloudflare.com`. | cloudflared and Cloudflare Access use these. |
| Hairpin NAT / local overrides for `api.fam.xgold.tech` | Not needed. | From inside the house the apps still go out to Cloudflare and back through the tunnel, which works everywhere. |
| QoS | Optional: prioritise the server's Minecraft traffic. | Keeps gameplay smooth while backups or uploads run. |

The server-side VPN (split tunnel) is unaffected: cloudflared's outbound connections and
Tailscale work through it, and Minecraft/Jellyfin keep their existing exceptions (VPN tab).

## 9. Final checklist

- [ ] `https://<server>.ts.net` loads; every service on the **Service status** page is OK
- [ ] **Minecraft** page shows players and the live log; `list` works in the console
- [ ] **Maintenance → Back up now** creates a `.tar.gz` in `/var/backups/minecraft` and the job history shows OK
- [ ] **Media files** lists each root; a test upload appears and triggers a Jellyfin scan
- [ ] **Database** page shows Directus `ok` and Postgres connected
- [ ] `sudo ss -ltnp | grep 5432` shows `127.0.0.1` only (also 8056, 8057, 2000)
- [ ] `dig +short NS xgold.tech` → `robin`/`rory.ns.cloudflare.com`, Cloudflare's overview says **Active**, and `dig +short mc.xgold.tech` is still the home IP, not a Cloudflare address (§ 5.0a)
- [ ] `https://api.fam.xgold.tech/server/health` and `https://api.ai.xgold.tech/server/health` return ok from outside the house; `/admin` asks for the Cloudflare Access login; `https://fam.xgold.tech` still shows the GitHub Pages site
- [ ] **Database & apps** shows the tunnel connected and a green card per app; a dump exists for each database in `PG_BACKUP_DIR`
- [ ] No router port forwards exist for 5432, 8055–8057, 2000 or 3000 (§ 8b)
- [ ] **Minecraft → Live server alerts** shows Paper log lines; "Problems & maintenance" hides the routine ones
- [ ] Each script in `SCRIPTS_DIR` has a ▶ button and its output appears in the feed
- [ ] `node test-mcp.mjs` passes; the Assistant widget flips to "Connected · test-client"
- [ ] Owner's terminal `claude` (or `codex`) lists the `homelab` MCP tools
- [ ] **World backups** panel lists the existing `mcworld_…` folders (marked "existing") before any dashboard-made backup
- [ ] Every mirrored timer **and cron line** shows "Output tracking connected"; `npm run discover` proposes nothing new
- [ ] Assistant panel: runner shows as available; a one-off task produces messages in the panel and a report on the Dashboard; a restart attempt by the agent shows up as an approval request instead of restarting
- [ ] `npm run audit:install` ends with **FULLY CONNECTED**

## Troubleshooting

| Symptom | Fix |
|---|---|
| Minecraft shows "RCON authentication failed" | `RCON_PASSWORD` ≠ `rcon.password`; restart Paper after editing server.properties |
| Start/Stop/Restart returns "sudo: a password is required" | sudoers path mismatch — compare `which systemctl` with `deploy/sudoers-homelab` |
| Jellyfin logs/restart "not available" | `homelab` not in `docker` group, or wrong `JELLYFIN_CONTAINER`; re-login isn't needed for a service — restart it |
| Media files "Not found" on a root | path in `MEDIA_ROOTS` is the *container* path; use the host path from `docker inspect` |
| Backups "No world folders found" | `MC_DIR` wrong, or world named differently (`level-name` in server.properties); symlink it to `world` or fix `MC_DIR` |
| Dashboard 401 in browser | Opened via IP:3000 instead of the `tailscale serve` HTTPS address |
| Dashboard 403 | Login not in `ALLOWED_LOGINS` |
| Tailscale peers "unavailable" | `tailscale` CLI not on PATH for the service; `sudo ln -s $(which tailscale) /usr/bin/tailscale` |
| Script button missing | file must be `*.py` or `*.sh` directly in `SCRIPTS_DIR` and readable by `homelab` |
| MCP tools all fail with 401 | `HOMELAB_KEY` ≠ `DASHBOARD_KEY`, or `DASHBOARD_KEY` not set (service logs warn at start) |
| Alerts feed empty for Minecraft | `homelab` not in `systemd-journal` group, or wrong `MC_SERVICE` unit name |

## Operating notes

- Logs: `journalctl -u homelab-dashboard -f`
- Update: copy new files, `npm ci && npm run build`, `systemctl restart homelab-dashboard`
- Job definitions: `/opt/homelab-dashboard/data/jobs.json` (editable while stopped; see § 6c). Deleting the file leaves zero jobs on next start — re-run `npm run discover -- --apply` to recreate the mirrors.
- Demo mode for testing on any machine: `DEMO=1 AUTH_DISABLED=1 npm start` — never set these on the server

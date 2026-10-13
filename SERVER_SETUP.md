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

## 5. PostgreSQL + Directus

```bash
cd /opt/homelab-dashboard && sudo cp .env.example .env && sudo nano .env
```

Fill every `CHANGE-ME` (`openssl rand -hex 32` for `DIRECTUS_SECRET`). Set
`DIRECTUS_PUBLIC_URL` to `http://<tailscale-name>:8055`. Then:

```bash
sudo docker compose up -d && sudo docker compose ps
```

Verify:
- `curl -s http://127.0.0.1:8055/server/health` → `{"status":"ok"}` (Directus takes ~20 s to boot)
- `sudo ss -ltnp | grep 5432` → shows **only** `127.0.0.1:5432` (acceptance criterion 3)
- Open `http://<tailscale-name>:8055` from a tailnet device and log in with `DIRECTUS_ADMIN_*`.

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

## 9. Final checklist

- [ ] `https://<server>.ts.net` loads; every service on the **Service status** page is OK
- [ ] **Minecraft** page shows players and the live log; `list` works in the console
- [ ] **Maintenance → Back up now** creates a `.tar.gz` in `/var/backups/minecraft` and the job history shows OK
- [ ] **Media files** lists each root; a test upload appears and triggers a Jellyfin scan
- [ ] **Database** page shows Directus `ok` and Postgres connected
- [ ] `sudo ss -ltnp | grep 5432` shows `127.0.0.1` only
- [ ] **Minecraft → Live server alerts** shows Paper log lines; "Problems & maintenance" hides the routine ones
- [ ] Each script in `SCRIPTS_DIR` has a ▶ button and its output appears in the feed
- [ ] `node test-mcp.mjs` passes; the Assistant widget flips to "Connected · test-client"
- [ ] Owner's terminal `claude` (or `codex`) lists the `homelab` MCP tools
- [ ] **World backups** panel lists the existing `mcworld_…` folders (marked "existing") before any dashboard-made backup
- [ ] Every mirrored timer **and cron line** shows "Output tracking connected"; `npm run discover` proposes nothing new
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

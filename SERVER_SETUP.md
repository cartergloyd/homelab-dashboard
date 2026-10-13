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
`ssh <server> node /opt/homelab-dashboard/server/dist/mcp.js`. For Codex, the equivalent is
`codex mcp add homelab …` or an `[mcp_servers.homelab]` block in `~/.codex/config.toml` —
**verify the exact syntax against the current Codex docs** before telling the owner it works.
Running `claude` inside `/opt/homelab-dashboard` picks the connector up automatically from
`.mcp.json` (export `HOMELAB_KEY` first).

The connector's tools can restart Minecraft, run scripts and edit `CLAUDE.md` — that is the
owner's explicit choice. Every call is attributed in the alerts feed and the Assistant widget.

Smoke test from the server: `cd /opt/homelab-dashboard/server && HOMELAB_KEY=… node test-mcp.mjs`.

## 6c. Scheduled jobs (Minecraft → Maintenance)

Jobs are **data, not code**: `/opt/homelab-dashboard/data/jobs.json`, edited through the
Maintenance card (create / edit / enable / disable / delete / Run now). Run history is in
`data/job-runs.json` (last 200). Times use the `TZ` in `/etc/homelab-dashboard.env`.

On the very first start (no `jobs.json` yet) two jobs are seeded, **both disabled**:

| Seeded job | Type | Schedule | What it does |
|---|---|---|---|
| Nightly world backup | `backup` | 04:00 | RCON `save-off` → `save-all flush` → tar.gz `world*` into `BACKUP_DIR` → `save-on`; keeps the newest `BACKUP_KEEP` |
| Daily restart | `restart` | 05:00 | in-game countdown at 10/5/1 min → `save-all` → `systemctl restart`; skips if players are online |

Five job types exist: `backup`, `restart` (as above), `command` (one RCON command),
`script` (runs a file from `SCRIPTS_DIR`, output into the alerts feed) and `external`
(**mirror only** — something cron or a systemd timer already runs; the dashboard never
runs it, just marks the feed when it is due and checks that output arrived).

**The owner's instruction for this install: the live server already restarts and backs up
on a semi-weekly schedule, and that must keep working exactly as it does. Do not delete,
move or re-time those cron entries, and do not enable the seeded built-in jobs.** Make the
dashboard *reflect* reality instead:

1. Discover the real schedule. Check all of: `sudo crontab -l`, `crontab -l` as the owner
   and as the Minecraft user, `ls /etc/cron.d /etc/cron.weekly`, `systemctl list-timers`,
   and read the scripts themselves (one script may call another). Note the exact cron
   expressions, the exact commands, and which user runs them.
2. For each real job, create an `external` job in the dashboard with that cron expression,
   `managedBy` = `cron` (or `systemd timer`), `command` = the exact command for display, and
   `script` = the script's file name (e.g. `backup_world.py`) so the dashboard can confirm
   it ran. Create them in the Maintenance card (New job → External) or by `POST /api/jobs`:

   ```bash
   curl -s -X POST -H "Authorization: Bearer $DASHBOARD_KEY" -H 'Content-Type: application/json' \
     -d '{"name":"Semi-weekly world backup","type":"external","cron":"0 4 * * 0,3","enabled":true,"options":{"managedBy":"cron","command":"python3 /opt/homelab-scripts/backup_world.py","script":"backup_world.py","graceMinutes":20}}' \
     http://127.0.0.1:3000/api/jobs
   ```
   The cron expression above is a **placeholder** — use what `crontab -l` actually shows.
3. Wrap each cron command with `hl-run` so its output streams into the feed and the
   dashboard can mark the mirrored job OK / failed. Only the command changes, never the
   schedule — e.g. `0 4 * * 0,3  python3 /opt/homelab-scripts/backup_world.py` becomes
   `0 4 * * 0,3  HOMELAB_KEY=… /usr/local/bin/hl-run python3 /opt/homelab-scripts/backup_world.py`
   (or put `HOMELAB_KEY=…` at the top of the crontab). Keep the scripts where they are;
   `SCRIPTS_DIR` is only for scripts the dashboard itself should offer as ▶ buttons — copy
   or symlink them there if the owner wants manual runs too.
4. Delete the two seeded disabled jobs (or leave them disabled) and record what you found and
   did in `CLAUDE.md` → Decisions log.

Verify: the Dashboard's "Next scheduled job" tile shows the next real cron time; when the
cron fires, the feed shows `Due now: "…" runs outside the dashboard via cron`, then the
script's lines (via hl-run), then `✔ backup_world.py exited 0 (terminal)`, and the job's
last run reads `OK — Ran via cron: …`. If instead it reads `No output from … within N min`,
the cron entry is not wrapped with hl-run yet (or `HOMELAB_KEY` is missing in cron's env).
`Run now` is intentionally absent for external jobs; start them from cron/the shell.

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
- Job definitions: `/opt/homelab-dashboard/data/jobs.json` (editable while stopped; see § 6c). Deleting the file re-seeds the two disabled defaults on next start.
- Demo mode for testing on any machine: `DEMO=1 AUTH_DISABLED=1 npm start` — never set these on the server

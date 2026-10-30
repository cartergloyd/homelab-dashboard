# homelab-dashboard

One web UI, reachable only over Tailscale, for a home server running Jellyfin
(Docker), a Paper Minecraft server (native), and a personal Directus/PostgreSQL
database.

**Tabs:** Dashboard · Media (Jellyfin, files) · Database · Minecraft (server, live
alerts, assistant, maintenance) · System (status, storage, logs)

**Live Server Alerts** (Minecraft tab): the Paper log, scheduled jobs, your
maintenance scripts' output and agent actions in one feed, with a one-click
"Problems & maintenance" filter. **Assistant** panel: which terminal agent is
connected, what it did, the editable `CLAUDE.md` instructions with a change log,
and maintenance reports agents file for you to review.

**Agents:** the dashboard is an MCP server. Register it once in your terminal
Claude Code or Codex (Assistant settings has the command) and the agent can
read alerts, tail logs, send RCON, restart the service, run scripts, file reports
and update its own instructions — on your existing subscription, no API keys.
These tools are deliberately powerful; everything they do is attributed in the feed.

The dashboard assistant keeps its own conversation and runs one CLI job at a time.
Chat, incident investigations, and approval follow-ups resume that conversation;
editor sessions and external terminal agents remain separate. Use **Auto: on** to
investigate new problems, or pause it and keep chatting manually. **Stop job and
pause auto** cancels the worker and its child processes and clears queued launches.
Set `CODEX_MODEL` in the service environment to select an available Codex model
without changing your editor's CLI defaults. The panel shows the model; technical
connection details are tucked into Settings. The Incidents menu has short issue
summaries, Review for findings, and Revisit for owner feedback. Feedback stays
with that issue. Proposed lessons are only added to shared instructions after
the owner approves them in the review.

Minecraft player updates follow join/leave events in the existing log stream and
are pushed to open dashboards. Tabs share one player list and one authenticated
RCON connection; they do not each poll Minecraft. A startup read and a roughly
one-minute safety check catch missed log events. Failed connections retry no more
often than every 15 seconds during routine monitoring. Commands run immediately,
in order, and are never automatically replayed after a disconnect or timeout.

**Storage:** Connected drives lists physical disks and existing partitions even
when they are not mounted. Unmounted does not mean empty: used/free space and
files are unknown until the operating system mounts the filesystem. The explorer
scans mounted filesystems independently; the dashboard never mounts, formats, or
moves data automatically. Data drives mounted under `/run/media` are scannable;
other runtime and kernel directories stay blocked. An unavailable `lsblk` only hides the hardware inventory,
not the existing mounted-storage view.

Set optional `ROUTER_URL` to your router's local HTTP/HTTPS address to show a
**Router settings** shortcut in navigation. It opens the router's own login in a
new tab; it stores no router credentials and does not expose the router remotely.
The device opening the link must be able to reach that local address.

**Installing on the server:** follow [SERVER_SETUP.md](SERVER_SETUP.md). It is
written so another AI assistant can do it step by step. Start with
[CLAUDE.md](CLAUDE.md) for the why and the current roadmap.

## Try it anywhere (demo mode)

```bash
npm install && npm run build && npm run demo
```

Open http://127.0.0.1:3000. Demo mode fakes Docker, systemd, RCON, Tailscale and
Jellyfin so every page works on a laptop; the file manager and backups operate on
throwaway folders under `data/demo/`.

## Installing on a real server

`SERVER_SETUP.md` is the runbook. The tools that make it verifiable:

```bash
npm run audit:install        # FULLY CONNECTED only when every gated check passes
npm run discover             # find timers, crontabs, script folders, backup roots; propose env + mirror jobs
npm run discover -- --apply  # create the proposed external (mirror-only) jobs
npm run clear-demo-data -- --yes
sudo npm run wrap-service -- --install-hl-run                    # hl-run + /etc/homelab-hl-run.env
sudo npm run wrap-service -- mc-backup.service --apply --test    # route a timer's output into the feed
npm test                                                         # discovery + disk-scan unit checks, demo-index coverage
npm run demo:index                                               # list every [DEMO] tag (see DEMO_INDEX.md)
scripts/add-app.sh <name>                                        # new Directus-per-app database + the snippets to paste (SERVER_SETUP § 5)
scripts/pg-backup.sh                                             # dump every Postgres database to PG_BACKUP_DIR
```

## Development

**Security → Set up authenticator** adds a separate dashboard confirmation code for sensitive actions. Enrollment enables protection, shows eight single-use recovery codes, and requires a fresh code before restarts, deletion, assistant changes and risky approvals. Confirmation is bound to the exact action and browser session; read-only browsing and torrent-link submission stay available. See [dashboard authenticator setup and recovery](docs/DASHBOARD_STEP_UP.md).

The Dashboard and Media pages can submit magnet links and HTTP/HTTPS torrent download URLs directly to qBittorrent using **Add Torrent Link**. Set `QBITTORRENT_URL` to its server-side WebUI address; set `QBITTORRENT_USERNAME` and `QBITTORRENT_PASSWORD` if that connection requires login. The form uses the dashboard's existing authentication, supports adding paused, preserves qBittorrent's download destination, and records only the number of submitted links in the activity feed. The full qBittorrent WebUI shortcut remains a separate link.

```bash
npm run dev:server   # API on :3000 with tsx watch (demo + auth disabled)
npm run dev:web      # Vite on :5173, proxies /api and /ws to :3000
```

## Layout

```
server/   Express 5 + ws API. services/ holds one module per integration
          (docker, systemd, rcon, slp, jellyfin, directus, postgres, files,
          storage, tailscale, backups, scheduler, status, logs).
web/      Vite + React UI. pages/ has one file per page; components/ui.tsx has
          cards, tiles, meters, pills, dialogs and toasts.
deploy/   systemd units, sudoers rule, environment template.
scripts/  hl-run.sh — mirror a terminal command's output into the alerts feed.
server/src/mcp.ts    stdio MCP server (thin client over the REST API); .mcp.json registers it.
docker-compose.yml   PostgreSQL (127.0.0.1 only) + Directus.
```

## How access works

Optionally the dashboard is also published through the Cloudflare Tunnel behind Cloudflare
Access (GitHub login + 2FA); the dashboard verifies every such request's Access token itself
(SERVER_SETUP § 7b).

The server binds to `127.0.0.1:3000`. `tailscale serve` terminates HTTPS and
proxies to it, adding `Tailscale-User-Login`/`Tailscale-User-Name` headers (it
strips any such headers a client sends). The app trusts those headers only on
loopback connections, refuses Funnel requests, and optionally checks an
`ALLOWED_LOGINS` list. No passwords anywhere.

## Dash interface

The live dashboard uses Gold Server and xGold AI workspace navigation. Real service connections, preserved features, new Directus/terminal/repository controls, and rollback instructions are documented in [docs/DASH_REDESIGN.md](docs/DASH_REDESIGN.md). Production contains no preview sample data.

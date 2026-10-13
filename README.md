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
Claude Code or Codex (`Connect an agent` button has the command) and the agent can
read alerts, tail logs, send RCON, restart the service, run scripts, file reports
and update its own instructions — on your existing subscription, no API keys.
These tools are deliberately powerful; everything they do is attributed in the feed.

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
npm run discover -- --apply  # mirror existing systemd timers as external jobs
npm run clear-demo-data -- --yes
sudo npm run wrap-service -- mc-backup.service --apply --test
```

## Development

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

The server binds to `127.0.0.1:3000`. `tailscale serve` terminates HTTPS and
proxies to it, adding `Tailscale-User-Login`/`Tailscale-User-Name` headers (it
strips any such headers a client sends). The app trusts those headers only on
loopback connections, refuses Funnel requests, and optionally checks an
`ALLOWED_LOGINS` list. No passwords anywhere.

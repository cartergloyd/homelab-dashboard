# homelab-dashboard

One web UI, reachable only over Tailscale, for a home server running Jellyfin
(Docker), a Paper Minecraft server (native), and a personal Directus/PostgreSQL
database.

**Pages:** Dashboard · Jellyfin · Media files · Database · Minecraft · Maintenance
· Logs · Service status · Storage

**Installing on the server:** follow [SERVER_SETUP.md](SERVER_SETUP.md). It is
written so another AI assistant can do it step by step.

## Try it anywhere (demo mode)

```bash
npm install && npm run build && npm run demo
```

Open http://127.0.0.1:3000. Demo mode fakes Docker, systemd, RCON, Tailscale and
Jellyfin so every page works on a laptop; the file manager and backups operate on
throwaway folders under `data/demo/`.

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
docker-compose.yml   PostgreSQL (127.0.0.1 only) + Directus.
```

## How access works

The server binds to `127.0.0.1:3000`. `tailscale serve` terminates HTTPS and
proxies to it, adding `Tailscale-User-Login`/`Tailscale-User-Name` headers (it
strips any such headers a client sends). The app trusts those headers only on
loopback connections, refuses Funnel requests, and optionally checks an
`ALLOWED_LOGINS` list. No passwords anywhere.

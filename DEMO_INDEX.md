# Demo index — everything that is fake in `npm run demo`

Read this before installing on the real server. The dashboard has one demo switch,
`DEMO=1` (plus `AUTH_DISABLED=1` so a laptop browser is let in). With it, every
integration answers with made-up data so the whole UI can be exercised with no
Docker, systemd, Tailscale, Paper server or coding agent present. **None of the code
below runs when `DEMO` is unset.** Nothing in this list needs to be deleted — it is
guarded by `if (cfg.demo)` — but every row tells you what the real install must
provide instead, and how to prove the real thing is wired.

Conventions:

- A `[DEMO]` tag in a comment marks a demo-mode branch, fixture or UI element. List
  them all with `npm run demo:index`; `npm test` fails if a file with demo code is
  missing from this index.
- `[INSTALLER]` tags (see `SERVER_SETUP.md` § 0) are a different thing: *guesses about
  the real server* that run in production until corrected. Both lists must be worked.
- `npm run audit:install` refuses to say FULLY CONNECTED while `DEMO`/`AUTH_DISABLED`
  are set, while the demo key is in use, or while `data/demo/` or seeded jobs exist.
- `npm run clear-demo-data -- --yes` removes demo *data* that may have leaked into
  `DATA_DIR` (seeded jobs and runs, the `data/demo/` folder, demo reports, demo backup
  markers). It never touches user data.

## 1. The switch and the fixtures

`server/src/services/qbittorrent.ts` simulates connection status and acknowledges submissions in demo mode, without contacting qBittorrent. A real install sets `QBITTORRENT_URL` and submits links through the authenticated dashboard.

| Where | What is fake | Real install |
|---|---|---|
| `package.json` → `"demo": "DEMO=1 AUTH_DISABLED=1 node server/dist/index.js"` | the only way demo mode is turned on | run `npm start` / the systemd unit; never set `DEMO` or `AUTH_DISABLED` in the env file |
| `server/src/config.ts` → `DEMO`, `AUTH_DISABLED` flags; demo `DASHBOARD_KEY` = `demo-key-not-secret` when unset in demo | identity and API key | real `DASHBOARD_KEY` (`openssl rand -hex 24`); Tailscale identity headers |
| `server/src/index.ts` → `bootstrapDemo()` | creates `data/demo/` on boot | nothing; `data/demo/` must not exist (audit fails if it does) |
| `server/src/demo.ts` (whole file) | fixtures: fake media library, a Minecraft folder **with a space** (`data/demo/Minecraft Server`), dated `mcworld_…` backup folders, three sample Python scripts, a copy of `CLAUDE.md` for the instructions editor, fake players/peers/log lines/filesystems/VPN, an **ncdu-format disk export** of an imaginary disk, a fixed reclaimable-space list | the real folders via `MC_DIR`, `MEDIA_ROOTS`, `BACKUP_DIR`, `SCRIPTS_DIR`, `CONTEXT_FILE`; real tools |

## 2. Fake service answers (one `if (cfg.demo)` branch each)

| File | Fakes | Real integration it stands in for |
|---|---|---|
| `server/src/services/systemd.ts` | unit state and start/stop/restart of the Minecraft unit | `systemctl show`, `sudo -n systemctl …` with the sudoers rule |
| `server/src/services/rcon.ts` | RCON replies (`list`, `tps`, `say`…) | Source RCON to Paper (`RCON_HOST/PORT/PASSWORD`) |
| `server/src/services/slp.ts` | Server List Ping (version, MOTD, players) | TCP ping to `MC_HOST:MC_PORT` |
| `server/src/services/jellyfin.ts` | health, sessions, library counts | Jellyfin API with `JELLYFIN_API_KEY` |
| `server/src/services/directus.ts` | `/server/health` | the Directus container |
| `server/src/services/postgres.ts` | table counts, size | `PG_URL` on 127.0.0.1 |
| `server/src/services/docker.ts` | container state/logs/restart and `docker system df` numbers | Docker socket (`homelab` in the `docker` group) |
| `server/src/services/tailscale.ts` | self + peers | `tailscale status --json` |
| `server/src/services/vpn.ts` | VPN state, exit IP/location, traffic map | provider CLI / WireGuard / ip rule / geo probes (§ 6d) |
| `server/src/services/logs.ts` | synthetic log lines for every source (incl. "Can't keep up" warnings) | `journalctl -f`, container logs |
| `server/src/services/status.ts` | service state rollup for the Dashboard | the real probes above |
| `server/src/services/storage.ts` | `df` rows, managed-folder sizes, the reclaimable-space list | `df -kP`, `du`, `docker df`, `journalctl --disk-usage`, apt/snap/trash probes |
| `server/src/services/diskscan.ts` | the "demo" engine feeds the generated ncdu export (from `demo.ts`) to the **real** streaming parser | `ncdu -x -e -0 --exclude-kernfs -o -` (or `gdu -n -p -x -o -`, or `du -x -a`) on each mount — verify with `npm run audit:install` → `[storage] disk scanner` |
| `server/src/services/hostnames.ts` | fixed rows for xgold.tech — sites, APIs, dash, mc, streaming, a planned `crm` (`demo.hostnames()`) | the Cloudflare DNS API (`CLOUDFLARE_API_TOKEN`, read-only) or `deploy/dns/<domain>.zone`, live public DNS lookups, HTTPS probes and the Minecraft ping |
| `server/src/services/apps.ts` | fixed fam/ai/personal databases, tunnel state, loopback exposure (`demo.apps()`) | each app's Directus `/server/health` locally and via the tunnel, the app databases over `PG_URL`, `PG_BACKUP_DIR`, cloudflared's `/ready` endpoint, `ss -ltn` for port bindings |
| `server/src/services/updates.ts` | fixed Paper/plugin versions and dates (`demo.stagedUpdates()`) | jars in `MC_DIR` + `MC_DIR/plugins`, the staging folder (`UPDATE_STAGING_DIR`), PaperMC / Modrinth / Hangar / GitHub APIs |
| `server/src/services/scheduler.ts` → `defaultJobs()` | four seeded jobs, flagged `seeded: true` (two disabled built-ins, two external mirrors with made-up timer/cron) | **zero** jobs; `npm run discover -- --apply` mirrors the real timers/crontab |
| `server/src/services/reports.ts` | one seeded "(demo)" maintenance report | none; agents file real ones |
| `server/src/services/agentRunner.ts` → `runnerAvailable()` | reports the CLI as available | real `codex` / `claude` on the unit's PATH, logged in as the service user |
| `server/src/services/sidecar.ts` → `DEFAULTS()` (enabled in demo), `simulateAgent()`, `simulateIncident()` | the sidecar is **on** by default and a scripted fake agent answers incidents, asks for a restart approval and files reports | sidecar off until the owner enables it; the real CLI runs; `/api/sidecar/simulate` is refused |

## 3. Demo-only API and UI

| Where | What | Real install |
|---|---|---|
| `server/src/routes.ts` → `POST /api/sidecar/simulate` | injects a fake exception / warning / failed-job event | returns 403 unless `DEMO=1` |
| `web/src/components/AssistantWidget.tsx` → "Simulate incident" button | shown only when `/api/config` says `demo: true` | hidden |
| `web/src/App.tsx` → header shows "demo mode" instead of "over Tailscale" | the badge under the server name | shows "over Tailscale" |

## 4. Tooling that knows about demo mode

| Where | Role |
|---|---|
| `server/src/tools/audit-install.ts` | fails the `env` gate while `DEMO`/`AUTH_DISABLED`/demo key are set and the `data` gate while `data/demo/` or seeded jobs exist |
| `server/src/tools/clear-demo-data.ts` | removes leaked demo data from `DATA_DIR` (dry run by default) |
| `server/src/tools/demo-index.ts` | prints every `[DEMO]` tag and demo branch; `--check` enforces that this file lists each tagged file |
| `CLAUDE.md`, `SERVER_SETUP.md`, `README.md` | document the tags and the demo workflow |

## 5. How to prove the real thing replaced the fake

1. `grep -rn "DEMO" /etc/homelab-dashboard.env` (or the real env file) prints nothing.
2. `npm run audit:install` → FULLY CONNECTED. Every gated check corresponds to a row above.
3. The Minecraft tab shows the real `level-name` worlds, real players over RCON, and the
   feed shows Paper's journal lines — not the synthetic "Alex joined the game" loop.
4. System → Storage shows `engine: ncdu <version>` (or gdu) and a scan of the real mounts;
   the Dashboard's reclaimable total comes from Docker/journald, not the fixed list.
5. The Assistant panel shows the real runner as available and a one-off task produces
   messages from Codex/Claude Code, not lines prefixed "(demo)".

# homelab-dashboard — notes for AI sessions and humans

Read this first. It explains what the owner is trying to accomplish, how the code
is laid out, and what has been decided so you don't re-litigate it. Keep it
current: when you finish a roadmap step, tick it; when you make a decision that a
future session might undo by accident, add it to the decisions log.

## Purpose & owner intent

Carter runs one Linux home server with Jellyfin (Docker), a Paper Minecraft server
(installed natively, managed by systemd) and a personal PostgreSQL database with
Directus as its UI. This dashboard is the single place, reachable only over
Tailscale, to see and manage all of it.

The current focus is the **Minecraft tab**: make it a live operations view where

1. **everything flows through one feed** ("Live Server Alerts") — the Minecraft
   server log, scheduled jobs (backups, restarts), and the output of the Python
   maintenance scripts Carter used to run by double-clicking (they open Terminal
   and text flies by);
2. **one button filters out routine noise** and shows only problems (errors,
   warnings) and maintenance events (restarts, backups, job results);
3. **coding agents can act on what they see**: Carter's own terminal sessions of
   Claude Code and/or Codex connect to the dashboard through an MCP server and get
   tools to read alerts, tail logs, send RCON commands, restart the service, run
   the scripts and update their own instructions — with full autonomy, by his
   choice. Every agent action appears in the same feed;
4. an **Assistant widget** beside the feed shows which agent is connected, what it
   last did, and problem counts, with a button to view/edit this file and a change
   log of edits to it;
5. this file is the shared **instructions & context** for agents and sessions.

Costs matter to the owner: agents run on his existing Claude / Codex
subscriptions in his terminal. **No API keys and no per-token billing** are
required for anything in the roadmap. `DASHBOARD_KEY` is a locally generated
password for the dashboard's own API — not an Anthropic/OpenAI key.

## Architecture map

```
server/   Express 5 + ws, TypeScript (ESM, NodeNext → use .js import suffixes)
  src/index.ts        boot: demo bootstrap → scheduler → alerts hub → http + ws
  src/config.ts       zod-validated env → `cfg` (mutable; demo fills gaps)
  src/auth.ts         Tailscale identity headers (loopback only) + Bearer DASHBOARD_KEY
  src/routes.ts       all /api routes (one Router)
  src/ws.ts           /ws/logs (raw lines) and /ws/alerts (events)
  src/demo.ts         DEMO=1 fixtures + seeded demo dirs under data/demo/
  src/services/       one module per integration; each degrades to "unavailable"
    docker systemd rcon slp jellyfin directus postgres files storage tailscale
    backups scheduler status logs alerts scripts context
  src/mcp.ts          stdio MCP server — thin client over the REST API
web/      Vite + React 18 + TS, react-router, TanStack Query, plain CSS tokens
  src/pages/          Dashboard, Database, groups.tsx (Media/Minecraft/System stack
                      the original pages as sections), Jellyfin, Files, Minecraft,
                      Maintenance, Logs, Status, Storage
  src/components/     ui.tsx (Card, StatTile, Meter, StatusPill, dialogs, toasts),
                      LogViewer, AlertsFeed, AssistantWidget, ContextModal, icons
  src/types.ts        MIRROR of server/src/types.ts — keep both in sync by hand
deploy/   systemd units, sudoers rule, env template      SERVER_SETUP.md = install handoff
scripts/  hl-run.sh — tee a terminal script's output into the alerts feed
docker-compose.yml   PostgreSQL (127.0.0.1 only) + Directus
```

Scheduler (`services/scheduler.ts`): jobs are **data** in `data/jobs.json` (types
`backup`, `restart`, `command`, `script`, `external`), run with node-cron in `TZ`,
history in `data/job-runs.json`. `external` jobs are mirrors of cron/systemd-timer
jobs: the dashboard marks "due now" in the feed and waits for the script's hl-run
output instead of running anything. Two built-in defaults are seeded disabled on
first start only. Never hard-code a schedule — add or change jobs through the API/UI.

Auth model: the app binds `127.0.0.1:3000`; `tailscale serve` fronts it and injects
`Tailscale-User-Login`. Those headers are trusted only on loopback connections and
Funnel is refused. Scripts and the MCP server use `Authorization: Bearer
$DASHBOARD_KEY` plus `X-Homelab-Agent: <name>` so their actions are attributed.

## Conventions

- **`[INSTALLER]` tags mark placeholders.** Anything written against the demo rather
  than the real server — default container/unit names, paths, seeded jobs, sample
  scripts, alert rules, deploy templates — carries a `[INSTALLER]` comment saying what
  to replace it with. `grep -rn "\[INSTALLER\]" .` lists them; SERVER_SETUP § 0 is
  the checklist. When you add a new guess, tag it the same way.
- One service module per integration. Never let a missing dependency crash boot —
  return `unavailable`/`null` and let the UI say so.
- Validate request bodies with zod at the route; throw `HttpError(status, msg)`.
- Demo mode (`DEMO=1 AUTH_DISABLED=1`, `npm run demo`) must keep every page working
  on a laptop with no Docker/systemd/Tailscale. New integrations need a demo path.
- Mutating actions in the UI confirm first (`useDialog().confirm`).
- Design tokens live in `web/src/styles.css`; status colours are never used alone
  (always with a label); meters' fill carries severity.
- Add a dependency only when it saves real code (current extras: dockerode,
  node-cron, multer, pg, ws, zod, @modelcontextprotocol/sdk).
- Don't commit secrets. `.env`, `data/`, `dist/`, `.claude/` are ignored.

## Roadmap & status

- [x] Nine-page dashboard, demo mode, deploy templates, SERVER_SETUP.md
- [x] Five-tab navigation; Media/Minecraft/System stack their sections
- [x] **Step 1** this file
- [x] **Step 2** alerts hub (`services/alerts.ts`), `/ws/alerts`, AlertsFeed on the
      Minecraft tab with the "Problems & maintenance" toggle
- [x] **Step 3** scripts: `SCRIPTS_DIR` runner with ▶ buttons, `script` job type,
      `scripts/hl-run.sh` tee wrapper, `/api/alerts/ingest`
- [x] **Step 4** AssistantWidget + Instructions & context editor with history/diff
- [x] **Step 5** `DASHBOARD_KEY` bearer auth + agent attribution
- [x] **Step 6** MCP server (`server/src/mcp.ts`), `.mcp.json`, registration docs
- [x] Maintenance reports: agents file brief write-ups (`submit_report`), owner marks
      them reviewed (`services/reports.ts`, `ReportsCard`)
- [x] VPN tab: state, provider/protocol, exit IP + location, datacenter (endpoint geo),
      handshake/transfer, DNS, kill switch, and a per-service traffic map (bypass /
      through VPN) with advice. Provider-agnostic probing; `[INSTALLER]` placeholders.
- [ ] VPN connect/disconnect actions (needs the real provider CLI + sudoers)
- [ ] **Step 7** (optional, off by default) auto-triage via headless `claude -p`
- [ ] Codex registration syntax verified against current docs (marked "verify" in UI/docs)
- [ ] Alert-rule editing from the UI (today: edit `data/alert-rules.json`, hot-reloaded)

### Agent etiquette (read before acting on the server)

1. `read_instructions` first, then `get_alerts` (problems only) and `server_status`.
2. Warn players over RCON (`say …`) before any stop/restart if `players.online > 0`.
3. Prefer the smallest fix. Run a script or job rather than hand-rolling commands when one exists.
4. When done, `submit_report` with what you saw, what you did, and what a human should decide.
5. If you learn something durable about this server, `append_instructions` with a short note.

## Known facts about the live server (from the first install attempt, issue #2)

Learned on 2026-10-13 when an installer ran this branch on the real machine. These
override the placeholders wherever they conflict:

- Minecraft lives under a path **with a space**: `/home/gold/Minecraft Server`. Quote it
  everywhere (env, units, shell snippets).
- Backups are **dated folders**, not single archives: `mcworld_YYYY_MM_DD/world.tar.gz`.
  The dashboard's `mc-YYYYMMDD-HHMMSS.tar.gz` format is only what *it* creates.
- Maintenance scripts are **not** in `/opt/homelab-scripts`; the real folder was not
  recorded — discover it (`SCRIPTS_DIR`) rather than assume.
- Real **systemd timers** already exist: an update-fetch timer and a backup/update/restart
  timer. Mirror them as `external` jobs; do not add dashboard-run equivalents.
- The seeded default jobs showed up in production → treat any job named "Nightly world
  backup" / "Daily restart" in `data/jobs.json` on the server as demo leakage to remove.
- Open work for all of this is tracked in GitHub issue #2 (deferred by the owner).

## Decisions log

- 2026-10-12 UI first. Carter wants to see the screen early; keep backend to what
  the UI needs; hand off server installation as `SERVER_SETUP.md`.
- 2026-10-12 Dashboard runs natively (systemd), not in Docker, because Paper is
  native and needs `systemctl`. Only Postgres + Directus are containers.
- 2026-10-12 Postgres is published on `127.0.0.1` only. Non-negotiable.
- 2026-10-13 Agents connect via **MCP from Carter's terminal sessions**; the
  dashboard does not spawn agents by default. Chosen over headless buttons.
- 2026-10-13 Agent tools have **full autonomy** (restart, RCON, run scripts, edit
  this file). Carter's choice; README states the risk plainly.
- 2026-10-13 Alerts + widget live **inside the Minecraft tab** (filter button above
  the feed, widget to the right), not a separate tab.
- 2026-10-13 Python maintenance scripts move to `SCRIPTS_DIR` and run from the
  dashboard; `hl-run.sh` covers scripts still launched from Terminal.
- 2026-10-13 No API keys. Subscription-based terminal agents only; the optional
  auto-triage would use `claude setup-token`, never `ANTHROPIC_API_KEY`.
- 2026-10-13 Paper's "Can't keep up!" is classified **warn**, not error (it is a
  symptom, not an outage). Rules persist in `data/alert-rules.json`; changing the
  defaults in code does not touch an existing file.
- 2026-10-13 Minecraft layout: compact status strip top-right; alerts + assistant
  row; console; then the Maintenance section. Carter found the big status tiles
  low-value.
- 2026-10-13 **Maintenance reports live on the Dashboard** (under the stat tiles),
  not the Minecraft tab — they are the owner's review inbox, so they belong on the
  landing page.
- 2026-10-13 Demo mode edits a copy of this file (`data/demo/CLAUDE.md`), never the
  repo's, so smoke tests can write freely.
- 2026-10-13 Seeded jobs start **disabled**. The owner already has backup/restart
  scripts; the dashboard must not add a second nightly backup on its own.
- 2026-10-13 VPN: the server runs a VPN with split-tunnel exceptions for Minecraft and
  Jellyfin; the client and mechanism are unknown, so `services/vpn.ts` probes (CLIs,
  WireGuard, ip rule, nft/iptables marks, geo) rather than assuming. Guidance baked into
  the traffic map: Tailscale MUST bypass (it carries the dashboard), Directus/Dashboard
  ride on Tailscale, Postgres is loopback-only, Minecraft needs a bypass, Jellyfin only
  if reached from the internet. The page is read-only on purpose until the real client
  is known.
- 2026-10-13 **The live server keeps its existing semi-weekly restart + backup
  motion (cron + Python scripts) unchanged.** The dashboard mirrors them as
  `external` jobs — real cron expressions, display-only — and the cron commands are
  wrapped with `hl-run` so output lands in the feed and the mirrored job is marked
  OK/failed. Do not convert them to built-in jobs or re-time them without Carter.

## How to run & verify

```bash
npm install && npm run build && npm run demo      # http://127.0.0.1:3000, all pages faked
npm run dev:server   # tsx watch, demo + auth disabled   |  npm run dev:web  # Vite :5173
```
Demo verification used so far: `curl -i http://127.0.0.1:3000/` → 200; backup job
creates a tar.gz under `data/demo/backups`; restart job cycles the fake unit;
`../` paths rejected by the file manager; mobile width has no horizontal overflow.
MCP smoke test (once Step 6 lands): `node server/test-mcp.mjs`.

## Deployment

Follow `SERVER_SETUP.md`. The repo is `git@github.com:cartergloyd/homelab-dashboard.git`
(private); on the server it lives at `/opt/homelab-dashboard` and runs as user
`homelab` under `homelab-dashboard.service`.

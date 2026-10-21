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
                      + Cloudflare Access tokens on tunnel requests (src/cf-access.ts verifies them)
  src/routes.ts       all /api routes (one Router)
  src/ws.ts           /ws/logs (raw lines) and /ws/alerts (events)
  src/demo.ts         DEMO=1 fixtures + seeded demo dirs under data/demo/
  src/services/       one module per integration; each degrades to "unavailable"
    docker systemd rcon slp jellyfin directus postgres files storage tailscale
    backups scheduler status logs alerts scripts context
  src/mcp.ts          stdio MCP server — thin client over the REST API
  src/tools/          CLIs: audit-install (+ --propose = discover), clear-demo-data,
                      wrap-service; discover-lib.ts is pure (OnCalendar→cron, crontab
                      parsing, mirror matching) and tested by server/test-discover.mjs
web/      Vite + React 18 + TS, react-router, TanStack Query, plain CSS tokens
  src/pages/          Dashboard, Database, groups.tsx (Media/Minecraft/System stack
                      the original pages as sections), Jellyfin, Files, Minecraft,
                      Maintenance, Logs, Status, Storage
  src/components/     ui.tsx (Card, StatTile, Meter, StatusPill, dialogs, toasts),
                      LogViewer, AlertsFeed, AssistantWidget, ContextModal, icons
  src/types.ts        MIRROR of server/src/types.ts — keep both in sync by hand
deploy/   systemd units, sudoers rule, env template      SERVER_SETUP.md = install handoff
scripts/  hl-run.sh — tee a terminal script's output into the alerts feed; add-app.sh; pg-backup.sh;
          migrate-supabase-kv.sh — the fam site's Supabase table into the fam database + Directus (§ 5.9)
docker-compose.yml   PostgreSQL (127.0.0.1 only) + personal Directus (Tailscale) + one Directus per
                     public app (fam, ai → 127.0.0.1:805x, published as <app>-api.xgold.tech) +
                     cloudflared (Cloudflare Tunnel, host network → 127.0.0.1:<port>)
                     services/apps.ts reads it all; apps-config.ts parses APPS / APP_<NAME>_*
deploy/dns/          the owner's real DNS records as a BIND zone (import into Cloudflare, § 5.0a)
```

Scheduler (`services/scheduler.ts`): jobs are **data** in `data/jobs.json` (types
`backup`, `restart`, `command`, `script`, `external`), run with node-cron in `TZ`,
history in `data/job-runs.json`. `external` jobs are mirrors of cron/systemd-timer
jobs: the dashboard marks "due now" in the feed and waits for the script's hl-run
output instead of running anything. A non-demo install seeds **no** jobs; `npm run
discover` mirrors the real systemd timers and crontab lines (demo mode seeds four
flagged `seeded: true`). Never hard-code a schedule — add or change jobs through the
API/UI.

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
- **`[DEMO]` tags mark demo-only code.** Every `if (cfg.demo)` branch, fixture, demo-only
  route or button carries a `[DEMO]` comment, and `DEMO_INDEX.md` lists each file with
  what it fakes and what the real install provides. `npm run demo:index` prints the tags;
  `npm test` fails when a file with demo code is missing from the index. New demo code →
  tag it and add a row.
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
- [x] Issue #2 install hardening: zero jobs on a non-demo install (`seeded` flag on demo
      ones); backups discovered in `mc-*.tar.gz`, `mcworld_YYYY_MM_DD/` and `*.tar.gz`
      layouts with source shown and only dashboard-made ones deletable; `BACKUP_METHOD`
      / `BACKUP_FORMAT`; multi-folder `SCRIPTS_DIR` with a loud missing-folder error;
      external jobs carry `timer` + output-tracking state; tools `audit:install`,
      `discover`, `clear-demo-data`, `wrap-service`; hl-run accepts `DASHBOARD_KEY`.
- [x] `discover` also reads crontabs (user, /etc/crontab, /etc/cron.d, root + Minecraft
      owner via sudo -n), finds script folders and backup roots, verifies each OnCalendar→cron
      translation against systemd's next elapse, and prints the wrapped cron line;
      `wrap-service --install-hl-run` + `/etc/homelab-hl-run.env`; hl-run streams
      line-by-line (PYTHONUNBUFFERED) and survives an unreachable dashboard
- [x] Codex registration syntax verified against developers.openai.com/codex/mcp
      (`codex mcp add <name> --env K=V -- <cmd>`; `[mcp_servers.<name>]` in config.toml)
- [x] Issue #4 storage explorer (System → Storage), **built on proven scanners**: ncdu
      (preferred; documented JSON export) or gdu (same format, faster), `du -x -a` as the
      fallback — `services/diskscan.ts` parses the export as a stream into a directory
      tree with per-folder aggregates, the largest files per subtree, and type / age /
      owner statistics for the top 3 levels; scans run one at a time per mount, persist
      under `data/diskscan/`, re-run every `DISK_SCAN_INTERVAL_HOURS`. UI: breadcrumb tree
      with bars, squarified treemap, Largest files / By type / By age / By owner tabs,
      "Scan this folder" for deep stats. Plus the "Reclaimable space" report (display-only
      commands). MCP: `storage_scan`, `storage_tree`, `storage_largest`, `storage_reclaim`.
      Tests: `server/test-diskscan.mjs`.
- [x] Issue #5 **Assistant sidecar** (`services/sidecar.ts`, `services/agentRunner.ts`,
      `AssistantWidget`): the feed is grouped into **incidents** (errors, failed jobs/scripts,
      3× the same warning in 10 min; fingerprinted, deduped, cooldown), a supervised
      **queue** launches the owner's signed-in Codex / Claude Code on them one at a time
      (quiet period first), output is parsed (Codex `--json`, Claude `stream-json`) into a
      **conversation** the owner can type into, sessions are **resumed** across runs, risky
      actions (restart/stop, destructive RCON) are **gated behind approvals** the owner
      grants in the panel (409 to the agent → it stops → resumed with the decision),
      reports carry `incidentId`, alert rows are clickable → "Ask about this", lifecycle
      phases off/idle/queued/investigating/waiting-approval/acting/failed. Demo mode runs a
      simulated agent so the whole loop can be watched ("Simulate incident").
      MCP: `request_approval`, `list_incidents`, `get_incident`; `submit_report(incidentId)`.
- [x] Assistant tile "repairs by the agent": reports carry an `outcome` (fixed / no-action /
      needs-human; inferred from wording when the agent omits it), incidents inherit the
      strongest outcome, `GET /api/sidecar/repairs` lists each reported incident with the
      agent's tool calls, approvals and reports; the tile counts `fixed` and opens the list.
- [x] "Staged update" card on the Minecraft tab (`services/updates.ts`): installed Paper build
      and plugin versions read from the jars (own zip reader → plugin.yml / paper-plugin.yml),
      staged jars in `UPDATE_STAGING_DIR` (or plugins/update, updates, staged, staging),
      latest upstream with release dates (PaperMC, Modrinth, Hangar, GitHub; `PLUGIN_SOURCES`
      maps names; `UPDATE_CHECK=0` disables), next apply job, last fetch. MCP `staged_updates`.
      Tests: `server/test-updates.mjs`.
- [x] **Database platform** (Carter, 2026-10-19): Directus-per-app on one Postgres, published
      by a Cloudflare Tunnel — `docker-compose.yml` (postgres + personal directus + directus-fam
      + directus-ai + cloudflared), `deploy/postgres-init/01-apps.sh` (role + database per app
      on first start), `scripts/add-app.sh` (idempotent add + snippets), `scripts/pg-backup.sh`
      (dumps per database), `services/apps.ts` + `GET /api/apps` + MCP `apps_status`, Database
      tab rebuilt (Postgres core with loopback proof, tunnel, one card per app, databases
      table), Service status rows per app, audit `[apps]` section (5432 loopback-only is a
      gate), SERVER_SETUP § 5 rewritten + § 8b router settings.
- [ ] Database platform: the compose stack has still never been started on real Docker
      (none on the dev Mac) — first `docker compose up` happens on the server
- [x] **DNS cutover** done 2026-10-20: `xgold.tech` is **Active** on Cloudflare (nameservers switched
      11:33, DNSSEC removed at Squarespace, 13 records identical to the old zone, all DNS-only);
      Zero Trust Free is activated (team `xgold-tech`). Runbook SERVER_SETUP § 5.0a, records
      as data in `deploy/dns/xgold.tech.zone`, `audit:install` `[dns]` section (`server/test-dns.mjs`).
- [x] Tunnel `homelab` created in Zero Trust (2026-10-20, id `0ef75471-…`) with routes
      `fam-api.xgold.tech` → `http://127.0.0.1:8056` and `ai-api.xgold.tech` → `http://127.0.0.1:8057`
- [x] Cloudflare Access application "Directus admin (fam-api, ai-api)" (2026-10-20): destinations
      `fam-api.xgold.tech/admin*` + `ai-api.xgold.tech/admin*`, policy Owner = allow the owner's
      login e-mail, One-time PIN IdP, 24 h sessions. API paths stay public for the apps.
- [x] **Issue #10 part A, code**: the dashboard verifies Cloudflare Access tokens itself
      (`cf-access.ts`: RS256 against the team's JWKS, aud/iss/exp, cookie or header; `auth.ts`:
      Cloudflare-stamped requests never read Tailscale headers, bearer key over the tunnel needs a
      valid token too, logins land in the feed; `AppConfigPayload.user.via`; audit `[remote]` gates
      incl. a forged-header probe; `server/test-cf-access.mjs`). Env `CF_ACCESS_TEAM_DOMAIN`,
      `CF_ACCESS_AUD`, `PUBLIC_DASHBOARD_URL`. SERVER_SETUP § 7b = GitHub OAuth app → Access app
      (GitHub only) → env → tunnel route `dash`.
- [x] **Domain & hostnames card** on the Dashboard (Carter, 2026-10-20: "a list of subdomains …
      and their statuses"): `services/hostnames.ts` merges the Cloudflare DNS API (read-only token)
      or `deploy/dns/<domain>.zone` (`dns-lib.ts parseZoneFile`) with config-implied names (apps,
      dash, mc, `HOSTNAMES_EXTRA` planned names), resolves each publicly (`services/dnsLookup.ts`,
      shared with the audit), infers the role, and probes it (HTTPS / Access login wall / Cloudflare
      5xx, Minecraft ping, Jellyfin). `GET /api/hostnames`, MCP `hostnames_status`,
      `HostnamesCard`. Read-only by design.
- [x] Issue #10 part A, Cloudflare side (2026-10-20): GitHub OAuth app + login method (tested,
      identity e-mail = the owner's), Access application "Homelab dashboard" for `dash.xgold.tech`
      (GitHub only, Owner policy, 24 h, id `ff50007a-…`, AUD in SERVER_SETUP § 7b), tunnel route
      `dash` → `http://127.0.0.1:8088`
- [x] **Twenty CRM** as a second app kind (Carter, 2026-10-21): `APP_<NAME>_KIND=twenty` in
      `apps-config.ts` (site = the app, `/healthz`, container `homelab-twenty`, 127.0.0.1:3020),
      compose services `redis` + `twenty-server` + `twenty-worker` on the shared Postgres (database +
      role `crm`), `add-app.sh --kind twenty`, kind-aware Database card / status row / audit / hostnames
      role `app`, SERVER_SETUP § 5.8 with the multi-user access model. Cloudflare side done 2026-10-21:
      tunnel route `crm` → 127.0.0.1:3020, Access app "Twenty CRM" (policy "CRM users" = e-mail
      allow-list starting with the owner, One-time PIN + GitHub, 1-month sessions). Server side: #12.
- [ ] **fam data off Supabase** (Carter, 2026-10-21): `scripts/migrate-supabase-kv.sh fam …` copies the
      site's one table (`public.kv`, 7 colls, 19 rows that day) through the REST API into the `fam`
      database via the postgres container and registers it in fam's Directus (SERVER_SETUP § 5.9).
      Written and syntax-checked on the dev Mac only — **the first real run is on the server**, after
      the compose stack is up. Then: switch the front-end (`fam.xgold.tech` repo) and pause the project.
- [ ] Issue #10 part A, server side: pull main, build, add `CF_ACCESS_*` + `PUBLIC_DASHBOARD_URL`
      to the dashboard env, restart; confirm `PORT`/`HOST` (route assumes 8088 on loopback)
- [ ] Issue #10 parts B–E: TOTP step-up, encrypted off-site dumps + restore test, Directus 2FA
      checklist, service token for MCP, image versions in the Staged update card
- [ ] Tunnel: token into the compose `.env` on the server, first `docker compose up` (then
      `fam-api.xgold.tech/server/health` turns from Cloudflare 530 into `{"status":"ok"}`)
- [ ] Sidecar: verify `codex exec --json` / `codex exec resume <thread>` against the installed
      Codex version on the server (plain-text output still works, resume is skipped if absent)
- [ ] VPN connect/disconnect actions (needs the real provider CLI + sudoers)
- [x] **Step 7** became the sidecar above (headless agent on the owner's subscription, no API key)
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
- The owner's domain is `xgold.tech`, **registered at Squarespace**, served by Cloudflare DNS since
  2026-10-20 (`robin`/`rory.ns.cloudflare.com`, zone Active, DNSSEC off everywhere — the stale DS
  caused a few hours of SERVFAIL at 1.1.1.1 because the nameservers moved before the DS expired).
  Zero Trust Free is active; the team domain is `xgold-tech.cloudflareaccess.com` (renamed
  from the auto-generated one on 2026-10-20; issue #10 needs it as `CF_ACCESS_TEAM_DOMAIN`). Visiting
  that domain directly shows the App Launcher's "NoAuth" page — expected, it is only a redirect target. The records, identical to the old Squarespace set:
  `@`, `www`, `fam` → GitHub Pages (`cartergloyd.github.io`); `api.fam`, `mc`, `streaming` → the
  home IP `99.116.141.110` (port-forwarded through the VPN's exceptions); SRV `_minecraft._tcp.mc`;
  SPF/DMARC/DKIM TXTs saying no mail is sent. Hence the convention **`<app>-api` = that app's
  Directus, `<app>` = its front-end** (single level: Universal SSL covers `*.xgold.tech` only; the
  legacy `api.fam` A record stays until nothing uses it). The first apps are `fam` and `ai`.
- A Geyser (Bedrock) plugin with MCXboxBroadcast runs on the Paper server — its token-refresh
  failures are a known "needs a human" incident, not a server fault.
- **The fam site's backend is Supabase project `radwvuaaaxxblsnrkpqd`** (as of 2026-10-21): one table
  `public.kv (coll, id, data jsonb)` used as a Firestore-style document store by the shim at the top of
  `fam.xgold.tech/index.html` (colls plans, bedrooms, flights, members, progress, meals, groceries;
  ids are either generated or paths like `members/claim-<name>`, so the same id can recur across
  colls). RLS gives the site's publishable key (`sb_publishable_iRnckqOLBIR7pt_ZYdFLeg_gAztE1e_`, public
  in the HTML) full CRUD on those colls; no Auth users, no Storage. The earlier FastAPI login API at
  `api.fam.xgold.tech` (`gold_linux_server/fam.xgold.tech/`, CSV accounts) is defunct.
- **The dev Mac is Carter's company laptop and must stay clean**: nothing runs or is stored on it
  (no Docker Desktop — it is sign-in-locked by the company anyway — no data exports, no local dry
  runs). It edits and pushes; the server runs. From the office network it cannot reach the server
  (no Tailscale client, the LAN address only works at home) and `gh` fails TLS behind the corporate
  proxy while `curl` and git-over-SSH work.

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
- 2026-10-13 **A non-demo install seeds no jobs at all** (was: two disabled seeds, which
  still leaked into production — issue #2). Demo seeds carry `seeded: true` so
  `clear-demo-data` can remove them.
- 2026-10-13 The dashboard **never deletes a backup it did not create** (tracked in
  `data/backups-created.json`); existing `mcworld_…` folders show as "existing".
- 2026-10-13 Install verification is a command, not a feeling: `npm run audit:install`
  must print FULLY CONNECTED; "it looks connected" is not acceptance.
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
- 2026-10-13 **A mirror's schedule is verified, not trusted.** `audit:install` compares
  node-cron's next run of each timer-backed mirror with systemd's `NextElapse` and fails
  on disagreement; `discover` does the same before proposing. Cron-backed mirrors are
  matched to the actual crontab line (command or script+schedule) and fail the audit
  until that line runs through hl-run.
- 2026-10-13 hl-run reads `/etc/homelab-hl-run.env` (HOMELAB_URL + HOMELAB_KEY only,
  written by `wrap-service --install-hl-run`) when cron/systemd give it no environment.
  The full dashboard env is never handed to maintenance scripts (it holds the Jellyfin
  key and the Postgres password).
- 2026-10-13 The audit/discover tools probe unknown paths only through `find` child
  processes with hard timeouts; a direct fs call on a dead mount (autofs/NFS) parks a
  Node I/O thread forever and the process can never exit — seen on the dev Mac's `/home`.
- 2026-10-14 **The storage explorer never deletes.** Reclaimable-space items carry the
  shell command a human (or an agent with its own shell) would run; the dashboard only
  measures. Folders the service user cannot read show as lower bounds with a notice —
  no sudo rule for `du`/`find` (find -exec would be root code execution).
- 2026-10-14 **Scanning is delegated to ncdu/gdu, not reimplemented.** Carter asked for the
  most robust open-source TreeSize equivalent rather than a from-scratch scanner. ncdu's
  JSON export (https://dev.yorhel.nl/ncdu/jsonfmt) is the interchange format; gdu writes
  the same format (verify `ncdu -f` reads a `gdu -o` file on the server); `du -a` is only a
  fallback. Our code owns the streaming parse, the aggregates and the UI. Demo mode feeds
  a generated ncdu export through the same parser so the code path is identical.
- 2026-10-14 **Sidecar safety model.** Humans (Tailscale identity) are never gated. Agents
  (dashboard key) hit a 409 on restart/stop/destructive RCON while `requireApproval` is
  on; the dashboard files an approval request, the agent is told to end its turn, and the
  owner's decision resumes the same session with a continuation prompt. An approval is
  spent once (`consumed`). Incidents never re-trigger within the cooldown; one agent run at
  a time; `maxRunMinutes` kills a runaway run. The sidecar never deletes or edits anything
  itself — only the agent does, inside its workspace, through the same API the UI uses.
- 2026-10-19 **Directus-per-app, not self-hosted Supabase.** Carter wants a Supabase-style
  backend for `fam.xgold.tech`, `ai.xgold.tech`, … with segregated databases. Chosen: one
  Postgres, one database + one login role + one Directus per app (auth, roles/policies,
  REST, GraphQL, files, realtime, flows), because it reuses what the dashboard already
  understands and costs ~1 container per app instead of ~10. Trade-off accepted: no
  `supabase-js` compatibility, permissions enforced by Directus rather than Postgres RLS.
- 2026-10-19 **Cloudflare Tunnel for the public side.** The server sits behind a VPN, so
  inbound port-forwards don't work and would widen the attack surface anyway; `cloudflared`
  makes outbound-only connections, gives TLS per hostname on the owner's domain, and
  Cloudflare Access can gate `/admin`. Tailscale Funnel was rejected (no custom domains).
  **Postgres stays 127.0.0.1-only** — apps talk to Directus, never to the database port.
  The personal Directus stays Tailscale-only and is NOT in the tunnel.
- 2026-10-19 Data for the stack lives outside the source checkout (`PGDATA_DIR`,
  `APPS_DATA_DIR`, default `/srv/homelab/…`) so a re-clone can never lose it.
- 2026-10-20 **`<app>-api.xgold.tech` is the app's Directus; `<app>.xgold.tech` is its front-end.**
  Found in the live DNS: `fam.xgold.tech` is already a GitHub Pages site and `api.fam` its API
  host. First chosen as `api.<app>`, changed the same day: Cloudflare's free Universal SSL covers
  one subdomain level only, and a multi-level name needs the paid Advanced Certificate Manager.
  Defaults in `apps-config.ts` (`publicUrl` = `<name>-api`, `siteUrl` = bare), compose `PUBLIC_URL`,
  CORS default = the site origin, `add-app.sh`, docs; `APP_<NAME>_PUBLIC_URL` / `_SITE_URL` override.
- 2026-10-20 **cloudflared runs with `network_mode: host`.** A bridge container cannot reach
  services bound to 127.0.0.1 on the host (`host.docker.internal` is the bridge gateway, not
  loopback), and everything the tunnel publishes is loopback-only by design — including the
  native dashboard for issue #10. Public hostnames therefore point at `http://127.0.0.1:<port>`.
- 2026-10-20 **The DNS cutover changes nothing but the nameservers.** The Cloudflare zone is made
  record-for-record identical to Squarespace with every record DNS-only (`mc`/`streaming` must
  never be proxied; GitHub Pages stays unproxied for now), DNSSEC is switched off at Squarespace
  and the DS allowed to expire *before* the nameservers move; the `dash` tunnel hostname waits
  for issue #10. A browser session can read both accounts, but Claude Code's auto-mode classifier
  refuses DNS/registrar edits and Zero Trust activation needs a payment method + Terms, so the
  owner performs § 5.0a by hand.
- 2026-10-20 **Remote access = Cloudflare Access + the dashboard's own token check, GitHub as
  the identity provider.** A Cloudflare-stamped request (`CF-Ray`) is authenticated ONLY by its
  Access JWT; Tailscale headers on it are ignored (anyone could type them). Bearer key over the
  tunnel requires a valid Access token as well. GitHub was chosen because it enforces 2FA on every
  account and needs one OAuth app, no money; e-mail one-time PIN is a single factor and is not
  offered for the dashboard. No JWT library: Node's `crypto.verify` with JWK import.
- 2026-10-20 **The hostnames card reads DNS, never writes it.** Preferred source is a Cloudflare
  API token scoped to Zone:Read + DNS:Read on this zone only (an integration secret like the
  Jellyfin key, not an AI API key); the zone file is the fallback. Changing records stays a human
  action in Cloudflare — the classifier refuses DNS edits for the agent anyway, and a dashboard that
  could rewrite DNS would be a far bigger prize than one that can read it.
- 2026-10-21 **CRM for several people: Twenty's own accounts first, Cloudflare Access as the outer
  lock with an e-mail allow-list.** Carter wants multiple users. GitHub-only login would force every
  family member onto GitHub, so the "Twenty CRM" Access app allows listed e-mails with One-time PIN
  (plus GitHub for the owner), long sessions, and Twenty handles accounts, roles and 2FA inside.
  Adding a person = one e-mail in the policy + an invite in Twenty. Access stays removable.
- 2026-10-14 Facts from the server-side agent's commits on `main`: the dashboard source is
  at `/home/gold/server-platform/homelab-dashboard-src`, its env at
  `/home/gold/server-platform/homelab-dashboard.env` (pass `--env` to the CLI tools, or
  set `HOMELAB_ENV_FILE`); `.mcp.json` on main hard-codes those paths; there is a
  `SYSTEMD_USER` flag in config (unused so far — if Paper runs as a *user* unit,
  `systemctl --user` is needed and the sudo rules don't apply); a qBittorrent link
  (`QBITTORRENT_PUBLIC_URL`) exists; a dashboard-launched agent runner
  (`services/agentRunner.ts`, `codex exec` / `claude -p` with cwd `/home/gold/Minecraft
  Server`) was added as an interim step toward issue #5.
- 2026-10-21 **fam's Supabase table lands at home with a single-column key.** Directus cannot manage a
  table whose primary key spans two columns, so `kv` gets `key text primary key = '<coll>/<id>'` next
  to the unchanged `coll`, `id`, `data` (unique `(coll, id)`, check constraint). The migration goes
  through Supabase's REST API with the site's own public key (no database password exists on the Mac
  or in the repos) and `psql` inside the postgres container — no new dependency. Public write access
  is **not** granted at home by default (`--public-access` mirrors the Supabase anon policy when the
  front-end moves). The script runs on the server only; see the known-facts note on the dev Mac.

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

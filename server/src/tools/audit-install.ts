#!/usr/bin/env node
// Production install audit + importer (issue #2). Checks the configured service
// names, paths, timers, cron entries, backup roots, scripts folders and DATA_DIR
// against the live machine, and only says FULLY CONNECTED when status, jobs,
// scripts, backups and alerts ingestion all pass. --propose discovers systemd
// timers, crontab lines, script folders and backup roots and prints suggested env
// values and `external` mirror jobs; --apply (with --propose) creates those jobs
// through the running dashboard.
//
//   npm run audit:install                 # audit against /etc/homelab-dashboard.env
//   npm run audit:install -- --json       # machine-readable (for agents)
//   npm run discover                      # = audit --propose
//   npm run discover -- --apply           # create the proposed mirror jobs
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { calendarToCron, fmtDelta, isRelevant, jobMatchesCronEntry, nextRunOf, normalizeCommand, parseCrontab, parseSystemdTimestamp, scriptPathFromCommand, wrappedCronLine, type CronEntry } from "./discover-lib.js";
import { RR, dnssecVerdict, hostOf, proxiedVerdict, readDoh, type DohResponse, type RRName } from "./dns-lib.js";
import { envFileFromArgs, flag, loadEnvFile, shq } from "./env.js";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const envFile = envFileFromArgs(argv);
const envLoaded = loadEnvFile(envFile);
const asJson = flag(argv, "--json");
const propose = flag(argv, "--propose");
const applyProposals = flag(argv, "--apply");

const { cfg } = await import("../config.js");
const { unitState } = await import("../services/systemd.js");
const { containerInfo, dockerAvailable } = await import("../services/docker.js");
const { health: jellyfinHealth } = await import("../services/jellyfin.js");
const { rconCommand } = await import("../services/rcon.js");
const { listScripts } = await import("../services/scripts.js");
const { listBackups, worldFolders } = await import("../services/backups.js");
const { directusHealth } = await import("../services/directus.js");
const { pgStats } = await import("../services/postgres.js");
const { tailscaleStatus } = await import("../services/tailscale.js");
const { appsStatus, portBinds } = await import("../services/apps.js");

type Status = "pass" | "warn" | "fail" | "skip";
interface Check {
  area: string;
  name: string;
  status: Status;
  detail: string;
  /** must pass for "fully connected" */
  gate?: boolean;
}
const checks: Check[] = [];
const add = (area: string, name: string, status: Status, detail: string, gate = false) => checks.push({ area, name, status, detail, gate });

async function run(cmd: string, args: string[], timeout = 8000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await execFileP(cmd, args, { timeout, maxBuffer: 1 << 20 });
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
async function sh(cmd: string, args: string[], timeout = 8000): Promise<string | null> {
  const r = await run(cmd, args, timeout);
  return r.ok ? r.stdout : null;
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
/** A stuck mount (autofs, dead NFS) must not hang the audit: give up on a path after a few seconds. */
function withTimeout<T>(p: Promise<T>, fallback: T, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);
}
const ls = (dir: string): Promise<string[]> => withTimeout(fs.readdir(dir).catch(() => [] as string[]), []);
const statOrNull = (p: string) => withTimeout(fs.stat(p).catch(() => null), null);
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: cfg.timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ---- environment --------------------------------------------------------------

add("env", "env file", envLoaded ? "pass" : "fail", envLoaded ? envFile : `${envFile} not found (pass --env FILE)`, true);
// [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
add("env", "demo flags", cfg.demo || cfg.authDisabled ? "fail" : "pass", cfg.demo || cfg.authDisabled ? "DEMO and/or AUTH_DISABLED are set — never on the server" : "DEMO / AUTH_DISABLED unset", true);
add("env", "dashboard key", !cfg.dashboardKey ? "fail" : cfg.dashboardKey === "demo-key-not-secret" ? "fail" : "pass", !cfg.dashboardKey ? "DASHBOARD_KEY unset" : cfg.dashboardKey === "demo-key-not-secret" ? "DASHBOARD_KEY is the demo key" : "set", true);
add("env", "timezone", "pass", `${cfg.timezone} (schedules are evaluated in this zone)`);

// ---- status: minecraft, docker, jellyfin, directus, postgres, tailscale -------

const unit = await unitState(cfg.minecraft.service);
add("status", `systemd unit ${cfg.minecraft.service}`, unit ? "pass" : "fail", unit ? `${unit.active} (${unit.sub})` : "not found — set MC_SERVICE to the real unit (systemctl list-units | grep -i mine)", true);

const sudoList = (await sh("sudo", ["-n", "-l"])) ?? "";
const unitName = cfg.minecraft.service.endsWith(".service") ? cfg.minecraft.service : `${cfg.minecraft.service}.service`;
add("status", "sudo rule for restart", sudoList.includes(`systemctl restart ${unitName}`) ? "pass" : "fail", sudoList.includes(`systemctl restart ${unitName}`) ? "present" : `sudoers lacks "systemctl restart ${unitName}" (deploy/sudoers-homelab)`, true);
add("status", "sudo rules for VPN inspection", /wg show/.test(sudoList) && /nft list ruleset|iptables -t mangle/.test(sudoList) ? "pass" : "warn", /wg show/.test(sudoList) ? "wg show allowed" : "wg show / nft not allowed — VPN page will show Unknown for handshake and bypass detection");

add("status", "docker socket", dockerAvailable() ? "pass" : "fail", dockerAvailable() ? cfg.dockerSocket : `${cfg.dockerSocket} not readable — is homelab in the docker group?`, true);
for (const [label, name] of [
  ["jellyfin container", cfg.jellyfin.container],
  ["directus container", cfg.directus.container],
  ["postgres container", cfg.postgres.container],
] as const) {
  const c = dockerAvailable() ? await containerInfo(name) : null;
  add("status", label, c ? (c.state === "running" ? "pass" : "warn") : "fail", c ? `${name}: ${c.state}` : `${name} not found (docker ps --format '{{.Names}}')`, label === "jellyfin container");
}

try {
  const ms = await jellyfinHealth();
  add("status", "jellyfin /health", "pass", `${cfg.jellyfin.url} (${ms} ms)`, true);
} catch (e) {
  add("status", "jellyfin /health", "fail", `${cfg.jellyfin.url}: ${(e as Error).message}`, true);
}
if (cfg.jellyfin.apiKey) {
  try {
    const res = await fetch(`${cfg.jellyfin.url}/System/Info`, { headers: { Authorization: `MediaBrowser Token="${cfg.jellyfin.apiKey}"` }, signal: AbortSignal.timeout(5000) });
    add("status", "jellyfin API key", res.ok ? "pass" : "fail", res.ok ? "accepted" : `rejected (${res.status})`);
  } catch (e) {
    add("status", "jellyfin API key", "fail", (e as Error).message);
  }
} else add("status", "jellyfin API key", "warn", "JELLYFIN_API_KEY unset — sessions/counts unavailable");

try {
  const out = await rconCommand("list");
  add("status", "RCON", "pass", out.slice(0, 80), true);
} catch (e) {
  add("status", "RCON", "fail", `${cfg.minecraft.rcon.host}:${cfg.minecraft.rcon.port}: ${(e as Error).message}`, true);
}

add("status", "minecraft folder", (await exists(cfg.minecraft.dir)) ? "pass" : "fail", cfg.minecraft.dir, true);
const worldNames = await worldFolders();
const worlds: string[] = [];
for (const w of worldNames) if (await exists(path.join(cfg.minecraft.dir, w))) worlds.push(w);
add("status", "world folders", worlds.length ? "pass" : "warn", worlds.length ? `${worlds.join(", ")} (level-name "${worldNames[0]}")` : `none of ${worldNames.join("/")} in ${cfg.minecraft.dir} — check level-name in server.properties`);

const d = await directusHealth();
add("status", "directus", d.state === "ok" ? "pass" : d.state === "degraded" ? "warn" : "fail", d.status ? `health ${d.status}` : (d.error ?? "unreachable"));
const pg = await pgStats();
add("status", "postgresql", pg.connected ? "pass" : cfg.postgres.url ? "fail" : "warn", pg.connected ? `${pg.tables} tables` : (pg.error ?? "PG_URL unset"));

const ts = await tailscaleStatus();
add("status", "tailscale", ts.available ? (ts.self?.online === false ? "fail" : "pass") : "fail", ts.available ? `${ts.self?.hostName ?? "?"} · ${ts.peers.filter((p) => p.online).length}/${ts.peers.length} peers online` : (ts.error ?? "tailscale CLI unavailable"), true);
const serve = (await sh("tailscale", ["serve", "status"])) ?? "";
add("status", "tailscale serve", serve.includes(`:${cfg.port}`) || serve.includes(`127.0.0.1:${cfg.port}`) ? "pass" : "warn", serve.trim() ? serve.trim().split("\n")[0] : "no serve config — run: sudo tailscale serve --bg " + cfg.port);

// ---- media, scripts, backups ---------------------------------------------------

for (const r of cfg.mediaRoots) {
  let ok = false;
  try {
    await fs.access(r.path, fsConstants.W_OK);
    ok = true;
  } catch {
    ok = false;
  }
  add("media", `root ${r.name}`, ok ? "pass" : "fail", ok ? r.path : `${r.path} missing or not writable by this user`);
}
if (!cfg.mediaRoots.length) add("media", "media roots", "warn", "MEDIA_ROOTS unset — Media files page will be empty");

const scripts = await listScripts();
for (const dir of scripts.dirs) add("scripts", "folder", dir.exists ? (dir.count ? "pass" : "warn") : "fail", dir.exists ? `${dir.path}: ${dir.count} script(s)` : `${dir.path} does not exist — set SCRIPTS_DIR to the real folder(s)`, true);

const backups = await listBackups();
for (const r of backups.roots) add("backups", "root", r.exists ? (r.count ? "pass" : "warn") : "fail", r.exists ? `${r.path}: ${r.count} backup(s)` : `${r.path} does not exist — set BACKUP_DIR`, true);
const byFormat = backups.backups.reduce<Record<string, number>>((acc, b) => ((acc[b.format] = (acc[b.format] ?? 0) + 1), acc), {});
add("backups", "formats found", backups.backups.length ? "pass" : "warn", backups.backups.length ? Object.entries(byFormat).map(([k, v]) => `${k}: ${v}`).join(", ") : "no existing backups recognised (mc-*.tar.gz, mcworld_YYYY_MM_DD/, *.tar.gz)");
add("backups", "method", cfg.backups.method === "builtin" ? "warn" : "pass", cfg.backups.method === "builtin" ? `BACKUP_METHOD=builtin (${cfg.backups.format}) — set script:<name> to use the owner's own backup script` : cfg.backups.method);

// ---- storage explorer engine (issue #4) ----------------------------------------------

const ncduVer = (await sh("ncdu", ["-v"]))?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
const gduVer = (await sh("gdu", ["-v"]))?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
add("storage", "disk scanner", ncduVer || gduVer ? "pass" : "warn", ncduVer ? `ncdu ${ncduVer} (TreeSize view with file ages and owners)` : gduVer ? `gdu ${gduVer} (ncdu-format export; no file ages/owners)` : "neither ncdu nor gdu installed — the explorer falls back to du -a (slow, no ages/owners). Fix: sudo apt install ncdu");

// ---- database apps + tunnel (issue: Directus-per-app, SERVER_SETUP § 5) -----------------

const pgBinds = await portBinds(5432);
add("apps", "postgres bound to loopback only", pgBinds === null ? "warn" : pgBinds.length && pgBinds.every((b) => b.startsWith("127.") || b === "::1") ? "pass" : "fail", pgBinds === null ? "could not run ss — check by hand: ss -ltnp | grep 5432" : pgBinds.length ? `5432 listens on ${pgBinds.join(", ")}` : "nothing is listening on 5432 (is the postgres container up?)", pgBinds !== null);
if (cfg.apps.length) {
  const a = await appsStatus(true);
  add("apps", "cloudflared", a.tunnel.ready ? "pass" : "fail", a.tunnel.ready ? `${a.tunnel.connections} connection(s) → ${a.tunnel.hostnames.join(", ")}` : (a.tunnel.error ?? "tunnel not ready — check CLOUDFLARE_TUNNEL_TOKEN and `docker logs ${cfg.cloudflared.container}`"), true);
  for (const x of a.apps) {
    add("apps", `${x.name}: container`, x.container?.state === "running" ? "pass" : "fail", x.container ? `${x.containerName}: ${x.container.state}` : `${x.containerName} not found (docker ps)`, true);
    add("apps", `${x.name}: directus (local)`, x.local.ok ? "pass" : "fail", x.local.ok ? `${x.url} healthy (${x.local.latencyMs} ms)` : `${x.url}: ${x.local.error ?? "not healthy"}`, true);
    add("apps", `${x.name}: directus (public)`, x.public.ok === true ? "pass" : x.public.ok === null ? "warn" : "fail", x.public.ok === true ? `${x.publicUrl} answers over HTTPS (${x.public.latencyMs} ms)${x.public.note ? ` — ${x.public.note}` : ""}` : (x.public.note ?? `${x.publicUrl} not reachable — DNS/tunnel hostname missing?`));
    add("apps", `${x.name}: database`, x.database.exists ? "pass" : "fail", x.database.exists ? `"${x.db}": ${x.database.collections ?? 0} collections, ${x.database.users ?? 0} users` : (x.database.error ?? `database "${x.db}" missing — scripts/add-app.sh ${x.name}`), true);
    const port = Number(new URL(x.url).port || 80);
    const binds = await portBinds(port);
    if (binds !== null) add("apps", `${x.name}: port ${port} loopback only`, binds.every((b) => b.startsWith("127.") || b === "::1") && binds.length ? "pass" : "fail", binds.length ? binds.join(", ") : "not listening", true);
    const ageH = x.backup.latest ? (Date.now() - Date.parse(x.backup.latest)) / 3600_000 : null;
    add("apps", `${x.name}: backup`, ageH !== null && ageH < 48 ? "pass" : "warn", ageH !== null ? `${x.backup.count} dump(s), newest ${ageH.toFixed(0)} h ago in ${cfg.pgBackupDir}` : `no dumps for "${x.db}" in ${cfg.pgBackupDir} — schedule scripts/pg-backup.sh`);
  }
} else add("apps", "apps", "warn", "APPS is empty — no Directus-per-app instances configured (SERVER_SETUP § 5)");

// ---- public DNS: nameservers, DNSSEC, proxied vs DNS-only per hostname (SERVER_SETUP § 5.0a) --
// Asked over DNS-over-HTTPS first so the answer is the public one (not the LAN resolver's) and
// DNSSEC validation (AD) is visible; when DoH is blocked (corporate networks, Pi-hole rules) the
// name/address checks fall back to plain DNS against 1.1.1.1 / 8.8.8.8 and only DNSSEC is skipped.

async function doh(name: string, type: RRName): Promise<DohResponse | null> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
    return res.ok ? ((await res.json()) as DohResponse) : null;
  } catch {
    return null;
  }
}
const plainResolver = new dns.Resolver({ timeout: 4000, tries: 2 });
plainResolver.setServers(["1.1.1.1", "8.8.8.8"]);
let dohWorks: boolean | null = null;
/** answers of `type` for `name`; null = no resolver reachable at all */
async function lookup(name: string, type: "NS" | "A"): Promise<string[] | null> {
  if (dohWorks !== false) {
    const r = await doh(name, type);
    if (r) {
      dohWorks = true;
      return readDoh(r, RR[type]).answers;
    }
    dohWorks = false;
  }
  try {
    const out = type === "NS" ? await plainResolver.resolveNs(name) : await plainResolver.resolve4(name);
    return out.map((x) => x.replace(/\.$/, "").toLowerCase());
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? [] : null;
  }
}

if (cfg.publicDomain) {
  const dom = cfg.publicDomain;
  const servers = await lookup(dom, "NS");
  if (servers === null) add("dns", "resolver", "warn", "neither cloudflare-dns.com (DoH) nor 1.1.1.1/8.8.8.8 (plain DNS) answered — no internet from here? [dns] checks skipped");
  else {
    const onCloudflare = servers.length > 0 && servers.every((s) => /(^|\.)ns\.cloudflare\.com$/i.test(s));
    add("dns", `${dom}: nameservers`, onCloudflare ? "pass" : "fail", servers.length ? `${servers.join(", ")}${onCloudflare ? "" : " — not Cloudflare's yet. Finish SERVER_SETUP § 5.0a (DNSSEC off at the registrar first, then switch the nameservers)"}` : "no NS answer", cfg.apps.length > 0);
    if (dohWorks) {
      const [ds, a] = await Promise.all([doh(dom, "DS"), doh(dom, "A")]);
      const v = dnssecVerdict({ rcode: readDoh(a, RR.A).rcode, ad: !!a?.AD, dsAtParent: readDoh(ds, RR.DS).answers.length > 0 });
      add("dns", `${dom}: dnssec`, v.status, v.detail, v.status === "fail");
    } else add("dns", `${dom}: dnssec`, "warn", `DNS-over-HTTPS is blocked from here, so DNSSEC was not checked — by hand: dig +short DS ${dom} @1.1.1.1 must print nothing before the nameservers move (SERVER_SETUP § 5.0a step 2)`);
    for (const app of cfg.apps) {
      if (app.publicUrl) {
        const host = new URL(app.publicUrl).host;
        const ips = await lookup(host, "A");
        const pv = proxiedVerdict(ips ?? [], true);
        add("dns", `${app.name}: ${host}`, ips === null ? "warn" : ips.length ? pv.status : "fail", ips === null ? "lookup failed" : ips.length ? pv.detail : "no record — add the public hostname under the tunnel (Zero Trust → Networks → Tunnels → Public Hostname)", ips !== null);
      }
      if (app.siteUrl) {
        const host = new URL(app.siteUrl).host;
        const ips = await lookup(host, "A");
        add("dns", `${app.name}: site ${host}`, ips?.length ? "pass" : "warn", ips?.length ? `→ ${ips.join(", ")} (the app's front-end — not a tunnel hostname)` : "no record — fine until the app has a front-end");
      }
    }
    if (cfg.minecraft.publicAddress) {
      const host = hostOf(cfg.minecraft.publicAddress);
      const ips = await lookup(host, "A");
      const pv = proxiedVerdict(ips ?? [], false);
      add("dns", `minecraft: ${host}`, ips?.length ? pv.status : "warn", ips?.length ? pv.detail : "no A record for MC_PUBLIC_ADDRESS", !!ips?.length);
    }
  }
} else add("dns", "dns", "skip", "PUBLIC_DOMAIN not set — no public hostnames to check");

// ---- staged updates ------------------------------------------------------------------

const pluginsDir = path.join(cfg.minecraft.dir, "plugins");
const pluginJars = (await fs.readdir(pluginsDir).catch(() => [] as string[])).filter((n) => /\.jar$/i.test(n));
add("updates", "plugins folder", pluginJars.length ? "pass" : "warn", pluginJars.length ? `${pluginsDir}: ${pluginJars.length} jar(s)` : `${pluginsDir}: no plugin jars found`);
const paperJar = (await fs.readdir(cfg.minecraft.dir).catch(() => [] as string[])).find((n) => /^(paper|purpur|folia).*\.jar$/i.test(n));
add("updates", "paper jar", paperJar ? "pass" : "warn", paperJar ?? `no paper-*.jar in ${cfg.minecraft.dir} — the widget falls back to version_history.json`);
const stagingCandidates = cfg.updates.stagingDir ? [cfg.updates.stagingDir] : ["plugins/update", "updates", "staged", "staging"].map((d) => path.join(cfg.minecraft.dir, d));
const stagingFound: string[] = [];
for (const c of stagingCandidates) if (await exists(c)) stagingFound.push(c);
add("updates", "staging folder", stagingFound.length ? "pass" : "warn", stagingFound.length ? stagingFound.join(", ") : "none of the usual staging folders exist — set UPDATE_STAGING_DIR to where the update-fetch job writes (read its script)");

// ---- data dir: demo leakage ------------------------------------------------------

const demoDir = path.join(cfg.dataDir, "demo");
add("data", "demo folder", (await exists(demoDir)) ? "fail" : "pass", (await exists(demoDir)) ? `${demoDir} exists — run: npm run clear-demo-data -- --yes` : "none", true);
interface JobRec {
  id: string;
  name: string;
  type: string;
  cron: string;
  enabled: boolean;
  seeded?: boolean;
  options: { timer?: string; script?: string; managedBy?: string; command?: string; cronSource?: string };
}
const jobs = await readJson<JobRec[]>(path.join(cfg.dataDir, "jobs.json"), []);
const seeded = jobs.filter((j) => j.seeded || ["Nightly world backup", "Daily restart"].includes(j.name));
add("data", "seeded demo jobs", seeded.length ? "fail" : "pass", seeded.length ? `${seeded.map((j) => `"${j.name}"`).join(", ")} — run: npm run clear-demo-data -- --yes` : "none", true);

// ---- the real schedule: systemd timers + crontabs ------------------------------------

interface Timer {
  unit: string;
  activates: string;
  nextMs: number | null;
  lastMs: number | null;
}

async function timestampMs(v: string | null): Promise<number | null> {
  const direct = parseSystemdTimestamp(v);
  if (direct !== null || !v || v === "n/a") return direct;
  const out = await sh("date", ["-d", v, "+%s"]); // GNU date understands systemd's "Thu 2026-10-16 04:00:00 CEST"
  return out && /^\d+/.test(out.trim()) ? Number(out.trim()) * 1000 : null;
}

async function listTimers(): Promise<Timer[]> {
  const json = await sh("systemctl", ["list-timers", "--all", "--no-pager", "--output=json"]);
  if (json) {
    try {
      const rows = JSON.parse(json) as { unit: string; activates: string; next?: string | number | null; last?: string | number | null }[];
      return rows.map((t) => ({ unit: t.unit, activates: t.activates, nextMs: parseSystemdTimestamp(t.next ?? null), lastMs: parseSystemdTimestamp(t.last ?? null) }));
    } catch {
      // fall through to the text format
    }
  }
  // systemd < 246 has no JSON output: UNIT and ACTIVATES are the last two columns.
  const text = await sh("systemctl", ["list-timers", "--all", "--no-pager", "--no-legend"]);
  if (!text) return [];
  const timers: Timer[] = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || !cols[cols.length - 2].endsWith(".timer")) continue;
    const u = cols[cols.length - 2];
    const next = (await sh("systemctl", ["show", u, "-p", "NextElapseUSecRealtime", "--value", "--no-pager"]))?.trim() ?? null;
    timers.push({ unit: u, activates: cols[cols.length - 1], nextMs: await timestampMs(next), lastMs: null });
  }
  return timers;
}

/** "1h 30min", "45s", "0" → ms (systemd span syntax, the common cases). */
function spanMs(s: string): number {
  let ms = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|us|usec|msec|s|sec|min|m|h|hr|d|w)?\b/g)) {
    const n = Number(m[1]);
    const u = m[2] ?? "s";
    ms += n * (u === "us" || u === "usec" ? 0.001 : u === "ms" || u === "msec" ? 1 : u === "min" || u === "m" ? 60_000 : u === "h" || u === "hr" ? 3_600_000 : u === "d" ? 86_400_000 : u === "w" ? 604_800_000 : 1000);
  }
  return ms;
}

const timers = await listTimers();
const relevant = timers.filter((t) => isRelevant(`${t.unit} ${t.activates}`, t.unit));

async function readCron(): Promise<{ entries: CronEntry[]; notes: string[] }> {
  const entries: CronEntry[] = [];
  const notes: string[] = [];
  const me = os.userInfo().username;
  const mine = await run("crontab", ["-l"]);
  if (mine.ok) entries.push(...parseCrontab(mine.stdout, `crontab (${me})`, { user: me }));
  const etc = await fs.readFile("/etc/crontab", "utf8").catch(() => null);
  if (etc) entries.push(...parseCrontab(etc, "/etc/crontab", { systemTable: true }));
  for (const f of await ls("/etc/cron.d")) {
    if (f.startsWith(".") || /\.(dpkg-\w+|rpm\w*|bak|disabled|orig)$/.test(f)) continue;
    const t = await fs.readFile(path.join("/etc/cron.d", f), "utf8").catch(() => null);
    if (t) entries.push(...parseCrontab(t, `/etc/cron.d/${f}`, { systemTable: true }));
  }
  // Other users' crontabs need root: root's and the Minecraft folder owner's.
  const users = new Set<string>(["root"]);
  const uid = (await statOrNull(cfg.minecraft.dir))?.uid ?? null;
  if (uid !== null) {
    const name = (await sh("id", ["-nu", String(uid)]))?.trim();
    if (name) users.add(name);
  }
  for (const u of users) {
    if (u === me) continue;
    const r = await run("sudo", ["-n", "crontab", "-l", "-u", u]);
    if (r.ok) entries.push(...parseCrontab(r.stdout, `crontab (${u})`, { user: u }));
    else if (!/no crontab for/i.test(r.stderr)) notes.push(`could not read ${u}'s crontab without a password — check by hand: sudo crontab -l -u ${u}`);
  }
  return { entries: entries.filter((e) => isRelevant(e.command)), notes };
}
const cron = await readCron();

add("jobs", "real schedule found", relevant.length || cron.entries.length ? "pass" : "warn", `${relevant.length} relevant timer(s)${relevant.length ? `: ${relevant.map((t) => t.unit).join(", ")}` : ""}; ${cron.entries.length} relevant cron entr${cron.entries.length === 1 ? "y" : "ies"}${cron.entries.length ? `: ${cron.entries.map((e) => `${e.source} → ${e.script ? path.basename(e.script) : e.command.slice(0, 40)}`).join(", ")}` : ""}`);
for (const note of cron.notes) add("jobs", "crontab access", "warn", note);

// ---- jobs vs real timers / cron ------------------------------------------------------------

const externals = jobs.filter((j) => j.type === "external");
add("jobs", "external mirror jobs", externals.length ? "pass" : relevant.length || cron.entries.length ? "fail" : "warn", externals.length ? externals.map((j) => `"${j.name}" (${j.cron})`).join("; ") : relevant.length || cron.entries.length ? "none, but a real schedule exists — run: npm run discover" : "none, and no relevant timers or cron entries found", true);

const unmirrored = relevant.filter((t) => !externals.some((j) => j.options.timer === t.unit));
if (relevant.length) add("jobs", "timers mirrored", unmirrored.length ? "fail" : "pass", unmirrored.length ? `not mirrored: ${unmirrored.map((t) => t.unit).join(", ")} — run: npm run discover` : `all ${relevant.length} relevant timer(s) mirrored`, true);

const unmirroredCron = cron.entries.filter((e) => e.cron && !externals.some((j) => jobMatchesCronEntry(j, e)));
if (cron.entries.length) add("jobs", "cron entries mirrored", unmirroredCron.length ? "fail" : "pass", unmirroredCron.length ? `not mirrored: ${unmirroredCron.map((e) => `${e.source}: ${e.line}`).join(" | ")} — run: npm run discover` : `all ${cron.entries.length} relevant cron entr${cron.entries.length === 1 ? "y" : "ies"} mirrored`, true);

for (const j of externals) {
  if (j.options.timer) {
    const service = j.options.timer.replace(/\.timer$/, ".service");
    const exec = (await sh("systemctl", ["show", service, "-p", "ExecStart", "--no-pager"])) ?? "";
    add("jobs", `output tracking: ${j.name}`, /hl-run/.test(exec) ? "pass" : "fail", /hl-run/.test(exec) ? `${service} runs through hl-run` : `${service} does not run through hl-run — sudo npm run wrap-service -- ${service} --apply --test`, true);

    // Does the dashboard's cron expression agree with systemd about the next run?
    const t = timers.find((x) => x.unit === j.options.timer);
    if (!t) {
      add("jobs", `schedule: ${j.name}`, "fail", `${j.options.timer} is not a timer on this machine (systemctl list-timers --all)`, true);
      continue;
    }
    const [cronNext] = nextRunOf(j.cron, cfg.timezone);
    if (!cronNext) add("jobs", `schedule: ${j.name}`, "fail", `"${j.cron}" is not a valid cron expression`, true);
    else if (t.nextMs === null) add("jobs", `schedule: ${j.name}`, "warn", `${t.unit} reports no next run (inactive?) — cannot verify "${j.cron}"`);
    else {
      const jitter = spanMs(((await sh("systemctl", ["show", t.unit, "-p", "RandomizedDelayUSec", "--value", "--no-pager"])) ?? "0").trim());
      const diff = cronNext.getTime() - t.nextMs;
      const ok = Math.abs(diff) <= 60_000 + jitter;
      add("jobs", `schedule: ${j.name}`, ok ? "pass" : "fail", ok ? `"${j.cron}" agrees with systemd — next ${when(t.nextMs)}` : `"${j.cron}" → next ${when(cronNext.getTime())}, but systemd says ${when(t.nextMs)} (${fmtDelta(diff)} apart) — fix the schedule or TZ`, true);
    }
  } else {
    const entry = cron.entries.find((e) => jobMatchesCronEntry(j, e));
    if (entry) add("jobs", `output tracking: ${j.name}`, entry.wrapped ? "pass" : "fail", entry.wrapped ? `${entry.source} line runs through hl-run` : `${entry.source} line is not wrapped — replace it with:\n      ${wrappedCronLine(entry)}`, true);
    else if (j.options.script) add("jobs", `output tracking: ${j.name}`, "warn", `cron-managed but no matching crontab line is readable here; confirmed only once ${j.options.script} output has been seen via hl-run`);
    else add("jobs", `output tracking: ${j.name}`, "warn", "cron-managed with no script name or command — the dashboard cannot tell whether it ran");
  }
}
const enabledBuiltins = jobs.filter((j) => j.enabled && (j.type === "backup" || j.type === "restart"));
if (enabledBuiltins.length) add("jobs", "enabled built-in jobs", "warn", `${enabledBuiltins.map((j) => `"${j.name}"`).join(", ")} run from the dashboard — make sure they don't duplicate a timer/cron`);

// ---- alerts ingestion (needs the dashboard running) ---------------------------------

const base = `http://${cfg.host}:${cfg.port}`;
const auth = { Authorization: `Bearer ${cfg.dashboardKey ?? ""}`, "X-Homelab-Agent": "audit-install" };
let serverUp = false;
try {
  serverUp = (await fetch(`${base}/api/health`, { headers: auth, signal: AbortSignal.timeout(3000) })).ok;
} catch {
  serverUp = false;
}
if (!serverUp) add("alerts", "ingestion test", "fail", `dashboard not reachable at ${base} (is homelab-dashboard running?)`, true);
else {
  const marker = `audit-install ${Date.now()}`;
  try {
    await fetch(`${base}/api/alerts/ingest?label=audit-install`, { method: "POST", headers: auth, body: `${marker}\n`, signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 800));
    const events = (await (await fetch(`${base}/api/alerts?sources=scripts&limit=50`, { headers: auth })).json()) as { text: string }[];
    const seen = events.some((e) => e.text.includes(marker));
    add("alerts", "ingestion test", seen ? "pass" : "fail", seen ? "test event appeared in the feed" : "test event not seen in the feed", true);
  } catch (e) {
    add("alerts", "ingestion test", "fail", (e as Error).message, true);
  }
}
const hlRunInstalled = await exists("/usr/local/bin/hl-run");
const hlEnv = await exists("/etc/homelab-hl-run.env");
add("alerts", "hl-run installed", hlRunInstalled ? "pass" : relevant.length || cron.entries.length ? "fail" : "warn", hlRunInstalled ? `/usr/local/bin/hl-run${hlEnv ? " + /etc/homelab-hl-run.env" : " (no /etc/homelab-hl-run.env — cron lines must export HOMELAB_KEY themselves)"}` : "missing — sudo npm run wrap-service -- --install-hl-run", relevant.length > 0 || cron.entries.length > 0);

// ---- VPN -------------------------------------------------------------------------

const links = (await sh("ip", ["-d", "-j", "link", "show"])) ?? "[]";
let vpnIfaces: string[] = [];
try {
  vpnIfaces = (JSON.parse(links) as { ifname: string; linkinfo?: { info_kind?: string } }[]).filter((l) => l.ifname !== "tailscale0" && (l.linkinfo?.info_kind === "wireguard" || l.linkinfo?.info_kind === "tun" || /^(wg|tun|nordlynx|proton|mullvad)/i.test(l.ifname))).map((l) => l.ifname);
} catch {
  vpnIfaces = [];
}
add("vpn", "vpn interface", vpnIfaces.length ? "pass" : "warn", vpnIfaces.length ? vpnIfaces.join(", ") + (cfg.vpn.iface ? ` (VPN_INTERFACE=${cfg.vpn.iface})` : " — set VPN_INTERFACE") : "no wireguard/tun interface found (VPN down, or VPN_PROVIDER/INTERFACE needed)");

// ---- discovery: script folders, backup roots, mirror jobs ---------------------------------------

interface Proposal {
  name: string;
  type: "external";
  cron: string | null;
  enabled: boolean;
  options: { managedBy: string; timer?: string; cronSource?: string; command: string; script?: string; graceMinutes: number };
  note?: string;
}
interface BackupRoot {
  path: string;
  dated: number;
  dashboard: number;
  archive: number;
  total: number;
}

const DATED_RE = /^mcworld_\d{4}_\d{2}_\d{2}$/;
const DASH_RE = /^mc-\d{8}-\d{6}\.tar\.gz$/;

const SYSTEM_PATH_RE = /^\/(proc|sys|dev|usr|bin|sbin|lib|lib64|etc|tmp|run|boot|snap|var\/(log|lib|cache|run|tmp))(\/|$)/;

/** Absolute paths a script mentions (quoted ones may contain spaces) — the folder itself and its parent, unverified. */
async function pathsMentionedIn(file: string): Promise<string[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  if (!text || text.length > 400_000) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(/["'](\/[^"'\n{}%$]{2,200})["']|(?<=[\s=(,])(\/[\w./-]{2,200})/g)) {
    const raw = (m[1] ?? m[2]).replace(/\/+$/, "");
    for (const candidate of [raw, path.dirname(raw)]) if (candidate.length > 1 && !SYSTEM_PATH_RE.test(candidate)) found.add(candidate);
  }
  return [...found];
}

/**
 * Look for backup-shaped entries under the usual places and the paths the scripts
 * mention. Runs `find` as one child process per start path, each with a hard
 * timeout, so a dead NFS/autofs mount stalls one probe instead of wedging the
 * audit (direct fs calls on a stuck mount park a Node I/O thread for good).
 */
async function discoverBackupRoots(hints: Iterable<string>): Promise<BackupRoot[]> {
  const mc = cfg.minecraft.dir;
  const starts = [...new Set([...cfg.backups.dirs, mc, path.dirname(mc), "/home", "/root", "/mnt", "/media", "/srv", "/opt", "/var/backups", "/backup", "/backups", os.homedir(), ...hints])].filter((p) => path.isAbsolute(p) && !SYSTEM_PATH_RE.test(p)).slice(0, 60);
  const expr = [
    "-mindepth", "1", "-maxdepth", "4",
    "(", "-name", "node_modules", "-o", "-name", ".git", "-o", "-name", ".cache", "-o", "-name", "Library", "-o", "-name", "snap", "-o", "-name", "proc", ")", "-prune", "-o",
    "(",
      "(", "-type", "d", "-name", "mcworld_[0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]", ")",
      "-o", "(", "-type", "f", "-name", "mc-[0-9]*-[0-9]*.tar.gz", ")",
      "-o", "(", "-type", "f", "(", "-iname", "*world*.tar*", "-o", "-iname", "*world*.zip", "-o", "-iname", "*minecraft*.tar*", "-o", "-iname", "*minecraft*.zip", "-o", "-iname", "*mc*backup*", "-o", "-iname", "*backup*mc*", ")", ")",
    ")", "-print0",
  ];
  const probe = async (start: string): Promise<string[]> => {
    const child = execFileP("find", [start, ...expr], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 8 << 20 }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
    return (await withTimeout(child, "", 25_000)).split("\0").filter(Boolean);
  };
  const results = await Promise.all(starts.map(probe));
  const byRoot = new Map<string, BackupRoot>();
  for (const p of new Set(results.flat())) {
    const name = path.basename(p);
    const root = path.dirname(p);
    if (DATED_RE.test(path.basename(root))) continue; // archives inside mcworld_…/ belong to that folder, not a root of their own
    const entry = byRoot.get(root) ?? { path: root, dated: 0, dashboard: 0, archive: 0, total: 0 };
    if (DATED_RE.test(name)) entry.dated++;
    else if (DASH_RE.test(name)) entry.dashboard++;
    else entry.archive++;
    entry.total++;
    byRoot.set(root, entry);
  }
  return [...byRoot.values()].sort((a, b) => b.total - a.total);
}

const proposals: Proposal[] = [];
const suggestedScriptDirs = new Set<string>();
const scriptFiles = new Set<string>();
let backupRoots: BackupRoot[] = [];
const envSuggestions: string[] = [];

if (propose) {
  // scripts the real schedule runs
  const noteScript = (p: string | null) => {
    if (!p) return;
    if (path.isAbsolute(p)) {
      suggestedScriptDirs.add(path.dirname(p));
      scriptFiles.add(p);
    }
  };
  for (const t of unmirrored) {
    const cal = ((await sh("systemctl", ["show", t.unit, "-p", "TimersCalendar", "--value", "--no-pager"])) ?? "").match(/OnCalendar=([^;}]+)/)?.[1]?.trim() ?? "";
    const exec = ((await sh("systemctl", ["cat", t.activates, "--no-pager"])) ?? "").split("\n").filter((l) => /^\s*ExecStart=/.test(l)).pop()?.replace(/^\s*ExecStart=/, "").trim() ?? "";
    const scriptPath = scriptPathFromCommand(exec);
    noteScript(scriptPath);
    let cronExpr = calendarToCron(cal);
    let note: string | undefined;
    if (!cronExpr) note = `OnCalendar "${cal}" could not be translated to cron — set the schedule by hand`;
    else if (t.nextMs !== null) {
      const [next] = nextRunOf(cronExpr, cfg.timezone);
      const jitter = spanMs(((await sh("systemctl", ["show", t.unit, "-p", "RandomizedDelayUSec", "--value", "--no-pager"])) ?? "0").trim());
      if (next && Math.abs(next.getTime() - t.nextMs) > 60_000 + jitter) {
        note = `translated "${cal}" → "${cronExpr}" but systemd's next run is ${when(t.nextMs)} (cron says ${when(next.getTime())}) — set the schedule by hand`;
        cronExpr = null;
      } else if (next) note = `verified: next run ${when(t.nextMs)} matches systemd`;
    }
    proposals.push({
      name: t.unit.replace(/\.timer$/, "").replace(/[-_]/g, " "),
      type: "external",
      cron: cronExpr,
      enabled: true,
      options: { managedBy: "systemd timer", timer: t.unit, command: exec, script: scriptPath ? path.basename(scriptPath) : undefined, graceMinutes: 30 },
      note,
    });
  }
  for (const e of unmirroredCron) {
    noteScript(e.script);
    const base = e.script ? path.basename(e.script).replace(/\.(py|sh)$/, "").replace(/[-_]/g, " ") : normalizeCommand(e.command).split(" ").slice(0, 3).join(" ");
    proposals.push({
      name: `${base} (${e.user ?? "cron"})`,
      type: "external",
      cron: e.cron,
      enabled: true,
      options: { managedBy: "cron", cronSource: e.source, command: normalizeCommand(e.command), script: e.script ? path.basename(e.script) : undefined, graceMinutes: 30 },
      note: e.wrapped ? "already wrapped with hl-run" : `not wrapped — in ${e.source} replace the line with:\n#   ${wrappedCronLine(e)}`,
    });
  }
  for (const s of scripts.scripts) scriptFiles.add(path.join(s.dir, s.name));
  for (const dir of suggestedScriptDirs) for (const f of await ls(dir)) if (/\.(py|sh)$/.test(f)) scriptFiles.add(path.join(dir, f));
  for (const f of scriptFiles) if (SYSTEM_PATH_RE.test(f)) scriptFiles.delete(f);

  // backup roots: folders the scripts mention + the usual places
  const hints = new Set<string>();
  for (const f of scriptFiles) for (const p of await pathsMentionedIn(f)) hints.add(p);
  backupRoots = await discoverBackupRoots(hints);

  const configuredScriptDirsOk = scripts.dirs.length > 0 && scripts.dirs.every((d) => d.exists);
  const scriptDirsToSuggest = [...new Set([...(configuredScriptDirsOk ? scripts.dirs.map((d) => d.path) : []), ...suggestedScriptDirs])];
  if (scriptDirsToSuggest.length && (!configuredScriptDirsOk || [...suggestedScriptDirs].some((d) => !scripts.dirs.some((x) => x.path === d)))) envSuggestions.push(`SCRIPTS_DIR=${shq(scriptDirsToSuggest.join(","))}`);

  const configuredRootsOk = backups.roots.length > 0 && backups.roots.every((r) => r.exists && r.count > 0);
  if (backupRoots.length && (!configuredRootsOk || !backupRoots.some((r) => cfg.backups.dirs.includes(r.path)))) {
    const best = backupRoots[0];
    envSuggestions.push(`BACKUP_DIR=${shq(backupRoots.filter((r) => r.total >= Math.max(1, best.total / 4)).map((r) => r.path).join(","))}`);
    if (best.dated >= best.dashboard && best.dated >= best.archive) envSuggestions.push("BACKUP_FORMAT=dated-folder");
  }
  const backupScript = [...scriptFiles].map((f) => path.basename(f)).find((n) => /backup/i.test(n));
  if (backupScript && cfg.backups.method === "builtin") envSuggestions.push(`BACKUP_METHOD=script:${backupScript}`);
}

// ---- report ------------------------------------------------------------------------

const gates = checks.filter((c) => c.gate);
const fullyConnected = gates.every((c) => c.status === "pass");
const fails = checks.filter((c) => c.status === "fail").length;

if (asJson) {
  console.log(JSON.stringify({ fullyConnected, checks, proposals, envSuggestions, suggestedScriptDirs: [...suggestedScriptDirs], backupRoots, timers: relevant, cron: cron.entries }, null, 2));
} else {
  const icon: Record<Status, string> = { pass: "✔", warn: "!", fail: "✖", skip: "·" };
  let area = "";
  for (const c of checks) {
    if (c.area !== area) {
      area = c.area;
      console.log(`\n[${area}]`);
    }
    console.log(`  ${icon[c.status]} ${c.name.padEnd(34)} ${c.detail}${c.gate ? "" : "  (advisory)"}`);
  }
  console.log(`\n${fullyConnected ? "FULLY CONNECTED — every gated check passed." : `NOT fully connected — ${fails} failure(s). Fix the ✖ lines above (gated ones block the verdict).`}`);
  if (propose) {
    console.log("\n== Discovered ==");
    console.log(`timers: ${relevant.length ? relevant.map((t) => `${t.unit}${t.nextMs ? ` (next ${when(t.nextMs)})` : ""}`).join(", ") : "none relevant"}`);
    console.log(`cron:   ${cron.entries.length ? cron.entries.map((e) => `${e.source}: ${e.line}`).join("\n        ") : "none relevant"}`);
    console.log(`backup roots: ${backupRoots.length ? backupRoots.map((r) => `${r.path} (${[r.dated && `${r.dated} dated folders`, r.dashboard && `${r.dashboard} dashboard archives`, r.archive && `${r.archive} archives`].filter(Boolean).join(", ")})`).join("; ") : "none found — look for the mcworld_YYYY_MM_DD folders by hand"}`);
    console.log("\n== Proposed /etc/homelab-dashboard.env changes ==");
    console.log(envSuggestions.length ? envSuggestions.join("\n") : "(none — SCRIPTS_DIR / BACKUP_DIR already point at what was found)");
    console.log("\n== Proposed mirror jobs ==");
    if (!proposals.length) console.log("No unmirrored timers or cron entries.");
    for (const p of proposals) {
      console.log(`\n# ${p.options.timer ?? p.options.cronSource}${p.note ? `  — ${p.note}` : ""}`);
      console.log(JSON.stringify({ name: p.name, type: p.type, cron: p.cron ?? "0 4 * * *", enabled: p.enabled, options: p.options }));
    }
    if (proposals.length && !applyProposals) console.log("\nRe-run with --apply to create these jobs in the running dashboard (fix any untranslated schedules first).");
  }
}

if (propose && applyProposals) {
  if (!serverUp) console.log(`\nCannot apply: dashboard not reachable at ${base}. Start it (sudo systemctl start homelab-dashboard) and re-run.`);
  for (const p of proposals) {
    if (!serverUp) break;
    if (!p.cron) {
      console.log(`skip ${p.options.timer ?? p.options.cronSource}: schedule needs manual entry`);
      continue;
    }
    const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ name: p.name, type: p.type, cron: p.cron, enabled: p.enabled, options: p.options }) });
    console.log(`${res.ok ? "created" : `failed (${res.status}: ${(await res.text()).slice(0, 200)})`}: ${p.name}`);
  }
}

// Let piped stdout drain before exiting (on macOS pipe writes are asynchronous and
// process.exit() would truncate the report).
process.stdout.write("", () => process.exit(fullyConnected ? 0 : 1));

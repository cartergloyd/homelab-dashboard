#!/usr/bin/env node
// Production install audit (issue #2). Checks the configured service names,
// paths, timers, backup roots, scripts folders and DATA_DIR against the live
// machine, and only says FULLY CONNECTED when status, jobs, scripts, backups and
// alerts ingestion all pass. --propose discovers systemd timers / script folders /
// backup roots and prints suggested env values and `external` mirror jobs;
// --apply (with --propose) creates those jobs through the running dashboard.
//
//   npm run audit:install                 # audit against /etc/homelab-dashboard.env
//   npm run audit:install -- --json       # machine-readable (for agents)
//   npm run discover                      # = audit --propose
//   npm run discover -- --apply           # create the proposed mirror jobs
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { envFileFromArgs, flag, loadEnvFile } from "./env.js";

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
const { listBackups } = await import("../services/backups.js");
const { directusHealth } = await import("../services/directus.js");
const { pgStats } = await import("../services/postgres.js");
const { tailscaleStatus } = await import("../services/tailscale.js");

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

async function sh(cmd: string, args: string[], timeout = 8000): Promise<string | null> {
  try {
    return (await execFileP(cmd, args, { timeout, maxBuffer: 1 << 20 })).stdout;
  } catch {
    return null;
  }
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

// ---- environment --------------------------------------------------------------

add("env", "env file", envLoaded ? "pass" : "fail", envLoaded ? envFile : `${envFile} not found (pass --env FILE)`, true);
add("env", "demo flags", cfg.demo || cfg.authDisabled ? "fail" : "pass", cfg.demo || cfg.authDisabled ? "DEMO and/or AUTH_DISABLED are set — never on the server" : "DEMO / AUTH_DISABLED unset", true);
add("env", "dashboard key", !cfg.dashboardKey ? "fail" : cfg.dashboardKey === "demo-key-not-secret" ? "fail" : "pass", !cfg.dashboardKey ? "DASHBOARD_KEY unset" : cfg.dashboardKey === "demo-key-not-secret" ? "DASHBOARD_KEY is the demo key" : "set", true);

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
const worlds: string[] = [];
for (const w of ["world", "world_nether", "world_the_end"]) if (await exists(path.join(cfg.minecraft.dir, w))) worlds.push(w);
add("status", "world folders", worlds.length ? "pass" : "warn", worlds.length ? worlds.join(", ") : `none of world/world_nether/world_the_end in ${cfg.minecraft.dir} — check level-name`);

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
    await fs.access(r.path, (await import("node:fs")).constants.W_OK);
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
  options: { timer?: string; script?: string; managedBy?: string; command?: string };
}
const jobs = await readJson<JobRec[]>(path.join(cfg.dataDir, "jobs.json"), []);
const seeded = jobs.filter((j) => j.seeded || ["Nightly world backup", "Daily restart"].includes(j.name));
add("data", "seeded demo jobs", seeded.length ? "fail" : "pass", seeded.length ? `${seeded.map((j) => `"${j.name}"`).join(", ")} — run: npm run clear-demo-data -- --yes` : "none", true);

// ---- jobs vs real timers -----------------------------------------------------------

interface Timer {
  unit: string;
  activates: string;
  next: string | null;
  last: string | null;
}
const timersRaw = await sh("systemctl", ["list-timers", "--all", "--no-pager", "--output=json"]);
let timers: Timer[] = [];
if (timersRaw) {
  try {
    timers = (JSON.parse(timersRaw) as { unit: string; activates: string; next?: string | number | null; last?: string | number | null }[]).map((t) => ({
      unit: t.unit,
      activates: t.activates,
      next: t.next ? String(t.next) : null,
      last: t.last ? String(t.last) : null,
    }));
  } catch {
    timers = [];
  }
}
const relevant = timers.filter((t) => /mine|mc|paper|backup|update|restart|world|server/i.test(`${t.unit} ${t.activates}`) && !/apt|snapd|logrotate|man-db|fstrim|motd|e2scrub|systemd-|dpkg|ua-|fwupd/i.test(t.unit));
const externals = jobs.filter((j) => j.type === "external");
add("jobs", "external mirror jobs", externals.length ? "pass" : relevant.length ? "fail" : "warn", externals.length ? externals.map((j) => `"${j.name}" (${j.cron})`).join("; ") : relevant.length ? `none, but ${relevant.length} relevant timer(s) exist — run: npm run discover` : "none, and no relevant timers found", true);
const unmirrored = relevant.filter((t) => !externals.some((j) => j.options.timer === t.unit));
if (relevant.length) add("jobs", "timers mirrored", unmirrored.length ? "fail" : "pass", unmirrored.length ? `not mirrored: ${unmirrored.map((t) => t.unit).join(", ")}` : `all ${relevant.length} relevant timer(s) mirrored`, true);
for (const j of externals) {
  if (j.options.timer) {
    const exec = (await sh("systemctl", ["show", j.options.timer.replace(/\.timer$/, ".service"), "-p", "ExecStart", "--no-pager"])) ?? "";
    add("jobs", `output tracking: ${j.name}`, /hl-run/.test(exec) ? "pass" : "fail", /hl-run/.test(exec) ? `${j.options.timer} wraps hl-run` : `${j.options.timer} does not run through hl-run — npm run wrap-service -- ${j.options.timer}`, true);
  } else if (j.options.script) {
    add("jobs", `output tracking: ${j.name}`, "warn", `cron-managed; confirmed only once ${j.options.script} output has been seen via hl-run`);
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

// ---- VPN -------------------------------------------------------------------------

const links = (await sh("ip", ["-d", "-j", "link", "show"])) ?? "[]";
let vpnIfaces: string[] = [];
try {
  vpnIfaces = (JSON.parse(links) as { ifname: string; linkinfo?: { info_kind?: string } }[]).filter((l) => l.ifname !== "tailscale0" && (l.linkinfo?.info_kind === "wireguard" || l.linkinfo?.info_kind === "tun" || /^(wg|tun|nordlynx|proton|mullvad)/i.test(l.ifname))).map((l) => l.ifname);
} catch {
  vpnIfaces = [];
}
add("vpn", "vpn interface", vpnIfaces.length ? "pass" : "warn", vpnIfaces.length ? vpnIfaces.join(", ") + (cfg.vpn.iface ? ` (VPN_INTERFACE=${cfg.vpn.iface})` : " — set VPN_INTERFACE") : "no wireguard/tun interface found (VPN down, or VPN_PROVIDER/INTERFACE needed)");

// ---- proposals ---------------------------------------------------------------------

interface Proposal {
  name: string;
  type: "external";
  cron: string | null;
  enabled: boolean;
  options: { managedBy: string; timer: string; command: string; script?: string; graceMinutes: number };
  note?: string;
}

function calendarToCron(cal: string): string | null {
  const c = cal.trim();
  const dow: Record<string, string> = { Sun: "0", Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6" };
  if (/^daily$/i.test(c)) return "0 0 * * *";
  if (/^weekly$/i.test(c)) return "0 0 * * 1";
  if (/^hourly$/i.test(c)) return "0 * * * *";
  // [Dow[,Dow|..Dow]] [*-*-* ]HH:MM[:SS]
  const m = c.match(/^(?:([A-Za-z]{3}(?:[,.]{1,2}[A-Za-z]{3})*)\s+)?(?:\*-\*-(\*|\d{2})\s+)?(\*|\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const [, days, dom, hh, mm] = m;
  let dowField = "*";
  if (days) {
    if (days.includes("..")) {
      const [a, b] = days.split("..");
      if (!(a in dow) || !(b in dow)) return null;
      dowField = `${dow[a]}-${dow[b]}`;
    } else {
      const parts = days.split(",");
      if (!parts.every((p) => p in dow)) return null;
      dowField = parts.map((p) => dow[p]).join(",");
    }
  }
  return `${Number(mm)} ${hh === "*" ? "*" : Number(hh)} ${dom && dom !== "*" ? Number(dom) : "*"} * ${dowField}`;
}

const proposals: Proposal[] = [];
const suggestedScriptDirs = new Set<string>();
if (propose) {
  for (const t of unmirrored) {
    const cal = ((await sh("systemctl", ["show", t.unit, "-p", "TimersCalendar", "--value", "--no-pager"])) ?? "").match(/OnCalendar=([^;}]+)/)?.[1]?.trim() ?? "";
    const exec = ((await sh("systemctl", ["cat", t.activates, "--no-pager"])) ?? "").split("\n").filter((l) => /^\s*ExecStart=/.test(l)).pop()?.replace(/^\s*ExecStart=/, "").trim() ?? "";
    const scriptPath = exec.match(/((?:"[^"]+"|\S+)\.(?:py|sh))/)?.[1]?.replace(/^"|"$/g, "");
    if (scriptPath) suggestedScriptDirs.add(path.dirname(scriptPath));
    const cron = calendarToCron(cal);
    proposals.push({
      name: t.unit.replace(/\.timer$/, "").replace(/[-_]/g, " "),
      type: "external",
      cron,
      enabled: true,
      options: { managedBy: "systemd timer", timer: t.unit, command: exec, script: scriptPath ? path.basename(scriptPath) : undefined, graceMinutes: 30 },
      note: cron ? undefined : `OnCalendar "${cal}" could not be translated to cron — set the schedule by hand`,
    });
  }
}

// ---- report ------------------------------------------------------------------------

const gates = checks.filter((c) => c.gate);
const fullyConnected = gates.every((c) => c.status === "pass");
const fails = checks.filter((c) => c.status === "fail").length;

if (asJson) {
  console.log(JSON.stringify({ fullyConnected, checks, proposals, suggestedScriptDirs: [...suggestedScriptDirs], timers: relevant }, null, 2));
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
    console.log("\n== Proposed configuration ==");
    if (suggestedScriptDirs.size) console.log(`SCRIPTS_DIR="${[...suggestedScriptDirs].join(",")}"`);
    if (!proposals.length) console.log("No unmirrored timers to propose.");
    for (const p of proposals) {
      console.log(`\n# ${p.options.timer}${p.note ? `  — ${p.note}` : ""}`);
      console.log(JSON.stringify({ name: p.name, type: p.type, cron: p.cron ?? "0 4 * * *", enabled: p.enabled, options: p.options }));
    }
    if (proposals.length && !applyProposals) console.log("\nRe-run with --apply to create these jobs in the running dashboard (fix any untranslated schedules first).");
  }
}

if (propose && applyProposals && serverUp) {
  for (const p of proposals) {
    if (!p.cron) {
      console.log(`skip ${p.options.timer}: schedule needs manual entry`);
      continue;
    }
    const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Homelab-Agent": "audit-install" }, body: JSON.stringify({ name: p.name, type: p.type, cron: p.cron, enabled: p.enabled, options: p.options }) });
    console.log(`${res.ok ? "created" : `failed (${res.status})`}: ${p.name}`);
  }
}

process.exit(fullyConnected ? 0 : 1);

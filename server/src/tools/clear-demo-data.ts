#!/usr/bin/env node
// Remove demo-seeded data from DATA_DIR without touching anything the owner
// created. Dry-run by default; pass --yes to apply.
//
//   npm run clear-demo-data            # show what would be removed
//   npm run clear-demo-data -- --yes   # remove it
//   ... --env /path/to/env             # default /etc/homelab-dashboard.env
import fs from "node:fs/promises";
import path from "node:path";
import { envFileFromArgs, flag, loadEnvFile } from "./env.js";

const argv = process.argv.slice(2);
const apply = flag(argv, "--yes");
const envFile = envFileFromArgs(argv);
const envLoaded = loadEnvFile(envFile);
const { cfg } = await import("../config.js");

const SEEDED_NAMES = new Set(["Nightly world backup", "Daily restart", "Semi-weekly world backup", "Semi-weekly restart"]);

interface Job {
  id: string;
  name: string;
  seeded?: boolean;
}
interface Run {
  jobId: string;
}
interface Report {
  agent: string;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const actions: string[] = [];
const dataDir = cfg.dataDir;
console.log(`Data dir: ${dataDir}${envLoaded ? `  (env: ${envFile})` : "  (no env file found; using process env/defaults)"}`);

// 1. seeded jobs + their runs
const jobsFile = path.join(dataDir, "jobs.json");
const runsFile = path.join(dataDir, "job-runs.json");
const jobs = await readJson<Job[]>(jobsFile, []);
const seeded = jobs.filter((j) => j.seeded || SEEDED_NAMES.has(j.name));
if (seeded.length) {
  actions.push(`remove ${seeded.length} seeded job(s) from jobs.json: ${seeded.map((j) => `"${j.name}"`).join(", ")}`);
  const ids = new Set(seeded.map((j) => j.id));
  const runs = await readJson<Run[]>(runsFile, []);
  const dropRuns = runs.filter((r) => ids.has(r.jobId)).length;
  if (dropRuns) actions.push(`remove ${dropRuns} run record(s) belonging to those jobs`);
  if (apply) {
    await fs.writeFile(jobsFile, JSON.stringify(jobs.filter((j) => !ids.has(j.id)), null, 2));
    await fs.writeFile(runsFile, JSON.stringify(runs.filter((r) => !ids.has(r.jobId)), null, 2));
  }
}

// 2. demo folder (fake media, worlds, scripts, backups, CLAUDE.md copy)
const demoDir = path.join(dataDir, "demo");
try {
  await fs.access(demoDir);
  actions.push(`delete demo folder ${demoDir}`);
  if (apply) await fs.rm(demoDir, { recursive: true, force: true });
} catch {
  // none
}

// 3. demo reports
const reportsFile = path.join(dataDir, "agent-reports.json");
const reports = await readJson<Report[]>(reportsFile, []);
const demoReports = reports.filter((r) => /\(demo\)$/i.test(r.agent));
if (demoReports.length) {
  actions.push(`remove ${demoReports.length} demo report(s)`);
  if (apply) await fs.writeFile(reportsFile, JSON.stringify(reports.filter((r) => !/\(demo\)$/i.test(r.agent)), null, 2));
}

// 4. dashboard-created backup markers that pointed into the demo folder
const createdFile = path.join(dataDir, "backups-created.json");
const created = await readJson<string[]>(createdFile, []);
const demoCreated = created.filter((p) => p.startsWith(demoDir));
if (demoCreated.length) {
  actions.push(`forget ${demoCreated.length} demo backup marker(s)`);
  if (apply) await fs.writeFile(createdFile, JSON.stringify(created.filter((p) => !p.startsWith(demoDir)), null, 2));
}

// 5. warnings that are not data
if (cfg.dashboardKey === "demo-key-not-secret") console.log("! DASHBOARD_KEY is the demo key — set a real one (openssl rand -hex 24).");
// [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
if (cfg.demo) console.log("! DEMO is set in this environment — never set it on the server.");

if (!actions.length) {
  console.log("Nothing demo-related found. Clean.");
} else {
  console.log(`${apply ? "Applied" : "Would apply"}:`);
  for (const a of actions) console.log(`  - ${a}`);
  if (!apply) console.log("\nRun again with --yes to apply. Restart the dashboard afterwards.");
  else console.log("\nDone. Restart the dashboard: sudo systemctl restart homelab-dashboard");
}

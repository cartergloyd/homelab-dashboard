// Automated Minecraft maintenance: cron-scheduled restarts (with in-game
// countdown), world backups and arbitrary RCON commands. Jobs and run history
// live in JSON files under DATA_DIR.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { schedule, validate } from "node-cron";
import { z } from "zod";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { fmtBytes, sleepUntil } from "../util.js";
import { publish } from "./alerts.js";
import { runBackup } from "./backups.js";
import { getPlayers } from "./minecraft.js";
import { rconCommand, stripColour } from "./rcon.js";
import { runScriptAndWait } from "./scripts.js";
import { unitAction, unitState } from "./systemd.js";
import type { Job, JobRun, JobView } from "../types.js";

type Task = ReturnType<typeof schedule>;

export const JobInput = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(["restart", "backup", "command", "script"]),
  cron: z.string().trim().refine((c) => validate(c), "Invalid cron expression"),
  enabled: z.boolean().default(true),
  options: z
    .object({
      warnMinutes: z.array(z.number().int().min(1).max(120)).max(10).optional(),
      onlyWhenEmpty: z.boolean().optional(),
      keep: z.number().int().min(1).max(365).optional(),
      command: z.string().trim().max(500).optional(),
      script: z
        .string()
        .trim()
        .regex(/^[\w.-]+\.(py|sh)$/, "Script must be a *.py or *.sh file name")
        .optional(),
    })
    .default({}),
});
export type JobInputT = z.infer<typeof JobInput>;

let jobs: Job[] = [];
let runs: JobRun[] = [];
const tasks = new Map<string, Task>();
const running = new Set<string>();

const jobsFile = () => path.join(cfg.dataDir, "jobs.json");
const runsFile = () => path.join(cfg.dataDir, "job-runs.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// Seeded only when data/jobs.json does not exist yet. Both start DISABLED: the
// owner already has backup/restart scripts, and the installer decides (see
// SERVER_SETUP.md § 6c) whether to schedule those or these built-ins.
function defaultJobs(): Job[] {
  const createdAt = new Date().toISOString();
  return [
    { id: crypto.randomUUID(), name: "Nightly world backup", type: "backup", cron: "0 4 * * *", enabled: false, options: { keep: cfg.backups.keep }, createdAt },
    {
      id: crypto.randomUUID(),
      name: "Daily restart",
      type: "restart",
      cron: "0 5 * * *",
      enabled: false,
      options: { warnMinutes: [10, 5, 1], onlyWhenEmpty: true },
      createdAt,
    },
  ];
}

export async function initScheduler(): Promise<void> {
  await fs.mkdir(cfg.dataDir, { recursive: true });
  jobs = (await readJson<Job[] | null>(jobsFile(), null)) ?? defaultJobs();
  runs = await readJson<JobRun[]>(runsFile(), []);
  // a run interrupted by a restart never finished
  for (const r of runs) if (r.ok === null) (r.ok = false), (r.message = "Interrupted by dashboard restart"), (r.finishedAt ??= r.startedAt);
  await writeJson(jobsFile(), jobs);
  for (const j of jobs) arm(j);
}

function arm(job: Job): void {
  disarm(job.id);
  if (!job.enabled) return;
  const task = schedule(job.cron, () => void execute(job.id), { timezone: cfg.timezone, noOverlap: true, name: job.id });
  tasks.set(job.id, task);
}

function disarm(id: string): void {
  const t = tasks.get(id);
  if (t) {
    void t.destroy();
    tasks.delete(id);
  }
}

function view(job: Job): JobView {
  const next = tasks.get(job.id)?.getNextRun() ?? null;
  return { ...job, nextRun: next ? next.toISOString() : null, lastRun: runs.find((r) => r.jobId === job.id) ?? null, running: running.has(job.id) };
}

function assertValid(job: Pick<Job, "type" | "options">): void {
  if (job.type === "command" && !job.options.command) throw new HttpError(400, "A command is required for command jobs");
  if (job.type === "script" && !job.options.script) throw new HttpError(400, "Choose a script for script jobs");
}

export function listJobs(): JobView[] {
  return jobs.map(view);
}

export async function createJob(input: JobInputT): Promise<JobView> {
  assertValid(input);
  const job: Job = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  jobs.push(job);
  await writeJson(jobsFile(), jobs);
  arm(job);
  return view(job);
}

export async function updateJob(id: string, patch: Partial<JobInputT>): Promise<JobView> {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, "Job not found");
  const next: Job = { ...job, ...patch, options: { ...job.options, ...(patch.options ?? {}) } };
  assertValid(next);
  Object.assign(job, next);
  await writeJson(jobsFile(), jobs);
  arm(job);
  return view(job);
}

export async function deleteJob(id: string): Promise<void> {
  if (!jobs.some((j) => j.id === id)) throw new HttpError(404, "Job not found");
  disarm(id);
  jobs = jobs.filter((j) => j.id !== id);
  await writeJson(jobsFile(), jobs);
}

export function runJob(id: string): JobRun {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, "Job not found");
  if (running.has(id)) throw new HttpError(409, "Job is already running");
  const run = startRun(job);
  void execute(id, run);
  return run;
}

export function listRuns(limit = 50): JobRun[] {
  return runs.slice(0, limit);
}

export function nextScheduled(): { name: string; at: string } | null {
  let best: { name: string; at: string } | null = null;
  for (const j of listJobs()) if (j.nextRun && (!best || j.nextRun < best.at)) best = { name: j.name, at: j.nextRun };
  return best;
}

// ---- execution -----------------------------------------------------------

function startRun(job: Job): JobRun {
  const run: JobRun = { id: crypto.randomUUID(), jobId: job.id, jobName: job.name, type: job.type, startedAt: new Date().toISOString(), finishedAt: null, ok: null, message: "Running…" };
  runs.unshift(run);
  publish({ source: "jobs", kind: "job", level: "info", tags: ["maintenance"], text: `Job "${job.name}" started (${job.type})`, meta: { job: job.name, jobId: job.id } });
  return run;
}

async function execute(jobId: string, existing?: JobRun): Promise<void> {
  const job = jobs.find((j) => j.id === jobId);
  if (!job || (running.has(jobId) && !existing)) return;
  running.add(jobId);
  const run = existing ?? startRun(job);
  try {
    run.message = await runners[job.type](job);
    run.ok = true;
  } catch (e) {
    run.ok = false;
    run.message = (e as Error).message;
  } finally {
    run.finishedAt = new Date().toISOString();
    running.delete(jobId);
    runs = runs.slice(0, 200);
    publish({
      source: "jobs",
      kind: "job",
      level: run.ok ? "info" : "error",
      tags: ["maintenance"],
      text: `Job "${job.name}" ${run.ok ? "finished" : "failed"}: ${run.message}`,
      meta: { job: job.name, jobId: job.id },
    });
    await writeJson(runsFile(), runs).catch(() => {});
  }
}

const runners: Record<Job["type"], (job: Job) => Promise<string>> = {
  async restart(job) {
    const unit = await unitState(cfg.minecraft.service);
    if (unit && unit.active !== "active") return `Skipped: server is ${unit.active}`;
    if (job.options.onlyWhenEmpty) {
      const players = await getPlayers().catch(() => null);
      if (players && players.online > 0) return `Skipped: ${players.online} player(s) online`;
    }
    const warns = [...new Set((job.options.warnMinutes ?? [10, 5, 1]).filter((n) => n > 0))].sort((a, b) => b - a);
    const scale = cfg.demo ? 1000 : 60_000; // demo mode: minutes become seconds
    const say = (msg: string) => {
      publish({ source: "jobs", kind: "job", level: "info", tags: ["maintenance"], text: `Countdown: ${msg}`, meta: { job: job.name, jobId: job.id } });
      return rconCommand(`say ${msg}`).catch(() => {});
    };
    if (warns.length) {
      const t0 = Date.now();
      const total = warns[0] * scale;
      for (const w of warns) {
        await sleepUntil(t0 + total - w * scale);
        await say(`Server restarting in ${w} minute${w === 1 ? "" : "s"}`);
      }
      const finalMs = cfg.demo ? 3000 : 10_000;
      await sleepUntil(t0 + total - finalMs);
      await say(`Server restarting in ${finalMs / 1000} seconds`);
      await sleepUntil(t0 + total);
    }
    await rconCommand("save-all").catch(() => {});
    await unitAction(cfg.minecraft.service, "restart");
    return warns.length ? `Restarted after a ${warns[0]}-minute countdown` : "Restarted";
  },
  async backup(job) {
    const r = await runBackup(job.options.keep ?? cfg.backups.keep);
    return `Created ${r.file} (${fmtBytes(r.bytes)})${r.pruned ? `, pruned ${r.pruned} old backup${r.pruned === 1 ? "" : "s"}` : ""}${r.savedWhileRunning ? "" : " — server was stopped"}`;
  },
  async command(job) {
    const cmd = job.options.command?.trim();
    if (!cmd) throw new Error("No command configured");
    return stripColour(await rconCommand(cmd)) || "(no output)";
  },
  async script(job) {
    const name = job.options.script;
    if (!name) throw new Error("No script configured");
    const { run, tail } = await runScriptAndWait(name, "job");
    if (run.exitCode !== 0) throw new Error(`${name} exited ${run.exitCode}: ${tail.slice(-2).join(" | ") || "(no output)"}`);
    return `${name} exited 0 (${run.lines} lines)`;
  },
};

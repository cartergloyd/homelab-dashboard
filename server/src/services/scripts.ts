// Maintenance scripts (*.py, *.sh) in SCRIPTS_DIR. Run from the ▶ buttons, from
// a "script" job, or by an agent; every output line goes into the alerts feed.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { ScriptInfo, ScriptRun } from "../types.js";
import { publish } from "./alerts.js";

const NAME_RE = /^[\w.-]+\.(py|sh)$/;
const TAIL = 200;

interface Active {
  run: ScriptRun;
  child: ChildProcess;
  tail: string[];
  exit: Promise<void>;
}

const active = new Map<string, Active>();
let runs: ScriptRun[] = [];
const runsFile = () => path.join(cfg.dataDir, "script-runs.json");

export async function initScripts(): Promise<void> {
  try {
    runs = JSON.parse(await fsp.readFile(runsFile(), "utf8")) as ScriptRun[];
    for (const r of runs) if (!r.finishedAt) (r.finishedAt = r.startedAt), (r.exitCode = -1);
  } catch {
    runs = [];
  }
}

async function saveRuns(): Promise<void> {
  runs = runs.slice(0, 50);
  await fsp.writeFile(runsFile(), JSON.stringify(runs, null, 2)).catch(() => {});
}

export async function listScripts(): Promise<ScriptInfo[]> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(cfg.scriptsDir)).filter((n) => NAME_RE.test(n)).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    name,
    kind: name.endsWith(".py") ? "python" : "shell",
    running: active.has(name),
    lastRun: runs.find((r) => r.script === name) ?? null,
  }));
}

export function listRuns(limit = 50): ScriptRun[] {
  return runs.slice(0, limit);
}

export async function startScript(name: string, trigger: ScriptRun["trigger"]): Promise<ScriptRun> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "Script names must be plain *.py or *.sh file names");
  const file = path.join(cfg.scriptsDir, name);
  try {
    await fsp.access(file);
  } catch {
    throw new HttpError(404, `${name} not found in ${cfg.scriptsDir}`);
  }
  if (active.has(name)) throw new HttpError(409, `${name} is already running`);

  const run: ScriptRun = { id: crypto.randomUUID(), script: name, trigger, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, lines: 0 };
  // [INSTALLER] Scripts run as the `homelab` service user with `python3`/`bash`
  // from PATH, cwd = SCRIPTS_DIR. The owner's real scripts may expect a different
  // user, a venv, or sudo — check their shebangs/imports and either adjust the
  // unit/sudoers or keep them on cron (wrapped with hl-run) instead of here.
  const isPython = name.endsWith(".py");
  const child = spawn(isPython ? "python3" : "bash", isPython ? ["-u", file] : [file], {
    cwd: cfg.scriptsDir,
    env: { ...process.env, PYTHONUNBUFFERED: "1", HOMELAB_URL: `http://${cfg.host}:${cfg.port}`, HOMELAB_KEY: cfg.dashboardKey ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let resolveExit: () => void = () => {};
  const entry: Active = { run, child, tail: [], exit: new Promise<void>((r) => (resolveExit = r)) };
  active.set(name, entry);
  runs.unshift(run);

  const meta = { script: name, runId: run.id };
  publish({ source: "scripts", kind: "script", level: "info", tags: ["maintenance"], text: `▶ ${name} started (${trigger})`, meta });

  const onLine = (line: string) => {
    run.lines++;
    entry.tail.push(line);
    if (entry.tail.length > TAIL) entry.tail.shift();
    publish({ source: "scripts", kind: "script", text: line, meta });
  };
  if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", onLine);
  if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", onLine);

  const finish = (code: number | null, startError?: string) => {
    if (run.finishedAt) return;
    run.finishedAt = new Date().toISOString();
    run.exitCode = code;
    active.delete(name);
    const secs = ((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1);
    publish({
      source: "scripts",
      kind: "script",
      level: code === 0 ? "info" : "error",
      tags: ["maintenance"],
      text: startError ? `✖ ${name} could not start: ${startError}` : `${code === 0 ? "✔" : "✖"} ${name} exited ${code} after ${secs}s`,
      meta: { ...meta, exitCode: code },
    });
    void saveRuns();
    resolveExit();
  };
  child.on("error", (e) => finish(null, e.message));
  child.on("close", (code) => finish(code));
  return run;
}

/** Runs a script and waits for it (jobs, MCP). Kills it after `timeoutMs`. */
export async function runScriptAndWait(name: string, trigger: ScriptRun["trigger"], timeoutMs = 10 * 60_000): Promise<{ run: ScriptRun; tail: string[] }> {
  const run = await startScript(name, trigger);
  const entry = active.get(name);
  if (!entry) return { run, tail: [] };
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    entry.exit,
    new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        entry.child.kill();
        reject(new Error(`${name} timed out after ${timeoutMs / 1000}s and was killed`));
      }, timeoutMs);
    }),
  ]).finally(() => timer && clearTimeout(timer));
  return { run, tail: entry.tail };
}

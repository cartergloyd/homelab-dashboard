import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";

export interface HostSample {
  at: string;
  cpu: number | null;
  memoryUsed: number;
  memoryTotal: number;
}
const samples: HostSample[] = [];
const filename = () => path.join(cfg.dataDir, "host-metrics.json");
let previous: { total: number; idle: number } | null = null;
let timer: NodeJS.Timeout | null = null;
function cpuTimes() {
  return os
    .cpus()
    .reduce(
      (sum, cpu) => ({
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
        idle: sum.idle + cpu.times.idle,
      }),
      { total: 0, idle: 0 },
    );
}
export function sampleHost(): HostSample {
  const current = cpuTimes();
  const delta = previous ? current.total - previous.total : 0;
  const cpu =
    previous && delta > 0
      ? Math.max(
          0,
          Math.min(100, 100 * (1 - (current.idle - previous.idle) / delta)),
        )
      : null;
  previous = current;
  return {
    at: new Date().toISOString(),
    cpu,
    memoryUsed: os.totalmem() - os.freemem(),
    memoryTotal: os.totalmem(),
  };
}
export function initHostMetrics() {
  if (timer) return;
  try {
    const saved = JSON.parse(fs.readFileSync(filename(), "utf8"));
    if (Array.isArray(saved))
      samples.push(
        ...saved
          .filter(
            (s) =>
              typeof s.at === "string" &&
              Date.parse(s.at) > Date.now() - 7 * 86400_000 &&
              typeof s.memoryUsed === "number",
          )
          .slice(-10080),
      );
  } catch {
    /* A new installation has no history. */
  }
  previous = cpuTimes();
  const save = () => {
    samples.push(sampleHost());
    while (
      samples.length > 10080 ||
      (samples[0] && Date.parse(samples[0].at) < Date.now() - 7 * 86400_000)
    )
      samples.shift();
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(filename() + ".tmp", JSON.stringify(samples), {
      mode: 0o600,
    });
    fs.renameSync(filename() + ".tmp", filename());
  };
  const safelySave = () => {
    try {
      save();
    } catch (error) {
      console.error(
        "Host metrics could not be saved",
        (error as Error).message,
      );
    }
  };
  const initial = setTimeout(safelySave, 1000);
  initial.unref();
  timer = setInterval(safelySave, 60_000);
  timer.unref();
}
export function hostStatus(range = "24h") {
  const cutoff = Date.now() - (range === "7d" ? 7 : 1) * 86400_000;
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    cpuCount: os.cpus().length,
    uptime: os.uptime(),
    username: os.userInfo().username,
    cwd: os.homedir(),
    memoryUsed: os.totalmem() - os.freemem(),
    memoryTotal: os.totalmem(),
    cpu: samples.at(-1)?.cpu ?? null,
    history: samples.filter((s) => Date.parse(s.at) >= cutoff),
    checkedAt: new Date().toISOString(),
  };
}

let running = 0;
export async function executeHostCommand(command: string, directory: string) {
  if (running >= 2)
    throw new HttpError(
      429,
      "Two commands are already running. Wait for one to finish.",
    );
  const cwd = path.resolve(directory || os.homedir());
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "Working directory does not exist");
  }
  // Inherit the owner's ordinary shell environment, never dashboard integration secrets.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      [
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "LANG",
        "LC_ALL",
        "TZ",
        "SHELL",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
      ].includes(name),
    ),
  );
  running++;
  const startedAt = new Date().toISOString();
  return new Promise<{
    stdout: string;
    stderr: string;
    code: number;
    timedOut: boolean;
    truncated: boolean;
    startedAt: string;
    finishedAt: string;
  }>((resolve, reject) => {
    let stdout = "",
      stderr = "",
      bytes = 0,
      timedOut = false,
      truncated = false;
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 30_000);
    const hardTimeout = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }, 32_000);
    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, 256 * 1024 - bytes);
      bytes += chunk.length;
      const text = chunk.subarray(0, remaining).toString("utf8");
      if (kind === "stdout") stdout += text;
      else stderr += text;
      if (bytes > 256 * 1024) {
        truncated = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    let done = false;
    const finish = (error?: Error, code?: number | null) => {
      if (done) return;
      done = true;
      running--;
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      if (error) reject(new HttpError(500, "Could not start the host shell"));
      else
        resolve({
          stdout,
          stderr,
          code: timedOut ? 124 : (code ?? -1),
          timedOut,
          truncated,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
    };
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code));
  });
}

// What the ops agent sees of the whole server, and the two things it may do to it: restart a
// user unit, restart a container. Everything here runs as the dashboard (outside any agent
// sandbox, which blocks systemctl, docker and journal-to-D-Bus calls). Reads are cheap: /proc,
// `systemctl --user`, `journalctl --user`, `docker stats --no-stream`.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { restartContainer } from "./docker.js";
import { unitAction } from "./systemd.js";

const execFileP = promisify(execFile);
const run = async (cmd: string, args: string[], timeout = 15_000) => (await execFileP(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
export const UNIT_NAME = /^[\w@.\\-]+\.(service|timer)$/;
export const CONTAINER_NAME = /^[\w.-]{1,64}$/;

export interface Pressure {
  memAvailableMb: number;
  memTotalMb: number;
  swapUsedPct: number;
  /** % of the last 10 s that every task was stalled on memory (PSI "full avg10") */
  psiFull10: number | null;
  disks: { mount: string; usedPct: number; availGb: number }[];
}

export function parseMeminfo(text: string): Pick<Pressure, "memAvailableMb" | "memTotalMb" | "swapUsedPct"> {
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  const swapTotal = kb("SwapTotal");
  return { memAvailableMb: Math.round(kb("MemAvailable") / 1024), memTotalMb: Math.round(kb("MemTotal") / 1024), swapUsedPct: swapTotal ? Math.round((100 * (swapTotal - kb("SwapFree"))) / swapTotal) : 0 };
}

export async function readPressure(): Promise<Pressure> {
  const mem = parseMeminfo(await fs.readFile("/proc/meminfo", "utf8").catch(() => ""));
  const psi = await fs.readFile("/proc/pressure/memory", "utf8").catch(() => "");
  const full = /^full avg10=([\d.]+)/m.exec(psi);
  const df = await run("df", ["-P", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "overlay"]).catch(() => "");
  const disks = df.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 6 && c[5].startsWith("/")).map((c) => ({ mount: c[5], usedPct: Number(c[4].replace("%", "")), availGb: Math.round(Number(c[3]) / 1024 / 1024) }));
  return { ...mem, psiFull10: full ? Number(full[1]) : null, disks };
}

/** Pressure plus who is using the memory: the largest processes and every container. */
export async function hostPressure(): Promise<Pressure & { topProcesses: { rssMb: number; command: string }[]; containers: { name: string; memory: string; cpu: string }[] }> {
  const ps = await run("ps", ["-eo", "rss=,args=", "--sort=-rss"]).catch(() => "");
  const topProcesses = ps.split("\n").filter(Boolean).slice(0, 12).map((l) => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return { rssMb: Math.round(Number(m?.[1] ?? 0) / 1024), command: (m?.[2] ?? l).slice(0, 160) }; });
  const stats = await run("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"], 30_000).catch(() => "");
  const containers = stats.split("\n").filter(Boolean).map((l) => { const [name, memory, cpu] = l.split("\t"); return { name, memory, cpu }; });
  return { ...(await readPressure()), topProcesses, containers };
}

const systemctl = (args: string[]) => run("systemctl", [...(cfg.systemdUser ? ["--user"] : []), ...args]);

export async function listUnits(): Promise<{ unit: string; active: string; sub: string; description: string }[]> {
  const out = await systemctl(["list-units", "--all", "--type=service,timer", "--no-legend", "--plain", "--no-pager"]).catch(() => "");
  return out.split("\n").filter(Boolean).map((l) => {
    const [unit, , active, sub, ...rest] = l.trim().split(/\s+/);
    return { unit, active, sub, description: rest.join(" ") };
  }).filter((u) => UNIT_NAME.test(u.unit));
}

export async function unitJournal(unit: string, lines = 80): Promise<string> {
  if (!UNIT_NAME.test(unit)) throw new HttpError(400, "Unit names end in .service or .timer");
  const n = String(Math.min(Math.max(lines, 1), 400));
  return run("journalctl", [...(cfg.systemdUser ? ["--user"] : []), "-u", unit, "-n", n, "--no-pager", "-o", "short-iso"]);
}

export async function unitExists(unit: string): Promise<boolean> {
  if (!UNIT_NAME.test(unit)) return false;
  return (await systemctl(["show", "-p", "LoadState", "--value", unit]).catch(() => "")).trim() === "loaded";
}

/** Starts or restarts a unit; the user manager is reloaded first so an edited unit file takes effect. */
export async function restartUnit(unit: string, action: "start" | "restart"): Promise<void> {
  if (!(await unitExists(unit))) throw new HttpError(404, `No unit called ${unit}`);
  if (cfg.systemdUser) await systemctl(["daemon-reload"]);
  await unitAction(unit, action);
}

export async function listContainers(): Promise<{ name: string; state: string; status: string; image: string }[]> {
  const out = await run("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}"]).catch(() => "");
  return out.split("\n").filter(Boolean).map((l) => { const [name, state, status, image] = l.split("\t"); return { name, state, status, image }; });
}

export async function containerLogs(name: string, lines = 80): Promise<string> {
  if (!CONTAINER_NAME.test(name)) throw new HttpError(400, "Invalid container name");
  const { stdout, stderr } = await execFileP("docker", ["logs", "--tail", String(Math.min(Math.max(lines, 1), 400)), "--timestamps", name], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return `${stdout}${stderr}`;
}

export async function restartNamedContainer(name: string): Promise<void> {
  if (!CONTAINER_NAME.test(name) || !(await listContainers()).some((c) => c.name === name)) throw new HttpError(404, `No container called ${name}`);
  await restartContainer(name);
}

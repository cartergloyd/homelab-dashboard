// Rules both assistant lanes share (step 5 of the assistant redesign): which log lines are known
// noise and are dropped outright, which Minecraft lines are player chat (never a problem), how many
// automatic runs one problem may get per day, and when memory is too tight to start another agent.
// The rules are data in DATA_DIR/routing.json (written with these defaults on first start; edits
// are picked up within a minute).
import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { readPressure, type Pressure } from "./hostOps.js";

export interface Routing {
  /** regular expressions (case-insensitive) for lines that are never a problem */
  noise: string[];
  memory: { minAvailableMb: number; maxPsiFull10: number };
  diskMaxUsedPct: number;
  runsPerKeyPerDay: number;
}

export const DEFAULT_ROUTING: Routing = {
  noise: [
    "snap\\.firmware-updater",
    "Could not ask extractor",
    "GDBus\\.Error",
    "xdg-document-portal",
    "update-notifier-crash",
    "wp-state:",
    "Failed to associate portal window",
    "tracker-miner",
    "gnome-shell",
    "\\bgsd-",
    "pipewire|wireplumber",
    "\\bapport",
    "Advanced terminal features are not available",
    // containers being restarted on purpose, and info/warning lines the error rules catch
    "terminating connection due to administrator command",
    "the database system is (shutting down|starting up|not yet accepting connections)",
    "^\\[[\\d:.]+\\] \\[(INF|WRN|DBG)\\]",
    "msg=process tree killed|msg=failed to kill - retrying",
  ],
  memory: { minAvailableMb: 400, maxPsiFull10: 20 },
  diskMaxUsedPct: 90,
  runsPerKeyPerDay: 2,
};

let routing: Routing = DEFAULT_ROUTING;
let noise: RegExp[] = [];
let loadedAt = 0;
const file = () => path.join(cfg.dataDir, "routing.json");

function compile(r: Routing): RegExp[] {
  return r.noise.flatMap((p) => {
    try {
      return [new RegExp(p, "i")];
    } catch {
      return [];
    }
  });
}

export function getRouting(): Routing {
  if (Date.now() - loadedAt < 60_000) return routing;
  loadedAt = Date.now();
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Routing>;
    routing = { ...DEFAULT_ROUTING, ...saved, memory: { ...DEFAULT_ROUTING.memory, ...saved.memory } };
  } catch {
    routing = DEFAULT_ROUTING;
    try {
      fs.writeFileSync(file(), JSON.stringify(DEFAULT_ROUTING, null, 2), { flag: "wx" });
    } catch {
      // the file exists but is unreadable or invalid; keep the defaults and leave it for the owner
    }
  }
  noise = compile(routing);
  return routing;
}

export function isNoise(text: string): boolean {
  getRouting();
  return noise.some((re) => re.test(text));
}

/** Paper's chat lines (`<name> …`, "[Not Secure]", the async chat thread): players' words, never a server problem. */
export function isChat(text: string): boolean {
  return /Async Chat Thread|\]: (\[Not Secure\] )?<[^>\s]{1,32}> /.test(text);
}

/** An OOM kill is a host problem even when Paper is what died: it belongs to the ops lane. */
export function isOomKill(text: string): boolean {
  return /oom-kill|OOM killer|Out of memory: Killed process/i.test(text);
}

// ---- run budget ------------------------------------------------------------------------------

const launches = new Map<string, number[]>();

/** Records an automatic run for this problem, or returns false when it already had its runs today. */
export function takeRunBudget(key: string, now = Date.now()): boolean {
  const recent = (launches.get(key) ?? []).filter((t) => now - t < 24 * 3600_000);
  if (recent.length >= getRouting().runsPerKeyPerDay) return false;
  launches.set(key, [...recent, now]);
  return true;
}

// ---- memory guard ----------------------------------------------------------------------------

export function memoryTight(p: Pick<Pressure, "memAvailableMb" | "psiFull10">, r: Routing = getRouting()): boolean {
  return (p.memAvailableMb > 0 && p.memAvailableMb < r.memory.minAvailableMb) || (p.psiFull10 ?? 0) > r.memory.maxPsiFull10;
}

/** Whether starting another agent now would make a memory shortage worse. */
export async function tooTightToStart(read: () => Promise<Pick<Pressure, "memAvailableMb" | "psiFull10">> = readPressure): Promise<boolean> {
  try {
    return memoryTight(await read());
  } catch {
    return false;
  }
}

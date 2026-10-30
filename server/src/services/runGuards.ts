// What the dashboard refuses its own agent runs, whatever their prompt says (step 2 of the
// assistant redesign): Minecraft console commands that hand out power, act against players or
// cheat; more restarts than a struggling server should get; and scripts or jobs outside Minecraft.
// security.ts applies these to requests that carry a run token. People are never checked here.
import path from "node:path";
import { cfg } from "../config.js";
import { query } from "./alerts.js";
import { listJobs } from "./scheduler.js";
import type { RunLane } from "./runTokens.js";
import { locate } from "./scripts.js";

// ---- the Minecraft console ---------------------------------------------------------------------

const NEVER = new Map<string, string>([
  ...["op", "deop", "execute", "sudo", "lp", "luckperms", "pex", "permissions"].map((v) => [v, "changes who may do what"] as const),
  ...["ban", "ban-ip", "pardon", "pardon-ip", "kick"].map((v) => [v, "acts against a player"] as const),
  ...["gamemode", "defaultgamemode", "give", "item", "tp", "teleport", "effect", "xp", "experience", "enchant", "attribute", "summon", "kill", "clear", "setblock", "fill", "clone"].map((v) => [v, "changes the game for someone"] as const),
  ...["stop", "restart", "reload", "rl", "save-off"].map((v) => [v, "stops the server or its saving (restarts go through minecraft_service)"] as const),
]);

/** Why a run may not send this console command, or null. Namespaced forms (minecraft:op) count too. */
export function rconRefusal(command: string): string | null {
  const words = command.trim().replace(/^\//, "").split(/\s+/);
  const verb = (words[0] ?? "").toLowerCase().split(":").pop() ?? "";
  const sub = (words[1] ?? "").toLowerCase();
  if (verb === "whitelist" && (sub === "off" || sub === "remove")) return `"whitelist ${sub}" weakens the whitelist; only the owner may do that.`;
  const reason = NEVER.get(verb);
  return reason ? `"${verb}" ${reason}; only the owner may run it.` : null;
}

// ---- restarts ----------------------------------------------------------------------------------

const RESTARTS_PER_HOUR = 2;
const RESTART_SPACING_MS = 5 * 60_000;
let lastRunRestart = 0;

/** Paper starts in the last hour, whoever caused them: systemd's own restarts, the owner, a run. */
function startsLastHour(now: number): number {
  const started = new RegExp(`Started ${cfg.minecraft.service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  return query({ sources: ["minecraft"], since: new Date(now - 3600_000).toISOString(), limit: 5000 }).filter((e) => started.test(e.text)).length;
}

/** Why a run may not start or restart Minecraft now, or null. An allowed restart is remembered. */
export function restartRefusal(now = Date.now()): string | null {
  if (now - lastRunRestart < RESTART_SPACING_MS) return "An assistant restarted Minecraft less than 5 minutes ago. Wait for it to come up and check it before trying again.";
  const starts = startsLastHour(now);
  if (starts >= RESTARTS_PER_HOUR) return `Minecraft has started ${starts} times in the last hour, counting systemd's automatic restarts. Another restart will not fix this: file a needs-human report instead.`;
  lastRunRestart = now;
  return null;
}

// ---- per Discord member -------------------------------------------------------------------------

// Counted in memory: a dashboard restart starts the windows over.
const MEMBER_LIMITS = { action: { max: 6, windowMs: 3600_000, what: "6 changes an hour" }, whitelist: { max: 3, windowMs: 24 * 3600_000, what: "3 whitelist additions a day" } };
type MemberKind = keyof typeof MEMBER_LIMITS;
const memberLog = new Map<string, number[]>();

/** Why the Discord member who started a run may not have it change something now, or null (then it is counted). */
export function memberRefusal(requester: string | undefined, kinds: MemberKind[], now = Date.now()): string | null {
  if (!requester) return null;
  for (const kind of kinds) {
    const recent = (memberLog.get(`${kind}:${requester}`) ?? []).filter((t) => now - t < MEMBER_LIMITS[kind].windowMs);
    if (recent.length >= MEMBER_LIMITS[kind].max) return `This player has reached the limit of ${MEMBER_LIMITS[kind].what} through the assistant. Tell them the owner will follow up, and file a needs-human report.`;
  }
  for (const kind of kinds) memberLog.set(`${kind}:${requester}`, [...(memberLog.get(`${kind}:${requester}`) ?? []).filter((t) => now - t < MEMBER_LIMITS[kind].windowMs), now]);
  return null;
}

// ---- scripts and jobs --------------------------------------------------------------------------

function inside(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Why a run may not run this script, or null. Only scripts under the Minecraft folder are Minecraft's. */
export async function scriptRefusal(name: string): Promise<string | null> {
  const { dir } = await locate(name);
  return inside(dir, cfg.minecraft.dir) ? null : `${name} is not a Minecraft script (it is in ${dir}); the minecraft assistant runs only scripts under ${cfg.minecraft.dir}.`;
}

/** Why a run may not run this scheduled job now, or null. The route answers unknown ids itself. */
export async function jobRefusal(id: string, lane: RunLane = "minecraft"): Promise<string | null> {
  const job = listJobs().find((j) => j.id === id);
  if (!job) return null;
  if (job.type === "restart") return restartRefusal();
  if (job.type === "command") return rconRefusal(job.options.command ?? "");
  if (job.type === "script" && job.options.script && lane === "minecraft") return scriptRefusal(job.options.script);
  return null; // backups are the Minecraft worlds; external jobs cannot be run from the dashboard
}

// ---- units and containers (the ops lane) --------------------------------------------------------

const TARGET_RESTARTS_PER_HOUR = 2;
const targetLog = new Map<string, number[]>();

function targetRefusal(target: string, now: number): string | null {
  const recent = (targetLog.get(target) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= TARGET_RESTARTS_PER_HOUR) return `${target} was already restarted ${recent.length} times by an assistant in the last hour. Another restart will not fix it: file a needs-human report.`;
  targetLog.set(target, [...recent, now]);
  return null;
}

/** Why a run may not start or restart this unit, or null. Paper shares the Minecraft restart limit. */
export function unitRefusal(unit: string, action: string, now = Date.now()): string | null {
  if (action !== "start" && action !== "restart") return `Assistants may start or restart units, not ${action} them; only the owner may.`;
  if (unit === cfg.dashboardService || unit === `${cfg.dashboardService}.service`) return "The dashboard runs you; restarting it would end this run. Ask the owner in a needs-human report.";
  if (unit === cfg.minecraft.service) return restartRefusal(now);
  return targetRefusal(`unit ${unit}`, now);
}

export function containerRefusal(name: string, now = Date.now()): string | null {
  return targetRefusal(`container ${name}`, now);
}

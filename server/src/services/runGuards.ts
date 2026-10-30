// What the dashboard refuses its own agent runs, whatever their prompt says (step 2 of the
// assistant redesign): Minecraft console commands that hand out power, act against players or
// cheat; more restarts than a struggling server should get; and scripts or jobs outside Minecraft.
// security.ts applies these to requests that carry a run token. People are never checked here.
import path from "node:path";
import { cfg } from "../config.js";
import { query } from "./alerts.js";
import { listJobs } from "./scheduler.js";
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
export async function jobRefusal(id: string): Promise<string | null> {
  const job = listJobs().find((j) => j.id === id);
  if (!job) return null;
  if (job.type === "restart") return restartRefusal();
  if (job.type === "command") return rconRefusal(job.options.command ?? "");
  if (job.type === "script" && job.options.script) return scriptRefusal(job.options.script);
  return null; // backups are the Minecraft worlds; external jobs cannot be run from the dashboard
}

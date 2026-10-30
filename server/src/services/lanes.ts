// Where each run lane may write on disk. The runner gives Codex the first root as its workspace
// (-C) and the rest as --add-dir; snapshots.ts keeps a local git history of the same folders so
// everything an autonomous run changes can be listed and rolled back. Missing folders are skipped.
import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import type { RunLane } from "./runTokens.js";

// Minecraft's own scripts and the plugin configs that are safe to fix. Not the server root
// (server.properties, whitelist.json, ops.json), the worlds, DiscordSRV (its bot token and the
// roles allowed to run console commands from Discord) or floodgate (its key).
const MINECRAFT_ROOTS = ["scripts", "plugins/Geyser-Spigot", "plugins/ViaVersion"];

/** The ops agent: its own workspace first, then the owner's extra folders (OPS_WRITABLE_DIRS), then Minecraft's. */
export function writableRoots(lane: RunLane): string[] {
  const minecraft = MINECRAFT_ROOTS.map((r) => path.join(cfg.minecraft.dir, r));
  const roots = lane === "minecraft" ? minecraft : [cfg.ops.dir, ...cfg.ops.writableDirs, ...minecraft];
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

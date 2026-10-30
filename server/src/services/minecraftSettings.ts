import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
const visible = new Set([
  "gamemode",
  "difficulty",
  "max-players",
  "white-list",
  "view-distance",
  "simulation-distance",
  "enable-rcon",
  "server-port",
]);
/** Expose settings for the design's settings panel, never passwords or query secrets. */
export async function readMinecraftSettings(
  directory: string,
): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(
      path.join(directory, "server.properties"),
      "utf8",
    );
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        })
        .filter(([key]) => visible.has(key!)),
    );
  } catch {
    throw new HttpError(503, "Minecraft settings are not readable");
  }
}

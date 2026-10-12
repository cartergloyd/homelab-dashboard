import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { followContainerLogs } from "./docker.js";
import { followJournal } from "./systemd.js";
import type { LogSource } from "../types.js";

export const LOG_SOURCES: LogSource[] = ["minecraft", "jellyfin", "directus", "postgres", "dashboard", "system"];

/** Starts tailing a source; resolves to a function that stops it. */
export async function openLogStream(source: LogSource, onLine: (line: string) => void): Promise<() => void> {
  if (cfg.demo) return demo.logStream(source, onLine);
  switch (source) {
    case "minecraft":
      return followJournal(["-u", cfg.minecraft.service], onLine);
    case "dashboard":
      return followJournal(["-u", cfg.dashboardService], onLine);
    case "system":
      return followJournal(["-p", "warning"], onLine);
    case "jellyfin":
      return followContainerLogs(cfg.jellyfin.container, onLine);
    case "directus":
      return followContainerLogs(cfg.directus.container, onLine);
    case "postgres":
      return followContainerLogs(cfg.postgres.container, onLine);
  }
}

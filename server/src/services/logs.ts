import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { followContainerLogs } from "./docker.js";
import { followJournal } from "./systemd.js";
import type { LogSource } from "../types.js";

export const LOG_SOURCES: LogSource[] = ["minecraft", "jellyfin", "directus", "postgres", "dashboard", "system"];

/** Starts tailing a source; resolves to a function that stops it. `onEnd` fires if the tail dies on its own. */
export async function openLogStream(source: LogSource, onLine: (line: string) => void, onEnd?: () => void): Promise<() => void> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.logStream(source, onLine);
  switch (source) {
    case "minecraft":
      return followJournal(["-u", cfg.minecraft.service], onLine, onEnd);
    case "dashboard":
      return followJournal(["-u", cfg.dashboardService], onLine, onEnd);
    case "system":
      return followJournal(["-p", "warning"], onLine, onEnd);
    case "jellyfin":
      return followContainerLogs(cfg.jellyfin.container, onLine, onEnd);
    case "directus":
      return followContainerLogs(cfg.directus.container, onLine, onEnd);
    case "postgres":
      return followContainerLogs(cfg.postgres.container, onLine, onEnd);
  }
}

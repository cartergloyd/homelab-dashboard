import { cfg } from "../config.js";
import { publish } from "./alerts.js";
import { pingServer } from "./slp.js";
import { unitState } from "./systemd.js";

/** Debounce transient ping failures and allow time for startup/maintenance. */
export class MinecraftOutageWatch {
  private failures = 0;
  private reported = false;
  observe(active: string | null, reachable: boolean, since: string | null, now = Date.now()): string | null {
    if (reachable) { this.failures = 0; this.reported = false; return null; }
    const starting = active === "activating" || active === "deactivating"
      || (active === "active" && since && now - Date.parse(since) < 120_000);
    if (starting || active === null) { this.failures = 0; return null; }
    this.failures++;
    if (this.reported || this.failures < (active === "active" ? 3 : 2)) return null;
    this.reported = true;
    return `Minecraft outage reported: local server is not responding to status pings; service state is ${active}. Check for planned maintenance or an intentional shutdown before recovery.`;
  }
}

export function startMinecraftWatch(): void {
  // [DEMO] demo-mode branch — skipped in `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return;
  const watch = new MinecraftOutageWatch();
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const [unit, ping] = await Promise.all([unitState(cfg.minecraft.service), pingServer().catch(() => null)]);
      const outage = watch.observe(unit?.active ?? null, !!ping, unit?.since ?? null);
      if (outage) publish({ source: "minecraft", kind: "log", level: "error", tags: ["outage"], text: outage });
    } finally { busy = false; }
  };
  const poll = () => { void check().catch((error) => console.warn("Minecraft health check failed:", error.message)); };
  setInterval(poll, 15_000).unref();
  poll();
}

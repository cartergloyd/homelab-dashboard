import { cfg } from "../config.js";
import type { DatabasePayload, ServiceState } from "../types.js";

export async function directusHealth(): Promise<DatabasePayload["directus"]> {
  const url = cfg.directus.publicUrl;
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return { state: "ok", status: "ok", url, latencyMs: 6 };
  const t = Date.now();
  try {
    const res = await fetch(`${cfg.directus.url}/server/health`, { signal: AbortSignal.timeout(4000) });
    const latencyMs = Date.now() - t;
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    const status = body.status ?? (res.ok ? "ok" : "error");
    const state: ServiceState = status === "ok" ? "ok" : status === "warn" ? "degraded" : "down";
    return { state, status, url, latencyMs };
  } catch (e) {
    return { state: "down", status: null, url, latencyMs: null, error: `Not reachable at ${cfg.directus.url}: ${(e as Error).message}` };
  }
}

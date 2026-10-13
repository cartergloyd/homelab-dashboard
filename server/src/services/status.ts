import { cfg } from "../config.js";
import { fmtBytes, fmtDuration } from "../util.js";
import { directusHealth } from "./directus.js";
import { containerInfo, dockerAvailable } from "./docker.js";
import { health as jellyfinHealth } from "./jellyfin.js";
import { pgStats } from "./postgres.js";
import { pingServer } from "./slp.js";
import { unitState } from "./systemd.js";
import { tailscaleStatus } from "./tailscale.js";
import { vpnStatus } from "./vpn.js";
import type { ServiceState, ServiceStatus, StatusPayload } from "../types.js";

let cache: { at: number; payload: StatusPayload } | null = null;

function result(id: string, name: string, state: ServiceState, detail: string, latencyMs: number | null = null, href?: string): ServiceStatus {
  return { id, name, state, detail, latencyMs, href, checkedAt: new Date().toISOString() };
}

async function checkJellyfin(): Promise<ServiceStatus> {
  const href = cfg.jellyfin.publicUrl;
  try {
    const ms = await jellyfinHealth();
    return result("jellyfin", "Jellyfin", "ok", "Healthy", ms, href);
  } catch (e) {
    const msg = (e as Error).message;
    const c = await containerInfo(cfg.jellyfin.container);
    if (c?.state === "running") return result("jellyfin", "Jellyfin", "degraded", `Container running but /health failed: ${msg}`, null, href);
    if (c) return result("jellyfin", "Jellyfin", "down", `Container ${c.state}`, null, href);
    return result("jellyfin", "Jellyfin", dockerAvailable() ? "down" : "unavailable", `Not reachable at ${cfg.jellyfin.url} (${msg})`, null, href);
  }
}

async function checkMinecraft(): Promise<ServiceStatus> {
  const [unit, ping] = await Promise.all([unitState(cfg.minecraft.service), pingServer().catch(() => null)]);
  if (ping) return result("minecraft", "Minecraft", "ok", `${ping.online}/${ping.max} players · ${ping.version}`, ping.latencyMs);
  if (unit?.active === "active" || unit?.active === "activating") return result("minecraft", "Minecraft", "degraded", `Service ${unit.active} (${unit.sub}) but not answering pings yet`);
  if (unit) return result("minecraft", "Minecraft", "down", `Service ${unit.active}`);
  return result("minecraft", "Minecraft", "unavailable", `No systemd unit "${cfg.minecraft.service}" and no ping response on ${cfg.minecraft.host}:${cfg.minecraft.port}`);
}

async function checkDirectus(): Promise<ServiceStatus> {
  const h = await directusHealth();
  return result("directus", "Directus", h.state, h.status ? `Health: ${h.status}` : (h.error ?? "Unknown"), h.latencyMs, cfg.directus.publicUrl);
}

async function checkPostgres(): Promise<ServiceStatus> {
  const t = Date.now();
  const s = await pgStats();
  if (s.connected) return result("postgres", "PostgreSQL", "ok", `${s.version ?? "connected"} · ${fmtBytes(s.sizeBytes ?? 0)} · ${s.tables} tables`, Date.now() - t);
  if (!cfg.postgres.url && !cfg.demo) return result("postgres", "PostgreSQL", "unavailable", "PG_URL not set");
  return result("postgres", "PostgreSQL", "down", s.error ?? "Connection failed");
}

async function checkTailscale(): Promise<ServiceStatus> {
  const t = Date.now();
  const ts = await tailscaleStatus();
  if (!ts.available) return result("tailscale", "Tailscale", "unavailable", ts.error ?? "tailscale CLI not available");
  const online = ts.peers.filter((p) => p.online).length;
  const detail = `${online}/${ts.peers.length} peers online${ts.self ? ` · ${ts.self.hostName}` : ""}`;
  return result("tailscale", "Tailscale", ts.self?.online === false ? "down" : "ok", ts.self?.online === false ? "This node is offline" : detail, Date.now() - t);
}

async function checkVpn(): Promise<ServiceStatus> {
  const t = Date.now();
  const v = await vpnStatus();
  const where = v.exit ? [v.exit.city, v.exit.country].filter(Boolean).join(", ") : null;
  if (v.state === "connected") return result("vpn", "VPN", "ok", `${v.provider ?? "VPN"} up${where ? ` · exit ${where}` : ""}${v.notes.length ? ` · ${v.notes.length} note${v.notes.length === 1 ? "" : "s"}` : ""}`, Date.now() - t);
  if (v.state === "disconnected") return result("vpn", "VPN", "down", `${v.provider ?? "VPN"} disconnected — traffic exits via the ISP${v.home ? ` (${v.home.org ?? v.home.ip})` : ""}`, Date.now() - t);
  return result("vpn", "VPN", "unavailable", v.provider ? `${v.provider} detected but state unknown` : "No VPN client or interface detected");
}

function checkDashboard(): ServiceStatus {
  return result("dashboard", "Dashboard", "ok", `Up ${fmtDuration(process.uptime())} · ${fmtBytes(process.memoryUsage().rss)} RSS${cfg.demo ? " · demo mode" : ""}`, 0);
}

export async function getStatus(): Promise<StatusPayload> {
  if (cache && Date.now() - cache.at < 5000) return cache.payload;
  const services = await Promise.all([checkDashboard(), checkTailscale(), checkVpn(), checkJellyfin(), checkMinecraft(), checkDirectus(), checkPostgres()]);
  const payload: StatusPayload = { services, generatedAt: new Date().toISOString(), demo: cfg.demo };
  cache = { at: Date.now(), payload };
  return payload;
}

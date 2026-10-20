// Domain & hostnames card: every name under PUBLIC_DOMAIN — the apps' sites and APIs, the
// dashboard, Minecraft, streaming, planned names — with its records, where it points, whether
// Cloudflare proxies it, the live public answer and a role-appropriate probe. Read-only: this
// module never changes DNS (the owner does that in Cloudflare; see deploy/dns/README.md).
//
// Record sources, in order of preference:
//   1. the Cloudflare DNS API with a READ-ONLY token (new records appear by themselves),
//   2. the zone file (deploy/dns/<domain>.zone — the owner's DNS as data),
//   3. what the config implies (APPS, PUBLIC_DASHBOARD_URL, MC_PUBLIC_ADDRESS, HOSTNAMES_EXTRA).
import fsp from "node:fs/promises";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { hostOf, isCloudflareIp, parseZoneFile } from "../tools/dns-lib.js";
import type { HostRole, HostnameProbe, HostnameRow, HostnamesPayload, ServiceState } from "../types.js";
import { lookup } from "./dnsLookup.js";
import { pingServer } from "./slp.js";

const STATUS_TTL_MS = 60_000;
const RECORDS_TTL_MS = 5 * 60_000;

interface Rec {
  name: string;
  type: string;
  data: string;
  proxied: boolean | null;
}

let recordsCache: { at: number; source: HostnamesPayload["source"]; records: Rec[]; error?: string } | null = null;
let statusCache: { at: number; value: HostnamesPayload } | null = null;

async function cloudflareRecords(domain: string, token: string): Promise<Rec[]> {
  const api = async (path: string): Promise<{ result?: unknown; errors?: { message: string }[] }> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; errors?: { message: string }[] };
    if (!res.ok) throw new Error(`Cloudflare API ${res.status}: ${body.errors?.map((e) => e.message).join("; ") || "request failed"}`);
    return body;
  };
  const zones = (await api(`/zones?name=${encodeURIComponent(domain)}`)).result as { id: string }[] | undefined;
  if (!zones?.length) throw new Error(`zone ${domain} not visible to this token (does it include Zone:Read for this zone?)`);
  const recs = (await api(`/zones/${zones[0].id}/dns_records?per_page=500`)).result as { name: string; type: string; content: string; proxied?: boolean }[] | undefined;
  return (recs ?? []).map((r) => ({ name: r.name.toLowerCase(), type: r.type.toUpperCase(), data: r.content, proxied: typeof r.proxied === "boolean" ? r.proxied : null }));
}

async function loadRecords(domain: string, force: boolean): Promise<NonNullable<typeof recordsCache>> {
  if (recordsCache && !force && Date.now() - recordsCache.at < RECORDS_TTL_MS) return recordsCache;
  let out: NonNullable<typeof recordsCache> = { at: Date.now(), source: "config", records: [] };
  if (cfg.cloudflareApiToken) {
    try {
      out = { at: Date.now(), source: "cloudflare", records: await cloudflareRecords(domain, cfg.cloudflareApiToken) };
    } catch (e) {
      out.error = `${(e as Error).message} — falling back to ${cfg.dnsZoneFile ?? "the config"}`;
    }
  }
  if (out.source !== "cloudflare" && cfg.dnsZoneFile) {
    try {
      const text = await fsp.readFile(cfg.dnsZoneFile, "utf8");
      out = { ...out, source: "zonefile", records: parseZoneFile(text, domain).map((r) => ({ name: r.name, type: r.type, data: r.data.replace(/\.$/, ""), proxied: null })) };
    } catch {
      // no zone file: config-derived names only
    }
  }
  recordsCache = out;
  return out;
}

const HOST_TYPES = new Set(["A", "AAAA", "CNAME"]);

function roleOf(host: string, domain: string, mcHost: string | null, streamHost: string | null, dashHost: string | null): HostRole {
  for (const a of cfg.apps) {
    if (a.siteUrl && new URL(a.siteUrl).host === host) return "site";
    if (a.publicUrl && new URL(a.publicUrl).host === host) return "api";
  }
  if (dashHost && host === dashHost) return "dashboard";
  if (mcHost && host === mcHost) return "game";
  if (streamHost && host === streamHost) return "stream";
  const label = host === domain ? "@" : host.slice(0, -(domain.length + 1));
  if (label === "@" || label === "www") return "site";
  if (/(^|[.-])api([.-]|$)/.test(label)) return "api";
  if (/^(mc|minecraft|play)([.-]|$)/.test(label)) return "game";
  if (/^(stream|streaming|jelly|jellyfin|media|plex|tv)([.-]|$)/.test(label)) return "stream";
  if (/^(dash|dashboard|home|admin)([.-]|$)/.test(label)) return "dashboard";
  return "other";
}

function describeTarget(recs: Rec[], homeIp: string | null): string | null {
  const cname = recs.find((r) => r.type === "CNAME");
  if (cname) {
    if (/\.github\.io$/i.test(cname.data)) return `GitHub Pages (${cname.data})`;
    if (/\.cfargotunnel\.com$/i.test(cname.data)) return "Cloudflare Tunnel";
    return cname.data;
  }
  const a = recs.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.data);
  if (!a.length) return null;
  if (homeIp && a.includes(homeIp)) return `home IP ${homeIp}`;
  if (a.every((ip) => /^185\.199\.(108|109|110|111)\.153$/.test(ip))) return "GitHub Pages";
  return a.join(", ");
}

async function httpsProbe(url: string, timeoutMs = 8000): Promise<HostnameProbe> {
  const t = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), // a browser-shaped UA: Cloudflare's Browser Integrity Check answers 403 to bare bot strings
      headers: { "user-agent": "Mozilla/5.0 (compatible; homelab-dashboard/0.2; +https://github.com/cartergloyd/homelab-dashboard)", accept: "text/html,application/json;q=0.9,*/*;q=0.8" } });
    const latencyMs = Date.now() - t;
    const loc = res.headers.get("location") ?? "";
    const base = { kind: "https" as const, httpStatus: res.status, latencyMs };
    if (res.status >= 200 && res.status < 300) return { ...base, ok: true, detail: `HTTPS ${res.status}` };
    if (res.status >= 300 && res.status < 400) return { ...base, ok: true, detail: /cloudflareaccess\.com/i.test(loc) ? "login wall (Cloudflare Access)" : `redirects to ${loc.replace(/^https?:\/\//, "").slice(0, 50)}` };
    if (res.status === 401) return { ...base, ok: true, detail: "HTTPS 401 (needs a login)" };
    if (res.status === 403) return { ...base, ok: true, detail: "HTTPS 403 (login required, or Cloudflare blocked the probe)" };
    if (res.status === 530 || (res.status >= 520 && res.status <= 526)) return { ...base, ok: false, detail: `Cloudflare ${res.status} — origin not reachable (tunnel down?)` };
    return { ...base, ok: false, detail: `HTTPS ${res.status}` };
  } catch (e) {
    return { kind: "https", ok: false, httpStatus: null, latencyMs: null, detail: (e as Error).message.replace(/^fetch failed:?\s*/i, "") || "no answer" };
  }
}

async function probe(host: string, role: HostRole, port: number | null): Promise<HostnameProbe> {
  switch (role) {
    case "game": {
      const p = await pingServer(host, port ?? 25565, 4000);
      return p ? { kind: "minecraft", ok: true, httpStatus: null, latencyMs: p.latencyMs, detail: `${p.online}/${p.max} players · ${p.version}` } : { kind: "minecraft", ok: false, httpStatus: null, latencyMs: null, detail: `no answer on ${port ?? 25565}` };
    }
    case "api":
      return httpsProbe(`https://${host}/server/health`);
    case "dashboard":
      return httpsProbe(`https://${host}/api/health`);
    case "stream": {
      const first = await httpsProbe(`https://${host}/`);
      if (first.ok) return first;
      const jf = await httpsProbe(`http://${host}:8096/health`, 5000);
      return jf.ok ? { ...jf, detail: "Jellyfin answers on 8096" } : { ...first, detail: `${first.detail} — from inside the house a hairpin-NAT block can hide a working forward` };
    }
    default:
      return httpsProbe(`https://${host}/`);
  }
}

function stateOf(p: HostnameProbe, resolved: string[], planned: boolean): ServiceState {
  if (planned && !resolved.length) return "unavailable";
  if (!resolved.length) return "down";
  if (p.ok) return "ok";
  if (p.httpStatus === 404) return "degraded";
  return "down";
}

export async function hostnamesStatus(force = false): Promise<HostnamesPayload> {
  // [DEMO] demo-mode branch — fixed rows for xgold.tech; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.hostnames();
  if (statusCache && !force && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const domain = cfg.publicDomain;
  if (!domain) return { domain: null, source: "none", zoneFile: null, rows: [], otherRecords: [], checkedAt: new Date().toISOString(), error: "PUBLIC_DOMAIN is not set" };

  const loaded = await loadRecords(domain, force);
  const byHost = new Map<string, Rec[]>();
  const otherRecords: string[] = [];
  const srvPorts = new Map<string, number>();
  for (const r of loaded.records) {
    if (HOST_TYPES.has(r.type)) byHost.set(r.name, [...(byHost.get(r.name) ?? []), r]);
    else if (r.type === "SRV") {
      const m = r.name.match(/^_minecraft\._tcp\.(.+)$/);
      const [, , port, target] = r.data.split(/\s+/);
      if (m && port) srvPorts.set((target ?? m[1]).replace(/\.$/, "").toLowerCase(), Number(port));
      otherRecords.push(`SRV ${r.name} → ${r.data}`);
    } else if (r.type !== "SOA" && r.type !== "NS") otherRecords.push(`${r.type} ${r.name === domain ? "@" : r.name.replace(`.${domain}`, "")} ${r.data}`);
  }

  const mcHost = cfg.minecraft.publicAddress ? hostOf(cfg.minecraft.publicAddress) : [...srvPorts.keys()][0] ?? null;
  const streamHost = (() => {
    try {
      const h = new URL(cfg.jellyfin.publicUrl).host;
      return h.endsWith(domain) ? h : null;
    } catch {
      return null;
    }
  })();
  const dashHost = cfg.cfAccess?.publicUrl ? new URL(cfg.cfAccess.publicUrl).host : null;

  const sources = new Map<string, HostnameRow["source"]>();
  for (const h of byHost.keys()) sources.set(h, loaded.source === "cloudflare" ? "cloudflare" : "zonefile");
  const addConfig = (h: string | null | undefined, src: HostnameRow["source"]) => {
    if (h && h.endsWith(domain) && !sources.has(h)) sources.set(h, src);
  };
  for (const a of cfg.apps) {
    addConfig(a.siteUrl ? new URL(a.siteUrl).host : null, "config");
    addConfig(a.publicUrl ? new URL(a.publicUrl).host : null, "config");
  }
  addConfig(dashHost, "config");
  addConfig(mcHost, "config");
  for (const x of cfg.hostnamesExtra) addConfig(x.includes(".") ? x.toLowerCase() : `${x.toLowerCase()}.${domain}`, "extra");

  const homeIp = mcHost ? (byHost.get(mcHost)?.find((r) => r.type === "A")?.data ?? null) : null;
  const rows = await Promise.all(
    [...sources.entries()].map(async ([host, source]): Promise<HostnameRow> => {
      const recs = byHost.get(host) ?? [];
      const role = roleOf(host, domain, mcHost, streamHost, dashHost);
      const resolved = (await lookup(host, "A")) ?? [];
      const proxiedLive = resolved.length ? resolved.every(isCloudflareIp) : null;
      const proxied = recs.find((r) => r.proxied !== null)?.proxied ?? proxiedLive;
      const planned = source === "extra" || source === "config";
      const p = resolved.length ? await probe(host, role, srvPorts.get(host) ?? null) : { kind: "none" as const, ok: null, httpStatus: null, latencyMs: null, detail: planned ? "no record yet" : "does not resolve" };
      const note = role === "game" && srvPorts.has(host) ? `SRV → port ${srvPorts.get(host)}` : proxied && (role === "game" || role === "stream") ? "proxied — this cannot work for a non-HTTP service; set the record to DNS only" : undefined;
      return { host, role, records: recs.map((r) => `${r.type} ${r.data}`), source, target: describeTarget(recs, homeIp) ?? (resolved.length ? resolved.join(", ") : null), proxied, resolved, probe: p, state: note?.startsWith("proxied") ? "down" : stateOf(p, resolved, planned), note };
    }),
  );
  const order: Record<HostRole, number> = { dashboard: 0, site: 1, api: 2, game: 3, stream: 4, other: 5 };
  rows.sort((a, b) => order[a.role] - order[b.role] || a.host.localeCompare(b.host));
  const value: HostnamesPayload = { domain, source: loaded.source, zoneFile: loaded.source === "zonefile" ? cfg.dnsZoneFile : null, rows, otherRecords, checkedAt: new Date().toISOString(), error: loaded.error };
  statusCache = { at: Date.now(), value };
  return value;
}

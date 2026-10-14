// VPN tab: is the VPN up, where does traffic exit, and which services bypass it.
//
// [INSTALLER] This module was written WITHOUT knowing which VPN runs on the server.
// It probes, in order: provider CLIs (mullvad / nordvpn / protonvpn), WireGuard
// (`wg show`, needs a sudoers rule), tun/wireguard interfaces, `ip rule`/`ip route`,
// nft/iptables mangle rules (sudo), DNS from resolvectl, and an exit-IP
// geolocation lookup. Expect to adjust: VPN_PROVIDER / VPN_INTERFACE in the env,
// the sudoers rules in deploy/sudoers-homelab, and the service list below if the
// real split-tunnel mechanism is something else (e.g. a per-user routing table).
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import type { GeoInfo, VpnPath, VpnPayload, VpnServicePath } from "../types.js";

const execFileP = promisify(execFile);
const CACHE_MS = 30_000;
const GEO_CACHE_MS = 60 * 60_000;

let cache: { at: number; payload: VpnPayload } | null = null;
const geoCache = new Map<string, { at: number; geo: GeoInfo | null }>();

async function run(cmd: string, args: string[], timeout = 6000): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout, maxBuffer: 1 << 20 });
    return stdout;
  } catch {
    return null;
  }
}

async function has(cmd: string): Promise<boolean> {
  return (await run("sh", ["-c", `command -v ${cmd}`])) !== null;
}

// ---- geolocation -------------------------------------------------------------

async function geo(ip?: string, viaInterface?: string): Promise<GeoInfo | null> {
  const key = `${ip ?? "self"}@${viaInterface ?? ""}`;
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_CACHE_MS) return hit.geo;
  const url = `${cfg.vpn.geoUrl}/${ip ? `${ip}/` : ""}json${cfg.vpn.geoToken ? `?token=${cfg.vpn.geoToken}` : ""}`;
  let text: string | null = null;
  if (viaInterface) {
    // Node's fetch can't bind to an interface; curl can.
    text = await run("curl", ["-sS", "--max-time", "6", "--interface", viaInterface, url]);
  } else {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" } });
      if (res.ok) text = await res.text();
    } catch {
      text = null;
    }
  }
  let result: GeoInfo | null = null;
  if (text) {
    try {
      const j = JSON.parse(text) as Record<string, string | undefined>;
      if (j.ip) result = { ip: j.ip, city: j.city ?? null, region: j.region ?? null, country: j.country ?? null, org: j.org ?? null, timezone: j.timezone ?? null, hostname: j.hostname ?? null };
    } catch {
      result = null;
    }
  }
  // negative results are cached briefly so a flapping API doesn't hammer
  geoCache.set(key, { at: result ? Date.now() : Date.now() - GEO_CACHE_MS + 60_000, geo: result });
  return result;
}

// ---- interfaces & routes -----------------------------------------------------

interface Link {
  ifname: string;
  operstate?: string;
  flags?: string[];
  linkinfo?: { info_kind?: string };
}

async function links(): Promise<Link[]> {
  const out = await run("ip", ["-d", "-j", "link", "show"]);
  if (!out) return [];
  try {
    return JSON.parse(out) as Link[];
  } catch {
    return [];
  }
}

function looksLikeVpn(l: Link): boolean {
  if (l.ifname === "tailscale0" || l.ifname.startsWith("docker") || l.ifname.startsWith("br-") || l.ifname.startsWith("veth")) return false;
  const kind = l.linkinfo?.info_kind ?? "";
  return kind === "wireguard" || kind === "tun" || /^(wg|tun|tap|nordlynx|proton|mullvad|pvpn)/i.test(l.ifname);
}

async function defaultRoute(): Promise<string | null> {
  const out = await run("ip", ["-j", "route", "show", "default"]);
  if (!out) return null;
  try {
    const routes = JSON.parse(out) as { dev?: string; metric?: number }[];
    routes.sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
    return routes[0]?.dev ?? null;
  } catch {
    return null;
  }
}

// ---- WireGuard ---------------------------------------------------------------

interface WgPeer {
  iface: string;
  endpoint: string | null;
  latestHandshake: number;
  rx: number;
  tx: number;
}

/** `wg show all dump` — needs `sudo wg show …` in sudoers (deploy/sudoers-homelab). */
async function wgDump(): Promise<{ peers: WgPeer[]; raw: string } | null> {
  const raw = (await run("sudo", ["-n", "wg", "show", "all", "dump"])) ?? (await run("wg", ["show", "all", "dump"]));
  if (!raw) return null;
  const peers: WgPeer[] = [];
  for (const line of raw.trim().split("\n")) {
    const f = line.split("\t");
    if (f.length >= 9) peers.push({ iface: f[0], endpoint: f[3] === "(none)" ? null : f[3], latestHandshake: Number(f[5]) || 0, rx: Number(f[6]) || 0, tx: Number(f[7]) || 0 });
  }
  return { peers, raw: raw.replace(/\t[A-Za-z0-9+/=]{40,}/g, "\t<key>") }; // never expose keys
}

// ---- provider CLIs -----------------------------------------------------------

interface CliInfo {
  provider: string;
  connected: boolean | null;
  server: string | null;
  location: string | null;
  protocol: string | null;
  killSwitch: boolean | null;
  raw: string;
}

function kv(text: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /-]+?):\s*(.+?)\s*$/);
    if (m) o[m[1].toLowerCase()] = m[2];
  }
  return o;
}

async function providerCli(): Promise<CliInfo | null> {
  const want = cfg.vpn.provider;
  if (want === "none" || want === "wireguard" || want === "openvpn") return null;

  if ((want === "auto" || want === "mullvad") && (await has("mullvad"))) {
    const status = (await run("mullvad", ["status", "-v"])) ?? (await run("mullvad", ["status"])) ?? "";
    const lockdown = (await run("mullvad", ["lockdown-mode", "get"])) ?? "";
    // "Connected to se-got-wg-001 in Gothenburg, Sweden" | "Disconnected" | "Connecting…"
    const m = status.match(/Connected to (\S+)(?: in (.+))?/);
    return {
      provider: "Mullvad",
      connected: /^Connected/m.test(status) ? true : /Disconnected/.test(status) ? false : null,
      server: m?.[1] ?? null,
      location: m?.[2]?.trim() ?? null,
      protocol: /wireguard|-wg-/i.test(status) ? "WireGuard" : /openvpn|-ovpn-/i.test(status) ? "OpenVPN" : null,
      killSwitch: /on|enabled|true/i.test(lockdown) ? true : lockdown ? false : null,
      raw: `${status}\n${lockdown}`.trim(),
    };
  }
  if ((want === "auto" || want === "nordvpn") && (await has("nordvpn"))) {
    const status = (await run("nordvpn", ["status"])) ?? "";
    const settings = (await run("nordvpn", ["settings"])) ?? "";
    const s = kv(status);
    const st = kv(settings);
    return {
      provider: "NordVPN",
      connected: /connected/i.test(s.status ?? "") && !/disconnected/i.test(s.status ?? "") ? true : s.status ? false : null,
      server: s.server ?? s.hostname ?? null,
      location: [s.city, s.country].filter(Boolean).join(", ") || null,
      protocol: s.technology ? `${s.technology}${s.protocol ? ` / ${s.protocol}` : ""}` : null,
      killSwitch: st["kill switch"] ? /enabled|on/i.test(st["kill switch"]) : null,
      raw: `${status}\n${settings}`.trim(),
    };
  }
  if (want === "auto" || want === "protonvpn") {
    const bin = (await has("protonvpn-cli")) ? "protonvpn-cli" : (await has("protonvpn")) ? "protonvpn" : null;
    if (bin) {
      const status = (await run(bin, ["status"])) ?? (await run(bin, ["s"])) ?? "";
      const s = kv(status);
      return {
        provider: "Proton VPN",
        connected: /connected/i.test(s.status ?? "") && !/disconnected|not connected/i.test(status) ? true : status ? false : null,
        server: s.server ?? null,
        location: [s.city, s.country].filter(Boolean).join(", ") || s.country || null,
        protocol: s.protocol ?? null,
        killSwitch: s["kill switch"] ? /on|enabled|permanent/i.test(s["kill switch"]) : null,
        raw: status.trim(),
      };
    }
  }
  return null;
}

// ---- DNS ---------------------------------------------------------------------

async function dnsServers(): Promise<string[]> {
  const out = await run("resolvectl", ["status"]);
  const found = new Set<string>();
  if (out) for (const m of out.matchAll(/DNS Servers?:\s*([^\n]+)/g)) for (const ip of m[1].split(/\s+/)) if (/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) found.add(ip);
  if (!found.size) {
    const resolv = await fsp.readFile("/etc/resolv.conf", "utf8").catch(() => "");
    for (const m of resolv.matchAll(/^nameserver\s+(\S+)/gm)) found.add(m[1]);
  }
  return [...found];
}

const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fe80:|fd)/i.test(ip);

// ---- split-tunnel classification -------------------------------------------

interface Probe {
  vpnUp: boolean;
  vpnIface: string | null;
  defaultDev: string | null;
  rules: string;
  firewall: string;
  cli: CliInfo | null;
}

/** [INSTALLER] The service list the traffic map reasons about. Ports come from config. */
function serviceDefs(): { name: string; port: string; needle: string[]; local?: boolean; tailscale?: boolean; advice: string; needed: VpnServicePath["needed"] }[] {
  return [
    {
      name: "Minecraft",
      port: `${cfg.minecraft.port}/tcp`,
      needle: [String(cfg.minecraft.port)],
      needed: "required",
      advice: "Players connect to your home IP (port forward). Replies must leave via the ISP, not the VPN, or connections hang — this port needs a bypass rule.",
    },
    {
      name: "Jellyfin",
      port: "8096/tcp",
      needle: ["8096"],
      needed: "optional",
      advice: "Only needed if people reach Jellyfin from the open internet. Over Tailscale it works without any VPN exception.",
    },
    {
      name: "Tailscale",
      port: "41641/udp · 100.64.0.0/10",
      needle: ["tailscale0", "41641", "100.64.0.0/10", "lookup 52"],
      tailscale: true,
      needed: "required",
      advice: "Must stay outside the VPN. Tailscale carries this dashboard, Directus and SSH; if the VPN's kill switch/firewall blocks tailscale0, UDP 41641 or 100.64.0.0/10 you lose remote access. Allow the interface in the VPN client (Mullvad: lockdown + LAN settings aren't enough on their own — verify for your provider).",
    },
    {
      name: "Directus",
      port: "8055/tcp",
      needle: ["8055"],
      tailscale: true,
      needed: "none",
      advice: "Reached only over Tailscale, so it rides on the Tailscale exception. No separate rule.",
    },
    {
      name: "PostgreSQL",
      port: "5432/tcp (127.0.0.1)",
      needle: ["5432"],
      local: true,
      needed: "none",
      advice: "Bound to 127.0.0.1 — never leaves the machine. Nothing to except.",
    },
    {
      name: "Dashboard",
      port: "3000/tcp (127.0.0.1)",
      needle: ["3000"],
      tailscale: true,
      needed: "none",
      advice: "Loopback + tailscale serve — rides on the Tailscale exception.",
    },
    {
      name: "SSH",
      port: "22/tcp",
      needle: [" 22 ", "dport 22", ":22"],
      needed: "recommended",
      advice: "Over Tailscale nothing is needed. If you also SSH in from the internet, it needs a bypass like Minecraft.",
    },
  ];
}

function classify(p: Probe): VpnServicePath[] {
  const declared = new Map(cfg.vpn.declaredExceptions.map((e) => [e.name.toLowerCase(), e.port]));
  const text = `${p.rules}\n${p.firewall}`;
  const tailscaleRule = /lookup 52|fwmark 0x80000|tailscale0/.test(p.rules);
  return serviceDefs().map((s) => {
    let path: VpnPath = "unknown";
    let evidence = "";
    if (s.local) {
      path = "local";
      evidence = "Bound to loopback.";
    } else if (!p.vpnUp) {
      path = "isp";
      evidence = p.vpnIface ? `VPN interface ${p.vpnIface} is down; everything exits via the ISP.` : "No VPN interface found; everything exits via the ISP.";
    } else if (declared.has(s.name.toLowerCase())) {
      path = "bypass";
      evidence = `Declared in VPN_EXCEPTIONS (${declared.get(s.name.toLowerCase())}).`;
    } else if (s.tailscale && s.name !== "Tailscale") {
      path = tailscaleRule ? "bypass" : "unknown";
      evidence = tailscaleRule ? "Carried inside Tailscale, whose policy routing (table 52) is active." : "Carried inside Tailscale; Tailscale's routing rules were not visible.";
    } else if (s.name === "Tailscale") {
      path = tailscaleRule ? "bypass" : "unknown";
      evidence = tailscaleRule ? "Tailscale policy routing (table 52 / fwmark 0x80000) is present." : "No Tailscale routing rules visible — is tailscaled running?";
    } else {
      const hit = s.needle.find((n) => text.includes(n));
      if (hit) {
        path = "bypass";
        evidence = `Found "${hit.trim()}" in routing/firewall rules (likely a fwmark or allowlist entry).`;
      } else if (p.defaultDev && p.vpnIface && p.defaultDev === p.vpnIface) {
        path = "vpn";
        evidence = `Default route is ${p.defaultDev}; no rule mentions this port.`;
      } else if (p.defaultDev && p.vpnIface && p.defaultDev !== p.vpnIface) {
        path = p.rules.includes("fwmark") ? "vpn" : "isp";
        evidence = p.rules.includes("fwmark") ? `Default route is ${p.defaultDev} but fwmark policy routing is active (VPN likely owns traffic without a mark).` : `Default route is ${p.defaultDev}, not the VPN interface.`;
      } else {
        evidence = "Could not read routing/firewall rules (see diagnostics).";
      }
    }
    return { name: s.name, port: s.port, path, evidence, advice: s.advice, needed: s.needed };
  });
}

// ---- main --------------------------------------------------------------------

export async function vpnStatus(force = false): Promise<VpnPayload> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.vpn();
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.payload;

  const notes: string[] = [];
  const diagnostics: Record<string, string> = {};

  const [allLinks, defaultDev, cli, wg, dns, rulesOut] = await Promise.all([links(), defaultRoute(), providerCli(), wgDump(), dnsServers(), run("ip", ["rule", "show"])]);
  const firewall = (await run("sudo", ["-n", "nft", "list", "ruleset"])) ?? (await run("sudo", ["-n", "iptables", "-t", "mangle", "-S"])) ?? "";
  if (!firewall) notes.push("Firewall rules not readable: add `sudo nft list ruleset` (or iptables -t mangle -S) to deploy/sudoers-homelab to detect port bypass rules.");
  if (!wg) notes.push("`wg show` not available: add `sudo wg show all dump` to sudoers for handshake, endpoint and transfer details.");

  const vpnLinks = allLinks.filter(looksLikeVpn);
  const chosen = cfg.vpn.iface ? allLinks.find((l) => l.ifname === cfg.vpn.iface) ?? null : (vpnLinks.find((l) => l.operstate === "UP" || l.flags?.includes("UP")) ?? vpnLinks[0] ?? null);
  const ifaceUp = chosen ? chosen.operstate === "UP" || chosen.operstate === "UNKNOWN" || Boolean(chosen.flags?.includes("UP")) : false;
  const kind = chosen?.linkinfo?.info_kind;
  const protocol = cli?.protocol ?? (kind === "wireguard" ? "WireGuard" : kind === "tun" ? "OpenVPN / tun" : null);

  const connected = cli?.connected ?? (chosen ? ifaceUp : null);
  const state: VpnPayload["state"] = connected === null ? "unknown" : connected ? "connected" : "disconnected";

  const peer = wg?.peers.find((p) => !chosen || p.iface === chosen.ifname) ?? wg?.peers[0] ?? null;
  let endpoint: VpnPayload["endpoint"] = null;
  if (peer?.endpoint) {
    const m = peer.endpoint.match(/^\[?([^\]]+?)\]?:(\d+)$/);
    const host = m?.[1] ?? peer.endpoint;
    endpoint = { host, port: m ? Number(m[2]) : null, geo: /^[\d.]+$|^[0-9a-f:]+$/i.test(host) ? await geo(host) : null };
  } else if (cli?.server) {
    endpoint = { host: cli.server, port: null, geo: null };
  }

  const exit = state === "disconnected" ? null : await geo();
  const home = cfg.vpn.lanIface ? await geo(undefined, cfg.vpn.lanIface) : state === "disconnected" ? await geo() : null;
  if (state === "connected" && exit && home && exit.ip === home.ip) notes.push("Exit IP equals the LAN-interface IP: traffic is NOT leaving through the VPN even though it reports connected.");

  const rules = rulesOut ?? "";
  const services = classify({ vpnUp: state === "connected", vpnIface: chosen?.ifname ?? null, defaultDev, rules, firewall, cli });

  const dnsNote = dns.length
    ? dns.every(isPrivate)
      ? "DNS goes to a private address (VPN-provided or your router) — not leaking to the ISP's public resolvers."
      : "DNS includes public resolvers; if the VPN is meant to hide DNS, check the client's DNS setting."
    : null;

  diagnostics["ip rule"] = rules.trim() || "(unavailable)";
  diagnostics["ip route default"] = defaultDev ? `default via ${defaultDev}` : "(unavailable)";
  diagnostics["interfaces"] = allLinks.map((l) => `${l.ifname} ${l.operstate ?? ""} ${l.linkinfo?.info_kind ?? ""}`.trim()).join("\n") || "(unavailable)";
  if (wg) diagnostics["wg show all dump"] = wg.raw.trim();
  if (firewall) diagnostics["firewall (mangle/nft)"] = firewall.trim().slice(0, 8000);
  if (cli) diagnostics[`${cli.provider} CLI`] = cli.raw;

  const payload: VpnPayload = {
    checkedAt: new Date().toISOString(),
    state,
    provider: cli?.provider ?? (kind === "wireguard" ? "WireGuard" : kind === "tun" ? "OpenVPN/tun" : null),
    protocol,
    iface: chosen?.ifname ?? null,
    endpoint,
    exit,
    home,
    handshakeAgoSec: peer?.latestHandshake ? Math.max(0, Math.floor(Date.now() / 1000 - peer.latestHandshake)) : null,
    transfer: peer ? { rxBytes: peer.rx, txBytes: peer.tx } : null,
    connectedSince: null,
    killSwitch: cli?.killSwitch ?? null,
    dns,
    dnsNote,
    defaultRouteDev: defaultDev,
    services,
    diagnostics,
    notes,
  };
  cache = { at: Date.now(), payload };
  return payload;
}

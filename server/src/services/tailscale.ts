import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import type { TailscalePayload, TailscalePeer } from "../types.js";

const execFileP = promisify(execFile);

interface RawPeer {
  HostName: string;
  DNSName: string;
  OS: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  LastSeen?: string; // only present when offline
}

export async function tailscaleStatus(): Promise<TailscalePayload> {
  if (cfg.demo) return demo.tailscale();
  try {
    const { stdout } = await execFileP("tailscale", ["status", "--json"], { timeout: 8000 });
    const j = JSON.parse(stdout) as { MagicDNSSuffix?: string; Self?: RawPeer; Peer?: Record<string, RawPeer> };
    const map = (p: RawPeer, self = false): TailscalePeer => ({
      hostName: p.HostName,
      dnsName: p.DNSName,
      os: p.OS,
      ips: p.TailscaleIPs ?? [],
      online: Boolean(p.Online),
      lastSeen: p.Online ? null : (p.LastSeen ?? null),
      self,
    });
    const peers = Object.values(j.Peer ?? {})
      .map((p) => map(p))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName));
    return { available: true, self: j.Self ? map(j.Self, true) : null, peers, magicDnsSuffix: j.MagicDNSSuffix ?? null };
  } catch (e) {
    return { available: false, self: null, peers: [], magicDnsSuffix: null, error: (e as Error).message.split("\n")[0] };
  }
}

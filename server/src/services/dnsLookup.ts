// Public DNS answers for the audit's [dns]/[remote] sections and the hostnames card. DNS-over-HTTPS
// first (the public view, plus DNSSEC validation flags), falling back to plain DNS against
// 1.1.1.1 / 8.8.8.8 where DoH is blocked (corporate networks, Pi-hole rules). Never the LAN resolver.
import dns from "node:dns/promises";
import { RR, readDoh, type DohResponse, type RRName } from "../tools/dns-lib.js";

export async function doh(name: string, type: RRName): Promise<DohResponse | null> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
    return res.ok ? ((await res.json()) as DohResponse) : null;
  } catch {
    return null;
  }
}

const plainResolver = new dns.Resolver({ timeout: 4000, tries: 2 });
plainResolver.setServers(["1.1.1.1", "8.8.8.8"]);
let dohState: boolean | null = null;

/** true/false once known; null before the first lookup */
export function dohWorks(): boolean | null {
  return dohState;
}

/** answers of `type` for `name` (trailing dots dropped, lower-case); [] = no such record; null = no resolver reachable */
export async function lookup(name: string, type: "NS" | "A" | "AAAA" | "CNAME"): Promise<string[] | null> {
  if (dohState !== false) {
    const r = await doh(name, type);
    if (r) {
      dohState = true;
      return readDoh(r, RR[type]).answers.map((a) => a.toLowerCase());
    }
    dohState = false;
  }
  try {
    const out = type === "NS" ? await plainResolver.resolveNs(name) : type === "A" ? await plainResolver.resolve4(name) : type === "AAAA" ? await plainResolver.resolve6(name) : await plainResolver.resolveCname(name);
    return out.map((x) => x.replace(/\.$/, "").toLowerCase());
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? [] : null;
  }
}

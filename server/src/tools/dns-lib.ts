// Pure helpers for the audit's [dns] section (tested by server/test-dns.mjs): is a nameserver
// Cloudflare's, is an address inside Cloudflare's proxy ranges (= the record is "Proxied"),
// how to read a DNS-over-HTTPS (RFC 8484 JSON) answer, and the verdicts the audit prints.
// Network calls live in audit-install.ts so everything here runs offline.

export interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}
export interface DohResponse {
  Status: number;
  /** authenticated data — the resolver validated DNSSEC for this answer */
  AD?: boolean;
  Answer?: DohAnswer[];
  Authority?: DohAnswer[];
}

export const RR = { A: 1, NS: 2, CNAME: 5, AAAA: 28, SRV: 33, DS: 43, DNSKEY: 48 } as const;
export type RRName = keyof typeof RR;

const RCODES: Record<number, string> = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED" };

export function isCloudflareNameserver(ns: string): boolean {
  return /(^|\.)ns\.cloudflare\.com\.?$/i.test(ns.trim());
}

// https://www.cloudflare.com/ips/ (checked 2026-10-20). An answer inside one of these ranges
// means the record is proxied (orange cloud): the origin is hidden and only HTTP/HTTPS passes.
const V4: Array<[string, number]> = [
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22], ["141.101.64.0", 18],
  ["108.162.192.0", 18], ["190.93.240.0", 20], ["188.114.96.0", 20], ["197.234.240.0", 22], ["198.41.128.0", 17],
  ["162.158.0.0", 15], ["104.16.0.0", 13], ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22],
];
const V6: Array<[string, number]> = [
  ["2400:cb00::", 32], ["2606:4700::", 32], ["2803:f800::", 32], ["2405:b500::", 32], ["2405:8100::", 32], ["2a06:98c0::", 29], ["2c0f:f248::", 32],
];

function v4ToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function v6ToBigInt(ip: string): bigint | null {
  const s = ip.trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(s) || s.split("::").length > 2) return null;
  const [head, tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (h.length + t.length > 8 || (!s.includes("::") && h.length !== 8)) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  let out = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    out = (out << 16n) + BigInt(parseInt(g, 16));
  }
  return out;
}

export function isCloudflareIp(ip: string): boolean {
  const n4 = v4ToInt(ip);
  if (n4 !== null) return V4.some(([net, bits]) => (n4 >>> (32 - bits)) === ((v4ToInt(net) as number) >>> (32 - bits)));
  const n6 = v6ToBigInt(ip);
  if (n6 !== null) return V6.some(([net, bits]) => (n6 >> BigInt(128 - bits)) === ((v6ToBigInt(net) as bigint) >> BigInt(128 - bits)));
  return false;
}

/** `mc.xgold.tech:25565` → `mc.xgold.tech`; `[2001:db8::1]:25565` → `2001:db8::1`. */
export function hostOf(address: string): string {
  const s = address.trim();
  const br = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (br) return br[1];
  const m = s.match(/^([^:/]+)(?::\d+)?$/);
  return (m ? m[1] : s).replace(/\.$/, "").toLowerCase();
}

export interface DohRead {
  rcode: string;
  /** data of the answers of the requested type, in order, trailing dots dropped */
  answers: string[];
  ad: boolean;
}

export function readDoh(res: DohResponse | null, type: number): DohRead {
  if (!res) return { rcode: "ERROR", answers: [], ad: false };
  return {
    rcode: RCODES[res.Status] ?? `RCODE${res.Status}`,
    answers: (res.Answer ?? []).filter((a) => a.type === type).map((a) => a.data.replace(/\.$/, "")),
    ad: !!res.AD,
  };
}

export type Verdict = { status: "pass" | "warn" | "fail"; detail: string };

/** DNSSEC consistency between the registrar (DS at the parent) and the zone (what resolvers see). */
export function dnssecVerdict(x: { rcode: string; ad: boolean; dsAtParent: boolean }): Verdict {
  if (x.rcode === "SERVFAIL")
    return { status: "fail", detail: "validating resolvers return SERVFAIL — the DS record the registrar publishes does not match the zone (DNSSEC still on at Squarespace while the Cloudflare zone is unsigned). Turn DNSSEC off at the registrar and wait for the DS to expire, or enable DNSSEC in Cloudflare and paste its DS at the registrar." };
  if (x.dsAtParent && x.ad) return { status: "pass", detail: "signed and validating (the registrar's DS matches the zone)" };
  if (x.dsAtParent) return { status: "warn", detail: "a DS record exists at the registrar but answers do not validate — resolvers will start failing when caches expire unless DNSSEC is enabled in Cloudflare with that exact DS" };
  return { status: "pass", detail: "off (no DS at the registrar) — fine; optional later: enable DNSSEC in Cloudflare, then add its DS at the registrar" };
}

/** What a hostname resolves to vs. what it must be: tunnel hostnames proxied, game/stream hosts not. */
export function proxiedVerdict(ips: string[], expectProxied: boolean): Verdict {
  const cf = ips.filter(isCloudflareIp);
  const list = ips.join(", ");
  if (expectProxied) {
    if (ips.length && cf.length === ips.length) return { status: "pass", detail: `→ ${list} (proxied by Cloudflare — the tunnel's record)` };
    return { status: "fail", detail: `→ ${list} — not a Cloudflare-proxied record. Delete the old A record and add the hostname under the tunnel's Public Hostname tab instead` };
  }
  if (cf.length) return { status: "fail", detail: `→ ${list} is Cloudflare's proxy — a game/stream port cannot pass through it; set the record to DNS only (grey cloud)` };
  return { status: "pass", detail: `→ ${list} (DNS only — clients connect directly)` };
}

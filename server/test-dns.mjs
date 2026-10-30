// Unit checks for the [dns] audit helpers (offline). Run after `npm run build`:
//   node server/test-dns.mjs
import assert from "node:assert/strict";
import { RR, dnssecVerdict, hostOf, isCloudflareIp, isCloudflareNameserver, proxiedVerdict, readDoh } from "./dist/tools/dns-lib.js";

let n = 0;
const eq = (a, b, what) => (assert.deepEqual(a, b, what), n++);

// nameservers
eq(isCloudflareNameserver("robin.ns.cloudflare.com."), true, "Cloudflare NS with trailing dot");
eq(isCloudflareNameserver("RORY.NS.CLOUDFLARE.COM"), true, "case-insensitive");
eq(isCloudflareNameserver("nsa1.squarespacedns.com"), false, "Squarespace NS");
eq(isCloudflareNameserver("cloudflare.com"), false, "bare domain is not an NS host");
eq(isCloudflareNameserver("ns.cloudflare.com.evil.example"), false, "suffix must be the end");

// proxy ranges
eq(isCloudflareIp("104.16.1.1"), true, "104.16/13");
eq(isCloudflareIp("172.64.0.1"), true, "172.64/13");
eq(isCloudflareIp("172.63.255.255"), false, "just below 172.64/13");
eq(isCloudflareIp("99.116.141.110"), false, "the home IP");
eq(isCloudflareIp("185.199.108.153"), false, "GitHub Pages");
eq(isCloudflareIp("2606:4700::6810:1"), true, "2606:4700::/32");
eq(isCloudflareIp("2a06:98c7::1"), true, "2a06:98c0::/29 covers 98c7");
eq(isCloudflareIp("2a06:98c8::1"), false, "2a06:98c8 is outside /29");
eq(isCloudflareIp("2001:db8::1"), false, "documentation prefix");
eq(isCloudflareIp("not an ip"), false, "garbage");
eq(isCloudflareIp("300.1.1.1"), false, "invalid octet");

// host extraction
eq(hostOf("mc.xgold.tech:25565"), "mc.xgold.tech", "strip port");
eq(hostOf("MC.xgold.tech."), "mc.xgold.tech", "lower-case, trailing dot");
eq(hostOf("[2001:db8::1]:25565"), "2001:db8::1", "bracketed IPv6 with port");

// DoH reading
const sample = { Status: 0, AD: false, Answer: [{ name: "fam-api.xgold.tech", type: 5, TTL: 300, data: "abc.cfargotunnel.com." }, { name: "fam-api.xgold.tech", type: 1, TTL: 300, data: "104.21.5.6" }, { name: "fam-api.xgold.tech", type: 1, TTL: 300, data: "172.67.1.2" }] };
eq(readDoh(sample, RR.A), { rcode: "NOERROR", answers: ["104.21.5.6", "172.67.1.2"], ad: false }, "only the requested type, in order");
eq(readDoh({ Status: 3 }, RR.A), { rcode: "NXDOMAIN", answers: [], ad: false }, "NXDOMAIN with no answers");
eq(readDoh(null, RR.NS).rcode, "ERROR", "no response");
eq(readDoh({ Status: 0, Answer: [{ name: "xgold.tech", type: 2, TTL: 3600, data: "robin.ns.cloudflare.com." }] }, RR.NS).answers, ["robin.ns.cloudflare.com"], "NS data without trailing dot");

// DNSSEC
eq(dnssecVerdict({ rcode: "SERVFAIL", ad: false, dsAtParent: true }).status, "fail", "DS at registrar, zone unsigned → SERVFAIL");
eq(dnssecVerdict({ rcode: "NOERROR", ad: true, dsAtParent: true }).status, "pass", "signed and validating");
eq(dnssecVerdict({ rcode: "NOERROR", ad: false, dsAtParent: true }).status, "warn", "DS present, not validating yet");
eq(dnssecVerdict({ rcode: "NOERROR", ad: false, dsAtParent: false }).status, "pass", "DNSSEC off is fine");

// proxied vs DNS-only
eq(proxiedVerdict(["104.21.5.6", "172.67.1.2"], true).status, "pass", "tunnel hostname proxied");
eq(proxiedVerdict(["99.116.141.110"], true).status, "fail", "tunnel hostname still an A record to the house");
eq(proxiedVerdict(["99.116.141.110"], false).status, "pass", "Minecraft DNS only");
eq(proxiedVerdict(["104.21.5.6"], false).status, "fail", "Minecraft accidentally proxied (exactly what the import did)");

console.log(`dns-lib: ${n} checks passed`);

// zone file parser (the repo's own zone file + edge cases)
import fs from "node:fs";
import { parseZoneFile } from "./dist/tools/dns-lib.js";
const zone = parseZoneFile(fs.readFileSync(new URL("../deploy/dns/xgold.tech.zone", import.meta.url), "utf8"));
eq(zone.length, 13, "13 records in deploy/dns/xgold.tech.zone");
eq(zone.filter((r) => r.name === "xgold.tech" && r.type === "A").length, 4, "@ expands to the origin");
eq(zone.find((r) => r.type === "SRV"), { name: "_minecraft._tcp.mc.xgold.tech", type: "SRV", ttl: 3600, data: "0 5 25565 mc.xgold.tech." }, "SRV keeps its four fields");
eq(zone.find((r) => r.name === "fam.xgold.tech")?.data, "cartergloyd.github.io.", "relative owner name, absolute target");
eq(zone.find((r) => r.name === "_dmarc.xgold.tech")?.data, '"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"', "semicolons inside quotes are data, not comments");
eq(zone.find((r) => r.name === "streaming.xgold.tech")?.ttl, 14400, "explicit TTL");
const small = parseZoneFile("$ORIGIN example.com.\n$TTL 300\nwww IN CNAME host.example.net. ; comment\n  IN A 192.0.2.1\n@ 60 IN TXT \"a;b\"\nmail.example.com. IN MX 10 mx.example.com.\n");
eq(small.map((r) => `${r.name} ${r.type} ${r.ttl} ${r.data}`), ["www.example.com CNAME 300 host.example.net.", "www.example.com A 300 192.0.2.1", "example.com TXT 60 \"a;b\"", "mail.example.com MX 300 10 mx.example.com."], "$TTL default, indented continuation, TTL before class, absolute owner");
console.log(`zone parser: ${n} checks total (dns-lib + zone)`);

// A loopback timeout must not claim that outside clients cannot connect.
const { probeHostname, stateOf } = await import("./dist/services/hostnames.js");
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => { throw new Error("connection timed out"); };
  const unreachable = await probeHostname("stream.example.invalid", "stream", null);
  eq(unreachable.ok, null, "unanswered public streaming probe is unverified");
  eq(stateOf(unreachable, ["192.0.2.1"], false), "unavailable", "LAN timeout is not reported down");
  eq(stateOf(unreachable, [], false), "down", "missing DNS is still down");
  globalThis.fetch = async (url) => {
    if (url.startsWith("https:")) throw new Error("connection timed out");
    return { status: 200, headers: new Headers() };
  };
  const reachable = await probeHostname("stream.example.invalid", "stream", null);
  eq(reachable.ok, true, "Jellyfin HTTP fallback can establish availability");
  eq(stateOf(reachable, ["192.0.2.1"], false), "ok", "successful fallback stays healthy");
  globalThis.fetch = async (url) => {
    if (url.startsWith("https:")) throw new Error("connection timed out");
    return { status: 503, headers: new Headers() };
  };
  const failed = await probeHostname("stream.example.invalid", "stream", null);
  eq(failed.httpStatus, 503, "concrete service failure is retained");
  eq(stateOf(failed, ["192.0.2.1"], false), "down", "HTTP service failure remains down");
} finally { globalThis.fetch = originalFetch; }
console.log(`hostnames: ${n} total checks passed`);

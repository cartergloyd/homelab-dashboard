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
const sample = { Status: 0, AD: false, Answer: [{ name: "api.fam.xgold.tech", type: 5, TTL: 300, data: "abc.cfargotunnel.com." }, { name: "api.fam.xgold.tech", type: 1, TTL: 300, data: "104.21.5.6" }, { name: "api.fam.xgold.tech", type: 1, TTL: 300, data: "172.67.1.2" }] };
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

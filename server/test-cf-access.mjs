// Offline checks for the Cloudflare Access token verifier. Run after `npm run build`:
//   node server/test-cf-access.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { accessTokenFrom, decodeJwt, identityFromClaims, isCloudflareRequest, parseCookies, sessionKeyOf, verifyAccessJwt, AccessVerifier } from "./dist/cf-access.js";

let n = 0;
const eq = (a, b, what) => (assert.deepEqual(a, b, what), n++);

const TEAM = "xgold-tech.cloudflareaccess.com";
const AUD = "b58b53ad1be3946251796e34a72115ce8921ca58e35a98dbceb4dc54fd3be469";
const now = Math.floor(Date.now() / 1000);

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey: otherPub, privateKey: otherPriv } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (pub, kid) => ({ ...pub.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });
const keys = [jwkOf(publicKey, "k1")];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload, { kid = "k1", alg = "RS256", key = privateKey } = {}) {
  const input = `${b64({ alg, kid, typ: "JWT" })}.${b64(payload)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url");
  return `${input}.${sig}`;
}
const claims = (over = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 3600, iat: now, nbf: now - 5, email: "Carter@Example.com", sub: "abc", type: "app", country: "US", identity_nonce: "n1", ...over });

// request classification + token extraction
eq(isCloudflareRequest({ "cf-ray": "8d1-ORD" }), true, "cf-ray marks a Cloudflare request");
eq(isCloudflareRequest({ "cf-connecting-ip": "203.0.113.9" }), true, "cf-connecting-ip too");
eq(isCloudflareRequest({ "tailscale-user-login": "x@y" }), false, "a tailnet request is not");
eq(accessTokenFrom({ "cf-access-jwt-assertion": " tok.en.x " }), "tok.en.x", "header wins, trimmed");
eq(accessTokenFrom({ cookie: "a=1; CF_Authorization=" + "x".repeat(30) + "; b=2" }), "x".repeat(30), "cookie fallback");
eq(accessTokenFrom({ cookie: "CF_Authorization=short" }), null, "a short cookie is ignored");
eq(parseCookies("a=1; b=2=3;  c ;=d"), { a: "1", b: "2=3" }, "cookie parsing keeps '=' in values and skips junk");

// verification
const good = sign(claims());
const r = verifyAccessJwt(good, { keys, aud: AUD, teamDomain: TEAM, now });
eq(r.ok, true, "valid token verifies");
eq(r.ok && r.claims.email, "Carter@Example.com", "claims come back");
eq(identityFromClaims(r.claims), { login: "carter@example.com", name: "carter@example.com", service: false }, "identity is the lower-cased email");
eq(verifyAccessJwt(good, { keys, aud: AUD, teamDomain: `https://${TEAM}/`, now }).ok, true, "team domain may be given with scheme/slash");
eq(verifyAccessJwt(good, { keys, aud: "other", teamDomain: TEAM, now }).ok, false, "wrong audience");
eq(verifyAccessJwt(good, { keys, aud: AUD, teamDomain: "evil.cloudflareaccess.com", now }).ok, false, "wrong issuer");
eq(verifyAccessJwt(sign(claims({ exp: now - 120 })), { keys, aud: AUD, teamDomain: TEAM, now }).reason, "token expired", "expired (beyond leeway)");
eq(verifyAccessJwt(sign(claims({ exp: now - 30 })), { keys, aud: AUD, teamDomain: TEAM, now }).ok, true, "60 s leeway on exp");
eq(verifyAccessJwt(sign(claims({ nbf: now + 600 })), { keys, aud: AUD, teamDomain: TEAM, now }).ok, false, "not valid yet");
eq(verifyAccessJwt(sign(claims(), { key: otherPriv }), { keys, aud: AUD, teamDomain: TEAM, now }).reason, "bad signature", "signed by someone else's key");
const u = verifyAccessJwt(sign(claims(), { kid: "k9" }), { keys, aud: AUD, teamDomain: TEAM, now });
eq([u.ok, u.unknownKid], [false, true], "unknown kid is flagged for a key refresh");
eq(verifyAccessJwt(sign(claims(), { alg: "HS256" }), { keys, aud: AUD, teamDomain: TEAM, now }).ok, false, "only RS256");
const [hd, pl, sg] = good.split(".");
eq(verifyAccessJwt(`${hd}.${b64(claims({ email: "attacker@example.com" }))}.${sg}`, { keys, aud: AUD, teamDomain: TEAM, now }).reason, "bad signature", "tampered payload");
eq(verifyAccessJwt("not-a-jwt", { keys, aud: AUD, teamDomain: TEAM, now }).reason, "malformed token", "garbage");
eq(decodeJwt(good)?.header.kid, "k1", "decode exposes the header");
eq(verifyAccessJwt(sign(claims({ email: undefined, sub: undefined })), { keys, aud: AUD, teamDomain: TEAM, now }).ok, false, "no email and no service name → rejected");
const svc = verifyAccessJwt(sign(claims({ email: undefined, common_name: "mcp-laptop" })), { keys, aud: AUD, teamDomain: TEAM, now });
eq(svc.ok && identityFromClaims(svc.claims), { login: "service:mcp-laptop", name: "mcp-laptop", service: true }, "service token identity");
eq(sessionKeyOf(claims()), `Carter@Example.com|n1|${now}`, "session key = who + nonce + issued-at");

// the verifier: caches keys, refetches once on an unknown kid, never trusts stale-key failures silently
let fetches = 0;
let served = keys;
const fakeFetch = async () => (fetches++, { ok: true, status: 200, json: async () => ({ keys: served }) });
const v = new AccessVerifier(TEAM, AUD, fakeFetch);
eq((await v.verify(good)).ok, true, "verifier fetches keys and verifies");
eq(fetches, 1, "one fetch");
eq((await v.verify(good)).ok, true, "second call uses the cache");
eq(fetches, 1, "still one fetch");
const rotated = sign(claims(), { kid: "k2", key: otherPriv });
eq((await v.verify(rotated)).ok, false, "unknown kid: fails while the published keys do not have it");
eq(fetches, 1, "the forced refetch is rate-limited right after a fresh fetch (no hammering)");
eq(v.status().keys, 1, "status reports the cached key count");
const v2 = new AccessVerifier(TEAM, AUD, async () => ({ ok: false, status: 503, json: async () => ({}) }));
const bad = await v2.verify(good);
eq(bad.ok, false, "no keys → rejected, not accepted");
assert.match(bad.reason, /signing keys unavailable/, "and it says why");
n++;

console.log(`cf-access: ${n} checks passed`);

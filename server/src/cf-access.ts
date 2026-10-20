// Cloudflare Access login tokens (issue #10, part 2). When the dashboard is published through the
// tunnel, every request that reaches it has already passed Cloudflare Access, and Cloudflare attaches
// a signed JWT (header `Cf-Access-Jwt-Assertion`, cookie `CF_Authorization`). The dashboard verifies
// that token ITSELF — signature against the team's published keys, audience, issuer, expiry — so a
// misconfigured tunnel or hostname is never enough to get in (two independent locks).
//
// Everything above `AccessVerifier` is pure and tested offline by server/test-cf-access.mjs.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface AccessClaims {
  aud: string | string[];
  iss: string;
  exp: number;
  iat?: number;
  nbf?: number;
  /** a person who logged in through an identity provider */
  email?: string;
  sub?: string;
  /** a service token (automation) instead of a person */
  common_name?: string;
  type?: string;
  country?: string;
  identity_nonce?: string;
}

export type VerifyResult = { ok: true; claims: AccessClaims; kid: string } | { ok: false; reason: string; unknownKid?: boolean };

type HeaderBag = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

function h(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Did this request come through Cloudflare's proxy? Cloudflare always stamps `CF-Ray` and
 *  `CF-Connecting-IP` on proxied requests and clients cannot remove them; a client CAN add them to a
 *  direct request, but that only makes the check stricter (an Access token becomes required). */
export function isCloudflareRequest(headers: HeaderBag): boolean {
  return !!(h(headers, "cf-ray") || h(headers, "cf-connecting-ip") || h(headers, "cf-access-jwt-assertion"));
}

export function parseCookies(cookie: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** The token Cloudflare attached: the header for API/WS calls, the cookie for browser page loads. */
export function accessTokenFrom(headers: HeaderBag): string | null {
  const direct = h(headers, "cf-access-jwt-assertion")?.trim();
  if (direct) return direct;
  const c = parseCookies(h(headers, "cookie"))["CF_Authorization"];
  return c && c.length > 20 ? c : null;
}

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface DecodedJwt {
  header: { alg?: string; kid?: string; typ?: string };
  payload: AccessClaims;
  signingInput: string;
  signature: Buffer;
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  try {
    const header = JSON.parse(b64url(parts[0]).toString("utf8")) as DecodedJwt["header"];
    const payload = JSON.parse(b64url(parts[1]).toString("utf8")) as AccessClaims;
    if (typeof header !== "object" || typeof payload !== "object" || !header || !payload) return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64url(parts[2]) };
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  keys: Jwk[];
  /** the application's Audience (AUD) tag from Zero Trust → Access → Applications */
  aud: string;
  /** e.g. xgold-tech.cloudflareaccess.com */
  teamDomain: string;
  /** seconds since the epoch; defaults to now */
  now?: number;
  /** clock tolerance in seconds */
  leewaySec?: number;
}

/** Pure verification of an Access JWT against already-fetched keys. */
export function verifyAccessJwt(token: string, opts: VerifyOptions): VerifyResult {
  const d = decodeJwt(token);
  if (!d) return { ok: false, reason: "malformed token" };
  if (d.header.alg !== "RS256") return { ok: false, reason: `unsupported algorithm ${d.header.alg ?? "none"}` };
  const kid = d.header.kid ?? "";
  const jwk = opts.keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: `unknown signing key ${kid || "(no kid)"}`, unknownKid: true };
  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
    valid = crypto.verify("RSA-SHA256", Buffer.from(d.signingInput, "utf8"), key, d.signature);
  } catch (e) {
    return { ok: false, reason: `signature check failed: ${(e as Error).message}` };
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  const c = d.payload;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = opts.leewaySec ?? 60;
  const issuer = `https://${opts.teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  if (c.iss !== issuer) return { ok: false, reason: `issuer ${c.iss} is not ${issuer}` };
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(opts.aud)) return { ok: false, reason: "token was issued for a different application (aud)" };
  if (typeof c.exp !== "number" || c.exp + leeway < now) return { ok: false, reason: "token expired" };
  if (typeof c.nbf === "number" && c.nbf - leeway > now) return { ok: false, reason: "token not valid yet" };
  if (!c.email && !c.common_name) return { ok: false, reason: "token carries neither an email nor a service name" };
  return { ok: true, claims: c, kid };
}

/** Who the token belongs to: a person (email) or a service token (common_name). */
export function identityFromClaims(c: AccessClaims): { login: string; name: string; service: boolean } {
  if (c.email) return { login: c.email.toLowerCase(), name: c.email.toLowerCase(), service: false };
  return { login: `service:${c.common_name}`, name: c.common_name ?? "service token", service: true };
}

/** A stable id for "this login session" so the feed records a login once, not per request. */
export function sessionKeyOf(c: AccessClaims): string {
  return `${c.email ?? c.common_name ?? "?"}|${c.identity_nonce ?? c.sub ?? ""}|${c.iat ?? ""}`;
}

// ---- the networked part: fetch + cache the team's signing keys ----------------------------------

const KEYS_TTL_MS = 60 * 60_000;
const REFETCH_MIN_MS = 60_000;

export class AccessVerifier {
  private keys: Jwk[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(
    readonly teamDomain: string,
    readonly aud: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get certsUrl(): string {
    return `https://${this.teamDomain}/cdn-cgi/access/certs`;
  }

  async refresh(force = false): Promise<void> {
    const age = Date.now() - this.fetchedAt;
    if (!force && this.keys.length && age < KEYS_TTL_MS) return;
    if (force && age < REFETCH_MIN_MS && this.keys.length) return; // an attacker's unknown kid must not make us hammer Cloudflare
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.fetchImpl(this.certsUrl, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("no keys in response");
        this.keys = body.keys;
        this.fetchedAt = Date.now();
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as Error).message;
        this.fetchedAt = this.keys.length ? this.fetchedAt : Date.now(); // keep stale keys; back off when we have none
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async verify(token: string): Promise<VerifyResult> {
    await this.refresh();
    if (!this.keys.length) return { ok: false, reason: `Cloudflare Access signing keys unavailable (${this.lastError ?? "not fetched"})` };
    let r = verifyAccessJwt(token, { keys: this.keys, aud: this.aud, teamDomain: this.teamDomain });
    if (!r.ok && r.unknownKid) {
      await this.refresh(true); // key rotation: fetch once more, then decide
      r = verifyAccessJwt(token, { keys: this.keys, aud: this.aud, teamDomain: this.teamDomain });
    }
    return r;
  }

  status(): { keys: number; fetchedAt: string | null; error: string | null } {
    return { keys: this.keys.length, fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null, error: this.lastError };
  }
}

import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { AccessVerifier, accessTokenFrom, identityFromClaims, isCloudflareRequest, sessionKeyOf } from "./cf-access.js";
import { cfg } from "./config.js";
import { publish, touchAgent } from "./services/alerts.js";
import type { IdentityVia } from "./types.js";

export interface Identity {
  login: string;
  name: string;
  /** how this request was authenticated (shown in the footer, recorded in the feed) */
  via: IdentityVia;
  /** true when authenticated with DASHBOARD_KEY (scripts, MCP connector, agents) */
  viaKey?: boolean;
  /** Stable binding to the signed Access login, without retaining its JWT. */
  sessionId?: string;
}

type Resolved = { ok: true; user: Identity } | { ok: false; status: number; message: string };

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Tailscale may RFC 2047-encode display names with non-ASCII characters.
function decodeRfc2047(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return text;
    }
  });
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function keyMatches(given: string): boolean {
  if (!cfg.dashboardKey) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.dashboardKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerOf(headers: IncomingHttpHeaders): string | null {
  const auth = header(headers, "authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

function keyIdentity(headers: IncomingHttpHeaders): Identity {
  const agent = (header(headers, "x-homelab-agent") ?? "").trim().slice(0, 60) || "connector";
  return { login: "dashboard-key", name: agent, via: "key", viaKey: true };
}

// ---- Cloudflare Access (the dashboard published through the tunnel, SERVER_SETUP § 7b) ----------

export const accessVerifier: AccessVerifier | null = cfg.cfAccess ? new AccessVerifier(cfg.cfAccess.teamDomain, cfg.cfAccess.aud) : null;

// login sessions already announced in the feed (bounded; a session = person + nonce + issued-at)
const seenSessions = new Set<string>();
function noteLogin(key: string, who: string, country: string | undefined): void {
  if (seenSessions.has(key)) return;
  if (seenSessions.size > 500) seenSessions.clear();
  seenSessions.add(key);
  publish({ source: "dashboard", kind: "log", level: "info", tags: ["maintenance", "security"], text: `Remote login via Cloudflare Access: ${who}${country ? ` (${country})` : ""}` });
}

/**
 * Requests that arrived through Cloudflare's proxy (the tunnel). Tailscale headers are NEVER read
 * here — anyone on the internet could type them — the identity comes only from the Access token
 * Cloudflare attached, which we verify ourselves. The bearer key is accepted over the tunnel only
 * together with a valid service-token Access JWT: human logins cannot authorize automation.
 */
async function resolveCloudflare(headers: IncomingHttpHeaders): Promise<Resolved> {
  if (!cfg.cfAccess || !accessVerifier) {
    return { ok: false, status: 401, message: "This dashboard is not published for remote access (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD unset). Use its Tailscale address." };
  }
  const token = accessTokenFrom(headers);
  if (!token) {
    return { ok: false, status: 401, message: `No Cloudflare Access token on this request. Sign in at ${cfg.cfAccess.publicUrl ?? `https://${cfg.cfAccess.teamDomain}`}.` };
  }
  const r = await accessVerifier.verify(token);
  if (!r.ok) return { ok: false, status: 401, message: `Cloudflare Access token rejected: ${r.reason}` };
  const who = identityFromClaims(r.claims);

  const bearer = bearerOf(headers);
  if (bearer !== null) {
    if (!who.service) return { ok: false, status: 403, message: "Remote automation requires a Cloudflare Access service token in addition to the dashboard key." };
    if (!keyMatches(bearer)) return { ok: false, status: 401, message: "Invalid dashboard key" };
    noteLogin(sessionKeyOf(r.claims), `${who.name} + dashboard key`, r.claims.country);
    return { ok: true, user: keyIdentity(headers) };
  }
  if (who.service) {
    return { ok: false, status: 401, message: "A service token must be combined with the dashboard key (Authorization: Bearer …) to use the API." };
  }
  if (cfg.allowedLogins.length && !cfg.allowedLogins.map((l) => l.toLowerCase()).includes(who.login)) {
    return { ok: false, status: 403, message: `${who.login} is not in ALLOWED_LOGINS` };
  }
  noteLogin(sessionKeyOf(r.claims), who.login, r.claims.country);
  return { ok: true, user: { login: who.login, name: who.name, via: "cloudflare", sessionId: crypto.createHash("sha256").update(sessionKeyOf(r.claims)).digest("hex") } };
}

/**
 * Three ways in:
 *  1. Tailscale identity headers. The app binds to 127.0.0.1 and `tailscale serve`
 *     proxies to it, stripping any inbound Tailscale-* headers before adding its own,
 *     so they are trustworthy only on local connections. Funnel is refused.
 *  2. `Authorization: Bearer <DASHBOARD_KEY>` for scripts and the MCP connector.
 *     `X-Homelab-Agent` names the agent so its actions are attributed in the feed.
 *  3. Through the Cloudflare Tunnel: a Cloudflare Access token, verified here (above).
 */
export async function resolveIdentity(headers: IncomingHttpHeaders, remoteAddress: string | undefined): Promise<Resolved> {
  if (isCloudflareRequest(headers)) return resolveCloudflare(headers);

  const bearer = bearerOf(headers);
  if (bearer !== null) {
    if (!isLoopback(remoteAddress)) return { ok: false, status: 403, message: "Dashboard keys require a private loopback proxy or a Cloudflare Access service token." };
    if (!keyMatches(bearer)) return { ok: false, status: 401, message: "Invalid dashboard key" };
    return { ok: true, user: keyIdentity(headers) };
  }

  if (cfg.authDisabled) return { ok: true, user: { login: "local-dev", name: "Local dev", via: "dev" } };
  if (!isLoopback(remoteAddress)) return { ok: false, status: 403, message: "Tailnet access only" };
  if (header(headers, "tailscale-funnel-request")) return { ok: false, status: 403, message: "Funnel requests are not allowed" };

  const login = header(headers, "tailscale-user-login");
  if (!login) {
    return {
      ok: false,
      status: 401,
      message: "No Tailscale identity on this request. Open the dashboard through its tailscale serve address.",
    };
  }
  if (cfg.allowedLogins.length && !cfg.allowedLogins.includes(login)) {
    return { ok: false, status: 403, message: `${login} is not in ALLOWED_LOGINS` };
  }
  const rawName = header(headers, "tailscale-user-name");
  return { ok: true, user: { login, name: rawName ? decodeRfc2047(rawName) : login, via: "tailscale" } };
}

export async function identityMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await resolveIdentity(req.headers, req.socket.remoteAddress);
  if (!result.ok) {
    res.status(result.status).json({ error: result.message });
    return;
  }
  res.locals.user = result.user;
  // keyed callers count as a present agent — except the terminal tee wrapper feeding /ingest
  if (result.user.viaKey && !req.path.startsWith("/api/alerts/ingest")) touchAgent(result.user.name);
  next();
}

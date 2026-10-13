import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { cfg } from "./config.js";
import { touchAgent } from "./services/alerts.js";

export interface Identity {
  login: string;
  name: string;
  /** true when authenticated with DASHBOARD_KEY (scripts, MCP connector, agents) */
  viaKey?: boolean;
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

/**
 * Two ways in:
 *  1. Tailscale identity headers. The app binds to 127.0.0.1 and `tailscale serve`
 *     proxies to it, stripping any inbound Tailscale-* headers before adding its own,
 *     so they are trustworthy only on local connections. Funnel is refused.
 *  2. `Authorization: Bearer <DASHBOARD_KEY>` for scripts and the MCP connector.
 *     `X-Homelab-Agent` names the agent so its actions are attributed in the feed.
 */
export function resolveIdentity(headers: IncomingHttpHeaders, remoteAddress: string | undefined): Resolved {
  const auth = header(headers, "authorization");
  if (auth?.startsWith("Bearer ")) {
    if (!keyMatches(auth.slice(7).trim())) return { ok: false, status: 401, message: "Invalid dashboard key" };
    const agent = (header(headers, "x-homelab-agent") ?? "").trim().slice(0, 60) || "connector";
    return { ok: true, user: { login: "dashboard-key", name: agent, viaKey: true } };
  }

  if (cfg.authDisabled) return { ok: true, user: { login: "local-dev", name: "Local dev" } };
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
  return { ok: true, user: { login, name: rawName ? decodeRfc2047(rawName) : login } };
}

export function identityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const result = resolveIdentity(req.headers, req.socket.remoteAddress);
  if (!result.ok) {
    res.status(result.status).json({ error: result.message });
    return;
  }
  res.locals.user = result.user;
  // keyed callers count as a present agent — except the terminal tee wrapper feeding /ingest
  if (result.user.viaKey && !req.path.startsWith("/api/alerts/ingest")) touchAgent(result.user.name);
  next();
}

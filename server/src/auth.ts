import type { IncomingHttpHeaders } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { cfg } from "./config.js";

export interface Identity {
  login: string;
  name: string;
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

/**
 * The app binds to 127.0.0.1 and `tailscale serve` proxies to it. Serve strips any
 * inbound Tailscale-* headers before adding its own, so they are trustworthy only
 * when the connection really is local. Funnel (public internet) requests are refused.
 */
export function resolveIdentity(headers: IncomingHttpHeaders, remoteAddress: string | undefined): Resolved {
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
  next();
}

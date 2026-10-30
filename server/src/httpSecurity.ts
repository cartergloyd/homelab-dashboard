import type { RequestHandler } from "express";
import { cfg } from "./config.js";

/** Applied before parsing/authentication so error responses have the same headers. */
export const httpSecurity: RequestHandler = (req, res, next) => {
  const socketOrigin = cfg.cfAccess?.publicUrl ? new URL(cfg.cfAccess.publicUrl).origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:") : "";
  res.set({
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${socketOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    "Strict-Transport-Security": "max-age=15552000",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  // Configuration includes an integration key for signed-in owners. No API
  // response may be cached by the browser, a proxy or Cloudflare.
  if (/^\/api(?:\/|$)/i.test(req.path)) res.set("Cache-Control", "no-store");
  next();
};

/** Limit confirmation/approval attempts per authenticated identity, across sessions. */
export function sensitiveRateLimit(now = Date.now): RequestHandler {
  const windows = new Map<string, { expires: number; count: number }>();
  return (req, res, next) => {
    let route: string;
    try { route = decodeURIComponent(req.path).toLowerCase(); } catch { next(); return; }
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !/^\/api\/(?:security(?:\/|$)|sidecar\/(?:approvals|settings)(?:\/|$))/.test(route)) { next(); return; }
    const time = now();
    for (const [key, value] of windows) if (value.expires <= time) windows.delete(key);
    const key = String(res.locals.user?.login ?? "unknown").toLowerCase();
    let window = windows.get(key);
    if (!window && windows.size < 2000) { window = { expires: time + 60_000, count: 0 }; windows.set(key, window); }
    if (!window || ++window.count > 30) {
      res.set("Retry-After", String(Math.max(1, Math.ceil(((window?.expires ?? time + 60_000) - time) / 1000))));
      res.status(429).json({ error: "Too many security or approval requests. Try again shortly." });
      return;
    }
    next();
  };
}

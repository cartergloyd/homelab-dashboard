import http from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RequestHandler } from "express";
import { resolveIdentity } from "../auth.js";
import { cfg } from "../config.js";

// AppFlowy's web app assumes it owns the site root. Its API, sign-in and websocket URLs are runtime
// config, so those live under /appflowy/* (prefix stripped on the way in). The pages and files it
// requests by absolute path are the few root paths in ROOT. Everything else stays the dash's.
const PREFIX = /^\/appflowy(?:\/|$)/;
const ROOT = /^\/(?:app(?:\/|$)|login(?:\/|$)|static\/|covers\/|af_icons\/|pdfjs\/|appflowy\.(?:svg|ico)$|og-image\.png$)/;

// Sign-in belongs to the dash (Cloudflare Access / Tailscale), so none of its credentials go to AppFlowy.
const DROP = ["cookie", "connection", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "x-homelab-agent", "x-homelab-run-id"];

// The dash's own CSP is stricter than AppFlowy can run under (inline config, wasm, blob workers) and says
// frame-ancestors 'none'. Only responses that came from AppFlowy get this one.
const CSP = "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

export const isNotesPath = (p: string): boolean => !!cfg.notes && (PREFIX.test(p) || ROOT.test(p));

/** Where on AppFlowy's nginx a request goes; null for the bare /appflowy entry, which opens the app. */
function upstreamPath(url: string): string | null {
  if (!PREFIX.test(url.split("?")[0])) return url;
  const rest = url.slice("/appflowy".length);
  return rest === "" || rest === "/" || rest.startsWith("?") || rest.startsWith("/?") ? null : rest;
}

function upstreamHeaders(h: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = { ...h };
  for (const k of DROP) delete out[k];
  return out;
}

// AppFlowy's own bearer token travels in Authorization, so it must not be judged as a dashboard key.
const who = (req: IncomingMessage) => resolveIdentity({ ...req.headers, authorization: undefined }, req.socket.remoteAddress).catch((e: Error) => ({ ok: false as const, status: 500, message: e.message }));

export const notesProxy: RequestHandler = async (req, res, next) => {
  if (!isNotesPath(req.path)) return next();
  const id = await who(req);
  if (!id.ok) {
    res.status(id.status).type("text/plain").send(id.message);
    return;
  }
  const path = upstreamPath(req.url);
  if (path === null) {
    res.redirect(302, "/app");
    return;
  }
  const up = http.request({ ...cfg.notes!, method: req.method, path, headers: upstreamHeaders(req.headers) }, (r) => {
    const headers: http.OutgoingHttpHeaders = { ...r.headers, "content-security-policy": CSP, "x-frame-options": "SAMEORIGIN" };
    delete headers.connection;
    delete headers["keep-alive"];
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (res.headersSent) res.destroy();
    else res.status(502).type("text/plain").send("Notes is not reachable. Check ./dc ps in ~/server-platform/appflowy.");
  });
  req.pipe(up);
};

/** AppFlowy's realtime sync is a websocket under /appflowy/ws/…; /ws/logs etc. stay in ws.ts. */
export function attachNotesSocket(server: http.Server): void {
  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "/";
    if (!cfg.notes || !PREFIX.test(url.split("?")[0])) return;
    const id = await who(req);
    if (socket.destroyed) return;
    const path = upstreamPath(url);
    if (!id.ok || path === null) {
      socket.end(`HTTP/1.1 ${id.ok ? 404 : id.status} ${id.ok ? "Not found" : id.message.replace(/[\r\n]/g, " ")}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const up = http.request({ ...cfg.notes, method: "GET", path, headers: { ...upstreamHeaders(req.headers), connection: "Upgrade", upgrade: "websocket" } });
    up.on("upgrade", (r, upSocket, upHead) => {
      let raw = "HTTP/1.1 101 Switching Protocols\r\n";
      for (let i = 0; i < r.rawHeaders.length; i += 2) raw += `${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}\r\n`;
      socket.write(raw + "\r\n");
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      socket.on("error", () => upSocket.destroy());
      upSocket.on("error", () => socket.destroy());
    });
    up.on("response", (r) => socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ""}\r\nConnection: close\r\n\r\n`)); // upstream said no
    up.on("error", () => socket.destroy());
    up.end();
  });
}

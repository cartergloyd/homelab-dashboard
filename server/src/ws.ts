import type http from "node:http";
import type net from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { resolveIdentity } from "./auth.js";
import { isProblem, isTailed, query, recentLines, subscribe, subscribeRaw } from "./services/alerts.js";
import { LOG_SOURCES, openLogStream } from "./services/logs.js";
import type { AlertSource, LogSource } from "./types.js";

const MAX_BUFFERED = 1_000_000; // bytes queued to a slow client before we drop messages
const MAX_LINE = 4000;

/**
 * /ws/logs?source=<LogSource>            raw lines of one source
 * /ws/alerts[?sources=a,b&problemsOnly=1] classified events from the alerts hub
 */
export function attachLogSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws/logs" && url.pathname !== "/ws/alerts") {
      socket.destroy();
      return;
    }
    // async: a Cloudflare Access token may need the team's signing keys fetched first
    const id = await resolveIdentity(req.headers, (socket as net.Socket).remoteAddress).catch((e: Error) => ({ ok: false as const, status: 500, message: e.message }));
    if (socket.destroyed) return;
    if (!id.ok) {
      socket.write(`HTTP/1.1 ${id.status} ${id.message.replace(/[\r\n]/g, " ")}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", async (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (payload: unknown) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) return;
      ws.send(JSON.stringify(payload));
    };
    const clip = (line: string) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    const keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 30_000);
    let stop: (() => void) | null = null;

    if (url.pathname === "/ws/alerts") {
      const sources = url.searchParams.get("sources")?.split(",").filter(Boolean) as AlertSource[] | undefined;
      const problemsOnly = url.searchParams.get("problemsOnly") === "1";
      send({ type: "backlog", events: query({ sources, problemsOnly, limit: 300 }) });
      stop = subscribe((e) => {
        if (sources?.length && !sources.includes(e.source)) return;
        if (problemsOnly && !isProblem(e)) return;
        send({ type: "event", event: e });
      });
    } else {
      const source = url.searchParams.get("source") as LogSource | null;
      if (!source || !LOG_SOURCES.includes(source)) {
        ws.close(1008, "Unknown log source");
        clearInterval(keepAlive);
        return;
      }
      const sendLine = (line: string) => send({ type: "line", line: clip(line) });
      if (isTailed(source)) {
        // the hub already tails this source — replay its buffer, then follow
        send({ type: "lines", lines: recentLines(source, 200).map(clip) });
        stop = subscribeRaw(source, sendLine);
      } else {
        try {
          stop = await openLogStream(source, sendLine);
        } catch (e) {
          sendLine(`[error] ${(e as Error).message}`);
        }
      }
    }

    ws.on("close", () => {
      clearInterval(keepAlive);
      stop?.();
    });
  });
}

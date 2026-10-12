import type http from "node:http";
import type net from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { resolveIdentity } from "./auth.js";
import { LOG_SOURCES, openLogStream } from "./services/logs.js";
import type { LogSource } from "./types.js";

const MAX_BUFFERED = 1_000_000; // bytes queued to a slow client before we drop lines
const MAX_LINE = 4000;

/** /ws/logs?source=<LogSource> — streams one log source per connection. */
export function attachLogSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws/logs") {
      socket.destroy();
      return;
    }
    const id = resolveIdentity(req.headers, (socket as net.Socket).remoteAddress);
    if (!id.ok) {
      socket.write(`HTTP/1.1 ${id.status} ${id.message.replace(/[\r\n]/g, " ")}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", async (ws: WebSocket, req: http.IncomingMessage) => {
    const source = new URL(req.url ?? "/", "http://localhost").searchParams.get("source") as LogSource | null;
    if (!source || !LOG_SOURCES.includes(source)) {
      ws.close(1008, "Unknown log source");
      return;
    }
    const send = (line: string) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) return;
      ws.send(JSON.stringify({ type: "line", line: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line }));
    };

    let stop: (() => void) | null = null;
    try {
      stop = await openLogStream(source, send);
    } catch (e) {
      send(`[error] ${(e as Error).message}`);
    }
    const keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 30_000);
    ws.on("close", () => {
      clearInterval(keepAlive);
      stop?.();
    });
  });
}

import { useEffect, useRef, useState } from "react";
import { logSocketUrl } from "../api";
import type { LogSource } from "../types";

const MAX_LINES = 2000;

type Conn = "connecting" | "open" | "closed";

function lineClass(line: string): string {
  if (/\b(ERROR|SEVERE|FATAL|\[ERR|\[error\]|Exception)\b/i.test(line)) return "log-line err";
  if (/\b(WARN|WARNING|\[WRN)\b/i.test(line)) return "log-line warn";
  return "log-line";
}

export function LogViewer({ source, height = 420 }: { source: LogSource; height?: number | string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [conn, setConn] = useState<Conn>("connecting");
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setLines([]);
    setConn("connecting");
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pending: string[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(logSocketUrl(source));
      ws.onopen = () => setConn("open");
      ws.onmessage = (ev) => {
        if (pausedRef.current) return;
        try {
          const msg = JSON.parse(ev.data as string) as { type: string; line: string };
          if (msg.type !== "line") return;
          pending.push(msg.line);
          flush ??= setTimeout(() => {
            flush = null;
            const batch = pending;
            pending = [];
            setLines((prev) => {
              const next = prev.concat(batch);
              return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
            });
          }, 80);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setConn("closed");
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (flush) clearTimeout(flush);
      ws?.close();
    };
  }, [source]);

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const shown = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;

  return (
    <div className="log" style={{ height }}>
      <div className="log-bar">
        <span className={`pill ${conn === "open" ? "ok" : conn === "connecting" ? "degraded" : "down"}`}>
          <span className="dot" />
          {conn === "open" ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted small">{shown.length} lines</span>
        <span style={{ flex: 1 }} />
        <button className={`btn sm ${follow ? "primary" : ""}`} onClick={() => setFollow(true)}>
          Follow
        </button>
        <button className="btn sm" onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="btn sm ghost" onClick={() => setLines([])}>
          Clear
        </button>
      </div>
      <div className="log-body" ref={bodyRef} onScroll={onScroll}>
        {shown.length === 0 && <span className="skeleton">Waiting for output…</span>}
        {shown.map((l, i) => (
          <div key={i} className={lineClass(l)}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

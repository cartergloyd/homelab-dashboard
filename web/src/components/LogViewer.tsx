import { useEffect, useRef, useState } from "react";
import { logSocketUrl } from "../api";
import { useEventSocket } from "../hooks/useEventSocket";
import type { LogSource } from "../types";

function lineClass(line: string): string {
  if (/\b(ERROR|SEVERE|FATAL|\[ERR|\[error\]|Exception)\b/i.test(line)) return "log-line err";
  if (/\b(WARN|WARNING|\[WRN)\b/i.test(line)) return "log-line warn";
  return "log-line";
}

type Msg = { type: "line"; line: string } | { type: "lines"; lines: string[] };
const extract = (msg: unknown): string[] | null => {
  const m = msg as Msg;
  if (m.type === "line") return [m.line];
  if (m.type === "lines") return m.lines;
  return null;
};

/** Raw tail of one log source (System → Logs). */
export function LogViewer({ source, height = 420 }: { source: LogSource; height?: number | string }) {
  const { items: lines, conn, paused, setPaused, clear } = useEventSocket<string>(logSocketUrl(source), extract, 2000);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

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
        <button className="btn sm ghost" onClick={clear}>
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

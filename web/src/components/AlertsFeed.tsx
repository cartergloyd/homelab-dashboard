// Live Server Alerts: the Minecraft log, scheduled jobs, script output and agent
// actions in one feed, with a one-click "Problems & maintenance" filter.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { alertsSocketUrl, api } from "../api";
import { selectAlert, useSelectedAlert } from "../alertSelection";
import { useEventSocket } from "../hooks/useEventSocket";
import type { AlertEvent, AlertSource, Incident } from "../types";

const GROUPS: { id: string; label: string; sources: AlertSource[] }[] = [
  { id: "minecraft", label: "Minecraft", sources: ["minecraft"] },
  { id: "jobs", label: "Jobs", sources: ["jobs"] },
  { id: "scripts", label: "Scripts", sources: ["scripts"] },
  { id: "agent", label: "Agent", sources: ["agent"] },
  { id: "other", label: "Other services", sources: ["jellyfin", "directus", "postgres", "dashboard", "system"] },
];
const DEFAULT_GROUPS = ["minecraft", "jobs", "scripts", "agent"];

const SOURCE_LABEL: Record<AlertSource, string> = {
  minecraft: "mc",
  jobs: "job",
  scripts: "script",
  agent: "agent",
  jellyfin: "jellyfin",
  directus: "directus",
  postgres: "postgres",
  dashboard: "dash",
  system: "system",
};

type Msg = { type: "backlog"; events: AlertEvent[] } | { type: "event"; event: AlertEvent };
const extract = (msg: unknown): AlertEvent[] | null => {
  const m = msg as Msg;
  if (m.type === "backlog") return m.events;
  if (m.type === "event") return [m.event];
  return null;
};

export const isProblem = (e: AlertEvent): boolean => e.level !== "info" || e.tags.includes("maintenance") || e.kind !== "log";

function readLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

const time = (iso: string) => iso.slice(11, 19);

export function AlertsFeed({ height = 460 }: { height?: number | string }) {
  const { items, conn, paused, setPaused, clear } = useEventSocket<AlertEvent>(alertsSocketUrl(), extract, 3000);
  const [problemsOnly, setProblemsOnly] = useState(() => readLS("alerts.problemsOnly", false));
  const [groups, setGroups] = useState<string[]>(() => readLS("alerts.groups", DEFAULT_GROUPS));
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selected = useSelectedAlert();
  // which rows belong to a sidecar incident (for the marker + tooltip)
  const incidents = useQuery({ queryKey: ["sidecar", "incidents"], queryFn: () => api.get<Incident[]>("/sidecar/incidents?limit=100"), refetchInterval: 10_000 });
  const incidentOf = useMemo(() => {
    const m = new Map<string, Incident>();
    for (const inc of incidents.data ?? []) for (const id of inc.alertIds) m.set(id, inc);
    return m;
  }, [incidents.data]);

  useEffect(() => writeLS("alerts.problemsOnly", problemsOnly), [problemsOnly]);
  useEffect(() => writeLS("alerts.groups", groups), [groups]);

  const enabledSources = useMemo(() => new Set(GROUPS.filter((g) => groups.includes(g.id)).flatMap((g) => g.sources)), [groups]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return items.filter((e) => enabledSources.has(e.source) && (!problemsOnly || isProblem(e)) && (!q || e.text.toLowerCase().includes(q)));
  }, [items, enabledSources, problemsOnly, filter]);

  const counts = useMemo(() => {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    let errors = 0;
    let warns = 0;
    let maint = 0;
    for (const e of items) {
      if (e.ts < hourAgo || !enabledSources.has(e.source)) continue;
      if (e.level === "error") errors++;
      else if (e.level === "warn") warns++;
      if (e.tags.includes("maintenance") || e.kind === "job" || e.kind === "script") maint++;
    }
    return { errors, warns, maint };
  }, [items, enabledSources]);

  useEffect(() => {
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const toggleGroup = (id: string) => setGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  return (
    <div className="log" style={{ height }}>
      <div className="log-bar">
        <button className={`btn sm ${problemsOnly ? "primary" : ""}`} onClick={() => setProblemsOnly((p) => !p)} title="Hide routine log lines; keep errors, warnings, restarts, backups, jobs, scripts and agent actions">
          {problemsOnly ? "● " : "○ "}Problems &amp; maintenance
        </button>
        <span className="muted small nowrap">
          <span style={{ color: counts.errors ? "var(--critical)" : undefined }}>{counts.errors} errors</span> · {counts.warns} warnings · {counts.maint} maintenance <span className="muted">(last hour)</span>
        </span>
        <span style={{ flex: 1 }} />
        <span className={`pill ${conn === "open" ? "ok" : conn === "connecting" ? "degraded" : "down"}`}>
          <span className="dot" />
          {conn === "open" ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
      </div>
      <div className="log-bar">
        {GROUPS.map((g) => (
          <button key={g.id} className={`btn sm ${groups.includes(g.id) ? "" : "ghost"}`} style={{ opacity: groups.includes(g.id) ? 1 : 0.55 }} onClick={() => toggleGroup(g.id)}>
            {g.label}
          </button>
        ))}
        <input className="input" style={{ maxWidth: 200 }} placeholder="Filter text…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span style={{ flex: 1 }} />
        <span className="muted small">{shown.length}</span>
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
      <div className="log-body ev-body" ref={bodyRef} onScroll={onScroll}>
        {shown.length === 0 && <span className="skeleton">{problemsOnly ? "No problems or maintenance events yet — that's good." : "Waiting for events…"}</span>}
        {shown.map((e) => {
          const inc = incidentOf.get(e.id) ?? (e.meta?.incidentId ? (incidents.data ?? []).find((i) => i.id === e.meta?.incidentId) : undefined);
          return (
            <div
              key={e.id}
              className={`ev ev-${e.level}${e.kind !== "log" || e.tags.includes("maintenance") ? " ev-maint" : ""}${selected?.id === e.id ? " ev-selected" : ""}${inc ? " ev-incident" : ""}`}
              title={`${new Date(e.ts).toLocaleString()}${inc ? ` · incident #${inc.id} (${inc.status}): ${inc.title}` : ""} — click to select for the Assistant`}
              onClick={() => selectAlert(e)}
              role="button"
            >
              <span className="ev-time">{time(e.ts)}</span>
              <span className={`ev-src src-${e.source}`}>{e.meta?.script ?? e.meta?.label ?? SOURCE_LABEL[e.source]}</span>
              <span className="ev-text">{e.text}</span>
              {inc && <span className="ev-inc mono" title={`incident #${inc.id}`}>#{inc.id}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

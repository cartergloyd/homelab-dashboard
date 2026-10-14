// Assistant panel beside the alerts feed: which agent is connected (via MCP),
// what it last did, problem counts, and the two doors — instructions/context
// and the connect-an-agent snippet. It does not run a model itself.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { fmtRelative } from "../format";
import type { AgentPresence, AgentRun, AgentRunner, AlertEvent, AlertSummary } from "../types";
import { ContextModal } from "./ContextModal";
import { Icons } from "./icons";
import { Modal, StatusPill, useToast } from "./ui";

const ONLINE_MS = 5 * 60_000;

function ConnectModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [runner, setRunner] = useState<AgentRunner>("codex");
  const [task, setTask] = useState(
    "Review recent Live server alerts, read the Minecraft instructions and context, investigate anything broken, make safe repairs, and submit a maintenance report.",
  );
  const runs = useQuery({ queryKey: ["agents", "runs"], queryFn: () => api.get<AgentRun[]>("/agents/runs?limit=5"), refetchInterval: 5000 });
  const running = runs.data?.find((r) => r.status === "running");
  const launch = useMutation({
    mutationFn: () => api.post<AgentRun>("/agents/launch", { runner, task }),
    onSuccess: () => {
      toast("Agent launched");
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["agents", "runs"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <Modal title="Launch an agent" onClose={onClose} wide>
      <div className="stack">
        <div className="notice">
          This starts a signed-in terminal agent on the server with `/home/gold/Minecraft Server` as its workspace. Output and actions appear in Live server alerts.
        </div>
        <div className="form-grid">
          <label className="field">
            Agent
            <select className="input" value={runner} onChange={(e) => setRunner(e.target.value as AgentRunner)} disabled={!!running || launch.isPending}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label className="field">
            Workspace
            <input className="input mono" value="/home/gold/Minecraft Server" readOnly />
          </label>
        </div>
        <label className="field">
          Task
          <textarea className="input" rows={5} value={task} onChange={(e) => setTask(e.target.value)} disabled={!!running || launch.isPending} />
        </label>
        {running && (
          <div className="notice">
            {running.runner} is already running: {running.task}
          </div>
        )}
        <div className="row spread">
          <span className="muted small">The agent must already be logged in on this server. If not, the run will fail in the feed with the login message.</span>
          <button className="btn primary" disabled={!!running || launch.isPending || !task.trim()} onClick={() => launch.mutate()}>
            <Icons.play width={14} height={14} /> Launch agent
          </button>
        </div>
        {!!runs.data?.length && (
          <div className="stack" style={{ gap: 4 }}>
            <h3 style={{ margin: "4px 0" }}>Recent launches</h3>
            {runs.data.map((r) => (
              <div key={r.id} className="small row spread agent-run-row">
                <span>
                  <span className="badge">{r.runner}</span> {r.status} · {r.lines} lines · {fmtRelative(r.startedAt)}
                </span>
                <span className="muted truncate" title={r.task}>
                  {r.task}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function AssistantWidget() {
  const [modal, setModal] = useState<"context" | "connect" | null>(null);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<AgentPresence[]>("/agents"), refetchInterval: 5000 });
  const summary = useQuery({ queryKey: ["alerts", "summary"], queryFn: () => api.get<AlertSummary>("/alerts/summary"), refetchInterval: 10_000 });
  const actions = useQuery({ queryKey: ["alerts", "agent-actions"], queryFn: () => api.get<AlertEvent[]>("/alerts?sources=agent&limit=8"), refetchInterval: 5000 });

  const agent = agents.data?.[0];
  const connected = !!agent && Date.now() - Date.parse(agent.lastSeen) < ONLINE_MS;
  const s = summary.data;
  const problems = (s?.errorsLastHour ?? 0) + (s?.warnsLastHour ?? 0);

  return (
    <section className="card assistant">
      <div className="card-head">
        <h2 className="row" style={{ gap: 8 }}>
          <Icons.spark width={16} height={16} style={{ color: "var(--accent)" }} /> Assistant
        </h2>
        <StatusPill state={connected ? "ok" : agent ? "degraded" : "unavailable"} label={connected ? `Connected · ${agent.name}` : agent ? `Idle · ${agent.name}` : "No agent connected"} />
      </div>
      <div className="muted small" style={{ marginTop: -6, marginBottom: 12 }}>
        {agent ? `Last seen ${fmtRelative(agent.lastSeen)} · ${agent.actions} action${agent.actions === 1 ? "" : "s"}` : "Launch Codex or Claude Code to review alerts, repair issues, and file reports."}
      </div>

      <div className="mini-stats">
        <div>
          <div className="mini-value" style={{ color: problems ? "var(--critical)" : undefined }}>
            {s ? problems : "–"}
          </div>
          <div className="mini-label">problems, last hour</div>
        </div>
        <div>
          <div className="mini-value">{s ? s.maintenanceLastHour : "–"}</div>
          <div className="mini-label">maintenance events</div>
        </div>
        <div>
          <div className="mini-value">{agents.data ? agents.data.length : "–"}</div>
          <div className="mini-label">agents seen</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 6, marginTop: 12 }}>
        <div className="small">
          <span className="muted">Last maintenance: </span>
          {s?.lastMaintenance ? (
            <span title={s.lastMaintenance.text}>
              {s.lastMaintenance.text.length > 70 ? `${s.lastMaintenance.text.slice(0, 70)}…` : s.lastMaintenance.text} <span className="muted">· {fmtRelative(s.lastMaintenance.ts)}</span>
            </span>
          ) : (
            <span className="muted">none yet</span>
          )}
        </div>
      </div>

      <h3 style={{ margin: "14px 0 6px" }}>Agent activity</h3>
      {!actions.data?.length ? (
        <div className="muted small">Nothing yet. Once an agent is connected, every tool it uses is listed here and in the feed.</div>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          {[...actions.data].reverse().map((e) => (
            <div key={e.id} className="small row" style={{ gap: 8, flexWrap: "nowrap" }}>
              <span className="muted nowrap">{fmtRelative(e.ts)}</span>
              <span className="truncate" title={e.text}>
                {e.text}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <button className="btn" onClick={() => setModal("context")}>
          <Icons.file width={14} height={14} /> Instructions &amp; context
        </button>
        <button className="btn primary" onClick={() => setModal("connect")}>
          <Icons.plug width={14} height={14} /> Launch an agent
        </button>
      </div>

      {modal === "context" && <ContextModal onClose={() => setModal(null)} />}
      {modal === "connect" && <ConnectModal onClose={() => setModal(null)} />}
    </section>
  );
}

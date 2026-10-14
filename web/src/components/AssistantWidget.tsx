// The Assistant sidecar beside Live server alerts (issue #5): lifecycle state of the
// supervised coding agent, pending approvals, a conversation the owner can type
// into, the incident queue, and the doors to instructions/context and settings
// (incl. the original one-off "launch" form and the connect-from-terminal
// snippets). The agent itself runs on the server through services/sidecar.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { selectAlert, useSelectedAlert } from "../alertSelection";
import { fmtDateTime, fmtRelative } from "../format";
import type { AgentRun, AgentRunner, AlertSummary, ConversationTurn, Incident, SidecarPayload, SidecarPhase, SidecarSettings } from "../types";
import { ContextModal } from "./ContextModal";
import { Icons } from "./icons";
import { Modal, StatusPill, useDialog, useToast } from "./ui";

const RUNNER_LABEL: Record<AgentRunner, string> = { codex: "Codex", claude: "Claude Code" };
const PHASE: Record<SidecarPhase, { label: string; dot: string }> = {
  off: { label: "Off — manual only", dot: "" },
  idle: { label: "Watching the feed", dot: "ok" },
  queued: { label: "Incident queued", dot: "warn" },
  investigating: { label: "Working…", dot: "busy" },
  "waiting-approval": { label: "Needs your approval", dot: "warn" },
  acting: { label: "Acting…", dot: "busy" },
  reporting: { label: "Writing a report…", dot: "busy" },
  failed: { label: "Last run failed", dot: "bad" },
};
const INCIDENT_STATE: Record<Incident["status"], string> = { open: "degraded", investigating: "degraded", "waiting-approval": "degraded", resolved: "ok", dismissed: "unavailable", failed: "down" };
const isActive = (i: Incident) => i.status === "open" || i.status === "investigating" || i.status === "waiting-approval";

function SettingsModal({ payload, onClose }: { payload: SidecarPayload; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const config = useAppConfig();
  const [s, setS] = useState<SidecarSettings>(payload.settings);
  const [reveal, setReveal] = useState(false);
  const [task, setTask] = useState("Review recent Live server alerts, read the Minecraft instructions and context, investigate anything broken, make safe repairs, and submit a maintenance report.");
  const save = useMutation({
    mutationFn: (patch: Partial<SidecarSettings>) => api.put<SidecarSettings>("/sidecar/settings", patch),
    onSuccess: (next) => {
      setS(next);
      toast("Assistant settings saved");
      qc.invalidateQueries({ queryKey: ["sidecar"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const launch = useMutation({
    mutationFn: () => api.post<AgentRun>("/agents/launch", { runner: s.runner, task }),
    onSuccess: () => {
      toast("Agent launched — follow it in the panel and the feed");
      qc.invalidateQueries({ queryKey: ["sidecar"] });
      onClose();
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const key = config.data?.dashboardKey;
  const node = config.data?.mcpScript ?? "/opt/homelab-dashboard/server/dist/mcp.js";
  const mask = (k: string) => (reveal ? k : `${k.slice(0, 4)}…${k.slice(-4)}`);
  const shownKey = key ? mask(key) : "<DASHBOARD_KEY>";
  const rawKey = key ?? "<DASHBOARD_KEY>";
  const snippets = [
    { title: "Claude Code — from this device over Tailscale", cmd: `claude mcp add homelab -e HOMELAB_URL=${location.origin} -e HOMELAB_KEY=${shownKey} -- node ${node}`, raw: `claude mcp add homelab -e HOMELAB_URL=${location.origin} -e HOMELAB_KEY=${rawKey} -- node ${node}` },
    { title: "Codex CLI — from this device over Tailscale", cmd: `codex mcp add homelab --env HOMELAB_URL=${location.origin} --env HOMELAB_KEY=${shownKey} -- node ${node}`, raw: `codex mcp add homelab --env HOMELAB_URL=${location.origin} --env HOMELAB_KEY=${rawKey} -- node ${node}` },
  ];
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Could not copy", "error"));
  const field = (k: keyof SidecarSettings, label: string, hint: string, input: ReactNode) => (
    <label className="field" key={k}>
      {label}
      {input}
      <span className="muted small">{hint}</span>
    </label>
  );

  return (
    <Modal title="Assistant settings & connections" onClose={onClose} wide>
      <div className="stack">
        <div className="notice">
          The assistant is <strong>{RUNNER_LABEL[s.runner]}</strong> running on the server as a signed-in terminal agent — your existing subscription, no API keys. It must be installed and logged in for the user the dashboard runs as.
          {payload.state.runnerNote && <span className="muted"> {payload.state.runnerNote}</span>}
        </div>
        <div className="form-grid">
          {field(
            "runner",
            "Agent",
            "Which CLI the sidecar launches.",
            <select className="input" value={s.runner} onChange={(e) => setS({ ...s, runner: e.target.value as AgentRunner })}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>,
          )}
          {field("cooldownMinutes", "Cooldown (minutes)", "The same incident will not re-trigger within this window.", <input className="input" type="number" min={1} max={1440} value={s.cooldownMinutes} onChange={(e) => setS({ ...s, cooldownMinutes: Number(e.target.value) || 30 })} />)}
          {field("quietSeconds", "Quiet period (seconds)", "Wait for the burst of alerts to settle before launching.", <input className="input" type="number" min={0} max={600} value={s.quietSeconds} onChange={(e) => setS({ ...s, quietSeconds: Number(e.target.value) })} />)}
          {field("maxRunMinutes", "Max run (minutes)", "A single investigation is stopped after this long.", <input className="input" type="number" min={1} max={180} value={s.maxRunMinutes} onChange={(e) => setS({ ...s, maxRunMinutes: Number(e.target.value) || 20 })} />)}
        </div>
        <label className="check">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Assistant on (off = nothing is launched automatically; chat still works as a one-off run)
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoTrigger} onChange={(e) => setS({ ...s, autoTrigger: e.target.checked })} /> Investigate new incidents automatically (errors, failed jobs/scripts, repeated warnings)
        </label>
        <label className="check">
          <input type="checkbox" checked={s.requireApproval} onChange={(e) => setS({ ...s, requireApproval: e.target.checked })} /> Ask me before restart / stop / destructive console commands
        </label>
        <div className="row small muted">
          Workspace (sandbox root): <span className="mono">{s.workspace}</span>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ enabled: s.enabled, runner: s.runner, autoTrigger: s.autoTrigger, requireApproval: s.requireApproval, cooldownMinutes: s.cooldownMinutes, quietSeconds: s.quietSeconds, maxRunMinutes: s.maxRunMinutes })}>
            Save settings
          </button>
        </div>

        <h3 style={{ margin: "6px 0 0" }}>Run a one-off task now</h3>
        <label className="field">
          Task
          <textarea className="input" rows={3} value={task} onChange={(e) => setTask(e.target.value)} />
        </label>
        <div className="row spread">
          <span className="muted small">Starts {RUNNER_LABEL[s.runner]} in the workspace with this task; output lands in the feed and the panel.</span>
          <button className="btn" disabled={launch.isPending || !task.trim() || !!payload.state.currentRunId} onClick={() => launch.mutate()}>
            <Icons.play width={14} height={14} /> Launch
          </button>
        </div>

        <h3 style={{ margin: "6px 0 0" }}>Or connect your own terminal session</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Paste one line once into Claude Code or Codex on your Mac; the agent gets the same tools (alerts, logs, RCON, scripts, jobs, backups, reports, approvals) and everything it does shows up in the feed.
        </p>
        {!key && <div className="notice">DASHBOARD_KEY is not set on the server, so the connector can't authenticate yet. Add it to the dashboard's env file (SERVER_SETUP.md).</div>}
        <div className="row">
          <span className="small dim">Dashboard key:</span>
          <code className="mono small">{key ? mask(key) : "—"}</code>
          {key && (
            <>
              <button className="btn sm ghost" onClick={() => setReveal((r) => !r)}>
                {reveal ? "Hide" : "Reveal"}
              </button>
              <button className="btn sm ghost" onClick={() => copy(key)}>
                Copy key
              </button>
            </>
          )}
        </div>
        {snippets.map((sn) => (
          <div key={sn.title} className="stack" style={{ gap: 4 }}>
            <div className="small" style={{ fontWeight: 500 }}>
              {sn.title}
            </div>
            <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
              <code className="mono small code-inline" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", flex: 1 }}>
                {sn.cmd}
              </code>
              <button className="btn sm ghost" onClick={() => copy(sn.raw)}>
                copy
              </button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function AssistantWidget() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const config = useAppConfig();
  const [modal, setModal] = useState<"context" | "settings" | null>(null);
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
  const convoRef = useRef<HTMLDivElement>(null);
  const selected = useSelectedAlert();

  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: () => api.get<SidecarPayload>("/sidecar"), refetchInterval: 3000 });
  const convo = useQuery({ queryKey: ["sidecar", "conversation"], queryFn: () => api.get<ConversationTurn[]>("/sidecar/conversation?limit=80"), refetchInterval: 3000 });
  const summary = useQuery({ queryKey: ["alerts", "summary"], queryFn: () => api.get<AlertSummary>("/alerts/summary"), refetchInterval: 10_000 });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sidecar"] });
    qc.invalidateQueries({ queryKey: ["alerts"] });
  };
  const onError = (e: Error) => toast(e.message, "error");
  const chat = useMutation({
    mutationFn: (v: { text: string; alertId?: string }) => api.post("/sidecar/chat", v),
    onSuccess: () => {
      setDraft("");
      selectAlert(null);
      invalidate();
    },
    onError,
  });
  const decide = useMutation({ mutationFn: (v: { id: string; decision: "approve" | "deny" }) => api.post(`/sidecar/approvals/${v.id}`, { decision: v.decision }), onSuccess: invalidate, onError });
  const incidentAction = useMutation({ mutationFn: (v: { id: string; action: "investigate" | "dismiss" | "resolve" }) => api.post(`/sidecar/incidents/${v.id}/${v.action}`), onSuccess: invalidate, onError });
  const simulate = useMutation({ mutationFn: (kind: "exception" | "warn" | "job") => api.post("/sidecar/simulate", { kind }), onSuccess: () => toast("Fake error published — watch the feed and the panel"), onError });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.put("/sidecar/settings", { enabled }), onSuccess: invalidate, onError });

  const turns = convo.data ?? [];
  const d = sidecar.data;
  useEffect(() => {
    const el = convoRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [turns.length, d?.state.phase]);

  const phase = d?.state.phase ?? "off";
  const p = PHASE[phase];
  const pending = (d?.approvals ?? []).filter((a) => a.status === "pending");
  const incidents = d?.incidents ?? [];
  const active = incidents.filter(isActive);
  const shownIncidents = showAll ? incidents : active.length ? active : incidents.slice(0, 3);
  const s = summary.data;
  const busy = !!d?.state.currentRunId;
  const runnerName = d ? RUNNER_LABEL[d.settings.runner] : "assistant";

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    chat.mutate({ text, alertId: selected?.id });
  };

  return (
    <section className="card assistant sidecar">
      <div className="sidecar-head">
        <h2 className="row" style={{ gap: 8, margin: 0 }}>
          <Icons.spark width={16} height={16} style={{ color: "var(--accent)" }} /> Assistant
          {d && <span className="badge">{runnerName}</span>}
        </h2>
        <div className="row" style={{ gap: 8 }}>
          <span className="small nowrap" title={d?.state.detail ?? ""}>
            <span className={`phase-dot ${p.dot}`} />
            {p.label}
          </span>
          {d && (
            <button className={`btn sm ${d.settings.enabled ? "" : "ghost"}`} disabled={toggle.isPending} onClick={() => toggle.mutate(!d.settings.enabled)} title={d.settings.enabled ? "Turn the sidecar off (stops automatic investigations)" : "Turn the sidecar on"}>
              {d.settings.enabled ? "On" : "Off"}
            </button>
          )}
        </div>
      </div>
      {d?.state.detail && (
        <div className="muted small" style={{ marginTop: -6 }}>
          {d.state.detail} · {fmtRelative(d.state.since)}
          {d.state.queue.length > 0 && ` · ${d.state.queue.length} queued`}
        </div>
      )}
      {d?.state.runnerAvailable === false && <div className="notice error small">{d.state.runnerNote}</div>}

      {pending.map((a) => (
        <div key={a.id} className="approval">
          <div className="small">
            <strong>{a.requestedBy}</strong> asks to <strong className="mono">{a.action}</strong>
            {a.incidentId && <span className="muted"> · incident #{a.incidentId}</span>}
            <span className="muted"> · {fmtRelative(a.ts)}</span>
          </div>
          <div className="small" style={{ margin: "4px 0 8px" }}>
            {a.reason}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "approve" })}>
              Approve
            </button>
            <button className="btn sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "deny" })}>
              Deny
            </button>
          </div>
        </div>
      ))}

      <div className="convo" ref={convoRef}>
        {turns.length === 0 && (
          <div className="muted small" style={{ textAlign: "center", padding: 12 }}>
            {d?.settings.enabled ? "Watching the feed. New errors, failed jobs and repeated warnings become incidents here; ask anything below." : "The assistant is off. Turn it on to investigate incidents automatically, or ask something below for a one-off run."}
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`turn ${t.role}`} title={fmtDateTime(t.ts)}>
            {t.text}
            {t.role !== "system" && (
              <span className="turn-meta">
                {t.role === "user" ? "you" : runnerName} · {fmtRelative(t.ts)}
                {t.incidentId && ` · #${t.incidentId}`}
              </span>
            )}
          </div>
        ))}
        {busy && (
          <div className="turn system">
            <span className="phase-dot busy" />
            {runnerName} is working — lines stream into the feed
          </div>
        )}
      </div>

      {selected && (
        <div className="row small" style={{ gap: 6, flexWrap: "nowrap" }}>
          <span className="muted nowrap">Selected alert:</span>
          <span className="mono truncate" title={selected.text}>
            {selected.text}
          </span>
          <button className="btn sm" onClick={() => chat.mutate({ text: "What is this about and should I worry?", alertId: selected.id })} disabled={chat.isPending || busy}>
            Ask about this
          </button>
          <button className="btn sm ghost" onClick={() => selectAlert(null)} title="Clear selection">
            ×
          </button>
        </div>
      )}

      <div className="chatbox">
        <textarea
          className="input"
          placeholder={selected ? "Ask about the selected alert… (Enter to send)" : "Ask the assistant… (Enter to send, Shift+Enter for a new line)"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={chat.isPending}
        />
        <button className="btn primary" disabled={chat.isPending || !draft.trim() || busy} onClick={send} title={busy ? "Wait for the current run to finish" : "Send"}>
          Send
        </button>
      </div>

      <details open={active.length > 0}>
        <summary className="small" style={{ cursor: "pointer" }}>
          Incidents <span className="muted">· {active.length} active · {incidents.length} recent</span>
        </summary>
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          {shownIncidents.length === 0 && <div className="muted small">No incidents. Errors, failed jobs/scripts and repeated warnings in the feed will appear here.</div>}
          {shownIncidents.map((i) => (
            <div key={i.id} className={`incident ${isActive(i) ? "active" : ""}`}>
              <div className="truncate">
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <StatusPill state={INCIDENT_STATE[i.status]} label={i.status} />
                  <span className="mono muted small">#{i.id}</span>
                  <span className="truncate small" title={i.samples[i.samples.length - 1]}>
                    {i.title}
                  </span>
                </div>
                <div className="muted small">
                  {i.count}× · first {fmtRelative(i.firstSeen)} · last {fmtRelative(i.lastSeen)}
                  {i.reportIds.length > 0 && ` · ${i.reportIds.length} report${i.reportIds.length === 1 ? "" : "s"}`}
                  {i.note && ` · ${i.note}`}
                </div>
              </div>
              <div className="actions">
                {i.status !== "investigating" && (
                  <button className="btn sm" disabled={incidentAction.isPending || busy} onClick={() => incidentAction.mutate({ id: i.id, action: "investigate" })} title="Launch the agent on this incident now">
                    Investigate
                  </button>
                )}
                {(i.status === "open" || i.status === "failed" || i.status === "waiting-approval") && (
                  <button
                    className="btn sm ghost"
                    disabled={incidentAction.isPending}
                    onClick={async () => {
                      if (await confirm({ title: `Dismiss incident #${i.id}?`, body: "It stays listed as dismissed; the same error within the cooldown is attached silently.", confirmLabel: "Dismiss" })) incidentAction.mutate({ id: i.id, action: "dismiss" });
                    }}
                  >
                    Dismiss
                  </button>
                )}
                {(i.status === "open" || i.status === "failed") && (
                  <button className="btn sm ghost" disabled={incidentAction.isPending} onClick={() => incidentAction.mutate({ id: i.id, action: "resolve" })}>
                    Resolved
                  </button>
                )}
              </div>
            </div>
          ))}
          {incidents.length > shownIncidents.length && (
            <button className="btn sm ghost" onClick={() => setShowAll(true)}>
              Show all {incidents.length}
            </button>
          )}
        </div>
      </details>

      <div className="mini-stats">
        <div>
          <div className="mini-value" style={{ color: s && s.errorsLastHour + s.warnsLastHour ? "var(--critical)" : undefined }}>
            {s ? s.errorsLastHour + s.warnsLastHour : "–"}
          </div>
          <div className="mini-label">problems, last hour</div>
        </div>
        <div>
          <div className="mini-value">{s ? s.maintenanceLastHour : "–"}</div>
          <div className="mini-label">maintenance events</div>
        </div>
        <div>
          <div className="mini-value">{d ? active.length : "–"}</div>
          <div className="mini-label">incidents open</div>
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => setModal("context")}>
          <Icons.file width={14} height={14} /> Instructions &amp; context
        </button>
        <button className="btn" onClick={() => setModal("settings")}>
          <Icons.plug width={14} height={14} /> Settings &amp; connect
        </button>
        {config.data?.demo && (
          <button className="btn ghost" disabled={simulate.isPending} onClick={() => simulate.mutate("exception")} title="Demo: publish a fake server exception to watch the sidecar react">
            Simulate incident
          </button>
        )}
      </div>

      {modal === "context" && <ContextModal onClose={() => setModal(null)} />}
      {modal === "settings" && d && <SettingsModal payload={d} onClose={() => setModal(null)} />}
    </section>
  );
}

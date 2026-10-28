// Conversation and approvals stay here; incident histories live in their own menu.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { selectAlert, useSelectedAlert } from "../alertSelection";
import { fmtDateTime, fmtRelative } from "../format";
import type { AgentRunner, ConversationTurn, SidecarPayload, SidecarPhase, SidecarSettings } from "../types";
import { ContextModal } from "./ContextModal";
import { IncidentsMenu } from "./IncidentsMenu";
import { Icons } from "./icons";
import { Modal, useToast } from "./ui";

const RUNNER_LABEL: Record<AgentRunner, string> = { codex: "Codex", claude: "Claude Code" };
const PHASE: Record<SidecarPhase, { label: string; dot: string }> = {
  off: { label: "Ready for your message", dot: "" },
  idle: { label: "Watching the feed", dot: "ok" },
  queued: { label: "Incident queued", dot: "warn" },
  investigating: { label: "Working…", dot: "busy" },
  "waiting-approval": { label: "Needs your approval", dot: "warn" },
  acting: { label: "Acting…", dot: "busy" },
  reporting: { label: "Writing a report…", dot: "busy" },
  failed: { label: "Last run failed", dot: "bad" },
};
function readableMessage(text: string): string {
  if (/spawn (?:codex|claude) ENOENT|not on the dashboard's PATH|could not be found for the dashboard/i.test(text)) return "The assistant couldn't start, so this request wasn't reviewed.";
  return text;
}

function SettingsModal({ payload, onClose }: { payload: SidecarPayload; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const config = useAppConfig();
  const [s, setS] = useState<SidecarSettings>(payload.settings);
  const [reveal, setReveal] = useState(false);
  const save = useMutation({
    mutationFn: (patch: Partial<SidecarSettings>) => api.put<SidecarSettings>("/sidecar/settings", patch),
    onSuccess: (next) => {
      setS(next);
      toast("Assistant settings saved");
      qc.invalidateQueries({ queryKey: ["sidecar"] });
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
    <Modal title="Assistant settings" onClose={onClose} wide>
      <div className="stack">
        <div className="notice">
          The dashboard runs one <strong>{RUNNER_LABEL[s.runner]}</strong> job at a time and keeps its own conversation between jobs, using your existing subscription. It is separate from your editor or ChatGPT conversation. Use the chat panel for tasks and follow-up questions.
          {payload.state.runnerNote && <span className="muted"> {payload.state.runnerNote}</span>}
        </div>
        <div className="form-grid">
          {field(
            "runner",
            "Agent",
            "Which CLI the sidecar launches.",
            <select className="input" value={s.runner} disabled={!!payload.state.currentRunId} onChange={(e) => setS({ ...s, runner: e.target.value as AgentRunner })}>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>,
          )}
          {field("cooldownMinutes", "Cooldown (minutes)", "The same incident will not re-trigger within this window.", <input className="input" type="number" min={1} max={1440} value={s.cooldownMinutes} onChange={(e) => setS({ ...s, cooldownMinutes: Number(e.target.value) || 30 })} />)}
          {field("quietSeconds", "Quiet period (seconds)", "Wait for the burst of alerts to settle before launching.", <input className="input" type="number" min={0} max={600} value={s.quietSeconds} onChange={(e) => setS({ ...s, quietSeconds: Number(e.target.value) })} />)}
          {field("maxRunMinutes", "Max run (minutes)", "A single investigation is stopped after this long.", <input className="input" type="number" min={1} max={180} value={s.maxRunMinutes} onChange={(e) => setS({ ...s, maxRunMinutes: Number(e.target.value) || 20 })} />)}
        </div>
        <label className="check">
          <input type="checkbox" checked={s.enabled && s.autoTrigger} onChange={(e) => setS({ ...s, enabled: e.target.checked, autoTrigger: e.target.checked })} /> Investigate new incidents automatically (errors, failed jobs/scripts, repeated warnings). Chat is always available.
        </label>
        <label className="check">
          <input type="checkbox" checked={s.requireApproval} onChange={(e) => setS({ ...s, requireApproval: e.target.checked })} /> Ask me before restart / stop / destructive console commands
        </label>
        <div className="row small muted">
          Workspace (sandbox root): <span className="mono">{s.workspace}</span>
        </div>
        <details className="small muted">
          <summary>Troubleshooting details</summary>
          <p>{payload.state.runnerNote}</p>
          <p>Model: {payload.state.model ?? "Default"}</p>
          <p>Conversation: {payload.state.sessionId ?? "Not started"}</p>
          <p>Last error: {payload.state.lastRun?.error ?? "None"}</p>
        </details>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ enabled: s.enabled, runner: s.runner, autoTrigger: s.autoTrigger, requireApproval: s.requireApproval, cooldownMinutes: s.cooldownMinutes, quietSeconds: s.quietSeconds, maxRunMinutes: s.maxRunMinutes })}>
            Save settings
          </button>
        </div>

        <details>
        <summary className="small" style={{ cursor: "pointer" }}>Advanced: connect a separate terminal agent</summary>
        <div className="stack" style={{ marginTop: 10 }}>
        <p className="muted small" style={{ margin: 0 }}>
          Optional: give an existing terminal agent access to dashboard tools. This does not attach it to the dashboard conversation or put it under the dashboard's Stop control.
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
        </details>
      </div>
    </Modal>
  );
}


export function AssistantWidget() {
  const qc = useQueryClient();
  const toast = useToast();
  const config = useAppConfig();
  const [modal, setModal] = useState<"context" | "settings" | "incidents" | "simulate" | null>(null);
  const [draft, setDraft] = useState("");
  const convoRef = useRef<HTMLDivElement>(null);
  const selected = useSelectedAlert();

  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: () => api.get<SidecarPayload>("/sidecar"), refetchInterval: 3000 });
  const convo = useQuery({ queryKey: ["sidecar", "conversation"], queryFn: () => api.get<ConversationTurn[]>("/sidecar/conversation?limit=80"), refetchInterval: 3000 });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sidecar"] });
    qc.invalidateQueries({ queryKey: ["alerts"] });
  };
  const onError = (e: Error) => toast(readableMessage(e.message), "error");
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
  const simulate = useMutation({
    mutationFn: (v: { kind: "exception" | "warn" | "job" | "custom"; text?: string }) => api.post("/sidecar/simulate", v),
    onSuccess: () => {
      toast("Published to the feed — watch the panel react");
      setModal(null);
      invalidate();
    },
    onError,
  });
  const [pasted, setPasted] = useState("");
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.put("/sidecar/settings", { enabled, autoTrigger: enabled }), onSuccess: invalidate, onError });
  const stop = useMutation({ mutationFn: () => api.post("/sidecar/stop"), onSuccess: () => { toast("Stopping the job; automatic investigations are paused"); invalidate(); }, onError });

  const turns = (convo.data ?? []).filter((turn) => !turn.incidentId && turn.role !== "system");
  const d = sidecar.data;
  useEffect(() => {
    const el = convoRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [turns.length, d?.state.phase]);

  const phase = d?.state.phase ?? "off";
  const p = PHASE[phase];
  const pending = (d?.approvals ?? []).filter((a) => a.status === "pending");
  const busy = !!d?.state.currentRunId;
  const runnerName = d ? RUNNER_LABEL[d.settings.runner] : "assistant";

  const send = () => {
    const text = draft.trim();
    if (!text || busy || chat.isPending) return;
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
          <span className="small nowrap">
            <span className={`phase-dot ${d?.state.runnerAvailable === false ? "bad" : p.dot}`} />
            {d?.state.runnerAvailable === false ? "Unavailable" : p.label}
          </span>
          {d && (
            <button className={`btn sm ${d.settings.enabled && d.settings.autoTrigger ? "" : "ghost"}`} disabled={toggle.isPending} onClick={() => toggle.mutate(!(d.settings.enabled && d.settings.autoTrigger))} title="Controls automatic investigations. Pausing does not interrupt the current job; use Stop job to cancel it.">
              {d.settings.enabled && d.settings.autoTrigger ? "Auto: on" : "Auto: paused"}
            </button>
          )}
        </div>
      </div>
      {d?.state.model && <div className="muted small">{d.state.model}</div>}
      {sidecar.error && <div className="notice error small">Couldn't connect to the assistant. Please try again.</div>}
      {d?.state.runnerAvailable === false && <div className="notice error small">The assistant couldn't start. Problems are still recorded, but aren't being investigated.</div>}
      {d?.state.runnerAvailable !== false && phase === "failed" && <div className="notice error small">The assistant couldn't finish its last task. You can review the issue or ask it to try again.</div>}

      {pending.map((a) => (
        <div key={a.id} className="approval">
          <div className="small">
            <strong>The assistant needs your approval</strong>
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
            {d?.settings.enabled && d.settings.autoTrigger ? "Watching for new problems. Ask a question or give the assistant a task below; follow-ups stay in the same conversation." : "Chat is ready. Automatic investigations are paused; you can still ask questions or give the assistant a task."}
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`turn ${t.role}`} title={fmtDateTime(t.ts)}>
            {readableMessage(t.text)}
            {t.role !== "system" && (
              <span className="turn-meta">
                {t.role === "user" ? "you" : runnerName} · {fmtRelative(t.ts)}
              </span>
            )}
          </div>
        ))}
        {busy && (
          <div className="turn system">
            <span className="phase-dot busy" />
            {d?.state.currentIncidentId ? "The assistant is reviewing an incident. Open Incidents to follow its work." : "The assistant is working on your message."}
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
      {busy && (
        <div className="row spread">
          <span className="muted small">You can draft your next message while this job finishes.</span>
          <button className="btn" disabled={stop.isPending} onClick={() => stop.mutate()}>
            {stop.isPending ? "Stopping..." : "Stop job and pause auto"}
          </button>
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => setModal("incidents")}>Incidents</button>
        <button className="btn" onClick={() => setModal("context")}>
          <Icons.file width={14} height={14} /> Instructions &amp; context
        </button>
        <button className="btn" onClick={() => setModal("settings")}>
          <Icons.plug width={14} height={14} /> Settings
        </button>
        {/* [DEMO] demo-only button: fakes a server error so the sidecar loop can be watched (see DEMO_INDEX.md) */}
        {config.data?.demo && (
          <button className="btn ghost" disabled={simulate.isPending} onClick={() => setModal("simulate")} title="Demo: publish a fake error, or paste real console output, to watch the sidecar react">
            Simulate incident
          </button>
        )}
      </div>

      {modal === "context" && <ContextModal onClose={() => setModal(null)} />}
      {modal === "settings" && d && <SettingsModal payload={d} onClose={() => setModal(null)} />}
      {modal === "incidents" && <IncidentsMenu onClose={() => setModal(null)} />}
      {modal === "simulate" && (
        <Modal title="Simulate an incident (demo)" onClose={() => setModal(null)} wide>
          <div className="stack">
            <p className="muted small" style={{ margin: 0 }}>
              Demo only. Pick a canned error, or paste real console output — every line is published to the Minecraft feed and classified exactly like live log lines, so you can see how the detector groups it and what the assistant does.
            </p>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <button className="btn sm" disabled={simulate.isPending} onClick={() => simulate.mutate({ kind: "exception" })}>
                Server exception
              </button>
              <button className="btn sm" disabled={simulate.isPending} onClick={() => simulate.mutate({ kind: "warn" })}>
                “Can't keep up” warning
              </button>
              <button className="btn sm" disabled={simulate.isPending} onClick={() => simulate.mutate({ kind: "job" })}>
                Failed backup job
              </button>
            </div>
            <label className="field">
              Paste console output
              <textarea className="input mono" rows={10} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={"[Fri 04:44:35 WARN  Geyser-Spigot] [mcxboxbroadcast] [Auth] Failed to refresh tokens\ncom.example.SomeException: status: 400 Bad Request …\n    at com.example.Foo.bar(Foo.java:32)"} spellCheck={false} />
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn primary" disabled={simulate.isPending || !pasted.trim()} onClick={() => simulate.mutate({ kind: "custom", text: pasted })}>
                Publish to the feed
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

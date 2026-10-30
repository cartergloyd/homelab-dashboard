// Conversation and approvals stay here; incident histories live in their own menu.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import { selectAlert, useSelectedAlert } from "../alertSelection";
import { fmtDateTime, fmtRelative } from "../format";
import type { AgentRunner, ConversationTurn, SidecarPayload, SidecarPhase, SidecarSettings } from "../types";
import { Icons } from "./icons";
import { Modal, useToast } from "./ui";

const RUNNER_LABEL: Record<AgentRunner, string> = { codex: "Codex", claude: "Claude Code" };
const PHASE: Record<SidecarPhase, { label: string; dot: string }> = {
  off: { label: "Monitoring paused", dot: "" },
  idle: { label: "Watching Minecraft", dot: "ok" },
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
          The dashboard runs <strong>{RUNNER_LABEL[s.runner]}</strong> in two lanes, one job at a time each, using your existing subscription: this Minecraft responder, which keeps its own conversation between jobs, and the ops agent for the rest of the server. Both are separate from your editor or ChatGPT conversation. These settings and the automatic-response switch apply to both lanes.
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
          <input type="checkbox" checked={s.enabled && s.autoTrigger} onChange={(e) => setS({ ...s, enabled: e.target.checked, autoTrigger: e.target.checked })} /> Respond automatically to Minecraft errors, repeated warnings, and detected outages.
        </label>
        <label className="check">
          <input type="checkbox" checked={s.requireApproval} onChange={(e) => setS({ ...s, requireApproval: e.target.checked })} /> Ask before destructive changes and maintenance scripts. Minecraft start/restart recovery is preauthorized.
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


export function AssistantWidget({ title = "Minecraft responder" }: { title?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<"outage" | "console" | "followup">("outage");
  const [older, setOlder] = useState<ConversationTurn[]>([]);
  const [historyEnd, setHistoryEnd] = useState(false);
  const convoRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const selected = useSelectedAlert();
  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: () => api.get<SidecarPayload>("/sidecar"), refetchInterval: 3000 });
  const convo = useQuery({ queryKey: ["sidecar", "conversation"], queryFn: () => api.get<ConversationTurn[]>("/sidecar/conversation?limit=80"), refetchInterval: 2000 });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["sidecar"] }); qc.invalidateQueries({ queryKey: ["alerts"] }); };
  const onError = (e: Error) => toast(readableMessage(e.message), "error");
  const submit = useMutation({
    mutationFn: (v: { text: string; kind: typeof kind }) => v.kind === "followup"
      ? api.post("/sidecar/chat", { text: v.text, alertId: selected?.id })
      : api.post("/sidecar/problems", { kind: v.kind, text: v.text }),
    onSuccess: () => { setDraft(""); selectAlert(null); followBottom.current = true; invalidate(); }, onError,
  });
  const decide = useMutation({ mutationFn: (v: { id: string; decision: "approve" | "deny" }) => api.post(`/sidecar/approvals/${v.id}`, { decision: v.decision }), onSuccess: invalidate, onError });
  const stop = useMutation({ mutationFn: () => api.post("/sidecar/stop"), onSuccess: invalidate, onError });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.put("/sidecar/settings", { enabled, autoTrigger: enabled }), onSuccess: invalidate, onError });
  // Keep every visited page of history while polling the most recent messages.
  useEffect(() => { if (convo.data) setOlder((previous) => [...new Map([...previous, ...convo.data!].map(t => [t.id, t])).values()]); }, [convo.data]);
  const turns = [...new Map([...older, ...(convo.data ?? [])].map(t => [t.id, t])).values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const history = useMutation({
    mutationFn: () => api.get<ConversationTurn[]>(`/sidecar/conversation?limit=80&before=${encodeURIComponent(turns[0]?.id ?? "")}`),
    onSuccess: (page) => { followBottom.current = false; setOlder(previous => [...new Map([...page, ...previous].map(t => [t.id, t])).values()]); setHistoryEnd(page.length < 80); }, onError,
  });
  const d = sidecar.data;
  const phase = d?.state.phase ?? "off";
  const busy = !!d?.state.currentRunId;
  const monitoring = !!d?.settings.enabled && !!d?.settings.autoTrigger;
  useEffect(() => { if (followBottom.current && convoRef.current) convoRef.current.scrollTop = convoRef.current.scrollHeight; }, [turns.length, phase]);
  const send = () => {
    const text = draft.trim();
    if (text && !submit.isPending && !(kind === "followup" && busy)) submit.mutate({ text, kind });
  };
  return (
    <section className="card assistant sidecar minecraft-responder">
      <div className="sidecar-head">
        <h2 className="row" style={{ gap: 8, margin: 0 }}><Icons.spark width={16} height={16} /> {title}</h2>
        <span className="small"><span className={`phase-dot ${PHASE[phase].dot}`} />{PHASE[phase].label}</span>
      </div>
      <div className="responder-inputs">
        <span className="small muted">Inputs</span>
        <span className="badge">Minecraft console errors</span><span className="badge">Outage reports</span>
        <span className="small muted">{monitoring ? "Automatic response on" : "Automatic response paused"}</span>
      </div>
      {sidecar.error && <div className="notice error small">Couldn't connect to the responder.</div>}
      {d?.state.runnerAvailable === false && <div className="notice error small">The agent couldn't start. Inputs are recorded, but aren't being investigated.</div>}
      {phase === "failed" && <div className="notice error small">The last investigation failed. Review the conversation and report the issue again to retry.</div>}
      <div className="convo" ref={convoRef} role="log" aria-label="Minecraft incident conversation" aria-live="polite" onScroll={() => { const el = convoRef.current; if (el) followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {!historyEnd && turns.length >= 80 && <button className="btn sm ghost" disabled={history.isPending} onClick={() => history.mutate()}>Load earlier messages</button>}
        {turns.length === 0 && <div className="turn system">Minecraft errors and outage reports appear here, followed by the agent's investigation, recovery actions, and replies.</div>}
        {turns.map(t => <div key={t.id} className={`turn ${t.role}`} title={fmtDateTime(t.ts)}>
          {readableMessage(t.text)}
          <span className="turn-meta">{t.role === "assistant" ? "Minecraft responder" : t.role === "system" ? "Status" : t.incidentId ? "Incident input" : "You"} · {fmtRelative(t.ts)}</span>
        </div>)}
        {busy && <div className="turn system"><span className="phase-dot busy" /> Investigating Minecraft…</div>}
        {(d?.approvals ?? []).filter(a => a.status === "pending").map(a => <div className="approval" key={a.id}>
          <div className="small"><strong>Decision needed</strong> · {a.reason}</div>
          <div className="row"><button className="btn sm primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "approve" })}>Approve</button><button className="btn sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "deny" })}>Deny</button></div>
        </div>)}
      </div>
      <div className="responder-composer">
        <label className="small" htmlFor="minecraft-input-kind">Send to the Minecraft responder</label>
        <select id="minecraft-input-kind" className="input" value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
          <option value="outage">Report an outage</option><option value="console">Paste a console error</option><option value="followup">Follow up on an incident</option>
        </select>
        {selected?.source === "minecraft" && <div className="row small"><span className="truncate">Selected console line: {selected.text}</span><button className="btn sm ghost" onClick={() => { setKind("console"); setDraft(selected.text); selectAlert(null); }}>Use this error</button></div>}
        <div className="chatbox"><textarea className="input" aria-label="Minecraft incident message" placeholder={kind === "outage" ? "What is down? Describe what players are seeing…" : kind === "console" ? "Paste the Minecraft console error…" : "Ask about the incident or add context…"} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={submit.isPending} />
          <button className="btn primary" disabled={!draft.trim() || submit.isPending || (kind === "followup" && busy)} onClick={send}>{kind === "followup" ? "Send" : "Report"}</button>
        </div>
        {busy && <span className="small muted">New errors and outage reports are accepted while the agent works. Follow-up questions can be sent when it finishes.</span>}
        {!monitoring && <span className="small muted">Reports are recorded while monitoring is paused. Resume monitoring to investigate them.</span>}
      </div>
      <details className="responder-controls"><summary className="small muted">Responder controls</summary><div className="row">
        <button className="btn sm" disabled={toggle.isPending} onClick={() => toggle.mutate(!monitoring)}>{monitoring ? "Pause monitoring" : "Resume monitoring"}</button>
        {busy && <button className="btn sm" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop and pause</button>}
        <button className="btn sm ghost" onClick={() => setSettingsOpen(true)}>Settings</button>
      </div></details>
      {settingsOpen && d && <SettingsModal payload={d} onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}

// The ops agent's lane, shown next to the Minecraft responder in the Assistant panel: what it is
// doing, the whole-server incidents it tracks, and each incident's reports with the rollback id of
// any run that changed files. The lane has no conversation of its own; the Auto switch it shares
// with the Minecraft responder lives in that panel's controls.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDateTime, fmtRelative } from "../format";
import type { AgentReport, AgentRun, AgentRunner, OpsIncidentStatus, OpsIncidentView, OpsPayload, OpsPhase, OpsReportLink, OpsRunChange, ReportOutcome } from "../types";
import { Icons } from "./icons";
import { Modal, useDialog, useToast } from "./ui";

const RUNNER_LABEL: Record<AgentRunner, string> = { codex: "Codex", claude: "Claude Code" };
const PHASE: Record<OpsPhase, { label: string; dot: string }> = {
  off: { label: "Automatic runs paused", dot: "" },
  idle: { label: "Watching the server", dot: "ok" },
  queued: { label: "Incident queued", dot: "warn" },
  investigating: { label: "Working…", dot: "busy" },
};
// the badge text always says the status; the tone only repeats it
const STATUS: Record<OpsIncidentStatus, { label: string; tone: string; order: number }> = {
  "needs-human": { label: "Needs you", tone: "bad", order: 0 },
  investigating: { label: "Investigating", tone: "accent", order: 1 },
  open: { label: "Open", tone: "warn", order: 2 },
  resolved: { label: "Resolved", tone: "ok", order: 3 },
};
const OUTCOME: Record<ReportOutcome, string> = { fixed: "Fixed", "no-action": "Checked", "needs-human": "Needs you" };
const RUN_STATUS: Record<AgentRun["status"], string> = { running: "running", exited: "finished", failed: "failed", cancelled: "stopped" };
// the note a report leaves ("needs-human by Codex") only repeats the report listed below it
const REPORT_NOTE = /^(fixed|no-action|needs-human|reported) by /;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One run's report and/or file changes, with the rollback id and an undo button. */
function RunModal({ incident, report, change, onClose }: { incident: OpsIncidentView; report: OpsReportLink | null; change: OpsRunChange | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const full = useQuery({ queryKey: ["reports", report?.id], queryFn: () => api.get<AgentReport>(`/reports/${report!.id}`), enabled: !!report });
  const onError = (e: Error) => toast(e.message, "error");
  const review = useMutation({
    mutationFn: (reviewed: boolean) => api.post(`/reports/${report!.id}/review`, { reviewed }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["reports"] }); qc.invalidateQueries({ queryKey: ["ops"] }); },
    onError,
  });
  const rollback = useMutation({
    mutationFn: (runId: string) => api.post<{ files: string[] }>(`/sidecar/runs/${encodeURIComponent(runId)}/rollback`),
    onSuccess: (r) => { toast(r.files.length ? `Rolled back ${plural(r.files.length, "file")}` : "Nothing left to undo"); qc.invalidateQueries({ queryKey: ["ops"] }); },
    onError,
  });
  const runId = report?.runId ?? change?.runId ?? null;
  const files = report?.changedFiles.length ? report.changedFiles : (change?.files ?? []);
  const reviewed = full.data?.reviewed ?? report?.reviewed ?? false;
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Could not copy", "error"));
  const undo = async () => {
    if (!runId) return;
    const ok = await confirm({
      title: "Undo this run's changes?",
      body: `Puts ${plural(files.length, "file")} back to how they were before run ${runId.slice(0, 8)}. Later changes to the same files are undone too.`,
      confirmLabel: "Roll back",
      danger: true,
    });
    if (ok) rollback.mutate(runId);
  };

  return (
    <Modal title={report ? report.title : `Run ${runId?.slice(0, 8) ?? ""} changed files`} onClose={onClose} wide>
      <div className="stack ops-run">
        <div className="muted small">
          {report && <><span className="badge">{report.agent}</span> {report.outcome ? OUTCOME[report.outcome] : "Reported"} · <span title={fmtDateTime(report.ts)}>{fmtRelative(report.ts)}</span> · </>}
          ops incident #{incident.id}: {incident.title}
        </div>
        {report && <div className="report-body">{full.data?.body ?? (full.error ? "Couldn't load the report." : "Loading the report…")}</div>}
        {!report && <div className="small muted">This run filed no report.</div>}
        {runId && files.length > 0 && (
          <div className="notice stack" style={{ gap: 8 }}>
            <div className="small"><strong>The run changed {plural(files.length, "file")}</strong></div>
            <ul className="mono small ops-files">{files.map((f) => <li key={f}>{f}</li>)}</ul>
            <div className="row small">
              Rollback id <code className="mono">{runId}</code>
              <button className="btn sm ghost" onClick={() => copy(runId)}>Copy</button>
              <button className="btn sm" disabled={rollback.isPending} onClick={() => void undo()}>Roll back these changes</button>
            </div>
          </div>
        )}
        {report && runId && !files.length && <div className="small muted">The run changed no files, so there is nothing to roll back.</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {report && <button className="btn sm" disabled={review.isPending || !full.data} onClick={() => review.mutate(!reviewed)}>{reviewed ? "Unreview" : "Mark reviewed"}</button>}
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}

function IncidentRow({ inc, open }: { inc: OpsIncidentView; open: (report: OpsReportLink | null, change: OpsRunChange | null) => void }) {
  const status = STATUS[inc.status];
  const reported = new Set(inc.reports.map((r) => r.runId));
  const unreported = (inc.changes ?? []).filter((c) => !reported.has(c.runId));
  return (
    <li className="ops-incident">
      <div className="row" style={{ flexWrap: "nowrap", alignItems: "baseline" }}>
        <span className={`badge ${status.tone}`}>{status.label}</span>
        <strong className="truncate" title={inc.title}>{inc.title}</strong>
      </div>
      <div className="small muted">
        {inc.severity === "P1" && <><span className="badge">P1</span> </>}
        {inc.count}× · last seen <span title={fmtDateTime(inc.lastSeen)}>{fmtRelative(inc.lastSeen)}</span> · #{inc.id}
      </div>
      {inc.note && inc.status !== "resolved" && !REPORT_NOTE.test(inc.note) && <div className="small muted">{inc.note}</div>}
      {(inc.reports.length > 0 || unreported.length > 0) && (
        <ul className="ops-reports small">
          {inc.reports.map((r) => (
            <li key={r.id}>
              <button className="ops-link" onClick={() => open(r, null)} title="Open the report">
                {r.title}
              </button>
              <span className="muted"> · {r.outcome ? OUTCOME[r.outcome] : "Reported"} · {fmtRelative(r.ts)}{r.reviewed ? " · reviewed" : ""}</span>
              {r.runId && r.changedFiles.length > 0 && <span className="muted"> · changed {plural(r.changedFiles.length, "file")}, rollback id <code className="mono" title={r.runId}>{r.runId.slice(0, 8)}</code></span>}
            </li>
          ))}
          {unreported.map((c) => (
            <li key={c.runId}>
              <button className="ops-link" onClick={() => open(null, c)} title="See the changed files">
                Run {c.runId.slice(0, 8)} changed {plural(c.files.length, "file")}
              </button>
              <span className="muted"> · no report · rollback id <code className="mono" title={c.runId}>{c.runId.slice(0, 8)}</code></span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function OpsLane() {
  const [showResolved, setShowResolved] = useState(false);
  const [selected, setSelected] = useState<{ incidentId: string; report: OpsReportLink | null; change: OpsRunChange | null } | null>(null);
  const q = useQuery({ queryKey: ["ops"], queryFn: () => api.get<OpsPayload>("/ops"), refetchInterval: 3000 });
  const d = q.data;
  const phase = d?.phase ?? "idle";
  const incidents = [...(d?.incidents ?? [])].sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || b.lastSeen.localeCompare(a.lastSeen));
  const active = incidents.filter((i) => i.status !== "resolved");
  const resolved = incidents.filter((i) => i.status === "resolved");
  const count = (s: OpsIncidentStatus) => incidents.filter((i) => i.status === s).length;
  const working = d?.current ? incidents.find((i) => i.id === d.current!.incidentId) : null;
  const chosen = selected ? incidents.find((i) => i.id === selected.incidentId) : null;
  const last = d?.lastRun;

  return (
    <section className="card assistant sidecar ops-lane">
      <div className="sidecar-head">
        <h2 className="row" style={{ gap: 8, margin: 0 }}><Icons.pulse width={16} height={16} /> Ops agent</h2>
        <span className="small"><span className={`phase-dot ${PHASE[phase].dot}`} />{PHASE[phase].label}</span>
      </div>
      <div className="responder-inputs">
        <span className="small muted">Inputs</span>
        <span className="badge">Services &amp; timers</span><span className="badge">Containers</span><span className="badge">Scripts &amp; jobs</span><span className="badge">Memory &amp; disk</span>
      </div>
      {q.error && <div className="notice error small">Couldn't load the ops lane.</div>}
      {d && phase === "investigating" && (
        <div className="notice small ops-now">
          <div><span className="phase-dot busy" />Working on {working ? <><strong>#{working.id}</strong> {working.title}</> : "an incident"}</div>
          {d.run && <div className="muted">{RUNNER_LABEL[d.run.runner]} run <code className="mono" title={d.run.id}>{d.run.id.slice(0, 8)}</code> · started <span title={fmtDateTime(d.run.startedAt)}>{fmtRelative(d.run.startedAt)}</span> · {plural(d.run.lines, "line")} of output</div>}
        </div>
      )}
      {d && phase !== "investigating" && (
        <div className="small muted">
          {d.detail ? `${d.detail}. ` : ""}
          {last ? <>Last run {RUN_STATUS[last.status]} <span title={fmtDateTime(last.finishedAt)}>{fmtRelative(last.finishedAt)}</span>{last.error ? `: ${last.error.slice(0, 160)}` : ""}.</> : "No runs since the dashboard started."}
          {phase === "off" && " The pause switch in the Minecraft responder's controls covers this lane too; new incidents are recorded but not investigated."}
        </div>
      )}
      {d && (
        <div className="row small ops-counts" aria-label="Incident counts">
          <span><span className="badge bad">Needs you</span> {count("needs-human")}</span>
          <span><span className="badge accent">Investigating</span> {count("investigating")}</span>
          <span><span className="badge warn">Open</span> {count("open")}</span>
          <span><span className="badge ok">Resolved</span> {count("resolved")}</span>
        </div>
      )}
      <ul className="ops-incidents" aria-label="Ops incidents">
        {d && !incidents.length && <li className="muted small">No whole-server incidents. Failed services and timers, container errors, failed scripts and jobs, and memory or disk running out appear here.</li>}
        {d && incidents.length > 0 && !active.length && <li className="muted small">Nothing open.</li>}
        {active.map((inc) => <IncidentRow key={inc.id} inc={inc} open={(report, change) => setSelected({ incidentId: inc.id, report, change })} />)}
        {showResolved && resolved.map((inc) => <IncidentRow key={inc.id} inc={inc} open={(report, change) => setSelected({ incidentId: inc.id, report, change })} />)}
      </ul>
      {resolved.length > 0 && <button className="btn sm ghost" onClick={() => setShowResolved((v) => !v)}>{showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}</button>}
      {chosen && selected && <RunModal incident={chosen} report={selected.report && (chosen.reports.find((r) => r.id === selected.report!.id) ?? selected.report)} change={selected.change} onClose={() => setSelected(null)} />}
    </section>
  );
}

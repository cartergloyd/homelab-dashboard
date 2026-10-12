import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, Modal, PageHead, StatusPill, useDialog, useToast } from "../components/ui";
import { describeCron, fmtBytes, fmtDateTime, fmtRelative } from "../format";
import type { BackupFile, JobRun, JobType, JobView } from "../types";

interface JobForm {
  name: string;
  type: JobType;
  cron: string;
  enabled: boolean;
  warnMinutes: string;
  onlyWhenEmpty: boolean;
  keep: string;
  command: string;
}

const PRESETS: { label: string; cron: string }[] = [
  { label: "Daily 04:00", cron: "0 4 * * *" },
  { label: "Daily 05:00", cron: "0 5 * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Weekly Sun 03:00", cron: "0 3 * * 0" },
  { label: "Every 30 min", cron: "*/30 * * * *" },
];

const TYPE_LABEL: Record<JobType, string> = { restart: "Restart", backup: "Backup", command: "Command" };

function toForm(j?: JobView): JobForm {
  return {
    name: j?.name ?? "",
    type: j?.type ?? "backup",
    cron: j?.cron ?? "0 4 * * *",
    enabled: j?.enabled ?? true,
    warnMinutes: (j?.options.warnMinutes ?? [10, 5, 1]).join(", "),
    onlyWhenEmpty: j?.options.onlyWhenEmpty ?? false,
    keep: String(j?.options.keep ?? 7),
    command: j?.options.command ?? "",
  };
}

function fromForm(f: JobForm) {
  const options: Record<string, unknown> = {};
  if (f.type === "restart") {
    options.warnMinutes = f.warnMinutes
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    options.onlyWhenEmpty = f.onlyWhenEmpty;
  }
  if (f.type === "backup") options.keep = Number(f.keep) || 7;
  if (f.type === "command") options.command = f.command.trim();
  return { name: f.name.trim(), type: f.type, cron: f.cron.trim(), enabled: f.enabled, options };
}

function JobEditor({ job, onClose }: { job?: JobView; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<JobForm>(toForm(job));
  const set = <K extends keyof JobForm>(k: K, v: JobForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: () => (job ? api.put(`/jobs/${job.id}`, fromForm(f)) : api.post("/jobs", fromForm(f))),
    onSuccess: () => {
      toast(job ? "Job updated" : "Job created");
      qc.invalidateQueries({ queryKey: ["jobs"] });
      onClose();
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  return (
    <Modal title={job ? "Edit job" : "New maintenance job"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="field">
          Name
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} required />
        </label>
        <div className="form-grid">
          <label className="field">
            Type
            <select className="input" value={f.type} onChange={(e) => set("type", e.target.value as JobType)}>
              <option value="backup">World backup</option>
              <option value="restart">Restart with countdown</option>
              <option value="command">RCON command</option>
            </select>
          </label>
          <label className="field">
            Schedule (cron) <span className="muted small">{describeCron(f.cron)}</span>
            <input className="input mono" value={f.cron} onChange={(e) => set("cron", e.target.value)} required />
          </label>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {PRESETS.map((p) => (
            <button key={p.cron} type="button" className={`btn sm ${f.cron === p.cron ? "primary" : "ghost"}`} onClick={() => set("cron", p.cron)}>
              {p.label}
            </button>
          ))}
        </div>

        {f.type === "restart" && (
          <div className="form-grid">
            <label className="field">
              Warn players at (minutes before)
              <input className="input" value={f.warnMinutes} onChange={(e) => set("warnMinutes", e.target.value)} placeholder="10, 5, 1" />
            </label>
            <label className="check" style={{ alignSelf: "end", paddingBottom: 8 }}>
              <input type="checkbox" checked={f.onlyWhenEmpty} onChange={(e) => set("onlyWhenEmpty", e.target.checked)} />
              Skip if players are online
            </label>
          </div>
        )}
        {f.type === "backup" && (
          <label className="field">
            Keep the newest N backups
            <input className="input" type="number" min={1} max={365} value={f.keep} onChange={(e) => set("keep", e.target.value)} />
          </label>
        )}
        {f.type === "command" && (
          <label className="field">
            Command (sent over RCON)
            <input className="input mono" value={f.command} onChange={(e) => set("command", e.target.value)} placeholder="say Daily reminder: be nice" required />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Enabled
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {job ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Maintenance() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirm } = useDialog();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobView[]>("/jobs"), refetchInterval: 5000 });
  const runs = useQuery({ queryKey: ["jobs", "runs"], queryFn: () => api.get<JobRun[]>("/jobs/runs?limit=20"), refetchInterval: 5000 });
  const backups = useQuery({ queryKey: ["backups"], queryFn: () => api.get<BackupFile[]>("/backups"), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<JobView | null | "new">(null);

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["jobs"] });
    qc.invalidateQueries({ queryKey: ["backups"] });
  };
  const onError = (e: Error) => toast(e.message, "error");

  const toggle = useMutation({ mutationFn: (j: JobView) => api.put(`/jobs/${j.id}`, { enabled: !j.enabled }), onSuccess: refetchAll, onError });
  const run = useMutation({
    mutationFn: (j: JobView) => api.post(`/jobs/${j.id}/run`),
    onSuccess: (_r, j) => {
      toast(`Running "${j.name}"`);
      refetchAll();
    },
    onError,
  });
  const del = useMutation({ mutationFn: (j: JobView) => api.del(`/jobs/${j.id}`), onSuccess: refetchAll, onError });
  const backupNow = useMutation({
    mutationFn: () => api.post<{ file: string; bytes: number }>("/backups"),
    onSuccess: (r) => {
      toast(`Backup created: ${r.file} (${fmtBytes(r.bytes)})`);
      refetchAll();
    },
    onError,
  });
  const delBackup = useMutation({ mutationFn: (name: string) => api.del(`/backups/${encodeURIComponent(name)}`), onSuccess: refetchAll, onError });

  const totalBackupBytes = (backups.data ?? []).reduce((s, b) => s + b.bytes, 0);

  return (
    <>
      <PageHead
        title="Minecraft maintenance"
        sub="Scheduled restarts with in-game countdowns, world backups with retention, and recurring console commands."
        actions={
          <>
            <button className="btn" disabled={backupNow.isPending} onClick={() => backupNow.mutate()}>
              <Icons.drive width={14} height={14} /> {backupNow.isPending ? "Backing up…" : "Back up now"}
            </button>
            <button className="btn primary" onClick={() => setEditing("new")}>
              <Icons.plus width={14} height={14} /> New job
            </button>
          </>
        }
      />
      <ErrorNotice error={jobs.error} />

      <Card title="Scheduled jobs">
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Schedule</th>
              <th>Next run</th>
              <th>Last run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No jobs yet.
                </td>
              </tr>
            )}
            {jobs.data?.map((j) => (
              <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.6 }}>
                <td>
                  <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                    <span style={{ fontWeight: 500 }}>{j.name}</span>
                    <span className="badge">{TYPE_LABEL[j.type]}</span>
                    {j.running && <span className="badge accent">Running</span>}
                  </div>
                  <div className="muted small">
                    {j.type === "restart" && `Warn at ${(j.options.warnMinutes ?? []).join(", ")} min${j.options.onlyWhenEmpty ? " · skip if players online" : ""}`}
                    {j.type === "backup" && `Keep newest ${j.options.keep ?? 7}`}
                    {j.type === "command" && <span className="mono">{j.options.command}</span>}
                  </div>
                </td>
                <td>
                  <div>{describeCron(j.cron)}</div>
                  <div className="muted small mono">{j.cron}</div>
                </td>
                <td className="nowrap">{j.enabled ? (j.nextRun ? <span title={fmtDateTime(j.nextRun)}>{fmtRelative(j.nextRun)}</span> : "–") : <span className="muted">Disabled</span>}</td>
                <td>
                  {j.lastRun ? (
                    <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                      <StatusPill state={j.lastRun.ok === null ? "degraded" : j.lastRun.ok ? "ok" : "down"} label={j.lastRun.ok === null ? "Running" : j.lastRun.ok ? "OK" : "Failed"} />
                      <span className="small dim truncate" style={{ maxWidth: 260 }} title={j.lastRun.message}>
                        {fmtRelative(j.lastRun.startedAt)} · {j.lastRun.message}
                      </span>
                    </div>
                  ) : (
                    <span className="muted">Never</span>
                  )}
                </td>
                <td>
                  <div className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                    <button className="btn sm ghost" disabled={j.running || run.isPending} onClick={() => run.mutate(j)}>
                      Run now
                    </button>
                    <button className="btn sm ghost" onClick={() => toggle.mutate(j)}>
                      {j.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="btn sm ghost" onClick={() => setEditing(j)}>
                      Edit
                    </button>
                    <button
                      className="btn sm ghost danger"
                      onClick={async () => {
                        if (await confirm({ title: `Delete "${j.name}"?`, confirmLabel: "Delete", danger: true })) del.mutate(j);
                      }}
                    >
                      <Icons.trash width={14} height={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid wide" style={{ marginTop: 14 }}>
        <Card title="World backups" actions={<span className="muted small">{backups.data ? `${backups.data.length} · ${fmtBytes(totalBackupBytes)}` : ""}</span>}>
          <ErrorNotice error={backups.error} />
          {backups.data?.length === 0 && <span className="muted">No backups yet. Run "Back up now" or enable the nightly job.</span>}
          {!!backups.data?.length && (
            <table className="table">
              <tbody>
                {backups.data.map((b) => (
                  <tr key={b.name}>
                    <td className="mono">{b.name}</td>
                    <td className="num dim">{fmtBytes(b.bytes)}</td>
                    <td className="dim nowrap">{fmtDateTime(b.mtime)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn sm ghost danger"
                        onClick={async () => {
                          if (await confirm({ title: `Delete ${b.name}?`, confirmLabel: "Delete", danger: true })) delBackup.mutate(b.name);
                        }}
                      >
                        <Icons.trash width={14} height={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent runs">
          {runs.data?.length === 0 && <span className="muted">Nothing has run yet.</span>}
          {!!runs.data?.length && (
            <table className="table">
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <StatusPill state={r.ok === null ? "degraded" : r.ok ? "ok" : "down"} label={r.ok === null ? "Running" : r.ok ? "OK" : "Failed"} />
                    </td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{r.jobName}</div>
                      <div className="small dim">{r.message}</div>
                    </td>
                    <td className="dim nowrap small" title={fmtDateTime(r.startedAt)}>
                      {fmtRelative(r.startedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {editing && <JobEditor job={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

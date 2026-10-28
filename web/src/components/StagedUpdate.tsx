// "Staged update": Paper and every plugin — installed version (from the jar), what is
// staged for the next update/restart, and the latest upstream release, with dates.
// Read-only; the owner's update-fetch + restart timers do the actual work.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDateTime, fmtRelative } from "../format";
import type { StagedUpdatePayload, UpdateItem, UpdateStatus, UpdateVersion } from "../types";
import { Icons } from "./icons";
import { Card, ErrorNotice, StatusPill, useToast } from "./ui";

const STATUS: Record<UpdateStatus, { label: string; state: string }> = {
  "up-to-date": { label: "up to date", state: "ok" },
  staged: { label: "staged for next restart", state: "degraded" },
  "update-available": { label: "update available", state: "down" },
  unknown: { label: "unknown", state: "unavailable" },
};

function Ver({ v, empty = "–" }: { v: UpdateVersion | null; empty?: string }) {
  if (!v) return <span className="muted">{empty}</span>;
  const label = v.version && v.version === v.mcVersion && v.build != null ? `${v.version}-${v.build}`
    : v.version ?? (v.build != null ? `build ${v.build}` : "version unknown");
  return (
    <span className="nowrap" title={[v.file, v.source ? `source: ${v.source}` : null, v.channel ? `channel: ${v.channel}` : null].filter(Boolean).join("\n")}>
      {v.url ? (
        <a href={v.url} target="_blank" rel="noreferrer" className="mono">
          {label}
        </a>
      ) : (
        <span className="mono">{label}</span>
      )}
      {v.channel && v.channel !== "default" && <span className="badge warn">{v.channel}</span>}
      <span className="muted small" style={{ display: "block" }} title={v.date ? fmtDateTime(v.date) : ""}>
        {v.date ? fmtRelative(v.date) : "date unknown"}
      </span>
    </span>
  );
}

export function StagedUpdate() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["updates"], queryFn: () => api.get<StagedUpdatePayload>("/updates"), refetchInterval: 5 * 60_000 });
  const refresh = useMutation({
    mutationFn: () => api.get<StagedUpdatePayload>("/updates?refresh=1"),
    onSuccess: (d) => {
      qc.setQueryData(["updates"], d);
      toast("Versions re-checked");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const d = q.data;
  const staged = d?.items.filter((i) => i.status === "staged") ?? [];
  const available = d?.items.filter((i) => i.status === "update-available") ?? [];

  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8, margin: 0 }}>
          Staged update
          {staged.length > 0 && <span className="badge accent">{staged.length} staged</span>}
          {available.length > 0 && <span className="badge warn">{available.length} newer upstream</span>}
        </h2>
      }
      actions={
        <div className="row" style={{ gap: 8 }}>
          {d?.checkedAt && <span className="muted small">Checked {fmtRelative(d.checkedAt)}</span>}
          <button className="btn sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <Icons.refresh width={13} height={13} /> Re-check
          </button>
        </div>
      }
    >
      <ErrorNotice error={q.error} />
      {d && (
        <div className="row small muted" style={{ gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
          <span>
            Minecraft <strong className="mono" style={{ color: "var(--ink)" }}>{d.mcVersion ?? "?"}</strong>
            {d.newestMcVersion && d.newestMcVersion !== d.mcVersion && <> · newest release {d.newestMcVersion}</>}
          </span>
          <span>
            Staging folder:{" "}
            {d.stagingDirs.length ? (
              d.stagingDirs.map((s) => (
                <span key={s.path} className="mono" title={s.exists ? `${s.files} jar(s) waiting` : "does not exist"} style={{ color: s.exists ? undefined : "var(--critical)" }}>
                  {s.path}
                  {s.exists ? ` (${s.files})` : " (missing)"}{" "}
                </span>
              ))
            ) : (
              <span style={{ color: "var(--critical)" }}>none found</span>
            )}
          </span>
          <span>Last fetch: {d.lastFetch ? <span title={fmtDateTime(d.lastFetch)}>{fmtRelative(d.lastFetch)}</span> : "–"}</span>
          <span>
            Applied by: {d.nextApply ? <>{d.nextApply.job} · next {d.nextApply.at ? <span title={fmtDateTime(d.nextApply.at)}>{fmtRelative(d.nextApply.at)}</span> : "–"}</> : <span style={{ color: "var(--warning)" }}>no update/restart job found</span>}
          </span>
        </div>
      )}
      {d?.notes.map((n) => (
        <div key={n} className="notice" style={{ marginBottom: 8 }}>
          {n}
        </div>
      ))}
      {!d && !q.error && <div className="skeleton">Reading jars and checking upstream…</div>}
      {d && (
        <table className="table updates">
          <thead>
            <tr>
              <th>Component</th>
              <th>Installed</th>
              <th>Staged</th>
              <th>Latest upstream</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((i: UpdateItem) => (
              <tr key={`${i.kind}:${i.name}`} className={i.kind === "paper" ? "paper-row" : ""}>
                <td>
                  <div style={{ fontWeight: i.kind === "paper" ? 600 : 500 }}>{i.name}</div>
                  {i.note && <div className="muted small">{i.note}</div>}
                </td>
                <td>
                  <Ver v={i.installed} empty="not installed" />
                </td>
                <td>
                  <Ver v={i.staged} empty="–" />
                </td>
                <td>
                  <Ver v={i.latest} empty={d.upstreamChecked ? "–" : "checks off"} />
                </td>
                <td>
                  <StatusPill state={STATUS[i.status].state} label={STATUS[i.status].label} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small" style={{ margin: "10px 0 0" }}>
        Paper is read from the server jar in the main Minecraft folder; plugin versions come from their plugin.yml files. Staged versions come from your update-fetch folder; latest versions from PaperMC, Modrinth, Hangar or GitHub. This panel only reads — the existing update + restart timer applies staged files.
      </p>
    </Card>
  );
}

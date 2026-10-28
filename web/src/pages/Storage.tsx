// Storage: capacity per filesystem, the TreeSize-style explorer (ncdu/gdu scans),
// a "reclaimable space" report with the commands to run, and the folders the
// dashboard manages. The page never deletes anything.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { StorageExplorer } from "../components/StorageExplorer";
import { DriveInventory } from "../components/DriveInventory";
import { Card, ErrorNotice, Meter, PageHead, useToast } from "../components/ui";
import { fmtBytes, fmtRelative } from "../format";
import type { ReclaimPayload, StoragePayload } from "../types";

const pollWhileMeasuring = (q: { state: { data?: { measuring?: boolean } } }) => (q.state.data?.measuring ? 2000 : 60_000);

/** Compact line for the Dashboard's Storage card. */
export function ReclaimHint() {
  const q = useQuery({ queryKey: ["storage", "reclaim"], queryFn: () => api.get<ReclaimPayload>("/storage/reclaim"), refetchInterval: pollWhileMeasuring });
  const d = q.data;
  if (!d) return null;
  return (
    <div className="small muted" style={{ marginTop: 4 }}>
      {d.measuring && !d.measuredAt ? (
        "Measuring reclaimable space…"
      ) : (
        <>
          ≈ <strong style={{ color: "var(--ink)" }}>{fmtBytes(d.totalBytes)}</strong> reclaimable without touching media, worlds or backups
        </>
      )}
    </div>
  );
}

function Reclaim() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["storage", "reclaim"], queryFn: () => api.get<ReclaimPayload>("/storage/reclaim"), refetchInterval: pollWhileMeasuring });
  const refresh = useMutation({
    mutationFn: () => api.get("/storage/reclaim?refresh=1"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["storage", "reclaim"] }),
  });
  const d = q.data;
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast("Copied"), () => toast("Could not copy", "error"));
  const measured = (d?.items ?? []).filter((i) => i.bytes !== null);
  const max = Math.max(1, ...measured.map((i) => i.bytes ?? 0));

  return (
    <Card
      title="Reclaimable space"
      actions={
        <div className="row" style={{ gap: 8 }}>
          {d?.measuredAt && <span className="muted small">Measured {fmtRelative(d.measuredAt)}</span>}
          <button className="btn sm" disabled={d?.measuring || refresh.isPending} onClick={() => refresh.mutate()}>
            <Icons.refresh width={13} height={13} /> Re-check
          </button>
        </div>
      }
    >
      <ErrorNotice error={q.error} />
      <div className="row" style={{ alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span className="hero-num">{d && (!d.measuring || d.measuredAt) ? `≈ ${fmtBytes(d.totalBytes)}` : "…"}</span>
        <span className="muted small">could be freed by the commands below. Nothing here is deleted by the dashboard — copy a command and run it (or hand it to an agent). Media, worlds and the owner's backups are never on this list.</span>
      </div>
      {d?.measuring && !d.measuredAt && <div className="skeleton">Checking Docker, journald, caches, trash…</div>}
      <div className="tree">
        {(d?.items ?? []).map((i) => (
          <div key={i.id} className={`tree-row reclaim ${i.actionable ? "" : "dim"}`}>
            <span className="tree-name">
              <div style={{ fontWeight: 500 }}>{i.label}</div>
              <div className="small muted">{i.detail}</div>
              {i.command && (
                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  <code className="mono small code-inline truncate" title={i.command}>
                    {i.command}
                  </code>
                  <button className="btn sm ghost" onClick={() => copy(i.command!)}>
                    copy
                  </button>
                </div>
              )}
            </span>
            <span className="tree-bar" aria-hidden>
              {i.bytes !== null && <span className={`tree-fill ${i.actionable ? "" : "neutral"}`} style={{ width: `${Math.max(0.5, ((i.bytes ?? 0) / max) * 100)}%` }} />}
            </span>
            <span className="tree-pct" />
            <span className="tree-size nowrap">{i.bytes === null ? <span className="muted small">not measurable</span> : fmtBytes(i.bytes)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Storage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["storage"], queryFn: () => api.get<StoragePayload>("/storage"), refetchInterval: (query) => (query.state.data?.refreshing ? 2000 : 30_000) });
  const refresh = useMutation({
    mutationFn: () => api.post("/storage/refresh"),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["storage"] }), 500),
  });
  const d = q.data;
  const known = (d?.folders ?? []).filter((f) => f.bytes !== null);
  const maxFolder = Math.max(1, ...known.map((f) => f.bytes ?? 0));

  return (
    <>
      <PageHead
        title="Storage"
        sub="Connected drives, mounted storage, a TreeSize-style explorer, and the folders the dashboard manages."
        actions={
          <button className="btn" disabled={d?.refreshing || refresh.isPending} onClick={() => refresh.mutate()}>
            <Icons.refresh width={14} height={14} /> {d?.refreshing ? "Measuring…" : "Re-measure folders"}
          </button>
        }
      />
      <ErrorNotice error={q.error} />

      <div style={{ marginBottom: 14 }}><DriveInventory inventory={d?.driveInventory} /></div>

      <div className="grid wide" style={{ marginBottom: 14 }}>
        {d?.filesystems.length === 0 && <div className="notice">No filesystems reported by df.</div>}
        {(d?.filesystems ?? []).map((f) => (
          <Card key={f.mount}>
            <Meter
              label={
                <>
                  <strong>{f.mount}</strong> <span className="muted small">{f.filesystem}</span>
                </>
              }
              used={f.usedBytes}
              total={f.totalBytes}
              sub={`${fmtBytes(f.usedBytes)} of ${fmtBytes(f.totalBytes)}`}
            />
          </Card>
        ))}
      </div>

      <div className="stack" style={{ gap: 14 }}>
        <StorageExplorer />
        <Reclaim />
        <Card title="Managed folders" actions={<span className="muted small">{d?.refreshedAt ? `Measured ${fmtRelative(d.refreshedAt)}` : d?.refreshing ? "Measuring…" : "Not measured yet"}</span>}>
          <table className="table">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Path</th>
                <th style={{ width: "30%" }} />
                <th className="num">Size</th>
              </tr>
            </thead>
            <tbody>
              {(d?.folders ?? []).map((f) => (
                <tr key={f.path}>
                  <td style={{ fontWeight: 500 }}>{f.label}</td>
                  <td className="mono dim truncate" style={{ maxWidth: 320 }}>
                    {f.path}
                  </td>
                  <td>
                    {f.bytes !== null && (
                      <div className="meter-track" style={{ height: 6 }}>
                        <div className="meter-fill" style={{ width: `${Math.max(2, (f.bytes / maxFolder) * 100)}%` }} />
                      </div>
                    )}
                  </td>
                  <td className="num">{f.bytes === null ? <span className="muted small">{f.error ?? "…"}</span> : fmtBytes(f.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

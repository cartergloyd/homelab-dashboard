// Storage: capacity per filesystem, the configured folders, and (issue #4) a
// TreeSize-style explorer — drill into any folder to see where the space goes —
// plus the largest files and a "reclaimable space" report with the commands to
// run. The page never deletes anything.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, Meter, PageHead, useToast } from "../components/ui";
import { fmtBytes, fmtDateTime, fmtRelative } from "../format";
import type { LargestPayload, ReclaimPayload, StoragePayload, StorageTreePayload } from "../types";

const LS_KEY = "storage.explorer.path";
const pollWhileMeasuring = (q: { state: { data?: { measuring?: boolean } } }) => (q.state.data?.measuring ? 2000 : 60_000);

function crumbs(p: string): { label: string; path: string }[] {
  const parts = p.split("/").filter(Boolean);
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

const pct = (n: number, of: number | null | undefined) => (of ? `${((n / of) * 100).toFixed(of && n / of < 0.1 ? 1 : 0)}%` : "");

/** Compact line for the Dashboard's Storage card. */
export function ReclaimHint() {
  const q = useQuery({ queryKey: ["storage", "reclaim"], queryFn: () => api.get<ReclaimPayload>("/storage/reclaim"), refetchInterval: pollWhileMeasuring });
  const d = q.data;
  if (!d) return null;
  return (
    <div className="small muted" style={{ marginTop: 4 }}>
      {d.measuring && !d.measuredAt ? "Measuring reclaimable space…" : <>≈ <strong style={{ color: "var(--ink)" }}>{fmtBytes(d.totalBytes)}</strong> reclaimable without touching media, worlds or backups</>}
    </div>
  );
}

function Explorer() {
  const toast = useToast();
  const qc = useQueryClient();
  const [path, setPath] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_KEY) || "/";
    } catch {
      return "/";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, path);
    } catch {
      // ignore
    }
  }, [path]);

  const tree = useQuery({ queryKey: ["storage", "tree", path], queryFn: () => api.get<StorageTreePayload>(`/storage/tree?path=${encodeURIComponent(path)}`), refetchInterval: pollWhileMeasuring });
  const largest = useQuery({ queryKey: ["storage", "largest", path], queryFn: () => api.get<LargestPayload>(`/storage/largest?path=${encodeURIComponent(path)}&limit=25`), refetchInterval: pollWhileMeasuring });
  const remeasure = useMutation({
    mutationFn: () => Promise.all([api.get(`/storage/tree?path=${encodeURIComponent(path)}&refresh=1`), api.get(`/storage/largest?path=${encodeURIComponent(path)}&limit=25&refresh=1`)]),
    onSuccess: () => {
      toast("Measuring again…");
      qc.invalidateQueries({ queryKey: ["storage", "tree", path] });
      qc.invalidateQueries({ queryKey: ["storage", "largest", path] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const t = tree.data;
  const total = t?.totalBytes ?? null;
  const diskPct = t?.mount && total ? (total / t.mount.totalBytes) * 100 : null;
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast("Copied"), () => toast("Could not copy", "error"));

  return (
    <>
      <Card
        title="Where the space goes"
        actions={
          <div className="row" style={{ gap: 8 }}>
            {t?.measuredAt && <span className="muted small">Measured {fmtRelative(t.measuredAt)}</span>}
            <button className="btn sm" disabled={!!t?.measuring || remeasure.isPending} onClick={() => remeasure.mutate()}>
              <Icons.refresh width={13} height={13} /> Re-measure
            </button>
          </div>
        }
      >
        <div className="crumbs">
          {crumbs(path).map((c, i, arr) => (
            <span key={c.path} className="row" style={{ gap: 4 }}>
              {i > 0 && <span className="muted">›</span>}
              <button className={`crumb ${i === arr.length - 1 ? "current" : ""}`} onClick={() => setPath(c.path)} disabled={i === arr.length - 1}>
                {c.label}
              </button>
            </span>
          ))}
          <span style={{ flex: 1 }} />
          {total !== null && (
            <span className="small nowrap">
              <strong>{fmtBytes(total)}</strong>
              {t?.mount && (
                <span className="muted">
                  {" "}
                  · {diskPct !== null ? `${diskPct.toFixed(diskPct < 10 ? 1 : 0)}%` : ""} of {t.mount.mount} ({fmtBytes(t.mount.totalBytes)})
                </span>
              )}
            </span>
          )}
          <button className="btn sm ghost mono" onClick={() => copy(path)} title="Copy path">
            copy
          </button>
        </div>
        <ErrorNotice error={tree.error} />
        {t?.error && <div className="notice error">{t.error}</div>}
        {t?.partial && <div className="notice">Some folders here could not be read by the dashboard's user, so these sizes are lower bounds. Compare with the disk meter above; the gap is what it cannot see (often /var/lib/docker or other users' homes).</div>}
        {t?.measuring && <div className="skeleton">Measuring {path} with du — big folders take a minute; this page keeps polling.</div>}
        {t && !t.measuring && t.entries.length === 0 && !t.error && <div className="muted small">Empty folder.</div>}
        <div className="tree">
          {(t?.entries ?? []).map((e) => {
            const share = total ? (e.bytes / total) * 100 : 0;
            return (
              <div key={`${e.kind}:${e.path}:${e.name}`} className={`tree-row ${e.kind === "dir" ? "clickable" : ""}`} onClick={e.kind === "dir" ? () => setPath(e.path) : undefined} role={e.kind === "dir" ? "button" : undefined} title={e.path}>
                <span className="tree-name truncate">
                  {e.kind === "dir" ? <Icons.folder width={13} height={13} /> : <Icons.file width={13} height={13} />} {e.name}
                  {e.kind === "dir" && <Icons.chevron width={12} height={12} className="muted" />}
                </span>
                <span className="tree-bar" aria-hidden>
                  <span className="tree-fill" style={{ width: `${Math.max(0.5, share)}%` }} />
                </span>
                <span className="tree-pct muted small nowrap">{pct(e.bytes, total)}</span>
                <span className="tree-size nowrap">{fmtBytes(e.bytes)}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title={`Largest files under ${path}`} actions={<span className="muted small">{largest.data?.measuring ? "Searching…" : largest.data?.measuredAt ? `${largest.data.files.length} files over ${fmtBytes(largest.data.minBytes)}` : ""}</span>}>
        <ErrorNotice error={largest.error} />
        {largest.data?.error && <div className="notice error">{largest.data.error}</div>}
        {largest.data?.measuring && !largest.data.files.length && <div className="skeleton">Running find on this filesystem…</div>}
        {largest.data && !largest.data.measuring && largest.data.files.length === 0 && !largest.data.error && <div className="muted small">No files over {fmtBytes(largest.data.minBytes)} here.</div>}
        {!!largest.data?.files.length && (
          <table className="table">
            <thead>
              <tr>
                <th className="num">Size</th>
                <th>Modified</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {largest.data.files.map((f) => (
                <tr key={f.path}>
                  <td className="num nowrap">{fmtBytes(f.bytes)}</td>
                  <td className="nowrap muted small">{f.modified ? fmtDateTime(f.modified) : "–"}</td>
                  <td className="mono small truncate" style={{ maxWidth: 520 }} title={f.path}>
                    <button className="linkish" onClick={() => setPath(f.path.slice(0, f.path.lastIndexOf("/")) || "/")} title="Open the folder">
                      {f.path}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
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
        sub="Capacity per disk, the folders the dashboard manages, and a TreeSize-style explorer to see where the space goes and what can be reclaimed."
        actions={
          <button className="btn" disabled={d?.refreshing || refresh.isPending} onClick={() => refresh.mutate()}>
            <Icons.refresh width={14} height={14} /> {d?.refreshing ? "Measuring…" : "Re-measure folders"}
          </button>
        }
      />
      <ErrorNotice error={q.error} />

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
        <Explorer />
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

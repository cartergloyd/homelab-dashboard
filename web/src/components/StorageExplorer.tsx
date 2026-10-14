// TreeSize-style storage explorer (issue #4), fed by whole-filesystem scans that
// ncdu / gdu (or du as a fallback) produce on the server. Everything shown here is
// read from the last scan in memory, so browsing is instant; "Scan now" refreshes.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtBytes, fmtDateTime, fmtRelative } from "../format";
import type { DirViewPayload, DiskScanOverview, DiskScanSummary, ScanDirSummary } from "../types";
import { Icons } from "./icons";
import { Card, ErrorNotice, useToast } from "./ui";

const LS_KEY = "storage.explorer.v2";
const enc = (s: string | null | undefined) => encodeURIComponent(s ?? "");
const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)}%` : "");
const whenS = (s: number | null) => (s ? fmtRelative(new Date(s * 1000).toISOString()) : "–");

function readLS(): { root: string | null; path: string | null } {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "null") ?? { root: null, path: null };
  } catch {
    return { root: null, path: null };
  }
}

function crumbs(root: string, p: string): { label: string; path: string }[] {
  const out = [{ label: root, path: root }];
  if (p === root) return out;
  const rel = p.slice(root.endsWith("/") ? root.length : root.length + 1).split("/").filter(Boolean);
  let acc = root;
  for (const part of rel) {
    acc = acc.endsWith("/") ? `${acc}${part}` : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

// ---- treemap (squarified) ---------------------------------------------------------------

interface TmItem {
  key: string;
  label: string;
  bytes: number;
  path: string | null;
  kind: "dir" | "files";
}
interface Rect {
  item: TmItem;
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
}

function squarify(items: TmItem[], x: number, y: number, w: number, h: number): Rect[] {
  const total = items.reduce((s, i) => s + i.bytes, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const out: Rect[] = [];
  let rest = items.filter((i) => i.bytes > 0).map((i) => ({ item: i, area: i.bytes * scale }));
  let rank = 0;
  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;
  const worst = (row: { area: number }[], side: number) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const mx = Math.max(...row.map((r) => r.area));
    const mn = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(cw, ch);
    const row: typeof rest = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(row.length);
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (cw >= ch) {
      // lay the row vertically along the left edge
      const rw = sum / ch;
      let ry = cy;
      for (const r of row) {
        const rh = r.area / rw;
        out.push({ item: r.item, x: cx, y: ry, w: rw, h: rh, rank: rank++ });
        ry += rh;
      }
      cx += rw;
      cw -= rw;
    } else {
      const rh = sum / cw;
      let rx = cx;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ item: r.item, x: rx, y: cy, w: rw, h: rh, rank: rank++ });
        rx += rw;
      }
      cy += rh;
      ch -= rh;
    }
  }
  return out;
}

function Treemap({ items, onOpen }: { items: TmItem[]; onOpen: (p: string) => void }) {
  // laid out in a 1000×600 box, rendered as percentage-positioned divs so labels are real pixels
  const W = 1000;
  const H = 600;
  const rects = useMemo(() => squarify([...items].sort((a, b) => b.bytes - a.bytes).slice(0, 60), 0, 0, W, H), [items]);
  const total = items.reduce((s, i) => s + i.bytes, 0);
  if (!rects.length) return <div className="muted small">Nothing to draw.</div>;
  return (
    <div className="treemap" role="img" aria-label="Treemap of this folder">
      {rects.map((r) => {
        const wPct = (r.w / W) * 100;
        const hPct = (r.h / H) * 100;
        return (
          <div
            key={r.item.key}
            className={`tm ${r.item.kind} ${r.item.path ? "clickable" : ""}`}
            style={{ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${wPct}%`, height: `${hPct}%`, opacity: r.item.kind === "files" ? 0.35 : Math.max(0.35, 0.95 - r.rank * 0.05) }}
            title={`${r.item.label} — ${fmtBytes(r.item.bytes)} (${pct(r.item.bytes, total)})`}
            onClick={r.item.path ? () => onOpen(r.item.path!) : undefined}
          >
            {wPct > 9 && hPct > 9 && (
              <div className="tm-text">
                <div className="tm-label">{r.item.label}</div>
                {hPct > 16 && (
                  <div className="tm-sub">
                    {fmtBytes(r.item.bytes)} · {pct(r.item.bytes, total)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- bars for the statistics tabs ------------------------------------------------------

function Bars({ rows, total }: { rows: { label: string; bytes: number; count: number; sub?: string }[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  if (!rows.length) return <div className="muted small">Nothing here.</div>;
  return (
    <div className="tree">
      {rows.map((r) => (
        <div key={r.label} className="tree-row">
          <span className="tree-name truncate" title={r.label}>
            {r.label}
            {r.sub && <span className="muted small"> {r.sub}</span>}
          </span>
          <span className="tree-bar" aria-hidden>
            <span className="tree-fill" style={{ width: `${Math.max(0.5, (r.bytes / max) * 100)}%` }} />
          </span>
          <span className="tree-pct muted small nowrap">{pct(r.bytes, total)}</span>
          <span className="tree-size nowrap">
            {fmtBytes(r.bytes)} <span className="muted small">· {r.count.toLocaleString()}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ScanStatus({ scan, running }: { scan: DiskScanSummary | undefined; running: string | null }) {
  if (!scan) return <span className="muted small">Not scanned yet.</span>;
  if (scan.status === "running")
    return (
      <span className="small">
        <span className="phase-dot busy" /> Scanning {scan.root} with {scan.engine}… {scan.progress.dirs.toLocaleString()} folders · {scan.progress.files.toLocaleString()} files so far
      </span>
    );
  if (scan.status === "failed")
    return (
      <span className="small" style={{ color: "var(--critical)" }}>
        Scan failed: {scan.error}
      </span>
    );
  return (
    <span className="muted small" title={scan.finishedAt ? fmtDateTime(scan.finishedAt) : ""}>
      Scanned {fmtRelative(scan.finishedAt)} in {scan.durationMs !== null ? `${Math.max(1, Math.round(scan.durationMs / 1000))} s` : "?"} with {scan.engine}
      {scan.engineVersion ? ` ${scan.engineVersion}` : ""} · {scan.totals.files.toLocaleString()} files · {scan.totals.dirs.toLocaleString()} folders
      {scan.totals.readErrors ? ` · ${scan.totals.readErrors} unreadable` : ""}
      {scan.totals.excluded ? ` · ${scan.totals.excluded} skipped (other filesystems / kernel)` : ""}
      {scan.error ? ` · note: ${scan.error}` : ""}
      {running && running !== scan.root ? ` · a scan of ${running} is running` : ""}
    </span>
  );
}

export function StorageExplorer() {
  const toast = useToast();
  const qc = useQueryClient();
  const [sel, setSel] = useState<{ root: string | null; path: string | null }>(readLS);
  const [tab, setTab] = useState<"files" | "ext" | "age" | "owners">("files");
  const ov = useQuery({ queryKey: ["storage", "scan"], queryFn: () => api.get<DiskScanOverview>("/storage/scan"), refetchInterval: (q) => (q.state.data?.running ? 2000 : 30_000) });

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(sel));
    } catch {
      // ignore
    }
  }, [sel]);
  // pick a sensible default root once the overview is in
  useEffect(() => {
    const d = ov.data;
    if (!d) return;
    if (sel.root && d.roots.includes(sel.root)) return;
    const r = d.scans.find((s) => s.status === "done")?.root ?? d.roots[0] ?? null;
    if (r) setSel({ root: r, path: r });
  }, [ov.data, sel.root]);

  const root = sel.root;
  const path = sel.path ?? root;
  const scan = ov.data?.scans.find((s) => s.root === root);
  const view = useQuery({
    queryKey: ["storage", "scan", "dir", root, path, scan?.finishedAt],
    queryFn: () => api.get<DirViewPayload>(`/storage/scan/dir?root=${enc(root)}&path=${enc(path)}`),
    enabled: !!root && !!path && scan?.status === "done",
    retry: false,
  });
  const start = useMutation({
    mutationFn: (r: string) => api.post<DiskScanSummary>("/storage/scan", { root: r }),
    onSuccess: (s) => {
      toast(s.error?.startsWith("queued") ? s.error : `Scanning ${s.root} with ${s.engine}…`);
      qc.invalidateQueries({ queryKey: ["storage", "scan"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  // a root with no scan at all: start one automatically, once
  useEffect(() => {
    if (ov.data && root && !scan && !ov.data.running && !start.isPending) start.mutate(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, scan === undefined, ov.data?.running]);

  const open = (p: string) => setSel({ root, path: p });
  const v = view.data;
  const total = v?.dir.dsize ?? 0;
  const tmItems: TmItem[] = useMemo(() => {
    if (!v) return [];
    const items: TmItem[] = v.children.filter((c) => !c.excluded).map((c) => ({ key: c.path, label: c.name, bytes: c.dsize, path: c.hasChildren || c.files > 0 ? c.path : c.path, kind: "dir" as const }));
    if (v.dir.ownBytes > 0) items.push({ key: "__files", label: `${v.dir.ownFiles.toLocaleString()} files here`, bytes: v.dir.ownBytes, path: null, kind: "files" });
    return items;
  }, [v]);
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast("Copied"), () => toast("Could not copy", "error"));

  return (
    <Card
      title="Where the space goes"
      actions={
        <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {ov.data && (
            <select className="input sm" value={root ?? ""} onChange={(e) => setSel({ root: e.target.value, path: e.target.value })} title="Scanned filesystem / folder">
              {ov.data.roots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <button className="btn sm" disabled={!root || !!ov.data?.running || start.isPending} onClick={() => root && start.mutate(root)} title={ov.data?.running ? `A scan of ${ov.data.running} is running` : "Re-scan this root now"}>
            <Icons.refresh width={13} height={13} /> Scan now
          </button>
        </div>
      }
    >
      <div className="row small" style={{ gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        {ov.data && (
          <span className="badge" title={ov.data.engine.note}>
            engine: {ov.data.engine.preferred}
            {ov.data.engine.available.ncdu ? ` · ncdu ${ov.data.engine.available.ncdu}` : ""}
            {ov.data.engine.available.gdu ? ` · gdu ${ov.data.engine.available.gdu}` : ""}
          </span>
        )}
        <ScanStatus scan={scan} running={ov.data?.running ?? null} />
        {ov.data && ov.data.intervalHours > 0 && <span className="muted small">· re-scans every {ov.data.intervalHours} h</span>}
      </div>
      {ov.data?.engine.preferred === "du" && <div className="notice">Using the <span className="mono">du</span> fallback: slower, and file ages / owners are unavailable. Install ncdu on the server for the full view: <span className="mono">sudo apt install ncdu</span></div>}
      <ErrorNotice error={ov.error} />
      {view.error && scan?.status === "done" && <div className="notice">{(view.error as Error).message}</div>}

      {root && path && (
        <div className="crumbs">
          {crumbs(root, path).map((c, i, arr) => (
            <span key={c.path} className="row" style={{ gap: 4 }}>
              {i > 0 && <span className="muted">›</span>}
              <button className={`crumb ${i === arr.length - 1 ? "current" : ""}`} onClick={() => open(c.path)} disabled={i === arr.length - 1}>
                {c.label}
              </button>
            </span>
          ))}
          <span style={{ flex: 1 }} />
          {v && (
            <span className="small nowrap">
              <strong>{fmtBytes(v.dir.dsize)}</strong>
              <span className="muted">
                {" "}
                · {v.dir.files.toLocaleString()} files · {v.dir.dirs.toLocaleString()} folders
                {v.scan.mount && v.scan.mount.totalBytes ? ` · ${pct(v.dir.dsize, v.scan.mount.totalBytes)} of ${v.scan.mount.mount}` : ""}
              </span>
            </span>
          )}
          <button className="btn sm ghost mono" onClick={() => path && copy(path)} title="Copy path">
            copy
          </button>
          {path !== root && (
            <button className="btn sm ghost" onClick={() => start.mutate(path)} disabled={!!ov.data?.running} title="Scan this folder on its own (adds it as a root, with full statistics)">
              Scan this folder
            </button>
          )}
        </div>
      )}

      {scan?.status === "running" && !v && <div className="skeleton">Scanning… the tree appears when the scan finishes. Big disks take a few minutes with ncdu, longer with du.</div>}

      {v && (
        <div className="explorer-grid">
          <div className="explorer-tree">
            {v.parent && (
              <div className="tree-row clickable" onClick={() => open(v.parent!)} role="button">
                <span className="tree-name">
                  <Icons.chevron width={13} height={13} style={{ transform: "rotate(180deg)" }} /> ..
                </span>
                <span />
                <span />
                <span className="muted small">up</span>
              </div>
            )}
            {v.children.map((c: ScanDirSummary) => (
              <div key={c.path} className={`tree-row ${c.excluded ? "dim" : "clickable"}`} onClick={c.excluded ? undefined : () => open(c.path)} role="button" title={`${c.path}\n${c.files.toLocaleString()} files · ${c.dirs.toLocaleString()} folders · changed ${whenS(c.mtime)}${c.readError ? "\nsome entries could not be read" : ""}${c.excluded ? `\nskipped: ${c.excluded}` : ""}`}>
                <span className="tree-name truncate">
                  <Icons.folder width={13} height={13} /> {c.name}
                  {c.readError && <span className="badge warn">!</span>}
                  {c.excluded && <span className="badge">{c.excluded === "otherfs" ? "other filesystem" : c.excluded}</span>}
                </span>
                <span className="tree-bar" aria-hidden>
                  <span className="tree-fill" style={{ width: `${Math.max(0.5, total ? (c.dsize / total) * 100 : 0)}%` }} />
                </span>
                <span className="tree-pct muted small nowrap">{pct(c.dsize, total)}</span>
                <span className="tree-size nowrap">
                  {fmtBytes(c.dsize)}
                  <span className="tree-meta muted small">
                    {c.files.toLocaleString()} files · {whenS(c.mtime)}
                  </span>
                </span>
              </div>
            ))}
            {v.dir.ownFiles > 0 && (
              <div className="tree-row dim" title={`${v.dir.ownFiles.toLocaleString()} files directly in this folder`}>
                <span className="tree-name truncate">
                  <Icons.file width={13} height={13} /> {v.dir.ownFiles.toLocaleString()} files here
                </span>
                <span className="tree-bar" aria-hidden>
                  <span className="tree-fill neutral" style={{ width: `${Math.max(0.5, total ? (v.dir.ownBytes / total) * 100 : 0)}%` }} />
                </span>
                <span className="tree-pct muted small nowrap">{pct(v.dir.ownBytes, total)}</span>
                <span className="tree-size nowrap">{fmtBytes(v.dir.ownBytes)}</span>
              </div>
            )}
            {!v.children.length && !v.dir.ownFiles && <div className="muted small">Empty folder.</div>}
          </div>
          <div className="explorer-map">
            <Treemap items={tmItems} onOpen={open} />
          </div>
        </div>
      )}

      {v && (
        <div style={{ marginTop: 12 }}>
          <div className="tabs" style={{ marginBottom: 8 }}>
            {(
              [
                ["files", `Largest files (${v.top.length})`],
                ["ext", "By file type"],
                ["age", "By age"],
                ["owners", "By owner"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={`btn sm ${tab === id ? "primary" : "ghost"}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "files" &&
            (v.top.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">Size</th>
                    <th>Changed</th>
                    <th>Owner</th>
                    <th>File</th>
                  </tr>
                </thead>
                <tbody>
                  {v.top.map((f) => (
                    <tr key={f.path}>
                      <td className="num nowrap">{fmtBytes(f.dsize)}</td>
                      <td className="nowrap muted small">{f.mtime ? fmtDateTime(new Date(f.mtime * 1000).toISOString()) : "–"}</td>
                      <td className="nowrap muted small">{v.stats.owners.find((o) => o.uid === f.uid)?.name ?? (f.uid ?? "–")}</td>
                      <td className="mono small truncate" style={{ maxWidth: 520 }} title={f.path}>
                        <button className="linkish" onClick={() => open(f.path.slice(0, f.path.lastIndexOf("/")) || root!)} title="Open the folder">
                          {f.path.startsWith(`${path}/`) ? f.path.slice(path!.length + 1) : f.path}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted small">No files in this subtree.</div>
            ))}
          {tab !== "files" && !v.stats.available && (
            <div className="notice">
              Type / age / owner statistics are kept for the top 3 levels of a scan. For this folder, use <strong>Scan this folder</strong> above to scan it on its own.
            </div>
          )}
          {tab === "ext" && v.stats.available && <Bars rows={v.stats.ext.map((e) => ({ label: e.ext, bytes: e.bytes, count: e.count }))} total={total} />}
          {tab === "age" && v.stats.available && <Bars rows={v.stats.age.map((a) => ({ label: a.label, bytes: a.bytes, count: a.count }))} total={total} />}
          {tab === "owners" && v.stats.available && <Bars rows={v.stats.owners.map((o) => ({ label: o.name ?? `uid ${o.uid}`, bytes: o.bytes, count: o.count, sub: o.name ? `(${o.uid})` : undefined }))} total={total} />}
        </div>
      )}
    </Card>
  );
}

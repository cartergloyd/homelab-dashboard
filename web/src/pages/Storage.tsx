import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, Meter, PageHead } from "../components/ui";
import { fmtBytes, fmtRelative } from "../format";
import type { StoragePayload } from "../types";

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
        sub="Filesystem capacity from df; folder sizes from du, refreshed every 15 minutes in the background."
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

      <Card title="Folder sizes" actions={<span className="muted small">{d?.refreshedAt ? `Measured ${fmtRelative(d.refreshedAt)}` : d?.refreshing ? "Measuring…" : "Not measured yet"}</span>}>
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
    </>
  );
}

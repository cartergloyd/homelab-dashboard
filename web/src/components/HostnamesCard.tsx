// Domain & hostnames: every name under the owner's domain with where it points, whether Cloudflare
// proxies it, and a live probe. Read-only — DNS is changed in Cloudflare, never here.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtRelative } from "../format";
import type { HostRole, HostnamesPayload } from "../types";
import { Card, StatusPill } from "./ui";

const ROLE: Record<HostRole, string> = { site: "Site", api: "API (Directus)", dashboard: "Dashboard", game: "Minecraft", stream: "Streaming", other: "Other" };

export function HostnamesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hostnames"], queryFn: () => api.get<HostnamesPayload>("/hostnames"), refetchInterval: 60_000 });
  const refresh = useMutation({ mutationFn: () => api.get<HostnamesPayload>("/hostnames?refresh=1"), onSuccess: (d) => qc.setQueryData(["hostnames"], d) });
  const d = q.data;
  const ok = d?.rows.filter((r) => r.state === "ok").length ?? 0;
  return (
    <Card
      title={`Domain · ${d?.domain ?? "…"}`}
      actions={
        <span className="row" style={{ gap: 8 }}>
          {d && <span className="muted small">{ok} / {d.rows.length} answering</span>}
          <button className="btn sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Checking…" : "Re-check"}
          </button>
        </span>
      }
    >
      {d?.error && <div className="notice" style={{ marginBottom: 10 }}>{d.error}</div>}
      {!d ? (
        <span className="skeleton">Checking…</span>
      ) : !d.rows.length ? (
        <span className="muted">No hostnames known. Set PUBLIC_DOMAIN, and either CLOUDFLARE_API_TOKEN (read-only) or keep deploy/dns/&lt;domain&gt;.zone current (SERVER_SETUP § 6h).</span>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>What</th>
                <th>Points to</th>
                <th>Proxy</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.host}>
                  <td className="mono">
                    {r.resolved.length && r.role !== "game" ? (
                      <a href={`https://${r.host}`} target="_blank" rel="noreferrer">
                        {r.host}
                      </a>
                    ) : (
                      r.host
                    )}
                    {r.note && <div className="muted small">{r.note}</div>}
                  </td>
                  <td>{ROLE[r.role]}</td>
                  <td className="mono small">{r.target ?? <span className="muted">no record</span>}</td>
                  <td>{r.proxied === null ? <span className="muted small">—</span> : r.proxied ? <span className="badge accent">Proxied</span> : <span className="badge">DNS only</span>}</td>
                  <td>
                    <StatusPill state={r.state} label={r.probe.detail} />
                    {r.probe.latencyMs !== null && <span className="muted small"> {r.probe.latencyMs} ms</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {d.otherRecords.length > 0 && <div>Also: {d.otherRecords.join(" · ")}</div>}
          <div>
            Source: {d.source === "cloudflare" ? "Cloudflare DNS (read-only token)" : d.source === "zonefile" ? `zone file ${d.zoneFile}` : d.source === "config" ? "dashboard config only" : "—"} · checked {fmtRelative(d.checkedAt)} · DNS is changed in Cloudflare, not here
          </div>
        </div>
      )}
    </Card>
  );
}

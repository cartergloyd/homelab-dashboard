import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, PageHead, StatusPill } from "../components/ui";
import { fmtRelative } from "../format";
import type { StatusPayload, TailscalePayload } from "../types";

export function Status() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["status"], queryFn: () => api.get<StatusPayload>("/status"), refetchInterval: 10_000 });
  const ts = useQuery({ queryKey: ["tailscale"], queryFn: () => api.get<TailscalePayload>("/tailscale"), refetchInterval: 30_000 });

  return (
    <>
      <PageHead
        title="Service status"
        sub={q.data ? `Checked ${fmtRelative(q.data.generatedAt)}` : "Loading…"}
        actions={
          <button
            className="btn"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["status"] });
              qc.invalidateQueries({ queryKey: ["tailscale"] });
            }}
          >
            <Icons.refresh width={14} height={14} /> Refresh
          </button>
        }
      />
      <ErrorNotice error={q.error} />

      <Card title="Services">
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>State</th>
              <th>Detail</th>
              <th className="num">Latency</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.services.map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 500 }}>
                  {s.href ? (
                    <a href={s.href} target="_blank" rel="noreferrer">
                      {s.name}
                    </a>
                  ) : (
                    s.name
                  )}
                </td>
                <td>
                  <StatusPill state={s.state} />
                </td>
                <td className="dim">{s.detail}</td>
                <td className="num dim">{s.latencyMs === null ? "–" : `${s.latencyMs} ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Tailscale devices" className="" actions={<span className="muted small">{ts.data?.magicDnsSuffix ?? ""}</span>}>
        <div style={{ marginTop: 0 }} />
        {ts.data && !ts.data.available && <div className="notice">{ts.data.error ?? "tailscale CLI not available on this host"}</div>}
        {ts.data?.available && (
          <table className="table">
            <thead>
              <tr>
                <th>Device</th>
                <th>OS</th>
                <th>Tailscale IP</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...(ts.data.self ? [ts.data.self] : []), ...ts.data.peers].map((p) => (
                <tr key={p.dnsName || p.hostName}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{p.hostName}</span>
                    {p.self && <span className="badge accent" style={{ marginLeft: 8 }}>this server</span>}
                    <div className="muted small">{p.dnsName.replace(/\.$/, "")}</div>
                  </td>
                  <td className="dim">{p.os}</td>
                  <td className="mono dim">{p.ips[0]}</td>
                  <td>
                    <StatusPill state={p.online ? "ok" : "unavailable"} label={p.online ? "Online" : p.lastSeen ? `Seen ${fmtRelative(p.lastSeen)}` : "Offline"} />
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

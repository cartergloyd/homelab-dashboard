import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, PageHead, StatusPill } from "../components/ui";
import { fmtBytes, fmtRelative, fmtUptime } from "../format";
import type { GeoInfo, VpnPath, VpnPayload, VpnServicePath } from "../types";

function place(g: GeoInfo | null | undefined): string {
  if (!g) return "–";
  return [g.city, g.region && g.region !== g.city ? g.region : null, g.country].filter(Boolean).join(", ") || g.ip;
}

function PathBadge({ path }: { path: VpnPath }) {
  switch (path) {
    case "bypass":
      return <StatusPill state="ok" label="Bypasses VPN" />;
    case "vpn":
      return <span className="badge accent">Through VPN</span>;
    case "isp":
      return <StatusPill state="down" label="Via ISP (VPN off)" />;
    case "local":
      return <span className="badge">Local only</span>;
    default:
      return <StatusPill state="unavailable" label="Unknown" />;
  }
}

const NEEDED_LABEL: Record<VpnServicePath["needed"], string> = { required: "Required", recommended: "Recommended", optional: "Optional", none: "Not needed" };

function rowProblem(s: VpnServicePath): string | null {
  if (s.path === "local" || s.path === "isp") return null;
  if (s.needed === "required" && s.path !== "bypass") return s.path === "unknown" ? "Needs a bypass — could not confirm one exists" : "Needs a bypass but traffic goes through the VPN";
  return null;
}

export function Vpn() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["vpn"], queryFn: () => api.get<VpnPayload>("/vpn"), refetchInterval: 30_000 });
  const refresh = useMutation({
    mutationFn: () => api.get<VpnPayload>("/vpn?refresh=1"),
    onSuccess: (data) => qc.setQueryData(["vpn"], data),
  });
  const d = q.data;
  const state = d?.state === "connected" ? "ok" : d?.state === "disconnected" ? "down" : "unavailable";
  const problems = (d?.services ?? []).filter((s) => rowProblem(s)).length;

  return (
    <>
      <PageHead
        title="VPN"
        sub={
          d ? (
            <>
              {d.provider ?? "No VPN client detected"}
              {d.protocol ? ` · ${d.protocol}` : ""}
              {d.iface ? (
                <>
                  {" · "}
                  <span className="mono">{d.iface}</span>
                </>
              ) : (
                ""
              )}
              {" · checked "}
              {fmtRelative(d.checkedAt)}
            </>
          ) : (
            "Checking…"
          )
        }
        actions={
          <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <Icons.refresh width={14} height={14} /> {refresh.isPending ? "Checking…" : "Re-check"}
          </button>
        }
      />
      <ErrorNotice error={q.error} />

      <div className="status-strip" style={{ justifyContent: "flex-start", marginBottom: 14, fontSize: 14 }}>
        <StatusPill state={state} label={d ? (d.state === "connected" ? "Connected" : d.state === "disconnected" ? "Disconnected" : "Unknown") : "Checking"} />
        {d?.exit && (
          <span>
            <span className="muted">Exit</span> {place(d.exit)}
          </span>
        )}
        {d?.endpoint?.geo && (
          <span>
            <span className="muted">Server</span> {place(d.endpoint.geo)}
          </span>
        )}
        {d?.handshakeAgoSec !== null && d?.handshakeAgoSec !== undefined && (
          <span>
            <span className="muted">Handshake</span> {d.handshakeAgoSec < 120 ? `${d.handshakeAgoSec} s ago` : `${Math.round(d.handshakeAgoSec / 60)} min ago`}
          </span>
        )}
        {d?.killSwitch !== null && d?.killSwitch !== undefined && <StatusPill state={d.killSwitch ? "ok" : "degraded"} label={d.killSwitch ? "Kill switch on" : "Kill switch off"} />}
        {problems > 0 && <StatusPill state="down" label={`${problems} exception${problems === 1 ? "" : "s"} missing`} />}
      </div>

      {!!d?.notes.length && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {d.notes.map((n, i) => (
            <div key={i}>• {n}</div>
          ))}
        </div>
      )}

      <div className="grid wide" style={{ marginBottom: 14 }}>
        <Card title="Where your traffic exits">
          {d?.state === "disconnected" && <div className="notice error" style={{ marginBottom: 10 }}>VPN is off — everything leaves through your home ISP.</div>}
          <dl className="kv">
            <dt>Public IP</dt>
            <dd className="mono">{d?.exit?.ip ?? (d?.state === "disconnected" ? d?.home?.ip : null) ?? "–"}</dd>
            <dt>Location</dt>
            <dd>{place(d?.exit ?? (d?.state === "disconnected" ? d?.home : null))}</dd>
            <dt>Network / ASN</dt>
            <dd>{d?.exit?.org ?? (d?.state === "disconnected" ? d?.home?.org : null) ?? "–"}</dd>
            {d?.exit?.hostname && (
              <>
                <dt>Hostname</dt>
                <dd className="mono small">{d.exit.hostname}</dd>
              </>
            )}
            {d?.home && d.state === "connected" && (
              <>
                <dt>Without VPN</dt>
                <dd>
                  <span className="mono">{d.home.ip}</span> · {place(d.home)} · <span className="dim">{d.home.org}</span>
                </dd>
              </>
            )}
          </dl>
        </Card>

        <Card title="VPN server (datacenter)">
          <dl className="kv">
            <dt>Provider</dt>
            <dd>{d?.provider ?? "–"}</dd>
            <dt>Protocol</dt>
            <dd>{d?.protocol ?? "–"}</dd>
            <dt>Endpoint</dt>
            <dd className="mono">{d?.endpoint ? `${d.endpoint.host}${d.endpoint.port ? `:${d.endpoint.port}` : ""}` : "–"}</dd>
            <dt>Datacenter</dt>
            <dd>
              {place(d?.endpoint?.geo)}
              {d?.endpoint?.geo?.org && <span className="dim"> · {d.endpoint.geo.org}</span>}
            </dd>
            <dt>Interface</dt>
            <dd className="mono">{d?.iface ?? "–"}</dd>
            <dt>Default route</dt>
            <dd className="mono">{d?.defaultRouteDev ?? "–"}</dd>
            <dt>Transfer</dt>
            <dd>{d?.transfer ? `↓ ${fmtBytes(d.transfer.rxBytes)} · ↑ ${fmtBytes(d.transfer.txBytes)}` : "–"}</dd>
            <dt>Connected</dt>
            <dd>{d?.connectedSince ? `for ${fmtUptime(d.connectedSince)}` : d?.handshakeAgoSec !== null && d?.handshakeAgoSec !== undefined ? `last handshake ${d.handshakeAgoSec} s ago` : "–"}</dd>
          </dl>
        </Card>

        <Card title="DNS">
          <dl className="kv">
            <dt>Resolvers</dt>
            <dd className="mono">{d?.dns.length ? d.dns.join(", ") : "–"}</dd>
          </dl>
          {d?.dnsNote && <p className="dim small" style={{ margin: "8px 0 0" }}>{d.dnsNote}</p>}
        </Card>
      </div>

      <Card
        title="What goes through the VPN and what doesn't"
        actions={<span className="muted small">{d ? `${d.services.filter((s) => s.path === "bypass").length} bypass · ${d.services.filter((s) => s.path === "vpn").length} through VPN` : ""}</span>}
      >
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Inbound services that people reach via your home IP must <em>bypass</em> the VPN, or their replies leave through the tunnel and connections hang. Anything reached over Tailscale only needs Tailscale itself to bypass.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Port</th>
              <th>Path</th>
              <th>Exception</th>
              <th>Why / evidence</th>
            </tr>
          </thead>
          <tbody>
            {d?.services.map((s) => {
              const problem = rowProblem(s);
              return (
                <tr key={s.name}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td className="mono dim nowrap">{s.port}</td>
                  <td>
                    <PathBadge path={s.path} />
                  </td>
                  <td>
                    <span className={`badge${s.needed === "required" ? " accent" : ""}`}>{NEEDED_LABEL[s.needed]}</span>
                  </td>
                  <td>
                    {problem && <div style={{ color: "var(--critical)", fontWeight: 500 }}>{problem}</div>}
                    <div className="small dim">{s.evidence}</div>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      {s.advice}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Diagnostics" className="" actions={<span className="muted small">raw output the detection is based on</span>}>
        <div style={{ marginTop: 0 }} />
        {d && Object.keys(d.diagnostics).length === 0 && <span className="muted">Nothing collected yet.</span>}
        <div className="stack" style={{ gap: 6 }}>
          {d &&
            Object.entries(d.diagnostics).map(([k, v]) => (
              <details key={k}>
                <summary className="small" style={{ cursor: "pointer", fontWeight: 500 }}>
                  {k}
                </summary>
                <pre className="code" style={{ marginTop: 6, maxHeight: 280, overflow: "auto" }}>
                  {v}
                </pre>
              </details>
            ))}
        </div>
        <p className="muted small" style={{ margin: "12px 0 0" }}>
          Detection is inferred from the VPN client, routing rules and firewall marks. Where something reads "Unknown", the server needs read access granted during install (see SERVER_SETUP.md, VPN section).
        </p>
      </Card>
    </>
  );
}

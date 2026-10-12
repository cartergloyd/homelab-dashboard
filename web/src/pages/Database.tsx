import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, PageHead, StatTile, StatusPill } from "../components/ui";
import { fmtBytes } from "../format";
import type { DatabasePayload } from "../types";

export function Database() {
  const q = useQuery({ queryKey: ["database"], queryFn: () => api.get<DatabasePayload>("/database"), refetchInterval: 15_000 });
  const d = q.data;

  return (
    <>
      <PageHead
        title="Database"
        sub="Directus is the UI for your personal PostgreSQL database. Postgres itself is bound to 127.0.0.1 on the server and is never exposed to the network."
        actions={
          <a className="btn primary" href={d?.directus.url} target="_blank" rel="noreferrer">
            <Icons.external width={14} height={14} /> Open Directus
          </a>
        }
      />
      <ErrorNotice error={q.error} />

      <div className="grid" style={{ marginBottom: 14 }}>
        <div className="card tile">
          <div className="tile-label">Directus</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={d?.directus.state ?? "unavailable"} label={d ? (d.directus.status ? `Health: ${d.directus.status}` : "Unreachable") : "Checking"} />
            {d?.directus.latencyMs !== null && d?.directus.latencyMs !== undefined && <span className="muted small">{d.directus.latencyMs} ms</span>}
          </div>
          <div className="tile-sub truncate">{d?.directus.error ?? d?.directus.url}</div>
        </div>
        <div className="card tile">
          <div className="tile-label">PostgreSQL</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={d ? (d.postgres.connected ? "ok" : d.postgres.error === "PG_URL not set" ? "unavailable" : "down") : "unavailable"} label={d ? (d.postgres.connected ? "Connected" : "Not connected") : "Checking"} />
          </div>
          <div className="tile-sub truncate">{d?.postgres.error ?? d?.postgres.version ?? ""}</div>
        </div>
        <StatTile label="Database size" value={d?.postgres.connected ? fmtBytes(d.postgres.sizeBytes) : "–"} />
        <StatTile label="Tables" value={d?.postgres.connected ? d.postgres.tables : "–"} sub="User + Directus system tables" />
      </div>

      <Card title="Largest tables">
        {!d?.postgres.topTables.length ? (
          <span className="muted">{d?.postgres.connected ? "No user tables yet — create a collection in Directus." : "Connect PostgreSQL (PG_URL) to see table statistics."}</span>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Table</th>
                <th className="num">Rows (est.)</th>
                <th className="num">Size</th>
              </tr>
            </thead>
            <tbody>
              {d.postgres.topTables.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="num">{t.rows.toLocaleString()}</td>
                  <td className="num">{fmtBytes(t.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Connecting from your own tools" className="" >
        <div className="dim small" style={{ lineHeight: 1.7 }}>
          <div>• Browse and edit data: Directus at <a href={d?.directus.url} target="_blank" rel="noreferrer">{d?.directus.url}</a> (reachable over Tailscale).</div>
          <div>• SQL clients / scripts: SSH over Tailscale to the server, then connect to <span className="mono">127.0.0.1:5432</span>, or use Directus's REST/GraphQL API.</div>
          <div>• Postgres is deliberately not published on the LAN or tailnet — keep it that way.</div>
        </div>
      </Card>
    </>
  );
}

// Database & apps: the Postgres core (loopback only), the owner's personal Directus
// over Tailscale, and one Directus per public app (fam, ai, …) published through the
// Cloudflare Tunnel — each with its own database, users and dumps. Read-only.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Icons } from "../components/icons";
import { Card, ErrorNotice, PageHead, StatTile, StatusPill, useToast } from "../components/ui";
import { fmtBytes, fmtDateTime, fmtRelative } from "../format";
import type { AppStatus, AppsPayload, DatabasePayload } from "../types";

function AppCard({ a }: { a: AppStatus }) {
  const host = a.publicUrl ? new URL(a.publicUrl).host : null;
  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8, margin: 0 }}>
          <Icons.database width={16} height={16} /> {a.name}
          <StatusPill state={a.state} />
        </h2>
      }
      actions={
        a.publicUrl ? (
          <a className="btn sm" href={`${a.publicUrl}/admin`} target="_blank" rel="noreferrer">
            <Icons.external width={13} height={13} /> Open admin
          </a>
        ) : undefined
      }
    >
      <div className="kv">
        <div>
          <span className="kv-k">Public URL</span>
          <span className="kv-v">
            {a.publicUrl ? (
              <a href={a.publicUrl} target="_blank" rel="noreferrer" className="mono">
                {host}
              </a>
            ) : (
              <span className="muted">none</span>
            )}
            {a.public.ok === true && <span className="muted small"> · HTTPS ok{a.public.latencyMs !== null ? ` · ${a.public.latencyMs} ms` : ""}</span>}
            {a.public.ok === false && <span className="small" style={{ color: "var(--critical)" }}> · not reachable through the tunnel</span>}
            {a.public.note && a.public.ok !== false && <span className="muted small"> · {a.public.note}</span>}
          </span>
        </div>
        <div>
          <span className="kv-k">Directus</span>
          <span className="kv-v">
            <StatusPill state={a.local.ok ? "ok" : a.container?.state === "running" ? "degraded" : "down"} label={a.local.ok ? `healthy · ${a.local.latencyMs} ms` : (a.local.error ?? "not healthy")} />
            <span className="muted small"> · {a.containerName}{a.container ? ` ${a.container.state}` : " (no container)"}</span>
          </span>
        </div>
        <div>
          <span className="kv-k">Database</span>
          <span className="kv-v">
            {a.database.exists ? (
              <>
                <span className="mono">{a.db}</span> · {fmtBytes(a.database.sizeBytes)} · {a.database.collections ?? 0} collection{a.database.collections === 1 ? "" : "s"}
                <span className="muted small"> ({a.database.tables ?? 0} tables incl. Directus)</span>
              </>
            ) : (
              <span style={{ color: "var(--critical)" }}>{a.database.error ?? "missing"}</span>
            )}
          </span>
        </div>
        <div>
          <span className="kv-k">Users</span>
          <span className="kv-v">{a.database.users === null ? <span className="muted">Directus not bootstrapped yet</span> : <>{a.database.users} · last login {a.database.lastLogin ? fmtRelative(a.database.lastLogin) : "never"}</>}</span>
        </div>
        <div>
          <span className="kv-k">Backup</span>
          <span className="kv-v">
            {a.backup.latest ? (
              <>
                <span title={fmtDateTime(a.backup.latest)} style={{ color: Date.now() - Date.parse(a.backup.latest) > 48 * 3_600_000 ? "var(--warning)" : undefined }}>
                  {fmtRelative(a.backup.latest)}
                </span>{" "}
                · {fmtBytes(a.backup.bytes)} · {a.backup.count} kept
              </>
            ) : (
              <span style={{ color: "var(--warning)" }}>no dumps yet — schedule scripts/pg-backup.sh</span>
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

export function Database() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["database"], queryFn: () => api.get<DatabasePayload>("/database"), refetchInterval: 15_000 });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.get<AppsPayload>("/apps"), refetchInterval: 15_000 });
  const refresh = useMutation({
    mutationFn: () => api.get<AppsPayload>("/apps?refresh=1"),
    onSuccess: (d) => {
      qc.setQueryData(["apps"], d);
      toast("Re-checked");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const d = q.data;
  const a = apps.data;
  const exposure = a?.postgres.exposure;

  return (
    <>
      <PageHead
        title="Database & apps"
        sub="One PostgreSQL, bound to 127.0.0.1 only. Your personal Directus over Tailscale, plus one Directus per public app — each with its own database, users and backups — published through the Cloudflare Tunnel without opening a router port."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <Icons.refresh width={14} height={14} /> Re-check
            </button>
            <a className="btn primary" href={d?.directus.url} target="_blank" rel="noreferrer">
              <Icons.external width={14} height={14} /> Personal Directus
            </a>
          </div>
        }
      />
      <ErrorNotice error={q.error} />
      <ErrorNotice error={apps.error} />

      <div className="grid" style={{ marginBottom: 14 }}>
        <div className="card tile">
          <div className="tile-label">PostgreSQL</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={d ? (d.postgres.connected ? "ok" : d.postgres.error === "PG_URL not set" ? "unavailable" : "down") : "unavailable"} label={d ? (d.postgres.connected ? "Connected" : "Not connected") : "Checking"} />
            {exposure && (
              <StatusPill state={exposure.loopbackOnly === true ? "ok" : exposure.loopbackOnly === false ? "down" : "unavailable"} label={exposure.loopbackOnly === true ? "127.0.0.1 only" : exposure.loopbackOnly === false ? `exposed on ${exposure.binds.join(", ")}` : "exposure unknown"} />
            )}
          </div>
          <div className="tile-sub truncate">{d?.postgres.error ?? d?.postgres.version ?? ""}</div>
        </div>
        <div className="card tile">
          <div className="tile-label">Cloudflare Tunnel</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={a ? (a.tunnel.ready ? "ok" : a.tunnel.ready === false ? "down" : "unavailable") : "unavailable"} label={a ? (a.tunnel.ready ? `Connected · ${a.tunnel.connections} link${a.tunnel.connections === 1 ? "" : "s"}` : (a.tunnel.error ?? "Not ready")) : "Checking"} />
          </div>
          <div className="tile-sub truncate">{a?.tunnel.hostnames.length ? a.tunnel.hostnames.join(" · ") : a ? "no public hostnames configured" : ""}</div>
        </div>
        <div className="card tile">
          <div className="tile-label">Personal Directus (Tailscale)</div>
          <div className="row" style={{ marginTop: 4 }}>
            <StatusPill state={d?.directus.state ?? "unavailable"} label={d ? (d.directus.status ? `Health: ${d.directus.status}` : "Unreachable") : "Checking"} />
            {d?.directus.latencyMs !== null && d?.directus.latencyMs !== undefined && <span className="muted small">{d.directus.latencyMs} ms</span>}
          </div>
          <div className="tile-sub truncate">{d?.directus.error ?? d?.directus.url}</div>
        </div>
        <StatTile label="Databases" value={a ? a.postgres.databases.length : "–"} sub={a ? `${a.apps.length} app${a.apps.length === 1 ? "" : "s"} · ${fmtBytes(a.postgres.databases.reduce((s, x) => s + x.sizeBytes, 0))} total` : ""} />
      </div>

      {a && a.apps.length === 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          No apps configured yet. Set <span className="mono">APPS=fam,ai</span> and <span className="mono">PUBLIC_DOMAIN</span> in the dashboard env (SERVER_SETUP § 5) once the compose stack is up.
        </div>
      )}
      <div className="grid wide" style={{ marginBottom: 14 }}>
        {(a?.apps ?? []).map((x) => (
          <AppCard key={x.name} a={x} />
        ))}
      </div>

      <div className="grid wide" style={{ marginBottom: 14 }}>
        <Card title="Databases on this PostgreSQL">
          {!a?.postgres.databases.length ? (
            <span className="muted">{a?.postgres.error ?? "Connect PostgreSQL (PG_URL) to list databases."}</span>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Owner role</th>
                  <th>Used by</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {a.postgres.databases.map((r) => (
                  <tr key={r.name}>
                    <td className="mono">{r.name}</td>
                    <td className="mono">{r.owner}</td>
                    <td>{r.app ? <span className="badge accent">{r.app}</span> : r.name === "postgres" ? <span className="muted small">system</span> : <span className="badge">personal · Tailscale</span>}</td>
                    <td className="num">{fmtBytes(r.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small" style={{ margin: "10px 0 0" }}>
            Each app owns its database through its own role, so one app's Directus cannot read another's tables. Dumps land in <span className="mono">{a?.backupDir ?? "PG_BACKUP_DIR"}</span>.
          </p>
        </Card>

        <Card title="Largest tables (personal database)">
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
      </div>

      <Card title="Adding an app or connecting from code">
        <div className="dim small" style={{ lineHeight: 1.8 }}>
          <div>
            • New app: on the server run <span className="mono">scripts/add-app.sh &lt;name&gt;</span> — it creates the database and role and prints the compose block, the env lines, the Cloudflare hostname and the dashboard env to paste (SERVER_SETUP § 5).
          </div>
          <div>
            • From an app: use the Directus SDK or plain REST/GraphQL against <span className="mono">https://&lt;app&gt;.{a?.domain ?? "your-domain"}</span>; create roles and policies in that app's admin so each user only sees their data.
          </div>
          <div>• SQL clients: SSH over Tailscale, then <span className="mono">127.0.0.1:5432</span>. PostgreSQL is deliberately never published on the LAN, the tailnet or the internet.</div>
          <div>• Personal data stays on the Tailscale-only Directus; apps never share a database with it.</div>
        </div>
      </Card>
    </>
  );
}

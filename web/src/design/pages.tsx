import { useState } from "react";
import { Link } from "react-router-dom";
import { useAppConfig } from "../App";
import { Security } from "../pages/Security";
import { JobEditor } from "../pages/Maintenance";
import {
  Button,
  Details,
  Empty,
  Head,
  Icon,
  Issue,
  Panel,
  Status,
  Table,
} from "./ui";
import {
  useRead,
  useActions,
  type Host,
  type Workspace,
  basePath,
  workspaceName,
} from "./data";
import {
  Activity,
  AssistantDialog,
  DriveCards,
  Drawer,
  MetricCards,
  ReportsDialog,
} from "./shared";
import { RepositoryHub } from "./repositories";
import { fmtBytes, fmtDateTime, fmtRelative, describeCron } from "../format";
import type {
  AgentPresence,
  AppsPayload,
  AppStatus,
  DatabasePayload,
  HostnamesPayload,
  JobView,
  JobRun,
  JellyfinPayload,
  MinecraftPayload,
  OverviewPayload,
  ScriptsPayload,
  StatusPayload,
  TailscalePayload,
  VpnPayload,
} from "../types";

export function Performance() {
  const [range, setRange] = useState("24h"),
    q = useRead<Host>("host", `/host?range=${range}`, 15000),
    d = q.data;
  function series(kind: "cpu" | "memory") {
    const cutoff = Date.now() - (range === "7d" ? 7 : 1) * 86400000;
    const points =
      d?.history
        .filter((s) => kind === "memory" || s.cpu != null)
        .map(
          (s) =>
            `${Math.max(0, Math.min(600, ((Date.parse(s.at) - cutoff) / (Date.now() - cutoff)) * 600))},${104 - (kind === "cpu" ? s.cpu! : (s.memoryUsed / s.memoryTotal) * 100)}`,
        ) ?? [];
    return points.length > 1 ? (
      <polyline
        points={points.join(" ")}
        stroke={kind === "cpu" ? "#7e9f7b" : "#bac8b7"}
        strokeWidth={kind === "cpu" ? 2 : 1.7}
        fill="none"
      />
    ) : null;
  }
  return (
    <Panel
      title="CPU & memory"
      sub="Resource usage"
      actions={
        <select
          className="activity-filter"
          aria-label="Chart period"
          value={range}
          onChange={(e) => setRange(e.target.value)}
        >
          <option>24h</option>
          <option>7d</option>
        </select>
      }
    >
      <Issue error={q.error} />
      <div className="metrics">
        <div>
          <div className="metric-label">
            <span className="legend" />
            CPU usage
          </div>
          <div className="metric-value">
            {d?.cpu == null ? "—" : d.cpu.toFixed(1)}
            <small>%</small>
          </div>
        </div>
        <div>
          <div className="metric-label">
            <span className="legend light" />
            Memory
          </div>
          <div className="metric-value">
            {d ? fmtBytes(d.memoryUsed) : "—"}
            <small>/ {d ? fmtBytes(d.memoryTotal) : "—"}</small>
          </div>
        </div>
      </div>
      <div
        className="chart"
        role="img"
        aria-label="Actual recorded CPU and memory usage"
      >
        <div className="chart-y">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg viewBox="0 0 600 110" preserveAspectRatio="none">
          <path
            d="M0 6H600M0 51H600M0 104H600"
            stroke="var(--line)"
            strokeWidth="1"
            strokeDasharray="3 4"
            fill="none"
          />
          {series("memory")}
          {series("cpu")}
        </svg>
        <div className="chart-x">
          <span>{range === "24h" ? "24 hours ago" : "7 days ago"}</span>
          <span>Now</span>
        </div>
      </div>
      <div className="panel-bottom">
        <span>
          {d
            ? `${d.hostname} · ${d.cpuCount} CPU cores · ${fmtBytes(d.memoryTotal)} RAM`
            : "Reading host"}
        </span>
        <span>{d?.history.length ?? 0} actual samples</span>
      </div>
    </Panel>
  );
}
export function OverviewDesign({ workspace }: { workspace: Workspace }) {
  const q = useRead<OverviewPayload>("overview", "/overview", 15000),
    mc = useRead<MinecraftPayload>("minecraft", "/minecraft"),
    jf = useRead<JellyfinPayload>("jellyfin", "/jellyfin"),
    db = useRead<DatabasePayload>("database", "/database"),
    apps = useRead<AppsPayload>("apps", "/apps"),
    jobs = useRead<JobView[]>("jobs", "/jobs"),
    [reports, setReports] = useState(false),
    [database, setDatabase] = useState(false);
  const d = q.data,
    base = basePath(workspace),
    business = workspace === "business",
    issues = d?.status.services.filter((s) => s.state !== "ok") ?? [],
    next =
      jobs.data
        ?.filter((j) => j.enabled && j.nextRun)
        .sort((a, b) => Date.parse(a.nextRun!) - Date.parse(b.nextRun!))
        .slice(0, 3) ?? [];
  const personal = [
    {
      name: "Minecraft",
      icon: "cube" as const,
      color: "mint",
      state: mc.data?.ping ? "ok" : "unknown",
      label: mc.data?.ping ? "Online" : "Checking",
      value: d?.minecraft.players
        ? `${d.minecraft.players.online} / ${d.minecraft.players.max}`
        : "—",
      sub: "players online",
      fact: mc.data?.ping?.version ?? "Minecraft server",
      to: "/minecraft",
    },
    {
      name: "Jellyfin",
      icon: "film" as const,
      color: "peach",
      state: jf.data?.reachable ? "ok" : "unknown",
      label: jf.data?.reachable ? "Online" : "Checking",
      value: d?.jellyfin.playing ?? "—",
      sub: "active streams",
      fact: jf.data?.counts
        ? `${jf.data.counts.Movies} movies · ${jf.data.counts.Series} series`
        : "Reading library",
      to: "/jellyfin",
    },
    {
      name: "Directus",
      icon: "database" as const,
      color: "purple",
      state: db.data?.directus.state ?? "unknown",
      label: db.data?.directus.state === "ok" ? "Online" : "Checking",
      value: db.data?.postgres.tables ?? "—",
      sub: "database tables",
      fact: "Personal data & files",
      to: "/files",
    },
    {
      name: "PostgreSQL",
      icon: "database" as const,
      color: "blue",
      state: db.data?.postgres.connected ? "ok" : "unknown",
      label: db.data?.postgres.connected ? "Online" : "Checking",
      value: fmtBytes(db.data?.postgres.sizeBytes),
      sub: "personal database",
      fact: db.data?.postgres.connected
        ? "Database connected"
        : "Checking connection",
      to: "/files",
    },
  ];
  return (
    <>
      <Head
        title="Overview"
        actions={
          <Button icon="file" onClick={() => setReports(true)}>
            Reports
          </Button>
        }
      />
      <Issue error={q.error} />
      {!business && issues.length > 0 && (
        <div className="attention">
          <span className="icon-wrap">
            <Icon name="pulse" />
          </span>
          <div>
            <strong>{issues.length} services need attention</strong>
            <p>{issues.map((s) => `${s.name}: ${s.state}`).join(" · ")}</p>
          </div>
          <Link to="/network">
            View status <Icon name="external" />
          </Link>
        </div>
      )}
      <div className="section-label">
        <h2>{business ? "Business services" : "Applications"}</h2>
        <span className="muted">
          {business ? "xGold AI" : "Personal applications"}
        </span>
      </div>
      <div className="service-summary-grid">
        {business
          ? apps.data?.apps
              .filter((a) => ["crm", "ai"].includes(a.name))
              .map((a) => (
                <Link
                  key={a.name}
                  className="service-summary"
                  to={a.kind === "twenty" ? "/business/crm" : "/business/ai"}
                >
                  <div className="service-summary-top">
                    <span
                      className={`app-icon ${a.kind === "twenty" ? "purple" : "teal"}`}
                    >
                      <Icon name={a.kind === "twenty" ? "user" : "spark"} />
                    </span>
                    <Status
                      label={a.state === "ok" ? "Online" : a.state}
                      state={a.state}
                    />
                  </div>
                  <h3>{a.kind === "twenty" ? "Twenty CRM" : "AI workspace"}</h3>
                  <p className="inline-note">
                    {a.kind === "twenty"
                      ? "Contacts, clients, and business follow-ups."
                      : "AI projects, content and connected applications."}
                  </p>
                  <div className="service-summary-foot">
                    <span>
                      {a.database.exists
                        ? fmtBytes(a.database.sizeBytes) + " database"
                        : "Database unavailable"}
                    </span>
                    <Icon name="external" />
                  </div>
                </Link>
              ))
          : personal.map((a) => (
              <Link key={a.name} className="service-summary" to={a.to}>
                <div className="service-summary-top">
                  <span className={`app-icon ${a.color}`}>
                    <Icon name={a.icon} />
                  </span>
                  <Status label={a.label} state={a.state} />
                </div>
                <h3>{a.name}</h3>
                <div className="summary-value">
                  <b>{a.value}</b>
                  <span>{a.sub}</span>
                </div>
                <div className="service-summary-foot">
                  <span>{a.fact}</span>
                  <Icon name="external" />
                </div>
              </Link>
            ))}
      </div>
      {business ? (
        <div className="two-cols">
          <Panel
            title="Business storage"
            actions={
              <Link className="text-link" to="/business/files">
                Files & storage <Icon name="external" />
              </Link>
            }
          >
            <div className="panel-body">
              <p className="inline-note">Shared host storage</p>
              <DriveCards compact />
            </div>
          </Panel>
          <Panel title="Workspace actions">
            <div className="panel-body file-grid">
              <Link className="button" to="/business/terminal">
                <Icon name="terminal" />
                Open terminal
              </Link>
              <Link className="button" to="/business/automation">
                <Icon name="refresh" />
                View update hub
              </Link>
            </div>
          </Panel>
        </div>
      ) : (
        <>
          <div className="overview-middle">
            <Performance />
            <Panel
              title="Drive storage"
              sub="All detected SSD & HDD drives"
              className="storage-panel"
              actions={
                <Link className="text-link" to="/files">
                  Details <Icon name="external" />
                </Link>
              }
            >
              <div className="panel-body">
                <DriveCards compact />
              </div>
              <Link className="panel-bottom" to="/files">
                <span>Explore drives & files</span>
                <Icon name="external" />
              </Link>
            </Panel>
          </div>
          <div className="overview-lower">
            <Panel
              title="Recent activity"
              actions={
                <Link className="text-link" to="/automation#activity">
                  View all <Icon name="external" />
                </Link>
              }
            >
              <Activity compact limit={4} />
            </Panel>
            <Panel
              title="Scheduled jobs"
              sub="Next runs"
              actions={
                <Link className="text-link" to="/automation">
                  Manage <Icon name="external" />
                </Link>
              }
            >
              <Issue error={jobs.error} />
              <div
                className="panel-body"
                style={{ paddingTop: 6, paddingBottom: 5 }}
              >
                {next.map((j) => (
                  <Link
                    key={j.id}
                    className="job-mini"
                    style={{ width: "100%", textAlign: "left" }}
                    to="/automation"
                  >
                    <span className="job-mini-icon">
                      <Icon name="clock" />
                    </span>
                    <span className="job-mini-text">
                      <strong>{j.name}</strong>
                      <small>{describeCron(j.cron)}</small>
                    </span>
                    <span>{fmtRelative(j.nextRun)}</span>
                  </Link>
                ))}
                {!next.length && <Empty>No upcoming jobs.</Empty>}
              </div>
            </Panel>
          </div>
        </>
      )}
      {reports && (
        <ReportsDialog kind="all" onClose={() => setReports(false)} />
      )}
    </>
  );
}

export function NetworkDesign() {
  const hosts = useRead<HostnamesPayload>("hostnames", "/hostnames", 60000),
    apps = useRead<AppsPayload>("apps", "/apps"),
    ts = useRead<TailscalePayload>("tailscale", "/tailscale"),
    vpn = useRead<VpnPayload>("vpn", "/vpn"),
    services = useRead<StatusPayload>("status", "/status"),
    config = useAppConfig(),
    [selected, setSelected] = useState<HostnamesPayload["rows"][number] | null>(
      null,
    ),
    [details, setDetails] = useState<"vpn" | "tailscale" | "services" | null>(
      null,
    ),
    a = apps.data?.tunnel,
    t = ts.data,
    v = vpn.data;
  return (
    <>
      <Head
        title="Network"
        actions={
          <Button icon="pulse" onClick={() => setDetails("services")}>
            Service status
          </Button>
        }
      />
      <MetricCards
        items={[
          [
            "Published hostnames",
            hosts.data?.rows.length ?? "—",
            "Configured domain records",
          ],
          [
            "Tunnel connections",
            a?.connections ?? "—",
            a?.ready
              ? "Cloudflare · connected"
              : (a?.error ?? "Checking tunnel"),
          ],
          [
            "Private network",
            t?.available ? t.peers.filter((p) => p.online).length : "—",
            t?.available ? "Tailscale peers online" : "Tailscale unavailable",
          ],
        ]}
      />
      <div className="section-stack">
        <Panel title="Hostnames">
          <Issue error={hosts.error} />
          <Table headers={["Hostname", "Destination", "Status", "Access", ""]}>
            {hosts.data?.rows.map((h) => (
              <tr key={h.host}>
                <td>
                  <span className="table-name">
                    <Icon name="external" />
                    {h.host}
                  </span>
                </td>
                <td className="muted">{h.target ?? h.role}</td>
                <td>
                  <Status
                    label={h.probe.ok === null && h.resolved.length > 0 ? "Unverified" : h.state === "ok" ? "Answering" : h.state}
                    state={h.state}
                  />
                </td>
                <td>
                  <span className="tag">
                    {h.probe.httpStatus === 302 ||
                    h.probe.httpStatus === 401 ||
                    h.probe.httpStatus === 403
                      ? "Protected endpoint"
                      : h.proxied
                        ? "Cloudflare proxy"
                        : h.role === "game"
                          ? "Minecraft login"
                          : "See details"}
                  </span>
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`View ${h.host}`}
                    onClick={() => setSelected(h)}
                  >
                    <Icon name="external" />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          {hosts.data?.rows.length === 0 && (
            <Empty>No hostnames configured.</Empty>
          )}
        </Panel>
        <Panel
          title="Homelab tunnel"
          sub="Cloudflare Tunnel"
          actions={
            <Status
              label={
                a?.ready
                  ? "Connected"
                  : a?.ready === false
                    ? "Not ready"
                    : "Checking"
              }
              state={a?.ready ? "ok" : "unknown"}
            />
          }
        >
          <Issue error={apps.error} />
          <div className="panel-body">
            <Details
              items={[
                ["Connections", a?.connections ?? "Unavailable"],
                ["Container", a?.container?.state ?? "Unavailable"],
                [
                  "Published applications",
                  a?.hostnames.length ?? "Unavailable",
                ],
                [
                  "Last checked",
                  apps.data ? fmtRelative(apps.data.checkedAt) : "Checking",
                ],
              ]}
            />
            {a?.error && <p className="inline-note">{a.error}</p>}
          </div>
        </Panel>
        <div className="two-cols">
          <Panel
            title="VPN connection"
            sub="Download traffic"
            actions={
              <Status
                label={v?.state ?? "Checking"}
                state={
                  v?.state === "connected"
                    ? "ok"
                    : v?.state === "disconnected"
                      ? "warn"
                      : "unknown"
                }
              />
            }
          >
            <div className="panel-body">
              <Issue error={vpn.error} />
              <Details
                items={[
                  ["Protocol", v?.protocol ?? "Not connected"],
                  [
                    "Current exit",
                    v?.exit
                      ? [v.exit.city, v.exit.country].filter(Boolean).join(", ")
                      : "Unavailable",
                  ],
                  [
                    "Protected service",
                    v?.services.find((s) =>
                      s.name.toLowerCase().includes("torrent"),
                    )?.path ?? "Not verified",
                  ],
                  [
                    "Last handshake",
                    v?.handshakeAgoSec != null
                      ? `${v.handshakeAgoSec} seconds ago`
                      : "Unavailable",
                  ],
                ]}
              />
              <Button icon="shield" onClick={() => setDetails("vpn")}>
                Routing details
              </Button>
            </div>
          </Panel>
          <Panel
            title="Tailscale"
            sub="Private network"
            actions={
              <Status
                label={t?.available ? "Connected" : "Unavailable"}
                state={t?.available ? "ok" : "unknown"}
              />
            }
          >
            <div className="panel-body">
              <Issue error={ts.error} />
              <Details
                items={[
                  [
                    "Devices online",
                    t?.available
                      ? `${t.peers.filter((p) => p.online).length} of ${t.peers.length}`
                      : "Unavailable",
                  ],
                  ["Server address", t?.self?.ips[0] ?? "Unavailable"],
                  ["Private hostname", t?.self?.dnsName ?? "Unavailable"],
                ]}
              />
              <Button icon="pulse" onClick={() => setDetails("tailscale")}>
                Device details
              </Button>
            </div>
          </Panel>
        </div>
        <Panel title="Router" sub="Router administration">
          <div className="panel-body router-row">
            <span className="app-icon">
              <Icon name="pulse" />
            </span>
            <div>
              <strong>Router settings</strong>
              <p className="inline-note">
                {config.data?.links.router ?? "Router address not configured."}
              </p>
            </div>
            {config.data?.links.router && (
              <a
                className="button primary"
                href={config.data.links.router}
                target="_blank"
                rel="noreferrer"
              >
                Open router <Icon name="external" />
              </a>
            )}
          </div>
        </Panel>
      </div>
      {selected && (
        <Drawer title={selected.host} onClose={() => setSelected(null)}>
          <Details
            items={[
              ["Destination", selected.target ?? "Unknown"],
              ["Records", selected.records.join(", ") || "None"],
              ["Resolved addresses", selected.resolved.join(", ") || "None"],
              ["Probe", selected.probe.detail],
              ["HTTP status", selected.probe.httpStatus ?? "Not HTTP"],
              [
                "Proxy",
                selected.proxied === null
                  ? "Unknown"
                  : selected.proxied
                    ? "Cloudflare"
                    : "Direct",
              ],
            ]}
          />
          {selected.probe.cert && (
            <Details
              items={[
                ["Certificate issuer", selected.probe.cert.issuer],
                ["Expires", fmtDateTime(selected.probe.cert.expiresAt)],
              ]}
            />
          )}
        </Drawer>
      )}
      {details && (
        <Drawer
          title={
            details === "vpn"
              ? "VPN routing"
              : details === "tailscale"
                ? "Tailscale devices"
                : "Service status"
          }
          onClose={() => setDetails(null)}
        >
          {details === "vpn" ? (
            <>
              <p className="inline-note">{v?.notes.join(" ")}</p>
              <Table headers={["Service", "Path", "Evidence"]}>
                {v?.services.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.path}</td>
                    <td>
                      {s.evidence}
                      <small>{s.advice}</small>
                    </td>
                  </tr>
                ))}
              </Table>
              <Details
                items={[
                  [
                    "Kill switch",
                    v?.killSwitch == null
                      ? "Unknown"
                      : v.killSwitch
                        ? "Enabled"
                        : "Disabled",
                  ],
                  ["DNS", v?.dns.join(", ") || "Unavailable"],
                  ["Default route", v?.defaultRouteDev ?? "Unavailable"],
                ]}
              />
            </>
          ) : details === "tailscale" ? (
            <>
              <p className="inline-note">{t?.error}</p>
              <Table headers={["Device", "OS", "Address", "Status"]}>
                {[...(t?.self ? [t.self] : []), ...(t?.peers ?? [])].map(
                  (p) => (
                    <tr key={p.dnsName || p.hostName}>
                      <td>{p.hostName}</td>
                      <td>{p.os}</td>
                      <td>{p.ips.join(", ")}</td>
                      <td>
                        {p.online
                          ? "Online"
                          : p.lastSeen
                            ? fmtRelative(p.lastSeen)
                            : "Offline"}
                      </td>
                    </tr>
                  ),
                )}
              </Table>
            </>
          ) : (
            <Table headers={["Service", "State", "Details", "Latency"]}>
              {services.data?.services.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <Status label={s.state} state={s.state} />
                  </td>
                  <td>{s.detail}</td>
                  <td>{s.latencyMs == null ? "—" : `${s.latencyMs} ms`}</td>
                </tr>
              ))}
            </Table>
          )}
        </Drawer>
      )}
    </>
  );
}

export function AutomationDesign({ workspace }: { workspace: Workspace }) {
  const jobs = useRead<JobView[]>("jobs", "/jobs", 5000),
    runs = useRead<JobRun[]>("job-runs", "/jobs/runs?limit=200", 5000),
    scripts = useRead<ScriptsPayload>("scripts", "/scripts", 5000),
    config = useAppConfig(),
    action = useActions(),
    [editing, setEditing] = useState<JobView | "new" | null>(null),
    [selected, setSelected] = useState<JobView | null>(null);
  const next = jobs.data
    ?.filter((j) => j.enabled && j.nextRun)
    .sort((a, b) => Date.parse(a.nextRun!) - Date.parse(b.nextRun!))[0];
  const day = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: config.data?.timezone ?? "UTC",
      }).format(new Date(iso)),
    today = day(new Date().toISOString()),
    successes = runs.data?.filter(
      (r) => r.ok === true && day(r.startedAt) === today,
    ).length;
  return (
    <>
      <Head
        title="Automation"
        actions={
          <Button icon="plus" primary onClick={() => setEditing("new")}>
            New automation
          </Button>
        }
      />
      <MetricCards
        items={[
          [
            "Scheduled jobs",
            jobs.data?.filter((j) => j.enabled).length ?? "—",
            "Enabled",
          ],
          ["Successful runs today", successes ?? "—", "Recorded job history"],
          [
            "Next up",
            <span style={{ fontSize: 23 }}>
              {next?.name ?? "None scheduled"}
            </span>,
            next?.nextRun ? fmtRelative(next.nextRun) : "No upcoming job",
          ],
        ]}
      />
      <div className="section-stack">
        <Panel title="Scheduled jobs">
          <Issue error={jobs.error} />
          <Table
            headers={["Automation", "Schedule", "Last run", "Enabled", ""]}
          >
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <td>
                  <button className="table-name" onClick={() => setSelected(j)}>
                    <Icon name="clock" />
                    <span>
                      {j.name}
                      <small>
                        {j.type === "external"
                          ? `Managed by ${j.options.managedBy ?? "external scheduler"}`
                          : j.type}
                      </small>
                    </span>
                  </button>
                </td>
                <td className="muted">
                  {describeCron(j.cron)}
                  <small>
                    {j.cron} · {config.data?.timezone}
                  </small>
                </td>
                <td>
                  {j.lastRun ? fmtRelative(j.lastRun.startedAt) : "Never"}
                  <small>
                    {j.lastRun
                      ? j.lastRun.ok === null
                        ? "Running"
                        : j.lastRun.ok
                          ? "Completed successfully"
                          : "Failed"
                      : "No recorded run"}
                  </small>
                </td>
                <td>
                  <button
                    role="switch"
                    aria-checked={j.enabled}
                    aria-label={`Enable ${j.name}`}
                    className={`switch ${j.enabled ? "" : "off"}`}
                    disabled={action.pending}
                    onClick={() =>
                      action.perform(
                        `/jobs/${j.id}`,
                        { enabled: !j.enabled },
                        {
                          method: "put",
                          title: `${j.enabled ? "Disable" : "Enable"} ${j.name}?`,
                          description:
                            j.type === "external"
                              ? "This changes dashboard tracking only. The external cron or systemd timer continues running."
                              : undefined,
                          refresh: ["jobs"],
                          success: "Job updated",
                        },
                      )
                    }
                  />
                </td>
                <td>
                  {j.type === "external" ? (
                    <Button icon="external" onClick={() => setSelected(j)}>
                      Details
                    </Button>
                  ) : (
                    <Button
                      icon="play"
                      disabled={j.running || action.pending}
                      onClick={() =>
                        action.perform(`/jobs/${j.id}/run`, undefined, {
                          title: `Run ${j.name}?`,
                          refresh: ["jobs", "job-runs"],
                          success: "Job started",
                        })
                      }
                    >
                      Run now
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          {jobs.data?.length === 0 && <Empty>No scheduled jobs.</Empty>}
        </Panel>
        <RepositoryHub workspace={workspace} />
        <Panel title="Maintenance scripts" sub="Reusable jobs for your server">
          <Issue error={scripts.error} />
          <Table headers={["Script", "Location", "Last result", ""]}>
            {scripts.data?.scripts.map((s) => (
              <tr key={`${s.dir}/${s.name}`}>
                <td>
                  <span className="table-name">
                    <Icon name="terminal" />
                    {s.name}
                  </span>
                </td>
                <td className="muted">{s.dir}</td>
                <td>
                  <Status
                    label={
                      s.running
                        ? "Running"
                        : !s.lastRun
                          ? "Not run"
                          : s.lastRun.exitCode === 0
                            ? "Completed"
                            : `Exit ${s.lastRun.exitCode ?? "unknown"}`
                    }
                    state={
                      s.running
                        ? "warn"
                        : s.lastRun?.exitCode === 0
                          ? "ok"
                          : "unknown"
                    }
                  />
                </td>
                <td>
                  <Button
                    icon="play"
                    disabled={s.running || action.pending}
                    onClick={() =>
                      action.perform(
                        `/scripts/${encodeURIComponent(s.name)}/run`,
                        undefined,
                        {
                          title: `Run ${s.name}?`,
                          description: s.dir,
                          success: "Script started; output appears in Activity",
                          refresh: ["scripts"],
                        },
                      )
                    }
                  >
                    Run script
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
          {scripts.data?.scripts.length === 0 && (
            <Empty>No scripts found in the configured folders.</Empty>
          )}
          {scripts.data?.dirs
            .filter((d) => !d.exists)
            .map((d) => (
              <Issue
                key={d.path}
                error={new Error(`Script folder unavailable: ${d.path}`)}
              />
            ))}
        </Panel>
        <div id="activity">
          <Panel title="Activity">
            <Activity />
          </Panel>
        </div>
      </div>
      {editing && (
        <JobEditor
          job={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {selected && (
        <Drawer title={selected.name} onClose={() => setSelected(null)}>
          <Details
            items={[
              ["Type", selected.type],
              ["Schedule", `${selected.cron} · ${config.data?.timezone}`],
              [
                "Next run",
                selected.enabled ? fmtRelative(selected.nextRun) : "Disabled",
              ],
              ["Last run", selected.lastRun?.message ?? "No recorded run"],
              ["Output tracking", selected.outputTracking ?? "Not applicable"],
            ]}
          />
          <div className="file-grid section-gap">
            <Button
              icon="file"
              onClick={() => {
                setEditing(selected);
                setSelected(null);
              }}
            >
              Edit automation
            </Button>
            <Button
              icon="trash"
              className="danger"
              disabled={action.pending}
              onClick={async () => {
                const r = await action.perform(
                  `/jobs/${selected.id}`,
                  undefined,
                  {
                    method: "delete",
                    title: `Delete ${selected.name}?`,
                    danger: true,
                    refresh: ["jobs"],
                    success: "Job deleted",
                  },
                );
                if (r) setSelected(null);
              }}
            >
              Delete
            </Button>
          </div>
          <h3 className="section-gap">Run history</h3>
          <Table headers={["Started", "Result", "Message"]}>
            {runs.data
              ?.filter((r) => r.jobId === selected.id)
              .map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.startedAt)}</td>
                  <td>
                    {r.ok == null ? "Running" : r.ok ? "Completed" : "Failed"}
                  </td>
                  <td>{r.message}</td>
                </tr>
              ))}
          </Table>
        </Drawer>
      )}
    </>
  );
}
export function TerminalDesign({ workspace }: { workspace: Workspace }) {
  const host = useRead<Host>("host", "/host", 15000),
    config = useAppConfig(),
    agents = useRead<AgentPresence[]>("agents", "/agents", 10000),
    action = useActions(),
    [command, setCommand] = useState(""),
    [cwd, setCwd] = useState(""),
    [settings, setSettings] = useState(false),
    [assistant, setAssistant] = useState(false),
    [history, setHistory] = useState<
      {
        command: string;
        stdout: string;
        stderr: string;
        code: number;
        timedOut: boolean;
        truncated: boolean;
      }[]
    >([]);
  const d = host.data;
  async function send() {
    const text = command.trim();
    if (!text) return;
    const r = await action.perform<{
      stdout: string;
      stderr: string;
      code: number;
      timedOut: boolean;
      truncated: boolean;
    }>(
      "/terminal/execute",
      { command: text, cwd: cwd || d?.cwd || "" },
      {
        title: "Run this command on the server?",
        description: `${d?.username}@${d?.hostname} in ${cwd || d?.cwd}: ${text}`,
      },
    );
    if (r) {
      setHistory((h) => [...h, { command: text, ...r }].slice(-30));
      setCommand("");
    }
  }
  return (
    <>
      <Head
        title="Terminal"
        actions={
          <Button icon="terminal" onClick={() => setSettings(true)}>
            Session settings
          </Button>
        }
      />
      <Issue error={host.error} />
      <section className="terminal-panel">
        <div className="terminal-top">
          <span>{workspaceName(workspace)}</span>
          <span>
            {d
              ? `${d.username}@${d.hostname}:${cwd || d.cwd}`
              : "Connecting to host…"}
          </span>
          <span>{d ? "Connected · bash" : "Host unavailable"}</span>
        </div>
        <div className="terminal-output" id="terminal-output" role="log">
          {history.length === 0 && <p>No commands run in this session.</p>}
          {history.map((entry, i) => (
            <div key={i}>
              <p className="command">$ {entry.command}</p>
              <pre>{entry.stdout}</pre>
              {entry.stderr && <pre className="error">{entry.stderr}</pre>}
              <p>
                Exit {entry.code}
                {entry.timedOut ? " · timed out" : ""}
                {entry.truncated ? " · output truncated" : ""}
              </p>
            </div>
          ))}
          {action.pending && <p>Running on the host…</p>}
        </div>
        <form
          id="terminal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="terminal-command">$</label>
          <input
            id="terminal-command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Terminal command"
            placeholder="Command"
            disabled={action.pending || !d}
          />
          <button
            type="submit"
            disabled={!command.trim() || action.pending || !d}
          >
            Run ↵
          </button>
        </form>
      </section>
      <Panel title="Sessions" className="section-gap">
        <Table headers={["Identity", "Workspace", "Host", "Session"]}>
          <tr>
            <td>{config.data?.user.name ?? "Owner"}</td>
            <td>{workspaceName(workspace)}</td>
            <td>{d?.hostname ?? "Checking"}</td>
            <td>
              <button className="text-link" onClick={() => setSettings(true)}>
                Host command session <Icon name="external" />
              </button>
            </td>
          </tr>
          {agents.data
            ?.filter((a) => Date.now() - Date.parse(a.lastSeen) < 120000)
            .slice(0, 5)
            .map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td>Shared host</td>
                <td>{d?.hostname ?? "Checking"}</td>
                <td>
                  <button
                    className="text-link"
                    onClick={() => setAssistant(true)}
                  >
                    Last seen {fmtRelative(a.lastSeen)}
                  </button>
                </td>
              </tr>
            ))}
        </Table>
        <div className="panel-body">
          <p className="inline-note">
            Each command uses a fresh shell in the selected directory, with a 30
            second limit. Use SSH for interactive programs.
          </p>
        </div>
      </Panel>
      {settings && (
        <Drawer title="Terminal session" onClose={() => setSettings(false)}>
          <label className="field">
            Working directory
            <input
              value={cwd || d?.cwd || ""}
              onChange={(e) => setCwd(e.target.value)}
            />
          </label>
          <Details
            items={[
              ["Identity", d?.username],
              ["Host", d?.hostname],
              ["Command timeout", "30 seconds"],
              ["Output limit", "256 KB"],
            ]}
          />
          <Button onClick={() => setHistory([])}>Clear session output</Button>
          <ServiceLogsLink />
        </Drawer>
      )}
      {assistant && <AssistantDialog onClose={() => setAssistant(false)} />}
    </>
  );
}
function ServiceLogsLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="terminal" onClick={() => setOpen(true)}>
        Service logs
      </Button>
      {open && <LogDrawer onClose={() => setOpen(false)} />}
    </>
  );
}
import { LogsDialog as LogDrawer } from "./shared";

function Infrastructure({ app }: { app?: AppStatus }) {
  const db = useRead<DatabasePayload>("database", "/database");
  return (
    <details className="section-gap">
      <summary>Supporting infrastructure</summary>
      <p className="inline-note">PostgreSQL · database health and backups</p>
      <Details
        items={[
          ["Database", app?.db ?? "Personal PostgreSQL"],
          [
            "Health",
            app?.database.exists
              ? "Connected"
              : db.data?.postgres.connected
                ? "Connected"
                : "Unavailable",
          ],
          [
            "Database size",
            fmtBytes(app?.database.sizeBytes ?? db.data?.postgres.sizeBytes),
          ],
          [
            "Latest backup",
            app?.backup.latest
              ? fmtDateTime(app.backup.latest)
              : "No backup reported",
          ],
        ]}
      />
    </details>
  );
}
export function BusinessAppDesign({ kind }: { kind: "crm" | "ai" }) {
  const apps = useRead<AppsPayload>("apps", "/apps"),
    [controls, setControls] = useState(false),
    [assistant, setAssistant] = useState(false),
    a = apps.data?.apps.find((a) => a.name === kind),
    crm = kind === "crm";
  return (
    <>
      <Head
        title={crm ? "Twenty CRM" : "AI tools"}
        actions={
          !crm && (
            <Button icon="spark" onClick={() => setAssistant(true)}>
              Server assistant
            </Button>
          )
        }
      />
      <Issue error={apps.error} />
      <div className={crm ? "" : "two-cols"}>
        <Panel
          title={crm ? "Twenty CRM" : "AI workspace"}
          sub={crm ? "Business application" : "Business tool"}
          actions={
            <Status
              label={a?.state === "ok" ? "Online" : (a?.state ?? "Checking")}
              state={a?.state}
            />
          }
        >
          <div className="panel-body">
            <div className="file-grid section-gap">
              <Button
                icon={crm ? "user" : "spark"}
                onClick={() => setControls(true)}
              >
                {crm ? "CRM controls" : "Tool details"}
              </Button>
              {crm && (
                <Link className="text-link" to="/business/files">
                  Business files <Icon name="external" />
                </Link>
              )}
            </div>
            <Infrastructure app={a} />
          </div>
        </Panel>
      </div>
      {controls && (
        <Drawer
          title={crm ? "Twenty CRM" : "AI workspace"}
          onClose={() => setControls(false)}
        >
          <Details
            items={[
              ["Application", a?.name ?? "Not configured"],
              [
                "Local API",
                a?.local.ok ? "Healthy" : (a?.local.error ?? "Unavailable"),
              ],
              ["Public endpoint", a?.publicUrl ?? "Private only"],
              ["Container", a?.container?.state ?? "Unavailable"],
              ["Database", a?.db ?? "Unavailable"],
              ["Users", a?.database.users ?? "Unavailable"],
            ]}
          />
          <div className="file-grid section-gap">
            {a?.publicUrl && (
              <a
                className="button primary"
                href={a.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                {crm ? "Open Twenty CRM" : "Open AI workspace"}{" "}
                <Icon name="external" />
              </a>
            )}
            {a?.siteUrl && (
              <a
                className="button"
                href={a.siteUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open website <Icon name="external" />
              </a>
            )}
          </div>
        </Drawer>
      )}
      {assistant && <AssistantDialog onClose={() => setAssistant(false)} />}
    </>
  );
}
export function AccessDesign() {
  const config = useAppConfig(),
    agents = useRead<AgentPresence[]>("agents", "/agents", 10000),
    hosts = useRead<HostnamesPayload>("hostnames", "/hostnames", 60000),
    ts = useRead<TailscalePayload>("tailscale", "/tailscale"),
    [security, setSecurity] = useState(false),
    [assistant, setAssistant] = useState(false),
    [microsoft, setMicrosoft] = useState(false),
    ms = hosts.data?.rows.find((h) => h.host === "ms365.xgold.tech");
  const active =
    agents.data?.filter((a) => Date.now() - Date.parse(a.lastSeen) < 120000)
      .length ?? 0;
  return (
    <>
      <Head title="Access" />
      <div className="section-stack">
        <Panel
          title="Users"
          actions={
            <Button icon="shield" onClick={() => setSecurity(true)}>
              Authenticator settings
            </Button>
          }
        >
          <div className="panel-body">
            <Details
              items={[
                [config.data?.user.name ?? "Signed-in owner", "Owner"],
                [
                  "Dashboard sign-in",
                  config.data?.user.via === "cloudflare"
                    ? "Cloudflare Access"
                    : config.data?.user.via === "tailscale"
                      ? "Tailscale"
                      : (config.data?.user.via ?? "Checking"),
                ],
                [
                  "Private connection",
                  ts.data?.available
                    ? "Tailscale connected"
                    : "Tailscale unavailable",
                ],
              ]}
            />
          </div>
        </Panel>
        <Panel title="Connections">
          <Table headers={["Connection", "Status", "Details"]}>
            <tr>
              <td>Claude connector</td>
              <td>
                <Status
                  label={
                    active
                      ? `${active} active agent${active === 1 ? "" : "s"}`
                      : "Local MCP available"
                  }
                  state={active ? "ok" : "unknown"}
                />
              </td>
              <td>
                <Button icon="plug" onClick={() => setAssistant(true)}>
                  Configuration
                </Button>
              </td>
            </tr>
            <tr>
              <td>Microsoft 365</td>
              <td>
                <Status
                  label={
                    ms?.state === "ok"
                      ? "Endpoint reachable"
                      : ms
                        ? ms.state
                        : "Not checked"
                  }
                  state={ms?.state ?? "unknown"}
                />
              </td>
              <td>
                <Button icon="external" onClick={() => setMicrosoft(true)}>
                  Details
                </Button>
              </td>
            </tr>
          </Table>
        </Panel>
      </div>
      {security && (
        <Drawer
          title="Dashboard authenticator"
          onClose={() => setSecurity(false)}
        >
          <Security />
        </Drawer>
      )}
      {assistant && <AssistantDialog onClose={() => setAssistant(false)} />}{" "}
      {microsoft && (
        <Drawer
          title="Microsoft 365 connector"
          onClose={() => setMicrosoft(false)}
        >
          <Details
            items={[
              ["Endpoint", "https://ms365.xgold.tech/mcp"],
              ["Public reachability", ms?.probe.detail ?? "Not checked"],
              ["Authentication", "Connector sign-in"],
            ]}
          />
          <p className="inline-note">
            Manage Microsoft consent and the connection in Claude’s connector
            settings. Dashboard reachability checks do not verify a Microsoft
            account session.
          </p>
        </Drawer>
      )}
    </>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAppConfig } from "../App";
import {
  Card,
  ErrorNotice,
  Meter,
  PageHead,
  StatTile,
  StatusPill,
  useDialog,
  useToast,
} from "../components/ui";
import { Icons } from "../components/icons";
import { AlertsFeed } from "../components/AlertsFeed";
import { AssistantWidget } from "../components/AssistantWidget";
import { ReportsCard } from "../components/ReportsCard";
import { HostnamesCard } from "../components/HostnamesCard";
import { AddTorrentButton } from "../components/AddTorrentButton";
import { Maintenance } from "./Maintenance";
import { Files } from "./Files";
import { Storage } from "./Storage";
import { Database } from "./Database";
import { Status } from "./Status";
import { Vpn } from "./Vpn";
import { Logs } from "./Logs";
import { Jellyfin } from "./Jellyfin";
import { DirectusRecords } from "../components/DirectusRecords";
import { RepositoryUpdates } from "../components/RepositoryUpdates";
import { fmtBytes, fmtRelative } from "../format";
import type {
  OverviewPayload,
  AppsPayload,
  JobView,
  ScriptsPayload,
  ScriptRun,
} from "../types";

export interface Host {
  hostname: string;
  platform: string;
  cpuCount: number;
  uptime: number;
  username: string;
  cwd: string;
  cpu: number | null;
  memoryUsed: number;
  memoryTotal: number;
  checkedAt: string;
  history: {
    at: string;
    cpu: number | null;
    memoryUsed: number;
    memoryTotal: number;
  }[];
}
export const useHost = (range = "24h") =>
  useQuery({
    queryKey: ["host", range],
    queryFn: () => api.get<Host>(`/host?range=${range}`),
    refetchInterval: 15000,
  });

export function HostPerformance() {
  const [range, setRange] = useState("24h"),
    q = useHost(range),
    d = q.data;
  const chart = (type: "cpu" | "memory") => {
    const cutoff = Date.now() - (range === "7d" ? 7 : 1) * 86400000;
    const points =
      d?.history
        .filter((s) => type === "memory" || s.cpu !== null)
        .map(
          (s) =>
            `${Math.max(0, Math.min(700, ((Date.parse(s.at) - cutoff) / (Date.now() - cutoff)) * 700))},${110 - (type === "cpu" ? s.cpu! : (s.memoryUsed / s.memoryTotal) * 100)}`,
        ) ?? [];
    return points.length > 1 ? (
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={type === "cpu" ? "var(--accent)" : "#a9bba9"}
        strokeWidth="2"
      />
    ) : null;
  };
  return (
    <Card
      title="Host performance"
      actions={
        <div className="segmented">
          {["24h", "7d"].map((r) => (
            <button
              key={r}
              className={range === r ? "active" : ""}
              onClick={() => setRange(r)}
            >
              {r === "24h" ? "24 hours" : "7 days"}
            </button>
          ))}
        </div>
      }
    >
      <ErrorNotice error={q.error} />
      <div className="host-metrics">
        <div>
          <span>
            <i className="legend" />
            CPU
          </span>
          <strong>{d?.cpu == null ? "—" : `${d.cpu.toFixed(1)}%`}</strong>
        </div>
        <div>
          <span>
            <i className="legend light" />
            Memory
          </span>
          <strong>
            {d ? `${((100 * d.memoryUsed) / d.memoryTotal).toFixed(0)}%` : "—"}
          </strong>
          <small>
            {d
              ? `${fmtBytes(d.memoryUsed)} / ${fmtBytes(d.memoryTotal)}`
              : "Loading"}
          </small>
        </div>
      </div>
      <svg
        className="host-chart"
        viewBox="0 0 700 125"
        role="img"
        aria-label="Recorded CPU and memory usage over time"
      >
        <path
          d="M0 10H700M0 60H700M0 110H700"
          stroke="var(--hairline)"
          strokeDasharray="3 5"
        />
        {chart("memory")}
        {chart("cpu")}
      </svg>
      <div className="row spread small muted">
        <span>{range === "24h" ? "24 hours ago" : "7 days ago"}</span>
        <span>Now</span>
      </div>
      <p className="muted small">
        {d?.history.length
          ? `${d.history.length} actual samples · recorded since ${new Date(d.history[0].at).toLocaleString()}`
          : "History begins when monitoring starts. No historical values are estimated."}
      </p>
    </Card>
  );
}

export function LiveOverview({ business = false }: { business?: boolean }) {
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<OverviewPayload>("/overview"),
    refetchInterval: 15000,
  });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.get<JobView[]>("/jobs"),
    refetchInterval: 15000,
  });
  const apps = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.get<AppsPayload>("/apps"),
    enabled: business,
    refetchInterval: 30000,
  });
  const d = q.data,
    base = business ? "/business" : "";
  const issues = d?.status.services.filter((s) => s.state !== "ok") ?? [];
  return (
    <>
      <PageHead
        title="Overview"
        actions={
          <button
            className="btn"
            onClick={() => {
              void q.refetch();
              void jobs.refetch();
              if (business) void apps.refetch();
            }}
          >
            <Icons.refresh width={14} height={14} />
            Refresh
          </button>
        }
      />
      <ErrorNotice error={q.error} />
      {!!issues.length && (
        <div className="attention">
          <Icons.pulse width={23} height={23} />
          <div>
            <strong>
              {issues.length} service{issues.length === 1 ? " needs" : "s need"}{" "}
              attention
            </strong>
            <p>
              {issues
                .slice(0, 3)
                .map((s) => `${s.name}: ${s.state}`)
                .join(" · ")}
            </p>
          </div>
          <Link to={`${base}/network`}>View status →</Link>
        </div>
      )}
      <div className="service-summary-grid">
        {business ? (
          <>
            <Link className="summary-card" to="/business/crm">
              <Icons.database />
              <h2>Twenty CRM</h2>
              <strong>
                {apps.data?.apps.find((a) => a.kind === "twenty")?.state ??
                  "Checking"}
              </strong>
              <small>Live application status</small>
            </Link>
            <Link className="summary-card" to="/business/files">
              <Icons.folder />
              <h2>Business files</h2>
              <strong>
                {apps.data
                  ? apps.data.apps.filter((a) => a.kind === "directus").length
                  : "—"}
              </strong>
              <small>Configured app databases</small>
            </Link>
          </>
        ) : (
          <>
            <Link className="summary-card" to="/minecraft">
              <Icons.cube />
              <h2>Minecraft</h2>
              <strong>
                {d?.minecraft.players
                  ? `${d.minecraft.players.online} / ${d.minecraft.players.max}`
                  : (d?.minecraft.active ?? "Checking")}
              </strong>
              <small>
                {d?.minecraft.players?.names.join(", ") || "Players online"}
              </small>
            </Link>
            <Link className="summary-card" to="/jellyfin">
              <Icons.film />
              <h2>Jellyfin</h2>
              <strong>
                {d?.jellyfin.playing ?? "—"}
                <em> playing</em>
              </strong>
              <small>
                {d?.jellyfin.sessions != null
                  ? `${d.jellyfin.sessions} sessions`
                  : "Sessions unavailable"}
              </small>
            </Link>
          </>
        )}
        <Link className="summary-card" to={`${base}/network`}>
          <Icons.shield />
          <h2>Tailscale</h2>
          <strong>
            {d?.tailscale.total != null ? `${d.tailscale.online} / ${d.tailscale.total}` : "Unavailable"}
          </strong>
          <small>Devices online</small>
        </Link>
        <Link className="summary-card" to={`${base}/automation`}>
          <Icons.clock />
          <h2>Next job</h2>
          <strong className="job-summary">
            {d?.nextJob
              ? fmtRelative(d.nextJob.at)
              : d
                ? "None scheduled"
                : "Checking"}
          </strong>
          <small>{d?.nextJob?.name ?? "Automation"}</small>
        </Link>
      </div>
      <div className="overview-middle">
        <HostPerformance />
        <Card
          title="Storage"
          actions={<Link to={`${base}/files`}>View storage →</Link>}
        >
          <div className="stack">
            {d?.storage.map((f) => (
              <Meter
                key={f.mount}
                label={f.mount}
                used={f.usedBytes}
                total={f.totalBytes}
              />
            ))}
            {d?.storage.length === 0 && (
              <p className="muted">No filesystems reported.</p>
            )}
          </div>
        </Card>
      </div>
      <div className="overview-middle">
        <Card title="Recent activity">
          <AlertsFeed height={300} />
        </Card>
        <Card
          title="Scheduled jobs"
          actions={<Link to={`${base}/automation`}>Manage →</Link>}
        >
          <ErrorNotice error={jobs.error} />
          <div className="stack">
            {jobs.data?.map((j) => (
              <div className="activity-line" key={j.id}>
                <Icons.clock width={17} height={17} />
                <div>
                  <strong>{j.name}</strong>
                  <small>
                    {j.enabled
                      ? j.nextRun
                        ? fmtRelative(j.nextRun)
                        : "No next run"
                      : "Disabled"}
                  </small>
                </div>
                <StatusPill
                  state={
                    j.running ? "degraded" : j.enabled ? "ok" : "unavailable"
                  }
                  label={
                    j.running ? "Running" : j.enabled ? "Enabled" : "Disabled"
                  }
                />
              </div>
            ))}
            {jobs.data?.length === 0 && (
              <p className="muted">No scheduled jobs.</p>
            )}
          </div>
        </Card>
      </div>
      <ReportsCard compact />
    </>
  );
}

export function FilesStorage() {
  return (
    <div className="section-stack">
      <PageHead title="Files & storage" />
      <DirectusRecords />
      <details className="dash-details">
        <summary>
          Database health, app connections & private file uploads
        </summary>
        <Database />
      </details>
      <Files />
      <Storage />
    </div>
  );
}
export function NetworkPage() {
  return (
    <div className="section-stack">
      <PageHead title="Network" />
      <TunnelConnection />
      <HostnamesCard />
      <Status />
      <Vpn />
    </div>
  );
}
export function AutomationPage({ business = false }: { business?: boolean }) {
  return (
    <div className="section-stack">
      <Maintenance title="Automation" />
      <ScriptsPanel />
      <RepositoryUpdates workspace={business ? "business" : "personal"} />
      <div id="activity">
        <Card title="Activity">
          <AlertsFeed height={420} />
        </Card>
      </div>
    </div>
  );
}
export function AiTools() {
  return (
    <div className="section-stack">
      <PageHead title="AI tools" />
      <AssistantWidget />
      <ReportsCard />
    </div>
  );
}
export function CrmPage() {
  const q = useQuery({
      queryKey: ["apps"],
      queryFn: () => api.get<AppsPayload>("/apps"),
      refetchInterval: 30000,
    }),
    a = q.data?.apps.find((a) => a.kind === "twenty");
  return (
    <>
      <PageHead title="Twenty CRM" />
      <ErrorNotice error={q.error} />
      {a ? (
        <Card
          title={a.name}
          actions={
            a.publicUrl && (
              <a
                className="btn primary"
                href={a.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Twenty <Icons.external width={14} height={14} />
              </a>
            )
          }
        >
          <StatusPill state={a.state} />
          <p className="muted">
            {a.local.ok
              ? "Connected to the running Twenty instance."
              : (a.local.error ?? "Application unavailable.")}
          </p>
          <p>
            Database: <code>{a.db}</code> ·{" "}
            {fmtBytes(a.database.sizeBytes ?? 0)}
          </p>
          <p>
            Last backup:{" "}
            {a.backup.latest
              ? fmtRelative(a.backup.latest)
              : "No backup reported"}
          </p>
        </Card>
      ) : (
        <p className="muted">
          {q.isPending
            ? "Checking configured applications…"
            : "No Twenty instance is configured."}
        </p>
      )}
      <details className="dash-details">
        <summary>Application & database details</summary>
        <Database />
      </details>
    </>
  );
}

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  truncated: boolean;
  startedAt: string;
  finishedAt: string;
};
export function HostTerminal() {
  const host = useHost(),
    { confirm } = useDialog();
  const [cwd, setCwd] = useState(""),
    [command, setCommand] = useState(""),
    [history, setHistory] = useState<
      { command: string; result: CommandResult }[]
    >([]);
  const run = useMutation({
    mutationFn: (input: { command: string; cwd: string }) =>
      api.post<CommandResult>("/terminal/execute", input),
    onSuccess: (result, input) => {
      setHistory((h) => [...h, { command: input.command, result }].slice(-30));
      setCommand("");
    },
  });
  return (
    <div className="section-stack">
      <PageHead
        title="Terminal"
        sub={
          host.data
            ? `${host.data.username}@${host.data.hostname} · ${host.data.platform}`
            : "Connecting to host…"
        }
      />
      <Card title="Host shell">
        <p className="muted small">
          Commands run as {host.data?.username ?? "the dashboard service owner"}{" "}
          in a fresh shell, with a 30 second limit. Choose the working directory
          explicitly; interactive programs need SSH.
        </p>
        <label className="row">
          Working directory
          <input
            aria-label="Working directory"
            value={cwd || host.data?.cwd || ""}
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>
      </Card>
      <div className="host-terminal">
        <div className="terminal-caption">
          {host.data?.hostname ?? "Host"} · bash
        </div>
        <div className="terminal-output" role="log">
          {history.length === 0 && (
            <p>No commands have been run in this session.</p>
          )}
          {history.map((h, i) => (
            <div key={i}>
              <p className="terminal-command">$ {h.command}</p>
              <pre>{h.result.stdout}</pre>
              {h.result.stderr && (
                <pre className="terminal-error">{h.result.stderr}</pre>
              )}
              <small>
                Exit {h.result.code}
                {h.result.timedOut && " · timed out"}
                {h.result.truncated && " · output truncated at 256 KB"}
              </small>
            </div>
          ))}
          {run.isPending && <p>Running on the server…</p>}
        </div>
        <form
          className="terminal-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await confirm({
                title: "Run this host command?",
                body: (
                  <>
                    <p>
                      Runs as {host.data?.username} in {cwd || host.data?.cwd}.
                    </p>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{command}</pre>
                  </>
                ),
                confirmLabel: "Run command",
              })
            )
              run.mutate({ command, cwd: cwd || host.data?.cwd || "" });
          }}
        >
          <span>$</span>
          <input
            aria-label="Host command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={run.isPending}
          />
          <button className="btn" disabled={!command.trim() || run.isPending}>
            Run
          </button>
        </form>
      </div>
      <ErrorNotice error={run.error} />
      <details className="dash-details">
        <summary>Service logs</summary>
        <Logs />
      </details>
    </div>
  );
}

type Torrent = {
  hash: string;
  name: string;
  size: number;
  progress: number;
  state: string;
  downloadSpeed: number;
  uploadSpeed: number;
  eta: number;
  savePath: string;
};
function Downloads() {
  const q = useQuery({
      queryKey: ["torrent-queue"],
      queryFn: () => api.get<Torrent[]>("/qbittorrent/queue"),
      refetchInterval: 5000,
    }),
    qc = useQueryClient(),
    toast = useToast(),
    { confirm } = useDialog();
  const action = useMutation({
    mutationFn: (body: { hash: string; action: string }) =>
      api.post("/qbittorrent/control", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["torrent-queue"] });
      toast("Queue updated");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  return (
    <Card title="Downloads" actions={<AddTorrentButton />}>
      <ErrorNotice error={q.error} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Progress</th>
              <th>State</th>
              <th>Speed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((t) => (
              <tr key={t.hash}>
                <td title={t.savePath}>
                  {t.name}
                  <small className="dim">{fmtBytes(t.size)}</small>
                </td>
                <td>{(t.progress * 100).toFixed(1)}%</td>
                <td>{t.state}</td>
                <td>
                  {fmtBytes(t.downloadSpeed)}/s ↓
                  <small className="dim">{fmtBytes(t.uploadSpeed)}/s ↑</small>
                </td>
                <td>
                  <div className="row">
                    {["pause", "resume", "remove"].map((a) => (
                      <button
                        key={a}
                        disabled={action.isPending}
                        className={`btn sm ${a === "remove" ? "danger" : ""}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `${a[0].toUpperCase() + a.slice(1)} ${t.name}?`,
                              body:
                                a === "remove"
                                  ? "The torrent is removed from qBittorrent. Downloaded files are kept."
                                  : undefined,
                              danger: a === "remove",
                              confirmLabel: a,
                            })
                          )
                            action.mutate({ hash: t.hash, action: a });
                        }}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data?.length === 0 && (
        <p className="muted">The download queue is empty.</p>
      )}
    </Card>
  );
}
export function MediaWorkspace() {
  return (
    <div className="section-stack">
      <Jellyfin />
      <MediaLibrary />
      <details className="dash-details" open>
        <summary>Downloads</summary>
        <Downloads />
      </details>
      <details className="dash-details">
        <summary>Media files · browse, upload, move & rename</summary>
        <Files />
      </details>
    </div>
  );
}

function MediaLibrary() {
  const [kind, setKind] = useState("Movie"),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [start, setStart] = useState(0);
  const q = useQuery({
    queryKey: ["jellyfin-library", kind, query, start],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          name: string;
          year?: number;
          path?: string;
          minutes: number | null;
        }[];
        total: number;
      }>(
        `/jellyfin/library?kind=${kind}&search=${encodeURIComponent(query)}&start=${start}`,
      ),
  });
  return (
    <Card title="Media library">
      <div className="row spread">
        <div className="segmented">
          {[
            ["Movie", "Movies"],
            ["Series", "Series"],
            ["Audio", "Music"],
          ].map(([type, label]) => (
            <button
              key={type}
              className={kind === type ? "active" : ""}
              onClick={() => {
                setKind(type);
                setStart(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
            setStart(0);
          }}
        >
          <input
            aria-label="Search media library"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn">Search</button>
        </form>
      </div>
      <ErrorNotice error={q.error} />
      <div className="media-item-grid">
        {q.data?.items.map((item) => (
          <article key={item.id}>
            <Icons.film width={25} height={25} />
            <strong>{item.name}</strong>
            <small>
              {[item.year, item.minutes ? `${item.minutes} minutes` : null]
                .filter(Boolean)
                .join(" · ")}
            </small>
            <details>
              <summary>File path</summary>
              <code>{item.path ?? "Not reported by Jellyfin"}</code>
            </details>
          </article>
        ))}
      </div>
      {q.isPending && <p className="muted">Loading library…</p>}
      {q.data?.items.length === 0 && (
        <p className="muted">No matching media in this library.</p>
      )}
      <div className="row spread">
        <span className="muted small">
          {q.data ? `${q.data.total} matching items` : ""}
        </span>
        <div className="row">
          <button
            className="btn sm"
            disabled={start === 0}
            onClick={() => setStart((n) => Math.max(0, n - 30))}
          >
            Previous
          </button>
          <button
            className="btn sm"
            disabled={!q.data || start + 30 >= q.data.total}
            onClick={() => setStart((n) => n + 30)}
          >
            Next
          </button>
        </div>
      </div>
    </Card>
  );
}

function ScriptsPanel() {
  const q = useQuery({
      queryKey: ["scripts"],
      queryFn: () => api.get<ScriptsPayload>("/scripts"),
      refetchInterval: 5000,
    }),
    qc = useQueryClient(),
    toast = useToast(),
    { confirm } = useDialog();
  const run = useMutation({
    mutationFn: (name: string) =>
      api.post<ScriptRun>(`/scripts/${encodeURIComponent(name)}/run`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scripts"] });
      toast("Script started. Output appears in Activity.");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  return (
    <Card title="Scripts">
      <ErrorNotice error={q.error} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Script</th>
              <th>Last run</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.scripts.map((script) => (
              <tr key={`${script.dir}/${script.name}`}>
                <td>
                  <strong>{script.name}</strong>
                  <small className="dim">{script.dir}</small>
                </td>
                <td>
                  {script.lastRun
                    ? fmtRelative(script.lastRun.startedAt)
                    : "Never run"}
                </td>
                <td>
                  <StatusPill
                    state={
                      script.running
                        ? "degraded"
                        : !script.lastRun
                          ? "unavailable"
                          : script.lastRun.exitCode === 0
                            ? "ok"
                            : "down"
                    }
                    label={
                      script.running
                        ? "Running"
                        : !script.lastRun
                          ? "Not run"
                          : script.lastRun.exitCode === 0
                            ? "Completed"
                            : `Exit ${script.lastRun.exitCode ?? "unknown"}`
                    }
                  />
                </td>
                <td>
                  <button
                    className="btn sm"
                    disabled={script.running || run.isPending}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Run ${script.name}?`,
                          body: script.dir,
                          confirmLabel: "Run script",
                        })
                      )
                        run.mutate(script.name);
                    }}
                  >
                    Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data?.scripts.length === 0 && (
        <p className="muted">No scripts found in the configured folders.</p>
      )}
      {q.data?.dirs
        .filter((dir) => !dir.exists)
        .map((dir) => (
          <p className="notice error" key={dir.path}>
            Script folder unavailable: {dir.path}
          </p>
        ))}
    </Card>
  );
}
function TunnelConnection() {
  const q = useQuery({
      queryKey: ["apps"],
      queryFn: () => api.get<AppsPayload>("/apps"),
      refetchInterval: 30000,
    }),
    config = useAppConfig(),
    tunnel = q.data?.tunnel;
  return (
    <Card
      title="Cloudflare Tunnel"
      actions={
        config.data?.links.router && (
          <a
            className="btn"
            href={config.data.links.router}
            target="_blank"
            rel="noreferrer"
          >
            Router settings <Icons.external width={14} height={14} />
          </a>
        )
      }
    >
      <ErrorNotice error={q.error} />
      <div className="row spread">
        <StatusPill
          state={
            tunnel?.ready
              ? "ok"
              : tunnel?.ready === false
                ? "down"
                : "unavailable"
          }
          label={
            tunnel?.ready
              ? `Connected · ${tunnel.connections} links`
              : (tunnel?.error ?? (tunnel ? "Not ready" : "Checking"))
          }
        />
        <span className="muted small">
          {q.data ? `Checked ${fmtRelative(q.data.checkedAt)}` : ""}
        </span>
      </div>
      <p className="muted small">{tunnel?.hostnames.join(" · ")}</p>
    </Card>
  );
}

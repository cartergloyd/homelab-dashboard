// Shared API shapes. web/src/types.ts mirrors this file — keep them in sync.

export type ServiceState = "ok" | "degraded" | "down" | "unavailable";

export interface ServiceStatus {
  id: string;
  name: string;
  state: ServiceState;
  latencyMs: number | null;
  detail: string;
  href?: string;
  checkedAt: string;
}

export interface StatusPayload {
  services: ServiceStatus[];
  generatedAt: string;
  demo: boolean;
}

export interface ContainerInfo {
  name: string;
  state: string;
  status: string;
  image: string;
  startedAt: string | null;
  health: string | null;
}

export interface UnitState {
  unit: string;
  active: string;
  sub: string;
  since: string | null;
  pid: number | null;
  memoryBytes: number | null;
}

export interface McPlayers {
  online: number;
  max: number;
  names: string[];
}

export interface McPing {
  online: number;
  max: number;
  sample: string[];
  version: string;
  motd: string;
  latencyMs: number;
}

export interface MinecraftPayload {
  unit: UnitState | null;
  ping: McPing | null;
  rcon: { ok: boolean; error?: string };
  players: McPlayers | null;
  address: string;
}

export interface JellyfinSession {
  id: string;
  user: string;
  client: string;
  device: string;
  lastActivity: string;
  nowPlaying: {
    name: string;
    type: string;
    series?: string;
    progress: number;
    paused: boolean;
  } | null;
}

export interface JellyfinPayload {
  reachable: boolean;
  info: { version: string; serverName: string; os: string } | null;
  counts: Record<string, number> | null;
  sessions: JellyfinSession[];
  container: ContainerInfo | null;
  url: string;
  error?: string;
}

export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: string;
}

export interface MediaRoot {
  name: string;
  path: string;
}

export interface DatabasePayload {
  directus: {
    state: ServiceState;
    status: string | null;
    url: string;
    latencyMs: number | null;
    error?: string;
  };
  postgres: {
    connected: boolean;
    version: string | null;
    sizeBytes: number | null;
    tables: number | null;
    topTables: { name: string; rows: number; bytes: number }[];
    error?: string;
  };
}

/** `external` = runs outside the dashboard (cron, systemd timer); mirrored for visibility only. */
export type JobType = "restart" | "backup" | "command" | "script" | "external";

export interface JobOptions {
  warnMinutes?: number[];
  onlyWhenEmpty?: boolean;
  keep?: number;
  command?: string;
  /** script job: file to run. external job: script name to watch for in the feed. */
  script?: string;
  /** external job: who runs it, e.g. "cron", "systemd timer" */
  managedBy?: string;
  /** external job: minutes to wait for the script's output before reporting it missing */
  graceMinutes?: number;
  /** external job mirrored from a systemd timer: the .timer unit name */
  timer?: string;
  /** external job mirrored from a crontab: where the line lives, e.g. "crontab (gold)" or "/etc/cron.d/minecraft" */
  cronSource?: string;
}

export interface Job {
  id: string;
  name: string;
  type: JobType;
  cron: string;
  enabled: boolean;
  options: JobOptions;
  createdAt: string;
  /** true for demo-seeded jobs; `npm run clear-demo-data` removes these */
  seeded?: boolean;
}

export interface JobRun {
  id: string;
  jobId: string;
  jobName: string;
  type: JobType;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  message: string;
}

export interface JobView extends Job {
  nextRun: string | null;
  lastRun: JobRun | null;
  running: boolean;
  /** external jobs only: is the real job's output reaching the alerts feed? */
  outputTracking: "connected" | "not-connected" | "unknown" | null;
}

export type BackupFormat = "dashboard" | "dated-folder" | "archive";

export interface BackupFile {
  name: string;
  /** absolute path of the archive or dated folder */
  path: string;
  /** backup root it was found under */
  root: string;
  format: BackupFormat;
  bytes: number;
  mtime: string;
  /** only backups the dashboard itself created may be deleted from the UI */
  deletable: boolean;
}

export interface BackupsPayload {
  roots: { path: string; exists: boolean; count: number }[];
  backups: BackupFile[];
  method: string;
  format: string;
  writeDir: string;
}

export interface ScriptsPayload {
  dirs: { path: string; exists: boolean; count: number }[];
  scripts: ScriptInfo[];
}

export interface Filesystem {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usedPct: number;
}

export interface FolderUsage {
  label: string;
  path: string;
  bytes: number | null;
  error?: string;
}

export interface StoragePayload {
  filesystems: Filesystem[];
  folders: FolderUsage[];
  refreshedAt: string | null;
  refreshing: boolean;
}

// ---- storage explorer (issue #4: TreeSize-style "where does the space go") ----

export interface TreeEntry {
  name: string;
  path: string;
  bytes: number;
  /** `files` = the remaining files in this folder, aggregated */
  kind: "dir" | "file" | "files";
}

export interface StorageTreePayload {
  path: string;
  parent: string | null;
  /** a `du` is running in the background; entries (if any) are from the previous measurement */
  measuring: boolean;
  measuredAt: string | null;
  totalBytes: number | null;
  entries: TreeEntry[];
  /** some sub-folders could not be read; sizes are lower bounds */
  partial: boolean;
  /** the filesystem this folder lives on, for "% of disk" */
  mount: { mount: string; totalBytes: number; usedBytes: number } | null;
  error?: string;
}

export interface LargestFile {
  path: string;
  bytes: number;
  modified: string | null;
}

export interface LargestPayload {
  path: string;
  measuring: boolean;
  measuredAt: string | null;
  minBytes: number;
  files: LargestFile[];
  partial: boolean;
  error?: string;
}

export interface ReclaimItem {
  id: string;
  label: string;
  /** null = could not be measured (not readable, tool missing) */
  bytes: number | null;
  detail: string;
  /** display-only: what a human (or agent) would run to reclaim it; null when the dashboard handles it */
  command: string | null;
  /** counted in the reclaimable total */
  actionable: boolean;
}

export interface ReclaimPayload {
  items: ReclaimItem[];
  totalBytes: number;
  measuring: boolean;
  measuredAt: string | null;
}

export interface TailscalePeer {
  hostName: string;
  dnsName: string;
  os: string;
  ips: string[];
  online: boolean;
  lastSeen: string | null;
  self: boolean;
}

export interface TailscalePayload {
  available: boolean;
  self: TailscalePeer | null;
  peers: TailscalePeer[];
  magicDnsSuffix: string | null;
  error?: string;
}

export interface OverviewPayload {
  status: StatusPayload;
  minecraft: { players: McPlayers | null; active: string | null };
  jellyfin: { sessions: number; playing: number };
  storage: Filesystem[];
  tailscale: { online: number; total: number };
  nextJob: { name: string; at: string } | null;
}

export type LogSource =
  | "minecraft"
  | "jellyfin"
  | "directus"
  | "postgres"
  | "dashboard"
  | "system";

// ---- Live Server Alerts --------------------------------------------------

export type AlertLevel = "info" | "warn" | "error";
export type AlertSource = LogSource | "jobs" | "scripts" | "agent";
export type AlertKind = "log" | "job" | "script" | "agent";

export interface AlertEvent {
  id: string;
  ts: string;
  source: AlertSource;
  kind: AlertKind;
  level: AlertLevel;
  /** e.g. "maintenance" — set by the classifier or the publisher */
  tags: string[];
  text: string;
  meta?: {
    job?: string;
    jobId?: string;
    script?: string;
    runId?: string;
    agent?: string;
    exitCode?: number | null;
    label?: string;
  };
}

export interface AlertSummary {
  total: number;
  errorsLastHour: number;
  warnsLastHour: number;
  maintenanceLastHour: number;
  lastMaintenance: AlertEvent | null;
  lastAgent: AlertEvent | null;
}

export interface AgentPresence {
  name: string;
  lastSeen: string;
  lastAction: string | null;
  actions: number;
}

export type AgentRunner = "codex" | "claude";
export type AgentRunStatus = "running" | "exited" | "failed";

export interface AgentRun {
  id: string;
  runner: AgentRunner;
  task: string;
  cwd: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  status: AgentRunStatus;
  lines: number;
}

export interface ScriptRun {
  id: string;
  script: string;
  trigger: "manual" | "job" | "agent";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  lines: number;
}

export interface ScriptInfo {
  name: string;
  dir: string;
  kind: "python" | "shell";
  running: boolean;
  lastRun: ScriptRun | null;
}

export interface AgentReport {
  id: string;
  ts: string;
  agent: string;
  title: string;
  body: string;
  reviewed: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface ContextPayload {
  path: string;
  content: string;
  hash: string;
  updatedAt: string | null;
}

export interface ContextHistoryEntry {
  id: string;
  ts: string;
  author: string;
  note: string;
  added: number;
  removed: number;
  bytes: number;
}

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

export interface ContextVersion extends ContextHistoryEntry {
  content: string;
  /** line diff from this version to the current file */
  diff: DiffLine[];
}

// ---- VPN -----------------------------------------------------------------

export interface GeoInfo {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  org: string | null;
  timezone: string | null;
  hostname: string | null;
}

/** How a service's traffic leaves the machine while the VPN is up. */
export type VpnPath = "bypass" | "vpn" | "isp" | "local" | "unknown";

export interface VpnServicePath {
  name: string;
  port: string;
  path: VpnPath;
  evidence: string;
  advice: string;
  needed: "required" | "recommended" | "optional" | "none";
}

export interface VpnPayload {
  checkedAt: string;
  state: "connected" | "disconnected" | "unknown";
  provider: string | null;
  protocol: string | null;
  iface: string | null;
  endpoint: { host: string; port: number | null; geo: GeoInfo | null } | null;
  exit: GeoInfo | null;
  home: GeoInfo | null;
  handshakeAgoSec: number | null;
  transfer: { rxBytes: number; txBytes: number } | null;
  connectedSince: string | null;
  killSwitch: boolean | null;
  dns: string[];
  dnsNote: string | null;
  defaultRouteDev: string | null;
  services: VpnServicePath[];
  diagnostics: Record<string, string>;
  notes: string[];
}

export interface AppConfigPayload {
  demo: boolean;
  user: { login: string; name: string };
  links: { jellyfin: string; directus: string; qbittorrent: string | null };
  mediaRoots: string[];
  timezone: string;
  logSources: LogSource[];
  alertSources: AlertSource[];
  scriptsDirs: string[];
  contextFile: string;
  /** absolute path of server/dist/mcp.js on this machine, for the connect snippet */
  mcpScript: string;
  /** dashboard URL from the server's own shell, for locally launched MCP connectors */
  mcpLocalUrl: string;
  /** only sent to Tailscale-identified users, never to key-authenticated clients */
  dashboardKey?: string;
}

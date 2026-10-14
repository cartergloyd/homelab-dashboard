// Mirror of server/src/types.ts — keep in sync.

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
  nowPlaying: { name: string; type: string; series?: string; progress: number; paused: boolean } | null;
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

export interface FileListing {
  root: string;
  path: string;
  entries: FileEntry[];
}

export interface DatabasePayload {
  directus: { state: ServiceState; status: string | null; url: string; latencyMs: number | null; error?: string };
  postgres: {
    connected: boolean;
    version: string | null;
    sizeBytes: number | null;
    tables: number | null;
    topTables: { name: string; rows: number; bytes: number }[];
    error?: string;
  };
}

export type JobType = "restart" | "backup" | "command" | "script" | "external";

export interface JobOptions {
  warnMinutes?: number[];
  onlyWhenEmpty?: boolean;
  keep?: number;
  command?: string;
  script?: string;
  managedBy?: string;
  graceMinutes?: number;
  timer?: string;
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
  outputTracking: "connected" | "not-connected" | "unknown" | null;
}

export type BackupFormat = "dashboard" | "dated-folder" | "archive";

export interface BackupFile {
  name: string;
  path: string;
  root: string;
  format: BackupFormat;
  bytes: number;
  mtime: string;
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

// ---- storage explorer (issue #4): ncdu/gdu-powered TreeSize view ------------------

export type DiskScanEngine = "ncdu" | "gdu" | "du" | "demo";

export interface ScanFile {
  name: string;
  path: string;
  /** disk usage (st_blocks) */
  dsize: number;
  /** apparent size */
  asize: number;
  /** unix seconds; null when the engine does not report it (du) */
  mtime: number | null;
  uid: number | null;
  ext: string;
}

export interface ScanDirSummary {
  name: string;
  path: string;
  dsize: number;
  asize: number;
  /** files in the whole subtree */
  files: number;
  dirs: number;
  /** newest mtime in the subtree */
  mtime: number | null;
  /** files directly in this folder */
  ownFiles: number;
  ownBytes: number;
  readError: boolean;
  /** "otherfs" | "kernfs" | "pattern" … when the scanner skipped it */
  excluded: string | null;
  hasChildren: boolean;
}

export interface ScanStats {
  ext: { ext: string; bytes: number; count: number }[];
  age: { label: string; bytes: number; count: number }[];
  owners: { uid: number; name: string | null; bytes: number; count: number }[];
  /** statistics are kept for the top levels of a scan only */
  available: boolean;
}

export interface DiskScanSummary {
  id: string;
  root: string;
  engine: DiskScanEngine;
  engineVersion: string | null;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  progress: { dirs: number; files: number };
  totals: { dsize: number; asize: number; files: number; dirs: number; readErrors: number; excluded: number };
  mount: { mount: string; totalBytes: number; usedBytes: number } | null;
}

export interface DiskScanOverview {
  engine: { preferred: DiskScanEngine; available: { ncdu: string | null; gdu: string | null }; note: string };
  roots: string[];
  scans: DiskScanSummary[];
  running: string | null;
  intervalHours: number;
}

export interface DirViewPayload {
  scan: DiskScanSummary;
  dir: ScanDirSummary;
  parent: string | null;
  children: ScanDirSummary[];
  /** largest files in the subtree */
  top: ScanFile[];
  stats: ScanStats;
}

export interface ReclaimItem {
  id: string;
  label: string;
  bytes: number | null;
  detail: string;
  command: string | null;
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

export type LogSource = "minecraft" | "jellyfin" | "directus" | "postgres" | "dashboard" | "system";

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
    incidentId?: string;
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

export type AgentRunKind = "manual" | "incident" | "continuation" | "chat";

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
  kind: AgentRunKind;
  incidentId: string | null;
  sessionId: string | null;
}

export type SidecarPhase = "off" | "idle" | "queued" | "investigating" | "waiting-approval" | "acting" | "reporting" | "failed";
export type IncidentStatus = "open" | "investigating" | "waiting-approval" | "resolved" | "dismissed" | "failed";
export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface SidecarSettings {
  enabled: boolean;
  runner: AgentRunner;
  autoTrigger: boolean;
  requireApproval: boolean;
  cooldownMinutes: number;
  quietSeconds: number;
  workspace: string;
  maxRunMinutes: number;
}

export interface Incident {
  id: string;
  fingerprint: string;
  title: string;
  source: AlertSource;
  level: AlertLevel;
  status: IncidentStatus;
  firstSeen: string;
  lastSeen: string;
  count: number;
  alertIds: string[];
  samples: string[];
  runIds: string[];
  reportIds: string[];
  approvalIds: string[];
  note: string | null;
}

export interface Approval {
  id: string;
  ts: string;
  action: string;
  reason: string;
  requestedBy: string;
  incidentId: string | null;
  runId: string | null;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface ConversationTurn {
  id: string;
  ts: string;
  role: "user" | "assistant" | "system";
  text: string;
  runId: string | null;
  incidentId: string | null;
}

export interface SidecarState {
  phase: SidecarPhase;
  since: string;
  detail: string | null;
  currentIncidentId: string | null;
  currentRunId: string | null;
  queue: string[];
  lastRun: AgentRun | null;
  runnerAvailable: boolean | null;
  runnerNote: string | null;
}

export interface SidecarPayload {
  settings: SidecarSettings;
  state: SidecarState;
  incidents: Incident[];
  approvals: Approval[];
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
  incidentId?: string | null;
  runId?: string | null;
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
  mcpScript: string;
  mcpLocalUrl: string;
  dashboardKey?: string;
}

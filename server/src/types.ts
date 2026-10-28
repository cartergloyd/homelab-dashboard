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

export interface StorageDevice {
  path: string;
  type: string;
  model: string | null;
  label: string | null;
  filesystem: string | null;
  uuid: string | null;
  sizeBytes: number;
  mounts: string[];
  readOnly: boolean;
  children: StorageDevice[];
}

export interface DriveInventory {
  devices: StorageDevice[];
  error: string | null;
}

export interface StoragePayload {
  filesystems: Filesystem[];
  driveInventory: DriveInventory;
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
  jellyfin: { sessions: number | null; playing: number | null };
  storage: Filesystem[];
  tailscale: { online: number | null; total: number | null };
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
    /** sidecar: the incident this event belongs to / was produced for */
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
export type AgentRunStatus = "running" | "exited" | "failed" | "cancelled";

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
  /** why it was started (sidecar) */
  kind: AgentRunKind;
  incidentId: string | null;
  /** runner session id, so the next run can resume the same conversation */
  sessionId: string | null;
  pid: number | null;
  error: string | null;
}

// ---- sidecar assistant (issue #5) ----------------------------------------------

export type SidecarPhase = "off" | "idle" | "queued" | "investigating" | "waiting-approval" | "acting" | "reporting" | "failed";
export type IncidentStatus = "open" | "investigating" | "waiting-approval" | "resolved" | "dismissed" | "failed";
export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface SidecarSettings {
  /** master switch: off = the panel is a plain chat, nothing is launched automatically */
  enabled: boolean;
  runner: AgentRunner;
  /** launch the agent on new actionable incidents */
  autoTrigger: boolean;
  /** agents must get the owner's approval before restart/stop/destructive RCON */
  requireApproval: boolean;
  /** the same incident does not re-trigger within this window */
  cooldownMinutes: number;
  /** wait for the burst of alerts to settle before launching */
  quietSeconds: number;
  /** the agent's working directory / sandbox root */
  workspace: string;
  maxRunMinutes: number;
}

export interface Incident {
  summary?: string;
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
  /** last few raw lines, for the agent's prompt and the UI */
  samples: string[];
  runIds: string[];
  reportIds: string[];
  approvalIds: string[];
  note: string | null;
  /** what the agent's report said it did: fixed something, checked and found nothing to do, or needs a human */
  outcome: ReportOutcome | null;
}

export interface Approval {
  id: string;
  ts: string;
  /** e.g. "minecraft_service:restart", "rcon:stop" */
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
  /** is the chosen runner's CLI installed for the dashboard's user? null = unknown */
  runnerAvailable: boolean | null;
  runnerNote: string | null;
  sessionId: string | null;
  model: string | null;
}

export type ReportOutcome = "fixed" | "no-action" | "needs-human";

/** One resolved incident with everything the agent did about it (for the Repairs list). */
export interface RepairItem {
  incident: Incident;
  reports: AgentReport[];
  approvals: Approval[];
  /** the agent's tool calls and messages for this incident, from the feed */
  actions: { ts: string; text: string }[];
  runs: AgentRun[];
}

export interface RepairsPayload {
  /** incidents the agent fixed (outcome = fixed) */
  repaired: number;
  /** incidents the agent checked but left alone */
  checked: number;
  /** incidents waiting on a human decision after the agent reported */
  needsHuman: number;
  items: RepairItem[];
}

// ---- staged updates: Paper + plugins, installed / staged / upstream -------------------

export interface UpdateVersion {
  version: string | null;
  /** Paper build number */
  build?: number | null;
  /** ISO: release date upstream, or file date for installed/staged jars */
  date: string | null;
  file?: string | null;
  channel?: string | null;
  url?: string | null;
  /** where the upstream answer came from: papermc, modrinth, hangar, github */
  source?: string | null;
  mcVersion?: string | null;
}

export type UpdateStatus = "up-to-date" | "staged" | "update-available" | "unknown";

export interface UpdateItem {
  kind: "paper" | "plugin";
  name: string;
  installed: UpdateVersion | null;
  staged: UpdateVersion | null;
  latest: UpdateVersion | null;
  status: UpdateStatus;
  note: string | null;
}

export interface StagedUpdatePayload {
  items: UpdateItem[];
  mcVersion: string | null;
  newestMcVersion: string | null;
  stagingDirs: { path: string; exists: boolean; files: number }[];
  /** the dashboard job (usually the mirrored update/restart timer) that applies staged files */
  nextApply: { job: string; at: string | null } | null;
  lastFetch: string | null;
  checkedAt: string | null;
  upstreamChecked: boolean;
  notes: string[];
}

// ---- Directus-per-app platform (fam, ai, …) behind a Cloudflare Tunnel ---------------------

export interface AppContainer {
  state: string | null;
  startedAt: string | null;
  image: string | null;
}

export interface AppDbStats {
  exists: boolean;
  sizeBytes: number | null;
  /** all tables in the public schema */
  tables: number | null;
  /** tables that are not Directus system tables = the app's collections */
  collections: number | null;
  users: number | null;
  lastLogin: string | null;
  error?: string;
}

export type AppKind = "directus" | "twenty" | "umami";

export interface AppStatus {
  name: string;
  kind: AppKind;
  url: string;
  publicUrl: string | null;
  /** the app's front-end site (<name>.<domain>, GitHub Pages today); informational */
  siteUrl: string | null;
  containerName: string;
  db: string;
  state: ServiceState;
  container: AppContainer | null;
  local: { ok: boolean; status: string | null; latencyMs: number | null; error?: string };
  /** reached through the tunnel from the server itself; null = not checked (no public URL) */
  public: { ok: boolean | null; httpStatus: number | null; latencyMs: number | null; note?: string };
  database: AppDbStats;
  backup: { latest: string | null; file: string | null; bytes: number | null; count: number };
}

export interface TunnelStatus {
  container: AppContainer | null;
  ready: boolean | null;
  connections: number | null;
  hostnames: string[];
  error?: string;
}

export interface PgDatabaseRow {
  name: string;
  owner: string;
  sizeBytes: number;
  app: string | null;
}

export interface AppsPayload {
  apps: AppStatus[];
  tunnel: TunnelStatus;
  domain: string | null;
  postgres: {
    connected: boolean;
    version: string | null;
    databases: PgDatabaseRow[];
    /** local addresses 5432 is bound to (from ss); loopbackOnly null = could not check */
    exposure: { binds: string[]; loopbackOnly: boolean | null };
    error?: string;
  };
  backupDir: string;
  checkedAt: string;
}

// ---- Domain & hostnames card (Dashboard) --------------------------------------------------

export type HostRole = "site" | "api" | "app" | "dashboard" | "game" | "stream" | "other";

export interface HostnameProbe {
  kind: "https" | "minecraft" | "none";
  /** null = not probed, or public reachability could not be verified */
  ok: boolean | null;
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string;
  /** TLS certificate seen on the https probe (issuer + days until expiry); null when not https or unknown */
  cert?: { issuer: string; expiresAt: string; daysLeft: number } | null;
}

export interface HostnameRow {
  host: string;
  role: HostRole;
  /** the DNS records behind this name, as "TYPE data" */
  records: string[];
  source: "cloudflare" | "zonefile" | "config" | "extra";
  /** human description of where it points: "GitHub Pages", "home IP", "Cloudflare Tunnel", an IP */
  target: string | null;
  /** Cloudflare's orange cloud; from the API when available, else inferred from the live answer */
  proxied: boolean | null;
  resolved: string[];
  probe: HostnameProbe;
  state: ServiceState;
  note?: string;
}

export interface HostnamesPayload {
  domain: string | null;
  source: "cloudflare" | "zonefile" | "config" | "none";
  zoneFile: string | null;
  rows: HostnameRow[];
  /** records that are not hosts (TXT/MX/NS), as "TYPE name data" */
  otherRecords: string[];
  checkedAt: string;
  error?: string;
}

export interface SidecarPayload {
  settings: SidecarSettings;
  state: SidecarState;
  incidents: Incident[];
  approvals: Approval[];
}

export interface IncidentFeedback {
  id: string;
  incidentId: string;
  text: string;
  by: string;
  ts: string;
  runId: string | null;
}

export interface InstructionSuggestion {
  id: string;
  incidentId: string;
  reportId: string;
  text: string;
  ts: string;
  status: "pending" | "applied" | "declined";
  decidedBy: string | null;
}

export interface IncidentReviewPayload {
  incident: Incident;
  reports: AgentReport[];
  conversation: ConversationTurn[];
  feedback: IncidentFeedback[];
  suggestions: InstructionSuggestion[];
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
  /** sidecar: the incident / run this report answers */
  incidentId?: string | null;
  runId?: string | null;
  outcome?: ReportOutcome | null;
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

export type IdentityVia = "tailscale" | "cloudflare" | "key" | "dev";

export interface AppConfigPayload {
  demo: boolean;
  torrentAdd: boolean;
  user: { login: string; name: string; via: IdentityVia };
  links: { jellyfin: string; directus: string; qbittorrent: string | null; router: string | null };
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

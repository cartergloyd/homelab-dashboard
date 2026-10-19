#!/usr/bin/env node
// MCP server for terminal coding agents (Claude Code, Codex). A thin stdio
// front-end over the dashboard's REST API: everything an agent does here goes
// through the same routes the UI uses, so it is attributed in the alerts feed.
//
//   HOMELAB_URL   dashboard base URL (default http://127.0.0.1:3000)
//   HOMELAB_KEY   the dashboard's DASHBOARD_KEY (a local password, not an AI API key)
//   HOMELAB_AGENT optional display name; otherwise taken from the connecting client
//
// Never write to stdout here except through the MCP transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.HOMELAB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = process.env.HOMELAB_KEY ?? process.env.DASHBOARD_KEY ?? "";
let agentName = process.env.HOMELAB_AGENT ?? "MCP client";

const LOG_SOURCES = ["minecraft", "jellyfin", "directus", "postgres", "dashboard", "system"] as const;
const ALERT_SOURCES = [...LOG_SOURCES, "jobs", "scripts", "agent"] as const;

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "X-Homelab-Agent": agentName,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // not JSON
    }
    throw new Error(`${method} ${path} failed: ${msg}`);
  }
  return (await res.json()) as T;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

interface AlertEvent {
  ts: string;
  source: string;
  level: string;
  kind: string;
  tags: string[];
  text: string;
  meta?: { runId?: string };
}

const fmtEvents = (events: AlertEvent[]) =>
  events.length ? events.map((e) => `${e.ts.slice(0, 19).replace("T", " ")} [${e.source}${e.kind !== "log" ? `/${e.kind}` : ""}] ${e.level.toUpperCase()}${e.tags.length ? ` {${e.tags.join(",")}}` : ""} ${e.text}`).join("\n") : "(no events)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = new McpServer({ name: "homelab-dashboard", version: "0.2.0" });

server.server.oninitialized = () => {
  if (process.env.HOMELAB_AGENT) return;
  const client = server.server.getClientVersion();
  const raw = client?.name ?? "";
  if (/claude/i.test(raw)) agentName = "Claude Code";
  else if (/codex/i.test(raw)) agentName = "Codex";
  else if (raw) agentName = raw.slice(0, 40);
};

// ---- observe ----------------------------------------------------------------

server.registerTool(
  "get_alerts",
  {
    title: "Get server alerts",
    description:
      "Recent events from the Live Server Alerts feed: Minecraft log, jobs, scripts, agent actions and other services. Defaults to problems & maintenance only (errors, warnings, restarts, backups, job/script results).",
    inputSchema: {
      problemsOnly: z.boolean().default(true).describe("false = include routine log noise"),
      sources: z.array(z.enum(ALERT_SOURCES)).optional().describe("limit to these sources"),
      sinceMinutes: z.number().int().min(1).max(10080).optional().describe("only events newer than this many minutes"),
      limit: z.number().int().min(1).max(1000).default(100),
    },
  },
  async ({ problemsOnly, sources, sinceMinutes, limit }) => {
    const params = new URLSearchParams({ problemsOnly: problemsOnly ? "1" : "0", limit: String(limit) });
    if (sources?.length) params.set("sources", sources.join(","));
    if (sinceMinutes) params.set("since", new Date(Date.now() - sinceMinutes * 60_000).toISOString());
    return text(fmtEvents(await call<AlertEvent[]>("GET", `/api/alerts?${params}`)));
  },
);

server.registerTool(
  "tail_log",
  {
    title: "Tail a log",
    description: "Last N raw lines of one log source (minecraft = Paper server via journald; jellyfin/directus/postgres = container logs; system = journald warnings+).",
    inputSchema: { source: z.enum(LOG_SOURCES), lines: z.number().int().min(1).max(1000).default(200) },
  },
  async ({ source, lines }) => {
    const events = await call<AlertEvent[]>("GET", `/api/alerts?sources=${source}&limit=${lines}`);
    return text(events.map((e) => e.text).join("\n") || "(empty)");
  },
);

server.registerTool(
  "server_status",
  { title: "Server status", description: "Health of every service (dashboard, Tailscale, Jellyfin, Minecraft, Directus, PostgreSQL) plus Minecraft details (systemd unit, players, RCON).", inputSchema: {} },
  async () => {
    const [status, minecraft] = await Promise.all([call("GET", "/api/status"), call("GET", "/api/minecraft")]);
    return text({ status, minecraft });
  },
);

server.registerTool("storage", { title: "Storage", description: "Filesystem usage (df) and measured folder sizes (du).", inputSchema: {} }, async () => text(await call("GET", "/api/storage")));

server.registerTool(
  "storage_scan",
  {
    title: "Disk scans (TreeSize engine)",
    description: "Status of the ncdu/gdu disk scans the explorer is built on: engine, scanned roots, totals, when each finished. Pass root to start (or re-run) a scan of that filesystem/folder; scans run one at a time in the background.",
    inputSchema: { root: z.string().optional().describe("start a scan of this folder (absolute path); omit to just read status") },
  },
  async ({ root }) => text(root ? await call("POST", "/api/storage/scan", { root }) : await call("GET", "/api/storage/scan")),
);

server.registerTool(
  "storage_tree",
  {
    title: "Storage explorer: one folder",
    description: "TreeSize-style view of a folder from the last scan: its total, every sub-folder with size / file count / newest change, the largest files in the whole subtree, and (top 3 levels) size by file type, by age and by owner. Drill down by calling it with a sub-folder path. 404 = no scan covers it yet (use storage_scan).",
    inputSchema: { path: z.string().default("/") },
  },
  async ({ path: p }) => text(await call("GET", `/api/storage/scan/dir?path=${encodeURIComponent(p)}`)),
);

server.registerTool(
  "storage_largest",
  { title: "Largest files", description: "The biggest files under a path according to the last scan, largest first, with modification time and owner where the engine reports them.", inputSchema: { path: z.string().default("/"), limit: z.number().int().min(1).max(200).default(40) } },
  async ({ path: p, limit }) => text(await call("GET", `/api/storage/scan/top?path=${encodeURIComponent(p)}&limit=${limit}`)),
);

server.registerTool(
  "storage_reclaim",
  { title: "Reclaimable space", description: "Where space can be freed safely (unused Docker images/build cache/volumes, journald, apt cache, old snap revisions, old dashboard backups, Minecraft log archives, trash, tmp, core dumps) with the command a human would run. Nothing is deleted by this tool.", inputSchema: {} },
  async () => text(await call("GET", "/api/storage/reclaim")),
);

server.registerTool(
  "vpn_status",
  { title: "VPN status", description: "Is the VPN up, provider/protocol, exit IP and location, handshake, DNS, and which services bypass it (Minecraft, Jellyfin, Tailscale…) with evidence and advice. Includes raw routing/firewall diagnostics.", inputSchema: {} },
  async () => text(await call("GET", "/api/vpn?refresh=1")),
);

// ---- act --------------------------------------------------------------------

server.registerTool(
  "minecraft_rcon",
  { title: "Run a Minecraft console command", description: "Send a command to the Paper server over RCON (e.g. list, say hello, whitelist add Name, save-all, tps) and return its output.", inputSchema: { command: z.string().min(1).max(500) } },
  async ({ command }) => {
    try {
      return text((await call<{ output: string }>("POST", "/api/minecraft/command", { command })).output || "(no output)");
    } catch (e) {
      if (/Approval required/.test((e as Error).message)) return text(`NOT RUN. ${(e as Error).message}`);
      throw e;
    }
  },
);

server.registerTool(
  "minecraft_service",
  {
    title: "Start / stop / restart Minecraft",
    description: "Control the Paper server's systemd unit. Players are disconnected immediately on stop/restart — warn them with minecraft_rcon `say …` first if any are online. When the sidecar requires approval, stop/restart return NOT RUN with an approval request: end your turn and the dashboard resumes you with the owner's decision.",
    inputSchema: { action: z.enum(["start", "stop", "restart"]), reason: z.string().max(500).optional().describe("why — shown to the owner if approval is needed") },
  },
  async ({ action, reason }) => {
    try {
      await call("POST", "/api/minecraft/action", { action, reason });
      return text(`Minecraft ${action} requested. Check server_status in ~30 s.`);
    } catch (e) {
      if (/Approval required/.test((e as Error).message)) return text(`NOT RUN. ${(e as Error).message}`);
      throw e;
    }
  },
);

server.registerTool(
  "apps_status",
  { title: "Database apps & tunnel", description: "The Directus-per-app platform: every app (fam, ai, …) with its Directus health locally and through the Cloudflare Tunnel, its own Postgres database size / collections / users / newest dump, the tunnel's connection state, every database on the Postgres core, and whether 5432 is bound to loopback only. Read-only.", inputSchema: { refresh: z.boolean().default(false) } },
  async ({ refresh }) => text(await call("GET", `/api/apps${refresh ? "?refresh=1" : ""}`)),
);

server.registerTool(
  "staged_updates",
  { title: "Staged Paper / plugin updates", description: "Installed Paper build and every plugin's version (from the jars), what is staged in the update folder for the next restart, and the latest upstream release (PaperMC, Modrinth, Hangar, GitHub) with release dates; plus when the update/restart job runs next. Read-only.", inputSchema: { refresh: z.boolean().default(false).describe("re-read jars and re-query upstream now") } },
  async ({ refresh }) => text(await call("GET", `/api/updates${refresh ? "?refresh=1" : ""}`)),
);

// ---- sidecar: incidents & approvals (issue #5) ---------------------------------------

server.registerTool(
  "request_approval",
  {
    title: "Ask the owner for approval",
    description: "Before a risky step (restart/stop, destructive RCON, deleting files, changing timers) ask the owner. Returns immediately with the request id; the owner answers in the dashboard and the sidecar resumes you with the decision — so after calling this, STOP and end your turn. If a matching approval was already granted, the gated tool simply works.",
    inputSchema: { action: z.string().min(1).max(80).describe('short id, e.g. "minecraft_service:restart", "rcon:stop", "delete:old-backups"'), reason: z.string().min(1).max(1000).describe("what you want to do and why, in plain words"), incidentId: z.string().max(40).optional() },
  },
  async ({ action, reason, incidentId }) => {
    const a = await call<{ id: string; status: string }>("POST", "/api/sidecar/approvals", { action, reason, incidentId });
    return text(`Approval ${a.id} is ${a.status} for "${action}". End your turn now; the dashboard will resume you when the owner decides.`);
  },
);

server.registerTool("list_incidents", { title: "List incidents", description: "Incidents the sidecar has grouped from the alerts feed (open first): id, status, title, count, first/last seen, linked runs/reports/approvals.", inputSchema: { all: z.boolean().default(false).describe("include resolved/dismissed older than 48 h") } }, async ({ all }) =>
  text(await call("GET", `/api/sidecar/incidents?limit=50${all ? "&all=1" : ""}`)),
);

server.registerTool("get_incident", { title: "Get one incident", description: "Full detail of an incident incl. the raw sample lines.", inputSchema: { id: z.string().min(1).max(40) } }, async ({ id }) => text(await call("GET", `/api/sidecar/incidents/${encodeURIComponent(id)}`)));

server.registerTool("list_scripts", { title: "List maintenance scripts", description: "Scripts in the dashboard's scripts folder (*.py, *.sh) with their last run.", inputSchema: {} }, async () => text(await call("GET", "/api/scripts")));

server.registerTool(
  "run_script",
  {
    title: "Run a maintenance script",
    description: "Run one of the listed scripts and wait for it to finish (output streams into the alerts feed as it runs). Returns exit code and the last lines of output.",
    inputSchema: { name: z.string().regex(/^[\w.-]+\.(py|sh)$/), waitSeconds: z.number().int().min(5).max(3600).default(600) },
  },
  async ({ name, waitSeconds }) => {
    const run = await call<{ id: string; startedAt: string }>("POST", `/api/scripts/${encodeURIComponent(name)}/run`);
    const deadline = Date.now() + waitSeconds * 1000;
    let finished: { exitCode: number | null; finishedAt: string | null; lines: number } | undefined;
    while (Date.now() < deadline) {
      await sleep(1500);
      const runs = await call<{ id: string; exitCode: number | null; finishedAt: string | null; lines: number }[]>("GET", "/api/scripts/runs?limit=50");
      const r = runs.find((x) => x.id === run.id);
      if (r?.finishedAt) {
        finished = r;
        break;
      }
    }
    const events = await call<AlertEvent[]>("GET", `/api/alerts?sources=scripts&since=${encodeURIComponent(run.startedAt)}&limit=400`);
    const mine = events.filter((e) => e.meta?.runId === run.id).map((e) => e.text);
    const head = finished ? `${name} exited ${finished.exitCode} (${finished.lines} lines)` : `${name} still running after ${waitSeconds}s — output so far:`;
    return text(`${head}\n\n${mine.slice(-200).join("\n")}`);
  },
);

server.registerTool("list_jobs", { title: "List scheduled jobs", description: "Scheduled maintenance jobs (restart with countdown, backup, RCON command, script) with next/last run.", inputSchema: {} }, async () => text(await call("GET", "/api/jobs")));

server.registerTool("run_job", { title: "Run a scheduled job now", description: "Trigger a job immediately by id (from list_jobs). Returns the run record; follow progress with get_alerts.", inputSchema: { id: z.string().uuid() } }, async ({ id }) =>
  text(await call("POST", `/api/jobs/${id}/run`)),
);

server.registerTool("run_backup", { title: "Back up the Minecraft worlds now", description: "save-off → save-all flush → tar.gz the worlds → save-on, then prune old backups. Waits for completion.", inputSchema: {} }, async () => text(await call("POST", "/api/backups")));

server.registerTool("list_backups", { title: "List world backups", description: "Existing world backup archives with size and date.", inputSchema: {} }, async () => text(await call("GET", "/api/backups")));

// ---- instructions & context --------------------------------------------------

interface Ctx {
  path: string;
  content: string;
  hash: string;
}

server.registerTool(
  "read_instructions",
  { title: "Read Minecraft instructions & context", description: "The Minecraft server operational context the owner maintains for agents. Read it before taking action on alerts or repairs.", inputSchema: {} },
  async () => {
    const c = await call<Ctx>("GET", "/api/context");
    return text(`# ${c.path}\n\n${c.content}`);
  },
);

server.registerTool(
  "update_instructions",
  {
    title: "Replace Minecraft instructions & context",
    description: "Overwrite the whole Minecraft instructions file. Every change is versioned in the dashboard's change log with your name and the note. Prefer append_instructions for small additions.",
    inputSchema: { content: z.string().max(512 * 1024), note: z.string().max(200).default("Updated by agent") },
  },
  async ({ content, note }) => {
    const cur = await call<Ctx>("GET", "/api/context");
    const next = await call<Ctx>("PUT", "/api/context", { content, baseHash: cur.hash, note });
    return text(`Saved (${next.hash}).`);
  },
);

server.registerTool(
  "append_instructions",
  { title: "Append to Minecraft instructions & context", description: "Add a note, decision or lesson to the end of the Minecraft instructions file (versioned in the change log).", inputSchema: { text: z.string().min(1).max(20_000), note: z.string().max(200).default("Appended by agent") } },
  async ({ text: addition, note }) => {
    const cur = await call<Ctx>("GET", "/api/context");
    const content = `${cur.content.replace(/\s*$/, "")}\n\n${addition.trim()}\n`;
    const next = await call<Ctx>("PUT", "/api/context", { content, baseHash: cur.hash, note });
    return text(`Appended (${next.hash}).`);
  },
);

// ---- maintenance reports -------------------------------------------------------

server.registerTool(
  "submit_report",
  {
    title: "File a maintenance report",
    description:
      "After you investigate or fix something, file a brief report for the owner to review later: what you saw, what you did, and anything a human should follow up on. Keep it short; it appears on the dashboard's Maintenance reports card and in the alerts feed.",
    inputSchema: {
      title: z.string().min(1).max(120).describe("one line, e.g. 'Restarted after memory leak in plugin X'"),
      summary: z.string().min(1).max(2000).describe("what happened and why it mattered"),
      actionsTaken: z.string().max(3000).optional().describe("bullet list of what you changed or ran"),
      followUp: z.string().max(2000).optional().describe("anything a human should decide or check"),
      contextSuggestions: z.string().max(2000).optional().describe("changes you suggest to the instructions & context file (not applied automatically)"),
      incidentId: z.string().max(40).optional().describe("the sidecar incident this report answers (from your prompt or list_incidents)"),
      outcome: z.enum(["fixed", "no-action", "needs-human"]).optional().describe("fixed = you changed/repaired something; no-action = checked, left alone; needs-human = the owner must decide. Counted as a repair on the dashboard only when fixed."),
    },
  },
  async ({ title, summary, actionsTaken, followUp, contextSuggestions, incidentId, outcome }) => {
    const body = [`Summary: ${summary.trim()}`, actionsTaken ? `Actions taken:\n${actionsTaken.trim()}` : "", followUp ? `Follow-up for a human:\n${followUp.trim()}` : "", contextSuggestions ? `Suggested context updates:\n${contextSuggestions.trim()}` : ""].filter(Boolean).join("\n\n");
    const r = await call<{ id: string }>("POST", "/api/reports", { title, body, incidentId, outcome });
    return text(`Report filed (${r.id})${incidentId ? ` for incident #${incidentId}` : ""}.`);
  },
);

server.registerTool("list_reports", { title: "List maintenance reports", description: "Previous reports filed by agents, newest first, with whether the owner has reviewed them.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) } }, async ({ limit }) =>
  text(await call("GET", `/api/reports?limit=${limit}`)),
);

// ---- resources ---------------------------------------------------------------

server.registerResource("instructions", "homelab://instructions", { title: "Minecraft instructions & context", mimeType: "text/markdown" }, async (uri) => {
  const c = await call<Ctx>("GET", "/api/context");
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: c.content }] };
});

server.registerResource("recent-alerts", "homelab://alerts/recent", { title: "Recent problems & maintenance", mimeType: "text/plain" }, async (uri) => {
  const events = await call<AlertEvent[]>("GET", "/api/alerts?problemsOnly=1&limit=200");
  return { contents: [{ uri: uri.href, mimeType: "text/plain", text: fmtEvents(events) }] };
});

// ---- start -------------------------------------------------------------------

if (!KEY) console.error("[homelab-mcp] HOMELAB_KEY is not set; the dashboard will reject every call.");
await server.connect(new StdioServerTransport());
console.error(`[homelab-mcp] connected to ${BASE}`);

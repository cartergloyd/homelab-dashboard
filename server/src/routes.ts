import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { ALERT_SOURCE_IDS, cfg } from "./config.js";
import { HttpError } from "./errors.js";
import type { Identity } from "./auth.js";
import * as files from "./services/files.js";
import * as jellyfin from "./services/jellyfin.js";
import { directusHealth } from "./services/directus.js";
import { pgStats } from "./services/postgres.js";
import { getPlayers, minecraftAction, minecraftCommand, minecraftStatus } from "./services/minecraft.js";
import * as sched from "./services/scheduler.js";
import { deleteBackup, listBackups, runBackup } from "./services/backups.js";
import { filesystems, reclaimable, refreshFolders, storage } from "./services/storage.js";
import { cancelScan, dirView, overview as scanOverview, startScan, topFiles } from "./services/diskscan.js";
import { stagedUpdates } from "./services/updates.js";
import { appsStatus } from "./services/apps.js";
import { tailscaleStatus } from "./services/tailscale.js";
import { getStatus } from "./services/status.js";
import { LOG_SOURCES } from "./services/logs.js";
import { getRules, listAgents, publish, query, summary, touchAgent } from "./services/alerts.js";
import { listRuns as listScriptRuns, listScripts, startScript } from "./services/scripts.js";
import { getVersion, listHistory, readContext, restoreVersion, writeContext } from "./services/context.js";
import { addReport, listReports, setReviewed } from "./services/reports.js";
import { vpnStatus } from "./services/vpn.js";
import { launchAgent, listAgentRuns } from "./services/agentRunner.js";
import * as sidecar from "./services/sidecar.js";
import type { AgentRunner, AlertSource, AppConfigPayload, DatabasePayload, OverviewPayload } from "./types.js";

export const api = express.Router();

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const user = (res: Response): Identity => res.locals.user as Identity;

/** Records who did what: agents (via key) to presence + feed, humans straight to the feed. */
function logAction(res: Response, action: string): void {
  const u = user(res);
  if (u.viaKey) touchAgent(u.name, action);
  else publish({ source: "dashboard", kind: "log", level: "info", tags: ["maintenance"], text: `${u.name}: ${action}` });
}

// ---- app -----------------------------------------------------------------

api.get("/health", (_req, res) => {
  res.json({ ok: true, demo: cfg.demo, uptime: process.uptime() });
});

api.get("/config", (_req, res) => {
  const u = user(res);
  const payload: AppConfigPayload = {
    demo: cfg.demo,
    user: { login: u.login, name: u.name, via: u.via },
    links: { jellyfin: cfg.jellyfin.publicUrl, directus: cfg.directus.publicUrl, qbittorrent: cfg.qbittorrent.publicUrl },
    mediaRoots: cfg.mediaRoots.map((r) => r.name),
    timezone: cfg.timezone,
    logSources: LOG_SOURCES,
    alertSources: ALERT_SOURCE_IDS,
    scriptsDirs: cfg.scriptsDirs,
    contextFile: cfg.contextFile,
    mcpScript: path.join(cfg.repoRoot, "server", "dist", "mcp.js"),
    mcpLocalUrl: `http://127.0.0.1:${cfg.port}`,
    ...(u.viaKey || !cfg.dashboardKey ? {} : { dashboardKey: cfg.dashboardKey }),
  };
  res.json(payload);
});

api.get("/status", async (_req, res) => {
  res.json(await getStatus());
});

api.get("/overview", async (_req, res) => {
  const [status, mc, jf, fsList, ts] = await Promise.all([
    getStatus(),
    minecraftStatus().catch(() => null),
    jellyfin.overview().catch(() => null),
    filesystems().catch(() => []),
    tailscaleStatus(),
  ]);
  const payload: OverviewPayload = {
    status,
    minecraft: { players: mc?.players ?? null, active: mc?.unit?.active ?? (mc?.ping ? "active" : null) },
    jellyfin: { sessions: jf?.sessions.length ?? 0, playing: jf?.sessions.filter((s) => s.nowPlaying).length ?? 0 },
    storage: fsList,
    tailscale: { online: ts.peers.filter((p) => p.online).length, total: ts.peers.length },
    nextJob: sched.nextScheduled(),
  };
  res.json(payload);
});

// ---- jellyfin ------------------------------------------------------------

api.get("/jellyfin", async (_req, res) => {
  res.json(await jellyfin.overview());
});

api.post("/jellyfin/refresh", async (_req, res) => {
  await jellyfin.refreshLibrary();
  logAction(res, "started a Jellyfin library scan");
  res.json({ ok: true });
});

api.post("/jellyfin/restart", async (_req, res) => {
  await jellyfin.restart();
  logAction(res, "restarted the Jellyfin container");
  res.json({ ok: true });
});

// ---- files ---------------------------------------------------------------

api.get("/files/roots", (_req, res) => {
  res.json(cfg.mediaRoots.map((r) => r.name));
});

api.get("/files/list", async (req, res) => {
  res.json(await files.listDir(str(req.query.root), str(req.query.path)));
});

const FileOp = z.object({ root: z.string(), path: z.string().default("") });

api.post("/files/mkdir", async (req, res) => {
  const body = FileOp.extend({ name: z.string() }).parse(req.body);
  await files.makeDir(body.root, body.path, body.name);
  res.json({ ok: true });
});

api.post("/files/rename", async (req, res) => {
  const body = FileOp.extend({ newName: z.string() }).parse(req.body);
  await files.rename(body.root, body.path, body.newName);
  jellyfin.scheduleLibraryRefresh();
  res.json({ ok: true });
});

api.post("/files/move", async (req, res) => {
  const body = FileOp.extend({ dest: z.string() }).parse(req.body);
  await files.move(body.root, body.path, body.dest);
  jellyfin.scheduleLibraryRefresh();
  res.json({ ok: true });
});

api.post("/files/delete", async (req, res) => {
  const body = FileOp.parse(req.body);
  await files.remove(body.root, body.path);
  jellyfin.scheduleLibraryRefresh();
  res.json({ ok: true });
});

type UploadReq = Request & { uploadDir?: string };

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, (req as UploadReq).uploadDir ?? ""),
    filename: (req, file, cb) => {
      const name = path.basename(file.originalname);
      if (!files.isSafeName(name)) return cb(new HttpError(400, `Invalid file name "${name}"`), "");
      if (fs.existsSync(path.join((req as UploadReq).uploadDir ?? "", name))) return cb(new HttpError(409, `${name} already exists`), "");
      cb(null, name);
    },
  }),
  limits: { fileSize: 64 * 1024 ** 3, files: 50 },
});

api.post(
  "/files/upload",
  async (req, _res, next) => {
    const dest = await files.resolveSafe(str(req.query.root), str(req.query.path));
    if (!fs.statSync(dest.abs).isDirectory()) throw new HttpError(400, "Upload target is not a folder");
    (req as UploadReq).uploadDir = dest.abs;
    next();
  },
  upload.array("files", 50),
  (req, res) => {
    const uploaded = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => f.filename);
    if (uploaded.length) jellyfin.scheduleLibraryRefresh();
    res.json({ uploaded });
  },
);

// ---- database ------------------------------------------------------------

// Directus-per-app platform + Cloudflare Tunnel + Postgres core (read-only)
api.get("/apps", async (req, res) => {
  res.json(await appsStatus(req.query.refresh === "1"));
});

api.get("/database", async (_req, res) => {
  const [directus, postgres] = await Promise.all([directusHealth(), pgStats()]);
  const payload: DatabasePayload = { directus, postgres };
  res.json(payload);
});

// ---- minecraft -----------------------------------------------------------

api.get("/minecraft", async (_req, res) => {
  res.json(await minecraftStatus());
});

api.get("/minecraft/players", async (_req, res) => {
  res.json(await getPlayers());
});

api.post("/minecraft/action", async (req, res) => {
  const { action, reason } = z.object({ action: z.enum(["start", "stop", "restart"]), reason: z.string().max(500).optional() }).parse(req.body);
  // agents need the owner's approval for stop/restart when the sidecar says so (issue #5)
  if (action !== "start") await sidecar.gate(`minecraft_service:${action}`, user(res), reason ?? `${action} the Minecraft server`);
  logAction(res, `${action} Minecraft service`);
  await minecraftAction(action);
  res.json({ ok: true });
});

const RISKY_RCON = /^\/?\s*(stop|ban|ban-ip|pardon|deop|op|kill|whitelist\s+(off|remove))\b/i;

api.post("/minecraft/command", async (req, res) => {
  const { command, reason } = z.object({ command: z.string().max(500), reason: z.string().max(500).optional() }).parse(req.body);
  const risky = command.trim().match(RISKY_RCON);
  if (risky) await sidecar.gate(`rcon:${risky[1].toLowerCase().replace(/\s+/g, " ")}`, user(res), reason ?? `RCON: ${command.trim()}`);
  const output = await minecraftCommand(command);
  logAction(res, `RCON: ${command.trim()}`);
  res.json({ output });
});

// ---- maintenance ---------------------------------------------------------

api.get("/jobs", (_req, res) => {
  res.json(sched.listJobs());
});

api.get("/jobs/runs", (req, res) => {
  res.json(sched.listRuns(Number(req.query.limit) || 50));
});

api.post("/jobs", async (req, res) => {
  const job = await sched.createJob(sched.JobInput.parse(req.body));
  logAction(res, `created job "${job.name}"`);
  res.status(201).json(job);
});

api.put("/jobs/:id", async (req, res) => {
  res.json(await sched.updateJob(String(req.params.id), sched.JobInput.partial().parse(req.body)));
});

api.delete("/jobs/:id", async (req, res) => {
  await sched.deleteJob(String(req.params.id));
  res.json({ ok: true });
});

api.post("/jobs/:id/run", (req, res) => {
  const run = sched.runJob(String(req.params.id));
  logAction(res, `ran job "${run.jobName}"`);
  res.status(202).json(run);
});

api.get("/backups", async (_req, res) => {
  res.json(await listBackups());
});

api.post("/backups", async (_req, res) => {
  logAction(res, "started a world backup");
  res.json(await runBackup());
});

// Only backups the dashboard created are deletable (listBackups → deletable).
api.delete("/backups", async (req, res) => {
  const target = str(req.query.path) || str(req.query.name);
  if (!target) throw new HttpError(400, "path is required");
  await deleteBackup(target);
  logAction(res, `deleted backup ${path.basename(target)}`);
  res.json({ ok: true });
});

// ---- scripts -------------------------------------------------------------

api.get("/scripts", async (_req, res) => {
  res.json(await listScripts());
});

api.get("/scripts/runs", (req, res) => {
  res.json(listScriptRuns(Number(req.query.limit) || 50));
});

api.post("/scripts/:name/run", async (req, res) => {
  const name = String(req.params.name);
  const run = await startScript(name, user(res).viaKey ? "agent" : "manual");
  logAction(res, `ran script ${name}`);
  res.status(202).json(run);
});

// ---- alerts --------------------------------------------------------------

api.get("/alerts", (req, res) => {
  const sources = str(req.query.sources)
    ? (str(req.query.sources).split(",").filter((s) => (ALERT_SOURCE_IDS as string[]).includes(s)) as AlertSource[])
    : undefined;
  res.json(
    query({
      sources,
      problemsOnly: req.query.problemsOnly === "1" || req.query.problemsOnly === "true",
      since: str(req.query.since) || undefined,
      limit: Number(req.query.limit) || undefined,
    }),
  );
});

api.get("/alerts/summary", (_req, res) => {
  res.json(summary());
});

api.get("/alerts/rules", (_req, res) => {
  res.json(getRules());
});

api.get("/agents", (_req, res) => {
  res.json(listAgents());
});

api.get("/agents/runs", (req, res) => {
  res.json(listAgentRuns(Number(req.query.limit) || 20));
});

api.post("/agents/launch", async (req, res) => {
  const body = z.object({ runner: z.enum(["codex", "claude"]), task: z.string().trim().max(4000).default("") }).parse(req.body ?? {});
  const run = await launchAgent(body.runner as AgentRunner, body.task);
  logAction(res, `launched ${body.runner} agent`);
  res.status(201).json(run);
});

/**
 * Streams a terminal script's output into the feed, one event per line.
 * Used by scripts/hl-run.sh: `... | curl -T - .../api/alerts/ingest?label=name`
 */
api.post("/alerts/ingest", (req, res) => {
  const label = (str(req.query.label) || "terminal").slice(0, 80);
  const meta = { label, agent: user(res).viaKey ? user(res).name : undefined };
  let lines = 0;
  publish({ source: "scripts", kind: "script", level: "info", tags: ["maintenance"], text: `▶ ${label} started (terminal)`, meta });
  const rl = readline.createInterface({ input: req });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    lines++;
    publish({ source: "scripts", kind: "script", text: line, meta });
  });
  rl.on("close", () => {
    publish({ source: "scripts", kind: "script", level: "info", tags: ["maintenance"], text: `■ ${label} finished (${lines} lines)`, meta });
    res.json({ ok: true, lines });
  });
});

/** hl-run.sh posts the wrapped command's exit code here after its output stream closes. */
api.post("/alerts/ingest/exit", (req, res) => {
  const label = (str(req.query.label) || "terminal").slice(0, 80);
  const code = Number(req.query.code);
  const ok = code === 0;
  publish({
    source: "scripts",
    kind: "script",
    level: ok ? "info" : "error",
    tags: ["maintenance"],
    text: `${ok ? "✔" : "✖"} ${label} exited ${Number.isFinite(code) ? code : "?"} (terminal)`,
    meta: { label, exitCode: Number.isFinite(code) ? code : null },
  });
  res.json({ ok: true });
});

// ---- instructions & context (CLAUDE.md) ---------------------------------

const author = (res: Response) => (user(res).viaKey ? user(res).name : user(res).login);

api.get("/context", async (_req, res) => {
  res.json(await readContext());
});

api.put("/context", async (req, res) => {
  const body = z.object({ content: z.string().max(512 * 1024), baseHash: z.string().optional(), note: z.string().max(200).default("") }).parse(req.body);
  const result = await writeContext(body.content, body.baseHash, author(res), body.note);
  if (user(res).viaKey) touchAgent(user(res).name, `updated instructions${body.note ? `: ${body.note}` : ""}`);
  res.json(result);
});

api.get("/context/history", async (_req, res) => {
  res.json(await listHistory());
});

api.get("/context/history/:id", async (req, res) => {
  res.json(await getVersion(String(req.params.id)));
});

api.post("/context/history/:id/restore", async (req, res) => {
  res.json(await restoreVersion(String(req.params.id), author(res)));
});

// ---- maintenance reports (agents write, humans review) -------------------

api.get("/reports", (req, res) => {
  res.json(listReports(Number(req.query.limit) || 50, req.query.unreviewed !== "1"));
});

api.post("/reports", async (req, res) => {
  const body = z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(8000), incidentId: z.string().trim().max(40).optional(), runId: z.string().trim().max(60).optional(), outcome: z.enum(["fixed", "no-action", "needs-human"]).optional() }).parse(req.body);
  const u = user(res);
  res.status(201).json(await addReport(u.viaKey ? u.name : u.name || u.login, body.title, body.body, { incidentId: body.incidentId ?? null, runId: body.runId ?? null, outcome: body.outcome ?? null }));
});

// ---- assistant sidecar (issue #5) ---------------------------------------------

api.get("/sidecar", (_req, res) => {
  res.json(sidecar.getPayload());
});

api.put("/sidecar/settings", async (req, res) => {
  const patch = z
    .object({
      enabled: z.boolean().optional(),
      runner: z.enum(["codex", "claude"]).optional(),
      autoTrigger: z.boolean().optional(),
      requireApproval: z.boolean().optional(),
      cooldownMinutes: z.number().int().min(1).max(1440).optional(),
      quietSeconds: z.number().int().min(0).max(600).optional(),
      maxRunMinutes: z.number().int().min(1).max(180).optional(),
    })
    .parse(req.body ?? {});
  res.json(await sidecar.updateSettings(patch, user(res).name));
});

api.get("/sidecar/conversation", (req, res) => {
  res.json(sidecar.getConversation(Math.min(500, Number(req.query.limit) || 100)));
});

api.post("/sidecar/chat", (req, res) => {
  const body = z.object({ text: z.string().trim().min(1).max(4000), alertId: z.string().optional() }).parse(req.body);
  const alert = body.alertId ? (query({ limit: 5000 }).find((e) => e.id === body.alertId) ?? null) : null;
  const turn = sidecar.chat(body.text, user(res).name, alert);
  logAction(res, `asked the assistant: ${body.text.slice(0, 80)}`);
  res.status(201).json(turn);
});

api.get("/sidecar/incidents", (req, res) => {
  res.json(sidecar.listIncidents(Math.min(200, Number(req.query.limit) || 40), req.query.all === "1"));
});

api.get("/sidecar/incidents/:id", (req, res) => {
  res.json(sidecar.getIncident(String(req.params.id)));
});

api.post("/sidecar/incidents/:id/investigate", (req, res) => {
  const inc = sidecar.investigateIncident(String(req.params.id), user(res).name);
  logAction(res, `asked the assistant to investigate incident #${inc.id}`);
  res.json(inc);
});

api.post("/sidecar/incidents/:id/dismiss", (req, res) => {
  const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
  res.json(sidecar.dismissIncident(String(req.params.id), user(res).name, note));
});

api.post("/sidecar/incidents/:id/resolve", (req, res) => {
  const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
  res.json(sidecar.resolveIncident(String(req.params.id), user(res).name, note));
});

/** Incidents the agent reported on, with what it did — the Repairs list behind the Assistant tile. */
api.get("/sidecar/repairs", (req, res) => {
  res.json(sidecar.repairs(Math.min(300, Number(req.query.limit) || 100)));
});

api.get("/sidecar/approvals", (req, res) => {
  res.json(sidecar.listApprovals(req.query.all === "1"));
});

/** Agents ask here (MCP request_approval); the owner answers below. */
api.post("/sidecar/approvals", async (req, res) => {
  const body = z.object({ action: z.string().trim().min(1).max(80), reason: z.string().trim().min(1).max(1000), incidentId: z.string().trim().max(40).optional() }).parse(req.body);
  const u = user(res);
  res.status(201).json(await sidecar.requestApproval(body.action, body.reason, u.name, null, body.incidentId ?? null));
});

api.post("/sidecar/approvals/:id", async (req, res) => {
  const { decision } = z.object({ decision: z.enum(["approve", "deny"]) }).parse(req.body);
  const a = await sidecar.decideApproval(String(req.params.id), decision, user(res).name);
  res.json(a);
});

// [DEMO] demo-only endpoint: publishes a fake error so the sidecar loop can be watched; refused unless DEMO=1 (see DEMO_INDEX.md)
api.post("/sidecar/simulate", (req, res) => {
  const { kind, text } = z.object({ kind: z.enum(["exception", "warn", "job", "custom"]).default("exception"), text: z.string().max(40_000).optional() }).parse(req.body ?? {});
  res.status(201).json(sidecar.simulateIncident(kind, text));
});

api.post("/reports/:id/review", async (req, res) => {
  const { reviewed } = z.object({ reviewed: z.boolean().default(true) }).parse(req.body ?? {});
  res.json(await setReviewed(String(req.params.id), user(res).name, reviewed));
});

// ---- storage / tailscale / logs -----------------------------------------

api.get("/storage", async (_req, res) => {
  res.json(await storage());
});

api.post("/storage/refresh", async (_req, res) => {
  void refreshFolders();
  res.status(202).json({ ok: true });
});

// Storage explorer (issue #4): ncdu/gdu/du scans of whole filesystems, browsed from
// memory. GET /storage/scan lists engines, roots and scan status; POST starts one.
api.get("/storage/scan", async (_req, res) => {
  res.json(await scanOverview());
});

api.post("/storage/scan", async (req, res) => {
  const { root } = z.object({ root: z.string().trim().min(1).max(1024).optional() }).parse(req.body ?? {});
  const target = root ?? (await scanOverview()).roots[0] ?? "/";
  logAction(res, `started a disk scan of ${target}`);
  res.status(202).json(await startScan(target));
});

api.delete("/storage/scan", (_req, res) => {
  res.json({ cancelled: cancelScan() });
});

api.get("/storage/scan/dir", (req, res) => {
  res.json(dirView(str(req.query.path) || "/", str(req.query.root) || undefined));
});

api.get("/storage/scan/top", (req, res) => {
  res.json(topFiles(str(req.query.path) || "/", Math.min(200, Number(req.query.limit) || 40), str(req.query.root) || undefined));
});

// Staged update widget: installed vs staged vs upstream Paper/plugin versions (read-only).
api.get("/updates", async (req, res) => {
  res.json(await stagedUpdates(req.query.refresh === "1"));
});

api.get("/storage/reclaim", async (req, res) => {
  res.json(await reclaimable(req.query.refresh === "1"));
});

api.get("/tailscale", async (_req, res) => {
  res.json(await tailscaleStatus());
});

api.get("/vpn", async (req, res) => {
  res.json(await vpnStatus(req.query.refresh === "1"));
});

api.get("/logs/sources", (_req, res) => {
  res.json(LOG_SOURCES);
});

api.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

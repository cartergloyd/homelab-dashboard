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
import { filesystems, refreshFolders, storage } from "./services/storage.js";
import { tailscaleStatus } from "./services/tailscale.js";
import { getStatus } from "./services/status.js";
import { LOG_SOURCES } from "./services/logs.js";
import { getRules, listAgents, publish, query, summary, touchAgent } from "./services/alerts.js";
import { listRuns as listScriptRuns, listScripts, startScript } from "./services/scripts.js";
import { getVersion, listHistory, readContext, restoreVersion, writeContext } from "./services/context.js";
import { addReport, listReports, setReviewed } from "./services/reports.js";
import { vpnStatus } from "./services/vpn.js";
import type { AlertSource, AppConfigPayload, DatabasePayload, OverviewPayload } from "./types.js";

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
    user: { login: u.login, name: u.name },
    links: { jellyfin: cfg.jellyfin.publicUrl, directus: cfg.directus.publicUrl },
    mediaRoots: cfg.mediaRoots.map((r) => r.name),
    timezone: cfg.timezone,
    logSources: LOG_SOURCES,
    alertSources: ALERT_SOURCE_IDS,
    scriptsDirs: cfg.scriptsDirs,
    contextFile: cfg.contextFile,
    mcpScript: path.join(cfg.repoRoot, "server", "dist", "mcp.js"),
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
  const { action } = z.object({ action: z.enum(["start", "stop", "restart"]) }).parse(req.body);
  logAction(res, `${action} Minecraft service`);
  await minecraftAction(action);
  res.json({ ok: true });
});

api.post("/minecraft/command", async (req, res) => {
  const { command } = z.object({ command: z.string().max(500) }).parse(req.body);
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
  const body = z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(8000) }).parse(req.body);
  const u = user(res);
  res.status(201).json(await addReport(u.viaKey ? u.name : u.name || u.login, body.title, body.body));
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

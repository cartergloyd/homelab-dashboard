import fs from "node:fs";
import path from "node:path";
import express, { type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { cfg } from "./config.js";
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
import type { AppConfigPayload, DatabasePayload, OverviewPayload } from "./types.js";

export const api = express.Router();

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- app -----------------------------------------------------------------

api.get("/health", (_req, res) => {
  res.json({ ok: true, demo: cfg.demo, uptime: process.uptime() });
});

api.get("/config", (_req, res) => {
  const user = res.locals.user as Identity;
  const payload: AppConfigPayload = {
    demo: cfg.demo,
    user,
    links: { jellyfin: cfg.jellyfin.publicUrl, directus: cfg.directus.publicUrl },
    mediaRoots: cfg.mediaRoots.map((r) => r.name),
    timezone: cfg.timezone,
    logSources: LOG_SOURCES,
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
  res.json({ ok: true });
});

api.post("/jellyfin/restart", async (_req, res) => {
  await jellyfin.restart();
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
  await minecraftAction(action);
  res.json({ ok: true });
});

api.post("/minecraft/command", async (req, res) => {
  const { command } = z.object({ command: z.string().max(500) }).parse(req.body);
  res.json({ output: await minecraftCommand(command) });
});

// ---- maintenance ---------------------------------------------------------

api.get("/jobs", (_req, res) => {
  res.json(sched.listJobs());
});

api.get("/jobs/runs", (req, res) => {
  res.json(sched.listRuns(Number(req.query.limit) || 50));
});

api.post("/jobs", async (req, res) => {
  res.status(201).json(await sched.createJob(sched.JobInput.parse(req.body)));
});

api.put("/jobs/:id", async (req, res) => {
  res.json(await sched.updateJob(String(req.params.id), sched.JobInput.partial().parse(req.body)));
});

api.delete("/jobs/:id", async (req, res) => {
  await sched.deleteJob(String(req.params.id));
  res.json({ ok: true });
});

api.post("/jobs/:id/run", (req, res) => {
  res.status(202).json(sched.runJob(String(req.params.id)));
});

api.get("/backups", async (_req, res) => {
  res.json(await listBackups());
});

api.post("/backups", async (_req, res) => {
  res.json(await runBackup());
});

api.delete("/backups/:name", async (req, res) => {
  await deleteBackup(String(req.params.name));
  res.json({ ok: true });
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

api.get("/logs/sources", (_req, res) => {
  res.json(LOG_SOURCES);
});

api.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

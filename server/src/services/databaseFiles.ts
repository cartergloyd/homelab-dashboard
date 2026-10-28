import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";

export const MAX_DATABASE_FILE = 25 * 1024 * 1024;
const fields = "id,title,filename_download,type,filesize,uploaded_on";
const uuid = z.string().uuid();
export const rasterImage = (mime: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(mime);

function targets() {
  const filename = path.join(cfg.dataDir, "database-uploads.json");
  const tokens = fs.existsSync(filename) ? z.record(z.string(), z.string()).parse(JSON.parse(fs.readFileSync(filename, "utf8"))) : {};
  return [
    { id: "personal", label: "Personal database", url: cfg.directus.url },
    ...cfg.apps.filter(a => a.kind === "directus").map(a => ({ id: a.name, label: a.name, url: a.url })),
  ].map(t => ({ ...t, token: tokens[t.id] }));
}

function target(id: string) {
  const t = targets().find(t => t.id === id);
  if (!t) throw new HttpError(404, "Unknown upload database");
  if (!t.token) throw new HttpError(503, "File uploads are not configured for this database");
  return t;
}

async function request(t: ReturnType<typeof target>, endpoint: string, init: RequestInit = {}) {
  const response = await fetch(t.url + endpoint, { ...init, redirect: "error", signal: AbortSignal.timeout(120_000), headers: { Authorization: `Bearer ${t.token}` } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status === 404 ? 404 : 502, `Database file request failed (${response.status}). Try again or check Directus.`);
  }
  return response;
}

export function databaseFileRoutes(logAction: (res: Response, action: string) => void) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DATABASE_FILE, files: 1, fields: 0, parts: 1 } });
  router.get("/targets", (_req, res) => {
    res.json(targets().map(({ id, label, token }) => ({ id, label, enabled: !!token })));
  });
  router.get("/:target", async (req, res) => {
    const t = target(req.params.target);
    const response = await request(t, `/files?fields=${fields}&sort=-uploaded_on&limit=30`);
    const body = await response.json();
    res.setHeader("Cache-Control", "no-store");
    res.json(body.data);
  });
  router.post("/:target", (req, _res, next) => {
    try { target(String(req.params.target)); next(); } catch (e) { next(e); }
  }, (req, res, next) => {
    upload.single("files")(req, res, error => {
      if (error) return next(new HttpError(400, error.code === "LIMIT_FILE_SIZE" ? "Files must be 25 MB or smaller" : "Choose one file at a time"));
      next();
    });
  }, async (req, res) => {
    const t = target(String(req.params.target));
    if (!req.file) throw new HttpError(400, "Choose a file to upload");
    const name = path.basename(req.file.originalname.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
    if (!name || name === "." || name === "..") throw new HttpError(400, "Invalid file name");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }), name);
    const response = await request(t, `/files?fields=${fields}`, { method: "POST", body: form });
    const body = await response.json();
    logAction(res, `uploaded a file to ${t.label}`);
    res.status(201).json(body.data);
  });
  router.get("/:target/:id", async (req, res) => {
    const t = target(req.params.target), id = uuid.parse(req.params.id);
    const metaResponse = await request(t, `/files/${id}?fields=${fields}`);
    const { data } = await metaResponse.json();
    const preview = req.query.preview === "1" && rasterImage(data.type ?? "");
    const response = await request(t, `/assets/${id}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Type", preview ? data.type : "application/octet-stream");
    res.setHeader("Content-Disposition", `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(data.filename_download || "download").replace(/'/g, "%27")}`);
    if (!response.body) throw new HttpError(502, "Empty file response");
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
  });
  return router;
}

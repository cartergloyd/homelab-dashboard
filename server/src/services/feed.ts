// Publish card backend: a zip (or a picked folder) of article.json + media becomes feed items in the ai Directus.
// Format and field reference: docs/feed-uploads.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { request, target } from "./databaseFiles.js";
import { FEED_FOLDER, MIME, cardOf, findItems, localPath, rewriteMedia, validateDoc } from "./feedLib.js";

type FeedReq = Request & { feedRoot?: string };
const run = promisify(execFile);
const uuid = z.string().uuid();
const SITE = "https://www.xgold.tech";
const safeRel = (name: string) => localPath(name.replace(/[\x00-\x1f\x7f]/g, "")) ?? "";

export function feedRoutes(logAction: (res: Response, action: string) => void) {
  const router = express.Router();
  const upload = multer({
    preservePath: true,
    // shortcut: no size cap (owner is the only uploader); videos stream from disk, not memory.
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const rel = safeRel(file.originalname);
        if (!rel) return cb(new HttpError(400, `Bad file path: ${file.originalname}`), "");
        const dir = path.join((req as FeedReq).feedRoot!, path.dirname(rel));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, path.basename(safeRel(file.originalname))),
    }),
    limits: { files: 2000 },
  });

  router.get("/", async (_req, res) => {
    const r = await request(target("ai"), "/items/feed_items?fields=id,section,slug,title,date&sort=-date&limit=200");
    res.setHeader("Cache-Control", "no-store");
    res.json((await r.json()).data);
  });

  router.delete("/:id", async (req, res) => {
    await request(target("ai"), `/items/feed_items/${uuid.parse(req.params.id)}`, { method: "DELETE" });
    logAction(res, "removed a feed item");
    res.status(204).end();
  });

  router.post("/publish", (req, _res, next) => {
    (req as FeedReq).feedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
    next();
  }, upload.array("files"), async (req, res) => {
    const root = (req as FeedReq).feedRoot!;
    try {
      const t = target("ai");
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) throw new HttpError(400, "Choose a zip or a folder");
      if (files.length === 1 && /\.zip$/i.test(files[0].originalname)) {
        const out = path.join(root, "unzipped");
        try { await run("unzip", ["-q", "-o", files[0].path, "-d", out]); } catch { throw new HttpError(400, "That zip could not be opened"); }
        fs.rmSync(files[0].path);
        var itemDirs = findItems(out);
      } else itemDirs = findItems(root);
      if (!itemDirs.length) throw new HttpError(400, "No article.json found. Put one in each item's folder.");

      const results: { slug?: string; section?: string; url?: string; status: string; errors?: string[]; media?: number }[] = [];
      const uploaded = new Map<string, string>();
      for (const dir of itemDirs) {
        const errors: string[] = [];
        let doc: any;
        try { doc = JSON.parse(fs.readFileSync(path.join(dir, "article.json"), "utf8")); } catch (e) { results.push({ status: "failed", errors: [`${path.relative(root, dir) || "."}/article.json is not valid JSON (${(e as Error).message})`] }); continue; }
        errors.push(...validateDoc(doc));
        if (errors.length) { results.push({ slug: doc?.slug, status: "failed", errors }); continue; }
        if (doc.draft) { results.push({ slug: doc.slug, section: doc.section, status: "skipped (draft)" }); continue; }
        let media = 0;
        await rewriteMedia(doc, async rel => {
          const abs = path.join(dir, rel);
          const hit = uploaded.get(abs);
          if (hit) return hit;
          const ext = path.extname(rel).slice(1).toLowerCase();
          if (!MIME[ext]) throw new Error(`${rel}: .${ext} is not a supported file type (${Object.keys(MIME).join(", ")})`);
          if (!fs.existsSync(abs)) throw new Error(`${rel} is referenced in article.json but is not in the upload`);
          const form = new FormData();
          form.append("folder", FEED_FOLDER); // must come before the file
          form.append("file", await fs.openAsBlob(abs, { type: MIME[ext] }), path.basename(rel));
          // shortcut: re-publishing a slug uploads its media again and leaves the old copies; clean up in Directus Studio if it matters.
          const r = await request(t, "/files?fields=id", { method: "POST", body: form }, 15 * 60_000);
          const id = z.string().uuid().parse((await r.json()).data.id);
          uploaded.set(abs, id); media++;
          return id;
        }, errors);
        if (errors.length) { results.push({ slug: doc.slug, status: "failed", errors }); continue; }

        const row = { section: doc.section, slug: doc.slug, title: doc.title, summary: doc.summary, date: doc.date, card: cardOf(doc), doc, updated_at: new Date().toISOString() };
        const existing = await (await request(t, `/items/feed_items?fields=id&filter[section][_eq]=${doc.section}&filter[slug][_eq]=${encodeURIComponent(doc.slug)}`)).json();
        const id: string | undefined = existing.data?.[0]?.id;
        await request(t, id ? `/items/feed_items/${id}` : "/items/feed_items", { method: id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row) });
        logAction(res, `${id ? "updated" : "published"} feed item ${doc.section}/${doc.slug}`);
        results.push({ slug: doc.slug, section: doc.section, url: `${SITE}/${doc.section}.html#${doc.slug}`, status: id ? "updated" : "published", media });
      }
      res.json({ results });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return router;
}

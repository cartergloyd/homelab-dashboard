// Pure helpers for the Research / Solutions feed (see docs/feed-uploads.md). No I/O except findItems.
import fs from "node:fs";
import path from "node:path";

export const FEED_FOLDER = "bafa863f-798e-4f4c-a8f6-616768988dcf"; // deploy/ai-feed.sql, directus-extension-feed-media
export const SECTIONS = ["research", "solutions"];
/** Keys whose string value is a file path inside the item's folder. */
export const MEDIA_KEYS = new Set(["cover", "image", "video", "poster", "file"]);
export const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", pdf: "application/pdf",
};

/** Directories (within three levels of root) that contain an article.json. */
export function findItems(root: string, depth = 0): string[] {
  if (fs.existsSync(path.join(root, "article.json"))) return [root];
  if (depth >= 3) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "__MACOSX")
    .flatMap(e => findItems(path.join(root, e.name), depth + 1));
}

export function validateDoc(doc: any): string[] {
  const errs: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["article.json must be a JSON object"];
  if (!SECTIONS.includes(doc.section)) errs.push(`section must be one of: ${SECTIONS.join(", ")}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(doc.slug ?? "") || doc.slug.length > 100) errs.push("slug must be lowercase letters, digits and hyphens");
  if (typeof doc.title !== "string" || !doc.title.trim()) errs.push("title is required");
  if (typeof doc.summary !== "string" || !doc.summary.trim()) errs.push("summary is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date ?? "") || Number.isNaN(Date.parse(doc.date))) errs.push("date must be YYYY-MM-DD");
  if (doc.body !== undefined && !Array.isArray(doc.body)) errs.push("body must be an array of blocks");
  return errs;
}

const isLocal = (v: string) => !/^(https?:|data:|media:|\/|#)/i.test(v);

/** Normalised relative path inside the item folder, or null when it escapes the folder. */
export function localPath(v: string): string | null {
  const p = path.posix.normalize(v.replace(/\\/g, "/"));
  return p.startsWith("..") || path.posix.isAbsolute(p) ? null : p;
}

/** Walks the document and swaps every local media path for "media:<id>" using upload(). Collects problems instead of throwing. */
export async function rewriteMedia(node: unknown, upload: (rel: string) => Promise<string>, errors: string[]): Promise<void> {
  if (Array.isArray(node)) { for (const n of node) await rewriteMedia(n, upload, errors); return; }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (MEDIA_KEYS.has(k) && typeof v === "string" && isLocal(v)) {
      const rel = localPath(v);
      if (!rel) { errors.push(`${k}: "${v}" points outside the item folder`); continue; }
      try { obj[k] = `media:${await upload(rel)}`; } catch (e) { errors.push((e as Error).message); }
    } else await rewriteMedia(v, upload, errors);
  }
}

/** The few fields a feed card needs, so the list never downloads whole articles. */
export function cardOf(doc: any): Record<string, unknown> {
  const firstImage = Array.isArray(doc.body) ? doc.body.find((b: any) => b && typeof b === "object" && typeof b.image === "string")?.image : undefined;
  const card: Record<string, unknown> = { type: doc.type, area: doc.area, status: doc.status, cover: doc.cover ?? firstImage, hero_stat: doc.hero_stat };
  return Object.fromEntries(Object.entries(card).filter(([, v]) => v !== undefined));
}

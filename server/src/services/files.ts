// File manager over the Jellyfin media roots. Every path the client sends is
// "<root name>" + a relative path; nothing outside a configured root is reachable.
import fs from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { FileEntry, MediaRoot } from "../types.js";

export function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

export interface Resolved {
  root: MediaRoot;
  abs: string;
  rel: string;
}

/** Resolves an existing path inside a root, rejecting traversal and symlink escapes. */
export async function resolveSafe(rootName: string, rel = ""): Promise<Resolved> {
  const root = cfg.mediaRoots.find((r) => r.name === rootName);
  if (!root) throw new HttpError(404, `Unknown media root "${rootName}"`);
  if (rel.includes("\0")) throw new HttpError(400, "Invalid path");

  const segments = rel.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw new HttpError(400, "Path escapes the media root");

  const abs = path.resolve(root.path, ...segments);
  if (abs !== root.path && !abs.startsWith(root.path + path.sep)) throw new HttpError(400, "Path escapes the media root");

  let rootReal: string;
  try {
    rootReal = await fs.realpath(root.path);
  } catch {
    throw new HttpError(500, `Media root ${root.path} is not accessible`);
  }
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw new HttpError(404, "Not found");
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new HttpError(400, "Path escapes the media root");

  return { root, abs, rel: segments.join("/") };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(rootName: string, rel = ""): Promise<{ root: string; path: string; entries: FileEntry[] }> {
  const { root, abs, rel: cleanRel } = await resolveSafe(rootName, rel);
  if (!(await fs.stat(abs)).isDirectory()) throw new HttpError(400, "Not a directory");
  const entries: FileEntry[] = [];
  for (const d of await fs.readdir(abs, { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    try {
      const s = await fs.stat(path.join(abs, d.name));
      entries.push({ name: d.name, type: s.isDirectory() ? "dir" : "file", size: s.isDirectory() ? 0 : s.size, mtime: s.mtime.toISOString() });
    } catch {
      // broken symlink — skip
    }
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.type === "dir" ? -1 : 1,
  );
  return { root: root.name, path: cleanRel, entries };
}

export async function makeDir(rootName: string, rel: string, name: string): Promise<void> {
  if (!isSafeName(name)) throw new HttpError(400, "Invalid folder name");
  const parent = await resolveSafe(rootName, rel);
  await fs.mkdir(path.join(parent.abs, name));
}

export async function rename(rootName: string, rel: string, newName: string): Promise<void> {
  if (!isSafeName(newName)) throw new HttpError(400, "Invalid name");
  const { root, abs } = await resolveSafe(rootName, rel);
  if (abs === root.path) throw new HttpError(400, "Cannot rename a media root");
  const target = path.join(path.dirname(abs), newName);
  if (await exists(target)) throw new HttpError(409, `${newName} already exists`);
  await fs.rename(abs, target);
}

export async function move(rootName: string, rel: string, destRel: string): Promise<void> {
  const src = await resolveSafe(rootName, rel);
  if (src.abs === src.root.path) throw new HttpError(400, "Cannot move a media root");
  const dest = await resolveSafe(rootName, destRel);
  if (!(await fs.stat(dest.abs)).isDirectory()) throw new HttpError(400, "Destination is not a folder");
  const target = path.join(dest.abs, path.basename(src.abs));
  if (target === src.abs) return;
  if (target.startsWith(src.abs + path.sep)) throw new HttpError(400, "Cannot move a folder into itself");
  if (await exists(target)) throw new HttpError(409, `${path.basename(src.abs)} already exists in the destination`);
  await fs.rename(src.abs, target);
}

export async function remove(rootName: string, rel: string): Promise<void> {
  const { root, abs } = await resolveSafe(rootName, rel);
  if (abs === root.path) throw new HttpError(400, "Cannot delete a media root");
  await fs.rm(abs, { recursive: true });
}

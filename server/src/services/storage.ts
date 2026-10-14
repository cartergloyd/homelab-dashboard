// Storage: filesystem capacity (df), measured folder sizes (du), and — issue #4 —
// a TreeSize-style explorer (size of every sub-folder of a path), the largest
// files under a path, and a "reclaimable space" report. Every measurement runs
// in the background with a timeout and is cached; GETs return `measuring: true`
// until the result lands, so the UI/agents poll instead of waiting on `du`.
// Nothing in this module deletes anything.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { HttpError } from "../errors.js";
import { sleep } from "../util.js";
import { listBackups } from "./backups.js";
import { dockerDiskUsage } from "./docker.js";
import type { Filesystem, FolderUsage, LargestFile, LargestPayload, ReclaimItem, ReclaimPayload, StoragePayload, StorageTreePayload, TreeEntry } from "../types.js";

const execFileP = promisify(execFile);
const TTL_MS = 15 * 60_000;
const EXPLORER_TTL_MS = 10 * 60_000;
const DU_TIMEOUT = 15 * 60_000;
const BLOCKED = /^\/(proc|sys|dev|run)(\/|$)/;

let folderCache: { folders: FolderUsage[]; refreshedAt: string | null } = { folders: [], refreshedAt: null };
let refreshing: Promise<void> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref())]);
}

/** Runs a measuring tool; tools like du/find exit 1 on unreadable entries but still print, so keep partial stdout. */
async function measure(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; partial: boolean; failed: boolean }> {
  try {
    const r = await execFileP(cmd, args, { timeout, maxBuffer: 64 << 20, killSignal: "SIGKILL" });
    return { stdout: r.stdout, partial: r.stderr.trim().length > 0, failed: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; code?: string };
    if (err.code === "ENOENT") return { stdout: "", partial: false, failed: true };
    return { stdout: err.stdout ?? "", partial: true, failed: !err.stdout };
  }
}

// ---- filesystems + folder sizes (original) ---------------------------------------

let fsCache: { at: number; rows: Filesystem[] } | null = null;

export async function filesystems(): Promise<Filesystem[]> {
  if (cfg.demo) return demo.filesystems();
  if (fsCache && Date.now() - fsCache.at < 30_000) return fsCache.rows;
  const { stdout } = await execFileP("df", ["-kP"], { timeout: 10_000 });
  const rows: Filesystem[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    const [, filesystem, total, used, avail, , mount] = m;
    if (!filesystem.startsWith("/dev/")) continue; // skip tmpfs, overlay, snaps, etc.
    const totalBytes = Number(total) * 1024;
    const usedBytes = Number(used) * 1024;
    rows.push({
      filesystem,
      mount,
      totalBytes,
      usedBytes,
      availBytes: Number(avail) * 1024,
      usedPct: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    });
  }
  fsCache = { at: Date.now(), rows };
  return rows;
}

function targets(): { label: string; path: string }[] {
  return [
    ...cfg.mediaRoots.map((r) => ({ label: r.name, path: r.path })),
    { label: "Minecraft server", path: cfg.minecraft.dir },
    ...cfg.backups.dirs.map((d, i) => ({ label: cfg.backups.dirs.length > 1 ? `Minecraft backups (${i + 1})` : "Minecraft backups", path: d })),
  ];
}

/** `du` can take minutes on a big library, so it runs in the background and is cached. */
export function refreshFolders(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (cfg.demo) {
      await sleep(1500);
      folderCache = { folders: demo.folders(), refreshedAt: new Date().toISOString() };
      return;
    }
    const folders: FolderUsage[] = [];
    for (const t of targets()) {
      try {
        const { stdout } = await execFileP("du", ["-sk", t.path], { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
        folders.push({ ...t, bytes: Number(stdout.trim().split(/\s+/)[0]) * 1024 });
      } catch (e) {
        folders.push({ ...t, bytes: null, error: (e as Error).message.split("\n")[0] });
      }
    }
    folderCache = { folders, refreshedAt: new Date().toISOString() };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function storage(): Promise<StoragePayload> {
  const fsList = await filesystems().catch(() => [] as Filesystem[]);
  const stale = !folderCache.refreshedAt || Date.now() - Date.parse(folderCache.refreshedAt) > TTL_MS;
  if (stale) void refreshFolders();
  return {
    filesystems: fsList,
    folders: folderCache.folders.length ? folderCache.folders : targets().map((t) => ({ ...t, bytes: null })),
    refreshedAt: folderCache.refreshedAt,
    refreshing: refreshing !== null,
  };
}

// ---- explorer: one folder's children ---------------------------------------------------

const treeCache = new Map<string, StorageTreePayload>();
const treeJobs = new Map<string, Promise<void>>();

async function safeDir(input: string): Promise<string> {
  if (input && !input.startsWith("/")) throw new HttpError(400, "Path must be absolute");
  const p = path.resolve(input || "/");
  if (BLOCKED.test(p)) throw new HttpError(400, `${p} cannot be measured`);
  if (cfg.demo) return p; // demo paths are imaginary
  const st = await withTimeout(fs.stat(p), 5000, `stat ${p}`).catch(() => null);
  if (!st) throw new HttpError(404, `${p} is not reachable`);
  if (!st.isDirectory()) throw new HttpError(400, `${p} is not a folder`);
  return p;
}

function mountFor(p: string, list: Filesystem[]): StorageTreePayload["mount"] {
  let best: Filesystem | null = null;
  for (const f of list) if ((p === f.mount || p.startsWith(f.mount.endsWith("/") ? f.mount : `${f.mount}/`)) && (!best || f.mount.length > best.mount.length)) best = f;
  return best ? { mount: best.mount, totalBytes: best.totalBytes, usedBytes: best.usedBytes } : null;
}

const fresh = (at: string | null, ttl = EXPLORER_TTL_MS) => !!at && Date.now() - Date.parse(at) < ttl;

function emptyTree(p: string): StorageTreePayload {
  return { path: p, parent: p === "/" ? null : path.dirname(p), measuring: false, measuredAt: null, totalBytes: null, entries: [], partial: false, mount: null };
}

async function measureTree(p: string): Promise<StorageTreePayload> {
  // -x: stay on this filesystem (other mounts have their own meter); -d 1: children only
  const du = await measure("du", ["-x", "-k", "-d", "1", "--", p], DU_TIMEOUT);
  if (du.failed) throw new Error("du is not available or produced no output");
  const dirs: TreeEntry[] = [];
  let total = 0;
  for (const line of du.stdout.split("\n")) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    if (m[2] === p) total = bytes;
    else dirs.push({ name: path.basename(m[2]), path: m[2], bytes, kind: "dir" });
  }
  // files directly in this folder (du -d 1 only lists sub-folders)
  const files: TreeEntry[] = [];
  let fileBytes = 0;
  const names = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
  for (const e of names.slice(0, 5000)) {
    if (!e.isFile()) continue;
    const full = path.join(p, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (!st) continue;
    fileBytes += st.size;
    files.push({ name: e.name, path: full, bytes: st.size, kind: "file" });
  }
  files.sort((a, b) => b.bytes - a.bytes);
  const shown = files.slice(0, 25);
  const entries = [...dirs, ...shown].sort((a, b) => b.bytes - a.bytes);
  const rest = files.length - shown.length;
  if (rest > 0) entries.push({ name: `${rest} more file${rest === 1 ? "" : "s"}`, path: p, bytes: fileBytes - shown.reduce((s, f) => s + f.bytes, 0), kind: "files" });
  return { ...emptyTree(p), measuredAt: new Date().toISOString(), totalBytes: total || dirs.reduce((s, d) => s + d.bytes, 0) + fileBytes, entries, partial: du.partial, mount: mountFor(p, await filesystems().catch(() => [])) };
}

function trim<T>(cache: Map<string, T>, max = 300): void {
  while (cache.size > max) cache.delete(cache.keys().next().value as string);
}

export async function storageTree(input: string, refresh = false): Promise<StorageTreePayload> {
  const p = await safeDir(input);
  const cached = treeCache.get(p);
  if (cached && !refresh && fresh(cached.measuredAt)) return { ...cached, measuring: treeJobs.has(p) };
  if (cfg.demo) {
    const t = { ...demo.storageTree(p), mount: mountFor(p, demo.filesystems()) };
    treeCache.set(p, t);
    return t;
  }
  if (!treeJobs.has(p)) {
    const job = measureTree(p)
      .then(
        (t) => treeCache.set(p, t),
        (e) => treeCache.set(p, { ...(cached ?? emptyTree(p)), measuredAt: new Date().toISOString(), error: (e as Error).message }),
      )
      .then(() => trim(treeCache))
      .finally(() => treeJobs.delete(p));
    treeJobs.set(p, job);
  }
  return { ...(cached ?? emptyTree(p)), measuring: true };
}

// ---- largest files under a path -------------------------------------------------------

const MIN_LARGE = 20 * 1024 * 1024;
const largestCache = new Map<string, LargestPayload>();
const largestJobs = new Map<string, Promise<void>>();

async function measureLargest(p: string, limit: number): Promise<LargestPayload> {
  // GNU find prints size, mtime and path in one pass; -xdev stays on this filesystem.
  let r = await measure("find", [p, "-xdev", "-type", "f", "-size", `+${MIN_LARGE / 1024}k`, "-printf", "%s\\t%T@\\t%p\\n"], DU_TIMEOUT);
  let files: LargestFile[] = [];
  if (!r.failed && /^\d+\t/m.test(r.stdout)) {
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^(\d+)\t([\d.]+)\t(.*)$/);
      if (m) files.push({ path: m[3], bytes: Number(m[1]), modified: new Date(Number(m[2]) * 1000).toISOString() });
    }
  } else {
    // BSD find (no -printf): list, then stat
    r = await measure("find", [p, "-xdev", "-type", "f", "-size", `+${MIN_LARGE / 1024}k`, "-print0"], DU_TIMEOUT);
    if (r.failed) throw new Error("find is not available");
    for (const f of r.stdout.split("\0").filter(Boolean).slice(0, 5000)) {
      const st = await fs.stat(f).catch(() => null);
      if (st) files.push({ path: f, bytes: st.size, modified: st.mtime.toISOString() });
    }
  }
  files = files.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  return { path: p, measuring: false, measuredAt: new Date().toISOString(), minBytes: MIN_LARGE, files, partial: r.partial };
}

export async function largestFiles(input: string, limit = 50, refresh = false): Promise<LargestPayload> {
  const p = await safeDir(input);
  const key = `${p}\u0000${limit}`;
  const cached = largestCache.get(key);
  if (cached && !refresh && fresh(cached.measuredAt)) return { ...cached, measuring: largestJobs.has(key) };
  if (cfg.demo) {
    const l = demo.largestFiles(p, limit);
    largestCache.set(key, l);
    return l;
  }
  if (!largestJobs.has(key)) {
    const job = measureLargest(p, limit)
      .then(
        (l) => largestCache.set(key, l),
        (e) => largestCache.set(key, { path: p, measuring: false, measuredAt: new Date().toISOString(), minBytes: MIN_LARGE, files: cached?.files ?? [], partial: false, error: (e as Error).message }),
      )
      .then(() => trim(largestCache))
      .finally(() => largestJobs.delete(key));
    largestJobs.set(key, job);
  }
  return { path: p, measuring: true, measuredAt: cached?.measuredAt ?? null, minBytes: MIN_LARGE, files: cached?.files ?? [], partial: false };
}

// ---- reclaimable space --------------------------------------------------------------------

let reclaimCache: ReclaimPayload | null = null;
let reclaimJob: Promise<void> | null = null;

/** `du -sk -x` of one path; null when missing/unreadable. */
async function duBytes(p: string, timeout = 120_000): Promise<{ bytes: number | null; partial: boolean }> {
  try {
    await fs.access(p);
  } catch {
    return { bytes: null, partial: false };
  }
  const r = await measure("du", ["-s", "-k", "-x", "--", p], timeout);
  const m = r.stdout.trim().match(/^(\d+)/);
  return { bytes: m ? Number(m[1]) * 1024 : null, partial: r.partial };
}

/** "1.2G", "856.0M", "12K" → bytes */
function parseSize(s: string): number | null {
  const m = s.trim().match(/^([\d.]+)\s*([KMGTP]?)i?B?$/i);
  if (!m) return null;
  const mult: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.round(Number(m[1]) * mult[m[2].toUpperCase()]);
}

async function measureReclaim(): Promise<ReclaimPayload> {
  const items: ReclaimItem[] = [];
  const item = (i: Omit<ReclaimItem, "actionable"> & { actionable?: boolean }) => items.push({ actionable: i.command !== null, ...i });

  const docker = await dockerDiskUsage();
  if (docker) {
    const total = docker.imagesUnused + docker.buildCache + docker.volumesUnused;
    item({ id: "docker", label: "Docker: unused images, build cache, dangling volumes", bytes: total, detail: `${docker.imagesUnusedCount} image(s) not used by any container, ${(docker.buildCache / 1024 ** 2).toFixed(0)} MB build cache, ${docker.volumesUnusedCount} unreferenced volume(s). Jellyfin / Directus / Postgres images in use are untouched.`, command: "docker system prune" + (docker.volumesUnused ? " --volumes" : "") });
  } else item({ id: "docker", label: "Docker", bytes: null, detail: "Docker socket not readable from the dashboard, so unused images could not be measured.", command: "docker system df" });

  const journal = await measure("journalctl", ["--disk-usage"], 20_000);
  const jm = journal.stdout.match(/take up ([\d.]+\s*[KMGT]?i?B?)/i);
  item({ id: "journal", label: "systemd journal", bytes: jm ? parseSize(jm[1]) : null, detail: jm ? "Archived and active journal files. Keeping ~200 MB is plenty for a home server; the dashboard's alerts history is stored separately." : "journalctl --disk-usage failed (is the service user in systemd-journal?)", command: "sudo journalctl --vacuum-size=200M" });

  const apt = await duBytes("/var/cache/apt/archives");
  if (apt.bytes !== null) item({ id: "apt", label: "apt package cache", bytes: apt.bytes, detail: "Downloaded .deb files already installed.", command: "sudo apt-get clean" });

  const snaps = await measure("snap", ["list", "--all"], 20_000);
  if (!snaps.failed && snaps.stdout) {
    let bytes = 0;
    let count = 0;
    for (const line of snaps.stdout.split("\n")) {
      if (!/\bdisabled\b/.test(line)) continue;
      const [name, , rev] = line.trim().split(/\s+/);
      const st = await fs.stat(`/var/lib/snapd/snaps/${name}_${rev}.snap`).catch(() => null);
      if (st) {
        bytes += st.size;
        count++;
      }
    }
    item({ id: "snap", label: "Old snap revisions", bytes, detail: `${count} disabled revision(s) kept for rollback.`, command: count ? "snap list --all | awk '/disabled/{print $1, $3}' | while read n r; do sudo snap remove \"$n\" --revision=\"$r\"; done" : null });
  }

  try {
    const b = await listBackups();
    const ours = b.backups.filter((x) => x.deletable);
    const extra = ours.slice(Math.max(1, cfg.backups.keep));
    item({ id: "backups", label: "Dashboard-made world backups beyond retention", bytes: extra.reduce((s, x) => s + x.bytes, 0), detail: `${ours.length} dashboard-made backup(s), BACKUP_KEEP=${cfg.backups.keep}; ${extra.length} beyond that. The owner's own mcworld_… history is never touched.`, command: null, actionable: extra.length > 0 });
  } catch {
    // backups unavailable
  }

  const logs = await duBytes(path.join(cfg.minecraft.dir, "logs"));
  if (logs.bytes !== null) item({ id: "mc-logs", label: "Minecraft log archives", bytes: logs.bytes, detail: `${path.join(cfg.minecraft.dir, "logs")} — Paper gzips a log per day and never deletes them.`, command: `find "${path.join(cfg.minecraft.dir, "logs")}" -name '*.log.gz' -mtime +30 -delete` });
  const crash = await duBytes(path.join(cfg.minecraft.dir, "crash-reports"));
  if (crash.bytes !== null && crash.bytes > 0) item({ id: "mc-crash", label: "Minecraft crash reports", bytes: crash.bytes, detail: "Worth reading before deleting — an agent can summarise them.", command: `find "${path.join(cfg.minecraft.dir, "crash-reports")}" -mtime +30 -delete` });

  let trash = 0;
  let trashSeen = false;
  for (const home of [...(await fs.readdir("/home").catch(() => [])).map((h) => `/home/${h}`), "/root"]) {
    const t = await duBytes(path.join(home, ".local/share/Trash"), 60_000);
    if (t.bytes !== null) {
      trash += t.bytes;
      trashSeen = true;
    }
  }
  if (trashSeen) item({ id: "trash", label: "Trash folders", bytes: trash, detail: "Desktop-style trash under each user's ~/.local/share/Trash.", command: "rm -rf ~/.local/share/Trash/*" });

  let tmp = 0;
  for (const t of ["/tmp", "/var/tmp"]) tmp += (await duBytes(t, 60_000)).bytes ?? 0;
  item({ id: "tmp", label: "Temporary files", bytes: tmp, detail: "/tmp and /var/tmp. systemd cleans these on its own schedule.", command: "sudo systemd-tmpfiles --clean" });

  const cores = await duBytes("/var/lib/systemd/coredump");
  if (cores.bytes !== null && cores.bytes > 0) item({ id: "coredump", label: "Core dumps", bytes: cores.bytes, detail: "Crash dumps kept by systemd-coredump.", command: "sudo rm -f /var/lib/systemd/coredump/*" });

  const varlog = await duBytes("/var/log");
  if (varlog.bytes !== null) item({ id: "varlog", label: "/var/log (all logs incl. journal)", bytes: varlog.bytes, detail: "Rotated by logrotate. Use the explorer above to find any single log that grew.", command: null, actionable: false });

  const totalBytes = items.filter((i) => i.actionable && i.bytes).reduce((s, i) => s + (i.bytes ?? 0), 0);
  return { items, totalBytes, measuring: false, measuredAt: new Date().toISOString() };
}

export async function reclaimable(refresh = false): Promise<ReclaimPayload> {
  if (reclaimCache && !refresh && fresh(reclaimCache.measuredAt)) return { ...reclaimCache, measuring: reclaimJob !== null };
  if (cfg.demo) return (reclaimCache = demo.reclaim());
  if (!reclaimJob) {
    reclaimJob = measureReclaim()
      .then(
        (r) => (reclaimCache = r),
        () => (reclaimCache = { items: reclaimCache?.items ?? [], totalBytes: reclaimCache?.totalBytes ?? 0, measuring: false, measuredAt: new Date().toISOString() }),
      )
      .then(() => undefined)
      .finally(() => (reclaimJob = null));
  }
  return { items: reclaimCache?.items ?? [], totalBytes: reclaimCache?.totalBytes ?? 0, measuring: true, measuredAt: reclaimCache?.measuredAt ?? null };
}

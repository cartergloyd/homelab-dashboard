// Storage: filesystem capacity (df), measured sizes of the folders the dashboard
// manages (du), and the "reclaimable space" report (issue #4). The TreeSize-style
// explorer lives in services/diskscan.ts (ncdu / gdu / du engines). Nothing in this
// module deletes anything.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { sleep } from "../util.js";
import { listBackups } from "./backups.js";
import { dockerDiskUsage } from "./docker.js";
import { driveInventory } from "./blockDevices.js";
import type { Filesystem, FolderUsage, ReclaimItem, ReclaimPayload, StoragePayload } from "../types.js";

const execFileP = promisify(execFile);
const TTL_MS = 15 * 60_000;
const RECLAIM_TTL_MS = 10 * 60_000;

let folderCache: { folders: FolderUsage[]; refreshedAt: string | null } = { folders: [], refreshedAt: null };
let refreshing: Promise<void> | null = null;

/** Runs a measuring tool; du exits 1 on unreadable entries but still prints, so keep partial stdout. */
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

// ---- filesystems + folder sizes ----------------------------------------------------

let fsCache: { at: number; rows: Filesystem[] } | null = null;

export async function filesystems(): Promise<Filesystem[]> {
  // [DEMO] demo-mode branch — fake df output; never taken on a real install (see DEMO_INDEX.md)
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
  const [fsList, inventory] = await Promise.all([
    filesystems().catch(() => [] as Filesystem[]),
    // [DEMO] demo drive inventory stays separate from the host's real hardware.
    cfg.demo ? Promise.resolve(demo.driveInventory()) : driveInventory(),
  ]);
  const stale = !folderCache.refreshedAt || Date.now() - Date.parse(folderCache.refreshedAt) > TTL_MS;
  if (stale) void refreshFolders();
  return {
    filesystems: fsList,
    driveInventory: inventory,
    folders: folderCache.folders.length ? folderCache.folders : targets().map((t) => ({ ...t, bytes: null })),
    refreshedAt: folderCache.refreshedAt,
    refreshing: refreshing !== null,
  };
}

// ---- reclaimable space --------------------------------------------------------------------

let reclaimCache: ReclaimPayload | null = null;
let reclaimJob: Promise<void> | null = null;
const fresh = (at: string | null) => !!at && Date.now() - Date.parse(at) < RECLAIM_TTL_MS;

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
  // [DEMO] demo-mode branch — a fixed reclaimable-space list; never taken on a real install (see DEMO_INDEX.md)
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

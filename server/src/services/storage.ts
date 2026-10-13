import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { sleep } from "../util.js";
import type { Filesystem, FolderUsage, StoragePayload } from "../types.js";

const execFileP = promisify(execFile);
const TTL_MS = 15 * 60_000;

let folderCache: { folders: FolderUsage[]; refreshedAt: string | null } = { folders: [], refreshedAt: null };
let refreshing: Promise<void> | null = null;

export async function filesystems(): Promise<Filesystem[]> {
  if (cfg.demo) return demo.filesystems();
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

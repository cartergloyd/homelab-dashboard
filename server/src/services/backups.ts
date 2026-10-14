// Minecraft world backups. Discovers EXISTING backups in several layouts and
// only ever deletes what the dashboard itself created.
//
// Recognised layouts under each BACKUP_DIR root:
//   mc-YYYYMMDD-HHMMSS.tar.gz        "dashboard"    (what the built-in backup writes in archive mode)
//   mcworld_YYYY_MM_DD/<x>.tar.gz    "dated-folder" (the owner's existing layout, issue #2)
//   *.tar.gz | *.tgz | *.zip | *.tar.zst   "archive" (anything else that looks like a backup)
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { sleep } from "../util.js";
import { rconCommand } from "./rcon.js";
import { runScriptAndWait } from "./scripts.js";
import type { BackupFile, BackupsPayload } from "../types.js";

const execFileP = promisify(execFile);

/**
 * Paper's world folders: <level-name>, <level-name>_nether, <level-name>_the_end,
 * with level-name read from server.properties in MC_DIR (default "world"). Only the
 * built-in backup uses this; the owner's own backup script / timer is the live
 * mechanism today (BACKUP_METHOD=script:<name> to use it).
 */
export async function worldFolders(): Promise<string[]> {
  let level = "world";
  try {
    const props = await fs.readFile(path.join(cfg.minecraft.dir, "server.properties"), "utf8");
    const m = props.match(/^\s*level-name\s*=\s*(.+?)\s*$/m);
    if (m?.[1]) level = m[1];
  } catch {
    // no server.properties readable: Paper's default
  }
  return [level, `${level}_nether`, `${level}_the_end`];
}

const DASH_RE = /^mc-\d{8}-\d{6}\.tar\.gz$/;
const DATED_RE = /^mcworld_\d{4}_\d{2}_\d{2}$/;
const ARCHIVE_RE = /\.(tar\.gz|tgz|zip|tar\.zst|tar\.xz|tar)$/i;

const createdFile = () => path.join(cfg.dataDir, "backups-created.json");
let created: Set<string> | null = null;

async function loadCreated(): Promise<Set<string>> {
  if (created) return created;
  try {
    created = new Set(JSON.parse(await fs.readFile(createdFile(), "utf8")) as string[]);
  } catch {
    created = new Set();
  }
  return created;
}

async function markCreated(p: string): Promise<void> {
  const set = await loadCreated();
  set.add(p);
  await fs.writeFile(createdFile(), JSON.stringify([...set], null, 2)).catch(() => {});
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(dir: string): Promise<{ bytes: number; mtime: Date }> {
  let bytes = 0;
  let mtime = new Date(0);
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const s = await fs.stat(path.join(dir, e.name));
    bytes += s.size;
    if (s.mtime > mtime) mtime = s.mtime;
  }
  if (mtime.getTime() === 0) mtime = (await fs.stat(dir)).mtime;
  return { bytes, mtime };
}

export async function listBackups(): Promise<BackupsPayload> {
  const madeByUs = await loadCreated();
  const backups: BackupFile[] = [];
  const roots: BackupsPayload["roots"] = [];
  for (const root of cfg.backups.dirs) {
    let entries: import("node:fs").Dirent[] = [];
    let ok = true;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      ok = false;
    }
    let count = 0;
    for (const e of entries) {
      const full = path.join(root, e.name);
      try {
        if (e.isFile() && DASH_RE.test(e.name)) {
          const s = await fs.stat(full);
          backups.push({ name: e.name, path: full, root, format: "dashboard", bytes: s.size, mtime: s.mtime.toISOString(), deletable: true });
        } else if (e.isDirectory() && DATED_RE.test(e.name)) {
          const { bytes, mtime } = await dirSize(full);
          backups.push({ name: e.name, path: full, root, format: "dated-folder", bytes, mtime: mtime.toISOString(), deletable: madeByUs.has(full) });
        } else if (e.isFile() && ARCHIVE_RE.test(e.name)) {
          const s = await fs.stat(full);
          backups.push({ name: e.name, path: full, root, format: "archive", bytes: s.size, mtime: s.mtime.toISOString(), deletable: madeByUs.has(full) });
        } else continue;
        count++;
      } catch {
        // vanished mid-scan
      }
    }
    roots.push({ path: root, exists: ok, count });
  }
  backups.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { roots, backups, method: cfg.backups.method, format: cfg.backups.format, writeDir: cfg.backups.dir };
}

export async function deleteBackup(target: string): Promise<void> {
  const { backups } = await listBackups();
  const b = backups.find((x) => x.path === target || x.name === target);
  if (!b) throw new HttpError(404, "Backup not found");
  if (!b.deletable) throw new HttpError(403, `${b.name} was not created by the dashboard; delete it by hand if you really mean to.`);
  await fs.rm(b.path, { recursive: true, force: true });
  const set = await loadCreated();
  set.delete(b.path);
  await fs.writeFile(createdFile(), JSON.stringify([...set], null, 2)).catch(() => {});
}

/** Retention applies ONLY to backups the dashboard created. */
async function prune(keep: number): Promise<number> {
  const { backups } = await listBackups();
  const ours = backups.filter((b) => b.deletable);
  const extra = ours.slice(Math.max(1, keep));
  for (const b of extra) await deleteBackup(b.path).catch(() => {});
  return extra.length;
}

export interface BackupResult {
  file: string;
  bytes: number;
  pruned: number;
  savedWhileRunning: boolean;
  method: string;
}

async function pauseSaving(): Promise<boolean> {
  try {
    await rconCommand("save-off");
    await rconCommand("save-all flush");
    await sleep(2000);
    return true;
  } catch {
    return false; // server not running: files are already consistent
  }
}

async function resumeSaving(): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rconCommand("save-on");
      return;
    } catch (e) {
      console.warn(`[backup] save-on attempt ${attempt} failed: ${(e as Error).message}`);
      await sleep(2000);
    }
  }
}

/**
 * "Back up now" / backup jobs. BACKUP_METHOD=script:<name> runs the owner's own
 * script; builtin pauses autosave, tars the worlds in BACKUP_FORMAT, resumes.
 */
export async function runBackup(keep = cfg.backups.keep): Promise<BackupResult> {
  const method = cfg.backups.method;
  if (method.startsWith("script:")) {
    const name = method.slice(7).trim();
    const { run, tail } = await runScriptAndWait(name, "job");
    if (run.exitCode !== 0) throw new Error(`${name} exited ${run.exitCode}: ${tail.slice(-2).join(" | ") || "(no output)"}`);
    const latest = (await listBackups()).backups[0];
    return { file: latest?.name ?? name, bytes: latest?.bytes ?? 0, pruned: 0, savedWhileRunning: true, method };
  }

  const root = cfg.backups.dir;
  await fs.mkdir(root, { recursive: true });
  const names = await worldFolders();
  const worlds: string[] = [];
  for (const w of names) if (await exists(path.join(cfg.minecraft.dir, w))) worlds.push(w);
  if (!worlds.length) throw new Error(`No world folders (${names.join(", ")}) found in ${cfg.minecraft.dir} — check level-name in server.properties`);

  const now = new Date();
  const saving = await pauseSaving();
  let outPath: string;
  try {
    if (cfg.backups.format === "dated-folder") {
      const day = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}_${String(now.getDate()).padStart(2, "0")}`;
      outPath = path.join(root, `mcworld_${day}`);
      await fs.mkdir(outPath, { recursive: true });
      for (const w of worlds) {
        await execFileP("tar", ["-czf", path.join(outPath, `${w}.tar.gz`), "-C", cfg.minecraft.dir, "--exclude=session.lock", w], { timeout: 60 * 60_000, maxBuffer: 1 << 20 });
      }
    } else {
      const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
      outPath = path.join(root, `mc-${stamp}.tar.gz`);
      try {
        await execFileP("tar", ["-czf", outPath, "-C", cfg.minecraft.dir, "--exclude=session.lock", ...worlds], { timeout: 60 * 60_000, maxBuffer: 1 << 20 });
      } catch (e) {
        await fs.rm(outPath, { force: true });
        throw e;
      }
    }
  } finally {
    if (saving) await resumeSaving();
  }

  await markCreated(outPath);
  const size = cfg.backups.format === "dated-folder" ? (await dirSize(outPath)).bytes : (await fs.stat(outPath)).size;
  const pruned = await prune(keep);
  return { file: path.basename(outPath), bytes: size, pruned, savedWhileRunning: saving, method: `builtin/${cfg.backups.format}` };
}

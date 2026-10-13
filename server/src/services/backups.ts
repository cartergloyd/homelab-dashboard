import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { sleep } from "../util.js";
import { rconCommand } from "./rcon.js";
import type { BackupFile } from "../types.js";

const execFileP = promisify(execFile);
// [INSTALLER] PLACEHOLDER: Paper's default world folders. Check `level-name` in
// the real server.properties — if the world is not called "world", add the real
// names here (Paper names the other dimensions <level-name>_nether / _the_end).
// Only matters if the built-in `backup` job is ever used; the owner's own backup
// script is the live mechanism today.
const WORLDS = ["world", "world_nether", "world_the_end"];
const NAME_RE = /^mc-\d{8}-\d{6}\.tar\.gz$/;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listBackups(): Promise<BackupFile[]> {
  await fs.mkdir(cfg.backups.dir, { recursive: true });
  const out: BackupFile[] = [];
  for (const name of await fs.readdir(cfg.backups.dir)) {
    if (!NAME_RE.test(name)) continue;
    const s = await fs.stat(path.join(cfg.backups.dir, name));
    out.push({ name, bytes: s.size, mtime: s.mtime.toISOString() });
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export async function deleteBackup(name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "Not a backup file");
  await fs.rm(path.join(cfg.backups.dir, name));
}

async function prune(keep: number): Promise<number> {
  const extra = (await listBackups()).slice(Math.max(1, keep));
  for (const b of extra) await fs.rm(path.join(cfg.backups.dir, b.name), { force: true });
  return extra.length;
}

export interface BackupResult {
  file: string;
  bytes: number;
  pruned: number;
  savedWhileRunning: boolean;
}

/**
 * Consistent world backup: pause autosave, flush to disk, tar the worlds, then
 * re-enable autosave no matter what. If RCON is unreachable the server is assumed
 * stopped, in which case the files are already consistent.
 */
export async function runBackup(keep = cfg.backups.keep): Promise<BackupResult> {
  await fs.mkdir(cfg.backups.dir, { recursive: true });
  const worlds: string[] = [];
  for (const w of WORLDS) if (await exists(path.join(cfg.minecraft.dir, w))) worlds.push(w);
  if (!worlds.length) throw new Error(`No world folders found in ${cfg.minecraft.dir}`);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = path.join(cfg.backups.dir, `mc-${stamp}.tar.gz`);

  let saving = false;
  try {
    await rconCommand("save-off");
    await rconCommand("save-all flush");
    saving = true;
    await sleep(2000);
  } catch {
    // server not running
  }

  try {
    await execFileP("tar", ["-czf", file, "-C", cfg.minecraft.dir, "--exclude=session.lock", ...worlds], {
      timeout: 60 * 60_000,
      maxBuffer: 1 << 20,
    });
  } catch (e) {
    await fs.rm(file, { force: true });
    throw e;
  } finally {
    if (saving) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await rconCommand("save-on");
          break;
        } catch (e) {
          console.warn(`[backup] save-on attempt ${attempt} failed: ${(e as Error).message}`);
          await sleep(2000);
        }
      }
    }
  }

  const st = await fs.stat(file);
  const pruned = await prune(keep);
  return { file: path.basename(file), bytes: st.size, pruned, savedWhileRunning: saving };
}

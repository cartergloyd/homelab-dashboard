// A local git history of the folders a run may write (lanes.ts), so the owner can see exactly what
// an autonomous run changed and undo it. Before a run, pending changes are committed and each
// root's commit is recorded; after it, the run's changes are committed and listed. Rollback puts a
// root back to its recorded commit. Nothing is pushed anywhere. Plugin folders track config files
// only (no caches, keys, databases or jars); the rules live in .git/info/exclude, not in the folder.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";

const execFileP = promisify(execFile);
const IDENTITY = ["-c", "user.name=homelab-dashboard", "-c", "user.email=homelab-dashboard@localhost", "-c", "commit.gpgsign=false", "-c", "core.quotepath=false"];
const EXCLUDE_SCRIPTS = "__pycache__/\n*.pyc\n*.log\n*.jar\n*.tar.gz\n*.zip\nbackups/\nupdates/\n";
const EXCLUDE_CONFIG = "*\n!*/\n!*.yml\n!*.yaml\n!*.properties\n!*.toml\n!*.conf\n!*.txt\n";
const KEEP_RUNS = 200;

type Recorded = Record<string, Record<string, string>>; // runId → root → commit before the run
const file = () => path.join(cfg.dataDir, "run-snapshots.json");

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", [...IDENTITY, "-C", root, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function ensureRepo(root: string): Promise<void> {
  try {
    await fs.access(path.join(root, ".git"));
    return;
  } catch {
    // first snapshot of this folder
  }
  await git(root, "init", "-q");
  await fs.writeFile(path.join(root, ".git/info/exclude"), path.basename(root) === "scripts" ? EXCLUDE_SCRIPTS : EXCLUDE_CONFIG);
}

/** Commits whatever is pending and returns the root's HEAD. */
async function commit(root: string, message: string): Promise<string> {
  await ensureRepo(root);
  await git(root, "add", "-A");
  if (await git(root, "status", "--porcelain")) await git(root, "commit", "-q", "-m", message);
  else if (!(await git(root, "rev-parse", "--verify", "-q", "HEAD").catch(() => ""))) await git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function readRecorded(): Promise<Recorded> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8")) as Recorded;
  } catch {
    return {};
  }
}

async function record(runId: string, heads: Record<string, string>): Promise<void> {
  const all = await readRecorded();
  all[runId] = heads;
  const keep = Object.entries(all).slice(-KEEP_RUNS);
  await fs.writeFile(`${file()}.tmp`, JSON.stringify(Object.fromEntries(keep), null, 2));
  await fs.rename(`${file()}.tmp`, file());
}

const label = (root: string, f: string) => `${path.relative(cfg.minecraft.dir, root) || path.basename(root)}/${f}`;

export async function snapshotBefore(runId: string, roots: string[]): Promise<void> {
  const heads: Record<string, string> = {};
  for (const root of roots) heads[root] = await commit(root, `before run ${runId}`);
  await record(runId, heads);
}

/** Commits the run's changes and lists the files it changed, as "<root>/<file>". */
export async function snapshotAfter(runId: string): Promise<string[]> {
  const before = (await readRecorded())[runId] ?? {};
  const changed: string[] = [];
  for (const [root, head] of Object.entries(before)) {
    const now = await commit(root, `run ${runId}`);
    if (now !== head) changed.push(...(await git(root, "diff", "--name-only", head, now)).split("\n").filter(Boolean).map((f) => label(root, f)));
  }
  return changed;
}

/** Puts every root back to where it was before the run. Later changes to those files are undone too. */
export async function rollbackRun(runId: string): Promise<string[]> {
  const before = (await readRecorded())[runId];
  if (!before) throw new HttpError(404, `No snapshot recorded for run ${runId}`);
  const restored: string[] = [];
  for (const [root, head] of Object.entries(before)) {
    await commit(root, `changes before rolling back run ${runId}`);
    const files = (await git(root, "diff", "--name-only", head, "HEAD")).split("\n").filter(Boolean);
    if (!files.length) continue;
    await git(root, "restore", `--source=${head}`, "--staged", "--worktree", "--", ".");
    await git(root, "commit", "-q", "-m", `roll back run ${runId}`);
    restored.push(...files.map((f) => label(root, f)));
  }
  return restored;
}

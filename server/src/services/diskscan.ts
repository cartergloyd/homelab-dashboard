// Storage explorer engine (issue #4). Scanning is done by proven open-source tools:
// ncdu — the de-facto Linux disk-usage analyser since 2007, whose JSON export
// format is documented and stable (https://dev.yorhel.nl/ncdu/jsonfmt) — or gdu, a
// faster parallel scanner that writes the same format; plain `du -x -a` is the last
// resort. The export is parsed as a STREAM, so a disk with millions of files never
// has to exist in memory as JSON: we keep the directory tree with per-folder
// aggregates, the largest files per subtree, and extension / age / owner
// statistics for the top levels. Results persist under DATA_DIR/diskscan and are
// refreshed on a schedule. Nothing here deletes anything.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { HttpError } from "../errors.js";
import { filesystems } from "./storage.js";
import type { DirViewPayload, DiskScanEngine, DiskScanOverview, DiskScanSummary, Filesystem, ScanDirSummary, ScanFile, ScanStats } from "../types.js";

const execFileP = promisify(execFile);
const TOP_N = 40;
const STATS_DEPTH = 3;
const EXT_KEEP = 40;
const SCAN_TIMEOUT_MS = 6 * 3600_000;
const AGE_BUCKETS: { label: string; maxAgeS: number }[] = [
  { label: "< 1 week", maxAgeS: 7 * 86400 },
  { label: "< 1 month", maxAgeS: 31 * 86400 },
  { label: "< 6 months", maxAgeS: 183 * 86400 },
  { label: "< 1 year", maxAgeS: 366 * 86400 },
  { label: "< 2 years", maxAgeS: 731 * 86400 },
  { label: "older", maxAgeS: Infinity },
];
const AGE_UNKNOWN = AGE_BUCKETS.length;

// ---- in-memory model -----------------------------------------------------------------

interface Stats {
  ext: Map<string, { bytes: number; count: number }>;
  /** one [bytes, count] per AGE_BUCKETS entry + unknown */
  age: [number, number][];
  owners: Map<number, { bytes: number; count: number }>;
}

export interface Dir {
  name: string;
  path: string;
  depth: number;
  dsize: number;
  asize: number;
  files: number;
  dirs: number;
  mtime: number | null;
  ownFiles: number;
  ownBytes: number;
  readError: boolean;
  excluded: string | null;
  children: Dir[];
  top: ScanFile[];
  stats: Stats | null;
}

interface Scan {
  summary: DiskScanSummary;
  tree: Dir | null;
  byPath: Map<string, Dir>;
  child: ChildProcess | null;
}

const newStats = (): Stats => ({ ext: new Map(), age: Array.from({ length: AGE_UNKNOWN + 1 }, () => [0, 0] as [number, number]), owners: new Map() });

function newDir(name: string, p: string, depth: number): Dir {
  return { name, path: p, depth, dsize: 0, asize: 0, files: 0, dirs: 0, mtime: null, ownFiles: 0, ownBytes: 0, readError: false, excluded: null, children: [], top: [], stats: depth <= STATS_DEPTH ? newStats() : null };
}

export function extOf(name: string): string {
  const m = name.match(/\.(tar\.(gz|xz|zst|bz2)|[A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : "(none)";
}

function pushTop(list: ScanFile[], f: ScanFile): void {
  if (list.length >= TOP_N && f.dsize <= list[list.length - 1].dsize) return;
  let i = list.length;
  while (i > 0 && list[i - 1].dsize < f.dsize) i--;
  list.splice(i, 0, f);
  if (list.length > TOP_N) list.length = TOP_N;
}

function mergeTop(into: ScanFile[], from: ScanFile[]): void {
  for (const f of from) pushTop(into, f);
}

function addToStats(s: Stats, f: ScanFile, now: number): void {
  const e = s.ext.get(f.ext) ?? { bytes: 0, count: 0 };
  e.bytes += f.dsize;
  e.count++;
  s.ext.set(f.ext, e);
  let bucket = AGE_UNKNOWN;
  if (f.mtime !== null) {
    const age = Math.max(0, now - f.mtime);
    bucket = AGE_BUCKETS.findIndex((b) => age < b.maxAgeS);
    if (bucket < 0) bucket = AGE_BUCKETS.length - 1;
  }
  s.age[bucket][0] += f.dsize;
  s.age[bucket][1]++;
  if (f.uid !== null) {
    const o = s.owners.get(f.uid) ?? { bytes: 0, count: 0 };
    o.bytes += f.dsize;
    o.count++;
    s.owners.set(f.uid, o);
  }
}

/** Shared by every engine: feeds files/dirs into the tree and keeps the aggregates. */
export class TreeBuilder {
  readonly stack: Dir[] = [];
  root: Dir | null = null;
  dirs = 0;
  files = 0;
  readErrors = 0;
  excluded = 0;
  private readonly seenInodes = new Set<string>();
  constructor(private readonly now: number) {}

  dirStart(name: string, fullPath: string, info: { dsize?: number; asize?: number; read_error?: boolean; excluded?: string }): Dir {
    const parent = this.stack[this.stack.length - 1];
    const d = newDir(name, fullPath, this.stack.length);
    d.dsize = info.dsize ?? 0;
    d.asize = info.asize ?? 0;
    d.readError = !!info.read_error;
    d.excluded = info.excluded ?? null;
    if (d.readError) this.readErrors++;
    if (d.excluded) this.excluded++;
    if (parent) parent.children.push(d);
    else this.root = d;
    this.stack.push(d);
    this.dirs++;
    return d;
  }

  file(name: string, info: { dsize?: number; asize?: number; mtime?: number; uid?: number; read_error?: boolean; excluded?: string; dev?: number; ino?: number; nlink?: number; hlnkc?: boolean }): void {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) return;
    if (info.excluded) {
      this.excluded++;
      return;
    }
    if (info.read_error) this.readErrors++;
    let dsize = info.dsize ?? 0;
    // a hard-linked file is counted once (ncdu exports ino only when nlink > 1)
    if ((info.nlink ?? 1) > 1 || info.hlnkc) {
      const key = `${info.dev ?? 0}:${info.ino ?? name}`;
      if (this.seenInodes.has(key)) dsize = 0;
      else this.seenInodes.add(key);
    }
    const f: ScanFile = { name, path: path.join(parent.path, name), dsize, asize: info.asize ?? 0, mtime: info.mtime ?? null, uid: info.uid ?? null, ext: extOf(name) };
    this.files++;
    parent.ownFiles++;
    parent.ownBytes += dsize;
    parent.files++;
    parent.dsize += dsize;
    parent.asize += f.asize;
    if (f.mtime !== null && (parent.mtime === null || f.mtime > parent.mtime)) parent.mtime = f.mtime;
    pushTop(parent.top, f);
    for (const a of this.stack) if (a.stats) addToStats(a.stats, f, this.now);
  }

  dirEnd(): Dir | null {
    const d = this.stack.pop();
    if (!d) return null;
    d.children.sort((a, b) => b.dsize - a.dsize);
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.dsize += d.dsize;
      parent.asize += d.asize;
      parent.files += d.files;
      parent.dirs += d.dirs + 1;
      if (d.mtime !== null && (parent.mtime === null || d.mtime > parent.mtime)) parent.mtime = d.mtime;
      mergeTop(parent.top, d.top);
    }
    return d;
  }

  /** du's size for a directory is already cumulative: set, don't add. */
  setDirSize(d: Dir, bytes: number): void {
    d.dsize = bytes;
    d.asize = bytes;
  }
}

// ---- ncdu JSON export: streaming parser -----------------------------------------------
// Format: [majorver, minorver, {meta}, <dir>] where <dir> = [ {info}, child, child … ]
// and a child is either a nested <dir> array or a file {info}. Objects are the only
// place strings occur, so structure can be tracked by brackets outside objects.

export class NcduStreamParser {
  private buf = "";
  private pos = 0;
  private objStart = -1;
  private objDepth = 0;
  private inStr = false;
  private esc = false;
  private depth = 0;
  private expectInfo = false;
  private metaSeen = false;
  meta: Record<string, unknown> | null = null;
  constructor(private readonly tree: TreeBuilder) {}

  push(chunk: string): void {
    this.buf += chunk;
    this.scan();
  }

  end(): void {
    if (this.depth !== 0 || this.objStart >= 0) throw new Error("ncdu export ended mid-structure (scanner was interrupted?)");
  }

  private scan(): void {
    const b = this.buf;
    let i = this.pos;
    for (; i < b.length; i++) {
      const c = b.charCodeAt(i);
      if (this.objStart >= 0) {
        if (this.inStr) {
          if (this.esc) this.esc = false;
          else if (c === 92) this.esc = true; // backslash
          else if (c === 34) this.inStr = false; // quote
          continue;
        }
        if (c === 34) this.inStr = true;
        else if (c === 123) this.objDepth++; // {
        else if (c === 125) {
          // }
          this.objDepth--;
          if (this.objDepth === 0) {
            const text = b.slice(this.objStart, i + 1);
            this.objStart = -1;
            this.onObject(JSON.parse(text) as Record<string, unknown>);
          }
        }
        continue;
      }
      if (c === 123) {
        this.objStart = i;
        this.objDepth = 1;
      } else if (c === 91) {
        // [
        this.depth++;
        if (this.depth >= 2) this.expectInfo = true;
      } else if (c === 93) {
        // ]
        if (this.depth >= 2) this.tree.dirEnd();
        this.depth--;
      }
    }
    if (this.objStart >= 0) {
      this.buf = b.slice(this.objStart);
      this.pos = this.buf.length;
      this.objStart = 0;
    } else {
      this.buf = "";
      this.pos = 0;
    }
  }

  private onObject(o: Record<string, unknown>): void {
    if (this.depth === 1 && !this.metaSeen) {
      this.metaSeen = true;
      this.meta = o;
      return;
    }
    const name = String(o.name ?? "");
    const info = o as { dsize?: number; asize?: number; mtime?: number; uid?: number; read_error?: boolean; excluded?: string; dev?: number; ino?: number; nlink?: number; hlnkc?: boolean };
    if (this.expectInfo) {
      this.expectInfo = false;
      const parent = this.tree.stack[this.tree.stack.length - 1];
      this.tree.dirStart(parent ? name : path.basename(name) || name, parent ? path.join(parent.path, name) : name, info);
    } else this.tree.file(name, info);
  }
}

// ---- du -a: post-order lines ------------------------------------------------------------

export class DuLineParser {
  private readonly pending = new Map<string, Dir>();
  constructor(
    private readonly tree: TreeBuilder,
    private readonly root: string,
  ) {}

  private ensureDir(p: string): Dir {
    const existing = this.pending.get(p);
    if (existing) return existing;
    if (p !== this.root) this.ensureDir(path.dirname(p));
    // dirStart pushes onto the stack; du gives us no nesting events, so we keep the
    // stack mirroring the path by hand
    while (this.tree.stack.length && !p.startsWith(`${this.tree.stack[this.tree.stack.length - 1].path}/`) && this.tree.stack[this.tree.stack.length - 1].path !== path.dirname(p)) this.tree.dirEnd();
    const d = this.tree.dirStart(p === this.root ? p : path.basename(p), p, {});
    this.pending.set(p, d);
    return d;
  }

  line(l: string): void {
    const m = l.match(/^(\d+)\s+(.*)$/);
    if (!m) return;
    const bytes = Number(m[1]) * 1024;
    const p = m[2];
    const dir = this.pending.get(p);
    if (dir) {
      this.tree.setDirSize(dir, bytes);
      return;
    }
    if (p === this.root) {
      const d = this.ensureDir(p);
      this.tree.setDirSize(d, bytes);
      return;
    }
    const parentPath = path.dirname(p);
    const parent = this.ensureDir(parentPath);
    // make the parent the top of the stack so file() attributes to it
    while (this.tree.stack.length && this.tree.stack[this.tree.stack.length - 1] !== parent) this.tree.dirEnd();
    this.tree.file(path.basename(p), { dsize: bytes, asize: bytes });
  }

  end(): void {
    while (this.tree.stack.length) this.tree.dirEnd();
  }
}

// ---- engines ---------------------------------------------------------------------------

let detected: { ncdu: string | null; gdu: string | null; at: number } | null = null;

async function version(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, { timeout: 5000 });
    const m = `${stdout}\n${stderr}`.match(/(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : "present";
  } catch {
    return null;
  }
}

export async function detectEngines(force = false): Promise<{ ncdu: string | null; gdu: string | null }> {
  if (detected && !force && Date.now() - detected.at < 10 * 60_000) return detected;
  detected = { ncdu: await version("ncdu", ["-v"]), gdu: await version("gdu", ["-v"]), at: Date.now() };
  return detected;
}

function chooseEngine(avail: { ncdu: string | null; gdu: string | null }): { engine: DiskScanEngine; version: string | null; note: string } {
  if (cfg.demo) return { engine: "demo", version: "fixture", note: "demo: a generated ncdu-format export of an imaginary disk is parsed by the real engine" };
  const want = cfg.diskScan.scanner;
  if ((want === "auto" || want === "ncdu") && avail.ncdu) return { engine: "ncdu", version: avail.ncdu, note: `ncdu ${avail.ncdu} (JSON export, extended info: file ages and owners)` };
  if ((want === "auto" || want === "gdu") && avail.gdu) return { engine: "gdu", version: avail.gdu, note: `gdu ${avail.gdu} (ncdu-format JSON export; no file ages/owners)` };
  if (want === "ncdu" || want === "gdu") return { engine: "du", version: null, note: `DISK_SCANNER=${want} but it is not installed — falling back to du -a (slow, no ages/owners). sudo apt install ${want}` };
  return { engine: "du", version: null, note: "du -a fallback (slow, no file ages/owners). Install ncdu for the full TreeSize view: sudo apt install ncdu" };
}

function commandFor(engine: DiskScanEngine, root: string, kernfs = true): { cmd: string; args: string[] } {
  const ex = cfg.diskScan.exclude;
  if (engine === "ncdu") return { cmd: "ncdu", args: ["-x", "-0", "-e", ...(kernfs ? ["--exclude-kernfs"] : []), ...ex.flatMap((p) => ["--exclude", p]), "-o", "-", "--", root] };
  if (engine === "gdu") return { cmd: "gdu", args: ["-n", "-p", "-x", "-c", ...(ex.length ? ["--ignore-dirs-pattern", ex.join("|")] : []), "-o", "-", root] };
  return { cmd: "du", args: ["-x", "-a", "-k", ...ex.flatMap((p) => ["--exclude", p]), "--", root] };
}

// ---- scans -------------------------------------------------------------------------------

const scans = new Map<string, Scan>();
let running: string | null = null;
const queue: string[] = [];
let passwd: Map<number, string> | null = null;

const dir = () => path.join(cfg.dataDir, "diskscan");
const slug = (root: string) => (root === "/" ? "root" : root.replace(/^\//, "").replace(/[^A-Za-z0-9_.-]+/g, "_"));
const file = (root: string) => path.join(dir(), `${slug(root)}.json`);

function mountFor(p: string, list: Filesystem[]): DiskScanSummary["mount"] {
  let best: Filesystem | null = null;
  for (const f of list) if ((p === f.mount || p.startsWith(f.mount.endsWith("/") ? f.mount : `${f.mount}/`)) && (!best || f.mount.length > best.mount.length)) best = f;
  return best ? { mount: best.mount, totalBytes: best.totalBytes, usedBytes: best.usedBytes } : null;
}

function indexTree(root: Dir): Map<string, Dir> {
  const m = new Map<string, Dir>();
  const walk = (d: Dir) => {
    m.set(d.path, d);
    for (const c of d.children) walk(c);
  };
  walk(root);
  return m;
}

type SerDir = Omit<Dir, "children" | "stats"> & { children: SerDir[]; stats: { ext: [string, number, number][]; age: [number, number][]; owners: [number, number, number][] } | null };

function serialize(d: Dir): SerDir {
  return { ...d, children: d.children.map(serialize), stats: d.stats ? { ext: [...d.stats.ext].map(([k, v]) => [k, v.bytes, v.count]), age: d.stats.age, owners: [...d.stats.owners].map(([k, v]) => [k, v.bytes, v.count]) } : null };
}

function deserialize(s: SerDir): Dir {
  return { ...s, children: s.children.map(deserialize), stats: s.stats ? { ext: new Map(s.stats.ext.map(([k, b, c]) => [k, { bytes: b, count: c }])), age: s.stats.age, owners: new Map(s.stats.owners.map(([k, b, c]) => [k, { bytes: b, count: c }])) } : null };
}

async function persist(s: Scan): Promise<void> {
  if (cfg.demo || !s.tree) return;
  await fsp.mkdir(dir(), { recursive: true });
  const tmp = `${file(s.summary.root)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ summary: s.summary, tree: serialize(s.tree) }));
  await fsp.rename(tmp, file(s.summary.root));
}

async function loadPersisted(): Promise<void> {
  const names = await fsp.readdir(dir()).catch(() => [] as string[]);
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir(), n), "utf8")) as { summary: DiskScanSummary; tree: SerDir };
      const tree = deserialize(raw.tree);
      scans.set(raw.summary.root, { summary: { ...raw.summary, status: raw.summary.status === "running" ? "failed" : raw.summary.status, error: raw.summary.status === "running" ? "interrupted by a dashboard restart" : raw.summary.error }, tree, byPath: indexTree(tree), child: null });
    } catch {
      // corrupt file: ignore, a rescan replaces it
    }
  }
}

async function loadPasswd(): Promise<void> {
  passwd = new Map();
  try {
    for (const line of (await fsp.readFile("/etc/passwd", "utf8")).split("\n")) {
      const [name, , uid] = line.split(":");
      if (name && uid) passwd.set(Number(uid), name);
    }
  } catch {
    // no /etc/passwd (unusual) — uids stay numeric
  }
}

export async function scanRoots(): Promise<string[]> {
  if (cfg.diskScan.roots.length) return cfg.diskScan.roots;
  const fs = await filesystems().catch(() => [] as Filesystem[]);
  const roots = fs.map((f) => f.mount).sort((a, b) => a.length - b.length);
  return roots.length ? roots : ["/"];
}

function summaryOf(s: Scan): DiskScanSummary {
  return s.summary;
}

export async function overview(): Promise<DiskScanOverview> {
  const avail = await detectEngines();
  const pick = chooseEngine(avail);
  const roots = await scanRoots();
  const all = [...new Set([...roots, ...scans.keys()])];
  return {
    engine: { preferred: pick.engine, available: { ncdu: cfg.demo ? null : avail.ncdu, gdu: cfg.demo ? null : avail.gdu }, note: pick.note },
    roots: all,
    scans: all.map((r) => scans.get(r)).filter((s): s is Scan => !!s).map(summaryOf),
    running,
    intervalHours: cfg.diskScan.intervalHours,
  };
}

function finish(s: Scan, builder: TreeBuilder, meta: Record<string, unknown> | null, error: string | null, fsList: Filesystem[]): void {
  const t0 = Date.parse(s.summary.startedAt);
  s.tree = builder.root;
  s.byPath = s.tree ? indexTree(s.tree) : new Map();
  s.summary.finishedAt = new Date().toISOString();
  s.summary.durationMs = Date.now() - t0;
  s.summary.progress = { dirs: builder.dirs, files: builder.files };
  s.summary.engineVersion = (meta?.progver as string | undefined) ?? s.summary.engineVersion;
  s.summary.mount = mountFor(s.summary.root, fsList);
  if (s.tree) s.summary.totals = { dsize: s.tree.dsize, asize: s.tree.asize, files: s.tree.files, dirs: s.tree.dirs, readErrors: builder.readErrors, excluded: builder.excluded };
  s.summary.status = s.tree && (!error || builder.files > 0) ? "done" : "failed";
  s.summary.error = s.summary.status === "failed" ? (error ?? "the scanner produced no data") : error;
  s.child = null;
  void persist(s);
}

async function runScan(root: string): Promise<void> {
  const fsList = await filesystems().catch(() => [] as Filesystem[]);
  const avail = await detectEngines();
  const pick = chooseEngine(avail);
  const s: Scan = {
    summary: { id: crypto.randomUUID().slice(0, 8), root, engine: pick.engine, engineVersion: pick.version, status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, error: null, progress: { dirs: 0, files: 0 }, totals: { dsize: 0, asize: 0, files: 0, dirs: 0, readErrors: 0, excluded: 0 }, mount: mountFor(root, fsList) },
    tree: null,
    byPath: new Map(),
    child: null,
  };
  const previous = scans.get(root);
  scans.set(root, s);
  running = root;
  const builder = new TreeBuilder(Math.floor(Date.now() / 1000));
  const tick = setInterval(() => (s.summary.progress = { dirs: builder.dirs, files: builder.files }), 1000);

  const done = (error: string | null, meta: Record<string, unknown> | null) => {
    clearInterval(tick);
    finish(s, builder, meta, error, fsList);
    if (s.summary.status === "failed" && previous?.tree) {
      // keep the last good tree browsable, but surface the failure
      s.tree = previous.tree;
      s.byPath = previous.byPath;
      s.summary.totals = previous.summary.totals;
    }
    running = null;
    const next = queue.shift();
    if (next) void runScan(next);
    else setTimeout(() => void kick(), 2000).unref(); // pick up the next stale root, if any
  };

  try {
    // [DEMO] demo-mode branch — a generated ncdu-format export of an imaginary disk stands
    // in for a real scanner; never taken on a real install (see DEMO_INDEX.md)
    if (pick.engine === "demo") {
      const parser = new NcduStreamParser(builder);
      const json = demo.ncduExport(root);
      for (let i = 0; i < json.length; i += 64 * 1024) {
        parser.push(json.slice(i, i + 64 * 1024));
        await new Promise((r) => setImmediate(r));
      }
      parser.end();
      done(null, parser.meta);
      return;
    }
    await spawnScan(s, builder, pick.engine, root, done);
  } catch (e) {
    done((e as Error).message, null);
  }
}

function spawnScan(s: Scan, builder: TreeBuilder, engine: DiskScanEngine, root: string, done: (error: string | null, meta: Record<string, unknown> | null) => void, kernfs = true): Promise<void> {
  return new Promise((resolve) => {
    const { cmd, args } = commandFor(engine, root, kernfs);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    s.child = child;
    const parser = engine === "du" ? new DuLineParser(builder, root) : new NcduStreamParser(builder);
    let stderr = "";
    let lineRest = "";
    let failed: string | null = null;
    const timer = setTimeout(() => {
      failed = `scan exceeded ${SCAN_TIMEOUT_MS / 3600_000} h and was stopped`;
      child.kill("SIGKILL");
    }, SCAN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        if (parser instanceof NcduStreamParser) parser.push(chunk);
        else {
          const lines = (lineRest + chunk).split("\n");
          lineRest = lines.pop() ?? "";
          for (const l of lines) parser.line(l);
        }
      } catch (e) {
        failed = `could not parse ${cmd} output: ${(e as Error).message}`;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      done(`could not start ${cmd}: ${e.message}`, null);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // old ncdu without --exclude-kernfs: retry once without it
      if (engine === "ncdu" && kernfs && code !== 0 && /exclude-kernfs|unknown option|Unknown option/i.test(stderr) && builder.dirs === 0) {
        void spawnScan(s, builder, engine, root, done, false).then(resolve);
        return;
      }
      try {
        if (parser instanceof DuLineParser) {
          if (lineRest) parser.line(lineRest);
          parser.end();
        } else parser.end();
      } catch (e) {
        failed ??= (e as Error).message;
      }
      // du/ncdu exit non-zero on unreadable entries but still produce a usable tree
      const err = failed ?? (code !== 0 && builder.files === 0 ? `${cmd} exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : code !== 0 ? `${cmd} exited ${code} (some entries could not be read): ${stderr.trim().split("\n").slice(-1)[0] ?? ""}` : null);
      done(err, parser instanceof NcduStreamParser ? parser.meta : null);
      resolve();
    });
  });
}

/** Start (or queue) a scan of `root`. One scan runs at a time. */
export async function startScan(root: string): Promise<DiskScanSummary> {
  const r = path.resolve(root);
  if (!path.isAbsolute(r) || /^\/(proc|sys|dev|run)(\/|$)/.test(r)) throw new HttpError(400, `${r} cannot be scanned`);
  if (!cfg.demo) {
    const st = await fsp.stat(r).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(404, `${r} is not a folder`);
  }
  if (running === r) return scans.get(r)!.summary;
  if (running) {
    if (!queue.includes(r)) queue.push(r);
    const existing = scans.get(r);
    return existing ? existing.summary : { id: "queued", root: r, engine: chooseEngine(await detectEngines()).engine, engineVersion: null, status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, error: `queued behind ${running}`, progress: { dirs: 0, files: 0 }, totals: { dsize: 0, asize: 0, files: 0, dirs: 0, readErrors: 0, excluded: 0 }, mount: null };
  }
  void runScan(r);
  return scans.get(r)!.summary;
}

export function cancelScan(): boolean {
  if (!running) return false;
  const s = scans.get(running);
  s?.child?.kill("SIGTERM");
  return true;
}

/** The scan whose root is the longest prefix of `p`. */
function scanFor(p: string, root?: string): Scan | null {
  if (root) return scans.get(path.resolve(root)) ?? null;
  let best: Scan | null = null;
  for (const s of scans.values()) {
    const r = s.summary.root;
    if ((p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`)) && (!best || r.length > best.summary.root.length)) best = s;
  }
  return best;
}

function summarizeDir(d: Dir): ScanDirSummary {
  return { name: d.name, path: d.path, dsize: d.dsize, asize: d.asize, files: d.files, dirs: d.dirs, mtime: d.mtime, ownFiles: d.ownFiles, ownBytes: d.ownBytes, readError: d.readError, excluded: d.excluded, hasChildren: d.children.length > 0 };
}

function statsOf(d: Dir): ScanStats {
  if (!d.stats) return { ext: [], age: [], owners: [], available: false };
  const ext = [...d.stats.ext].map(([k, v]) => ({ ext: k, bytes: v.bytes, count: v.count })).sort((a, b) => b.bytes - a.bytes);
  const kept = ext.slice(0, EXT_KEEP);
  const rest = ext.slice(EXT_KEEP);
  if (rest.length) kept.push({ ext: `(${rest.length} other types)`, bytes: rest.reduce((s, e) => s + e.bytes, 0), count: rest.reduce((s, e) => s + e.count, 0) });
  const age = d.stats.age.map(([bytes, count], i) => ({ label: i === AGE_UNKNOWN ? "unknown" : AGE_BUCKETS[i].label, bytes, count })).filter((a) => a.count > 0 || a.label !== "unknown");
  const owners = [...d.stats.owners].map(([uid, v]) => ({ uid, name: passwd?.get(uid) ?? null, bytes: v.bytes, count: v.count })).sort((a, b) => b.bytes - a.bytes);
  return { ext: kept, age, owners, available: true };
}

export function dirView(p: string, root?: string): DirViewPayload {
  const target = path.resolve(p);
  const s = scanFor(target, root);
  if (!s) throw new HttpError(404, `No scan covers ${target} yet`);
  if (!s.tree) throw new HttpError(s.summary.status === "running" ? 409 : 404, s.summary.status === "running" ? `Scan of ${s.summary.root} is still running` : (s.summary.error ?? "scan failed"));
  const d = s.byPath.get(target);
  if (!d) throw new HttpError(404, `${target} was not in the last scan of ${s.summary.root} (new folder, or excluded)`);
  return {
    scan: s.summary,
    dir: summarizeDir(d),
    parent: target === s.summary.root ? null : path.dirname(target),
    children: d.children.map(summarizeDir),
    top: d.top,
    stats: statsOf(d),
  };
}

export function topFiles(p: string, limit = 40, root?: string): ScanFile[] {
  return dirView(p, root).top.slice(0, limit);
}

/** Scan the next root that has never been scanned, failed, or is older than the interval. */
async function kick(): Promise<void> {
  if (running) return;
  const hours = cfg.diskScan.intervalHours;
  for (const r of await scanRoots()) {
    const s = scans.get(r);
    const stale = !s || s.summary.status === "failed" || (hours > 0 && !!s.summary.finishedAt && Date.now() - Date.parse(s.summary.finishedAt) > hours * 3600_000);
    if (stale && (hours > 0 || !s)) {
      await startScan(r).catch(() => {});
      return; // one at a time; the next kick (after this scan ends) picks up the rest
    }
  }
}

export async function initDiskScan(): Promise<void> {
  await loadPasswd();
  await loadPersisted();
  // first scan shortly after boot (the demo scans immediately so the page has data)
  setTimeout(() => void kick(), cfg.demo ? 500 : 60_000).unref();
  setInterval(() => void kick(), 15 * 60_000).unref();
}

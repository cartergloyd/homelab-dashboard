// The instructions & context file (CLAUDE.md) that agents read, with a versioned
// change log. Every save writes a snapshot under data/context-history/ and a
// line in data/context-history.jsonl; edits made outside the dashboard are
// detected by hash and recorded as "external".
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { ContextHistoryEntry, ContextPayload, ContextVersion } from "../types.js";
import { diffCounts, diffLines } from "../util/diff.js";
import { publish } from "./alerts.js";

const histFile = () => path.join(cfg.dataDir, "context-history.jsonl");
const snapDir = () => path.join(cfg.dataDir, "context-history");

let lastKnownHash: string | null = null;
let lastKnownContent = "";

const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

async function readFile(): Promise<{ content: string; mtime: string | null }> {
  try {
    const [content, st] = await Promise.all([fsp.readFile(cfg.contextFile, "utf8"), fsp.stat(cfg.contextFile)]);
    return { content, mtime: st.mtime.toISOString() };
  } catch {
    return { content: "", mtime: null };
  }
}

async function readHistory(): Promise<ContextHistoryEntry[]> {
  try {
    return (await fsp.readFile(histFile(), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ContextHistoryEntry);
  } catch {
    return [];
  }
}

async function record(newContent: string, prevContent: string, author: string, note: string): Promise<ContextHistoryEntry> {
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${crypto.randomBytes(2).toString("hex")}`;
  await fsp.mkdir(snapDir(), { recursive: true });
  await fsp.writeFile(path.join(snapDir(), `${id}.md`), newContent);
  const entry: ContextHistoryEntry = { id, ts: new Date().toISOString(), author, note, ...diffCounts(prevContent, newContent), bytes: Buffer.byteLength(newContent) };
  await fsp.appendFile(histFile(), `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function initContext(): Promise<void> {
  const { content } = await readFile();
  lastKnownHash = hashOf(content);
  lastKnownContent = content;
  if (content && (await readHistory()).length === 0) await record(content, "", "system", "Initial snapshot");
}

export async function readContext(): Promise<ContextPayload> {
  const { content, mtime } = await readFile();
  const hash = hashOf(content);
  if (lastKnownHash !== null && hash !== lastKnownHash) {
    await record(content, lastKnownContent, "external", "Changed outside the dashboard");
    publish({ source: "dashboard", kind: "log", level: "info", tags: ["maintenance"], text: `${path.basename(cfg.contextFile)} was changed outside the dashboard` });
  }
  lastKnownHash = hash;
  lastKnownContent = content;
  return { path: cfg.contextFile, content, hash, updatedAt: mtime };
}

export async function writeContext(content: string, baseHash: string | undefined, author: string, note: string): Promise<ContextPayload> {
  const current = await readContext();
  if (baseHash && baseHash !== current.hash) throw new HttpError(409, "The file changed since you opened it. Reload, then re-apply your edit.");
  if (content === current.content) return current;
  await fsp.mkdir(path.dirname(cfg.contextFile), { recursive: true });
  const tmp = `${cfg.contextFile}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, cfg.contextFile);
  const entry = await record(content, current.content, author, note);
  lastKnownHash = hashOf(content);
  lastKnownContent = content;
  publish({
    source: "dashboard",
    kind: "log",
    level: "info",
    tags: ["maintenance"],
    text: `${path.basename(cfg.contextFile)} updated by ${author} (+${entry.added} −${entry.removed})${note ? ` — ${note}` : ""}`,
  });
  return readContext();
}

export async function listHistory(): Promise<ContextHistoryEntry[]> {
  return (await readHistory()).reverse();
}

export async function getVersion(id: string): Promise<ContextVersion> {
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, "Invalid version id");
  const history = await readHistory();
  const idx = history.findIndex((h) => h.id === id);
  if (idx === -1) throw new HttpError(404, "Version not found");
  const content = await fsp.readFile(path.join(snapDir(), `${id}.md`), "utf8").catch(() => {
    throw new HttpError(404, "Snapshot file missing");
  });
  const prev = idx > 0 ? await fsp.readFile(path.join(snapDir(), `${history[idx - 1].id}.md`), "utf8").catch(() => "") : "";
  return { ...history[idx], content, diff: diffLines(prev, content) };
}

export async function restoreVersion(id: string, author: string): Promise<ContextPayload> {
  const v = await getVersion(id);
  const current = await readContext();
  return writeContext(v.content, current.hash, author, `Restored version ${id}`);
}

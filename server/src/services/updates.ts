// "Staged update" (Minecraft tab): what Paper and each plugin are at now (jar on
// disk), what has been staged for the next update/restart (jars waiting in the
// staging folder), and what upstream has released (PaperMC API, Modrinth, Hangar,
// GitHub) — with dates for all three. Read-only: nothing is downloaded or applied
// here; the owner's existing update-fetch + restart timers keep doing that.
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { listJobs } from "./scheduler.js";
import type { StagedUpdatePayload, UpdateItem, UpdateStatus, UpdateVersion } from "../types.js";

const UA = "homelab-dashboard/0.2 (+https://github.com/cartergloyd/homelab-dashboard)";
const UPSTREAM_TTL_MS = 6 * 3600_000;
const LOCAL_TTL_MS = 5 * 60_000;

// ---- jar reading --------------------------------------------------------------------
// A jar is a zip. Read only the central directory (at the end of the file), find the
// entry we want, inflate just that entry. No dependency, no full-file read.

export interface PluginMeta {
  name: string | null;
  version: string | null;
  apiVersion: string | null;
  main: string | null;
  authors: string[];
  website: string | null;
  kind: "plugin.yml" | "paper-plugin.yml" | null;
}

async function readZipEntry(file: string, wanted: string[]): Promise<{ name: string; text: string } | null> {
  const fh = await fsp.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) return null; // zip64: not expected for plugin jars
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (wanted.includes(name)) {
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, localOffset);
        if (lh.readUInt32LE(0) !== 0x04034b50) return null;
        const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = Buffer.alloc(compSize);
        await fh.read(data, 0, compSize, dataStart);
        const text = method === 8 ? zlib.inflateRawSync(data).toString("utf8") : method === 0 ? data.toString("utf8") : null;
        if (text === null) return null;
        return { name, text };
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Minimal YAML: top-level `key: value` lines plus a simple `- item` list for authors. */
export function parsePluginYml(text: string): Omit<PluginMeta, "kind"> {
  const get = (key: string): string | null => {
    const m = text.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, "mi"));
    if (!m) return null;
    const v = m[1].trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    return v && !/^\$\{/.test(v) ? v : null; // ${project.version} = unexpanded placeholder
  };
  let authors: string[] = [];
  const inline = text.match(/^authors?\s*:\s*\[(.*)\]\s*$/mi);
  if (inline) authors = inline[1].split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  else {
    const single = get("author");
    if (single) authors = [single];
    const block = text.match(/^authors\s*:\s*\n((?:\s+-\s*.*\n?)+)/mi);
    if (block) authors = block[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return { name: get("name"), version: get("version"), apiVersion: get("api-version"), main: get("main"), authors, website: get("website") };
}

export async function readPluginMeta(jar: string): Promise<PluginMeta | null> {
  try {
    const entry = await readZipEntry(jar, ["paper-plugin.yml", "plugin.yml"]);
    if (!entry) return null;
    return { ...parsePluginYml(entry.text), kind: entry.name as PluginMeta["kind"] };
  } catch {
    return null;
  }
}

// ---- installed + staged --------------------------------------------------------------

const PAPER_JAR = /^(?:paper|purpur|folia)[-_]?(\d+(?:\.\d+)+)(?:[-_](\d+))?.*\.jar$/i;

async function listJars(dir: string): Promise<{ file: string; name: string; mtime: Date }[]> {
  try {
    const names = await fsp.readdir(dir);
    const out: { file: string; name: string; mtime: Date }[] = [];
    for (const n of names) {
      if (!/\.jar$/i.test(n)) continue;
      const file = path.join(dir, n);
      const st = await fsp.stat(file).catch(() => null);
      if (st?.isFile()) out.push({ file, name: n, mtime: st.mtime });
    }
    return out;
  } catch {
    return [];
  }
}

function paperFromName(name: string): { version: string; build: number | null } | null {
  const m = name.match(PAPER_JAR);
  return m ? { version: m[1], build: m[2] ? Number(m[2]) : null } : null;
}

async function installedPaper(): Promise<UpdateVersion | null> {
  const dir = cfg.minecraft.dir;
  const jars = await listJars(dir);
  const paper = jars.map((j) => ({ ...j, meta: paperFromName(j.name) })).filter((j) => j.meta).sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
  if (paper?.meta) return { version: paper.meta.version, build: paper.meta.build, date: paper.mtime.toISOString(), file: paper.file, mcVersion: paper.meta.version };
  // Paper records what actually ran in version_history.json: "git-Paper-232 (MC: 1.21.4)" or "1.21.4-232-abcdef (MC: 1.21.4)"
  try {
    const vh = JSON.parse(await fsp.readFile(path.join(dir, "version_history.json"), "utf8")) as { currentVersion?: string };
    const cur = vh.currentVersion ?? "";
    const mc = cur.match(/MC:\s*([\d.]+)/)?.[1] ?? null;
    const build = cur.match(/(?:Paper-|-)(\d+)(?:-|\s|$)/)?.[1];
    const st = await fsp.stat(path.join(dir, "version_history.json"));
    const generic = jars.find((j) => /^(server|minecraft_server).*\.jar$/i.test(j.name));
    return { version: mc, build: build ? Number(build) : null, date: (generic?.mtime ?? st.mtime).toISOString(), file: generic?.file ?? null, mcVersion: mc };
  } catch {
    return null;
  }
}

async function stagingDirs(): Promise<{ path: string; exists: boolean; files: number }[]> {
  const mc = cfg.minecraft.dir;
  const candidates = cfg.updates.stagingDir ? [cfg.updates.stagingDir] : [path.join(mc, "plugins", "update"), path.join(mc, "updates"), path.join(mc, "staged"), path.join(mc, "staging"), path.join(mc, "update")];
  const out: { path: string; exists: boolean; files: number }[] = [];
  for (const c of candidates) {
    const jars = await listJars(c);
    const exists = await fsp
      .stat(c)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (exists || cfg.updates.stagingDir) out.push({ path: c, exists, files: jars.length });
  }
  return out;
}

// ---- upstream -------------------------------------------------------------------------

interface Cached<T> {
  at: number;
  value: T;
}
let upstreamCache = new Map<string, Cached<UpdateVersion | null>>();
const cacheFile = () => path.join(cfg.dataDir, "updates-cache.json");

async function loadCache(): Promise<void> {
  try {
    upstreamCache = new Map(Object.entries(JSON.parse(await fsp.readFile(cacheFile(), "utf8")) as Record<string, Cached<UpdateVersion | null>>));
  } catch {
    upstreamCache = new Map();
  }
}
const saveCache = () => fsp.writeFile(cacheFile(), JSON.stringify(Object.fromEntries(upstreamCache))).catch(() => {});

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function cached(key: string, fn: () => Promise<UpdateVersion | null>, force: boolean): Promise<UpdateVersion | null> {
  const c = upstreamCache.get(key);
  if (c && !force && Date.now() - c.at < UPSTREAM_TTL_MS) return c.value;
  const value = await fn();
  if (value || !c) upstreamCache.set(key, { at: Date.now(), value });
  void saveCache();
  return value;
}

async function latestPaper(mcVersion: string | null, force: boolean): Promise<{ latest: UpdateVersion | null; newestMc: string | null }> {
  const project = await cached("paper:project", async () => {
    const p = await getJson<{ versions: string[] }>("https://api.papermc.io/v2/projects/paper");
    return p ? { version: p.versions[p.versions.length - 1] ?? null, date: null, source: "papermc" } : null;
  }, force);
  const newestMc = project?.version ?? null;
  const target = mcVersion ?? newestMc;
  if (!target) return { latest: null, newestMc };
  const latest = await cached(`paper:${target}`, async () => {
    const b = await getJson<{ builds: { build: number; time: string; channel: string }[] }>(`https://api.papermc.io/v2/projects/paper/versions/${target}/builds`);
    const last = b?.builds?.[b.builds.length - 1];
    return last ? { version: `${target}-${last.build}`, build: last.build, date: last.time, channel: last.channel, url: `https://papermc.io/downloads/paper`, source: "papermc", mcVersion: target } : null;
  }, force);
  return { latest, newestMc };
}

async function latestPlugin(name: string, force: boolean): Promise<UpdateVersion | null> {
  const pref = cfg.updates.sources[name.toLowerCase()];
  if (pref === "none") return null;
  return cached(`plugin:${name.toLowerCase()}:${pref ?? "auto"}`, async () => {
    const [kind, ref] = pref ? pref.split(":", 2) : ["modrinth", null];
    if (kind === "hangar" && ref) {
      const r = await getJson<{ result: { name: string; createdAt: string }[] }>(`https://hangar.papermc.io/api/v1/projects/${ref}/versions?limit=1&platform=PAPER`);
      const v = r?.result?.[0];
      return v ? { version: v.name, date: v.createdAt, url: `https://hangar.papermc.io/${ref}`, source: "hangar" } : null;
    }
    if (kind === "github" && ref) {
      const r = await getJson<{ tag_name: string; published_at: string; html_url: string }>(`https://api.github.com/repos/${ref}/releases/latest`);
      return r ? { version: r.tag_name.replace(/^v/i, ""), date: r.published_at, url: r.html_url, source: "github" } : null;
    }
    // modrinth: by slug when given, else search and accept only an exact title/slug match
    let slug = ref;
    if (!slug) {
      const s = await getJson<{ hits: { slug: string; title: string }[] }>(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(name)}&limit=5&facets=${encodeURIComponent('[["project_type:plugin"]]')}`);
      const hit = s?.hits?.find((h) => h.title.toLowerCase() === name.toLowerCase() || h.slug.toLowerCase() === name.toLowerCase());
      if (!hit) return null;
      slug = hit.slug;
    }
    const versions = await getJson<{ version_number: string; date_published: string; loaders: string[] }[]>(`https://api.modrinth.com/v2/project/${slug}/version?loaders=${encodeURIComponent('["paper","bukkit","spigot"]')}`);
    const v = versions?.[0];
    return v ? { version: v.version_number.replace(/^v/i, ""), date: v.date_published, url: `https://modrinth.com/plugin/${slug}`, source: "modrinth" } : null;
  }, force);
}

// ---- compose ----------------------------------------------------------------------------

/** "1.21.4-232" vs "1.21.4-241", "2.21.0" vs "2.21.1": numeric fields left to right. */
export function compareVersions(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  if (!na.length || !nb.length) return null;
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function statusOf(installed: UpdateVersion | null, staged: UpdateVersion | null, latest: UpdateVersion | null): UpdateStatus {
  const iv = installed ? (installed.build !== null && installed.build !== undefined ? `${installed.version}-${installed.build}` : installed.version) : null;
  if (staged?.version && (!iv || compareVersions(staged.version, iv) !== 0)) return "staged";
  if (latest?.version && iv) {
    const c = compareVersions(latest.version, iv);
    if (c === null) return "unknown";
    return c > 0 ? "update-available" : "up-to-date";
  }
  return "unknown";
}

let localCache: { at: number; value: StagedUpdatePayload } | null = null;
let loaded = false;

export async function stagedUpdates(force = false): Promise<StagedUpdatePayload> {
  // [DEMO] demo-mode branch — fixed versions/dates instead of jars + upstream APIs; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.stagedUpdates();
  if (localCache && !force && Date.now() - localCache.at < LOCAL_TTL_MS) return localCache.value;
  if (!loaded) {
    await loadCache();
    loaded = true;
  }
  const notes: string[] = [];
  const mc = cfg.minecraft.dir;
  const paper = await installedPaper();
  if (!paper) notes.push(`No paper-*.jar or version_history.json found in ${mc} — is MC_DIR right?`);

  const plugins = await listJars(path.join(mc, "plugins"));
  const installed = new Map<string, UpdateVersion & { meta: PluginMeta }>();
  for (const j of plugins) {
    const meta = await readPluginMeta(j.file);
    const name = meta?.name ?? j.name.replace(/\.jar$/i, "");
    installed.set(name, { version: meta?.version ?? null, date: j.mtime.toISOString(), file: j.file, meta: meta ?? { name, version: null, apiVersion: null, main: null, authors: [], website: null, kind: null } });
  }

  const dirs = await stagingDirs();
  const staged = new Map<string, UpdateVersion>();
  let stagedPaper: UpdateVersion | null = null;
  let lastFetch: string | null = null;
  for (const d of dirs) {
    if (!d.exists) continue;
    for (const j of await listJars(d.path)) {
      if (!lastFetch || j.mtime.toISOString() > lastFetch) lastFetch = j.mtime.toISOString();
      const pm = paperFromName(j.name);
      if (pm) {
        stagedPaper = { version: `${pm.version}${pm.build !== null ? `-${pm.build}` : ""}`, build: pm.build, date: j.mtime.toISOString(), file: j.file, mcVersion: pm.version };
        continue;
      }
      const meta = await readPluginMeta(j.file);
      const name = meta?.name ?? j.name.replace(/\.jar$/i, "");
      staged.set(name, { version: meta?.version ?? null, date: j.mtime.toISOString(), file: j.file });
    }
  }
  if (!dirs.some((d) => d.exists)) notes.push(cfg.updates.stagingDir ? `UPDATE_STAGING_DIR ${cfg.updates.stagingDir} does not exist.` : "No staging folder found (looked for plugins/update, updates, staged, staging under MC_DIR). Set UPDATE_STAGING_DIR to where the update-fetch job puts new jars.");

  const check = cfg.updates.check;
  const { latest: latestP, newestMc } = check ? await latestPaper(paper?.mcVersion ?? stagedPaper?.mcVersion ?? null, force) : { latest: null, newestMc: null };
  const items: UpdateItem[] = [];
  items.push({ kind: "paper", name: "Paper", installed: paper, staged: stagedPaper, latest: latestP, status: statusOf(paper, stagedPaper, latestP), note: newestMc && paper?.mcVersion && compareVersions(newestMc, paper.mcVersion) === 1 ? `Minecraft ${newestMc} is out; builds here track ${paper.mcVersion}` : null });
  const names = [...new Set([...installed.keys(), ...staged.keys()])].sort((a, b) => a.localeCompare(b));
  for (const n of names) {
    const inst = installed.get(n) ?? null;
    const st = staged.get(n) ?? null;
    const latest = check ? await latestPlugin(n, force) : null;
    const authors = inst?.meta.authors.length ? `by ${inst.meta.authors.slice(0, 2).join(", ")}` : null;
    items.push({ kind: "plugin", name: n, installed: inst ? { version: inst.version, date: inst.date, file: inst.file } : null, staged: st, latest, status: statusOf(inst, st, latest), note: [authors, inst?.meta.apiVersion ? `api ${inst.meta.apiVersion}` : null, !latest && check ? "not found upstream — set PLUGIN_SOURCES" : null].filter(Boolean).join(" · ") || null });
  }
  if (!check) notes.push("UPDATE_CHECK=0: upstream versions are not looked up.");

  const jobs = listJobs().filter((j) => j.enabled && /update|restart/i.test(`${j.name} ${j.options.timer ?? ""} ${j.options.command ?? ""} ${j.options.script ?? ""}`));
  const next = jobs.filter((j) => j.nextRun).sort((a, b) => (a.nextRun ?? "").localeCompare(b.nextRun ?? ""))[0];
  const fetchJob = listJobs().find((j) => /fetch|update/i.test(`${j.name} ${j.options.timer ?? ""} ${j.options.script ?? ""}`) && j.lastRun?.finishedAt);
  const value: StagedUpdatePayload = {
    items,
    mcVersion: paper?.mcVersion ?? null,
    newestMcVersion: newestMc,
    stagingDirs: dirs,
    nextApply: next ? { job: next.name, at: next.nextRun } : null,
    lastFetch: lastFetch ?? fetchJob?.lastRun?.finishedAt ?? null,
    checkedAt: new Date().toISOString(),
    upstreamChecked: check,
    notes,
  };
  localCache = { at: Date.now(), value };
  return value;
}

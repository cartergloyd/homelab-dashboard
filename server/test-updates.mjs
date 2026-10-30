// Unit checks for the Staged update widget's jar reader and version logic. Run after
// `npm run build`:  node server/test-updates.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { compareVersions, latestPaper, latestPlugin, installedPaper, parsePluginYml, readPaperMeta, readPluginMeta, stagingDirs } from "./dist/services/updates.js";

let n = 0;
const eq = (a, b, what) => (assert.deepEqual(a, b, what), n++);

// ---- a tiny zip writer (stored or deflated entries), enough to fabricate a plugin jar
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const raw = Buffer.from(content, "utf8");
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hl-updates-"));
const yml = `name: EssentialsX
main: com.earth2me.essentials.Essentials
version: 2.21.1
api-version: '1.21'
description: Provides an essential, core set of commands for Bukkit.
authors: [Zenexer, ementalo, Aelux, Brettflan, KimKandor, snowleo, ceulemans, Xeology, KHobbits, md_5, Iaccidentally, drtshock, vemacs, SupaHam, md678685]
website: https://essentialsx.net`;
await fs.writeFile(path.join(tmp, "stored.jar"), zip([["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n", false], ["plugin.yml", yml, false]]));
await fs.writeFile(path.join(tmp, "deflated.jar"), zip([["com/x/Main.class", "\u0000\u0001\u0002", true], ["plugin.yml", yml, true]]));
await fs.writeFile(path.join(tmp, "paper.jar"), zip([["paper-plugin.yml", "name: Chunky\nversion: 1.4.28\napi-version: '1.19'\nauthors:\n  - pop4959\n  - another\nmain: org.popcraft.chunky.ChunkyBukkit\n", true], ["plugin.yml", "name: WRONG\nversion: 0\n", true]]));
await fs.writeFile(path.join(tmp, "noyml.jar"), zip([["README.txt", "nothing here", false]]));
await fs.writeFile(path.join(tmp, "garbage.jar"), Buffer.from("not a zip at all"));

for (const f of ["stored.jar", "deflated.jar"]) {
  const m = await readPluginMeta(path.join(tmp, f));
  eq(m?.name, "EssentialsX", `${f}: name`);
  eq(m?.version, "2.21.1", `${f}: version`);
  eq(m?.apiVersion, "1.21", `${f}: api-version with quotes stripped`);
  eq(m?.authors.length, 15, `${f}: inline author list`);
  eq(m?.kind, "plugin.yml", `${f}: kind`);
}
const paper = await readPluginMeta(path.join(tmp, "paper.jar"));
eq(paper?.name, "Chunky", "paper-plugin.yml preferred over plugin.yml");
eq(paper?.authors, ["pop4959", "another"], "block author list");
eq(await readPluginMeta(path.join(tmp, "noyml.jar")), null, "jar without plugin.yml → null");
eq(await readPluginMeta(path.join(tmp, "garbage.jar")), null, "non-zip → null, no throw");

eq(parsePluginYml("name: X\nversion: ${project.version}\n").version, null, "unexpanded maven placeholder → unknown");
eq(parsePluginYml('name: "Quoted Name"\nversion: "1.0" # trailing comment\nauthor: solo\n').authors, ["solo"], "single author");
eq(parsePluginYml('name: "Quoted Name"\nversion: "1.0" # trailing comment\n').version, "1.0", "comment stripped");

eq(compareVersions("1.21.4-232", "1.21.4-241"), -1, "paper builds");
eq(compareVersions("2.21.1", "2.21.0"), 1, "plugin semver");
eq(compareVersions("5.4.141", "5.4.141"), 0, "equal");
eq(compareVersions("1.7.3-b131", "1.7.3"), 1, "extra numeric field counts as newer");
eq(compareVersions("abc", "1.0"), null, "no digits → unknown");
eq(compareVersions(null, "1.0"), null, "missing → unknown");

const paperclip = "Manifest-Version: 1.0\r\nMain-Class: io.papermc.paperclip.Main\r\n\r\n";
const serverZip = zip([
  ["META-INF/MANIFEST.MF", paperclip, true],
  ["version.json", JSON.stringify({ id: "26.3" }), true],
  ["META-INF/libraries.list", "hash\tio.papermc.paper:paper-api:26.3.build.190-stable\tio/papermc/paper/paper-api/26.3.build.190-stable/paper-api-26.3.build.190-stable.jar\n", true],
]);
const install = path.join(tmp, "Minecraft Server");
await fs.mkdir(install);
await fs.writeFile(path.join(install, "paper-server.jar"), serverZip);
await fs.symlink("paper-server.jar", path.join(install, "server.jar"));
// Distractors must not override the actual launcher or the metadata in its jar.
await fs.writeFile(path.join(install, "paper-99.9-999.jar"), zip([]));
await fs.writeFile(path.join(install, "paper-version.txt"), "1.21.4\n");
await fs.writeFile(path.join(install, "paper-build.txt"), "42\n");
const active = await installedPaper(install);
eq(active?.version, "26.3", "renamed Paper launcher gets version from its jar");
eq(active?.build, 190, "Paperclip library metadata supplies the actual build, not stale tracking files");
eq(active?.file, path.join(install, "server.jar"), "server.jar symlink takes priority over archived versioned jars");
eq(active?.mcVersion, "26.3", "Minecraft version is available for update comparisons");
eq(active?.date, (await fs.stat(path.join(install, "paper-server.jar"))).mtime.toISOString(), "installation date comes from the jar");
for (const name of ["paper.jar", "paper-server.jar", "server.jar"]) {
  const dir = path.join(tmp, name.replace(".jar", "-install"));
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, name), serverZip);
  const found = await installedPaper(dir);
  eq([found?.version, found?.build], ["26.3", 190], `${name} works without plugins or version_history.json`);
}

const manifestJar = path.join(tmp, "manifest.jar");
await fs.writeFile(manifestJar, zip([["META-INF/MANIFEST.MF", "Implementation-Title: Paper\r\nSpecification-Version: 1.21.4\r\nImplementation-Version: 1.21.4-\r\n 232-abcdef\r\n\r\n", true]]));
eq(await readPaperMeta(manifestJar), { version: "1.21.4", build: 232 }, "unfolded manifest implementation supplies build when specification has none");

const tracked = path.join(tmp, "tracked-install");
await fs.mkdir(tracked);
await fs.writeFile(path.join(tracked, "paper.jar"), zip([["META-INF/MANIFEST.MF", paperclip, false], ["version.json", JSON.stringify({ id: "1.21.4" }), false]]));
await fs.writeFile(path.join(tracked, "paper-version.txt"), "1.21.4\n");
await fs.writeFile(path.join(tracked, "paper-build.txt"), "232\n");
eq((await installedPaper(tracked))?.build, 232, "matching tracking files supply build when the jar has only Minecraft version");
await fs.writeFile(path.join(tracked, "paper-version.txt"), "1.20.6\n");
eq((await installedPaper(tracked))?.build, null, "tracking from another Minecraft version is ignored");
await fs.writeFile(path.join(tracked, "version_history.json"), JSON.stringify({ currentVersion: "git-Paper-233 (MC: 1.21.4)" }));
eq((await installedPaper(tracked))?.build, 233, "legacy version_history remains a fallback");

const numbered = path.join(tmp, "numbered-install");
await fs.mkdir(numbered);
await fs.writeFile(path.join(numbered, "paper-1.21.4-232.jar"), zip([]));
eq([(await installedPaper(numbered))?.version, (await installedPaper(numbered))?.build], ["1.21.4", 232], "versioned filenames still work");
const unknown = path.join(tmp, "unknown-install");
await fs.mkdir(unknown);
await fs.writeFile(path.join(unknown, "paper.jar"), zip([]));
eq((await installedPaper(unknown))?.file, path.join(unknown, "paper.jar"), "existing Paper jar with unknown version is not reported missing");
const vanilla = path.join(tmp, "vanilla-install");
await fs.mkdir(vanilla);
await fs.writeFile(path.join(vanilla, "server.jar"), zip([["META-INF/MANIFEST.MF", "Main-Class: net.minecraft.bundler.Main\n", false], ["version.json", '{"id":"26.3"}', false]]));
eq(await installedPaper(vanilla), null, "generic vanilla jar is not mislabeled as Paper");
await fs.unlink(path.join(tracked, "paper.jar"));
eq(await installedPaper(tracked), null, "tracking/history files alone do not prove Paper is still installed");

// The maintenance scripts stage into separate paper/ and plugins/ subfolders.
const { cfg: stagingCfg } = await import("./dist/config.js");
const previousStaging = stagingCfg.updates.stagingDir;
const stageRoot = path.join(tmp, "updates");
await fs.mkdir(path.join(stageRoot, "paper"), { recursive: true });
await fs.mkdir(path.join(stageRoot, "plugins"));
await fs.writeFile(path.join(stageRoot, "paper", "paper-26.3-227.jar"), zip([]));
await fs.writeFile(path.join(stageRoot, "plugins", "Geyser-Spigot.jar"), zip([]));
stagingCfg.updates.stagingDir = stageRoot;
try {
  const dirs = await stagingDirs();
  eq(dirs.map(d => [path.relative(stageRoot, d.path), d.files]), [["", 0], ["paper", 1], ["plugins", 1]], "maintenance staging subfolders are scanned without traversing archives");
} finally { stagingCfg.updates.stagingDir = previousStaging; }

// Exercise the real provider selection with in-memory responses, never network or live data.
const realFetch = globalThis.fetch;
const { cfg } = await import("./dist/config.js");
const oldDataDir = cfg.dataDir;
cfg.dataDir = tmp;
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  let value;
  if (url.endsWith("/v3/projects/paper")) value = { versions: { "26.3": ["26.3-rc-3", "26.3"], "26.2": ["26.2"] } };
  else if (url.includes("/paper/versions/26.3/")) value = { id: 227, time: "2026-10-27T19:23:01Z", channel: "STABLE" };
  else if (url.includes("/projects/geyser/")) value = { version: "2.12.1", build: 1276, time: "2026-10-28T11:54:25Z", downloads: { spigot: {} } };
  else if (url.includes("/projects/floodgate/")) value = { version: "2.2.5", build: 141, time: "2026-09-17T14:53:03Z", downloads: { spigot: {} } };
  else throw new Error(`Unexpected upstream: ${url}`);
  return { ok: true, json: async () => value };
};
try {
  const paper = await latestPaper("26.3", true);
  eq(paper.newestMc, "26.3", "stable Minecraft version selected from v3 version groups");
  eq([paper.latest.version, paper.latest.build], ["26.3-227", 227], "Paper uses current v3 build API");
  eq((await latestPlugin("Geyser-Spigot", true)).version, "2.12.1", "Geyser automatically uses its official build API");
  eq((await latestPlugin("floodgate", true)).build, 141, "Floodgate automatically uses its official build API");
  cfg.updates.sources["geyser-spigot"] = "none";
  eq(await latestPlugin("Geyser-Spigot", true), null, "explicit source override wins over built-in mapping");
  delete cfg.updates.sources["geyser-spigot"];
  eq(calls.length, 4, "no Modrinth or GitHub-release fallback for official build providers");
} finally {
  globalThis.fetch = realFetch;
  cfg.dataDir = oldDataDir;
}
// Let the asynchronous cache write finish before removing its temporary directory.
await new Promise(resolve => setTimeout(resolve, 100));
await fs.rm(tmp, { recursive: true, force: true });
console.log(`updates: ${n} checks passed`);

// Unit checks for the Staged update widget's jar reader and version logic. Run after
// `npm run build`:  node server/test-updates.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { compareVersions, parsePluginYml, readPluginMeta } from "./dist/services/updates.js";

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

await fs.rm(tmp, { recursive: true, force: true });
console.log(`updates: ${n} checks passed`);

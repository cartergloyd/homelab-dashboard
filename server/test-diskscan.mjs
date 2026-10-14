// Unit checks for the storage explorer engine: the streaming ncdu parser, the du
// fallback parser, and the demo fixture. Run after `npm run build`:
//   node server/test-diskscan.mjs
import assert from "node:assert/strict";
import { DuLineParser, NcduStreamParser, extOf } from "./dist/services/diskscan.js";

let n = 0;
const eq = (a, b, what) => (assert.deepEqual(a, b, what), n++);

// TreeBuilder is internal; reach it the way the engine does — through a parser.
// Build a small export by hand (format: https://dev.yorhel.nl/ncdu/jsonfmt).
const NOW = Math.floor(Date.now() / 1000);
const day = 86400;
const file = (name, size, extra = {}) => JSON.stringify({ name, asize: size, dsize: size, ...extra });
const EXPORT = `[1,2,{"progname":"ncdu","progver":"2.3","timestamp":${NOW}},
[{"name":"/srv","asize":4096,"dsize":4096,"dev":66306,"ino":2},
  [{"name":"media","asize":4096,"dsize":4096},
    [{"name":"movies","asize":4096,"dsize":4096},
      ${file("Heat (1995).mp4", 6_000_000, { mtime: NOW - 400 * day, uid: 1000 })},
      ${file('Arrival "2016".mkv', 9_000_000, { mtime: NOW - 2 * day, uid: 1000 })},
      ${file("odd [name] {braces}.mkv", 1_000, { mtime: NOW - 40 * day, uid: 1000 })}
    ],
    [{"name":"music","asize":4096,"dsize":4096},
      ${file("a.flac", 1000, { mtime: NOW - 300 * day, uid: 1001 })},
      ${file("b.flac", 2000, { mtime: NOW - 300 * day, uid: 1001 })},
      ${file("hardlink-one", 5000, { nlink: 2, ino: 77, mtime: NOW - 10 * day })},
      ${file("hardlink-two", 5000, { nlink: 2, ino: 77, mtime: NOW - 10 * day })}
    ],
    [{"name":"private","asize":4096,"dsize":4096,"read_error":true}],
    [{"name":"usb","asize":4096,"dsize":4096,"excluded":"otherfs"}],
    ${file("notes.txt", 10, { mtime: NOW - 1 * day, uid: 0 })},
    ${file("broken-link", 0, { notreg: true })}
  ]
]]`;

// A fake TreeBuilder-compatible sink is not exposed, so test through the real one:
// NcduStreamParser needs a TreeBuilder; import it indirectly via a parse helper.
import * as engine from "./dist/services/diskscan.js";
const TreeBuilder = engine.TreeBuilder ?? null;
assert.ok(TreeBuilder, "TreeBuilder must be exported for tests");

function parseChunked(text, chunk) {
  const b = new TreeBuilder(NOW);
  const p = new NcduStreamParser(b);
  for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
  p.end();
  return { b, p };
}

for (const chunk of [7, 64, 100_000]) {
  const { b, p } = parseChunked(EXPORT, chunk);
  const root = b.root;
  eq(p.meta.progname, "ncdu", `meta parsed (chunk ${chunk})`);
  eq(root.path, "/srv", "root path is the full path");
  eq(root.children.map((c) => c.name), ["media"], "root children");
  const media = root.children[0];
  eq(media.children.map((c) => c.name), ["movies", "music", "private", "usb"], "children sorted by size desc");
  const movies = media.children[0];
  eq(movies.files, 3, "movies file count");
  eq(movies.dsize, 4096 + 6_000_000 + 9_000_000 + 1_000, "movies dsize = own entry + files");
  eq(movies.top[0].name, 'Arrival "2016".mkv', "escaped quote in a name survives; top file sorted");
  eq(movies.top[0].ext, "mkv", "ext");
  const music = media.children[1];
  eq(music.dsize, 4096 + 1000 + 2000 + 5000, "hard-linked file counted once");
  eq(music.files, 4, "but still listed as 4 files");
  eq(media.children[2].readError, true, "read_error carried");
  eq(media.children[3].excluded, "otherfs", "excluded carried");
  eq(root.files, 3 + 4 + 2, "root files incl. loose + non-regular");
  eq(root.dsize, 4096 + media.dsize, "root dsize = own + media");
  eq(media.ownFiles, 2, "loose files counted on media");
  eq(b.readErrors, 1, "read errors counted");
  eq(b.excluded, 1, "excluded counted");
  eq(root.mtime, NOW - 1 * day, "newest mtime bubbles up");
  // stats on the top levels
  const ext = [...root.stats.ext.entries()].sort((a, b2) => b2[1].bytes - a[1].bytes);
  eq(ext[0][0], "mkv", "largest ext");
  eq(root.stats.owners.get(1001).count, 2, "owner stats");
  eq(root.stats.age[0][1], 2, "two files < 1 week (Arrival, notes)");
  eq(root.stats.age[root.stats.age.length - 1][1], 1, "one file with unknown mtime (broken-link)");
}

// du fallback: post-order lines
const DU = `4\t/data/a/x.txt
8\t/data/a/y.txt
16\t/data/a
100\t/data/big.bin
120\t/data`;
{
  const b = new TreeBuilder(NOW);
  const p = new DuLineParser(b, "/data");
  for (const l of DU.split("\n")) p.line(l);
  p.end();
  eq(b.root.path, "/data", "du root");
  eq(b.root.dsize, 120 * 1024, "du root size is du's cumulative number");
  eq(b.root.children.map((c) => c.name), ["a"], "du child dir");
  eq(b.root.children[0].files, 2, "du child files");
  eq(b.root.files, 3, "du total files");
  eq(b.root.top[0].name, "big.bin", "du top file");
}

eq(extOf("movie.MKV"), "mkv", "ext lowercase");
eq(extOf("world.tar.gz"), "tar.gz", "compound ext");
eq(extOf("README"), "(none)", "no ext");
eq(extOf(".bashrc"), "bashrc", "dotfile ext");

// demo fixture parses with the same engine and matches the fake disk totals
const demo = await import("./dist/demo.js");
if (typeof demo.ncduExport === "function") {
  const json = demo.ncduExport("/");
  assert.ok(json.startsWith("[1,2,{"), "fixture is an ncdu export");
  JSON.parse(json); // must be valid JSON as a whole too
  const { b } = parseChunked(json, 4096);
  assert.ok(b.root.dsize > 50 * 1024 ** 3 && b.root.dsize < 200 * 1024 ** 3, "demo / is ~80 GB once the other mounts are excluded");
  const srv = b.root.children.find((c) => c.name === "srv");
  assert.ok(srv && srv.children.length === 1 && srv.children[0].excluded === "otherfs" && srv.children[0].files === 0, "/srv/media is listed under /srv as an excluded mount point, not descended into");
  assert.ok(b.files > 200, "demo has a few hundred files");
  n += 3;
  const media = parseChunked(demo.ncduExport("/srv/media"), 4096).b.root;
  assert.ok(media.children.map((c) => c.name).includes("movies"), "scan of /srv/media descends into movies");
  n++;
}

console.log(`diskscan: ${n} checks passed`);

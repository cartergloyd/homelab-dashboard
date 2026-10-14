#!/usr/bin/env node
// Lists every demo-only code site so the installing agent can see exactly what is
// fake. Convention: a `[DEMO]` tag in a comment marks a demo-mode branch, fixture or
// UI element; DEMO_INDEX.md explains each one. `--check` fails when a file that
// contains a [DEMO] tag (or a `cfg.demo` branch) is not mentioned in DEMO_INDEX.md.
//
//   npm run demo:index              # print the tags grouped by file
//   npm run demo:index -- --check   # verify DEMO_INDEX.md covers every tagged file (used by npm test)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../.."); // dist/tools → dist → server → repo
const check = process.argv.includes("--check");

const ROOTS = ["server/src", "web/src", "scripts", "deploy", "docker-compose.yml", "package.json", ".mcp.json", "README.md", "SERVER_SETUP.md", "CLAUDE.md"];
const SKIP = /node_modules|\/dist\/|\.d\.ts$|DEMO_INDEX\.md$/;

function* walk(p: string): Generator<string> {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const n of fs.readdirSync(p)) yield* walk(path.join(p, n));
}

interface Hit {
  file: string;
  line: number;
  text: string;
  kind: "tag" | "branch";
}
const hits: Hit[] = [];
for (const root of ROOTS) {
  for (const f of walk(path.join(repo, root))) {
    if (SKIP.test(f) || !/\.(ts|tsx|js|mjs|sh|md|yml|yaml|json|service|example)$/.test(f)) continue;
    const rel = path.relative(repo, f);
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (l.includes("[DEMO]")) hits.push({ file: rel, line: i + 1, text: l.trim().slice(0, 140), kind: "tag" });
      else if (/\bcfg\.demo\b|config\.data\?\.demo\b|process\.env\.DEMO\b/.test(l)) hits.push({ file: rel, line: i + 1, text: l.trim().slice(0, 140), kind: "branch" });
    });
  }
}

const byFile = new Map<string, Hit[]>();
for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);

const index = fs.existsSync(path.join(repo, "DEMO_INDEX.md")) ? fs.readFileSync(path.join(repo, "DEMO_INDEX.md"), "utf8") : "";
const missing: string[] = [];
const untagged: string[] = [];
for (const [file, list] of [...byFile.entries()].sort()) {
  const tagged = list.some((h) => h.kind === "tag");
  if (!tagged) untagged.push(file);
  if (!index.includes(file)) missing.push(file);
}

if (!check) {
  for (const [file, list] of [...byFile.entries()].sort()) {
    console.log(`\n${file}${index.includes(file) ? "" : "   (NOT in DEMO_INDEX.md)"}`);
    for (const h of list) console.log(`  ${String(h.line).padStart(4)}  ${h.kind === "tag" ? "[DEMO]" : "branch"}  ${h.text}`);
  }
  console.log(`\n${byFile.size} file(s) with demo code; ${hits.filter((h) => h.kind === "tag").length} [DEMO] tag(s), ${hits.filter((h) => h.kind === "branch").length} demo branch line(s).`);
}
if (missing.length) console.log(`${check ? "✖" : "!"} Not mentioned in DEMO_INDEX.md: ${missing.join(", ")}`);
if (untagged.length) console.log(`! Files with a demo branch but no [DEMO] tag: ${untagged.join(", ")}`);
if (check) {
  if (missing.length) process.exit(1);
  console.log(`demo-index: DEMO_INDEX.md covers all ${byFile.size} file(s) with demo code${untagged.length ? ` (${untagged.length} without an explicit tag)` : ""}`);
}

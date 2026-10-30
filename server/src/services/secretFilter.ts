// Keeps secrets out of what an agent sends off the server: Minecraft chat (say, tell, tellraw …),
// which DiscordSRV relays to Discord, and the public Discord support replies. It looks for the
// actual secret values this server holds and for the shapes of common tokens, and reports what
// kind of secret it found without ever repeating it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg } from "../config.js";

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/;
const NOT_A_VALUE = /_(FILE|DIR|PATH)$/;
const MIN_LENGTH = 8;
const RELOAD_MS = 5 * 60_000;
const SHAPES: [RegExp, string][] = [
  [/hlr_[\w-]{20,}/, "a run token"],
  [/\b[MNO][\w-]{23,27}\.[\w-]{6}\.[\w-]{27,}/, "a Discord bot token"],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, "a JSON web token"],
  [/\b(?:sk|ghp|gho|ghs|github_pat|xox[abp])[-_][\w-]{16,}/, "an API token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

let known = new Map<string, string>();
let loadedAt = 0;

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function add(values: Map<string, string>, value: string | undefined, label: string): void {
  const v = value?.trim().replace(/^["']|["']$/g, "");
  if (v && v.length >= MIN_LENGTH && !values.has(v)) values.set(v, label);
}

function addEnv(values: Map<string, string>, entries: [string, string | undefined][], from = ""): void {
  for (const [name, value] of entries) {
    if (SECRET_NAME.test(name) && !NOT_A_VALUE.test(name)) add(values, value, `${name}${from}`);
    try {
      const url = new URL(value ?? "");
      if (url.password) add(values, decodeURIComponent(url.password), `the password in ${name}${from}`);
    } catch {
      // not a URL
    }
  }
}

function addTokens(values: Map<string, string>, node: unknown, label: string, key = ""): void {
  if (typeof node === "string" && /token|key|secret/i.test(key)) add(values, node, label);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) addTokens(values, v, label, k);
}

function load(): Map<string, string> {
  const values = new Map<string, string>();
  addEnv(values, Object.entries(process.env)); // the dashboard's EnvironmentFile
  const tokenFile = cfg.discordSupport.tokenFile;
  if (tokenFile) {
    const lines = readFile(tokenFile).split("\n").map((l) => l.match(/^\s*([A-Za-z_]\w*)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m);
    addEnv(values, lines.map((m) => [m[1], m[2]]), ` (${path.basename(tokenFile)})`);
  }
  add(values, readFile(path.join(cfg.minecraft.dir, "plugins/DiscordSRV/config.yml")).match(/^BotToken:\s*"?([^"\s]+)"?/m)?.[1], "DiscordSRV's bot token");
  try {
    addTokens(values, JSON.parse(readFile(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json")) || "null"), "Codex's sign-in token");
  } catch {
    // no Codex sign-in on this machine
  }
  return values;
}

/** What kind of secret `text` contains — a name, never the value — or null when it holds none. */
export function secretIn(text: string): string | null {
  if (Date.now() - loadedAt > RELOAD_MS) {
    known = load();
    loadedAt = Date.now();
  }
  for (const [value, label] of known) if (text.includes(value)) return label;
  for (const [shape, label] of SHAPES) if (shape.test(text)) return label;
  return null;
}

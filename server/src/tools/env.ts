// Shared by the CLI tools: load the service's environment file so the tools see
// the same configuration as the running dashboard.
import fs from "node:fs";

export const DEFAULT_ENV_FILE = "/etc/homelab-dashboard.env";

/** KEY=VALUE lines (quotes optional, # comments). Existing process.env wins. */
export function loadEnvFile(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

export function envFileFromArgs(argv: string[]): string {
  const i = argv.indexOf("--env");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : (process.env.HOMELAB_ENV_FILE ?? DEFAULT_ENV_FILE);
}

export function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Quote a path for a shell/systemd snippet only when it needs it. */
export function shq(p: string): string {
  return /[\s"'\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, "\\$1")}"` : p;
}

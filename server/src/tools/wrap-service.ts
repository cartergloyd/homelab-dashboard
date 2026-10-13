#!/usr/bin/env node
// Wrap an existing systemd service's ExecStart with scripts/hl-run.sh so its
// output (and exit code) land in the Live Server Alerts feed. The timer that
// schedules it is untouched. Prints the drop-in by default; --apply writes it
// (run with sudo) and reloads systemd; --test sends a test event through hl-run
// and checks the dashboard received it.
//
//   npm run wrap-service -- mc-backup.service
//   sudo npm run wrap-service -- mc-backup.service --apply
//   npm run wrap-service -- mc-backup.service --test
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { envFileFromArgs, flag, loadEnvFile } from "./env.js";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const envFile = envFileFromArgs(argv);
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--env");
const service = positional[0];
if (!service) {
  console.error("usage: wrap-service <unit.service|unit.timer> [--apply] [--test] [--env FILE]");
  process.exit(64);
}
const unit = /\.(service|timer)$/.test(service) ? service.replace(/\.timer$/, ".service") : `${service}.service`;
loadEnvFile(envFile);
const { cfg } = await import("../config.js");

const HL_RUN = "/usr/local/bin/hl-run";

async function sh(cmd: string, args: string[]): Promise<string> {
  try {
    return (await execFileP(cmd, args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}

const load = await sh("systemctl", ["show", unit, "-p", "LoadState", "--value", "--no-pager"]);
if (load.trim() !== "loaded") {
  console.error(`${unit} is not a loaded systemd unit (LoadState=${load.trim() || "?"}). Check: systemctl list-units --all | grep -i ${service}`);
  process.exit(1);
}

// `systemctl cat` shows the unit file(s) with the ORIGINAL quoting, which is what we
// must preserve for paths with spaces. The last ExecStart= wins (drop-ins override).
const cat = await sh("systemctl", ["cat", unit, "--no-pager"]);
const execLines = cat.split("\n").filter((l) => /^\s*ExecStart=/.test(l));
const lastExec = execLines[execLines.length - 1]?.replace(/^\s*ExecStart=/, "").trim() ?? "";
if (!lastExec) {
  console.error(`Could not find an ExecStart= line in ${unit}:\n${cat}`);
  process.exit(1);
}

if (/hl-run/.test(lastExec)) {
  console.log(`${unit} already runs through hl-run:\n  ExecStart=${lastExec}`);
} else {
  // systemd ExecStart prefixes (-, @, +, !, :) must stay in front of the new executable.
  const m = lastExec.match(/^([-@+!:]*)(.*)$/);
  const prefix = m?.[1] ?? "";
  const command = (m?.[2] ?? lastExec).trim();
  const dropIn = `# Added by homelab-dashboard (npm run wrap-service): route this unit's output into the
# Live Server Alerts feed via hl-run. The timer/schedule is untouched.
# Original: ExecStart=${lastExec}
[Service]
EnvironmentFile=-${envFile}
ExecStart=
ExecStart=${prefix}${HL_RUN} ${command}
`;
  const dir = `/etc/systemd/system/${unit}.d`;
  const file = path.join(dir, "homelab-hl-run.conf");
  console.log(`Drop-in for ${unit} → ${file}\n\n${dropIn}`);
  if (flag(argv, "--apply")) {
    try {
      await fs.access(HL_RUN);
    } catch {
      console.error(`${HL_RUN} is missing. Install it first: sudo install -m 0755 scripts/hl-run.sh ${HL_RUN}`);
      process.exit(1);
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, dropIn);
    await execFileP("systemctl", ["daemon-reload"]);
    const after = await sh("systemctl", ["show", unit, "-p", "ExecStart", "--no-pager"]);
    console.log(`Applied. systemd now reports:\n  ${after.trim()}`);
  } else {
    console.log("Dry run. Re-run with --apply (as root) to write it and reload systemd.");
  }
}

if (flag(argv, "--test")) {
  const key = cfg.dashboardKey;
  const url = `http://${cfg.host}:${cfg.port}`;
  if (!key) {
    console.error("DASHBOARD_KEY is not set; cannot test ingestion.");
    process.exit(1);
  }
  const marker = `wrap-service test ${Date.now()}`;
  const env = { ...process.env, HOMELAB_URL: url, HOMELAB_KEY: key };
  const runner = await fs
    .access(HL_RUN)
    .then(() => [HL_RUN])
    .catch(() => ["bash", path.join(cfg.repoRoot, "scripts", "hl-run.sh")]);
  await execFileP(runner[0], [...runner.slice(1), "echo", marker], { env });
  await new Promise((r) => setTimeout(r, 1500));
  const res = await fetch(`${url}/api/alerts?sources=scripts&limit=50`, { headers: { Authorization: `Bearer ${key}` } });
  const events = (await res.json()) as { text: string }[];
  const seen = events.some((e) => e.text.includes(marker));
  console.log(seen ? "✔ Test event reached the alerts feed." : "✖ Test event did NOT appear in the feed — is the dashboard running and the key correct?");
  if (!seen) process.exit(1);
}

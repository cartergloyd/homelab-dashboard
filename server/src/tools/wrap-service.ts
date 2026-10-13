#!/usr/bin/env node
// Route an existing scheduled job's output into the Live Server Alerts feed.
//
// Timer-backed (systemd): wraps the service's ExecStart with hl-run via a drop-in;
// the timer and schedule are untouched. Cron-backed: there is nothing to write for
// you — `npm run discover` prints the wrapped crontab line — but --install-hl-run
// puts hl-run and its env file in place so that line works.
//
//   sudo npm run wrap-service -- --install-hl-run           # /usr/local/bin/hl-run + /etc/homelab-hl-run.env
//   npm run wrap-service -- mc-backup.service               # print the drop-in (dry run)
//   sudo npm run wrap-service -- mc-backup.service --apply --test
//   npm run wrap-service -- --test                          # just prove hl-run reaches the feed
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { envFileFromArgs, flag, loadEnvFile } from "./env.js";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const envFile = envFileFromArgs(argv);
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--env");
const service = positional[0];
const install = flag(argv, "--install-hl-run");
const apply = flag(argv, "--apply");
const test = flag(argv, "--test");
if (!service && !install && !test) {
  console.error("usage: wrap-service [<unit.service|unit.timer>] [--apply] [--test] [--install-hl-run] [--env FILE]");
  process.exit(64);
}
loadEnvFile(envFile);
const { cfg } = await import("../config.js");

const HL_RUN = "/usr/local/bin/hl-run";
// Only HOMELAB_URL + HOMELAB_KEY — never the whole dashboard env (it holds the Jellyfin
// key and the Postgres password, which the maintenance scripts have no business seeing).
const HL_ENV = "/etc/homelab-hl-run.env";
const url = `http://${cfg.host}:${cfg.port}`;

async function sh(cmd: string, args: string[]): Promise<string> {
  try {
    return (await execFileP(cmd, args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? "";
  }
}
const fileExists = (p: string) => fs.access(p).then(() => true, () => false);

async function writeHlEnv(): Promise<void> {
  if (!cfg.dashboardKey) {
    console.error(`DASHBOARD_KEY is not set in ${envFile}; cannot write ${HL_ENV}.`);
    process.exit(1);
  }
  const body = `# Written by homelab-dashboard (npm run wrap-service). Read by /usr/local/bin/hl-run when\n# a cron line or systemd unit runs it without HOMELAB_* in its environment.\nHOMELAB_URL=${url}\nHOMELAB_KEY=${cfg.dashboardKey}\n`;
  await fs.writeFile(HL_ENV, body, { mode: 0o600 });
  await fs.chmod(HL_ENV, 0o600);
  console.log(`Wrote ${HL_ENV} (0600, root). For a crontab that runs as another user, either\n  sudo chown root:<user> ${HL_ENV} && sudo chmod 0640 ${HL_ENV}\nor put HOMELAB_KEY=… at the top of that crontab.`);
}

if (install) {
  const src = path.join(cfg.repoRoot, "scripts", "hl-run.sh");
  try {
    await fs.copyFile(src, HL_RUN);
    await fs.chmod(HL_RUN, 0o755);
    console.log(`Installed ${HL_RUN} from ${src}`);
    await writeHlEnv();
  } catch (e) {
    console.error(`Could not install hl-run: ${(e as Error).message} (run with sudo)`);
    process.exit(1);
  }
}

if (service) {
  const unit = /\.(service|timer)$/.test(service) ? service.replace(/\.timer$/, ".service") : `${service}.service`;
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
EnvironmentFile=-${HL_ENV}
ExecStart=
ExecStart=${prefix}${HL_RUN} ${command}
`;
    const dir = `/etc/systemd/system/${unit}.d`;
    const file = path.join(dir, "homelab-hl-run.conf");
    console.log(`Drop-in for ${unit} → ${file}\n\n${dropIn}`);
    if (apply) {
      if (!(await fileExists(HL_RUN))) {
        console.error(`${HL_RUN} is missing. Install it first: sudo npm run wrap-service -- --install-hl-run`);
        process.exit(1);
      }
      if (!(await fileExists(HL_ENV))) await writeHlEnv();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, dropIn);
      await execFileP("systemctl", ["daemon-reload"]);
      const after = await sh("systemctl", ["show", unit, "-p", "ExecStart", "--no-pager"]);
      console.log(`Applied. systemd now reports:\n  ${after.trim()}`);
    } else {
      console.log("Dry run. Re-run with --apply (as root) to write it and reload systemd.");
    }
  }
}

if (test) {
  const key = cfg.dashboardKey;
  if (!key) {
    console.error("DASHBOARD_KEY is not set; cannot test ingestion.");
    process.exit(1);
  }
  const marker = `wrap-service test ${Date.now()}`;
  // Run hl-run the way cron/systemd would: only the env file, no HOMELAB_* in the environment.
  const env = { ...process.env };
  delete env.HOMELAB_URL;
  delete env.HOMELAB_KEY;
  delete env.DASHBOARD_KEY;
  const viaEnvFile = await fs.access(HL_ENV, fsConstants.R_OK).then(() => true, () => false);
  if (!viaEnvFile) Object.assign(env, { HOMELAB_URL: url, HOMELAB_KEY: key });
  const runner = (await fileExists(HL_RUN)) ? [HL_RUN] : ["bash", path.join(cfg.repoRoot, "scripts", "hl-run.sh")];
  const { stderr } = await execFileP(runner[0], [...runner.slice(1), "echo", marker], { env });
  if (stderr.trim()) console.log(stderr.trim());
  await new Promise((r) => setTimeout(r, 1500));
  const res = await fetch(`${url}/api/alerts?sources=scripts&limit=50`, { headers: { Authorization: `Bearer ${key}` } });
  const events = (await res.json()) as { text: string }[];
  const seen = events.some((e) => e.text.includes(marker));
  const exit = events.some((e) => /^✔ echo exited 0/.test(e.text));
  console.log(seen ? `✔ Test event reached the alerts feed${viaEnvFile ? ` using ${HL_ENV}` : " (credentials passed in the environment)"}.` : "✖ Test event did NOT appear in the feed — is the dashboard running and the key correct?");
  if (seen && !exit) console.log("! The exit code was not reported — the installed hl-run is older than scripts/hl-run.sh; re-run with --install-hl-run.");
  if (!seen) process.exit(1);
}

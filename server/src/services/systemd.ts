import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import type { UnitState } from "../types.js";

const execFileP = promisify(execFile);

export type UnitAction = "start" | "stop" | "restart";

function unitName(unit: string): string {
  return unit.endsWith(".service") ? unit : `${unit}.service`;
}

/** `systemctl show` needs no privileges, so this works for any unit. */
export async function unitState(unit: string): Promise<UnitState | null> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.unitState(unit);
  try {
    const { stdout } = await execFileP(
      "systemctl",
      ["show", unitName(unit), "--no-pager", "--property=ActiveState,SubState,ActiveEnterTimestamp,MainPID,MemoryCurrent,LoadState"],
      { timeout: 5000 },
    );
    const kv: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    if (kv.LoadState === "not-found") return null;
    const mem = Number(kv.MemoryCurrent);
    return {
      unit,
      active: kv.ActiveState ?? "unknown",
      sub: kv.SubState ?? "",
      since: kv.ActiveEnterTimestamp || null,
      pid: Number(kv.MainPID) || null,
      memoryBytes: Number.isFinite(mem) && mem > 0 ? mem : null,
    };
  } catch {
    return null;
  }
}

/**
 * Privileged: relies on the exact-argument sudoers rules in deploy/sudoers-homelab.
 * [INSTALLER] Those rules name `minecraft.service` and `/usr/bin/systemctl`. If the
 * real unit is called something else (MC_SERVICE) or systemctl lives in /bin, the
 * sudoers file must be changed to match or every Start/Stop/Restart fails with
 * "a password is required".
 */
export async function unitAction(unit: string, action: UnitAction): Promise<void> {
  if (cfg.demo) return demo.unitAction(unit, action);
  await execFileP("sudo", ["-n", "systemctl", action, unitName(unit)], { timeout: 180_000 });
}

/** Tails journald; returns a stop function. `args` selects the unit/priority. `onEnd` fires if the tail dies. */
export function followJournal(args: string[], onLine: (line: string) => void, onEnd?: () => void): () => void {
  const child = spawn("journalctl", [...args, "-f", "-n", "200", "-o", "cat", "--no-pager"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd?.();
  };
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", onLine);
  child.stderr.on("data", (d: Buffer) => onLine(`[journalctl] ${d.toString().trim()}`));
  child.on("error", (e) => {
    onLine(`[journalctl unavailable] ${e.message}`);
    end();
  });
  child.on("close", end);
  return () => {
    ended = true; // a deliberate stop is not a failure
    rl.close();
    if (!child.killed) child.kill();
  };
}

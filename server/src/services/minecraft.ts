import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { rconCommand, stripColour } from "./rcon.js";
import { pingServer } from "./slp.js";
import { unitAction, unitState, type UnitAction } from "./systemd.js";
import type { McPlayers, MinecraftPayload } from "../types.js";

export function parseList(output: string): McPlayers {
  const m = stripColour(output).match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)/i);
  if (!m) throw new Error(`Unexpected "list" output: ${output.slice(0, 120)}`);
  return {
    online: Number(m[1]),
    max: Number(m[2]),
    names: m[3]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export async function getPlayers(): Promise<McPlayers> {
  return parseList(await rconCommand("list"));
}

export async function minecraftStatus(): Promise<MinecraftPayload> {
  const [unit, ping, players] = await Promise.all([
    unitState(cfg.minecraft.service),
    pingServer().catch(() => null),
    getPlayers().then(
      (p) => ({ ok: true as const, p }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    ),
  ]);
  return {
    unit,
    ping,
    rcon: players.ok ? { ok: true } : { ok: false, error: players.error },
    players: players.ok ? players.p : null,
    address: cfg.minecraft.publicAddress ?? `${cfg.minecraft.host}:${cfg.minecraft.port}`,
  };
}

export async function minecraftAction(action: UnitAction): Promise<void> {
  await unitAction(cfg.minecraft.service, action);
}

export async function minecraftCommand(command: string): Promise<string> {
  const cmd = command.trim().replace(/^\//, "");
  if (!cmd) throw new HttpError(400, "Empty command");
  return stripColour(await rconCommand(cmd));
}

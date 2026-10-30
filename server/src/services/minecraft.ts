import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { rconClient, rconCommand, stripColour } from "./rcon.js";
import { subscribe } from "./alerts.js";
import { isPlayerChange, MinecraftPlayers } from "./minecraftPlayers.js";
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

export const minecraftPlayers = new MinecraftPlayers(async () => parseList(await rconCommand("list")));
let initialized = false;

export function initMinecraft(): void {
  if (initialized) return;
  initialized = true;
  rconClient.onDisconnect((error) => minecraftPlayers.disconnected(error));
  subscribe((event) => {
    if (event.source !== "minecraft" || event.kind !== "log") return;
    if (isPlayerChange(event.text)) minecraftPlayers.invalidate();
    else if (/\bStopping (?:the )?server\b/i.test(event.text)) rconClient.close(new Error("Minecraft is stopping"));
  });
  minecraftPlayers.start();
}

export async function getPlayers(): Promise<McPlayers> {
  const state = await minecraftPlayers.read();
  if (!state.players) throw new Error(state.rcon.error ?? "Minecraft controls are unavailable");
  return state.players;
}

export async function minecraftStatus(): Promise<MinecraftPayload> {
  const [unit, ping, players] = await Promise.all([
    unitState(cfg.minecraft.service),
    pingServer().catch(() => null),
    minecraftPlayers.read(),
  ]);
  return {
    unit,
    ping,
    rcon: players.rcon,
    players: players.players,
    address: cfg.minecraft.publicAddress ?? `${cfg.minecraft.host}:${cfg.minecraft.port}`,
  };
}

export async function minecraftAction(action: UnitAction): Promise<void> {
  await unitAction(cfg.minecraft.service, action);
  if (action !== "start") rconClient.close(new Error(`Minecraft ${action} requested`));
  minecraftPlayers.invalidate();
}

export async function minecraftCommand(command: string): Promise<string> {
  const cmd = command.trim().replace(/^\//, "");
  if (!cmd) throw new HttpError(400, "Empty command");
  return stripColour(await rconCommand(cmd));
}

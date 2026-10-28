import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { RconClient } from "./rconClient.js";

export const rconClient = new RconClient(() => cfg.minecraft.rcon);

export async function rconCommand(command: string, timeoutMs = 6000): Promise<string> {
  // [DEMO] demo-mode branch - fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.rcon(command);
  return rconClient.command(command, timeoutMs);
}

/** Strips Minecraft section-sign colour codes from command output. */
export function stripColour(s: string): string {
  return s.replace(/\u00a7[0-9a-fk-or]/gi, "");
}

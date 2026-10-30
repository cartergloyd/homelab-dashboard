// Adds a player to the Minecraft whitelist through the server's own lookups: Paper's
// `whitelist add` resolves Java names with Mojang, Floodgate's `fwhitelist add` resolves Bedrock
// gamertags with Xbox. The list is read back to confirm. Additions only; removing players stays
// with the owner. (The family site's worker uses the Management Protocol instead, which is
// switched off in server.properties on the live server.)
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import { minecraftCommand } from "./minecraft.js";

export type Edition = "java" | "bedrock";
export interface WhitelistResult {
  /** the name as it appears on the whitelist (Bedrock names carry Floodgate's prefix) */
  name: string;
  added: boolean;
  alreadyListed: boolean;
  output: string;
}

const JAVA = /^[A-Za-z0-9_]{3,16}$/;
// Gamertags with spaces are refused: `fwhitelist add` would read only the first word and could whitelist someone else.
const BEDROCK = /^[A-Za-z0-9][A-Za-z0-9_]{0,15}$/;

function floodgatePrefix(): string {
  try {
    return fs.readFileSync(path.join(cfg.minecraft.dir, "plugins/floodgate/config.yml"), "utf8").match(/^username-prefix:\s*"?([^"\n]*)"?/m)?.[1] ?? ".";
  } catch {
    return ".";
  }
}

/** Names from "There are 3 whitelisted player(s): a, b, c", lowercased. */
export function listedNames(output: string): string[] {
  const list = output.split(":").slice(1).join(":");
  return list.split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
}

export async function whitelistAdd(edition: Edition, raw: string, run: (command: string) => Promise<string> = minecraftCommand, waitMs = 1000): Promise<WhitelistResult> {
  const name = raw.trim();
  if (!(edition === "java" ? JAVA : BEDROCK).test(name)) {
    throw new HttpError(400, edition === "java" ? "Java names are 3–16 letters, numbers or underscores." : "Give the Xbox gamertag without spaces; gamertags with spaces must be added by the owner.");
  }
  const entry = edition === "java" ? name : `${floodgatePrefix()}${name}`;
  const isListed = async () => listedNames(await run("whitelist list")).includes(entry.toLowerCase());
  if (await isListed()) return { name: entry, added: false, alreadyListed: true, output: "" };
  const output = await run(edition === "java" ? `whitelist add ${name}` : `fwhitelist add ${name}`);
  // Both lookups finish asynchronously, after the command has returned.
  for (let i = 0; i < 8; i++) {
    if (await isListed()) return { name: entry, added: true, alreadyListed: false, output };
    await delay(waitMs);
  }
  throw new HttpError(422, `The server did not add ${name}${output.trim() ? `: ${output.trim()}` : ""}. Check the spelling and the edition (Java or Bedrock).`);
}

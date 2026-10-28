import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMinecraftSettings } from "./dist/services/minecraftSettings.js";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dash-settings-"));
try {
  await fs.writeFile(
    path.join(directory, "server.properties"),
    "# test-only fixture\r\ngamemode=survival\r\ndifficulty=normal\r\nmax-players=20\r\nwhite-list=true\r\nenable-rcon=false\r\nrcon.password=never-expose-this\r\nresource-pack-sha1=private\r\nserver-ip=private\r\n",
  );
  const result = await readMinecraftSettings(directory);
  assert.deepEqual(result, {
    gamemode: "survival",
    difficulty: "normal",
    "max-players": "20",
    "white-list": "true",
    "enable-rcon": "false",
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal("rcon.password" in result, false);
  await assert.rejects(
    readMinecraftSettings(path.join(directory, "missing")),
    (error) => error.status === 503,
  );
  console.log(
    "Minecraft settings: allowlisted real settings, no credentials, CRLF parsing and unavailable handling passed",
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { RconClient } from "./dist/services/rconClient.js";
import { isPlayerChange, MinecraftPlayers } from "./dist/services/minecraftPlayers.js";

function packet(id, type, text = "") {
  const body = Buffer.from(text);
  const buf = Buffer.alloc(body.length + 14);
  buf.writeInt32LE(body.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  return buf;
}

const sockets = new Set();
const commands = [];
let connections = 0;
let authentications = 0;
let names = [];
const server = net.createServer(sock => {
  connections++;
  sockets.add(sock);
  sock.on("close", () => sockets.delete(sock));
  sock.on("error", () => {});
  let buffer = Buffer.alloc(0);
  let previous = "";
  let authed = false;
  sock.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
      const len = buffer.readInt32LE(0);
      const id = buffer.readInt32LE(4);
      const type = buffer.readInt32LE(8);
      const body = buffer.subarray(12, len + 2).toString();
      buffer = buffer.subarray(len + 4);
      if (type === 3) {
        authentications++;
        authed = body === "test-password";
        const response = Buffer.concat([packet(id, 0), packet(authed ? id : -1, 2)]);
        // Exercise framing across chunks, including a fragmented length header.
        sock.write(response.subarray(0, 2));
        setTimeout(() => { if (!sock.destroyed) sock.write(response.subarray(2)); }, 5);
      } else if (type === 2 && authed) {
        commands.push(body);
        previous = body;
        if (body === "hang") continue;
        if (body === "malformed") { sock.write(Buffer.from([9, 0, 0, 0])); continue; }
        if (body === "disconnect") { sock.write(packet(id, 0, "partial")); sock.end(); continue; }
        if (body === "slow") {
          sock.write(packet(id, 0, "first "));
          setTimeout(() => { if (!sock.destroyed) sock.write(packet(id, 0, "second")); }, 450);
        } else {
          const output = body === "list" ? `There are ${names.length} of a max of 20 players online: ${names.join(", ")}` : `reply:${body}`;
          sock.write(packet(id, 0, output));
        }
      } else if (type === 0 && authed) {
        if (["hang", "disconnect", "malformed", "no-marker"].includes(previous)) continue;
        if (previous === "slow") setTimeout(() => { if (!sock.destroyed) sock.write(packet(id, 0, "Unknown request")); }, 500);
        else sock.write(packet(id, 0, "Unknown request"));
      }
    }
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = { host: "127.0.0.1", port: server.address().port, password: "test-password" };
const client = new RconClient(() => config);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-minecraft-"));
let tracked;
let httpServer;
let updates;
const monitors = [];
try {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => client.command(`command-${i}`)));
  assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => `reply:command-${i}`));
  assert.equal(connections, 1, "concurrent commands must share one connection");
  assert.equal(authentications, 1);
  assert.deepEqual(commands, Array.from({ length: 12 }, (_, i) => `command-${i}`));
  assert.equal(await client.command("slow"), "first second", "slow multi-packet replies must not be truncated");
  assert.equal(connections, 1);
  await assert.rejects(client.command("hang", 60), /timed out/);
  assert.equal(commands.filter(c => c === "hang").length, 1, "timed-out commands must never be replayed");
  assert.equal(await client.command("after-timeout"), "reply:after-timeout");
  assert.equal(connections, 2);
  await assert.rejects(client.command("disconnect"), /connection closed/);
  assert.equal(await client.command("after-disconnect"), "reply:after-disconnect");
  await assert.rejects(client.command("malformed"), /Invalid RCON/);
  assert.equal(await client.command("after-malformed"), "reply:after-malformed");
  await assert.rejects(client.command("no-marker", 60), /timed out/, "partial output is not confirmed completion");
  config.password = "wrong";
  await assert.rejects(client.command("bad-auth"), /authentication failed/);
  config.password = undefined;
  const beforeMissingPassword = connections;
  await assert.rejects(client.command("missing-password"), /RCON_PASSWORD/);
  assert.equal(connections, beforeMissingPassword);
  config.password = "test-password";
  assert.equal(await client.command("restored"), "reply:restored");
  for (const sock of sockets) sock.destroy();
  await delay(20);
  assert.equal(client.connected, false);
  assert.equal(await client.command("after-idle-drop"), "reply:after-idle-drop");
  client.close();

  let now = 0;
  let reads = 0;
  let currentNames = [];
  const monitor = new MinecraftPlayers(async () => {
    reads++;
    await delay(5);
    return { online: currentNames.length, max: 20, names: [...currentNames] };
  }, () => now);
  monitors.push(monitor);
  let changed = 0;
  monitor.subscribe(() => changed++);
  await Promise.all(Array.from({ length: 20 }, () => monitor.read()));
  assert.equal(reads, 1, "all tabs share one initial player-list read");
  now = 59_999;
  await monitor.read();
  assert.equal(reads, 1, "status requests do not poll RCON within the one-minute safety interval");
  currentNames = ["Alex"];
  monitor.invalidate();
  monitor.invalidate();
  await delay(250);
  assert.deepEqual((await monitor.read()).players.names, ["Alex"]);
  assert.equal(reads, 2, "bursts of player events are coalesced into one read");
  assert.equal(changed, 2);
  now += 60_000;
  await monitor.read();
  assert.equal(reads, 3, "periodic reconciliation catches missed events");
  assert.equal(changed, 2, "unchanged state does not send redundant updates");
  monitor.disconnected(new Error("connection dropped"));
  assert.equal((await monitor.read()).rcon.ok, false);
  assert.equal((await monitor.read()).players, null, "lost connections must not show stale player names");
  now += 15_000;
  assert.equal((await monitor.read()).rcon.ok, true);
  assert.equal(reads, 4);

  let attempts = 0;
  const failing = new MinecraftPlayers(async () => { attempts++; throw new Error("offline"); }, () => now);
  monitors.push(failing);
  assert.equal((await failing.read()).rcon.error, "offline");
  await Promise.all(Array.from({ length: 10 }, () => failing.read()));
  assert.equal(attempts, 1, "offline status requests must not cause a reconnect storm");
  now += 15_000;
  await failing.read();
  assert.equal(attempts, 2);

  let completeFirst;
  let races = 0;
  const racing = new MinecraftPlayers(async () => {
    races++;
    if (races === 1) return new Promise(resolve => { completeFirst = resolve; });
    return { online: 1, max: 20, names: ["NewPlayer"] };
  });
  monitors.push(racing);
  const racingRead = racing.read();
  racing.invalidate();
  completeFirst({ online: 0, max: 20, names: [] });
  assert.deepEqual((await racingRead).players.names, ["NewPlayer"], "an event during a read must not leave stale state");
  assert.equal(races, 2);

  assert.ok(isPlayerChange('[18:10:00 INFO]: Alex joined the game'));
  assert.ok(isPlayerChange('[Server thread/INFO]: .BedrockPlayer left the game'));
  assert.ok(isPlayerChange('Done (24.363s)! For help, type "help"'));
  assert.equal(isPlayerChange('Thread RCON Client /127.0.0.1 started'), false);
  assert.equal(isPlayerChange('[Geyser-Spigot] Done (3.985s)! Run /geyser help'), false);

  Object.assign(process.env, { DATA_DIR: tmp, MC_DIR: tmp, RCON_HOST: config.host, RCON_PORT: String(config.port), RCON_PASSWORD: config.password, AUTH_DISABLED: "1", DEMO: "0" });
  const minecraft = await import("./dist/services/minecraft.js");
  const { publish } = await import("./dist/services/alerts.js");
  const { rconClient } = await import("./dist/services/rcon.js");
  const { attachLogSocket } = await import("./dist/ws.js");
  tracked = { ...minecraft, rconClient };
  minecraft.initMinecraft();
  await minecraft.getPlayers();
  const initialListCount = commands.filter(c => c === "list").length;
  await Promise.all(Array.from({ length: 20 }, () => minecraft.getPlayers()));
  assert.equal(commands.filter(c => c === "list").length, initialListCount);
  httpServer = http.createServer();
  attachLogSocket(httpServer);
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  updates = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/ws/minecraft`);
  const messages = [];
  updates.on("message", data => messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { updates.once("open", resolve); updates.once("error", reject); });
  await delay(20);
  assert.deepEqual(messages[0], { type: "minecraft-update" });
  names = ["Alex"];
  publish({ source: "minecraft", text: "[18:10:00 INFO]: Alex joined the game" });
  await delay(300);
  assert.deepEqual((await minecraft.getPlayers()).names, ["Alex"]);
  assert.equal(messages.length, 2, "player joins push an update to the browser");
  names = [];
  publish({ source: "minecraft", text: "[18:10:01 INFO]: Alex left the game" });
  await delay(300);
  assert.deepEqual((await minecraft.getPlayers()).names, []);
  assert.equal(messages.length, 3);
  const beforeNoise = commands.filter(c => c === "list").length;
  publish({ source: "minecraft", text: "Thread RCON Client /127.0.0.1 started" });
  publish({ source: "system", text: "Alex joined the game" });
  await delay(300);
  assert.equal(commands.filter(c => c === "list").length, beforeNoise);
  assert.equal(await minecraft.minecraftCommand("read-only-example"), "reply:read-only-example");
  assert.equal(commands.filter(c => c === "list").length, beforeNoise, "commands must not trigger extra status polling");
  console.log("minecraft: persistent serialized RCON, complete replies, safe failures, shared event-driven players, reconnect backoff, and browser push passed");
} finally {
  updates?.terminate();
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  tracked?.minecraftPlayers.stop();
  tracked?.rconClient.close();
  for (const monitor of monitors) monitor.stop();
  client.close();
  for (const sock of sockets) sock.destroy();
  await new Promise(resolve => server.close(resolve));
  await delay(1200);
  await fs.rm(tmp, { recursive: true, force: true });
}

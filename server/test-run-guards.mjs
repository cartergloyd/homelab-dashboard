import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-run-guards-"));
const mc = path.join(tmp, "mc");
const other = path.join(tmp, "other-apps");
await fs.mkdir(path.join(mc, "scripts"), { recursive: true });
await fs.mkdir(path.join(mc, "plugins/DiscordSRV"), { recursive: true });
await fs.mkdir(other);
await fs.mkdir(path.join(tmp, "data"));
await fs.mkdir(path.join(tmp, "codex"));
await fs.writeFile(path.join(mc, "scripts/fix_status.sh"), "#!/bin/sh\necho ok\n");
await fs.writeFile(path.join(other, "pg_backup.sh"), "#!/bin/sh\necho ok\n");
await fs.writeFile(path.join(mc, "plugins/DiscordSRV/config.yml"), 'BotToken: "discordsrv-fixture-token"\nOtherSetting: 1\n');
await fs.writeFile(path.join(tmp, "secrets.env"), "DISCORD_BOT_TOKEN=discord-fixture-bot-token\nGMAIL_APP_PASSWORD=gmail-fixture-pw\nPLAIN_SETTING=not-a-secret-value\n");
await fs.writeFile(path.join(tmp, "codex/auth.json"), JSON.stringify({ tokens: { access_token: "codex-fixture-access-token" }, last_refresh: "2026-10-30T00:00:00.000Z" }));
Object.assign(process.env, {
  DATA_DIR: path.join(tmp, "data"), MC_DIR: mc, MC_SERVICE: "minecraft-paper.service", SCRIPTS_DIR: `${path.join(mc, "scripts")},${other}`, DEMO: "0",
  DASHBOARD_KEY: "fixture-master-key", RCON_PASSWORD: "fixture-rcon-pw", PG_URL: "postgres://app:pg-fixture-pw@127.0.0.1:5432/app",
  DISCORD_SUPPORT_TOKEN_FILE: path.join(tmp, "secrets.env"), CODEX_HOME: path.join(tmp, "codex"),
});
try {
  const guards = await import("./dist/services/runGuards.js");
  const { secretIn } = await import("./dist/services/secretFilter.js");
  const { publish, query } = await import("./dist/services/alerts.js");
  const { createJob } = await import("./dist/services/scheduler.js");
  const { issueRunToken } = await import("./dist/services/runTokens.js");
  const { resolveIdentity } = await import("./dist/auth.js");
  const { requireStepUp } = await import("./dist/security.js");
  const { DiscordJoinSupport } = await import("./dist/services/discordSupport.js");

  // the console never-list, including namespaced and slash forms
  for (const command of ["op Steve", "/deop Steve", "minecraft:op Steve", "execute as @a run op Steve", "ban Steve", "kick Steve", "gamemode creative Steve", "give Steve diamond 64", "tp Steve 0 100 0", "whitelist off", "whitelist remove Steve", "stop", "bukkit:reload", "save-off"]) {
    assert.ok(guards.rconRefusal(command), `"${command}" must be refused`);
  }
  for (const command of ["list", "tps", "say Restarting in 30 seconds", "whitelist add Steve", "whitelist list", "save-all", "geyser reload", "spark tps", ""]) {
    assert.equal(guards.rconRefusal(command), null, `"${command}" is allowed`);
  }

  // secrets: real values by name (never echoed), URL passwords, token files, DiscordSRV, Codex, token shapes
  const cases = [
    ["the password is fixture-rcon-pw", /^RCON_PASSWORD$/], ["key fixture-master-key", /^DASHBOARD_KEY$/], ["pg-fixture-pw", /password in PG_URL/],
    ["discord-fixture-bot-token", /DISCORD_BOT_TOKEN \(secrets\.env\)/], ["gmail-fixture-pw", /GMAIL_APP_PASSWORD/], ["discordsrv-fixture-token", /DiscordSRV/],
    ["codex-fixture-access-token", /Codex/], [`token hlr_${"a".repeat(43)}`, /run token/], ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl", /JSON web token/],
    ["-----BEGIN PRIVATE KEY-----", /private key/],
  ];
  for (const [text, label] of cases) {
    const found = secretIn(text);
    assert.match(found ?? "", label, `${text.slice(0, 30)} must be recognized`);
    assert.equal(found.includes(text), false, "the label never repeats the secret");
  }
  for (const text of ["Restarting in 30 seconds", "not-a-secret-value", "2026-10-30T00:00:00.000Z", "Join at mc.xgold.tech"]) assert.equal(secretIn(text), null, `${text} is not a secret`);

  // restarts: one at a time, and none once Paper has started twice in an hour
  const now = Date.now();
  assert.equal(guards.restartRefusal(now), null, "a first restart is allowed");
  assert.match(guards.restartRefusal(now + 60_000), /less than 5 minutes ago/);
  publish({ source: "minecraft", kind: "log", text: "Started minecraft-paper.service - Minecraft Paper Server." });
  publish({ source: "minecraft", kind: "log", text: "Started minecraft-paper.service - Minecraft Paper Server." });
  assert.match(guards.restartRefusal(now + 6 * 60_000), /started 2 times in the last hour/, "systemd's own restarts count");
  assert.equal(guards.restartRefusal(now + 66 * 60_000), null, "the window moves on");

  // scripts and jobs: Minecraft's only
  assert.equal(await guards.scriptRefusal("fix_status.sh"), null);
  assert.match(await guards.scriptRefusal("pg_backup.sh"), /not a Minecraft script/);
  await assert.rejects(guards.scriptRefusal("missing.sh"), /not found/);
  const job = async (type, options) => (await createJob({ name: `fixture ${type}`, type, cron: "0 4 * * *", enabled: false, options })).id;
  assert.match(await guards.jobRefusal(await job("script", { script: "pg_backup.sh" })), /not a Minecraft script/);
  assert.equal(await guards.jobRefusal(await job("script", { script: "fix_status.sh" })), null);
  assert.match(await guards.jobRefusal(await job("command", { command: "op Steve" })), /changes who may do what/);
  assert.equal(await guards.jobRefusal(await job("command", { command: "save-all" })), null);
  assert.equal(await guards.jobRefusal(await job("backup", {})), null);
  assert.match(await guards.jobRefusal(await job("restart", { warnMinutes: [1] })), /less than 5 minutes ago/, "restart jobs share the restart limit");

  // through the central gate, with a real run token
  const user = (await resolveIdentity({ authorization: `Bearer ${issueRunToken({ runId: "run-g", lane: "minecraft", origin: "dashboard" }, 60_000)}`, "x-homelab-agent": "Dashboard Codex" }, "127.0.0.1")).user;
  const step = async (method, p, body = {}) => {
    let passed = false;
    await requireStepUp({ method, path: p, body, query: {} }, { locals: { user }, setHeader() {} }, () => { passed = true; });
    return passed;
  };
  await assert.rejects(step("POST", "/minecraft/command", { command: "op Steve" }), (e) => e.status === 403 && /only the owner/.test(e.message));
  await assert.rejects(step("POST", "/minecraft/command", { command: "say the password is fixture-rcon-pw" }), (e) => e.status === 403 && /RCON_PASSWORD/.test(e.message) && !e.message.includes("fixture-rcon-pw"));
  const blocked = query({ sources: ["dashboard"] }).filter((e) => /Blocked a Minecraft command/.test(e.text));
  assert.equal(blocked.length, 1, "a blocked secret is reported in the feed");
  assert.equal(blocked[0].text.includes("fixture-rcon-pw"), false);
  await assert.rejects(step("POST", "/Scripts/pg_backup.sh/RUN"), (e) => e.status === 403 && /not a Minecraft script/.test(e.message), "mixed-case paths are guarded too");
  assert.equal(await step("POST", "/scripts/fix_status.sh/run"), true);
  assert.equal(await step("POST", "/minecraft/command", { command: "whitelist add Steve" }), true);

  // public Discord replies never carry a secret, in Discord or in the saved state
  const sent = [];
  const support = new DiscordJoinSupport({ botId: "40", guildId: "20", stateFile: path.join(tmp, "data/discord-support.json"), imageFolder: tmp,
    settings: () => ({ enabled: true, autoTrigger: true }), report: (key) => ({ id: key }),
    send: async (channel, replyTo, text) => { sent.push(text); return String(600 + sent.length); } });
  await support.load();
  await support.handle({ id: "100", channelId: "10", guildId: "20", author: { id: "30", username: "player" }, content: "<@40> I can't get on", mentions: ["40"], attachments: [] });
  const key = JSON.parse(await fs.readFile(path.join(tmp, "data/discord-support.json"), "utf8"))[0].key;
  await support.delivery(key).complete({ id: "run-s", sessionId: null, status: "exited", exitCode: 0 }, "Use the bot token discord-fixture-bot-token to log in.");
  assert.match(sent.at(-1), /couldn't send my answer/);
  assert.equal((await fs.readFile(path.join(tmp, "data/discord-support.json"), "utf8")).includes("discord-fixture-bot-token"), false);
  assert.ok(query({ sources: ["dashboard"] }).some((e) => /Blocked a Discord support reply that contained DISCORD_BOT_TOKEN/.test(e.text)));
  await support.delivery(key).complete({ id: "run-t", sessionId: null, status: "exited", exitCode: 0 }, "Add GoldServer2951 as a friend on Xbox.");
  assert.match(sent.at(-1), /GoldServer2951/, "ordinary replies are unchanged");
  console.log("run-guards: console never-list, restart limit incl. systemd restarts, Minecraft-only scripts and jobs, and secret blocking in chat and Discord passed");
} finally {
  await delay(1200); // alerts batch their disk writes
  await fs.rm(tmp, { recursive: true, force: true });
}

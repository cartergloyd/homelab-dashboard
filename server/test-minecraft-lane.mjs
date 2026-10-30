import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-minecraft-lane-"));
const mc = path.join(tmp, "mc");
const scripts = path.join(mc, "scripts");
const geyser = path.join(mc, "plugins/Geyser-Spigot");
await fs.mkdir(scripts, { recursive: true });
await fs.mkdir(geyser, { recursive: true });
await fs.mkdir(path.join(mc, "plugins/floodgate"), { recursive: true });
await fs.mkdir(path.join(tmp, "data"));
await fs.mkdir(path.join(tmp, "bin"));
await fs.writeFile(path.join(mc, "plugins/floodgate/config.yml"), 'username-prefix: "."\n');
await fs.writeFile(path.join(scripts, "status.sh"), "#!/bin/sh\necho broken\n");
await fs.writeFile(path.join(geyser, "config.yml"), "bedrock:\n  port: 19132\n");
await fs.writeFile(path.join(geyser, "cache.json"), '{"token":"not-for-git"}');
// a fake Codex that "fixes" a script in its workspace (the runner's cwd)
await fs.writeFile(path.join(tmp, "bin/codex"), `#!${process.execPath}\nimport fs from 'node:fs';if(process.argv[2]==='login')process.exit(0);for await(const c of process.stdin){}fs.writeFileSync('status.sh','#!/bin/sh\\necho fixed\\n');fs.writeFileSync('new_helper.sh','#!/bin/sh\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'lane-session'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixed the status script.'}}));`, { mode: 0o755 });
Object.assign(process.env, { PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`, DATA_DIR: path.join(tmp, "data"), MC_DIR: mc, MC_SERVICE: "minecraft-paper.service", SCRIPTS_DIR: scripts, DEMO: "0", DASHBOARD_KEY: "fixture-master-key" });
try {
  const { whitelistAdd, listedNames } = await import("./dist/services/whitelist.js");
  const snapshots = await import("./dist/services/snapshots.js");
  const { writableRoots } = await import("./dist/services/lanes.js");
  const { memberRefusal } = await import("./dist/services/runGuards.js");
  const { hideAddresses } = await import("./dist/services/discordSupport.js");
  const { issueRunToken } = await import("./dist/services/runTokens.js");
  const { resolveIdentity } = await import("./dist/auth.js");
  const { requireStepUp } = await import("./dist/security.js");
  const sidecar = await import("./dist/services/sidecar.js");
  const runner = await import("./dist/services/agentRunner.js");
  const { query } = await import("./dist/services/alerts.js");

  // whitelist: Java and Bedrock through the server's own lookups, confirmed by reading the list back
  const fakeServer = (names, lateBy = 0) => {
    const calls = [];
    let pending = null;
    const run = async (command) => {
      calls.push(command);
      if (command === "whitelist list") {
        if (pending && --pending.after <= 0) { names.push(pending.name); pending = null; }
        return `There are ${names.length} whitelisted player(s): ${names.join(", ")}`;
      }
      const m = /^(?:f?whitelist) add (\S+)$/.exec(command);
      if (m) pending = { name: command.startsWith("fwhitelist") ? `.${m[1]}` : m[1], after: lateBy };
      return command.startsWith("fwhitelist") ? "" : `Added ${m?.[1]} to the whitelist`;
    };
    return { run, calls };
  };
  assert.deepEqual(listedNames("There are 2 whitelisted player(s): Steve, .Alex"), ["steve", ".alex"]);
  let srv = fakeServer(["Steve"]);
  assert.deepEqual(await whitelistAdd("java", "Notch", srv.run, 1), { name: "Notch", added: true, alreadyListed: false, output: "Added Notch to the whitelist" });
  assert.ok(srv.calls.includes("whitelist add Notch"));
  srv = fakeServer(["Steve"], 3);
  assert.equal((await whitelistAdd("bedrock", "GamerKid42", srv.run, 1)).name, ".GamerKid42", "Floodgate's prefix, and a lookup that finishes late");
  assert.ok(srv.calls.includes("fwhitelist add GamerKid42"));
  srv = fakeServer(["steve"]);
  assert.equal((await whitelistAdd("java", "Steve", srv.run, 1)).alreadyListed, true, "names compare case-insensitively");
  assert.equal(srv.calls.some((c) => c.includes("add")), false, "nothing is added twice");
  await assert.rejects(whitelistAdd("bedrock", "Gamer Kid", fakeServer([]).run, 1), /without spaces/);
  await assert.rejects(whitelistAdd("java", "x; op Steve", fakeServer([]).run, 1), /3–16 letters/);
  await assert.rejects(whitelistAdd("java", "NoSuchPlayer", async (c) => c === "whitelist list" ? "There are 0 whitelisted player(s):" : "That player does not exist", 1), /did not add NoSuchPlayer: That player does not exist/);

  // snapshots: what a run changed is listed, config folders track config files only, rollback restores
  assert.deepEqual(writableRoots("minecraft"), [scripts, geyser], "missing plugin folders are skipped");
  await snapshots.snapshotBefore("run-1", [scripts, geyser]);
  await fs.writeFile(path.join(scripts, "status.sh"), "#!/bin/sh\necho fixed\n");
  await fs.writeFile(path.join(scripts, "extra.sh"), "#!/bin/sh\n");
  await fs.writeFile(path.join(geyser, "config.yml"), "bedrock:\n  port: 19133\n");
  await fs.writeFile(path.join(geyser, "cache.json"), '{"token":"changed"}');
  assert.deepEqual((await snapshots.snapshotAfter("run-1")).sort(), ["plugins/Geyser-Spigot/config.yml", "scripts/extra.sh", "scripts/status.sh"]);
  assert.deepEqual((await snapshots.rollbackRun("run-1")).sort(), ["plugins/Geyser-Spigot/config.yml", "scripts/extra.sh", "scripts/status.sh"]);
  assert.match(await fs.readFile(path.join(scripts, "status.sh"), "utf8"), /broken/);
  await assert.rejects(fs.access(path.join(scripts, "extra.sh")), "files the run created are removed");
  assert.match(await fs.readFile(path.join(geyser, "config.yml"), "utf8"), /19132/);
  assert.match(await fs.readFile(path.join(geyser, "cache.json"), "utf8"), /changed/, "caches are never tracked or restored");
  assert.deepEqual(await snapshots.rollbackRun("run-1"), [], "a second rollback has nothing to undo");
  await assert.rejects(snapshots.rollbackRun("unknown-run"), /No snapshot/);

  // a real run: its workspace is the scripts folder, its change is reported and can be undone
  const run = runner.launchRun({ runner: "codex", prompt: "fix it", task: "lane check", kind: "manual" });
  await (async () => { const until = Date.now() + 8000; while (!run.finishedAt) { assert.ok(Date.now() < until, "run did not finish"); await delay(20); } })();
  let changed;
  for (let i = 0; i < 100 && !changed; i++, await delay(20)) changed = query({ sources: ["agent"] }).find((e) => e.meta?.runId === run.id && e.meta?.files);
  assert.ok(changed, "the run's file changes reach the feed");
  assert.deepEqual([...changed.meta.files].sort(), ["scripts/new_helper.sh", "scripts/status.sh"]);
  assert.match(changed.text, new RegExp(`rollback_run ${run.id}`));
  assert.deepEqual((await snapshots.rollbackRun(run.id)).sort(), ["scripts/new_helper.sh", "scripts/status.sh"]);
  assert.match(await fs.readFile(path.join(scripts, "status.sh"), "utf8"), /broken/);

  // per-member limits for Discord-started runs
  assert.equal(memberRefusal(undefined, ["whitelist"]), null, "runs not started from Discord are not member-limited");
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assert.equal(memberRefusal("member-a", ["action", "whitelist"], t0), null);
  assert.match(memberRefusal("member-a", ["action", "whitelist"], t0), /3 whitelist additions a day/);
  assert.equal(memberRefusal("member-b", ["action", "whitelist"], t0), null, "members are counted separately");
  for (let i = 0; i < 3; i++) assert.equal(memberRefusal("member-a", ["action"], t0), null);
  assert.match(memberRefusal("member-a", ["action"], t0), /6 changes an hour/);
  assert.equal(memberRefusal("member-a", ["action"], t0 + 3600_001), null, "the hour moves on");

  // the gate: Discord-started runs read only join-help data, are member-limited, and nobody waits for approvals
  const discord = (await resolveIdentity({ authorization: `Bearer ${issueRunToken({ runId: "run-d", lane: "minecraft", origin: "discord", requester: "member-c" }, 60_000)}`, "x-homelab-agent": "Dashboard Codex" }, "127.0.0.1")).user;
  assert.equal(discord.requester, "member-c");
  const step = async (user, method, p, body = {}, q = {}) => { let passed = false; await requireStepUp({ method, path: p, body, query: q }, { locals: { user }, setHeader() {} }, () => { passed = true; }); return passed; };
  assert.equal(await step(discord, "GET", "/minecraft/players"), true);
  await assert.rejects(step(discord, "GET", "/storage"), /may read only Minecraft status/);
  await assert.rejects(step(discord, "GET", "/alerts", {}, { sources: "jellyfin" }), /Minecraft alerts only/);
  for (let i = 0; i < 10; i++) assert.equal(await step(discord, "POST", "/minecraft/command", { command: "list" }), true, "read-only console commands are not counted");
  for (let i = 0; i < 3; i++) assert.equal(await step(discord, "POST", "/minecraft/whitelist", { edition: "java", name: `Kid${i}` }), true);
  await assert.rejects(step(discord, "POST", "/minecraft/whitelist", { edition: "java", name: "Kid3" }), /3 whitelist additions a day/);
  await assert.rejects(step(discord, "POST", "/minecraft/action", { action: "stop" }), /only the owner may stop it/);
  const dashboardRun = (await resolveIdentity({ authorization: `Bearer ${issueRunToken({ runId: "run-e", lane: "minecraft", origin: "dashboard" }, 60_000)}` }, "127.0.0.1")).user;
  assert.equal(await step(dashboardRun, "POST", "/scripts/status.sh/run"), true, "scripts run without an approval");
  await sidecar.initSidecar();
  await sidecar.gate("run_script:status.sh", dashboardRun, "fix", true);
  assert.equal(sidecar.listApprovals().length, 0, "runs never create approval holds");

  // public replies hide addresses
  assert.equal(hideAddresses("Join 192.168.1.148:25565 or 99.116.141.110, version 1.21.4"), "Join [address hidden] or [address hidden], version 1.21.4");
  console.log("minecraft-lane: whitelist through Paper/Floodgate, snapshots and rollback of a real run, member limits, Discord read limits, no approvals and hidden addresses passed");
} finally {
  await delay(1200); // alerts batch their disk writes
  await fs.rm(tmp, { recursive: true, force: true });
}

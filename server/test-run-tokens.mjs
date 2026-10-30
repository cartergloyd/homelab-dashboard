import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-run-tokens-"));
Object.assign(process.env, { DATA_DIR: tmp, MC_DIR: tmp, DASHBOARD_KEY: "fixture-master-key", DEMO: "0" });
try {
  const tokens = await import("./dist/services/runTokens.js");
  const { resolveIdentity } = await import("./dist/auth.js");
  const { requireStepUp, laneRefusal } = await import("./dist/security.js");
  const sidecar = await import("./dist/services/sidecar.js");
  const bearer = (token, extra = {}) => ({ authorization: `Bearer ${token}`, "x-homelab-agent": "Dashboard Codex", ...extra });

  // tokens: bound to one run, revocable, expiring
  const token = tokens.issueRunToken({ runId: "run-a", lane: "minecraft", origin: "dashboard" }, 60_000);
  assert.match(token, /^hlr_[\w-]{43}$/);
  assert.notEqual(token, process.env.DASHBOARD_KEY);
  assert.equal(tokens.verifyRunToken(token).runId, "run-a");
  assert.equal(tokens.verifyRunToken("hlr_forged"), null);
  const reissued = tokens.issueRunToken({ runId: "run-a", lane: "minecraft", origin: "dashboard" }, 60_000);
  assert.equal(tokens.verifyRunToken(token), null, "a new token for the same run replaces the old one");
  tokens.revokeRunToken("run-a");
  assert.equal(tokens.verifyRunToken(reissued), null, "revoked when the run ends");
  const short = tokens.issueRunToken({ runId: "run-b", lane: "minecraft", origin: "dashboard" }, 30);
  await delay(60);
  assert.equal(tokens.verifyRunToken(short), null, "expired after its run limit");

  // auth: a run token yields a run identity on loopback only; the master key never carries a run id
  const live = tokens.issueRunToken({ runId: "run-c", lane: "minecraft", origin: "dashboard" }, 60_000);
  const ok = await resolveIdentity(bearer(live, { "x-homelab-run-id": "run-c" }), "127.0.0.1");
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.user.dashboardRunId, ok.user.lane, ok.user.runOrigin, ok.user.viaKey, ok.user.name], ["run-c", "minecraft", "dashboard", true, "Dashboard Codex"]);
  assert.equal((await resolveIdentity(bearer(live, { "x-homelab-run-id": "run-other" }), "127.0.0.1")).status, 403, "a run cannot claim another run's id");
  assert.equal((await resolveIdentity(bearer(live), "192.168.1.20")).status, 403, "run tokens are loopback only");
  assert.equal((await resolveIdentity(bearer("hlr_unknown"), "127.0.0.1")).status, 401);
  const master = await resolveIdentity(bearer("fixture-master-key", { "x-homelab-run-id": "run-c" }), "127.0.0.1");
  assert.equal(master.ok, true);
  assert.equal(master.user.dashboardRunId, undefined, "a run id header no longer turns the master key into a run");
  assert.equal(master.user.lane, undefined);

  // lanes: the minecraft lane may change Minecraft only and cannot see app data or the terminal
  const user = ok.user;
  const step = async (method, p, body = {}, query = {}) => {
    let passed = false;
    await requireStepUp({ method, path: p, body, query }, { locals: { user }, setHeader() {} }, () => { passed = true; });
    return passed;
  };
  for (const [method, p] of [["POST", "/reports"], ["POST", "/storage/scan"], ["GET", "/status"], ["GET", "/alerts"], ["GET", "/files"]]) {
    assert.equal(await step(method, p), true, `${method} ${p} is within the minecraft lane`);
  }
  for (const [method, p, body] of [
    ["POST", "/jellyfin/restart"], ["POST", "/terminal/execute", { command: "id" }], ["PUT", "/sidecar/settings", { requireApproval: false }],
    ["POST", "/files/delete", { root: "minecraft", path: "world" }], ["POST", "/agents/launch"], ["PUT", "/context", { content: "x" }],
    ["DELETE", "/backups"], ["POST", "/qbittorrent/control"], ["GET", "/directus/items/members"], ["GET", "/database/files"], ["POST", "/Jellyfin/Restart/"],
  ]) {
    await assert.rejects(step(method, p, body), (e) => e.status === 403 && /minecraft assistant/.test(e.message), `${method} ${p} is outside the minecraft lane`);
  }
  assert.equal(laneRefusal("minecraft", "POST", "/minecraft/action"), null);
  assert.equal(laneRefusal("minecraft", "POST", "/jobs/0f1e/run"), null);
  assert.match(laneRefusal("minecraft", "POST", "/jobs"), /may not POST/);

  // origin: Discord-started runs keep the narrower player-support rules, from the token alone
  const discord = await resolveIdentity(bearer(tokens.issueRunToken({ runId: "run-d", lane: "minecraft", origin: "discord" }, 60_000)), "127.0.0.1");
  assert.equal(sidecar.isPlayerSupportRun(discord.user), true);
  assert.equal(sidecar.isPlayerSupportRun(user), false);
  assert.equal(sidecar.isPlayerSupportRun({ viaKey: true, name: "Dashboard Codex" }), false, "the master key is never a player-support run");
  console.log("run-tokens: per-run tokens, expiry and revocation, loopback-only run identities, minecraft lane limits and Discord origin passed");
} finally {
  await delay(1200); // alerts batch their disk writes
  await fs.rm(tmp, { recursive: true, force: true });
}

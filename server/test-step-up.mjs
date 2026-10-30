import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import * as OTPAuth from "otpauth";
import express from "express";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-step-up-"));
process.env.DATA_DIR = path.join(tmp, "api");
process.env.CF_ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com";
process.env.CF_ACCESS_AUD = "test-audience";
process.env.PUBLIC_DASHBOARD_URL = "https://dashboard.example";
const { StepUpStore } = await import("./dist/services/stepUp.js");
const { stepUp, requireStepUp, securityApi, legacyGate, protectedAction } = await import("./dist/security.js");
const sidecar = await import("./dist/services/sidecar.js");
let server;

function otp(secret, now) { return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp: now }); }

async function checks() {
  let now = Math.floor(Date.now() / 30_000) * 30_000 + 1000;
  const dir = path.join(tmp, "store");
  const store = new StepUpStore(dir, () => now);
  await store.init();
  const enrollment = await store.begin("owner@example.com", "session-a");
  assert.match(enrollment.qr, /^data:image\/png;base64,/);
  await assert.rejects(store.confirm("owner@example.com", "session-b", enrollment.enrollmentId, otp(enrollment.secret, now)), /expired/);
  const setup = await store.confirm("owner@example.com", "session-a", enrollment.enrollmentId, otp(enrollment.secret, now));
  assert.equal(setup.recoveryCodes.length, 8);
  assert.equal(store.activeAccounts(), 1);
  await assert.rejects(store.begin("owner@example.com", "session-a"), /already enrolled/);
  const file = await fs.readFile(path.join(dir, "step-up.json"), "utf8");
  assert.equal(file.includes(enrollment.secret), false);
  for (const code of setup.recoveryCodes) assert.equal(file.includes(code), false);
  for (const filename of ["step-up.json", "step-up.key"]) assert.equal((await fs.stat(path.join(dir, filename))).mode & 0o777, 0o600);

  let challenge = store.challenge("owner@example.com", "session-a", "restart");
  await assert.rejects(store.verify("owner@example.com", "session-a", challenge, otp(enrollment.secret, now)), /already used/);
  now += 30_000;
  const proof = await store.verify("owner@example.com", "session-a", challenge, otp(enrollment.secret, now));
  assert.equal(store.consume("owner@example.com", "session-b", "restart", proof.permit), false);
  assert.equal(store.consume("owner@example.com", "session-a", "delete", proof.permit), false);
  assert.equal(store.consume("owner@example.com", "session-a", "restart", proof.permit), true);
  assert.equal(store.consume("owner@example.com", "session-a", "restart", proof.permit), false);
  await assert.rejects(store.verify("owner@example.com", "session-a", challenge, setup.recoveryCodes[0]), /expired/);

  challenge = store.challenge("owner@example.com", "session-a", "expired");
  now += 121_000;
  await assert.rejects(store.verify("owner@example.com", "session-a", challenge, setup.recoveryCodes[0]), /expired/);
  challenge = store.challenge("owner@example.com", "session-a", "recover");
  await store.verify("owner@example.com", "session-a", challenge, setup.recoveryCodes[0]);
  assert.equal(store.status("owner@example.com", "cloudflare").recoveryCodesRemaining, 7);
  challenge = store.challenge("owner@example.com", "session-a", "replay");
  await assert.rejects(store.verify("owner@example.com", "session-a", challenge, setup.recoveryCodes[0]), /already used/);
  const loaded = new StepUpStore(dir, () => now);
  await loaded.init();
  assert.equal(loaded.status("owner@example.com", "cloudflare").recoveryCodesRemaining, 7);
  await assert.rejects(loaded.verify("owner@example.com", "session-a", loaded.challenge("owner@example.com", "session-a", "persisted-replay"), setup.recoveryCodes[0]), /already used/);
  const expiring = await store.verify("owner@example.com", "session-a", store.challenge("owner@example.com", "session-a", "expires"), setup.recoveryCodes[2]);
  now += 61_000;
  assert.equal(store.consume("owner@example.com", "session-a", "expires", expiring.permit), false, "unused permits expire after one minute");
  now += 30_000;
  const challenges = [store.challenge("owner@example.com", "session-a", "a"), store.challenge("owner@example.com", "session-a", "b")];
  const concurrent = await Promise.allSettled(challenges.map((id) => store.verify("owner@example.com", "session-a", id, otp(enrollment.secret, now))));
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1, "same TOTP cannot authorize concurrent requests");
  await store.settings("owner@example.com", true);
  assert.equal(store.status("owner@example.com", "tailscale").required, false);
  assert.equal(store.status("owner@example.com", "cloudflare").required, true);
  assert.equal(store.status("other@example.com", "tailscale").required, true);
  const recovery = await store.rotateRecovery("owner@example.com");
  assert.equal(recovery.recoveryCodes.length, 8);
  challenge = store.challenge("owner@example.com", "session-a", "rotation");
  await assert.rejects(store.verify("owner@example.com", "session-a", challenge, setup.recoveryCodes[1]), /Incorrect/);
  now += 5 * 60_000;
  const wrong = otp(enrollment.secret, now) === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await assert.rejects(store.verify("owner@example.com", "session-a", store.challenge("owner@example.com", "session-a", "bad"), wrong), /Incorrect/);
  await assert.rejects(store.verify("owner@example.com", "session-a", store.challenge("owner@example.com", "session-a", "blocked"), wrong), (e) => e.status === 429);
  await fs.rename(path.join(dir, "step-up.key"), path.join(dir, "saved.key"));
  await assert.rejects(new StepUpStore(dir).init(), /key is missing/);
  await fs.rename(path.join(dir, "saved.key"), path.join(dir, "step-up.key"));
  const savedKey = await fs.readFile(path.join(dir, "step-up.key"));
  await fs.writeFile(path.join(dir, "step-up.key"), Buffer.alloc(32));
  await assert.rejects(new StepUpStore(dir).init(), /authenticate|authentic/i, "wrong encryption key fails closed");
  await fs.writeFile(path.join(dir, "step-up.key"), savedKey);

  for (const [method, url, body] of [["POST", "/minecraft/action", { action: "restart" }], ["POST", "/minecraft/command", { command: "say stop" }], ["DELETE", "/backups", {}], ["POST", "/files/delete", {}], ["PUT", "/sidecar/settings", {}], ["POST", "/sidecar/approvals/x", { decision: "approve" }], ["POST", "/sidecar/suggestions/x", { decision: "approve" }], ["POST", "/scripts/x.sh/run", {}], ["POST", "/jobs/x/run", {}], ["PUT", "/context", {}], ["POST", "/Jellyfin/Restart/", {}], ["POST", "/sidecar/chat", {}]]) assert.ok(protectedAction(method, url, body), url);
  for (const [method, url, body] of [["GET", "/backups", {}], ["POST", "/minecraft/command", { command: "list" }], ["POST", "/qbittorrent/torrents", {}], ["POST", "/sidecar/stop", {}], ["POST", "/sidecar/approvals/x", { decision: "deny" }]]) assert.equal(protectedAction(method, url, body), null, url);

  await stepUp.init();
  await fs.writeFile(path.join(process.env.DATA_DIR, "sidecar.json"), JSON.stringify({ settings: { enabled: false, autoTrigger: false, requireApproval: false } }));
  await sidecar.initSidecar();
  const app = express();
  app.use(express.json());
  // Synthetic identities exist ONLY in this isolated fixture server.
  app.use((req, res, next) => { const keyed = req.get("test-key") === "yes"; res.locals.user = { login: req.get("test-login") ?? "owner@example.com", name: "Fixture", via: keyed ? "key" : "cloudflare", viaKey: keyed, dashboardRunId: req.get("test-dashboard-run") || undefined, sessionId: req.get("test-auth") ?? "login-session-a" }; next(); });
  app.use("/api", requireStepUp);
  app.use("/api/security", securityApi);
  let actions = 0;
  app.post("/api/minecraft/action", async (_req, res) => { await legacyGate(res, "minecraft_service:restart", res.locals.user); actions++; res.json({ ok: true }); });
  app.post("/api/sidecar/approvals/:id", async (req, res) => { res.json(await sidecar.decideApproval(req.params.id, req.body.decision, "Owner fixture")); });
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  server = http.createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const owner = { cookie: "" };
  async function call(client, url, body, extra = {}, method = body === undefined ? "GET" : "POST") {
    const headers = { Origin: "https://dashboard.example", "Content-Type": "application/json", ...extra };
    if (client.cookie) headers.Cookie = client.cookie;
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.headers.get("set-cookie")) { const cookie = r.headers.get("set-cookie"); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/); client.cookie = cookie.split(";")[0]; }
    assert.equal(r.headers.get("cache-control"), url.startsWith("/security/") || r.status === 428 ? "no-store" : r.headers.get("cache-control"));
    return { status: r.status, body: await r.json() };
  }
  assert.equal((await call(owner, "/minecraft/action", { action: "restart" })).status, 200, "not enforced until enrollment");
  actions = 0;
  await call(owner, "/security/status");
  const begin = await call(owner, "/security/enroll", {});
  assert.equal(begin.status, 200);
  assert.equal((await call({ cookie: "" }, "/security/confirm", { enrollmentId: begin.body.enrollmentId, code: otp(begin.body.secret, Date.now()) })).status, 400, "another browser cannot finish enrollment");
  const enrolled = await call(owner, "/security/confirm", { enrollmentId: begin.body.enrollmentId, code: otp(begin.body.secret, Date.now()) });
  assert.equal(enrolled.status, 200);
  const codes = enrolled.body.recoveryCodes;
  const challengeResponse = await call(owner, "/minecraft/action", { action: "restart" });
  assert.equal(challengeResponse.status, 428);
  assert.equal(actions, 0);
  const verified = await call(owner, "/security/verify", { challengeId: challengeResponse.body.challengeId, code: codes[0] });
  assert.equal(verified.status, 200);
  const proofHeaders = { "X-Homelab-Step-Up": verified.body.permit };
  assert.equal((await call(owner, "/minecraft/action", { action: "stop" }, proofHeaders)).status, 428, "changed body is not authorized");
  assert.equal((await call({ cookie: owner.cookie }, "/minecraft/action", { action: "restart" }, { ...proofHeaders, "test-auth": "different-signed-login" })).status, 428, "another signed login cannot use the permit");
  assert.equal((await call(owner, "/minecraft/action", { action: "restart" }, proofHeaders)).status, 200);
  assert.equal(actions, 1);
  assert.equal((await call(owner, "/minecraft/action", { action: "restart" }, proofHeaders)).status, 428, "one use only");
  assert.equal(actions, 1);
  assert.equal((await call(owner, "/minecraft/action", { action: "restart" }, { Origin: "https://attacker.example" })).status, 403);
  const other = await call({ cookie: "" }, "/minecraft/action", { action: "restart" }, { "test-login": "other@example.com" });
  assert.equal(other.body.code, "STEP_UP_ENROLLMENT_REQUIRED");
  assert.equal((await call(owner, "/security/enroll", {}, { "test-key": "yes" })).status, 403);
  assert.equal((await call(owner, "/sidecar/approvals/fake", { decision: "approve" }, { "test-key": "yes" })).status, 403);

  const interactive = { "test-key": "yes" };
  const before = sidecar.listApprovals(true).length;
  assert.equal((await call({ cookie: "" }, "/minecraft/action", { action: "restart" }, interactive)).status, 200, "interactive assistant uses its own conversation even with enrollment active");
  assert.equal(sidecar.listApprovals(true).length, before, "interactive work must not enqueue dashboard approvals");
  actions = 1;
  const keyed = { "test-key": "yes", "test-dashboard-run": "fixture-run" };
  assert.equal((await call({ cookie: "" }, "/minecraft/action", { action: "restart" }, keyed)).status, 409, "agent needs owner approval even when requireApproval was off");
  const approval = sidecar.listApprovals().find((a) => a.action.startsWith("stepup:"));
  assert.ok(approval);
  const approveChallenge = await call(owner, `/sidecar/approvals/${approval.id}`, { decision: "approve" });
  assert.equal(approveChallenge.status, 428);
  const approvalProof = await call(owner, "/security/verify", { challengeId: approveChallenge.body.challengeId, code: codes[1] });
  assert.equal((await call(owner, `/sidecar/approvals/${approval.id}`, { decision: "approve" }, { "X-Homelab-Step-Up": approvalProof.body.permit })).status, 200);
  await sidecar.updateSettings({ requireApproval: true }, "Fixture");
  assert.equal((await call({ cookie: "" }, "/minecraft/action", { action: "restart" }, keyed)).status, 200, "approved agent action does not require a duplicate legacy approval");
  assert.equal(actions, 2);
  assert.equal((await call({ cookie: "" }, "/minecraft/action", { action: "stop" }, keyed)).status, 409, "owner approval is bound to the exact action");
  assert.equal(actions, 2);
  assert.equal((await call({ cookie: "" }, "/minecraft/action", { action: "stop" }, interactive)).status, 200, "legacy gate also allows interactive clients with requireApproval enabled");
  assert.equal(actions, 3);
  console.log("step-up: encrypted enrollment, hashed single-use recovery, TOTP replay/rate limits, fail-closed reload, session/action binding, CSRF, route coverage and owner-approved agents passed");
}

let failure;
try { await checks(); } catch (error) { failure = error; console.error(error); }
finally {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await fs.rm(tmp, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);

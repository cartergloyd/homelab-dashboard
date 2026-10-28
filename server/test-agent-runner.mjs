import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-agent-"));
const runningPids = [];
const waitFor = async (predicate, message, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < until, message);
    await delay(20);
  }
};
try {
  await fs.mkdir(path.join(tmp, "bin"));
  await fs.copyFile(new URL("./fixtures/agent-cli.mjs", import.meta.url), path.join(tmp, "bin/codex"));
  await fs.chmod(path.join(tmp, "bin/codex"), 0o755);
  Object.assign(process.env, { PATH: `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH}`, DATA_DIR: tmp, MC_DIR: tmp, CONTEXT_FILE: path.join(tmp, "instructions.md"), HOST: "0.0.0.0", PORT: "32123", CODEX_MODEL: "fixture-model", DASHBOARD_KEY: "fixture-key", AUTH_DISABLED: "1", DEMO: "0" });
  const runner = await import("./dist/services/agentRunner.js");
  const sidecar = await import("./dist/services/sidecar.js");
  const { publish } = await import("./dist/services/alerts.js");
  const { addReport } = await import("./dist/services/reports.js");
  const reviews = await import("./dist/services/incidentReviews.js");
  await sidecar.initSidecar();
  assert.equal((await runner.runnerAvailable("codex")).ok, true);

  sidecar.chat("first message", "owner");
  const first = runner.currentRun();
  const turnsBefore = sidecar.getConversation().length;
  assert.throws(() => sidecar.chat("must not be recorded", "owner"), /already running/);
  assert.equal(sidecar.getConversation().length, turnsBefore, "busy submissions must not leave phantom user messages");
  await waitFor(() => first.finishedAt, "first run did not finish");
  assert.equal(first.status, "exited");
  assert.ok(first.pid);
  assert.equal(sidecar.getPayload().state.sessionId, first.sessionId);

  sidecar.chat("follow-up", "owner");
  const resumed = runner.currentRun();
  await waitFor(() => resumed.finishedAt, "resumed run did not finish");
  const invocations = (await fs.readFile(path.join(tmp, "invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations[0].args.at(-1), "-", "prompts must travel over stdin");
  assert.ok(invocations[0].prompt.includes("first message"));
  assert.equal(invocations[0].url, "http://127.0.0.1:32123", "wildcard binds must use a loopback client URL");
  assert.equal(invocations[0].agent, "Dashboard Codex");
  assert.equal(invocations[0].keyPresent, true);
  assert.ok(invocations[0].args.includes("fixture-model"));
  assert.ok(invocations[0].args.some((arg) => arg.startsWith("mcp_servers.dashboard=") && arg.includes("required=true") && arg.includes('default_tools_approval_mode="approve"')));
  const resumeArgs = invocations[1].args;
  assert.ok(resumeArgs.indexOf("--sandbox") < resumeArgs.indexOf("resume"), "resume must not receive unsupported sandbox flags");
  assert.equal(resumeArgs[resumeArgs.indexOf("resume") + 3], first.sessionId);
  assert.ok(sidecar.getConversation().some((t) => t.text === "Continuing the saved conversation."));

  await fs.mkdir(path.join(tmp, ".local/bin"), { recursive: true });
  await fs.copyFile(path.join(tmp, "bin/codex"), path.join(tmp, ".local/bin/codex"));
  await fs.chmod(path.join(tmp, ".local/bin/codex"), 0o755);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.HOME = tmp;
  process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    assert.equal((await runner.runnerAvailable("codex")).ok, true, "user services must find an installed CLI outside PATH");
    const limited = runner.launchRun({ runner: "codex", prompt: "service PATH check", task: "service launch check", kind: "manual" });
    await waitFor(() => limited.finishedAt, "worker did not start with a limited service PATH");
    assert.equal(limited.status, "exited");
  } finally {
    process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }

  const failed = runner.launchRun({ runner: "codex", prompt: "fixture-fail", task: "failure check", kind: "manual" });
  await waitFor(() => failed.finishedAt, "failed run did not finish");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "This model is unavailable for this account.");

  const neverSpawned = runner.launchRun({ runner: "codex", prompt: "must not start", task: "immediate Stop check", kind: "manual" });
  assert.equal(runner.stopRun(neverSpawned.id), true);
  await waitFor(() => neverSpawned.finishedAt, "immediate Stop did not finish");
  assert.equal(neverSpawned.status, "cancelled");
  assert.equal(neverSpawned.pid, null, "a Stop during command setup must prevent spawning");

  await sidecar.updateSettings({ enabled: true, autoTrigger: true }, "owner");
  sidecar.chat("fixture-hold", "owner");
  const stopped = runner.currentRun();
  await waitFor(() => stopped.lines > 0, "stubborn worker did not start");
  runningPids.push(stopped.pid);
  const descendant = Number(await fs.readFile(path.join(tmp, "child-pid"), "utf8"));
  await sidecar.stopAssistant("owner");
  await waitFor(() => stopped.finishedAt, "Stop must escalate when SIGTERM is ignored");
  assert.equal(stopped.status, "cancelled");
  assert.equal(runner.currentRun(), null);
  assert.equal(sidecar.getSettings().enabled, false, "Stop must pause automatic relaunches");
  assert.equal(sidecar.getPayload().state.phase, "off");
  assert.equal(runner.stopRun(stopped.id), false);
  const descendantStat = await fs.readFile(`/proc/${descendant}/stat`, "utf8").catch(() => "");
  assert.ok(!descendantStat || /\) Z /.test(descendantStat), "Stop must also terminate descendant processes");

  const timedOut = runner.launchRun({ runner: "codex", prompt: "fixture-timeout", task: "timeout check", kind: "manual", timeoutMs: 150 });
  await waitFor(() => timedOut.finishedAt, "run limit did not terminate the worker");
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error, /run limit/);

  const approval = await sidecar.requestApproval("minecraft_service:restart", "fixture approval", "Dashboard Codex");
  await sidecar.decideApproval(approval.id, "deny", "owner");
  const continued = runner.currentRun();
  assert.ok(continued, "chat approvals must resume the conversation even without an incident");
  await waitFor(() => continued.finishedAt, "approval continuation did not finish");
  assert.equal(continued.sessionId, first.sessionId);
  publish({ source: "minecraft", kind: "log", level: "error", text: "Fixture server incident" });
  const incident = sidecar.listIncidents()[0];
  sidecar.investigateIncident(incident.id, "owner");
  const incidentRun = runner.currentRun();
  const unrelated = await addReport("Editor Codex", "Unrelated editor report", "A separate task was completed.");
  assert.equal(unrelated.incidentId, null, "reports from this chat must not inherit the dashboard incident");
  assert.equal(incident.reportIds.includes(unrelated.id), false);
  const linked = await addReport("Dashboard Codex", "Incident report", "Checked the fixture incident.", { runId: incidentRun.id });
  assert.equal(linked.incidentId, incident.id, "dashboard reports must link through their own run id");
  await waitFor(() => incidentRun.finishedAt, "incident run did not finish");
  await sidecar.revisitIncident(incident.id, "This started after a network change. Check that before suggesting a restart.", "owner");
  const revisit = runner.currentRun();
  await waitFor(() => revisit.finishedAt, "revisit did not finish");
  const review = sidecar.reviewIncident(incident.id);
  assert.equal(review.feedback.length, 1);
  assert.equal(review.feedback[0].runId, revisit.id);
  const latestInvocation = (await fs.readFile(path.join(tmp, "invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).at(-1);
  assert.match(latestInvocation.prompt, /This started after a network change/);
  assert.match(latestInvocation.prompt, /Never change shared instructions automatically/);
  assert.equal(sidecar.getSettings().enabled, false, "Revisit must not change the Auto preference");

  await fs.writeFile(path.join(tmp, "instructions.md"), "Original server instructions.\n");
  await addReport("Dashboard Codex", "Network review", "Summary: Reviewed with the owner's context.\n\nSuggested context updates:\nCheck recent network changes before recommending a restart.", { runId: revisit.id });
  const suggestion = reviews.suggestionsFor(incident.id)[0];
  assert.ok(suggestion);
  assert.equal(suggestion.status, "pending");
  assert.equal(await fs.readFile(path.join(tmp, "instructions.md"), "utf8"), "Original server instructions.\n", "suggestions must not edit instructions automatically");
  await sidecar.decideSuggestion(suggestion.id, "approve", "owner");
  assert.match(await fs.readFile(path.join(tmp, "instructions.md"), "utf8"), /Check recent network changes/);
  await assert.rejects(sidecar.decideSuggestion(suggestion.id, "approve", "owner"), /already been reviewed/);
  await reviews.initIncidentReviews();
  assert.equal(reviews.feedbackFor(incident.id)[0].text, review.feedback[0].text, "feedback must survive reloads");
  assert.equal(reviews.suggestionsFor(incident.id)[0].status, "applied");

  const express = (await import("express")).default;
  const { identityMiddleware } = await import("./dist/auth.js");
  const { api } = await import("./dist/routes.js");
  const app = express();
  app.use(express.json(), identityMiddleware);
  app.use("/api", api);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  const http = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const base = `http://127.0.0.1:${http.address().port}/api`;
  try {
    const apiReview = await fetch(`${base}/sidecar/incidents/${incident.id}/review`);
    assert.equal(apiReview.status, 200);
    assert.equal((await apiReview.json()).feedback.length, 1);
    const headers = { authorization: "Bearer fixture-key", "x-homelab-agent": "Dashboard Codex", "content-type": "application/json" };
    for (const [url, body] of [[`/sidecar/suggestions/${suggestion.id}`, { decision: "approve" }], [`/sidecar/incidents/${incident.id}/revisit`, { text: "self-generated feedback" }], ["/context", { content: "unapproved change" }], ["/context/history/fixture/restore", {}]]) {
      const response = await fetch(base + url, { method: url === "/context" ? "PUT" : "POST", headers, body: JSON.stringify(body) });
      assert.equal(response.status, 403, "the assistant cannot approve or bypass the owner's feedback flow");
    }
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
  await assert.rejects(sidecar.gate("run_script:fixture.sh", { viaKey: true, name: "Dashboard Codex" }), /Approval required/);
  await sidecar.gate("run_script:fixture.sh", { viaKey: false, name: "owner" });
  console.log("agent-runner: lifecycle, service launch, feedback persistence, and owner-only instruction approval passed");
} finally {
  for (const pid of runningPids) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  // Alerts batch their disk writes; let the final batch drain before cleanup.
  await delay(1200);
  await fs.rm(tmp, { recursive: true, force: true });
}

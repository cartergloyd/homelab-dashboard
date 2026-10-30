import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-ops-agent-"));
const mc = path.join(tmp, "mc");
const opsDir = path.join(tmp, "ops-agent");
const units = path.join(tmp, "units");
await fs.mkdir(path.join(mc, "scripts"), { recursive: true });
await fs.mkdir(opsDir);
await fs.mkdir(units);
await fs.mkdir(path.join(tmp, "data"));
await fs.mkdir(path.join(tmp, "bin"));
await fs.writeFile(path.join(opsDir, "AGENTS.md"), "# playbooks\n");
await fs.writeFile(path.join(tmp, "data/sidecar.json"), JSON.stringify({ settings: { enabled: true, autoTrigger: true, quietSeconds: 0, requireApproval: true } }));
// a fake Codex: records its arguments and run token, may edit a file in its workspace, then either finishes or holds (for the two-lane check)
await fs.writeFile(path.join(tmp, "bin/codex"), `#!${process.execPath}\nimport fs from 'node:fs';if(process.argv[2]==='login')process.exit(0);let p='';for await(const c of process.stdin)p+=c;fs.appendFileSync(${JSON.stringify(path.join(tmp, "calls.jsonl"))},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt:p})+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'ops-session'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Looked at it.'}}));if(p.includes('edit-me'))fs.writeFileSync('note.md','edited\\n');if(p.includes('hold-me'))setTimeout(()=>{},6000);`, { mode: 0o755 });
Object.assign(process.env, { PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`, DATA_DIR: path.join(tmp, "data"), MC_DIR: mc, MC_SERVICE: "minecraft-paper.service", DASHBOARD_SERVICE: "gold-dashboard.service", OPS_AGENT_DIR: opsDir, OPS_WRITABLE_DIRS: units, DEMO: "0", DASHBOARD_KEY: "fixture-master-key" });
const calls = async () => (await fs.readFile(path.join(tmp, "calls.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
const waitFor = async (predicate, what, ms = 20_000) => { const until = Date.now() + ms; while (!(await predicate())) { assert.ok(Date.now() < until, what); await delay(50); } };
try {
  const ops = await import("./dist/services/opsAgent.js");
  const routing = await import("./dist/services/routing.js");
  const { parseMeminfo } = await import("./dist/services/hostOps.js");
  const { writableRoots } = await import("./dist/services/lanes.js");
  const sidecar = await import("./dist/services/sidecar.js");
  const runner = await import("./dist/services/agentRunner.js");
  const { publish } = await import("./dist/services/alerts.js");
  const { addReport } = await import("./dist/services/reports.js");
  const { issueRunToken } = await import("./dist/services/runTokens.js");
  const { resolveIdentity } = await import("./dist/auth.js");
  const { requireStepUp } = await import("./dist/security.js");

  // which events are the ops lane's
  const ev = (source, text, level = "error", extra = {}) => ({ id: "x", ts: new Date().toISOString(), source, kind: "log", level, tags: [], text, ...extra });
  assert.deepEqual(ops.signalFor(ev("system", "gold-crm-observation.service: Failed with result 'exit-code'.")), { key: "unit:gold-crm-observation.service", title: "gold-crm-observation.service failed (exit-code)", severity: "P2", evidence: "gold-crm-observation.service: Failed with result 'exit-code'." });
  assert.equal(ops.signalFor(ev("system", "minecraft-paper.service: Failed with result 'exit-code'.")), null, "Paper's own failures stay with the Minecraft lane");
  assert.equal(ops.signalFor(ev("minecraft", "minecraft-paper.service: Failed with result 'oom-kill'.")).key, "host:memory", "an OOM kill is a host problem, from either stream");
  assert.equal(ops.signalFor(ev("system", "snap.firmware-updater.firmware-notifier.service: Failed with result 'exit-code'.")), null, "known noise is dropped");
  assert.equal(ops.signalFor(ev("postgres", 'PANIC:  could not write to file "pg_logical/replorigin_checkpoint.tmp": No space left on device')).key, "container:postgres", "one incident per container");
  for (const line of ["FATAL:  terminating connection due to administrator command", "FATAL:  the database system is shutting down", "[21:00:01] [INF] [12] Jellyfin.Database: SQLite connection error count 0"]) assert.equal(ops.signalFor(ev("postgres", line)), null, `${line} is restart chatter`);
  assert.equal(ops.signalFor(ev("scripts", "pg_backup.sh exited 1", "error", { meta: { script: "pg_backup.sh" } })).key, "job:pg_backup.sh");
  assert.equal(ops.signalFor(ev("scripts", "Traceback (most recent call last):", "error", { kind: "script", meta: { label: "backup_world.py", agent: "hl-run" } })).key, "job:backup_world.py", "cron output sent in by hl-run counts");
  for (const e of [ev("system", "gold-crm-observation.service: Failed with result 'exit-code'.", "warn"), ev("dashboard", "Scripts folder not found"), ev("agent", "Dashboard Codex: exited 1"), ev("system", "x.service: Failed with result 'exit-code'.", "error", { kind: "agent" }), ev("system", "error: connect_to 10.0.0.1 port 22: failed.")]) assert.equal(ops.signalFor(e), null);

  // shared routing rules
  assert.equal(routing.isChat("[12:00:01 INFO]: <Steve> the server crashed ERROR"), true);
  assert.equal(routing.isChat("[12:00:01 ERROR]: Could not pass event PlayerJoinEvent"), false);
  assert.equal(routing.isOomKill("minecraft-paper.service: The kernel OOM killer killed some processes in this unit."), true);
  for (let i = 0; i < 2; i++) assert.equal(routing.takeRunBudget("k", 1_000), true);
  assert.equal(routing.takeRunBudget("k", 2_000), false, "two automatic runs a day per problem");
  assert.equal(routing.takeRunBudget("k", 1_000 + 24 * 3600_000 + 1), true, "the day moves on");
  assert.equal(routing.memoryTight({ memAvailableMb: 350, psiFull10: 0 }), true);
  assert.equal(routing.memoryTight({ memAvailableMb: 2400, psiFull10: 31 }), true);
  assert.equal(routing.memoryTight({ memAvailableMb: 2400, psiFull10: 0.5 }), false);
  assert.equal(await routing.tooTightToStart(async () => ({ memAvailableMb: 100, psiFull10: 0 })), true);
  assert.ok(JSON.parse(await fs.readFile(path.join(tmp, "data/routing.json"), "utf8")).noise.length > 5, "routing.json is written with the defaults");
  assert.deepEqual(parseMeminfo("MemTotal: 7533568 kB\nMemAvailable: 2527232 kB\nSwapTotal: 4194300 kB\nSwapFree: 419430 kB\n"), { memAvailableMb: 2468, memTotalMb: 7357, swapUsedPct: 90 });
  assert.deepEqual(writableRoots("ops"), [opsDir, units, path.join(mc, "scripts")]);

  // a Minecraft chat line that looks like an error opens nothing
  await sidecar.initSidecar();
  await ops.initOpsAgent();
  const before = sidecar.listIncidents(200, true).length;
  publish({ source: "minecraft", kind: "log", text: "[12:00:01 INFO]: <Steve> help the server crashed ERROR Exception" });
  assert.equal(sidecar.listIncidents(200, true).length, before, "player chat is never an incident");

  // end to end: a unit failure becomes an ops incident and an ops-lane run in the ops workspace
  publish({ source: "system", kind: "log", text: "gold-crm-observation.service: Failed with result 'exit-code'." });
  const inc = ops.listOpsIncidents().find((i) => i.key === "unit:gold-crm-observation.service");
  assert.ok(inc, "the ops incident opened");
  await waitFor(async () => (await calls()).length >= 1, "the ops run did not start");
  const call = (await calls())[0];
  assert.equal(call.cwd, opsDir, "the ops agent works in its own workspace");
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.deepEqual(call.args.flatMap((a, i) => (a === "--add-dir" ? [call.args[i + 1]] : [])), [units, path.join(mc, "scripts")]);
  assert.match(call.prompt, /Ops incident #\w+: "gold-crm-observation\.service failed \(exit-code\)"/);
  assert.match(call.prompt, /You act on your own; there are no approvals/);
  const opsRun = runner.listAgentRuns(10).find((r) => r.incidentId === inc.id);
  assert.equal(opsRun.lane, "ops");
  await waitFor(() => !!opsRun.finishedAt, "the ops run did not finish");
  await waitFor(() => inc.status === "open", "a run without a report leaves the incident open");
  assert.match(inc.note, /without filing its findings/);
  await addReport("Dashboard Codex", "Fixed the CRM observation unit", "Summary: The script path was wrong.", { incidentId: inc.id, outcome: "fixed" });
  assert.equal(inc.status, "resolved");

  // recurrence soon after a fix reopens and runs again; the budget then sends it to the owner
  publish({ source: "system", kind: "log", text: "gold-crm-observation.service: Failed with result 'exit-code'." });
  assert.equal(inc.status, "open");
  await waitFor(async () => (await calls()).length >= 2, "the recurrence did not run");
  await waitFor(() => runner.listAgentRuns(10).filter((r) => r.incidentId === inc.id).every((r) => r.finishedAt), "second run did not finish");
  await addReport("Dashboard Codex", "Fixed again", "Summary: Same fix.", { incidentId: inc.id, outcome: "fixed" });
  publish({ source: "system", kind: "log", text: "gold-crm-observation.service: Failed with result 'exit-code'." });
  await waitFor(() => inc.status === "needs-human", "a third occurrence the same day must go to the owner");
  assert.match(inc.note, /already had 2 runs/);
  assert.equal((await calls()).length, 2, "no third run");

  // the two lanes run side by side
  sidecar.chat("hold-me while ops works", "owner");
  ops.handleSignal({ key: "unit:fam-xgold.service", title: "fam-xgold.service failed", severity: "P2", evidence: "fam-xgold.service: Failed with result 'exit-code'. hold-me" });
  await waitFor(() => !!runner.currentRun("ops"), "the ops run did not start beside the Minecraft run", 20_000);
  assert.ok(runner.currentRun("minecraft"), "the Minecraft run is still going");
  await waitFor(() => !runner.currentRun(), "runs did not finish");

  // the ops lane's own limits
  const user = (await resolveIdentity({ authorization: `Bearer ${issueRunToken({ runId: "run-o", lane: "ops", origin: "dashboard" }, 60_000)}`, "x-homelab-agent": "Dashboard Codex" }, "127.0.0.1")).user;
  const step = async (u, method, p, body = {}) => { let passed = false; await requireStepUp({ method, path: p, body, query: {} }, { locals: { user: u }, setHeader() {} }, () => { passed = true; }); return passed; };
  assert.equal(await step(user, "POST", "/units/fam-xgold.service/action", { action: "restart" }), true);
  assert.equal(await step(user, "POST", "/units/fam-xgold.service/action", { action: "restart" }), true);
  await assert.rejects(step(user, "POST", "/units/fam-xgold.service/action", { action: "restart" }), /already restarted 2 times/);
  await assert.rejects(step(user, "POST", "/units/fam-xgold.service/action", { action: "stop" }), /not stop them/);
  await assert.rejects(step(user, "POST", "/units/gold-dashboard.service/action", { action: "restart" }), /The dashboard runs you/);
  assert.equal(await step(user, "POST", "/containers/homelab-twenty/restart"), true);
  assert.equal(await step(user, "POST", "/scripts/anything.sh/run"), true, "the ops lane may run any of the owner's scripts");
  await assert.rejects(step(user, "POST", "/terminal/execute", { command: "id" }), /no access to \/terminal/);
  const mcUser = (await resolveIdentity({ authorization: `Bearer ${issueRunToken({ runId: "run-m", lane: "minecraft", origin: "dashboard" }, 60_000)}` }, "127.0.0.1")).user;
  await assert.rejects(step(mcUser, "POST", "/containers/homelab-twenty/restart"), /acts on minecraft only/);

  // the Assistant panel's view of the lane: its state, the run in progress, and each report with its rollback id
  assert.equal(ops.payload().phase, "idle");
  const edit = ops.handleSignal({ key: "unit:fam-edit.service", title: "fam-edit.service failed", severity: "P2", evidence: "fam-edit.service: Failed with result 'exit-code'. edit-me hold-me" });
  assert.equal(ops.payload().phase, "queued", "a new incident waits out the quiet period");
  await waitFor(() => ops.payload().phase === "investigating", "the panel did not show the run");
  const working = ops.payload();
  assert.equal(working.current.incidentId, edit.id);
  assert.equal(working.run.id, working.current.runId);
  assert.equal(working.run.lane, "ops");
  assert.match(working.detail, /fam-edit\.service failed/);
  await waitFor(() => ops.payload().phase === "idle", "the run did not end");
  const editRun = runner.listAgentRuns(10).find((r) => r.incidentId === edit.id);
  assert.equal(ops.payload().lastRun.id, editRun.id);
  await waitFor(() => edit.changes?.length === 1, "the run's changed files were not recorded");
  assert.deepEqual(edit.changes[0].files, [`${opsDir}/note.md`]);
  assert.deepEqual(editRun.changedFiles, [`${opsDir}/note.md`]);
  await addReport("Dashboard Codex", "Fixed fam-edit", "Summary: Edited the note.", { incidentId: edit.id, runId: editRun.id, outcome: "fixed" });
  await addReport("Dashboard Codex", "Checked again", "Summary: Looked once more.", { incidentId: edit.id, runId: "run-without-changes", outcome: "no-action" });
  const shown = ops.payload().incidents.find((i) => i.id === edit.id);
  assert.equal(shown.status, "resolved");
  assert.deepEqual(shown.reports.map((r) => [r.title, r.outcome, r.runId, r.changedFiles]), [["Fixed fam-edit", "fixed", editRun.id, [`${opsDir}/note.md`]], ["Checked again", "no-action", "run-without-changes", []]]);
  assert.equal(JSON.parse(await fs.readFile(path.join(tmp, "data/ops-incidents.json"), "utf8")).find((i) => i.id === edit.id).changes[0].runId, editRun.id, "changes survive a restart");
  sidecar.getSettings().enabled = false;
  assert.equal(ops.payload().phase, "off", "the Auto switch pauses this lane too");
  sidecar.getSettings().enabled = true;
  console.log("ops-agent: routing of units, OOM, containers and jobs, noise and chat dropped, ops runs in their own workspace and slot, reopen and run budget, unit and container limits, panel payload with reports and rollback ids passed");
} finally {
  await delay(1500); // alerts batch their disk writes
  await fs.rm(tmp, { recursive: true, force: true });
}

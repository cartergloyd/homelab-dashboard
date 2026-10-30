import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Demo mode: the ops lane starts with seeded incidents and a scripted agent answers new ones, so the
// Assistant panel's ops lane works on a laptop with no agent CLI (DEMO_INDEX.md).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-ops-demo-"));
await fs.mkdir(path.join(tmp, "data"));
await fs.mkdir(path.join(tmp, "mc"));
// no codex or claude on PATH: a real launch would fail, so only the simulated agent can file the report
Object.assign(process.env, { DEMO: "1", AUTH_DISABLED: "1", DATA_DIR: path.join(tmp, "data"), MC_DIR: path.join(tmp, "mc"), PATH: "/usr/bin:/bin" });
const waitFor = async (predicate, what, ms = 30_000) => { const until = Date.now() + ms; while (!(await predicate())) { assert.ok(Date.now() < until, what); await delay(50); } };
try {
  const { initReports } = await import("./dist/services/reports.js");
  const sidecar = await import("./dist/services/sidecar.js");
  const ops = await import("./dist/services/opsAgent.js");
  await initReports();
  await sidecar.initSidecar();
  await ops.initOpsAgent();

  // seeded: one left open, one for the owner, one fixed with a rollback id
  const seeded = ops.payload();
  assert.equal(seeded.phase, "idle");
  assert.equal(seeded.run, null);
  assert.deepEqual(seeded.incidents.map((i) => i.status), ["open", "needs-human", "resolved"]);
  assert.deepEqual(seeded.incidents.find((i) => i.status === "resolved").reports.map((r) => [r.outcome, r.runId, r.changedFiles]), [["fixed", "demo-ops-run-1", ["~/.config/systemd/user/fam-jellyfin-sync.service"]]]);
  assert.deepEqual(seeded.incidents.find((i) => i.status === "needs-human").reports.map((r) => [r.outcome, r.changedFiles]), [["needs-human", []]]);
  await waitFor(async () => JSON.parse(await fs.readFile(path.join(tmp, "data/ops-incidents.json"), "utf8").catch(() => "[]")).length === 3, "the seed was not saved");

  // a simulated unit failure: the scripted agent records a changed file and files a fixed report
  sidecar.simulateIncident("unit");
  const inc = ops.listOpsIncidents().find((i) => i.key === "unit:fam-mc-activity.service");
  assert.ok(inc, "the failed unit opened an ops incident");
  await waitFor(() => ops.payload().phase === "investigating", "the simulated run did not start");
  await waitFor(() => inc.reportIds.length === 1, "the simulated ops agent did not report");
  await waitFor(() => ops.payload().phase === "idle", "the simulated run did not end");
  const shown = ops.payload().incidents.find((i) => i.id === inc.id);
  assert.equal(shown.status, "resolved");
  assert.equal(shown.reports[0].outcome, "fixed");
  assert.equal(shown.reports[0].runId, shown.runIds[0]);
  assert.deepEqual(shown.reports[0].changedFiles, ["~/.config/systemd/user/fam-mc-activity.service"]);
  assert.equal(ops.payload().lastRun.status, "exited");
  console.log("ops-lane demo: seeded incidents with reports and a rollback id, simulated unit failure answered by the scripted ops agent passed");
} finally {
  await delay(1500); // alerts batch their disk writes
  await fs.rm(tmp, { recursive: true, force: true });
}

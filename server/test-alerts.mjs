import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-alerts-"));
process.env.DATA_DIR = tmp;
try {
  const { classify, isProblem, isRoutineConnection, isTailDiagnostic, publish, query, recentLines, summary } = await import("./dist/services/alerts.js");
  assert.equal(isTailDiagnostic("[journalctl] permission denied"), true);
  assert.equal(isTailDiagnostic("[journalctl unavailable] command not found"), true);
  assert.equal(isTailDiagnostic("[docker socket not available at /tmp/docker.sock]"), true);
  assert.equal(isTailDiagnostic("[docker logs error] disconnected"), true);
  assert.equal(isTailDiagnostic("[18:05:48 INFO]: Alex joined the game"), false, "reconnected tails must retain timestamped player events");
  assert.equal(isTailDiagnostic("[Server thread/INFO]: Alex left the game"), false);
  const routine = [
    "[18:05:48 INFO]: Thread RCON Client /192.168.1.148 shutting down",
    "[18:05:48 INFO]: Thread RCON Client /192.168.1.148 started",
    "Thread RCON Client /127.0.0.1 started",
    "Thread RCON Client /[::1]:12345 shutting down",
  ];
  for (const text of routine) {
    assert.deepEqual(classify(text), { level: "info", tags: [] });
    const e = publish({ source: "minecraft", text });
    assert.equal(isRoutineConnection(e), true);
    assert.equal(isProblem({ ...e, tags: ["maintenance"] }), false, "old misclassified events must also be hidden");
  }
  publish({ source: "minecraft", text: routine[0], tags: ["maintenance"] });
  assert.equal(query().length, 0, "routine connections must not appear even in the unfiltered feed");
  assert.deepEqual(recentLines("minecraft", 4), [...routine.slice(1), routine[0]], "raw logs must retain connection messages");
  assert.equal(summary().maintenanceLastHour, 0, "routine connections are not maintenance");
  assert.equal(summary().lastMaintenance, null);

  const failures = [
    "[18:05:48 ERROR]: RCON connection failed: connection refused",
    "[18:05:48 WARN]: Thread RCON Client /192.168.1.148 shutting down",
    "[18:05:48 ERROR]: Thread RCON Client /192.168.1.148 shutting down",
    "[18:05:48 INFO]: Thread RCON Client /192.168.1.148 shutting down after authentication failure",
  ];
  for (const text of failures) {
    const e = publish({ source: "minecraft", text });
    assert.equal(isRoutineConnection(e), false);
    assert.equal(isProblem(e), true);
  }
  const shutdown = publish({ source: "minecraft", text: "[18:06:00 INFO]: Stopping the server; shutting down" });
  assert.equal(isProblem(shutdown), true);
  assert.equal(isRoutineConnection({ ...shutdown, text: routine[0], kind: "agent" }), false);
  assert.equal(isRoutineConnection({ ...shutdown, text: routine[0], source: "system" }), false);
  assert.equal(query({ problemsOnly: true }).length, failures.length + 1);
  assert.equal(summary().maintenanceLastHour > 0, true);
  console.log("alerts: routine RCON activity hidden, raw logs preserved, real failures and shutdowns retained");
  await new Promise(resolve => setTimeout(resolve, 1200));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

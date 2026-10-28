import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";

const source = await fs.readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const compiled = await transform(source, { loader: "ts", format: "esm" });
const { api, setStepUpHandler } = await import("data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64"));
const originalFetch = globalThis.fetch;
let calls;
let mode;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (mode === "network") throw new Error("network lost");
  if (mode === "bad") return Response.json({ error: "blocked" }, { status: 403 });
  if (mode === "enrollment") return Response.json({ code: "STEP_UP_ENROLLMENT_REQUIRED" }, { status: 428 });
  if (calls.length === 1 || mode === "always-challenge") return Response.json({ code: "STEP_UP_REQUIRED", challengeId: "fixture", description: "Restart" }, { status: 428 });
  assert.equal(new Headers(init.headers).get("X-Homelab-Step-Up"), "one-use-proof");
  assert.equal(init.body, JSON.stringify({ action: "restart" }));
  return Response.json({ ok: true });
};
try {
  calls = []; mode = "challenge";
  setStepUpHandler(async (challenge) => { assert.equal(challenge.challengeId, "fixture"); return "one-use-proof"; });
  assert.deepEqual(await api.post("/minecraft/action", { action: "restart" }), { ok: true });
  assert.equal(calls.length, 2);
  calls = []; mode = "always-challenge";
  await assert.rejects(api.post("/minecraft/action", { action: "restart" }));
  assert.equal(calls.length, 2, "a repeated challenge is never retried again");
  for (const failure of ["bad", "network"]) {
    calls = []; mode = failure;
    await assert.rejects(api.post("/minecraft/action", { action: "restart" }));
    assert.equal(calls.length, 1, "normal errors and uncertain network results are not replayed");
  }
  calls = []; mode = "challenge";
  setStepUpHandler(async () => null);
  await assert.rejects(api.post("/minecraft/action", { action: "restart" }), /cancelled/);
  assert.equal(calls.length, 1);
  calls = []; mode = "enrollment";
  setStepUpHandler(async (challenge) => { assert.equal(challenge.enrollmentRequired, true); return null; });
  await assert.rejects(api.post("/minecraft/action", { action: "restart" }), /cancelled/);
  assert.equal(calls.length, 1);
  console.log("step-up browser client: only pre-action challenges can retry; exact body/proof preserved; cancellation, enrollment, failures and replay limits passed");
} finally { globalThis.fetch = originalFetch; setStepUpHandler(null); }

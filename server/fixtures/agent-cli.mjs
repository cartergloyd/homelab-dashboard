#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "login") process.exit(0);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
fs.appendFileSync(path.join(process.env.DATA_DIR, "invocations.jsonl"), JSON.stringify({ args, prompt, url: process.env.HOMELAB_URL, agent: process.env.HOMELAB_AGENT, keyPresent: !!process.env.HOMELAB_KEY }) + "\n");
const emit = (value) => console.log(JSON.stringify(value));
emit({ type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" });

if (prompt.includes("fixture-fail")) {
  emit({ type: "turn.failed", error: { message: JSON.stringify({ error: { message: "This model is unavailable for this account." } }) } });
  process.exit(1);
}
if (prompt.includes("fixture-hold") || prompt.includes("fixture-timeout")) {
  if (prompt.includes("fixture-hold")) process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(process.env.DATA_DIR, "child-pid"), String(child.pid));
  emit({ type: "item.completed", item: { type: "agent_message", text: "Worker ready." } });
  setInterval(() => {}, 1000);
} else {
  emit({ type: "item.completed", item: { type: "agent_message", text: args.includes("resume") ? "Continuing the saved conversation." : "Started the dashboard conversation." } });
}

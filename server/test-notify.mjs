import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "homelab-notify-"));
await fs.writeFile(path.join(tmp, "secrets.env"), "DISCORD_BOT_TOKEN=fixture-owner-bot-token\n");
Object.assign(process.env, { DATA_DIR: tmp, MC_DIR: tmp, DEMO: "0", RCON_PASSWORD: "fixture-rcon-pw", OWNER_DISCORD_CHANNEL_ID: "1348481613234966568", OWNER_DISCORD_TOKEN_FILE: path.join(tmp, "secrets.env"), PUBLIC_DASHBOARD_URL: "https://dash.example" });
const posts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  posts.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ id: String(posts.length) }), { status: 200 });
};
try {
  const { Notifier, messageForEvent, messageForReport, startNotifications } = await import("./dist/services/notify.js");
  const { publish } = await import("./dist/services/alerts.js");
  const { addReport } = await import("./dist/services/reports.js");

  // rate limit, held updates, dedupe, secrets
  let now = Date.parse("2026-10-30T12:00:00Z");
  const sent = [];
  const n = new Notifier({ send: async (text, replyTo) => { sent.push({ text, replyTo }); }, now: () => now });
  for (let i = 0; i < 6; i++) assert.equal(await n.notify(`update ${i}`), true);
  assert.equal(await n.notify("update 6"), false, "at most 6 posts an hour");
  assert.equal(await n.notify("update 7"), false);
  assert.equal(sent.length, 6);
  now += 3600_001;
  assert.equal(await n.notify("update 8", "999"), true);
  assert.match(sent.at(-1).text, /^update 8\n_\(\+2 more updates in the dashboard since/);
  assert.equal(sent.at(-1).replyTo, "999", "replies to a Discord message when asked");
  assert.equal(await n.notify("update 8"), false, "the same text is not posted twice in 10 minutes");
  await n.notify("the rcon password is fixture-rcon-pw");
  assert.match(sent.at(-1).text, /withheld because it contained RCON_PASSWORD/);
  assert.equal(sent.at(-1).text.includes("fixture-rcon-pw"), false);
  const quiet = new Notifier({ send: async (text) => { sent.push({ text }); }, now: () => now });
  for (let i = 0; i < 7; i++) await quiet.notify(`q ${i}`);
  now += 3600_001;
  assert.equal(await quiet.flushHeld(), true);
  assert.match(sent.at(-1).text, /^1 more assistant update since .* see the dashboard\.$/);

  // what the owner hears about
  assert.match(messageForEvent({ source: "agent", kind: "agent", level: "warn", tags: ["maintenance", "files"], text: "Dashboard Codex changed 1 file: scripts/a.sh. Undo with rollback_run r1.", meta: { files: ["scripts/a.sh"] } }), /^🛠️ Dashboard Codex changed 1 file/);
  assert.match(messageForEvent({ source: "dashboard", kind: "agent", level: "warn", tags: ["security", "refused"], text: "Refused Dashboard Codex: \"op\" changes who may do what" }), /^🚫 Refused/);
  assert.match(messageForEvent({ source: "dashboard", kind: "agent", level: "error", tags: ["security"], text: "Blocked a Discord support reply that contained DISCORD_BOT_TOKEN" }), /^🛑 Blocked/);
  assert.match(messageForEvent({ source: "agent", kind: "agent", level: "error", tags: ["maintenance"], text: "Dashboard Codex: Stopped after 20 minutes (run limit)", meta: { runId: "r2", exitCode: null } }), /could not finish a run/);
  for (const e of [{ source: "agent", kind: "agent", level: "info", tags: [], text: "Dashboard Codex: → server_status({})", meta: { runId: "r2" } }, { source: "minecraft", kind: "log", level: "error", tags: [], text: "Exception ticking world" }]) assert.equal(messageForEvent(e), null, "routine lines stay in the feed");
  const report = (outcome, body = "Summary: Restarted Paper after a crash.\n\nActions taken: …") => ({ id: "x", ts: "", agent: "Dashboard Codex", title: "Paper crashed", body, reviewed: false, reviewedBy: null, reviewedAt: null, incidentId: null, runId: null, outcome });
  assert.equal(messageForReport(report("fixed")), "✅ Fixed by the assistant: **Paper crashed**\nRestarted Paper after a crash.");
  assert.equal(messageForReport(report("needs-human")), "🙋 Needs you: **Paper crashed**\nRestarted Paper after a crash.\n<https://dash.example>");
  assert.equal(messageForReport(report("no-action")), null, "checked-and-left-alone stays in the dashboard");

  // wired up: feed events and reports reach the configured channel, without mentions
  await startNotifications();
  publish({ source: "dashboard", kind: "agent", level: "warn", tags: ["security", "refused"], text: "Refused Dashboard Codex (Discord run): \"op\" changes who may do what" });
  await addReport("Dashboard Codex", "Xbox sign-in expired", "Summary: MCXboxBroadcast needs a new sign-in.", { outcome: "needs-human" });
  for (let i = 0; i < 50 && posts.length < 2; i++) await delay(20);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, "https://discord.com/api/v10/channels/1348481613234966568/messages");
  assert.equal(posts[0].auth, "Bot fixture-owner-bot-token");
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.match(posts[0].body.content, /^🚫 Refused/);
  assert.match(posts[1].body.content, /^🙋 Needs you: \*\*Xbox sign-in expired\*\*/);
  console.log("notify: hourly limit with held summaries, dedupe, secrets withheld, owner-relevant events and reports, Discord posting without mentions passed");
} finally {
  globalThis.fetch = realFetch;
  await delay(1200); // alerts batch their disk writes
  await fs.rm(tmp, { recursive: true, force: true });
}

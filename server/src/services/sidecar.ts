// The Assistant sidecar (issue #5): a supervised, long-lived loop that turns the
// Live Server Alerts feed into incidents, launches the owner's signed-in coding
// agent (Codex / Claude Code) on them one at a time, keeps a readable
// conversation, pauses for the owner's approval before risky actions, and links
// the resulting reports back to the incident. The agent runs on the owner's
// subscription; no API keys. Nothing here edits a timer, crontab or world file —
// the agent does that inside its workspace through the MCP tools.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentRun, AgentRunner, AlertEvent, Approval, ConversationTurn, Incident, SidecarPayload, SidecarPhase, SidecarSettings, SidecarState } from "../types.js";
import { RUNNER_NAME, currentRun, launchRun, listAgentRuns, runnerAvailable, type LaunchOptions } from "./agentRunner.js";
import { publish, subscribe } from "./alerts.js";
import { addReport, onReport } from "./reports.js";

interface Identity {
  viaKey?: boolean;
  name: string;
}

const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = new Set<Incident["status"]>(["open", "investigating", "waiting-approval"]);
const APPROVAL_TTL_MS = 24 * 3600_000;

const DEFAULTS = (): SidecarSettings => ({
  enabled: cfg.demo,
  runner: "codex",
  autoTrigger: true,
  requireApproval: true,
  cooldownMinutes: 30,
  quietSeconds: cfg.demo ? 3 : 20,
  workspace: cfg.minecraft.dir,
  maxRunMinutes: 20,
});

let settings: SidecarSettings = DEFAULTS();
let lastSession: Partial<Record<AgentRunner, string>> = {};
let incidents: Incident[] = [];
let approvals: Approval[] = [];
let conversation: ConversationTurn[] = [];
const queue: string[] = [];
const launchTimers = new Map<string, NodeJS.Timeout>();
const continuations = new Map<string, string>();
const warnSeen = new Map<string, number[]>();
let phase: SidecarPhase = "off";
let phaseSince = iso();
let phaseDetail: string | null = null;
let current: { incidentId: string | null; runId: string | null } = { incidentId: null, runId: null };
let runnerOk: { ok: boolean | null; note: string | null } = { ok: null, note: null };
let turnsThisRun = 0;

const file = (name: string) => path.join(cfg.dataDir, name);
async function writeJson(name: string, data: unknown): Promise<void> {
  const tmp = `${file(name)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file(name));
}
async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}
const persistSettings = () => writeJson("sidecar.json", { settings, lastSession }).catch(() => {});
const persistIncidents = () => writeJson("incidents.json", incidents.slice(0, 500)).catch(() => {});
const persistApprovals = () => writeJson("approvals.json", approvals.slice(0, 500)).catch(() => {});

function setPhase(p: SidecarPhase, detail: string | null = null): void {
  if (phase !== p || detail !== phaseDetail) phaseSince = iso();
  phase = p;
  phaseDetail = detail;
}

// ---- conversation ------------------------------------------------------------------

function addTurn(role: ConversationTurn["role"], text: string, runId: string | null = null, incidentId: string | null = null): ConversationTurn {
  const t: ConversationTurn = { id: crypto.randomUUID(), ts: iso(), role, text: text.trim().slice(0, 12_000), runId, incidentId };
  conversation.push(t);
  if (conversation.length > 500) conversation.splice(0, conversation.length - 500);
  fsp.appendFile(file("sidecar-conversation.jsonl"), `${JSON.stringify(t)}\n`).catch(() => {});
  if (role === "assistant") turnsThisRun++;
  return t;
}

export function getConversation(limit = 100): ConversationTurn[] {
  return conversation.slice(-limit);
}

// ---- incidents: detection -----------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\d{4}-\d{2}-\d{2}[^\]]*\]/g, "")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "")
    .replace(/\b[0-9a-f-]{8,}\b/g, "#")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function titleOf(text: string): string {
  return (
    text
      .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "")
      .replace(/^\[[^\]]*\/(ERROR|WARN|SEVERE|FATAL|INFO)\]:?\s*/i, "")
      .trim()
      .slice(0, 110) || text.slice(0, 110)
  );
}

function repeatedWarning(fp: string, ts: number): boolean {
  const list = (warnSeen.get(fp) ?? []).filter((t) => ts - t < 10 * 60_000);
  list.push(ts);
  warnSeen.set(fp, list);
  if (list.length >= 3) {
    warnSeen.set(fp, []);
    return true;
  }
  return false;
}

function isActionable(e: AlertEvent, fp: string): boolean {
  if (e.source === "agent" || e.meta?.agent || e.meta?.incidentId) return false; // the agent's own output
  if (e.source === "dashboard" && e.level === "info") return false;
  if (e.level === "error") return true;
  if (e.level === "warn") return repeatedWarning(fp, Date.parse(e.ts));
  return false;
}

function lastRunAt(inc: Incident): number {
  const runs = listAgentRuns(50).filter((r) => inc.runIds.includes(r.id));
  return runs.length ? Math.max(...runs.map((r) => Date.parse(r.startedAt))) : 0;
}

function onEvent(e: AlertEvent): void {
  const fp = `${e.source}|${normalize(e.text)}`;
  if (!isActionable(e, fp)) return;
  const cooldownMs = settings.cooldownMinutes * 60_000;
  let inc = incidents.find((i) => i.fingerprint === fp && (ACTIVE.has(i.status) || Date.now() - Date.parse(i.lastSeen) < cooldownMs));
  if (inc) {
    inc.count++;
    inc.lastSeen = e.ts;
    if (inc.alertIds.length < 50) inc.alertIds.push(e.id);
    inc.samples = [...inc.samples, e.text].slice(-20);
    if (inc.status === "resolved" || inc.status === "failed") {
      inc.note = `Recurred ${inc.status === "resolved" ? "after being resolved" : "after a failed run"} — ${new Date(e.ts).toLocaleString()}`;
      inc.status = "open";
    }
    void persistIncidents();
    if (inc.status === "open" && Date.now() - lastRunAt(inc) > cooldownMs) scheduleLaunch(inc);
    return;
  }
  inc = {
    id: crypto.randomUUID().slice(0, 8),
    fingerprint: fp,
    title: titleOf(e.text),
    source: e.source,
    level: e.level,
    status: "open",
    firstSeen: e.ts,
    lastSeen: e.ts,
    count: 1,
    alertIds: [e.id],
    samples: [e.text],
    runIds: [],
    reportIds: [],
    approvalIds: [],
    note: null,
  };
  incidents.unshift(inc);
  if (incidents.length > 500) incidents.splice(500);
  void persistIncidents();
  publish({ source: "dashboard", kind: "agent", level: "warn", tags: ["maintenance", "incident"], text: `New incident #${inc.id}: ${inc.title}`, meta: { incidentId: inc.id } });
  scheduleLaunch(inc);
}

function scheduleLaunch(inc: Incident): void {
  if (!settings.enabled || !settings.autoTrigger) return;
  if (launchTimers.has(inc.id) || queue.includes(inc.id) || current.incidentId === inc.id) return;
  if (phase === "idle") setPhase("queued", `New incident: ${inc.title}`);
  launchTimers.set(
    inc.id,
    setTimeout(() => {
      launchTimers.delete(inc.id);
      enqueue(inc.id);
    }, settings.quietSeconds * 1000),
  );
}

function enqueue(incidentId: string): void {
  if (!queue.includes(incidentId)) queue.push(incidentId);
  pump();
}

function pump(): void {
  if (currentRun()) return;
  const next = queue.shift();
  if (!next) {
    if (approvals.some((a) => a.status === "pending")) setPhase("waiting-approval", phaseDetail ?? "Waiting for the owner's decision");
    else if (phase !== "failed") setPhase(settings.enabled ? "idle" : "off");
    return;
  }
  startIncidentRun(next);
}

// ---- prompts ---------------------------------------------------------------------------

function openIncidentsSummary(): string {
  const open = incidents.filter((i) => ACTIVE.has(i.status)).slice(0, 8);
  return open.length ? open.map((i) => `- #${i.id} [${i.status}] ${i.title} (${i.count}×, last ${i.lastSeen.slice(0, 16).replace("T", " ")})`).join("\n") : "- none";
}

const RULES = `Rules:
- Start with read_instructions, then get_alerts (problemsOnly, sinceMinutes=120) and server_status.
- Keep file edits inside the workspace. Prefer the dashboard's tools (minecraft_rcon, run_script, run_backup, list_jobs) over hand-rolled commands.
- Before restarting/stopping the server or any destructive RCON command (stop, ban, op, deop, kill, whitelist off) call request_approval(action, reason) and then STOP and end your turn. The dashboard asks the owner and resumes you with the decision; do not wait or poll.
- Finish every investigation with submit_report(incidentId=…): what happened, what you did, when and why, what a human should decide, and any suggested changes to the instructions. If nothing needs doing, still file a short report saying so.
- append_instructions only for durable lessons about this server.`;

function incidentPrompt(inc: Incident, continuation?: string): string {
  const head = `You are the Minecraft server maintenance assistant, running as a sidecar of the homelab dashboard. Workspace: ${settings.workspace}.`;
  const body = `Incident #${inc.id}: "${inc.title}" — ${inc.count} occurrence(s) between ${inc.firstSeen.slice(0, 19).replace("T", " ")} and ${inc.lastSeen.slice(0, 19).replace("T", " ")} (source ${inc.source}, level ${inc.level}).\nRecent lines:\n${inc.samples
    .slice(-12)
    .map((s) => `  ${s}`)
    .join("\n")}${inc.note ? `\nNote: ${inc.note}` : ""}\n\nOther open incidents:\n${openIncidentsSummary()}`;
  return [head, "", body, "", RULES, continuation ? `\nUpdate from the dashboard: ${continuation}` : ""].join("\n");
}

function chatPrompt(text: string, alert: AlertEvent | null): string {
  return [
    `You are the Minecraft server maintenance assistant, running as a sidecar of the homelab dashboard. Workspace: ${settings.workspace}. The owner is talking to you in the dashboard's Assistant panel; reply concisely in plain language (they are not a developer).`,
    "",
    alert ? `They are pointing at this alert: ${alert.ts.slice(0, 19).replace("T", " ")} [${alert.source}] ${alert.level.toUpperCase()} ${alert.text}\n` : "",
    `Open incidents:\n${openIncidentsSummary()}`,
    "",
    RULES,
    "File a report only if you changed something.",
    "",
    `Owner: ${text.trim()}`,
  ].join("\n");
}

function manualPrompt(task: string): string {
  return [`You are the Minecraft server maintenance assistant launched from the homelab dashboard. Workspace: ${settings.workspace}.`, "", `Open incidents:\n${openIncidentsSummary()}`, "", RULES, "", `Task: ${task.trim()}`].join("\n");
}

// ---- demo: a simulated agent -------------------------------------------------------------

function simulateAgent(inc: Incident | null, continuation: string | undefined, runner: AgentRunner, userText?: string): LaunchOptions["simulate"] {
  const name = `${RUNNER_NAME[runner]} (demo)`;
  return async (emit, say) => {
    const runId = currentRun()?.id ?? null;
    await sleep(700);
    emit("→ read_instructions()");
    await sleep(600);
    emit("→ get_alerts(problemsOnly=true, sinceMinutes=120)");
    await sleep(700);
    if (userText) {
      emit("→ server_status()");
      await sleep(600);
      say(`(demo) You asked: "${userText.slice(0, 120)}". The server is up with 3 players, TPS 20.0 and 3.1 GB of 4 GB heap in use. ${inc ? `Open incident #${inc.id} (${inc.title}) is what I'd look at first.` : "No open incidents right now."} On the real server I would answer this using the MCP tools and the Paper log.`);
      return 0;
    }
    if (!inc) {
      say("(demo) Nothing to do.");
      return 0;
    }
    if (continuation?.includes("APPROVED")) {
      emit("→ minecraft_rcon(say Server restarting in 10 seconds to clear an error)");
      await sleep(900);
      emit("→ minecraft_service(restart)");
      await sleep(1400);
      emit("→ server_status()");
      say("Restarted the server with your approval. It came back in 31 s; TPS is 20.0 and all three players reconnected.");
      await addReport(name, `Restarted after: ${inc.title}`, `Summary: ${inc.title} (${inc.count}× since ${inc.firstSeen.slice(11, 16)}). A restart was the smallest safe fix.\n\nActions taken:\n- Warned players over RCON, restarted via systemd (approved by the owner at ${new Date().toLocaleTimeString()}).\n- Verified TPS 20.0 and memory 2.4 GB after restart.\n\nFollow-up for a human:\n- If this recurs, check the plugin stack trace in logs/latest.log and consider updating the plugin.`, { incidentId: inc.id, runId });
      return 0;
    }
    if (continuation?.includes("DENIED")) {
      say("Understood — not restarting. The error has not repeated in the last 10 minutes and TPS is normal, so I left it and noted it for you.");
      await addReport(name, `Observed, no restart: ${inc.title}`, `Summary: ${inc.title}. A restart was proposed and declined by the owner.\n\nActions taken:\n- None beyond investigation.\n\nFollow-up for a human:\n- Watch for recurrence; the stack trace is in logs/latest.log.`, { incidentId: inc.id, runId });
      return 0;
    }
    emit("→ server_status()");
    await sleep(600);
    emit("→ minecraft_rcon(tps)");
    await sleep(700);
    if (/exception|crash|stopped|died|out of memory|killed|refused/i.test(`${inc.title} ${inc.samples.join(" ")}`)) {
      say(`The server logged "${inc.title.slice(0, 80)}" ${inc.count} time(s). TPS dipped to 14 while it happened. A restart would clear it; players would be warned first. Requesting your approval.`);
      await sleep(400);
      emit("→ request_approval(minecraft_service:restart)");
      await requestApproval("minecraft_service:restart", `Clear "${inc.title.slice(0, 80)}" with a restart. 3 players online would get a 10-second warning.`, name, runId, inc.id);
      return 0;
    }
    say(`Looked into "${inc.title.slice(0, 80)}": it happened ${inc.count} time(s) and the server recovered on its own (TPS 20.0, no further errors). No action needed.`);
    await addReport(name, `No action needed: ${inc.title.slice(0, 80)}`, `Summary: ${inc.title} — transient, recovered without intervention.\n\nActions taken:\n- Checked tps, server_status and the last 2 hours of alerts.\n\nFollow-up for a human:\n- None.`, { incidentId: inc.id, runId });
    return 0;
  };
}

// ---- runs ---------------------------------------------------------------------------------

function startIncidentRun(incidentId: string): void {
  const inc = incidents.find((i) => i.id === incidentId);
  const continuation = continuations.get(incidentId);
  continuations.delete(incidentId);
  if (!inc || (!continuation && !ACTIVE.has(inc.status))) {
    pump();
    return;
  }
  turnsThisRun = 0;
  let run: AgentRun;
  try {
    run = launchRun({
      runner: settings.runner,
      prompt: incidentPrompt(inc, continuation),
      task: continuation ? `Continue incident #${inc.id}: ${inc.title}` : `Investigate incident #${inc.id}: ${inc.title}`,
      kind: continuation ? "continuation" : "incident",
      incidentId: inc.id,
      resume: lastSession[settings.runner] ?? null,
      cwd: settings.workspace,
      timeoutMs: settings.maxRunMinutes * 60_000,
      onMessage: (t) => addTurn("assistant", t, current.runId, inc.id),
      onExit: onRunExit,
      simulate: cfg.demo ? simulateAgent(inc, continuation, settings.runner) : undefined,
    });
  } catch (e) {
    queue.unshift(incidentId);
    if (continuation) continuations.set(incidentId, continuation);
    setPhase(phase, `Waiting for the current run to finish (${(e as Error).message})`);
    return;
  }
  inc.status = "investigating";
  inc.runIds.push(run.id);
  void persistIncidents();
  current = { incidentId: inc.id, runId: run.id };
  setPhase(continuation ? "acting" : "investigating", `${continuation ? "Continuing" : "Investigating"}: ${inc.title}`);
  addTurn("system", continuation ? `Resuming incident #${inc.id} — ${continuation}` : `Investigating incident #${inc.id}: ${inc.title} (${inc.count}×, first ${inc.firstSeen.slice(11, 16)})`, run.id, inc.id);
}

function onRunExit(run: AgentRun, finalText: string): void {
  if (run.sessionId) {
    lastSession[run.runner] = run.sessionId;
    void persistSettings();
  }
  if (turnsThisRun === 0 && finalText) addTurn("assistant", finalText, run.id, run.incidentId);
  const inc = run.incidentId ? incidents.find((i) => i.id === run.incidentId) : null;
  const pending = approvals.find((a) => a.status === "pending" && (a.runId === run.id || (inc && a.incidentId === inc.id)));
  if (inc) {
    if (pending) {
      inc.status = "waiting-approval";
      setPhase("waiting-approval", `Waiting for approval: ${pending.action}`);
    } else if (run.status === "exited" && (run.exitCode ?? 0) === 0) {
      if (inc.reportIds.length) inc.status = "resolved";
      else {
        inc.status = "open";
        inc.note = "The agent finished without filing a report — nothing was confirmed. Investigate again or dismiss.";
      }
    } else {
      inc.status = "failed";
      inc.note = `The agent exited ${run.exitCode ?? "without a code"}. ${runnerOk.ok === false ? runnerOk.note ?? "" : "Check the agent lines in the feed."}`;
      setPhase("failed", `Last run failed: ${inc.title}`);
      setTimeout(() => phase === "failed" && pump(), 60_000).unref();
    }
    void persistIncidents();
  } else if (run.status !== "exited" || (run.exitCode ?? 0) !== 0) {
    setPhase("failed", `Last run failed (exit ${run.exitCode ?? "?"})`);
    setTimeout(() => phase === "failed" && pump(), 60_000).unref();
  }
  current = { incidentId: null, runId: null };
  if (phase !== "failed" && phase !== "waiting-approval") setPhase(settings.enabled ? "idle" : "off");
  pump();
}

/** The owner types in the panel. */
export function chat(text: string, by: string, alert: AlertEvent | null = null): ConversationTurn {
  const t = text.trim();
  if (!t) throw new HttpError(400, "Say something first");
  const turn = addTurn("user", alert ? `${t}\n\n↳ about: ${alert.text}` : t, null, current.incidentId);
  turnsThisRun = 0;
  const run = launchRun({
    runner: settings.runner,
    prompt: chatPrompt(t, alert),
    task: `Owner: ${t.slice(0, 100)}`,
    kind: "chat",
    resume: lastSession[settings.runner] ?? null,
    cwd: settings.workspace,
    timeoutMs: settings.maxRunMinutes * 60_000,
    onMessage: (m) => addTurn("assistant", m, current.runId, null),
    onExit: onRunExit,
    simulate: cfg.demo ? simulateAgent(incidents.find((i) => ACTIVE.has(i.status)) ?? null, undefined, settings.runner, t) : undefined,
  });
  current = { incidentId: null, runId: run.id };
  setPhase("investigating", `Answering ${by}`);
  return turn;
}

/** The "Launch an agent" button: a one-off manual task. */
export function launchManual(runner: AgentRunner, task: string): AgentRun {
  const t = task.trim() || "Review recent alerts, read the instructions, investigate anything broken, make safe repairs, and file a report.";
  turnsThisRun = 0;
  const run = launchRun({
    runner,
    prompt: manualPrompt(t),
    task: t,
    kind: "manual",
    resume: lastSession[runner] ?? null,
    cwd: settings.workspace,
    timeoutMs: settings.maxRunMinutes * 60_000,
    onMessage: (m) => addTurn("assistant", m, current.runId, null),
    onExit: onRunExit,
    simulate: cfg.demo ? simulateAgent(incidents.find((i) => ACTIVE.has(i.status)) ?? null, undefined, runner, t) : undefined,
  });
  current = { incidentId: null, runId: run.id };
  addTurn("system", `Launched ${RUNNER_NAME[runner]} manually: ${t}`, run.id, null);
  setPhase("investigating", `Manual task: ${t.slice(0, 80)}`);
  return run;
}

// ---- approvals ------------------------------------------------------------------------------

function expireApprovals(): void {
  const cutoff = Date.now() - APPROVAL_TTL_MS;
  let changed = false;
  for (const a of approvals) {
    if (a.status === "pending" && Date.parse(a.ts) < cutoff) {
      a.status = "expired";
      changed = true;
    }
  }
  if (changed) void persistApprovals();
}

export async function requestApproval(action: string, reason: string, by: string, runId: string | null = null, incidentId: string | null = null): Promise<Approval> {
  expireApprovals();
  const existing = approvals.find((a) => a.status === "pending" && a.action === action);
  if (existing) return existing;
  const a: Approval = { id: crypto.randomUUID().slice(0, 8), ts: iso(), action, reason: reason.trim().slice(0, 1000), requestedBy: by, incidentId, runId, status: "pending", decidedBy: null, decidedAt: null };
  approvals.unshift(a);
  if (approvals.length > 500) approvals.splice(500);
  await persistApprovals();
  const inc = incidentId ? incidents.find((i) => i.id === incidentId) : null;
  if (inc) {
    inc.approvalIds.push(a.id);
    inc.status = "waiting-approval";
    void persistIncidents();
  }
  publish({ source: "agent", kind: "agent", level: "warn", tags: ["maintenance", "approval"], text: `${by} asks for approval: ${action} — ${a.reason}`, meta: { agent: by, incidentId: incidentId ?? undefined } });
  addTurn("system", `Approval requested: ${action} — ${a.reason}`, runId, incidentId);
  setPhase("waiting-approval", `Waiting for approval: ${action}`);
  return a;
}

export async function decideApproval(id: string, decision: "approve" | "deny", by: string): Promise<Approval> {
  const a = approvals.find((x) => x.id === id);
  if (!a) throw new HttpError(404, "Approval not found");
  if (a.status !== "pending") throw new HttpError(409, `Already ${a.status}`);
  a.status = decision === "approve" ? "approved" : "denied";
  a.decidedBy = by;
  a.decidedAt = iso();
  await persistApprovals();
  publish({ source: "dashboard", kind: "agent", level: "info", tags: ["maintenance", "approval"], text: `${by} ${a.status} ${a.action}`, meta: { incidentId: a.incidentId ?? undefined } });
  addTurn("user", `${a.status === "approved" ? "Approved" : "Denied"}: ${a.action}`, null, a.incidentId);
  const message = a.status === "approved" ? `The owner APPROVED "${a.action}" (${a.reason}). Carry it out now — the dashboard allows it once — then finish with submit_report.` : `The owner DENIED "${a.action}". Do not do it. Propose an alternative or file a report explaining what you would have done and what they should decide.`;
  if (a.incidentId && incidents.some((i) => i.id === a.incidentId)) {
    continuations.set(a.incidentId, message);
    const inc = incidents.find((i) => i.id === a.incidentId)!;
    inc.status = "open";
    enqueue(a.incidentId);
  } else if (!approvals.some((x) => x.status === "pending")) {
    setPhase(settings.enabled ? "idle" : "off");
  }
  return a;
}

/** Spend an approval the owner granted for this exact action (or its tool prefix). */
function consumeApproval(action: string): boolean {
  expireApprovals();
  const a = approvals.find((x) => x.status === "approved" && (x.action === action || action.startsWith(`${x.action}:`) || x.action.startsWith(`${action}:`)));
  if (!a) return false;
  a.status = "consumed";
  void persistApprovals();
  return true;
}

/**
 * Route guard for risky actions. Humans (Tailscale identity) are never gated; agents
 * (dashboard key) need a granted approval when requireApproval is on. Without one, a
 * request is created for the owner and the agent gets a 409 telling it to stop.
 */
export async function gate(action: string, who: Identity, reason = "requested by the agent"): Promise<void> {
  if (!settings.requireApproval || !who.viaKey) return;
  if (consumeApproval(action)) return;
  const run = currentRun();
  const a = await requestApproval(action, reason, who.name, run?.id ?? null, current.incidentId);
  throw new HttpError(409, `Approval required for "${action}" (request ${a.id}). The owner has been asked in the Assistant panel. Stop here and end your turn — the dashboard resumes you with the decision.`);
}

export function listApprovals(all = false): Approval[] {
  expireApprovals();
  return (all ? approvals : approvals.filter((a) => a.status === "pending" || Date.now() - Date.parse(a.decidedAt ?? a.ts) < 6 * 3600_000)).slice(0, 30);
}

// ---- incidents: owner actions -------------------------------------------------------------------

function findIncident(id: string): Incident {
  const inc = incidents.find((i) => i.id === id);
  if (!inc) throw new HttpError(404, "Incident not found");
  return inc;
}

export function listIncidents(limit = 40, all = false): Incident[] {
  const sorted = [...incidents].sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.lastSeen.localeCompare(a.lastSeen));
  return (all ? sorted : sorted.filter((i) => ACTIVE.has(i.status) || Date.now() - Date.parse(i.lastSeen) < 48 * 3600_000)).slice(0, limit);
}

export function getIncident(id: string): Incident {
  return findIncident(id);
}

export function investigateIncident(id: string, by: string): Incident {
  const inc = findIncident(id);
  if (!runnerOk.ok && !cfg.demo) throw new HttpError(409, runnerOk.note ?? "The agent CLI is not available on the server");
  if (inc.status === "dismissed" || inc.status === "resolved" || inc.status === "failed") inc.status = "open";
  inc.note = `Investigation requested by ${by}`;
  void persistIncidents();
  const t = launchTimers.get(id);
  if (t) {
    clearTimeout(t);
    launchTimers.delete(id);
  }
  enqueue(id);
  return inc;
}

export function dismissIncident(id: string, by: string, note?: string): Incident {
  const inc = findIncident(id);
  inc.status = "dismissed";
  inc.note = note?.trim() || `Dismissed by ${by}`;
  const t = launchTimers.get(id);
  if (t) {
    clearTimeout(t);
    launchTimers.delete(id);
  }
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  void persistIncidents();
  pump();
  return inc;
}

export function resolveIncident(id: string, by: string, note?: string): Incident {
  const inc = findIncident(id);
  inc.status = "resolved";
  inc.note = note?.trim() || `Marked resolved by ${by}`;
  void persistIncidents();
  pump();
  return inc;
}

/** Demo only: inject an error into the feed so the whole loop can be watched. */
export function simulateIncident(kind: "exception" | "warn" | "job" = "exception"): AlertEvent {
  if (!cfg.demo) throw new HttpError(403, "Only in demo mode");
  if (kind === "job") return publish({ source: "jobs", kind: "job", level: "error", tags: ["maintenance"], text: 'Job "Semi-weekly world backup" failed: backup_world.py exited 1: tar: world/region/r.0.0.mca: file changed as we read it', meta: { job: "Semi-weekly world backup" } });
  if (kind === "warn") return publish({ source: "minecraft", kind: "log", text: "[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 4120ms or 82 ticks behind" });
  return publish({ source: "minecraft", kind: "log", text: "[Server thread/ERROR]: Exception ticking world — java.lang.NullPointerException: Cannot invoke \"net.minecraft.world.entity.Entity.tick()\" because \"entity\" is null" });
}

// ---- settings / state ------------------------------------------------------------------------------

export function getSettings(): SidecarSettings {
  return settings;
}

export async function updateSettings(patch: Partial<SidecarSettings>, by: string): Promise<SidecarSettings> {
  const before = settings;
  settings = { ...settings, ...patch };
  if (patch.runner && patch.runner !== before.runner) runnerOk = await runnerAvailable(settings.runner);
  await persistSettings();
  const changed = (Object.keys(patch) as (keyof SidecarSettings)[]).filter((k) => before[k] !== settings[k]);
  if (changed.length) publish({ source: "dashboard", kind: "log", level: "info", tags: ["maintenance"], text: `${by} changed assistant settings: ${changed.map((k) => `${k}=${String(settings[k])}`).join(", ")}` });
  if (!settings.enabled) {
    for (const t of launchTimers.values()) clearTimeout(t);
    launchTimers.clear();
    queue.splice(0);
    if (!currentRun()) setPhase("off");
  } else if (phase === "off") setPhase("idle");
  if (settings.enabled && settings.autoTrigger) for (const inc of incidents) if (inc.status === "open" && !inc.runIds.length) scheduleLaunch(inc);
  return settings;
}

function stateView(): SidecarState {
  return { phase, since: phaseSince, detail: phaseDetail, currentIncidentId: current.incidentId, currentRunId: current.runId, queue: [...queue], lastRun: listAgentRuns(1)[0] ?? null, runnerAvailable: runnerOk.ok, runnerNote: runnerOk.note };
}

export function getPayload(): SidecarPayload {
  return { settings, state: stateView(), incidents: listIncidents(), approvals: listApprovals() };
}

export async function initSidecar(): Promise<void> {
  const saved = await readJson<{ settings?: Partial<SidecarSettings>; lastSession?: Partial<Record<AgentRunner, string>> } | null>("sidecar.json", null);
  settings = { ...DEFAULTS(), ...(saved?.settings ?? {}) };
  lastSession = saved?.lastSession ?? {};
  incidents = await readJson<Incident[]>("incidents.json", []);
  approvals = await readJson<Approval[]>("approvals.json", []);
  try {
    conversation = (await fsp.readFile(file("sidecar-conversation.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .slice(-300)
      .map((l) => JSON.parse(l) as ConversationTurn);
  } catch {
    conversation = [];
  }
  // a run interrupted by a dashboard restart never finished
  for (const inc of incidents) {
    if (inc.status === "investigating") {
      inc.status = "open";
      inc.note = "The dashboard restarted during the investigation.";
    }
  }
  if (!saved) await persistSettings();
  runnerOk = await runnerAvailable(settings.runner);
  setPhase(settings.enabled ? (approvals.some((a) => a.status === "pending") ? "waiting-approval" : "idle") : "off");
  onReport((r) => {
    const inc = incidents.find((i) => i.id === (r.incidentId ?? current.incidentId));
    if (!inc) return;
    inc.reportIds.push(r.id);
    if (!r.incidentId) r.incidentId = inc.id;
    void persistIncidents();
  });
  subscribe(onEvent);
  if (settings.enabled && settings.autoTrigger) for (const inc of incidents) if (inc.status === "open" && !inc.runIds.length) scheduleLaunch(inc);
}

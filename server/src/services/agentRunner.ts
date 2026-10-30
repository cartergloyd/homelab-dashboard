// Runs a signed-in terminal coding agent (Codex CLI or Claude Code) headlessly on
// the server, on the owner's existing subscription — no API keys. Every output
// line lands in the Live Server Alerts feed; structured output (Codex `--json`,
// Claude `stream-json`) is parsed so the sidecar can keep a readable
// conversation and resume the same session next time. The sidecar
// (services/sidecar.ts) decides *when* to run; this module only knows *how*.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentRun, AgentRunKind, AgentRunner } from "../types.js";
import { publish, touchAgent } from "./alerts.js";
import { writableRoots } from "./lanes.js";
import { issueRunToken, revokeRunToken, type RunLane } from "./runTokens.js";
import { snapshotAfter, snapshotBefore } from "./snapshots.js";

// A run sees only what a CLI needs to start, never the dashboard's own environment: systemd's
// EnvironmentFile puts DASHBOARD_KEY, the RCON password, the Postgres URL and app tokens there.
const AGENT_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TMPDIR|TERM|LC_[A-Z]+|XDG_[A-Z_]+|CODEX_HOME|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY)$/;
function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => AGENT_ENV.test(key))), ...extra };
}

export const RUNNER_NAME: Record<AgentRunner, string> = { codex: "Codex", claude: "Claude Code" };

const DEFAULT_TASK = "Review recent Live server alerts, read the Minecraft instructions and context, investigate anything broken, make safe repairs inside the workspace, submit a maintenance report, and suggest or append context updates only if useful.";

const runs: AgentRun[] = [];
const execFileP = promisify(execFile);
const active = new Map<string, { controller: AbortController; child?: ChildProcess; killTimer?: NodeJS.Timeout }>();
const dashboardUrl = () => `http://${cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host}:${cfg.port}`;

export interface LaunchOptions {
  runner: AgentRunner;
  /** full prompt handed to the agent */
  prompt: string;
  /** short human description shown in lists */
  task: string;
  kind: AgentRunKind;
  incidentId?: string | null;
  /** resume this runner session (Claude session_id / Codex thread id) */
  resume?: string | null;
  cwd?: string;
  timeoutMs?: number;
  /** Locally validated screenshots to attach to the CLI prompt. */
  imagePaths?: string[];
  /** The run was started by a Discord player's message (its token's origin). */
  playerSupport?: boolean;
  /** The Discord member who sent that message (per-member limits). */
  requester?: string;
  /** What the run's token may act on and which folders it may write (default minecraft). */
  lane?: RunLane;
  /** the agent's own messages (not tool chatter), as they complete */
  onMessage?: (text: string) => void;
  /** called once, after the process ends */
  onExit?: (run: AgentRun, finalText: string) => void;
  /** demo mode: a simulated agent instead of a real CLI */
  simulate?: (emit: (line: string) => void, say: (text: string) => void, signal: AbortSignal) => Promise<number>;
}

export function listAgentRuns(limit = 20): AgentRun[] {
  return runs.slice(0, limit);
}

export function currentRun(): AgentRun | null {
  return runs.find((r) => r.status === "running") ?? null;
}

export function stopRun(id: string): boolean {
  const control = active.get(id);
  if (!control) return false;
  if (control.controller.signal.aborted) return true;
  control.controller.abort();
  if (control.child) {
    signalProcess(control.child, "SIGTERM");
    control.killTimer = setTimeout(() => signalProcess(control.child!, "SIGKILL"), 5000);
    control.killTimer.unref();
  }
  return true;
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // A CLI can start shells and MCP clients. Stop its whole process group.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

/** Is the runner's CLI installed for the dashboard's user? */
async function runnerCommand(runner: AgentRunner): Promise<string> {
  const bin = runner === "codex" ? "codex" : "claude";
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local/bin")];
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.resolve(dir, bin);
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // User services do not inherit the interactive shell's PATH.
    }
  }
  throw new Error(`${RUNNER_NAME[runner]} could not be found for the dashboard service user`);
}

export async function runnerAvailable(runner: AgentRunner): Promise<{ ok: boolean; note: string }> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return { ok: true, note: "demo: a simulated agent stands in for the CLI" };
  try {
    const command = await runnerCommand(runner);
    if (runner === "codex") {
      try {
        await execFileP(command, ["login", "status"], { timeout: 5000 });
        return { ok: true, note: "Codex is installed and signed in. The dashboard starts one job at a time and resumes its own conversation." };
      } catch {
        return { ok: false, note: "Codex is installed but is not signed in for the dashboard service user. Run codex login as that user." };
      }
    }
    return { ok: true, note: `${RUNNER_NAME[runner]} is installed; it must be signed in for the dashboard service user.` };
  } catch (e) {
    return { ok: false, note: (e as Error).message };
  }
}

/** Claude Code reads MCP servers from a config file; write one that points at this dashboard. */
async function claudeMcpConfig(runId: string, token: string): Promise<string> {
  const file = path.join(cfg.dataDir, "sidecar-mcp.json");
  const config = {
    mcpServers: {
      homelab: {
        command: "node",
        args: [path.join(cfg.repoRoot, "server", "dist", "mcp.js")],
        env: { HOMELAB_URL: dashboardUrl(), HOMELAB_KEY: token, HOMELAB_AGENT: "Dashboard Claude Code", HOMELAB_RUN_ID: runId },
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 }).catch(() => {});
  return file;
}

/** `roots` are the folders the run may write (lanes.ts): the first is the workspace, the rest are added. None means read-only. */
async function commandFor(runner: AgentRunner, prompt: string, resume: string | null | undefined, cwd: string, runId: string, token: string, imagePaths: string[] = [], roots: string[] = []): Promise<{ command: string; args: string[] }> {
  const command = await runnerCommand(runner);
  if (runner === "codex") {
    // The dashboard owns approvals for this connection; no terminal is attached.
    const mcp = `{command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(path.join(cfg.repoRoot, "server/dist/mcp.js"))}],env_vars=["HOMELAB_URL","HOMELAB_KEY","HOMELAB_AGENT","HOMELAB_RUN_ID"],required=true,default_tools_approval_mode="approve"}`;
    const args = ["exec", "--sandbox", roots.length ? "workspace-write" : "read-only", "-C", cwd, ...roots.slice(1).flatMap((dir) => ["--add-dir", dir]),
      "-c", "mcp_servers.homelab.enabled=false", "-c", `mcp_servers.dashboard=${mcp}`];
    if (cfg.codexModel) args.push("--model", cfg.codexModel);
    // Sandbox flags belong to exec, before resume. Pass the prompt over stdin.
    args.push(...(resume ? ["resume", "--json", "--skip-git-repo-check", resume, "-"] : ["--json", "--skip-git-repo-check", "-"]));
    // Resume has its own --image option. Images must precede the session/prompt arguments.
    if (imagePaths.length) {
      const position = args.indexOf("--json");
      args.splice(position, 0, ...imagePaths.flatMap(file => ["--image", file]));
    }
    return { command, args };
  }
  const mcp = await claudeMcpConfig(runId, token);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--mcp-config", mcp];
  if (resume) args.push("--resume", resume);
  args.push(prompt);
  return { command, args };
}

/**
 * Parse one line of runner output. Returns the agent-visible message (if the
 * line completes one), a session id (if announced), and whether the line was
 * structured (so the raw JSON is not echoed to the feed).
 */
function errorText(value: unknown): string | undefined {
  if (typeof value === "string") {
    try { return errorText(JSON.parse(value)) ?? value; } catch { return value; }
  }
  if (value && typeof value === "object") {
    const v = value as { message?: unknown; error?: unknown };
    return errorText(v.error) ?? errorText(v.message);
  }
  return undefined;
}

function parseLine(runner: AgentRunner, line: string): { message?: string; session?: string; toolCall?: string; structured: boolean; final?: string; error?: string } {
  if (!line.startsWith("{")) return { structured: false };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { structured: false };
  }
  if (runner === "claude") {
    const type = j.type as string;
    if (type === "system" && typeof j.session_id === "string") return { session: j.session_id, structured: true };
    if (type === "assistant") {
      const content = ((j.message as { content?: { type: string; text?: string; name?: string; input?: unknown }[] })?.content ?? []);
      const texts = content.filter((c) => c.type === "text" && c.text).map((c) => c.text!.trim());
      const tools = content.filter((c) => c.type === "tool_use").map((c) => `${c.name}(${JSON.stringify(c.input ?? {}).slice(0, 160)})`);
      return { message: texts.join("\n") || undefined, toolCall: tools.join("; ") || undefined, structured: true, session: typeof j.session_id === "string" ? j.session_id : undefined };
    }
    if (type === "result") return { final: typeof j.result === "string" ? j.result : undefined, error: j.is_error ? errorText(j.result) ?? "Claude Code failed" : undefined, session: typeof j.session_id === "string" ? j.session_id : undefined, structured: true };
    return { structured: true };
  }
  // codex --json (JSONL)
  const type = j.type as string;
  if (type === "thread.started" && typeof j.thread_id === "string") return { session: j.thread_id, structured: true };
  if (type === "item.completed") {
    const item = j.item as { type?: string; text?: string; command?: string; name?: string; tool?: string; arguments?: unknown } | undefined;
    if (item?.type === "agent_message" && item.text) return { message: item.text.trim(), structured: true };
    if (item?.type === "command_execution" && item.command) return { toolCall: `$ ${item.command}`.slice(0, 200), structured: true };
    if (item?.type === "mcp_tool_call" && (item.tool || item.name)) return { toolCall: `${item.tool ?? item.name}(${JSON.stringify(item.arguments ?? {}).slice(0, 160)})`, structured: true };
    return { structured: true };
  }
  if (type === "error" || type === "turn.failed") return { error: errorText(j.error) ?? errorText(j.message) ?? "Codex could not complete this turn", structured: true };
  return { structured: true };
}

export function launchRun(opts: LaunchOptions): AgentRun {
  if (!["codex", "claude"].includes(opts.runner)) throw new HttpError(400, "Unknown agent runner");
  const running = currentRun();
  if (running) throw new HttpError(409, `${RUNNER_NAME[running.runner]} is already running (${running.task.slice(0, 80)})`);

  const lane = opts.lane ?? "minecraft";
  const roots = writableRoots(lane);
  const cwd = roots[0] ?? opts.cwd ?? cfg.minecraft.dir;
  const run: AgentRun = {
    id: crypto.randomUUID(),
    runner: opts.runner,
    task: opts.task.trim() || DEFAULT_TASK,
    cwd,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    status: "running",
    lines: 0,
    kind: opts.kind,
    incidentId: opts.incidentId ?? null,
    sessionId: opts.resume ?? null,
    pid: null,
    error: null,
  };
  runs.unshift(run);
  if (runs.length > 50) runs.splice(50);
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  // valid until the run ends (finish revokes it) or a minute past its run limit
  const token = issueRunToken({ runId: run.id, lane, origin: opts.playerSupport ? "discord" : "dashboard", requester: opts.requester }, timeoutMs + 60_000);

  const name = `Dashboard ${RUNNER_NAME[opts.runner]}`;
  const meta = { agent: name, runId: run.id, ...(run.incidentId ? { incidentId: run.incidentId } : {}) };
  const messages: string[] = [];
  let finalText: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let snapshotted = false;
  const control: { controller: AbortController; child?: ChildProcess; killTimer?: NodeJS.Timeout } = { controller: new AbortController() };
  active.set(run.id, control);
  const stderrTail: string[] = [];

  publish({ source: "agent", kind: "agent", level: "info", tags: ["maintenance"], text: `${name}: ${opts.kind === "manual" ? "launched from dashboard" : opts.kind === "chat" ? "answering the owner" : opts.kind === "continuation" ? "resuming" : "investigating an incident"}${opts.resume ? " (same session)" : ""}`, meta });
  touchAgent(name, `${opts.kind}: ${run.task.slice(0, 120)}`);

  const emit = (line: string) => {
    if (run.finishedAt) return;
    run.lines++;
    publish({ source: "agent", kind: "agent", text: `${name}: ${line}`, meta });
  };
  const say = (text: string) => {
    if (run.finishedAt) return;
    messages.push(text);
    opts.onMessage?.(text);
    for (const l of text.split("\n").slice(0, 12)) if (l.trim()) emit(l.trim().slice(0, 400));
  };
  const finish = (code: number | null, startError?: string) => {
    if (run.finishedAt) return;
    run.finishedAt = new Date().toISOString();
    run.exitCode = code;
    if (timer) clearTimeout(timer);
    run.status = control.controller.signal.aborted ? "cancelled" : startError || code !== 0 || run.error ? "failed" : "exited";
    run.error = run.status === "cancelled" ? null : startError ?? run.error ?? (code !== 0 ? stderrTail.slice(-3).join("\n") || `Agent exited ${code ?? "without an exit code"}` : null);
    active.delete(run.id);
    revokeRunToken(run.id);
    if (snapshotted) {
      void snapshotAfter(run.id).then((files) => {
        if (files.length) publish({ source: "agent", kind: "agent", level: "warn", tags: ["maintenance", "files"], text: `${name} changed ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ", …" : ""}. Undo with rollback_run ${run.id}.`, meta: { ...meta, files } });
      }, (e) => publish({ source: "agent", kind: "agent", level: "error", text: `${name}: could not record its file changes: ${(e as Error).message}`, meta }));
    }
    publish({
      source: "agent",
      kind: "agent",
      level: run.status === "cancelled" || run.status === "exited" ? "info" : "error",
      tags: ["maintenance"],
      text: run.status === "cancelled" ? `${name}: stopped` : run.error ? `${name}: ${run.error}` : `${name}: exited ${code ?? "unknown"}`,
      meta: { ...meta, exitCode: code },
    });
    touchAgent(name, startError ? `failed to start: ${startError}` : `finished (${opts.kind}) with exit ${code ?? "unknown"}`);
    const text = run.status === "cancelled" ? "Stopped by the owner." : run.error ? `Could not complete this run: ${run.error}` : (finalText ?? messages.join("\n\n")).trim() || "The agent finished without a message.";
    opts.onExit?.(run, text);
  };

  if (opts.simulate) {
    const sim = opts.simulate(emit, say, control.controller.signal);
    sim.then(
      (code) => finish(code),
      (e) => finish(1, (e as Error).message),
    );
    return run;
  }

  void (async () => {
    const { command, args } = await commandFor(opts.runner, opts.prompt, opts.resume, cwd, run.id, token, opts.imagePaths, roots);
    if (roots.length) {
      try {
        await snapshotBefore(run.id, roots);
        snapshotted = true;
      } catch (e) {
        emit(`(could not snapshot the writable folders; changes will not be listed: ${(e as Error).message.slice(0, 200)})`);
      }
    }
    if (control.controller.signal.aborted) {
      finish(null);
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env: agentEnv({ HOMELAB_URL: dashboardUrl(), HOMELAB_KEY: token, HOMELAB_AGENT: name, HOMELAB_RUN_ID: run.id }),
        detached: process.platform !== "win32",
        stdio: [opts.runner === "codex" ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish(null, (e as Error).message);
      return;
    }
    control.child = child;
    run.pid = child.pid ?? null;
    child.stdin?.on("error", () => {});
    if (opts.runner === "codex") child.stdin?.end(opts.prompt);
    timer = setTimeout(() => {
      emit(`(stopped after ${Math.round(timeoutMs / 60_000)} min — maxRunMinutes)`);
      run.error = `Stopped after ${Math.round(timeoutMs / 60_000)} minutes (run limit)`;
      signalProcess(child, "SIGTERM");
      control.killTimer = setTimeout(() => signalProcess(child, "SIGKILL"), 5000);
      control.killTimer.unref();
    }, timeoutMs);

    const onLine = (line: string, stderr: boolean) => {
      if (!line.trim()) return;
      const p: ReturnType<typeof parseLine> = stderr ? { structured: false } : parseLine(opts.runner, line);
      if (p.session) run.sessionId = p.session;
      if (stderr) {
        stderrTail.push(line.slice(0, 400));
        if (stderrTail.length > 5) stderrTail.shift();
      }
      if (!p.structured) {
        emit(line.slice(0, 400));
        if (!stderr) messages.push(line);
        return;
      }
      if (p.toolCall) emit(`→ ${p.toolCall}`);
      if (p.error) {
        run.error = p.error;
        emit(`Error: ${p.error}`);
      }
      if (p.message) say(p.message);
      if (p.final !== undefined) finalText = p.final;
    };
    if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (l) => onLine(l, false));
    if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", (l) => onLine(l, true));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      finish(null, e.message);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish(code);
    });
  })().catch((e) => finish(null, (e as Error).message));

  return run;
}

/** The original "Launch an agent" button: a one-off manual run. */
export async function launchAgent(runner: AgentRunner, task: string): Promise<AgentRun> {
  const { launchManual } = await import("./sidecar.js");
  return launchManual(runner, task);
}

// Runs a signed-in terminal coding agent (Codex CLI or Claude Code) headlessly on
// the server, on the owner's existing subscription — no API keys. Every output
// line lands in the Live Server Alerts feed; structured output (Codex `--json`,
// Claude `stream-json`) is parsed so the sidecar can keep a readable
// conversation and resume the same session next time. The sidecar
// (services/sidecar.ts) decides *when* to run; this module only knows *how*.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentRun, AgentRunKind, AgentRunner } from "../types.js";
import { publish, touchAgent } from "./alerts.js";

export const RUNNER_NAME: Record<AgentRunner, string> = { codex: "Codex", claude: "Claude Code" };

const DEFAULT_TASK = "Review recent Live server alerts, read the Minecraft instructions and context, investigate anything broken, make safe repairs inside the workspace, submit a maintenance report, and suggest or append context updates only if useful.";

const runs: AgentRun[] = [];
const active = new Map<string, ChildProcess>();

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
  /** the agent's own messages (not tool chatter), as they complete */
  onMessage?: (text: string) => void;
  /** called once, after the process ends */
  onExit?: (run: AgentRun, finalText: string) => void;
  /** demo mode: a simulated agent instead of a real CLI */
  simulate?: (emit: (line: string) => void, say: (text: string) => void) => Promise<number>;
}

export function listAgentRuns(limit = 20): AgentRun[] {
  return runs.slice(0, limit);
}

export function currentRun(): AgentRun | null {
  return runs.find((r) => r.status === "running") ?? null;
}

export function stopRun(id: string): boolean {
  const child = active.get(id);
  if (!child) return false;
  child.kill("SIGTERM");
  setTimeout(() => !child.killed && child.kill("SIGKILL"), 5000).unref();
  return true;
}

/** Is the runner's CLI installed for the dashboard's user? */
export async function runnerAvailable(runner: AgentRunner): Promise<{ ok: boolean; note: string }> {
  if (cfg.demo) return { ok: true, note: "demo: a simulated agent stands in for the CLI" };
  const bin = runner === "codex" ? "codex" : "claude";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      await fs.access(path.join(dir, bin));
      return { ok: true, note: `${bin} found at ${path.join(dir, bin)}; it must be logged in for the user the dashboard runs as` };
    } catch {
      // next
    }
  }
  return { ok: false, note: `${bin} is not on the dashboard's PATH (${process.env.PATH ?? ""}). Install it and log in as the service user, or add its folder to Environment=PATH=… in the unit.` };
}

/** Claude Code reads MCP servers from a config file; write one that points at this dashboard. */
async function claudeMcpConfig(): Promise<string> {
  const file = path.join(cfg.dataDir, "sidecar-mcp.json");
  const config = {
    mcpServers: {
      homelab: {
        command: "node",
        args: [path.join(cfg.repoRoot, "server", "dist", "mcp.js")],
        env: { HOMELAB_URL: `http://${cfg.host}:${cfg.port}`, HOMELAB_KEY: cfg.dashboardKey ?? "", HOMELAB_AGENT: "Claude Code" },
      },
    },
  };
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 }).catch(() => {});
  return file;
}

async function commandFor(runner: AgentRunner, prompt: string, resume: string | null | undefined, cwd: string): Promise<{ command: string; args: string[] }> {
  if (runner === "codex") {
    // `codex exec --json` streams JSONL events (thread.started, item.completed …). Resume
    // continues the same thread so the conversation stays coherent.
    // [INSTALLER] verify on the server: `codex exec --help` / `codex exec resume --help` for
    // the installed version; older builds lack --json or resume (plain text still works).
    return resume
      ? { command: "codex", args: ["exec", "resume", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", resume, prompt] }
      : { command: "codex", args: ["exec", "--json", "-C", cwd, "--sandbox", "workspace-write", "--skip-git-repo-check", prompt] };
  }
  const mcp = await claudeMcpConfig();
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--mcp-config", mcp];
  if (resume) args.push("--resume", resume);
  args.push(prompt);
  return { command: "claude", args };
}

/**
 * Parse one line of runner output. Returns the agent-visible message (if the
 * line completes one), a session id (if announced), and whether the line was
 * structured (so the raw JSON is not echoed to the feed).
 */
function parseLine(runner: AgentRunner, line: string): { message?: string; session?: string; toolCall?: string; structured: boolean; final?: string } {
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
    if (type === "result") return { final: typeof j.result === "string" ? j.result : undefined, session: typeof j.session_id === "string" ? j.session_id : undefined, structured: true };
    return { structured: true };
  }
  // codex --json (JSONL)
  const type = j.type as string;
  if (type === "thread.started" && typeof j.thread_id === "string") return { session: j.thread_id, structured: true };
  if (type === "item.completed") {
    const item = j.item as { type?: string; text?: string; command?: string; name?: string; arguments?: unknown } | undefined;
    if (item?.type === "agent_message" && item.text) return { message: item.text.trim(), structured: true };
    if (item?.type === "command_execution" && item.command) return { toolCall: `$ ${item.command}`.slice(0, 200), structured: true };
    if (item?.type === "mcp_tool_call" && item.name) return { toolCall: `${item.name}(${JSON.stringify(item.arguments ?? {}).slice(0, 160)})`, structured: true };
    return { structured: true };
  }
  if (type === "error" && typeof j.message === "string") return { message: `Error: ${j.message}`, structured: true };
  return { structured: true };
}

export function launchRun(opts: LaunchOptions): AgentRun {
  if (!["codex", "claude"].includes(opts.runner)) throw new HttpError(400, "Unknown agent runner");
  const running = currentRun();
  if (running) throw new HttpError(409, `${RUNNER_NAME[running.runner]} is already running (${running.task.slice(0, 80)})`);

  const cwd = opts.cwd ?? cfg.minecraft.dir;
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
  };
  runs.unshift(run);
  if (runs.length > 50) runs.splice(50);

  const name = RUNNER_NAME[opts.runner];
  const meta = { agent: name, runId: run.id, ...(run.incidentId ? { incidentId: run.incidentId } : {}) };
  const messages: string[] = [];
  let finalText: string | null = null;

  publish({ source: "agent", kind: "agent", level: "info", tags: ["maintenance"], text: `${name}: ${opts.kind === "manual" ? "launched from dashboard" : opts.kind === "chat" ? "answering the owner" : opts.kind === "continuation" ? "resuming" : "investigating an incident"}${opts.resume ? " (same session)" : ""}`, meta });
  touchAgent(name, `${opts.kind}: ${run.task.slice(0, 120)}`);

  const emit = (line: string) => {
    run.lines++;
    publish({ source: "agent", kind: "agent", text: `${name}: ${line}`, meta });
  };
  const say = (text: string) => {
    messages.push(text);
    opts.onMessage?.(text);
    for (const l of text.split("\n").slice(0, 12)) if (l.trim()) emit(l.trim().slice(0, 400));
  };
  const finish = (code: number | null, startError?: string) => {
    if (run.finishedAt) return;
    run.finishedAt = new Date().toISOString();
    run.exitCode = code;
    run.status = startError ? "failed" : "exited";
    active.delete(run.id);
    publish({
      source: "agent",
      kind: "agent",
      level: code === 0 ? "info" : "error",
      tags: ["maintenance"],
      text: startError ? `${name}: could not start: ${startError}` : `${name}: exited ${code ?? "unknown"}`,
      meta: { ...meta, exitCode: code },
    });
    touchAgent(name, startError ? `failed to start: ${startError}` : `finished (${opts.kind}) with exit ${code ?? "unknown"}`);
    const text = (finalText ?? messages.join("\n\n")).trim() || (startError ? `Could not start ${name}: ${startError}` : code === 0 ? "(the agent finished without a message)" : `(exited ${code ?? "unknown"} without a message)`);
    opts.onExit?.(run, text);
  };

  if (opts.simulate) {
    const sim = opts.simulate(emit, say);
    sim.then(
      (code) => finish(code),
      (e) => finish(1, (e as Error).message),
    );
    return run;
  }

  let timer: NodeJS.Timeout | null = null;
  void (async () => {
    const { command, args } = await commandFor(opts.runner, opts.prompt, opts.resume, cwd);
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, HOMELAB_URL: `http://${cfg.host}:${cfg.port}`, HOMELAB_KEY: cfg.dashboardKey ?? "", HOMELAB_AGENT: name },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish(null, (e as Error).message);
      return;
    }
    active.set(run.id, child);
    const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    timer = setTimeout(() => {
      emit(`(stopped after ${Math.round(timeoutMs / 60_000)} min — maxRunMinutes)`);
      child.kill("SIGTERM");
      setTimeout(() => !child.killed && child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    const onLine = (line: string, stderr: boolean) => {
      if (!line.trim()) return;
      const p = stderr ? { structured: false as const } : parseLine(opts.runner, line);
      if (p.session && !run.sessionId) run.sessionId = p.session;
      if (!p.structured) {
        emit(line.slice(0, 400));
        if (!stderr) messages.push(line);
        return;
      }
      if (p.toolCall) emit(`→ ${p.toolCall}`);
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
  })();

  return run;
}

/** The original "Launch an agent" button: a one-off manual run. */
export async function launchAgent(runner: AgentRunner, task: string): Promise<AgentRun> {
  const { launchManual } = await import("./sidecar.js");
  return launchManual(runner, task);
}

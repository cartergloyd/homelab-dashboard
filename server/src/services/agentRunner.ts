import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentRun, AgentRunner } from "../types.js";
import { publish, touchAgent } from "./alerts.js";

const MINECRAFT_DIR = cfg.minecraft.dir;
const DEFAULT_TASK =
  "Review recent Live server alerts, read the Minecraft instructions and context, investigate anything broken, make safe repairs inside /home/gold/Minecraft Server, submit a maintenance report, and suggest or append context updates only if useful.";

const runs: AgentRun[] = [];
const active = new Map<string, ChildProcess>();

function promptFor(task: string): string {
  return [
    "You are the Minecraft server maintenance agent launched from the homelab dashboard.",
    "Use the homelab MCP tools first: read_instructions, get_alerts, server_status, and any focused logs/status tools needed.",
    "Your working directory and file edits must stay scoped to /home/gold/Minecraft Server unless the user explicitly asked otherwise.",
    "If a fix is safe and clear, make it. If it is risky, file a report instead of guessing.",
    "Before finishing, call submit_report with what you saw, what you did, when/why, and any follow-up.",
    "",
    `User task: ${task.trim() || DEFAULT_TASK}`,
  ].join("\n");
}

function commandFor(runner: AgentRunner, prompt: string): { command: string; args: string[] } {
  if (runner === "codex") {
    return {
      command: "codex",
      args: ["exec", "-C", MINECRAFT_DIR, "--sandbox", "workspace-write", "--skip-git-repo-check", prompt],
    };
  }
  return {
    command: "claude",
    args: ["-p", "--permission-mode", "acceptEdits", "--mcp-config", `${MINECRAFT_DIR}/.mcp.json`, prompt],
  };
}

export function listAgentRuns(limit = 20): AgentRun[] {
  return runs.slice(0, limit);
}

export async function launchAgent(runner: AgentRunner, task: string): Promise<AgentRun> {
  if (!["codex", "claude"].includes(runner)) throw new HttpError(400, "Unknown agent runner");
  const running = runs.find((r) => r.status === "running");
  if (running) throw new HttpError(409, `${running.runner} agent is already running`);

  const run: AgentRun = {
    id: crypto.randomUUID(),
    runner,
    task: task.trim() || DEFAULT_TASK,
    cwd: MINECRAFT_DIR,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    status: "running",
    lines: 0,
  };
  runs.unshift(run);
  if (runs.length > 50) runs.splice(50);

  const prompt = promptFor(run.task);
  const { command, args } = commandFor(runner, prompt);
  const name = runner === "codex" ? "Codex" : "Claude Code";
  const meta = { agent: name, runId: run.id };

  publish({ source: "agent", kind: "agent", level: "info", tags: ["maintenance"], text: `${name}: launched from dashboard`, meta });
  touchAgent(name, `started dashboard task: ${run.task.slice(0, 120)}`);

  const child = spawn(command, args, {
    cwd: MINECRAFT_DIR,
    env: {
      ...process.env,
      HOMELAB_URL: `http://127.0.0.1:${cfg.port}`,
      HOMELAB_KEY: cfg.dashboardKey ?? "",
      HOMELAB_AGENT: name,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  active.set(run.id, child);

  const onLine = (line: string) => {
    run.lines++;
    publish({ source: "agent", kind: "agent", text: `${name}: ${line}`, meta });
  };
  if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", onLine);
  if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", onLine);

  child.on("error", (e) => {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    active.delete(run.id);
    publish({ source: "agent", kind: "agent", level: "error", tags: ["maintenance"], text: `${name}: could not start: ${e.message}`, meta });
    touchAgent(name, `failed to start: ${e.message}`);
  });

  child.on("close", (code) => {
    if (run.finishedAt) return;
    run.status = "exited";
    run.finishedAt = new Date().toISOString();
    run.exitCode = code;
    active.delete(run.id);
    publish({
      source: "agent",
      kind: "agent",
      level: code === 0 ? "info" : "error",
      tags: ["maintenance"],
      text: `${name}: exited ${code ?? "unknown"}`,
      meta: { ...meta, exitCode: code },
    });
    touchAgent(name, `finished dashboard task with exit ${code ?? "unknown"}`);
  });

  return run;
}

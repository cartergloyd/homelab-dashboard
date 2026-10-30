// Tells the owner in Discord what the assistant did, what it was refused and what needs them
// (step 4 of the assistant redesign). Discord only announces; anything to decide stays in the
// dashboard. Posts are rate-limited (held ones are summarized later), deduplicated, never carry a
// secret and never mention anyone. Off unless OWNER_DISCORD_CHANNEL_ID is set.
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { cfg } from "../config.js";
import type { AgentReport, AlertEvent } from "../types.js";
import { publish, subscribe } from "./alerts.js";
import { onReport } from "./reports.js";
import { secretIn } from "./secretFilter.js";

const PER_HOUR = 6;
const DEDUPE_MS = 10 * 60_000;
const MAX_LENGTH = 1900;

export interface NotifierDeps {
  send: (text: string, replyTo?: string) => Promise<void>;
  now?: () => number;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: cfg.timezone });

export class Notifier {
  private sent: number[] = [];
  private recent = new Map<string, number>();
  private held = 0;
  private heldSince: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private deps: NotifierDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Posts now, or holds the update when the hourly limit is reached. Returns whether it was posted. */
  async notify(text: string, replyTo?: string): Promise<boolean> {
    const now = this.now();
    for (const [key, at] of this.recent) if (now - at > DEDUPE_MS) this.recent.delete(key);
    if (this.recent.has(text)) return false;
    this.recent.set(text, now);
    this.sent = this.sent.filter((t) => now - t < 3600_000);
    if (this.sent.length >= PER_HOUR) {
      this.held++;
      this.heldSince ??= now;
      this.scheduleFlush();
      return false;
    }
    this.sent.push(now);
    const leaked = secretIn(text);
    let body = leaked ? `An assistant update was withheld because it contained ${leaked}. See the dashboard.` : text;
    if (this.held) body += `\n_(+${this.held} more update${this.held === 1 ? "" : "s"} in the dashboard since ${clock(this.heldSince!)})_`;
    this.held = 0;
    this.heldSince = null;
    await this.deps.send(body.length > MAX_LENGTH ? `${body.slice(0, MAX_LENGTH - 1)}…` : body, replyTo);
    return true;
  }

  /** Posts a one-line summary of held updates once there is room again. */
  async flushHeld(): Promise<boolean> {
    if (!this.held) return false;
    const count = this.held;
    const since = this.heldSince!;
    this.held = 0;
    this.heldSince = null;
    return this.notify(`${count} more assistant update${count === 1 ? "" : "s"} since ${clock(since)} — see the dashboard.`);
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    const wait = Math.max(1000, this.sent[0] + 3600_000 - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushHeld();
    }, wait);
    this.timer.unref();
  }
}

const link = () => (cfg.ownerDiscord.dashboardUrl ? `\n<${cfg.ownerDiscord.dashboardUrl}>` : "");

/** The feed events the owner hears about: file changes, refusals, blocked secrets and failed runs. */
export function messageForEvent(e: AlertEvent): string | null {
  if (e.tags.includes("files") && e.meta?.files?.length) return `🛠️ ${e.text}`;
  if (e.tags.includes("refused")) return `🚫 ${e.text}`;
  if (e.tags.includes("security") && /^Blocked /.test(e.text)) return `🛑 ${e.text}`;
  if (e.source === "agent" && e.level === "error" && e.meta?.runId && e.meta.exitCode !== undefined) return `⚠️ The assistant could not finish a run. ${e.text}`;
  return null;
}

/** Reports the owner hears about: what was fixed, and what needs them. "No action" reports stay in the dashboard. */
export function messageForReport(r: AgentReport): string | null {
  const summary = r.body.split("\n").map((l) => l.replace(/^summary:\s*/i, "").trim()).find(Boolean)?.slice(0, 300) ?? "";
  const detail = summary && summary !== r.title ? `\n${summary}` : "";
  if (r.outcome === "fixed") return `✅ Fixed by the assistant: **${r.title}**${detail}`;
  if (r.outcome === "needs-human") return `🙋 Needs you: **${r.title}**${detail}${link()}`;
  return null;
}

async function discordSender(): Promise<NotifierDeps["send"] | null> {
  const { channelId, tokenFile } = cfg.ownerDiscord;
  if (!channelId || !tokenFile) return null;
  const token = parseEnv(await fs.readFile(tokenFile, "utf8")).DISCORD_BOT_TOKEN;
  if (!token) throw new Error(`no DISCORD_BOT_TOKEN in ${tokenFile}`);
  return async (content, replyTo) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] }, ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 && attempt === 0) {
        const retry = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 2);
        await delay(Math.min(10_000, retry * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Discord answered ${res.status}`);
      return;
    }
  };
}

let notifier: Notifier | null = null;

export async function startNotifications(): Promise<void> {
  let send: NotifierDeps["send"] | null;
  try {
    send = await discordSender();
  } catch (e) {
    publish({ source: "dashboard", kind: "log", level: "warn", text: `Assistant updates to Discord are off: ${(e as Error).message}` });
    return;
  }
  if (!send) return;
  const post = send;
  notifier = new Notifier({
    send: async (text, replyTo) => {
      try {
        await post(text, replyTo);
      } catch (e) {
        publish({ source: "dashboard", kind: "log", level: "warn", text: `Could not post an assistant update to Discord: ${(e as Error).message}` });
      }
    },
  });
  subscribe((e) => {
    const message = messageForEvent(e);
    if (message) void notifier?.notify(message);
  });
  onReport((r) => {
    const message = messageForReport(r);
    if (message) void notifier?.notify(message);
  });
  publish({ source: "dashboard", kind: "log", level: "info", text: `Assistant updates go to the owner's Discord channel ${cfg.ownerDiscord.channelId}` });
}

/** Tell the owner directly (incidents opened by the dispatcher). A reply when replyTo names a Discord message. */
export function notifyOwner(text: string, replyTo?: string): void {
  void notifier?.notify(text, replyTo);
}

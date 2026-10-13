// Live Server Alerts hub. One persistent tail per log source, every line
// classified (error / warn / maintenance / noise), merged with job, script and
// agent events, kept in a ring buffer + data/alerts.jsonl, and fanned out to
// WebSocket subscribers. The MCP server and the Assistant widget read from here.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import type { AgentPresence, AlertEvent, AlertKind, AlertLevel, AlertSource, AlertSummary, LogSource } from "../types.js";
import { openLogStream } from "./logs.js";

const MAX_EVENTS = 5000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 4000;

// ---- classification --------------------------------------------------------

export interface RuleSet {
  error: string[];
  warn: string[];
  maintenance: string[];
}

// [INSTALLER] PLACEHOLDER rule set, written against demo log lines. It is copied
// to data/alert-rules.json on first start and tuned THERE (hot-reloaded) — not
// here. After a day of real logs, review what the "Problems & maintenance" filter
// shows and move noisy patterns out / missing failure phrases in. Plugin-specific
// errors (Paper plugins, Jellyfin transcoder) are not covered yet.
export const DEFAULT_RULES: RuleSet = {
  error: [
    "\\bERROR\\b",
    "\\bSEVERE\\b",
    "\\bFATAL\\b",
    "Exception",
    "Traceback",
    "\\bfail(?:ed|ure)\\b",
    "\\brefused\\b",
    "timed? ?out",
    "unreachable",
    "crash(?:ed)?",
    "\\bkilled\\b",
    "out of memory",
    "\\bOOM\\b",
    "exit(?:ed)?(?: with)?(?: code)? [1-9]\\d*",
    "not responding",
    "stack trace",
    "segfault",
    "\\bpanic\\b",
  ],
  warn: ["\\bWARN(?:ING)?\\b", "\\bretry(?:ing)?\\b", "overloaded", "can't keep up", "\\bbehind\\b", "deprecated", "low disk", "disk (?:is )?(?:almost )?full", "\\blag(?:ging)?\\b"],
  maintenance: [
    "\\brestart(?:ing|ed)?\\b",
    "stopping(?: the)? server",
    "starting minecraft server",
    "\\bserver started\\b",
    "saved the game",
    "save-off",
    "save-on",
    "automatic saving",
    "\\bback(?:ing)? ?up\\b",
    "\\bpruned\\b",
    "closing server",
    "done \\(\\d",
    "\\bscheduled\\b",
    "maintenance",
    "shutting down",
    "preparing spawn",
    "loading libraries",
  ],
};

let rawRules: RuleSet = DEFAULT_RULES;
let rules = compile(DEFAULT_RULES);

function compile(r: RuleSet) {
  const re = (parts: string[]) => (parts.length ? new RegExp(parts.join("|"), "i") : /$^/);
  return { error: re(r.error), warn: re(r.warn), maintenance: re(r.maintenance) };
}

const rulesFile = () => path.join(cfg.dataDir, "alert-rules.json");

async function loadRules(): Promise<void> {
  try {
    const parsed = JSON.parse(await fsp.readFile(rulesFile(), "utf8")) as Partial<RuleSet>;
    rawRules = { ...DEFAULT_RULES, ...parsed };
  } catch {
    rawRules = DEFAULT_RULES;
    await fsp.writeFile(rulesFile(), JSON.stringify(DEFAULT_RULES, null, 2)).catch(() => {});
  }
  try {
    rules = compile(rawRules);
  } catch (e) {
    console.warn(`[alerts] bad rule in ${rulesFile()}: ${(e as Error).message}; using defaults`);
    rawRules = DEFAULT_RULES;
    rules = compile(DEFAULT_RULES);
  }
}

export function getRules(): RuleSet {
  return rawRules;
}

export function classify(text: string): { level: AlertLevel; tags: string[] } {
  return {
    level: rules.error.test(text) ? "error" : rules.warn.test(text) ? "warn" : "info",
    tags: rules.maintenance.test(text) ? ["maintenance"] : [],
  };
}

/** The "Problems & maintenance" filter: anything that isn't routine log noise. */
export function isProblem(e: AlertEvent): boolean {
  return e.level !== "info" || e.tags.includes("maintenance") || e.kind !== "log";
}

// ---- store -----------------------------------------------------------------

const events: AlertEvent[] = [];
const subscribers = new Set<(e: AlertEvent) => void>();
const rawSubs = new Map<AlertSource, Set<(line: string) => void>>();

let pendingWrite: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const eventsFile = () => path.join(cfg.dataDir, "alerts.jsonl");

async function flush(): Promise<void> {
  flushTimer = null;
  const lines = pendingWrite;
  pendingWrite = [];
  if (!lines.length) return;
  try {
    await fsp.appendFile(eventsFile(), `${lines.join("\n")}\n`);
    const st = await fsp.stat(eventsFile());
    if (st.size > MAX_FILE_BYTES) await fsp.rename(eventsFile(), `${eventsFile()}.1`);
  } catch (e) {
    console.warn(`[alerts] could not persist events: ${(e as Error).message}`);
  }
}

async function loadRecent(): Promise<void> {
  try {
    const text = await fsp.readFile(eventsFile(), "utf8");
    const lines = text.split("\n").filter(Boolean).slice(-1000);
    for (const l of lines) {
      try {
        events.push(JSON.parse(l) as AlertEvent);
      } catch {
        // skip torn line
      }
    }
  } catch {
    // no history yet
  }
}

export interface PublishInput {
  source: AlertSource;
  kind?: AlertKind;
  level?: AlertLevel;
  tags?: string[];
  text: string;
  meta?: AlertEvent["meta"];
}

export function publish(input: PublishInput): AlertEvent {
  const text = input.text.length > MAX_TEXT ? `${input.text.slice(0, MAX_TEXT)}…` : input.text;
  const c = classify(text);
  const e: AlertEvent = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    source: input.source,
    kind: input.kind ?? "log",
    level: input.level ?? c.level,
    tags: [...new Set([...(input.tags ?? []), ...c.tags])],
    text,
    meta: input.meta,
  };
  events.push(e);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  pendingWrite.push(JSON.stringify(e));
  flushTimer ??= setTimeout(() => void flush(), 1000);
  for (const fn of subscribers) {
    try {
      fn(e);
    } catch {
      // a bad subscriber must not break the hub
    }
  }
  return e;
}

export function subscribe(fn: (e: AlertEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Resolves with the first event matching `predicate`, or null after `timeoutMs`. */
export function waitForEvent(predicate: (e: AlertEvent) => boolean, timeoutMs: number): Promise<AlertEvent | null> {
  return new Promise((resolve) => {
    const unsub = subscribe((e) => {
      if (!predicate(e)) return;
      clearTimeout(timer);
      unsub();
      resolve(e);
    });
    const timer = setTimeout(() => {
      unsub();
      resolve(null);
    }, timeoutMs);
  });
}

/** Raw lines of one source, as they arrive — used by the plain log viewer. */
export function subscribeRaw(source: AlertSource, fn: (line: string) => void): () => void {
  const set = rawSubs.get(source) ?? new Set();
  set.add(fn);
  rawSubs.set(source, set);
  return () => set.delete(fn);
}

export interface QueryOptions {
  sources?: AlertSource[];
  problemsOnly?: boolean;
  since?: string;
  limit?: number;
}

export function query(opts: QueryOptions = {}): AlertEvent[] {
  let list: AlertEvent[] = events;
  if (opts.sources?.length) {
    const set = new Set(opts.sources);
    list = list.filter((e) => set.has(e.source));
  }
  if (opts.problemsOnly) list = list.filter(isProblem);
  if (opts.since) list = list.filter((e) => e.ts > opts.since!);
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), MAX_EVENTS);
  return list.slice(-limit);
}

export function recentLines(source: AlertSource, n = 200): string[] {
  return events
    .filter((e) => e.source === source && e.kind === "log")
    .slice(-n)
    .map((e) => e.text);
}

export function summary(): AlertSummary {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  let errorsLastHour = 0;
  let warnsLastHour = 0;
  let maintenanceLastHour = 0;
  let lastMaintenance: AlertEvent | null = null;
  let lastAgent: AlertEvent | null = null;
  for (const e of events) {
    if (e.ts > hourAgo) {
      if (e.level === "error") errorsLastHour++;
      else if (e.level === "warn") warnsLastHour++;
      if (e.tags.includes("maintenance") || e.kind === "job" || e.kind === "script") maintenanceLastHour++;
    }
    if (e.tags.includes("maintenance") || e.kind === "job" || e.kind === "script") lastMaintenance = e;
    if (e.kind === "agent") lastAgent = e;
  }
  return { total: events.length, errorsLastHour, warnsLastHour, maintenanceLastHour, lastMaintenance, lastAgent };
}

// ---- agent presence --------------------------------------------------------

const agents = new Map<string, AgentPresence>();

/** Record that an agent is alive; with `action`, also log what it did to the feed. */
export function touchAgent(name: string, action?: string): void {
  const p = agents.get(name) ?? { name, lastSeen: "", lastAction: null, actions: 0 };
  p.lastSeen = new Date().toISOString();
  if (action) {
    p.lastAction = action;
    p.actions++;
    publish({ source: "agent", kind: "agent", level: "info", text: `${name}: ${action}`, meta: { agent: name } });
  }
  agents.set(name, p);
}

export function listAgents(): AgentPresence[] {
  return [...agents.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

// ---- tails -----------------------------------------------------------------

interface TailState {
  stop: (() => void) | null;
  attempts: number;
  startedAt: number;
}
const tails = new Map<LogSource, TailState>();

function startTail(source: LogSource): void {
  const state = tails.get(source) ?? { stop: null, attempts: 0, startedAt: 0 };
  tails.set(source, state);
  state.startedAt = Date.now();
  const quiet = state.attempts > 0; // after a failure, don't re-log the tailer's own complaints

  const onLine = (line: string) => {
    if (quiet && line.startsWith("[")) return;
    publish({ source, kind: "log", text: line });
    rawSubs.get(source)?.forEach((fn) => fn(line));
  };
  const onEnd = () => {
    state.stop = null;
    // lived long enough to count as healthy → reset backoff
    if (Date.now() - state.startedAt > 60_000) state.attempts = 0;
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(state.attempts, 4));
    state.attempts++;
    setTimeout(() => startTail(source), delay);
  };

  openLogStream(source, onLine, onEnd)
    .then((stop) => {
      state.stop = stop;
    })
    .catch((e: Error) => {
      if (!quiet) publish({ source: "dashboard", kind: "log", level: "warn", text: `[alerts] cannot tail ${source}: ${e.message}` });
      onEnd();
    });
}

export function isTailed(source: AlertSource): boolean {
  return tails.has(source as LogSource);
}

export async function startHub(): Promise<void> {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await loadRules();
  await loadRecent();
  try {
    let timer: NodeJS.Timeout | null = null;
    fs.watch(rulesFile(), () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadRules(), 300);
    });
  } catch {
    // fs.watch unsupported — rules load at boot only
  }
  for (const source of cfg.alertSources) startTail(source);
  publish({ source: "dashboard", kind: "log", level: "info", tags: ["maintenance"], text: `Alerts hub started · tailing ${cfg.alertSources.join(", ")}` });
}

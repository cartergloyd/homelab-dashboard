// Brief maintenance reports filed by agents (or people) for later human review.
// A report may be linked to the sidecar incident / run it answers.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentReport } from "../types.js";
import { publish } from "./alerts.js";

const MAX = 200;
let reports: AgentReport[] = [];
const file = () => path.join(cfg.dataDir, "agent-reports.json");
const listeners = new Set<(r: AgentReport) => void>();

async function save(): Promise<void> {
  reports = reports.slice(0, MAX);
  const tmp = `${file()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(reports, null, 2));
  await fsp.rename(tmp, file());
}

export async function initReports(): Promise<void> {
  try {
    reports = JSON.parse(await fsp.readFile(file(), "utf8")) as AgentReport[];
  } catch {
    reports = [];
    // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
    if (cfg.demo) {
      reports.push({
        id: crypto.randomUUID(),
        ts: new Date(Date.now() - 50 * 60_000).toISOString(),
        agent: "Claude Code (demo)",
        title: "Investigated “Can't keep up” warnings",
        body: "Summary: the server fell 2 s behind twice during the 19:30 chunk generation burst while three players explored new terrain.\n\nActions taken:\n- Ran `tps` — 20.0 across all windows now, so it was transient.\n- Checked memory via server_status: 3.1 GB of 4 GB heap, no GC pressure.\n- No restart needed.\n\nFollow-up for a human: consider pre-generating chunks around spawn (Chunky plugin) if this recurs on weekends.",
        reviewed: false,
        reviewedBy: null,
        reviewedAt: null,
        incidentId: null,
        runId: null,
      });
      await save().catch(() => {});
    }
  }
}

/** The sidecar listens so it can attach reports to incidents. */
export function onReport(fn: (r: AgentReport) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listReports(limit = 50, includeReviewed = true): AgentReport[] {
  return (includeReviewed ? reports : reports.filter((r) => !r.reviewed)).slice(0, limit);
}

export async function addReport(agent: string, title: string, body: string, link: { incidentId?: string | null; runId?: string | null } = {}): Promise<AgentReport> {
  const report: AgentReport = { id: crypto.randomUUID(), ts: new Date().toISOString(), agent, title: title.trim(), body: body.trim(), reviewed: false, reviewedBy: null, reviewedAt: null, incidentId: link.incidentId ?? null, runId: link.runId ?? null };
  reports.unshift(report);
  for (const fn of listeners) {
    try {
      fn(report);
    } catch {
      // a listener must not break filing
    }
  }
  await save();
  publish({ source: "agent", kind: "agent", level: "info", tags: ["maintenance", "report"], text: `${agent} filed a report: ${report.title}`, meta: { agent, incidentId: report.incidentId ?? undefined } });
  return report;
}

export async function setReviewed(id: string, by: string, reviewed: boolean): Promise<AgentReport> {
  const r = reports.find((x) => x.id === id);
  if (!r) throw new HttpError(404, "Report not found");
  r.reviewed = reviewed;
  r.reviewedBy = reviewed ? by : null;
  r.reviewedAt = reviewed ? new Date().toISOString() : null;
  await save();
  return r;
}

// Brief maintenance reports filed by agents (or people) for later human review.
// A report may be linked to the sidecar incident / run it answers.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentReport, ReportOutcome } from "../types.js";
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
    // reports filed before outcomes existed: guess from the wording
    for (const r of reports) r.outcome ??= inferOutcome(r.title, r.body);
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
        outcome: "no-action",
      });
      // the ops agent's seeded incidents (opsAgent.ts demoIncidents) point at these two
      reports.push(
        {
          id: "demo-ops-report-1",
          ts: new Date(Date.now() - 168 * 60_000).toISOString(),
          agent: "Codex (demo)",
          title: "Fixed: fam-jellyfin-sync.service failed (exit-code)",
          body: "Summary: the sync unit failed three times since 14:05 because its ExecStart still pointed at the old scripts folder.\n\nActions taken:\n- Read unit_journal: \"No such file or directory\" for the script path.\n- Corrected ExecStart in ~/.config/systemd/user/fam-jellyfin-sync.service and restarted the unit with unit_action; it finished cleanly.\n\nFollow-up for a human:\n- None. rollback_run demo-ops-run-1 undoes the change.",
          reviewed: false,
          reviewedBy: null,
          reviewedAt: null,
          incidentId: "d3m0c3",
          runId: "demo-ops-run-1",
          outcome: "fixed",
        },
        {
          id: "demo-ops-report-2",
          ts: new Date(Date.now() - 15 * 60_000).toISOString(),
          agent: "Codex (demo)",
          title: "Needs you: Disk /srv is 93% full",
          body: "Summary: /srv has been above the 90% threshold for three hours; 61 GB are free.\n\nActions taken:\n- Checked host_pressure and the storage scan. The Jellyfin transcode cache is 48 GB and the Postgres dumps folder 22 GB.\n- Changed nothing: deleting data is not something I may do.\n\nFollow-up for a human:\n- Clear the transcode cache in Jellyfin's dashboard, or move the dumps off-site and prune them.",
          reviewed: false,
          reviewedBy: null,
          reviewedAt: null,
          incidentId: "d3m0b2",
          runId: "demo-ops-run-2",
          outcome: "needs-human",
        },
      );
      reports.sort((a, b) => b.ts.localeCompare(a.ts));
      await save().catch(() => {});
    }
  }
}

/** The sidecar listens so it can attach reports to incidents. */
export function onReport(fn: (r: AgentReport) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getReport(id: string): AgentReport | undefined {
  return reports.find((r) => r.id === id);
}

export function listReports(limit = 50, includeReviewed = true): AgentReport[] {
  return (includeReviewed ? reports : reports.filter((r) => !r.reviewed)).slice(0, limit);
}

/** When an agent did not say, guess the outcome from the wording of its report. */
export function inferOutcome(title: string, body: string): ReportOutcome {
  const t = `${title}\n${body}`;
  if (/\b(no action|nothing (to do|needed|was needed)|no change|left (it|as is)|transient|recovered on its own|observed, no)\b/i.test(t)) return "no-action";
  if (/\b(needs? (a )?human|owner should|please decide|waiting for (the )?owner|declined|denied)\b/i.test(t)) return "needs-human";
  if (/\b(restarted|fixed|repaired|removed|deleted|pruned|cleaned|updated|rotated|freed|replaced|patched|corrected|resolved|killed|whitelisted|unbanned|re-?enabled|re-?created)\b/i.test(t)) return "fixed";
  return "no-action";
}

export async function addReport(agent: string, title: string, body: string, link: { incidentId?: string | null; runId?: string | null; outcome?: ReportOutcome | null } = {}): Promise<AgentReport> {
  const report: AgentReport = { id: crypto.randomUUID(), ts: new Date().toISOString(), agent, title: title.trim(), body: body.trim(), reviewed: false, reviewedBy: null, reviewedAt: null, incidentId: link.incidentId ?? null, runId: link.runId ?? null, outcome: link.outcome ?? inferOutcome(title, body) };
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

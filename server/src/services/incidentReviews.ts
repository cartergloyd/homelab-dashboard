import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../errors.js";
import type { AgentReport, Incident, IncidentFeedback, InstructionSuggestion } from "../types.js";
import { readContext, writeContext } from "./context.js";

let feedback: IncidentFeedback[] = [];
let suggestions: InstructionSuggestion[] = [];
let writes = Promise.resolve();
const deciding = new Set<string>();
const file = () => path.join(cfg.dataDir, "incident-reviews.json");

function save(): Promise<void> {
  const text = JSON.stringify({ feedback, suggestions }, null, 2);
  const next = writes.then(async () => {
    await fs.writeFile(`${file()}.tmp`, text);
    await fs.rename(`${file()}.tmp`, file());
  });
  writes = next.catch(() => {});
  return next;
}

export async function initIncidentReviews(): Promise<void> {
  try {
    const saved = JSON.parse(await fs.readFile(file(), "utf8"));
    feedback = saved.feedback ?? [];
    suggestions = saved.suggestions ?? [];
  } catch {
    feedback = [];
    suggestions = [];
  }
}

export function feedbackFor(incidentId: string): IncidentFeedback[] {
  return feedback.filter((f) => f.incidentId === incidentId);
}

export async function addFeedback(incidentId: string, text: string, by: string): Promise<IncidentFeedback> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) throw new HttpError(400, "Please describe what the assistant should consider (up to 4,000 characters).");
  const entry: IncidentFeedback = { id: crypto.randomUUID(), incidentId, text: trimmed, by, ts: new Date().toISOString(), runId: null };
  feedback.push(entry);
  await save();
  return entry;
}

export async function markFeedbackRun(ids: string[], runId: string): Promise<void> {
  for (const entry of feedback) if (ids.includes(entry.id)) entry.runId = runId;
  await save();
}

export function suggestionsFor(incidentId: string): InstructionSuggestion[] {
  return suggestions.filter((s) => s.incidentId === incidentId);
}

export function recordSuggestion(report: AgentReport): void {
  if (!report.incidentId || suggestions.some((s) => s.reportId === report.id)) return;
  const text = report.body.match(/(?:^|\n)Suggested context updates:\s*\n([\s\S]+)/i)?.[1]?.trim();
  if (!text || /^(none\b|no (?:changes|updates|suggestions|server instruction changes)\b)/i.test(text)) return;
  suggestions.push({ id: crypto.randomUUID(), incidentId: report.incidentId, reportId: report.id, text, ts: report.ts, status: "pending", decidedBy: null });
  void save().catch(() => {});
}

export async function decideSuggestion(id: string, decision: "approve" | "decline", by: string): Promise<InstructionSuggestion> {
  const suggestion = suggestions.find((s) => s.id === id);
  if (!suggestion) throw new HttpError(404, "Suggestion not found");
  if (suggestion.status !== "pending" || deciding.has(id)) throw new HttpError(409, "This suggestion has already been reviewed.");
  deciding.add(id);
  try {
    if (decision === "approve") {
      const current = await readContext();
      await writeContext(`${current.content.trimEnd()}\n\n## Approved Lesson\n\n${suggestion.text}\n`, current.hash, by, "Approved a lesson from an incident review");
    }
    suggestion.status = decision === "approve" ? "applied" : "declined";
    suggestion.decidedBy = by;
    await save();
    return suggestion;
  } finally {
    deciding.delete(id);
  }
}

export function incidentSummary(incident: Incident): string {
  const text = `${incident.title}\n${incident.samples.slice(-2).join("\n")}`;
  if (/minecraft-status\.service/i.test(text)) return "The Discord status updater is failing to run.";
  if (/code-tunnel\.service/i.test(text)) return "The remote editor connection stopped unexpectedly.";
  if (/failed to grab accelerator/i.test(text)) return "A desktop keyboard shortcut could not be registered.";
  if (/failed to fetch usbguard/i.test(text)) return "The desktop could not check USB device protection.";
  if (/scaling factor/i.test(text)) return "The desktop could not determine its display scaling.";
  if (/libayatana.*deprecated/i.test(text)) return "A desktop component is using an older interface.";
  if (/g_object_get_data|G_IS_OBJECT/i.test(text)) return "A desktop component reported an internal error.";
  if (/sqlite connection string/i.test(text)) return "Jellyfin's database connection message was flagged for review.";
  if (/pm2 log:.*(?:kill|process tree)/i.test(text)) return "The database manager had trouble stopping a background process.";
  if (/logical replication launcher/i.test(text)) return "A database background task stopped while connections were closing.";
  if (/failed to bind|bind\(.+failed|cannot assign requested address/i.test(text)) return "Minecraft could not start because its network address or port was unavailable.";
  if (/unknownhostexception|services are unavailable/i.test(text)) return "Minecraft could not reach its online services.";
  if (/constraint .+does not exist/i.test(text)) return "A database change failed because an expected relationship was missing.";
  if (/connection to client lost|terminating connection due to administrator/i.test(text)) return "A database connection was interrupted.";
  if (/timeout|timed out|failed to connect|http.*exception/i.test(text)) {
    const name = incident.source === "minecraft" ? "Minecraft" : incident.source === "jellyfin" ? "Jellyfin" : "A server component";
    return `${name} had trouble connecting to another service.`;
  }
  const service = text.match(/(?:Failed to (?:start|stop) )?([\w@.-]+)\.service/i)?.[1]?.replace(/[-_]/g, " ");
  if (service) return `The ${service} service reported a problem.`;
  const names: Record<string, string> = { minecraft: "Minecraft", jellyfin: "Jellyfin", directus: "The database manager", postgres: "The database", system: "The server", jobs: "A scheduled task", scripts: "A maintenance script" };
  if (/crash|unexpected exception/i.test(text)) return `${names[incident.source] ?? "A server component"} stopped unexpectedly.`;
  return `${names[incident.source] ?? "A server component"} reported ${incident.level === "warn" ? "a recurring warning" : "a problem"} for the assistant to review.`;
}

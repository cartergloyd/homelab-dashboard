import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { cfg } from "./config.js";
import type { Identity } from "./auth.js";
import { jobRefusal, memberRefusal, rconRefusal, restartRefusal, scriptRefusal } from "./services/runGuards.js";
import type { RunLane } from "./services/runTokens.js";
import { secretIn } from "./services/secretFilter.js";
import { HttpError } from "./errors.js";
import { publish } from "./services/alerts.js";
import { StepUpStore } from "./services/stepUp.js";
import * as sidecar from "./services/sidecar.js";

export const stepUp = new StepUpStore(cfg.dataDir);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const COOKIE = "__Host-homelab-stepup-session";
const sessions = new Map<string, { login: string; auth: string; expires: number }>();
const who = (res: Response) => res.locals.user as Identity;
function event(res: Response, text: string) {
  publish({ source: "dashboard", kind: "log", level: "info", tags: ["security", "maintenance"], text: `${who(res).login}: ${text}` });
}

function sameOrigin(req: Request, res: Response) {
  const origin = req.get("origin");
  const expected = who(res).via === "cloudflare" ? cfg.cfAccess?.publicUrl : `${req.protocol}://${req.get("host")}`;
  if (!origin || !expected || new URL(expected).origin !== origin) throw new HttpError(403, "Use the dashboard page to confirm this action");
}

function session(req: Request, res: Response) {
  const user = who(res);
  const login = user.login.toLowerCase();
  const cookie = req.get("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const previous = cookie && /^[a-f0-9]{64}$/.test(cookie) ? sessions.get(hash(cookie)) : null;
  if (previous && previous.login === login && previous.auth === (user.sessionId ?? "") && previous.expires > Date.now()) return hash(cookie!);
  for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
  if (sessions.size >= 2000) throw new HttpError(429, "Too many confirmation sessions. Try again later.");
  const value = crypto.randomBytes(32).toString("hex");
  sessions.set(hash(value), { login, auth: user.sessionId ?? "", expires: Date.now() + 24 * 3600_000 });
  res.cookie(COOKIE, value, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 24 * 3600_000 });
  return hash(value);
}

const target = (req: Request) => hash(JSON.stringify([req.method, req.originalUrl, req.body ?? null]));

// What a dashboard-launched run may change, by lane. Anything not listed is refused before any
// other check. Reads stay open for diagnosis, except the apps' own data, repositories, the
// terminal and security settings. Within its lane and the run guards a run acts on its own: no
// approvals and no step-up (the owner's choice, 2026-10-30).
const LANE_WRITES: Record<RunLane, RegExp[]> = {
  minecraft: [
    /^post \/minecraft\/(action|command|whitelist)$/,
    /^post \/backups$/,
    /^post \/scripts\/[^/]+\/run$/,
    /^post \/jobs\/[^/]+\/run$/,
    /^post \/reports$/,
    /^post \/sidecar\/runs\/[^/]+\/rollback$/,
    /^post \/storage\/(scan|refresh)$/,
  ],
};
const LANE_HIDDEN = /^\/(security|directus|database|repositories|terminal)(\/|$)/;
// Discord-started runs read only what join help needs, and their changes count against the member who asked.
const DISCORD_READS = new Set(["/status", "/minecraft", "/minecraft/settings", "/minecraft/players", "/alerts", "/context", "/jobs", "/scripts", "/backups", "/updates"]);
const READ_ONLY_RCON = /^\/?\s*(list|tps|mspt|version|plugins|help|whitelist list)\s*$/i;

/** Why a run in this lane may not make this request, or null when it may. `p` is the normalized API path. */
export function laneRefusal(lane: RunLane, method: string, p: string): string | null {
  const m = method.toUpperCase();
  if (LANE_HIDDEN.test(p)) return `The ${lane} assistant has no access to /${p.split("/")[1]}.`;
  if (["GET", "HEAD", "OPTIONS"].includes(m)) return null;
  return LANE_WRITES[lane].some((re) => re.test(`${m.toLowerCase()} ${p}`)) ? null : `The ${lane} assistant may not ${m} ${p}; it acts on ${lane} only.`;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The run guards for writes a lane allows: console never-list, restart limit, Minecraft-only scripts and jobs, no secrets in chat. */
async function guardRefusal(req: Request, p: string, user: Identity): Promise<string | null> {
  if (req.method.toUpperCase() !== "POST") return null;
  if (p === "/minecraft/command") {
    const command = String(req.body?.command ?? "");
    const leaked = secretIn(command);
    if (leaked) {
      publish({ source: "dashboard", kind: "agent", level: "error", tags: ["security"], text: `Blocked a Minecraft command from ${user.name} that contained ${leaked}`, meta: { agent: user.name } });
      return `That command contains ${leaked} and was blocked. Never send secrets to players.`;
    }
    return rconRefusal(command);
  }
  if (p === "/minecraft/action" && req.body?.action === "stop") return "Stopping leaves Minecraft down for everyone; only the owner may stop it. Restart it to recover.";
  if (p === "/minecraft/action" && ["start", "restart"].includes(String(req.body?.action))) return restartRefusal();
  // Routes match case-insensitively; script names keep their case.
  const script = /^\/scripts\/([^/]+)\/run\/?$/i.exec(req.path);
  if (script) return scriptRefusal(decodeSegment(script[1]));
  const job = /^\/jobs\/([^/]+)\/run\/?$/i.exec(req.path);
  if (job) return jobRefusal(decodeSegment(job[1]));
  return null;
}

function discordRefusal(req: Request, p: string, user: Identity): string | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    if (!DISCORD_READS.has(p)) return "A Discord-started run may read only Minecraft status, settings, players, alerts, scripts, jobs, backups, updates and instructions.";
    if (p === "/alerts" && req.query?.sources !== "minecraft") return "A Discord-started run may read Minecraft alerts only.";
    return null;
  }
  if (p === "/reports" || (p === "/minecraft/command" && READ_ONLY_RCON.test(String(req.body?.command ?? "")))) return null;
  return memberRefusal(user.requester, p === "/minecraft/whitelist" ? ["action", "whitelist"] : ["action"]);
}

/** Keep coverage centralized, including case/trailing-slash variants Express accepts. */
export function protectedAction(method: string, pathname: string, body: Record<string, unknown> = {}): string | null {
  let p: string;
  try { p = decodeURIComponent(pathname).replace(/\/+$/, "").toLowerCase(); } catch { return "Change server state"; }
  const m = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(m)) return null;
  if (p === "/security/settings" || p === "/security/disable" || p === "/security/recovery") return "Change dashboard security settings";
  if (p === "/minecraft/action" && body.action !== "start") return `${body.action === "stop" ? "Stop" : "Restart"} Minecraft`;
  if (p === "/minecraft/command" && !/^\/?\s*(list|tps|mspt|version|plugins|help)\s*$/i.test(String(body.command ?? ""))) return `Run Minecraft command: ${String(body.command ?? "").slice(0, 500)}`;
  if (p === "/backups" && m === "DELETE") return "Delete a world backup";
  if (p === "/backups" && cfg.backups.method.startsWith("script:")) return "Run the configured backup script";
  if (["/files/delete", "/files/move", "/files/rename"].includes(p)) return `${p.split("/").pop()} server file: ${String(body.root ?? "")}/${String(body.path ?? "").slice(0, 300)}${body.dest ? ` → ${String(body.dest).slice(0, 300)}` : body.newName ? ` → ${String(body.newName).slice(0, 300)}` : ""}`;
  if (p === "/terminal/execute") return "Run a command on the server as the dashboard service owner";
  if (p.startsWith("/directus/") && !/\/(login|logout)$/.test(p)) return `Change Directus data: ${m} ${p}`;
  if (p === "/qbittorrent/control" && body.action === "remove") return "Remove a torrent from the queue (keep downloaded files)";
  if (p === "/jellyfin/restart") return "Restart Jellyfin";
  if (/^\/jobs(?:\/|$)/.test(p)) return `Maintenance job: ${m} ${p}${body.name ? ` (${String(body.name).slice(0, 150)})` : ""}`;
  if (/^\/scripts\/.+\/run$/.test(p)) return `Run maintenance script: ${p.split("/")[2]}`;
  if (/^\/context(?:\/|$)/.test(p)) return "Change shared assistant instructions";
  if (/^\/agents(?:\/|$)/.test(p)) return "Launch an assistant job";
  if (p === "/sidecar/settings") return `Change assistant settings: ${Object.entries(body).filter(([key]) => ["enabled", "runner", "autoTrigger", "requireApproval", "cooldownMinutes", "quietSeconds", "maxRunMinutes"].includes(key)).map(([key, value]) => `${key}=${String(value).slice(0, 50)}`).join(", ")}`;
  if (p === "/sidecar/chat" || /^\/sidecar\/incidents\/[^/]+\/(investigate|revisit)$/.test(p)) return "Start an assistant task";
  if (/^\/sidecar\/suggestions\/[^/]+$/.test(p) && body.decision === "approve") return "Approve a change to shared instructions";
  if (/^\/sidecar\/approvals\/[^/]+$/.test(p) && body.decision === "approve") return "Approve a risky assistant action";
  return null;
}

export async function requireStepUp(req: Request, res: Response, next: NextFunction) {
  const user = who(res);
  const p = req.path.toLowerCase().replace(/\/+$/, "");
  if (p.startsWith("/security/")) res.setHeader("Cache-Control", "no-store");
  // A shared dashboard key must never approve its own actions or enroll a factor.
  if (user.viaKey && (/^\/sidecar\/approvals\/[^/]+$/.test(p) || p.startsWith("/security/")) && !(req.method === "GET" && p === "/security/status")) {
    throw new HttpError(403, "Only a signed-in owner can manage security or decide approvals");
  }
  if (user.lane) {
    const refusal = laneRefusal(user.lane, req.method, p) ?? (await guardRefusal(req, p, user)) ?? (sidecar.isPlayerSupportRun(user) ? discordRefusal(req, p, user) : null);
    if (refusal) throw new HttpError(403, refusal);
    return next();
  }
  const description = protectedAction(req.method, req.path, req.body);
  if (!description) return next();
  const securityChange = p.startsWith("/security/");
  const login = user.login.toLowerCase();
  if (!securityChange && !stepUp.activeAccounts()) return next(); // Enrollment enables enforcement.
  if (user.viaKey && !user.dashboardRunId) return next(); // Interactive clients ask in their own CLI/chat.
  if (user.viaKey) {
    // The owner must approve this exact method/path/body through the protected UI.
    await sidecar.gate(`stepup:${target(req)}`, user, `${description}${req.method === "DELETE" && req.path.toLowerCase().replace(/\/+$/, "") === "/backups" ? `: ${String(req.query.path ?? req.query.name ?? "").slice(0, 500)}` : ""}`, true);
    res.locals.stepUpAgentApproved = true;
    return next();
  }
  const status = stepUp.status(login, user.via);
  if (!securityChange && !status.required) return next();
  sameOrigin(req, res);
  const id = session(req, res);
  res.setHeader("Cache-Control", "no-store");
  if (!status.enrolled) {
    res.status(428).json({ error: "Enroll your dashboard authenticator before continuing", code: "STEP_UP_ENROLLMENT_REQUIRED" });
    return;
  }
  const permit = req.get("x-homelab-step-up");
  if (permit && stepUp.consume(login, id, target(req), permit)) return next();
  res.status(428).json({ error: "Confirm this action with your authenticator", code: "STEP_UP_REQUIRED",
    challengeId: stepUp.challenge(login, id, target(req)), description });
}

/** A step-up owner approval already consumed the exact request's agent approval. */
export async function legacyGate(res: Response, ...args: Parameters<typeof sidecar.gate>) {
  if (!res.locals.stepUpAgentApproved) await sidecar.gate(...args);
}

export const securityApi = Router();
securityApi.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Pragma", "no-cache"); next(); });
securityApi.get("/status", (req, res) => {
  const user = who(res);
  if (!user.viaKey) session(req, res);
  res.json({ ...stepUp.status(user.login.toLowerCase(), user.via), canManage: !user.viaKey });
});
securityApi.use((req, res, next) => {
  if (who(res).viaKey) throw new HttpError(403, "Open dashboard Security to manage your authenticator");
  sameOrigin(req, res);
  next();
});
securityApi.post("/enroll", async (req, res) => {
  res.json(await stepUp.begin(who(res).login.toLowerCase(), session(req, res)));
});
securityApi.post("/confirm", async (req, res) => {
  const { enrollmentId, code } = z.object({ enrollmentId: z.string().length(64), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const result = await stepUp.confirm(who(res).login.toLowerCase(), session(req, res), enrollmentId, code);
  event(res, "enabled dashboard authenticator protection");
  res.json(result);
});
securityApi.post("/verify", async (req, res) => {
  const { challengeId, code } = z.object({ challengeId: z.string().length(64), code: z.string().trim().min(6).max(64) }).parse(req.body);
  try {
    const result = await stepUp.verify(who(res).login.toLowerCase(), session(req, res), challengeId, code);
    event(res, `confirmed a protected action with ${result.method}`);
    res.json({ permit: result.permit });
  } catch (e) {
    event(res, "failed dashboard authenticator confirmation");
    throw e;
  }
});
securityApi.put("/settings", async (req, res) => {
  const { tailnetExempt } = z.object({ tailnetExempt: z.boolean() }).parse(req.body);
  await stepUp.settings(who(res).login.toLowerCase(), tailnetExempt);
  event(res, `set Tailscale confirmation exemption to ${tailnetExempt ? "on" : "off"}`);
  res.json({ ok: true });
});
securityApi.post("/recovery", async (_req, res) => {
  const result = await stepUp.rotateRecovery(who(res).login.toLowerCase());
  event(res, "replaced dashboard recovery codes");
  res.json(result);
});
securityApi.post("/disable", async (_req, res) => {
  await stepUp.disable(who(res).login.toLowerCase());
  event(res, "disabled dashboard authenticator protection");
  res.json({ ok: true });
});
